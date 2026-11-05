import { createHash } from 'node:crypto';

import * as Sentry from '@sentry/nextjs';

import { requireInvoiceTenant } from './tenant-boundary';
import {
  invoiceSubmitFailed,
  invoiceSubmitSucceeded,
} from '../events';
import type { JobContext } from '@/lib/jobs/registry';
import { parseDurationMs } from '@/lib/jobs/duration';
import { RetryAfterError } from '@/lib/jobs/errors';
import { readTenantOwnerContact } from '@/lib/supabase/admin-queries';
import {
  sendInvoiceAcceptedEmail,
  sendInvoiceDuplicateDecisionEmail,
  sendInvoiceFailedEmail,
} from '@/lib/email/send';
import { sendPushToUser } from '@/lib/push/sender';
import { createAdminClient } from '@/lib/supabase/admin';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import {
  DUPLICATE_DECISION_TEXTS,
  duplicateMarker,
  duplicateNoticeVariant,
  ownHistoryInSubmissions,
  type DuplicateNoticeVariant,
} from '@/lib/ksef/duplicate-decision';
import {
  duplicateNoticeKey,
  duplicateReviewNoticeKey,
  findDuplicateNotices,
  recordDuplicateNotice,
} from '@/lib/ksef/duplicate-decision-notice';
import { readDuplicateDecisionBlocker } from '@/lib/ksef/duplicate-decision-rpc';
import { SEND_ERROR_CODES } from '@/lib/ksef/send-error-classes';
import { createProposal } from '@/lib/flo/proposals';
import {
  buildKsefStatusProposal,
  evaluateSubmission,
} from '@/lib/flo/functions/ksef-status';
import { buildKsefFixProposal } from '@/lib/flo/functions/ksef-fix';

/**
 * Notyfikacje per-użytkownik po zakończeniu wysyłki faktury.
 *
 * Oddzielone od `submitInvoiceJob` świadomie:
 *   - single-responsibility: submit robi KSeF, ten robi komunikację
 *   - niezależny retry: padnie Resend 503? Nie cofamy już wysłanej faktury
 *   - łatwo dołożyć kolejne kanały (Slack, push, in-app toast) jako nowe
 *     listenery tych samych eventów
 *
 * retries=2 bo email lepiej nie dostarczyć niż wysłać 4 razy.
 *
 * Powiadomienie nie ginie po cichu (A5, luka #3): karta FLO nie zatrzymuje
 * e-maila ani pusha; właściciel i adres ścisłym odczytem (błąd bazy albo
 * GoTrue = ponowienie, nie „brak adresu”); błąd Resend nie zatrzymuje pusha;
 * ponowienia po 5 i 30 min (`notifyRetryDelayMs`); po wyczerpaniu prób
 * `onNotifyExhausted` nazywa fakturę w logu i Sentry.
 */

/**
 * Odstępy ponowień kolejek notify (`getDelayMs` w package-b.ts, `maxRetries: 2`)
 * zamiast domyślnych 10 s / 30 s: awaria Resend, bazy albo GoTrue trwa zwykle
 * dłużej niż ~40 s, a po ostatniej próbie tego powiadomienia nic nie ponowi.
 * Klucz idempotencji Resend (24 h) chroni przed dublem e-maila. Jawny
 * `RetryAfterError` z runnera ma pierwszeństwo (`decideRetry`).
 */
export const NOTIFY_RETRY_DELAYS = ['5m', '30m'] as const;

export function notifyRetryDelayMs(attempt: number): number {
  return parseDurationMs(NOTIFY_RETRY_DELAYS[Math.min(attempt, NOTIFY_RETRY_DELAYS.length - 1)]!);
}

