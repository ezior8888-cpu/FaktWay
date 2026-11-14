import * as Sentry from '@sentry/nextjs';

import type { JobContext } from '@/lib/jobs/registry';

import {
  inboxInvoiceReceived,
  inboxInvoiceReceivedAutoCategorize,
  inboxPollTenant,
} from '../events';
import { classifyInboxPollError } from '@/lib/ksef/inbox-poll-errors';
import {
  INBOX_CATCH_UP_INTERVAL_MS,
  INBOX_METADATA_REQUESTS_PER_RUN,
  inboxActivityTier,
  inboxDispatchLimit,
  inboxOldestLagSeconds,
  inboxPollSlots,
  inboxRateLimitBrake,
  isInboxPollJobRedundant,
  nextInboxPollAfterError,
  nextInboxPollAfterSuccess,
  type InboxPollErrorClass,
} from '@/lib/ksef/inbox-schedule';
import {
  dispatchDueInboxPolls,
  finishInboxPoll,
  readInboxPollBacklog,
  readInboxPollState,
  type InboxPollState,
} from '@/lib/ksef/inbox-schedule-db';
import { getTenantKsefCredentials } from '@/lib/supabase/admin-queries';
import { queryReceivedInvoices } from '@/lib/ksef/inbox';
import { recordKsefPollSummary } from '@/lib/ksef/poll-audit';
import { createProposal } from '@/lib/flo/proposals';
import {
  buildInboxSummaryProposal,
  classifyInboxDocuments,
} from '@/lib/flo/functions/expense-inbox';
import { readInboxHwm, saveInboxHwm } from '@/lib/flo/functions/inbox-cursor';
import { inListChunks } from '@/lib/pagination/in-list';
import { forEachPageById } from '@/lib/pagination/keyset';
import { sendPushToTenant } from '@/lib/push/sender';
import { createAdminClient } from '@/lib/supabase/server';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import type { InvoiceMetadata, KsefEnvironment } from '@/types/ksef';
import { INBOX_MAX_WINDOW_MS, nextInboxHwm } from '@/lib/ksef/hwm';

// Przeniesione do czystego `lib/ksef/hwm.ts` (wspólne z synchronizacją historii
// KSeF, decyzja Bartosza 22.10.2026) — re-eksport zachowuje dotychczasowe importy.
export { INBOX_MAX_WINDOW_MS, nextInboxHwm };

/**
 * Polling skrzynki KSeF - dwa joby:
 *
 *   1. `runInboxPolling` (cron co minutę, 00160) - bierze firmy należne według
 *      harmonogramu do limitu slotów i wysyła zlecenia `inbox/poll.tenant`.
 *      Częstotliwość zależy od aktywności firmy (`lib/ksef/inbox-schedule.ts`),
 *      reszta należnych czeka na następny takt.
 *   2. `runInboxPollTenant` (zlecenie) - przebieg jednej firmy, filtr istniejących
 *      faktur, insert nowych jako direction='incoming', termin następnego przebiegu.
 *
 * Idempotencja:
 *   - KSeF zwraca tę samą fakturę przy kolejnych pollach jeśli w zakresie dat
 *   - `filter-existing` ogranicza odczyt do tenant + incoming + środowisko.
 *   - 00120 rozstrzyga wyścig w bazie po (tenant, environment, KSeF number).
 *     Po konflikcie odczytujemy istniejący dokument i ponawiamy atomowy batch
 *     bez potwierdzonych duplikatów. Wymaga wdrożenia 00120 przed tym kodem.
 *
 * UWAGA schema: KSeF inbox daje tylko METADANE - pełnego XML tu nie pobieramy.
 * Zapisujemy dane do `fa3_data JSONB` z `_source: 'inbox-metadata'` żeby
 * przyszły job (`fetch-inbox-xml`) wiedział które wiersze trzeba uzupełnić
 * pełnym Invoice po parsowaniu XML.
 */

/** Numer KSeF ma ~35 znaków — 100 w `in.(…)` to ~3,6 KB adresu. */
export const KSEF_NUMBERS_PER_QUERY = 100;