/** Karta agenta to dodatek: jej błąd idzie do logu i Sentry, e-mail i push wychodzą dalej. */
async function floCard(
  { step, logger }: JobContext,
  name: 'flo-status-card' | 'flo-fix-card',
  ids: { tenantId: string; invoiceId: string },
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await step.run(name, fn);
  } catch (e) {
    logger.warn('Karta FLO nieudana — powiadomienie idzie dalej', { ...ids, step: name, error: e instanceof Error ? e.message : String(e) });
    Sentry.captureException(e, { tags: { job: 'notify-user', step: name }, extra: ids });
  }
}

/**
 * Po wyczerpaniu prób kolejki notify (rejestracja: package-b.ts). Ogólny
 * Sentry workera (`reportExhaustedJob`) nie ma numeru faktury — ten nazywa
 * fakturę i firmę, żeby operator mógł dać znać klientowi.
 */
export function onNotifyExhausted(queue: string) {
  return async (
    error: Error,
    data: { invoiceId?: unknown; tenantId?: unknown } | null | undefined,
    { logger }: JobContext,
  ): Promise<void> => {
    const context = {
      invoiceId: typeof data?.invoiceId === 'string' ? data.invoiceId : null,
      tenantId: typeof data?.tenantId === 'string' ? data.tenantId : null,
      queue,
      error: error.message,
    };
    logger.error('Powiadomienie o wyniku wysyłki faktury nie doszło do klienta — wyczerpane próby', context);
    Sentry.captureMessage('Powiadomienie o wyniku wysyłki faktury nie doszło do klienta', {
      level: 'error',
      tags: { job: 'notify-user', queue },
      extra: context,
    });
  };
}

// ═══════════════════════════════════════════════════════════════
// SUKCES: faktura zaakceptowana przez KSeF
// ═══════════════════════════════════════════════════════════════

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-b.ts
 */
export async function runNotifySuccess(data: Parameters<typeof invoiceSubmitSucceeded.create>[0], ctx: JobContext) {
    const { step, logger } = ctx;
    const { tenantId, invoiceId, ksefNumber } = data;
    await requireInvoiceTenant(invoiceId, tenantId);

    // Karta agenta (X-01). Powiadomienie znika, karta zostaje — i mówi
    // prawdę o tym, czy poświadczenie odbioru już jest. Przy kontroli
    // różnica między „wysłałem" a „mam UPO" jest całą różnicą.
    await floCard(ctx, 'flo-status-card', { tenantId, invoiceId }, async () => {
      const supabase = createAdminClient();
      const { data: invoice } = await supabase
        .from('invoices')
        .select('internal_number, ksef_status, updated_at')
        .eq('id', invoiceId)
        .eq('tenant_id', tenantId)
        .maybeSingle();

      const { count } = await supabase
        .from('upo_receipts')
        .select('*', { count: 'exact', head: true })
        .eq('invoice_id', invoiceId)
        .eq('tenant_id', tenantId);

      const snapshot = {
        invoiceId,
        invoiceNumber: invoice?.internal_number ?? ksefNumber ?? 'bez numeru',
        state: 'accepted' as const,
        hasUpo: (count ?? 0) > 0,
        since: invoice?.updated_at ?? new Date().toISOString(),
        attempts: 1,
      };

      const proposal = buildKsefStatusProposal({
        tenantId,
        snapshot,
        verdict: evaluateSubmission(snapshot, new Date()),
      });
      if (proposal) await createProposal(proposal);
    });

    // Ścisły odczyt: błąd bazy albo GoTrue ponawia zadanie zamiast udawać
    // „firma bez adresu”; prawdziwy brak właściciela albo adresu = null.
    const { ownerUserId, email } = await step.run('get-owner-contact', () =>
      readTenantOwnerContact(tenantId),
    );

    // Błąd Resend nie zatrzymuje pusha (osobny kanał) — rzucamy go po pushu.
    const emailFailure: { error?: unknown } = {};
    const result = await step.run('send-email', async () => {
      if (!email) {
        return {
          sent: false as const,
          reason: 'no-admin-email' as const,
        };
      }
      // Faktura jest przyjmowana raz — ponowienie zadania nie wyśle drugi raz (AUD-86).
      return sendInvoiceAcceptedEmail(
        email,
        { ksefNumber, invoiceId },
        { idempotencyKey: `invoice-accepted/${invoiceId}` },
      );
    }).catch((e: unknown) => {
      emailFailure.error = e;
      return { sent: false as const, reason: 'email-error' as const };
    });

    if (!email) {
      logger.warn('Brak email dla tenanta — email pominięty, push dalej próbujemy', {
        tenantId,
        invoiceId,
      });
    }

    const pushResult = await step.run('send-push', async () => {
      if (!ownerUserId) {
        return { skipped: true as const, reason: 'no-owner' as const };
      }

      const supabase = createAdminClient();
      const { data: inv } = await supabase
        .from('invoices')
        .select('internal_number')
        .eq('id', invoiceId)
        .eq('tenant_id', tenantId)
        .maybeSingle();

      const label = inv?.internal_number?.trim()
        ? inv.internal_number
        : invoiceId.slice(0, 8);

      return sendPushToUser(ownerUserId, 'invoice_accepted', {
        title: '✅ Faktura zaakceptowana',
        body: `Faktura ${label} przeszła walidację KSeF`,
        url: `/invoices/${invoiceId}`,
        tag: `invoice-${invoiceId}`,
      });
    });

    if ('error' in emailFailure) {
      logger.warn('E-mail o przyjęciu faktury nie wyszedł — push wysłany, e-mail ponowimy', { tenantId, invoiceId, pushResult });
      throw emailFailure.error;
    }

    logger.info('notify-success zakończone', {
      tenantId,
      invoiceId,
      emailTo: email,
      pushResult,
      ...result,
    });

    return { emailed: result.sent, reason: result.reason, push: pushResult };
}

// ═══════════════════════════════════════════════════════════════
// BŁĄD: faktura odrzucona lub retries wyczerpane
// ═══════════════════════════════════════════════════════════════

async function failureNotificationSuppression(
  invoiceId: string,
  tenantId: string,
): Promise<'already-accepted' | 'manual-reconciliation' | null> {
  const { data, error } = await createAdminClient()
    .from('invoices')
    .select('ksef_status, ksef_number, last_error_code')
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error || !data) throw new Error('Nie można sprawdzić statusu faktury przed powiadomieniem');
  if (data.ksef_status === 'accepted' && data.ksef_number) return 'already-accepted';
  if (data.last_error_code === 'ROZ_HOLD_RECONCILE') return 'manual-reconciliation';
  return null;
}

type DuplicateDecisionNotice =
  /** Faktura nie czeka na decyzję klienta (blokada z bazy) — dalej jak dotąd. */
  | { pending: false }
  | { skipped: true; reason: 'duplicate-env' | 'already-notified' }
  | { notified: boolean; emailed: boolean; push: { sent: number; failed: number } | { skipped: true; reason: 'no-owner' } };

/** Tytuł i treść pusha według wariantu (INV-24: ten sam wariant co e-mail i panel). */
function duplicateNoticePush(variant: DuplicateNoticeVariant, invoiceNumber: string): { title: string; body: string } {
  const FF = DUPLICATE_DECISION_TEXTS.FAKTFLOW;
  if (variant === 'review') return { title: FF.NOTICE_PUSH_TITLE_REVIEW(invoiceNumber), body: FF.NOTICE_PUSH_BODY_REVIEW };
  return {
    title: DUPLICATE_DECISION_TEXTS.NOTICE.PUSH_TITLE(invoiceNumber),
    body: variant === 'record' ? FF.NOTICE_PUSH_BODY_RECORD : DUPLICATE_DECISION_TEXTS.NOTICE.PUSH_BODY,
  };
}