/**
 * Pierwszy przebieg firmy: tyle wstecz. Wcześniejszą historię zakupów pobiera
 * `ksef-history-sync` (strumień zakupów do HWM skrzynki z chwili założenia,
 * decyzja Bartosza 22.10.2026) — jako archiwum, bez kosztów i KPiR.
 */
export const INBOX_INITIAL_LOOKBACK_MS = 48 * 60 * 60 * 1000;

/**
 * Okno zapytania skrzynki (AUD-18): od HWM ostatniego przebiegu, więc przerwa
 * dowolnej długości jest nadrabiana; bez HWM — 48 h wstecz. Zaległość ponad
 * 90 dni albo ponad budżet zapytań przebiegu (E1-W10-b) nadrabiają kolejne
 * przebiegi. `null` = nie ma czego pytać (HWM nie starszy niż „teraz”).
 */
export function inboxQueryWindow(
  hwm: string | null,
  now: Date,
): { from: string; to: string } | null {
  const from = hwm ? new Date(hwm) : new Date(now.getTime() - INBOX_INITIAL_LOOKBACK_MS);
  if (Number.isNaN(from.getTime()) || from.getTime() >= now.getTime()) return null;
  const to = new Date(Math.min(now.getTime(), from.getTime() + INBOX_MAX_WINDOW_MS));
  return { from: from.toISOString(), to: to.toISOString() };
}

type InboxClient = Awaited<ReturnType<typeof createAdminClient>>;

function assertSameKsefDocument(
  row: { fa3_data: unknown; seller_nip: string | null; issue_date: string; gross_total: number | string | null },
  invoice: InvoiceMetadata,
): void {
  const data = row.fa3_data;
  const hash = data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>).invoiceHash
    : null;
  const hashMismatch = typeof hash === 'string' && hash.length > 0 &&
    typeof invoice.invoiceHash === 'string' && invoice.invoiceHash.length > 0 &&
    hash !== invoice.invoiceHash;
  const amountMismatch = row.gross_total !== null && row.gross_total !== undefined &&
    Math.round(Number(row.gross_total) * 100) !== Math.round(invoice.grossAmount * 100);
  if (hashMismatch || amountMismatch ||
      (row.seller_nip && row.seller_nip !== invoice.seller.nip) ||
      (row.issue_date && row.issue_date !== invoice.issueDate)) {
    throw new Error('Konflikt tożsamości faktury KSeF: istniejący dokument ma inne dane');
  }
}

async function findExistingInboxNumbers(
  supabase: InboxClient,
  tenantId: string,
  env: KsefEnvironment,
  invoices: InvoiceMetadata[],
): Promise<Set<string>> {
  const byNumber = new Map(invoices.map((invoice) => [invoice.ksefNumber, invoice]));
  const numbers = [...byNumber.keys()];
  const existingSet = new Set<string>();

  for (let i = 0; i < numbers.length; i += KSEF_NUMBERS_PER_QUERY) {
    const { data: existing, error } = await supabase
      .from('invoices')
      .select('ksef_number, ksef_environment, fa3_data, seller_nip, issue_date, gross_total')
      .eq('tenant_id', tenantId)
      .eq('direction', 'incoming')
      .in('ksef_number', numbers.slice(i, i + KSEF_NUMBERS_PER_QUERY));

    if (error) throw new Error(`Nie można sprawdzić, które faktury już są w bazie: ${error.message}`);
    for (const row of existing ?? []) {
      const invoice = byNumber.get(row.ksef_number as string);
      if (!invoice) continue;
      if (row.ksef_environment == null) {
        throw new Error('Historyczna faktura KSeF bez środowiska wymaga ręcznego uzgodnienia');
      }
      if (row.ksef_environment !== env) continue;
      assertSameKsefDocument(row, invoice);
      existingSet.add(invoice.ksefNumber);
    }
  }
  return existingSet;
}

// ═══════════════════════════════════════════════════════════════
// CRON: takt rozsyłki według harmonogramu
// ═══════════════════════════════════════════════════════════════

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-d.ts
 *
 * Ponowienie od zera jest bezpieczne: wybór firm i zapis zleceń to jedna
 * transakcja na paczkę (`dispatchDueInboxPolls`), więc po błędzie albo śmierci
 * procesu firmy z zatwierdzonej paczki mają dzierżawę, a reszta jest dalej
 * należna. Ponowieniem jest następny takt za minutę.
 */