/**
 * D-A4-1b-3 PR B (decyzja Bartosza 07.10.2026 (5), spec §2.8): „Faktura {nr}
 * czeka na Twoją decyzję” — DOKŁADNIE RAZ na fakturę i numer KSeF oryginału.
 * Ponowienie od zera po każdym kroku (pg-boss, `maxRetries: 2` w package-b.ts):
 *   - blokada, znacznik, ślad, właściciel i jego adres — tylko odczyt; błąd
 *     odczytu rzuca, więc nic nie wychodzi, a zadanie się ponawia (właściciel
 *     ścisłym `readTenantOwnerContact`: chwilowy błąd bazy albo GoTrue to nie
 *     „firma nie ma właściciela”, kolejna próba za 5 min — `RetryAfterError`);
 *   - e-mail ze stałym kluczem `ksef-duplicate-decision/{faktura}/{K}` — Resend
 *     deduplikuje 24 h; push z tagiem `invoice-{faktura}` zastępuje poprzedni;
 *   - zapis śladu: błąd rzuca, ponowienie wysyła z tym samym kluczem i zapisuje;
 *     po zapisie każde kolejne zdarzenie o (fakturze, K) jest pomijane.
 * Błąd Resend nie zatrzymuje pusha (A5 #3): push doszedł → powiadomienie
 * dostarczone (ślad z `emailed: false`, e-mail już nie wraca); nic nie doszło
 * → błąd Resend rzuca i ponowienie wysyła z tym samym kluczem.
 * Niedostarczone (bez e-maila i pusha: adres na liście odbić, brak właściciela
 * albo adresu, push bez subskrypcji) nie zostawia śladu (precedens
 * `cert-expiry-alert.ts`: zapis tylko po dostarczeniu) i NIKT go automatycznie
 * nie ponowi: faktura w I5D nie dostaje kolejnego zdarzenia (cron uzgadnia
 * tylko I5, alarm krytyczny I5D nie liczy — decyzja 4; bez automatycznego
 * przypomnienia — decyzja 5, spec §7 p. 11). Wyjście operatora: „Przypomnij klientowi”
 * w `/admin/ksef/<id>`; tabela I5D i karta faktury pokazują, ile powiadomień
 * o tym K doszło (0 × = klient nie wie).
 *
 * PR C (00156, spec v3 5.7, INV-24): wariant (`pair` / `record` / `released` / `review`) z TEJ SAMEJ
 * funkcji co panel (`duplicateNoticeVariant`) — własna historia (`ownHistoryInSubmissions`) liczona
 * z kolumn wpisów, które czyta panel, nigdy `null`. Blokada `provenance-review` (przegląd pliku, I5R):
 * klient dostaje RAZ „sprawdzamy fakturę z KSeF” (własny klucz `…/sprawdzamy` i rodzina śladów
 * `review`; klient niczego nie decyduje, więc środowisko znacznika go nie wstrzymuje), nigdy „czeka na
 * Twoją decyzję”. Każda inna blokada (też `recheck-needed`, `known-now`, `cross-tenant`) — ścieżka
 * ogólna jak dotąd (`last_error` = `FAKTFLOW.LAST_ERROR*` nie obiecuje decyzji).
 * Ponowienie po każdym kroku: jak wyżej (klucze Resend stałe w obrębie wariantu).
 */
async function notifyDuplicateDecision(
  invoiceId: string,
  tenantId: string,
  logger: JobContext['logger'],
): Promise<DuplicateDecisionNotice> {
  const supabase = createAdminClient();
  // 1. Blokada z bazy (00148, 00156) — autorytatywna, obejmuje też wiersze `payments`.
  //    NULL = czeka na decyzję klienta; `provenance-review` = przegląd pliku („sprawdzamy”); inna = ścieżka ogólna.
  const blocker = await readDuplicateDecisionBlocker(supabase, invoiceId, tenantId);
  if (blocker !== null && blocker !== 'provenance-review') return { pending: false };

  // 2. Znacznik 440 (K), numer dokumentu i kolumny, z których panel liczy własną historię w bazie (F43).
  const [{ data: rows, error: rowsError }, { data: invoice, error: invoiceError }] = await Promise.all([
    supabase
      .from('ksef_submissions')
      // `original_check` z 00144 — typy bazy dogenerujemy z produkcji po wgraniu.
      .select('id, status, original_ksef_number, original_check, attempted_at, session_reference_number, request_payload_hash, original_session_reference_number')
      .eq('invoice_id', invoiceId)
      .eq('tenant_id', tenantId),
    supabase
      .from('invoices')
      .select('internal_number')
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .maybeSingle(),
  ]);
  if (rowsError) throw new Error(`Nie można odczytać historii wysyłki przed powiadomieniem: ${rowsError.message}`);
  if (invoiceError) throw new Error(`Nie można odczytać faktury przed powiadomieniem: ${invoiceError.message}`);
  type MarkerRow = {
    id: string;
    status: string;
    original_ksef_number: string | null;
    original_check: unknown;
    attempted_at: string | null;
    session_reference_number: string | null;
    request_payload_hash: string | null;
    original_session_reference_number: string | null;
  };
  const submissions = (rows ?? []) as unknown as MarkerRow[];
  const marker = duplicateMarker(submissions);
  const ksefNumber = marker?.original_ksef_number ?? null;
  // Blokada NULL zawsze ma znacznik; bez niego — ostrożnie jak dotąd (bez wiadomości).
  if (!marker || !ksefNumber) return { pending: false };
  const check = marker.original_check;
  // Wariant jak w panelu (INV-24). Baza ma ostatnie słowo: blokada NULL = faktura czeka na decyzję, więc znacznik,
  // którego lustro TS (`allows`) nie rozpoznaje (rozjazd TS↔SQL), też dostaje powiadomienie PR B (`pair`), a nie milczenie.
  const variant = duplicateNoticeVariant(check, ownHistoryInSubmissions(submissions, marker), blocker)
    ?? (blocker === null ? 'pair' : null);
  if (variant === null) return { pending: false };

  // Dane oryginału z innego środowiska KSeF — klient nie zapisze decyzji (RPC ENV); operator dostaje I5D-env.
  // „Sprawdzamy” niczego od klienta nie wymaga, więc środowisko go nie wstrzymuje.
  if (variant !== 'review') {
    const checkEnv = typeof check === 'object' && check !== null ? (check as { env?: unknown }).env : undefined;
    if (checkEnv !== configuredKsefEnvironment()) return { skipped: true, reason: 'duplicate-env' };
  }

  // 3. Raz na (fakturę, K) w swojej rodzinie śladów — decyzja 5.
  const family = variant === 'review' ? 'review' : 'decision';
  const notices = await findDuplicateNotices(tenantId, invoiceId, ksefNumber, family);
  if (notices.count > 0) return { skipped: true, reason: 'already-notified' };

  const invoiceNumber = (invoice as { internal_number: string | null } | null)?.internal_number?.trim() || 'bez numeru';
  const idempotencyKey = variant === 'review'
    ? duplicateReviewNoticeKey(invoiceId, ksefNumber)
    : duplicateNoticeKey(invoiceId, ksefNumber, null);

  // 4. Właściciel i jego adres — wariant ścisły: błąd odczytu rzuca (pg-boss
  // ponawia), bo to jedyne automatyczne powiadomienie; prawdziwy brak = null.
  // Odstęp 5 min zamiast domyślnych 10 s / 30 s: restart bazy albo GoTrue
  // trwa dłużej niż ~40 s, a po ostatniej próbie nic go już nie ponowi.
  let contact: Awaited<ReturnType<typeof readTenantOwnerContact>>;
  try {
    contact = await readTenantOwnerContact(tenantId);
  } catch (e) {
    throw new RetryAfterError(e instanceof Error ? e.message : String(e), '5m', { cause: e });
  }
  const { ownerUserId: ownerId, email } = contact;

  // 5. E-mail do właściciela. Błąd Resend nie zatrzymuje pusha (krok 6).
  const mailFailure: { error?: unknown } = {};
  const mail = email
    ? await sendInvoiceDuplicateDecisionEmail(
        email,
        { invoiceId, invoiceNumber, ksefNumber, reminder: false, variant },
        { idempotencyKey },
      ).catch((e: unknown) => {
        mailFailure.error = e;
        return { sent: false as const, reason: 'email-error' };
      })
    : { sent: false as const, reason: 'no-admin-email' };
  const emailed = mail.sent === true;

  // 6. Push do właściciela (preferencja `notify_invoice_rejected`).
  const pushText = duplicateNoticePush(variant, invoiceNumber);
  const push = ownerId
    ? await sendPushToUser(ownerId, 'invoice_rejected', {
        title: pushText.title,
        body: pushText.body,
        url: `/invoices/${invoiceId}`,
        tag: `invoice-${invoiceId}`,
      })
    : { skipped: true as const, reason: 'no-owner' as const };
  const pushSent = 'sent' in push ? push.sent : 0;

  // 7. Ślad tylko po dostarczeniu. Nic nie doszło, a Resend padł — ponowienie od zera (ten sam klucz).
  const delivered = emailed || pushSent > 0;
  if ('error' in mailFailure) {
    if (!delivered) throw mailFailure.error;
    logger.warn('E-mail „czeka na Twoją decyzję” nie wyszedł — push doszedł, powiadomienie dostarczone', {
      tenantId, invoiceId, error: mailFailure.error instanceof Error ? mailFailure.error.message : String(mailFailure.error),
    });
  }
  if (delivered) {
    await recordDuplicateNotice({
      tenantId,
      invoiceId,
      ksefNumber,
      via: 'auto',
      idempotencyKey,
      emailed,
      pushSent,
      reminder: null,
      variant,
    });
  }
  return { notified: delivered, emailed, push };
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-b.ts
 */
export async function runNotifyFailure(data: Parameters<typeof invoiceSubmitFailed.create>[0], ctx: JobContext) {
    const { step, logger } = ctx;
    const { tenantId, invoiceId, error, fromOfflineQueue } = data;
    await requireInvoiceTenant(invoiceId, tenantId);

    // D-A4-1b-3 PR B: nierozstrzygnięty 440, który czeka na decyzję klienta —
    // jedno powiadomienie „czeka na Twoją decyzję” zamiast milczenia (decyzja 5).
    // Bez karty FLO i maila „odrzucona”: faktura nie jest odrzucona.
    if (data.errorCode === SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE) {
      const notice = await step.run('duplicate-decision-notice', () => notifyDuplicateDecision(invoiceId, tenantId, logger));
      if (!('pending' in notice)) {
        logger.info('notify-failure: decyzja klienta przy duplikacie 440', { tenantId, invoiceId, ...notice });
        return notice;
      }
    }

    // A local ROZ hold is a manual reconciliation state, not KSeF rejection.
    // Suppress all rejection messages: an older worker may still accept it.
    if (data.manualReconciliationRequired) {
      return { skipped: true as const, reason: 'manual-reconciliation' as const };
    }
    const suppression = await failureNotificationSuppression(invoiceId, tenantId);
    if (suppression) {
      return { skipped: true as const, reason: suppression };
    }

    // Karta agenta (X-02). Tłumaczy odrzucenie i — gdy rozwiązanie jest
    // jedno — pokazuje gotową poprawkę z podglądem różnicy.
    await floCard(ctx, 'flo-fix-card', { tenantId, invoiceId }, async () => {
      if (await failureNotificationSuppression(invoiceId, tenantId)) return;
      const supabase = createAdminClient();
      const { data: invoice } = await supabase
        .from('invoices')
        .select('internal_number, last_error_code')
        .eq('id', invoiceId)
        .eq('tenant_id', tenantId)
        .maybeSingle();

      const { count } = await supabase
        .from('ksef_submissions')
        .select('*', { count: 'exact', head: true })
        .eq('invoice_id', invoiceId)
        .eq('tenant_id', tenantId);

      await createProposal(
        buildKsefFixProposal({
          tenantId,
          invoiceId,
          invoiceNumber: invoice?.internal_number ?? 'bez numeru',
          context: {
            code: String(invoice?.last_error_code ?? 'brak'),
            rawMessage: error,
            attempts: count ?? 1,
            // Kandydat na poprawkę wyliczy osobne zadanie; tutaj nie
            // zgadujemy, bo poprawka bez pewności jest gorsza od jej braku.
            candidate: undefined,
          },
        }),
      );
    });

    if (fromOfflineQueue) {
      logger.info(
        'Pomijam email o błędzie — faktura z kolejki Offline24 wraca do kolejki',
        { tenantId, invoiceId },
      );
      return {
        skipped: true as const,
        reason: 'offline-queue-retry' as const,
      };
    }

    // Ścisły odczyt — jak przy przyjęciu.
    const { ownerUserId, email } = await step.run('get-owner-contact', () =>
      readTenantOwnerContact(tenantId),
    );

    // Błąd Resend nie zatrzymuje pusha (osobny kanał) — rzucamy go po pushu.
    const emailFailure: { error?: unknown } = {};
    const result = await step.run('send-email', async () => {
      const suppression = await failureNotificationSuppression(invoiceId, tenantId);
      if (suppression) {
        return { sent: false as const, reason: suppression };
      }
      if (!email) {
        return {
          sent: false as const,
          reason: 'no-admin-email' as const,
        };
      }
      // Klucz z treści błędu: ponowienie tego samego zdarzenia trafia w ten
      // sam klucz, a nowe odrzucenie z innym powodem dostaje własny mail.
      // Ten sam powód drugi raz w ciągu doby (okno Resend) nie dubluje maila.
      const errorDigest = createHash('sha256').update(error).digest('hex').slice(0, 16);
      return sendInvoiceFailedEmail(
        email,
        { invoiceId, errorMessage: error },
        { idempotencyKey: `invoice-failed/${invoiceId}/${errorDigest}` },
      );
    }).catch((e: unknown) => {
      emailFailure.error = e;
      return { sent: false as const, reason: 'email-error' as const };
    });

    if (!email) {
      logger.warn('Brak email dla tenanta — email pominięty, push dalej próbujemy', {
        tenantId,
        invoiceId,
      });
    }

    const pushResult = await step.run('send-push', async () => {
      const suppression = await failureNotificationSuppression(invoiceId, tenantId);
      if (suppression) {
        return { skipped: true as const, reason: suppression };
      }
      if (!ownerUserId) {
        return { skipped: true as const, reason: 'no-owner' as const };
      }

      const supabase = createAdminClient();
      const { data: inv } = await supabase
        .from('invoices')
        .select('internal_number')
        .eq('id', invoiceId)
        .eq('tenant_id', tenantId)
        .maybeSingle();

      const label = inv?.internal_number?.trim()
        ? inv.internal_number
        : invoiceId.slice(0, 8);
      const errShort =
        error.length > 140 ? `${error.slice(0, 137)}…` : error;

      return sendPushToUser(ownerUserId, 'invoice_rejected', {
        title: 'Faktura odrzucona przez KSeF',
        body: `${label}: ${errShort}`,
        url: `/invoices/${invoiceId}`,
        tag: `invoice-${invoiceId}`,
      });
    });

    if ('error' in emailFailure) {
      logger.warn('E-mail o odrzuceniu faktury nie wyszedł — push wysłany, e-mail ponowimy', { tenantId, invoiceId, pushResult });
      throw emailFailure.error;
    }

    logger.info('notify-failure zakończone', {
      tenantId,
      invoiceId,
      emailTo: email,
      pushResult,
      ...result,
    });

    return { emailed: result.sent, reason: result.reason, push: pushResult };
}