export async function runInboxPolling({ step, logger }: JobContext) {
    const env = requireConfiguredKsefEnvironment();
    const startedAt = Date.now();
    const slots = inboxPollSlots();

    const backlog = await step.run('read-backlog', () => readInboxPollBacklog(env));
    const braking = inboxRateLimitBrake(backlog);
    const limit = inboxDispatchLimit({ slots, inFlight: backlog.inFlight, braking });
    if (braking) {
      logger.warn('Skrzynka: dużo firm z 429, rozsyłka zwolniona', {
        rateLimitedRecent: backlog.rateLimitedRecent,
        polledRecent: backlog.polledRecent,
      });
    }

    const sent = limit > 0 && backlog.due > 0
      ? await step.run('dispatch-due', () => dispatchDueInboxPolls(env, limit))
      : 0;

    // Jedna linia na takt, tylko liczby (jak `process.metrics`): z niej widać, czy
    // skrzynka nadąża. Runbook: docs/runbooks/skrzynka-ksef-pojemnosc.md.
    console.log(JSON.stringify({
      msg: 'ksef.inbox.dispatch',
      due: backlog.due,
      sent,
      inFlight: backlog.inFlight,
      limit,
      slots,
      oldestLagSeconds: inboxOldestLagSeconds(backlog.oldestDueAt, new Date()),
      rateLimitedRecent: backlog.rateLimitedRecent,
      braking,
      durationMs: Date.now() - startedAt,
    }));

    return { polled: sent };
}


// ═══════════════════════════════════════════════════════════════
// PER-TENANT: polling + diff + insert
// ═══════════════════════════════════════════════════════════════

/** Wynik samego pobrania, z tym co potrzebne do terminu następnego przebiegu. */
interface InboxPollOutcome {
  fetched: number;
  newlyAdded: number;
  /** KSeF nie podał HWM: okno stoi, więc to nie jest sukces. */
  hwmMissing: boolean;
  /**
   * Okno ucięte limitem zakresu API albo przebieg skończony na budżecie zapytań:
   * reszta zaległości czeka na następny przebieg za `INBOX_CATCH_UP_INTERVAL_MS`.
   */
  catchingUp: boolean;
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-d.ts
 *
 * Harmonogram nie może zatrzymać pobierania: błąd odczytu albo zapisu stanu idzie
 * do logu i Sentry, a faktury i HWM zostają. Bez zapisu terminu firma wraca po
 * wygaśnięciu dzierżawy. Ponowienie od zera po każdym kroku opisuje
 * tests/unit/skrzynka-przebieg-harmonogram.test.ts.
 */
export async function runInboxPollTenant(data: Parameters<typeof inboxPollTenant.create>[0], ctx: JobContext) {
    const { tenantId } = data;
    const { step, logger } = ctx;
    const env = requireConfiguredKsefEnvironment();
    if (data.environment !== env) {
      throw new Error('KSeF inbox event environment does not match configured environment');
    }
    const startedAt = new Date();

    let state: InboxPollState | null = null;
    try {
      state = await step.run('read-schedule', () => readInboxPollState(tenantId));
    } catch (e) {
      reportScheduleFailure(e, tenantId, ctx);
    }
    // Drugie zadanie tej samej firmy (dzierżawa wygasła, gdy pierwsze czekało):
    // kończy się tym jednym odczytem, bez KSeF.
    if (isInboxPollJobRedundant(state, startedAt)) {
      logger.info('Skrzynka: zadanie zbędne, firma już obsłużona', { tenantId });
      return { fetched: 0, newlyAdded: 0, skipped: 'not-due' as const };
    }

    let outcome: InboxPollOutcome;
    try {
      outcome = await pollTenantInbox(data, env, ctx);
    } catch (error) {
      const failure = classifyInboxPollError(error);
      await planNextPoll({ tenantId, startedAt, state, errorClass: failure.errorClass, retryAfterMs: failure.retryAfterMs, ctx });
      // Nasz błąd ma trafić do Sentry i dziennika przebiegów. Zły certyfikat i awaria
      // KSeF to zwykły stan: ponowieniem jest termin w harmonogramie.
      if (failure.errorClass === 'other') throw error;
      logger.warn('Skrzynka: przebieg nieudany, następna próba według harmonogramu', {
        tenantId,
        errorClass: failure.errorClass,
        detail: failure.detail,
      });
      return { fetched: 0, newlyAdded: 0, failed: failure.errorClass };
    }

    await planNextPoll({
      tenantId,
      startedAt,
      state,
      errorClass: outcome.hwmMissing ? 'ksef' : null,
      newInvoices: outcome.newlyAdded,
      catchingUp: outcome.catchingUp,
      ctx,
    });
    return { fetched: outcome.fetched, newlyAdded: outcome.newlyAdded };
}

function reportScheduleFailure(e: unknown, tenantId: string, { logger }: JobContext): void {
  logger.error('Skrzynka: harmonogram niedostępny, przebieg idzie dalej', {
    tenantId,
    error: e instanceof Error ? e.message : String(e),
  });
  Sentry.captureException(e, {
    tags: { job: 'inbox-poll-tenant', step: 'schedule' },
    extra: { tenantId },
  });
}

/** Poziom i termin po przebiegu. Błąd zapisu nie cofa pobranych faktur. */
async function planNextPoll(input: {
  tenantId: string;
  startedAt: Date;
  state: InboxPollState | null;
  errorClass: InboxPollErrorClass | null;
  retryAfterMs?: number | null;
  newInvoices?: number;
  catchingUp?: boolean;
  ctx: JobContext;
}): Promise<void> {
  const { tenantId, state, errorClass, retryAfterMs, catchingUp, startedAt, ctx } = input;
  const newInvoices = input.newInvoices ?? 0;
  const now = new Date();
  // Bez stanu (awaria odczytu, zlecenie sprzed wdrożenia) firma liczy się jak gorąca:
  // lepiej jeden przebieg za dużo niż firma odsunięta na dobę przez chwilową awarię.
  const tier = state
    ? inboxActivityTier({
        now,
        lastInvoiceAt: newInvoices > 0 ? now : state.last_invoice_at,
        lastActivityAt: state.last_activity_at,
        subscriptionActive: state.subscription_active,
      })
    : 'hot';
  let nextPollAt: Date;
  if (errorClass) {
    nextPollAt = nextInboxPollAfterError({
      tenantId,
      tier,
      errorClass,
      consecutiveErrors: (state?.consecutive_errors ?? 0) + 1,
      retryAfterMs,
      now,
    });
  } else if (catchingUp) {
    nextPollAt = new Date(now.getTime() + INBOX_CATCH_UP_INTERVAL_MS);
  } else {
    nextPollAt = nextInboxPollAfterSuccess({ tenantId, tier, now });
  }
  try {
    await ctx.step.run('plan-next-poll', () =>
      finishInboxPoll({ tenantId, startedAt, nextPollAt, tier, newInvoices, errorClass }),
    );
  } catch (e) {
    reportScheduleFailure(e, tenantId, ctx);
  }
}

async function pollTenantInbox(
  data: Parameters<typeof inboxPollTenant.create>[0],
  env: KsefEnvironment,
  { step, logger }: JobContext,
): Promise<InboxPollOutcome> {
    const { tenantId, nip } = data;

    const window = await step.run('inbox-window', async () =>
      inboxQueryWindow(await readInboxHwm(tenantId), new Date()),
    );
    if (!window) {
      logger.info('Skrzynka: brak okna do pobrania (HWM nie starszy niż teraz)', { tenantId });
      return { fetched: 0, newlyAdded: 0, hwmMissing: false, catchingUp: false };
    }

    const query = await step.run('query-ksef', async () => {
      const credentials = await getTenantKsefCredentials(tenantId);
      // Faza 23 sekcja 3 + EXT-03: strona `/invoices/query/metadata` trafia do
      // audytu tylko przy błędzie; przebieg, który dodał faktury — niżej.
      // E1-W10-b: budżet zapytań na przebieg, bo MF liczy 16/min i 20/h na NIP.
      return queryReceivedInvoices(
        credentials,
        new Date(window.from),
        new Date(window.to),
        env,
        { tenantId },
        { maxRequests: INBOX_METADATA_REQUESTS_PER_RUN },
      );
    });
    const { invoices: newInvoices, hwm, requests } = query;
    const resumeFrom = query.resumeFrom ?? null;

    // HWM przesuwamy dopiero po zapisie faktur — na każdej ścieżce, także bez
    // nowych faktur. Błąd wcześniej = HWM stoi, kolejny przebieg zapyta o to
    // samo okno, a duble odsieje `filter-existing`.
    const finish = async (fetched: number, newlyAdded: number): Promise<InboxPollOutcome> => {
      if (!hwm) {
        logger.warn('KSeF nie podał HWM skrzynki — okno zostaje na miejscu', { tenantId });
        return { fetched, newlyAdded, hwmMissing: true, catchingUp: false };
      }
      // E1-W10-b: przebieg skończony na budżecie zapytań przesuwa HWM tylko do
      // daty ostatniej pobranej faktury (nie dalej niż HWM KSeF, opis
      // `resumeFrom`). Następny przebieg zaczyna od niej, więc postęp zostaje
      // także wtedy, gdy któryś z kolejnych przebiegów dostanie 429.
      const nextHwm = nextInboxHwm(resumeFrom ?? hwm, window);
      await step.run('advance-hwm', () =>
        saveInboxHwm(tenantId, { windowFrom: window.from, hwm: nextHwm, fetched, saved: newlyAdded }),
      );
      if (resumeFrom) {
        logger.info('Skrzynka: przebieg skończony na budżecie zapytań, reszta okna w następnym', {
          tenantId,
          requests,
          resumeFrom: nextHwm,
        });
      }
      // Reszta okna (budżet zapytań) albo okno skończone przed „teraz” (limit zakresu
      // API): zaległość nadrabiają kolejne przebiegi, bez czekania na rytm poziomu firmy.
      const catchingUp = resumeFrom !== null || Date.parse(window.to) < Date.now() - INBOX_CATCH_UP_INTERVAL_MS;
      return { fetched, newlyAdded, hwmMissing: false, catchingUp };
    };

    if (newInvoices.length === 0) {
      logger.info('Brak faktur w oknie czasu', { tenantId, nip });
      return finish(0, 0);
    }

    const freshInvoices = await step.run('filter-existing', async () => {
      const supabase = await createAdminClient();

      // Okno od HWM (AUD-18): przebieg po nieudanym poprzednim widzi te same
      // faktury ponownie. Zapytanie oszczędza INSERT-y; ostateczną ochroną przed
      // wyścigiem jest indeks tożsamości faktury przychodzącej (00120, #64) —
      // błąd odczytu lub nieustalone historyczne środowisko zatrzymuje job.
      // Paczki chronią przed zbyt długim URL PostgREST.
      const unique = [...new Map(newInvoices.map((inv) => [inv.ksefNumber, inv])).values()];
      const existingSet = await findExistingInboxNumbers(supabase, tenantId, env, unique);
      return unique.filter((inv) => !existingSet.has(inv.ksefNumber));
    });

    if (freshInvoices.length === 0) {
      logger.info('Wszystkie faktury już w DB', {
        tenantId,
        fetched: newInvoices.length,
      });
      return finish(newInvoices.length, 0);
    }

    const insertedInvoices = await step.run('save-received-invoices', async () => {
      const supabase = await createAdminClient();

      // Schemat `invoices` (00001):
      //   - direction CHECK IN ('outgoing', 'incoming') - NIE ma 'received'
      //   - kolumna `invoice_type` (nie `type`)
      //   - kolumna `ksef_accepted_at` (nie `ksef_timestamp`)
      //   - brak kolumn `seller_data`/`buyer_data`/`payment_data` - wszystko
      //     idzie do `fa3_data JSONB NOT NULL`
      //   - `fa3_data` jest NOT NULL - wstawiamy stub z metadanymi + markerem
      //     `_source: 'inbox-metadata'` dla przyszłego enricher jobu
      // Mapowanie KSeF 2.0 response → kolumny `invoices`:
      //   - `inv.acquisitionDate` to ISO z timezone, nadaje się wprost do TIMESTAMPTZ
      //   - `inv.issueDate` to `DATE` (YYYY-MM-DD) - bez timezone
      //   - `seller` ma zawsze NIP (polski wystawca), `buyer` może być VatUe/Other
      //   - `netAmount`/`vatAmount` dostajemy gotowe w metadata, bez pobierania XML
      const rows = freshInvoices.map((inv) => ({
        tenant_id: tenantId,
        direction: 'incoming' as const,
        origin: 'ksef_inbox' as const,
        internal_number: inv.invoiceNumber,
        ksef_number: inv.ksefNumber,
        ksef_status: 'accepted',
        ksef_environment: env,
        ksef_accepted_at: inv.acquisitionDate,
        invoice_type: 'VAT',
        issue_date: inv.issueDate,
        seller_nip: inv.seller.nip,
        buyer_nip:
          inv.buyer.identifier.type === 'Nip'
            ? inv.buyer.identifier.value
            : null,
        currency: inv.currency,
        gross_total: inv.grossAmount,
        net_total: inv.netAmount,
        vat_total: inv.vatAmount,
        fa3_data: {
          _source: 'inbox-metadata',
          _pendingFullFetch: true,
          ksefNumber: inv.ksefNumber,
          invoiceNumber: inv.invoiceNumber,
          issueDate: inv.issueDate,
          invoicingDate: inv.invoicingDate,
          acquisitionDate: inv.acquisitionDate,
          permanentStorageDate: inv.permanentStorageDate,
          invoicingMode: inv.invoicingMode,
          invoiceType: inv.invoiceType,
          seller: inv.seller,
          buyer: inv.buyer,
          grossAmount: inv.grossAmount,
          netAmount: inv.netAmount,
          vatAmount: inv.vatAmount,
          currency: inv.currency,
          invoiceHash: inv.invoiceHash,
          formCode: inv.formCode,
          isSelfInvoicing: inv.isSelfInvoicing,
          hasAttachment: inv.hasAttachment,
        },
      }));

      let pending = freshInvoices;
      for (let attempt = 0; attempt <= freshInvoices.length; attempt++) {
        const pendingNumbers = new Set(pending.map((inv) => inv.ksefNumber));
        const pendingRows = rows.filter((row) => pendingNumbers.has(row.ksef_number));
        const { data: inserted, error } = await supabase
          .from('invoices')
          .insert(pendingRows)
          .select('id, ksef_number');

        if (!error) {
          if (!inserted || inserted.length !== pendingRows.length) {
            throw new Error('Niepełna odpowiedź po zapisie faktur przychodzących');
          }
          return inserted;
        }
        if (error.code !== '23505') {
          throw new Error(`Failed to insert incoming invoices: ${error.message}`);
        }

        // Cały batch INSERT jest atomowy. Po 23505 nowy odczyt rozstrzyga,
        // które dokumenty wygrał równoległy job. Nie robimy częściowych
        // zapisów per-row: awaria w połowie zgubiłaby ich fan-out na retry.
        const existing = await findExistingInboxNumbers(supabase, tenantId, env, pending);
        if (existing.size === 0) {
          throw new Error('Konflikt UNIQUE poza tożsamością przychodzącej faktury KSeF');
        }
        pending = pending.filter((inv) => !existing.has(inv.ksefNumber));
        if (pending.length === 0) return [];
      }
      throw new Error('Nie udało się rozstrzygnąć równoległych zapisów faktur KSeF');
    });

    const insertedNumbers = new Set(insertedInvoices.map((row) => row.ksef_number as string));
    const newlyAddedInvoices = freshInvoices.filter((inv) => insertedNumbers.has(inv.ksefNumber));

    // EXT-03 (sesja 26 planu skalowania): jeden wiersz audytu na przebieg,
    // który dodał faktury, zamiast wiersza na każdą stronę co 15 minut.
    // Przebieg bez nowych faktur nie zapisuje nic. Ponowienie (pg-boss
    // powtarza cały handler) nie dopisze drugiego wiersza: zapisane faktury
    // odsieje `filter-existing`. Awaria procesu między zapisem faktur a tym
    // wierszem zostawia faktury bez wiersza — ich przyjęcie widać w nich samych.
    if (insertedInvoices.length > 0) {
      await recordKsefPollSummary({
        tenantId,
        action: 'inbox.poll',
        metadata: {
          windowFrom: window.from,
          windowTo: window.to,
          hwm,
          // E1-W10-b: przebieg częściowy kończy się tutaj (`null` = całe okno).
          resumeFrom,
          requests,
          fetched: newInvoices.length,
          added: insertedInvoices.length,
        },
      });
    }

    // K2 (rewizja 03.10.2026): kategoryzacja kosztu i archiwum XML idą
    // NATYCHMIAST po zapisie — przed kartą FLO i pushem. Wcześniej błąd karty
    // wywracał job, ponowienie widziało faktury „już w DB”, przesuwało HWM i
    // nikt nigdy nie emitował tego zdarzenia: faktura w /inbox, ale bez kosztu
    // w KPiR i bez XML. `singletonKey` to tylko etykieta (na kolejce `standard`
    // pg-boss po nim nie deduplikuje, `lib/jobs/enqueue.ts`): cron `inbox-backfill`
    // pomija faktury z czekającym zadaniem, a dubel kończy się jednym odczytem.
    // Błąd TEJ emisji ma wywrócić job: HWM stoi, ponowienie nic nie zapisze
    // (filter-existing), a brakujące zdarzenia dośle cron po 15 minutach
    // (znacznik `fa3_data._pendingFullFetch`).
    if (insertedInvoices.length > 0) {
      await step.sendEvent(
        'fan-out-auto-categorize-inbox',
        insertedInvoices.map((row) => ({
          ...inboxInvoiceReceivedAutoCategorize.create({
            invoiceId: row.id,
            tenantId,
            environment: env,
          }),
          singletonKey: row.id as string,
        })),
      );
    }

    // Od tego miejsca wszystko jest „best effort”: karta FLO, push i zdarzenie
    // dla UI nie mogą zatrzymać HWM ani przebiegu. Błąd idzie do logu i Sentry.
    const bestEffort = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await step.run(name, fn);
      } catch (e) {
        logger.error(`Skrzynka: krok pomocniczy „${name}” nieudany — faktury i kategoryzacja są zapisane`, {
          tenantId,
          error: e instanceof Error ? e.message : String(e),
        });
        Sentry.captureException(e, {
          tags: { job: 'inbox-poll-tenant', step: name },
          extra: { tenantId },
        });
      }
    };

    // Jedna zbiorcza karta na cały przebieg. Pięć faktur w nocy to pięć
    // powiadomień o siódmej rano — czyli hałas, przez który ludzie wyłączają
    // powiadomienia i przestają widzieć również te ważne.
    if (insertedInvoices.length > 0) {
      await bestEffort('flo-inbox-card', async () => {
        const supabase = await createAdminClient();

        // Sprzedawcy, których klient już u siebie widział. Nieznany
        // sprzedawca powyżej progu nie trafia sam do księgi — to jest sito
        // na fakturę wystawioną przez pomyłkę na cudzy NIP.
        //
        // „Widział” = PRZED tym przebiegiem. Ten krok idzie po zapisie, więc
        // bez wykluczenia właśnie wstawionych faktur każdy sprzedawca z paczki
        // wyglądał na znanego i sito nie działało nigdy (recenzja ChatGPT nr 2).
        // Pytamy tylko o sprzedawców z paczki — dawne `limit(500)` z całej
        // historii gubiło znanych u większych firm.
        //
        // Paczkami po 100 NIP-ów i stronami po `id`: produkcja ucina każdą
        // odpowiedź do 1000 wierszy bez błędu (`PGRST_DB_MAX_ROWS`), a dawne
        // `limit(1000)` na paczkę oddawało tysiąc faktur jednego dużego
        // dostawcy, więc reszta paczki wyglądała na nieznaną (sesja 29 planu
        // skalowania). Sprzedawca rozpoznany raz wypada z listy, więc kolejne
        // strony pytają już tylko o jeszcze nierozpoznanych.
        //
        // Błąd odczytu paczki = znani tylko ci rozpoznani do tej pory, reszta
        // tej paczki jest nieznana: karta zapyta o więcej, zamiast przepuścić
        // coś po cichu. Następne paczki sprawdzamy dalej, każda osobno.
        const justInserted = new Set(insertedInvoices.map((row) => row.id as string));
        const batchSellers = [
          ...new Set(
            newlyAddedInvoices
              .map((inv) => inv.seller?.nip)
              .filter((nip): nip is string => Boolean(nip)),
          ),
        ];
        const known = new Set<string>();
        for (const chunk of inListChunks(batchSellers)) {
          const pending = new Set(chunk);
          try {
            await forEachPageById<{ id: string; seller_nip: string | null }>(
              'znani sprzedawcy skrzynki',
              (afterId, limit) => {
                if (pending.size === 0) return Promise.resolve({ data: [], error: null });
                let query = supabase
                  .from('invoices')
                  .select('id, seller_nip')
                  .eq('tenant_id', tenantId)
                  .eq('direction', 'incoming')
                  .in('seller_nip', [...pending]);
                if (afterId) query = query.gt('id', afterId);
                return query.order('id', { ascending: true }).limit(limit);
              },
              (rows) => {
                for (const row of rows) {
                  if (row.seller_nip && !justInserted.has(row.id)) {
                    known.add(row.seller_nip);
                    pending.delete(row.seller_nip);
                  }
                }
              },
            );
          } catch (e) {
            logger.warn('Skrzynka: nie udało się sprawdzić wszystkich znanych sprzedawców paczki, reszta paczki liczy się jako nieznana', {
              tenantId,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        const byKsefNumber = new Map(
          insertedInvoices.map((row) => [row.ksef_number as string, row.id as string]),
        );

        const documents = newlyAddedInvoices
          .filter((inv) => byKsefNumber.has(inv.ksefNumber))
          .map((inv) => ({
            id: byKsefNumber.get(inv.ksefNumber)!,
            sellerName: inv.seller?.name ?? null,
            sellerNip: inv.seller?.nip ?? null,
            grossAmount: Number(inv.grossAmount ?? 0),
            issueDate: inv.issueDate,
          }));

        const proposal = buildInboxSummaryProposal({
          tenantId,
          documents: classifyInboxDocuments(documents, known),
          periodKey: new Date().toISOString().slice(0, 10),
        });

        if (proposal) await createProposal(proposal);
      });
    }

    await bestEffort('push-inbox-new', async () => {
      const n = newlyAddedInvoices.length;
      if (n === 0) return { skipped: true as const };

      const first = newlyAddedInvoices[0];
      const body =
        n === 1
          ? `${first.invoiceNumber} · ${first.seller.name}`
          : `${n} faktur, m.in. ${first.invoiceNumber}`;

      return sendPushToTenant(tenantId, 'inbox_new', {
        title:
          n === 1
            ? 'Nowa faktura w skrzynce KSeF'
            : `${n} nowych faktur w skrzynce`,
        body,
        url: '/inbox',
        tag: `inbox-new-${tenantId}`,
      });
    });

    // Fan-out do listenerów (np. notify-user w Fazie 6 UI dla real-time toast).
    const invoiceEvents = newlyAddedInvoices.map((inv) =>
      inboxInvoiceReceived.create({
        tenantId,
        ksefNumber: inv.ksefNumber,
        sellerNip: inv.seller.nip,
        sellerName: inv.seller.name,
        grossAmount: inv.grossAmount,
        currency: inv.currency,
        acquisitionTimestamp: inv.acquisitionDate,
      }),
    );
    if (invoiceEvents.length > 0) {
      try {
        await step.sendEvent('fan-out-new-invoices', invoiceEvents);
      } catch (e) {
        logger.error('Skrzynka: zdarzenie dla UI nie wyszło — faktury i kategoryzacja są zapisane', {
          tenantId,
          error: e instanceof Error ? e.message : String(e),
        });
        Sentry.captureException(e, {
          tags: { job: 'inbox-poll-tenant', step: 'fan-out-new-invoices' },
          extra: { tenantId },
        });
      }
    }

    logger.info(
      `Dodano ${newlyAddedInvoices.length} nowych faktur przychodzących`,
      { tenantId, fetched: newInvoices.length },
    );

    return finish(newInvoices.length, newlyAddedInvoices.length);
}

