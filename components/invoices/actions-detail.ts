'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';

import { logAudit } from '@/lib/audit/log';
import {
  KSEF_RESEND_SOURCE_COLUMNS,
  ksefResendFacts,
  ksefSendPayloadFromRow,
} from '@/lib/invoices/ksef-requeue-event';
import { enqueueKsefSubmitAfterDraft } from '@/lib/invoices/ksef-submit-enqueue';
import {
  canManageKsefSend,
  decideResend,
  describeResetError,
  KSEF_SEND_MESSAGES,
} from '@/lib/invoices/ksef-send-policy';
import { createAdminClient } from '@/lib/supabase/admin';
import { ActionAuthError, requireOrgRole, requireUserAndActiveOrg } from '@/lib/supabase/auth-context';
import { downloadInvoiceXml } from '@/lib/storage/r2';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import {
  KSEF_ORIGINAL_ALARM_KINDS,
  parseDuplicateCheck,
  type DuplicateDecisionMode,
  type DuplicateOriginalOffer,
  type OriginalRecheckKind,
} from '@/lib/ksef/duplicate-check';
import {
  DUPLICATE_DECISION_SQL_TEXTS,
  DUPLICATE_DECISION_TEXTS,
  decisionLabel,
  duplicateDecisionOptions,
  duplicateMarker,
  fillSqlText,
  type DuplicateChoice,
} from '@/lib/ksef/duplicate-decision';
import { loadDuplicateDecisionFacts } from '@/lib/ksef/duplicate-decision-facts';
import {
  callDecideKsefDuplicate,
  callDecideKsefDuplicateOriginal,
  callFlagKsefOriginalRecheck,
  type DecideKsefDuplicateOriginalResult,
  type DuplicateRpcError,
} from '@/lib/ksef/duplicate-decision-rpc';
import {
  originalDecisionAlarms,
  originalRecheckKindFor,
  prepareOriginalImport,
  type PrepareOriginalImportResult,
} from '@/lib/ksef/duplicate-original-import';
import type { KsefOriginalImportProjection } from '@/lib/ksef/duplicate-original-projection';
import type { KsefEnvironment } from '@/types/ksef';
import { validateInvoice } from '@/lib/xml/invoice-calculator';
import { generateInvoicePdf, verifyInvoicePdfDeliveryState } from '@/lib/pdf/invoice-pdf';
import { loadInvoiceForPdf } from '@/lib/pdf/invoice-data';
import { invoiceEmailAmount } from '@/lib/email/invoice-email-amount';
import { sendInvoiceEmail } from '@/lib/email/send';
import { checkRateLimit } from '@/lib/rate-limit';

// ═══════════════════════════════════════════════════════════════
// downloadInvoiceXmlAction
// ═══════════════════════════════════════════════════════════════

export type DownloadXmlResult =
  | { success: true; xml: string; filename: string }
  | { success: false; error: string };

/**
 * Pobiera XML faktury z R2 i oddaje jego treść do klienta (Blob → <a download>).
 *
 * Bezpieczeństwo: wymagamy zweryfikowanej sesji MFA i aktywnego członkostwa,
 * a odczyt przez RLS dodatkowo zawężamy do aktywnej organizacji.
 *
 * Weryfikujemy SHA-256 z `xml_documents` - niezgodność oznaczałaby
 * korupcję plików w R2 (lub rozjazd DB↔R2), wtedy zwracamy błąd
 * zamiast podawać uszkodzony plik.
 */
export async function downloadInvoiceXmlAction(
  invoiceId: string
): Promise<DownloadXmlResult> {
  try {
    const { supabase, user, tenantId } = await requireUserAndActiveOrg();

    const { data: inv, error: invErr } = await supabase
      .from('invoices')
      .select('internal_number, xml_storage_path, tenant_id')
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (invErr) return { success: false, error: invErr.message };
    if (!inv?.xml_storage_path) {
      return {
        success: false,
        error: 'Brak pliku XML - faktura nie została jeszcze wysłana do KSeF.',
      };
    }

    const { data: xmlDoc, error: xmlErr } = await supabase
      .from('xml_documents')
      .select('sha256_hash')
      .eq('storage_path', inv.xml_storage_path)
      .eq('tenant_id', inv.tenant_id)
      .eq('invoice_id', invoiceId)
      .maybeSingle();

    if (xmlErr) return { success: false, error: xmlErr.message };
    if (!xmlDoc?.sha256_hash) {
      return {
        success: false,
        error: 'Brak rekordu xml_documents dla tej faktury (re-sync wymagany).',
      };
    }

    const xml = await downloadInvoiceXml(
      inv.xml_storage_path,
      xmlDoc.sha256_hash,
      inv.tenant_id,
    );

    const safeName = (inv.internal_number ?? invoiceId).replace(
      /[^a-zA-Z0-9_-]+/g,
      '-'
    );

    await logAudit({
      action: 'invoice.xml_downloaded',
      tenantId,
      userId: user.id,
      entityType: 'invoice',
      entityId: invoiceId,
      metadata: { internalNumber: inv.internal_number },
    });

    return {
      success: true,
      xml,
      filename: `${safeName}.xml`,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Błąd pobierania XML',
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// resendInvoiceAction
// ═══════════════════════════════════════════════════════════════

export type ResendResult =
  | { success: true }
  | { success: false; error: string; code?: 'KSEF_NOT_VERIFIED' | 'MFA_REQUIRED' };

interface ResendRow {
  ksef_status: string | null;
  direction: string | null;
  invoice_kind: string | null;
  invoice_type: string | null;
  last_error_code: string | null;
  issue_date: string | null;
  fa3_data: unknown;
  special_data: unknown;
}

/** Kolumny źródła ponowienia (A4b) + stan wysyłki — bez eksportu (plik 'use server'). */
const RESEND_ROW_COLUMNS = `${KSEF_RESEND_SOURCE_COLUMNS}, ksef_status, direction, invoice_type, last_error_code` as const;

/**
 * „Wyślij ponownie” (cykl życia faktury, PR 3b — K3): `failed → queued` przez
 * RPC `requeue_ksef_send` w jednej transakcji ze zleceniem pg-boss. Kto i kiedy:
 * `lib/invoices/ksef-send-policy.ts` (właściciel/admin — D4; `rejected` nigdy,
 * wraca do szkicu — D2; klasy terminal/hold/reconcile nie). Runner i tak
 * zaczyna od uzgodnienia po referencji, więc historyczny `failed` bez kodu
 * nie wysyła faktury drugi raz, jeśli KSeF ją ma.
 *
 * Korektę, zaliczkę i ROZ wysyłamy z kopii na wierszu (A4b PR2b) — te same
 * fakty i builder co cron i operator; tylko w dniu wystawienia (decyzja b),
 * po północy worker kończy kodem ISSUE_DATE_PASSED. `validateInvoice` tylko
 * dla zwykłej faktury: korekta anulująca ma ujemne ilości, a treść dokumentu
 * specjalnego sprawdził zapis, generator i XSD.
 */
export async function resendInvoiceAction(
  invoiceId: string
): Promise<ResendResult> {
  try {
    const { supabase, user, tenantId, role } = await requireUserAndActiveOrg();
    if (!canManageKsefSend(role)) {
      return { success: false, error: KSEF_SEND_MESSAGES.role };
    }
    const { data, error } = await supabase
      .from('invoices')
      .select(RESEND_ROW_COLUMNS)
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    if (error || !data) {
      return { success: false, error: KSEF_SEND_MESSAGES.notFound };
    }
    const row = data as unknown as ResendRow;
    const env = configuredKsefEnvironment();
    const now = new Date();
    const facts = ksefResendFacts(row, env, now);
    const decision = decideResend({
      direction: row.direction,
      status: row.ksef_status,
      errorCode: row.last_error_code,
      invoiceKind: row.invoice_kind,
      facts,
      environmentKnown: env !== null,
    });
    if (!decision.allowed) {
      if (decision.reason === 'reconcile') {
        // Klient prosi o wysyłkę faktury „do uzgodnienia” — operator ma to zobaczyć.
        Sentry.captureMessage('Klient prosi o ponowną wysyłkę faktury wymagającej uzgodnienia', {
          level: 'warning',
          tags: { area: 'ksef.resend' },
          extra: { tenantId, invoiceId, code: row.last_error_code },
        });
      }
      return { success: false, error: decision.message };
    }

    const built = ksefSendPayloadFromRow(row, { environment: env, reconcileOnly: false, now });
    if (!built.ok) {
      // Nieosiągalne: decyzja wyżej odmówiła braku danych, rodzaju i daty na tych samych faktach.
      throw new Error(`resend: decyzja i dane zdarzenia się rozjechały (${built.reason})`);
    }
    const payload = built.payload;
    const invoice = payload.invoice;
    if (payload.auditKind === 'regular') {
      const problems = validateInvoice(invoice);
      if (problems.length > 0) {
        return { success: false, error: problems[0]! };
      }
    }

    const { data: tenant } = await supabase
      .from('tenants')
      .select('nip')
      .eq('id', tenantId)
      .maybeSingle();
    const nip = (tenant?.nip as string | null | undefined) ?? invoice.seller?.nip;
    if (!nip) return { success: false, error: 'Brak NIP firmy.' };

    const enq = await enqueueKsefSubmitAfterDraft({
      supabase,
      tenantId,
      userId: user.id,
      invoiceId,
      nip,
      invoice,
      correctionData: payload.correctionData,
      advanceData: payload.advanceData,
      finalData: payload.finalData,
      finalAdvanceSettlementRows: payload.finalAdvanceSettlementRows,
      auditKind: payload.auditKind,
      internalNumberForAudit: invoice.internalNumber,
      mode: { kind: 'requeue', actorUserId: user.id },
    });
    if (!enq.ok) {
      return enq.code
        ? { success: false, error: enq.error, code: enq.code }
        : { success: false, error: enq.error };
    }

    revalidatePath('/invoices');
    revalidatePath(`/invoices/${invoiceId}`);
    return { success: true };
  } catch (err) {
    if (err instanceof ActionAuthError) {
      return { success: false, error: err.message };
    }
    // Np. kolumna spoza KSEF_RESEND_SOURCE_COLUMNS albo rozjazd decyzji — błąd programu, nie klienta.
    Sentry.captureException(err, { tags: { area: 'ksef.resend' }, extra: { invoiceId } });
    return {
      success: false,
      error: 'Nie można sprawdzić możliwości ponownej wysyłki. Spróbuj później.',
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// resetInvoiceToDraftAction
// ═══════════════════════════════════════════════════════════════

export type ResetToDraftResult =
  | { success: true }
  | { success: false; error: string };

/**
 * „Wróć do szkicu” (PR 3b, decyzja D2): `failed`/`rejected → draft` przez RPC
 * `reset_ksef_send` (00131). RPC odmawia, gdy faktura ma dowód kontaktu
 * z KSeF (numer KSeF albo wpis `sent`/`accepted`/`duplicate`) albo kod klasy
 * reconcile — wtedy sprawą zajmuje się operator. Klucz serwisowy, bo
 * przejścia stanu są serwerowe (RPC przepuszczają tylko service_role);
 * firma i rola pochodzą z sesji (`requireOrgRole`).
 */
export async function resetInvoiceToDraftAction(
  invoiceId: string
): Promise<ResetToDraftResult> {
  try {
    const { user, tenantId } = await requireOrgRole(['owner', 'admin']);
    const { error } = await createAdminClient().rpc('reset_ksef_send', {
      p_invoice_id: invoiceId,
      p_tenant_id: tenantId,
      p_actor_user_id: user.id,
    });
    if (error) {
      return { success: false, error: describeResetError(error) };
    }
    revalidatePath('/invoices');
    revalidatePath(`/invoices/${invoiceId}`);
    return { success: true };
  } catch (err) {
    if (err instanceof ActionAuthError) {
      return { success: false, error: err.message };
    }
    return { success: false, error: KSEF_SEND_MESSAGES.resetFailed };
  }
}

// ═══════════════════════════════════════════════════════════════
// decideKsefDuplicateAction — decyzja klienta przy nierozstrzygniętym 440
// ═══════════════════════════════════════════════════════════════

export type DecideKsefDuplicateInput = {
  invoiceId: string;
  choice: DuplicateChoice;
  /** Numer KSeF oryginału pokazany klientowi (wiązanie z danymi na stronie). */
  originalKsefNumber: string;
  /** SHA-256 danych oryginału pokazanych klientowi (wiązanie). */
  originalSha256: string;
  /** Zaznaczone „Rozumiem skutki” (decyzja 7 — sprawdzane też tutaj, nie tylko w UI). */
  confirmed: boolean;
  /**
   * PR C (INV-8): tryb (`import` — zapis faktury z KSeF; `no-import` — oddana decyzja), oferta
   * (`pair`/`record`/`released`) i środowisko KSeF serwera, które pokazał panel `faktflow-original`.
   * Serwer liczy je od nowa i odmawia `STALE`, gdy którakolwiek wartość się różni. Powody PR B
   * (`no-own-file`, `known-number`) ich nie niosą — brak = `null`.
   */
  mode?: DuplicateDecisionMode | null;
  offer?: DuplicateOriginalOffer | null;
  env?: KsefEnvironment | null;
};

export type DecideKsefDuplicateResult =
  | { success: true; message: string }
  | { success: false; error: string };

const isDuplicateChoice = (v: unknown): v is DuplicateChoice => v === 'same_sale' || v === 'other_sale';

const BOTH_CHOICES: readonly DuplicateChoice[] = ['same_sale', 'other_sale'];

/** `DETAIL` odmów P0001 `decide_ksef_duplicate_original`, których tekst z bazy idzie do klienta bez alarmu (stan zmienił się od odczytu). */
const PASSTHROUGH_REFUSAL_DETAILS: ReadonlySet<string> = new Set([
  'mode',
  'offer',
  'choice',
  'already',
  'recheck-needed',
  'provenance-review',
  'known-now',
  'cross-tenant',
]);

/** Toast po zapisie oryginału z KSeF: z zapisanej decyzji (oferta, wybór), nie z wejścia akcji. `nrK` = numer przeniesiony na fakturę z KSeF. */
function importedDecisionToast(offer: DuplicateOriginalOffer | null | undefined, choice: DuplicateChoice, nrK: string): string {
  const F = DUPLICATE_DECISION_TEXTS.FAKTFLOW;
  const label = decisionLabel(offer, choice);
  return label === 'record' ? F.TOAST_RECORD(nrK) : label === 'other_sale' ? F.TOAST_OTHER(nrK) : F.TOAST_SAME(nrK);
}

/**
 * Alarmy po decyzji (K bez daty nadania / bez sesji, T5) — ze stanu bazy, na KAŻDEJ ścieżce sukcesu.
 * Zapisana decyzja nie może zamienić się w błąd: `originalDecisionAlarms` nie rzuca, a ta osłona
 * łapie ewentualny błąd programu (trwały sygnał K bez sesji / daty i tak pokaże I3K).
 */
async function reportOriginalDecisionAlarms(tenantId: string, invoiceId: string, importedInvoiceId: string): Promise<void> {
  try {
    await originalDecisionAlarms(createAdminClient(), { tenantId, invoiceId, importedInvoiceId });
  } catch (err) {
    Sentry.captureException(err, { tags: { area: 'ksef.duplicate-decision' }, extra: { tenantId, invoiceId, importedInvoiceId } });
  }
}

/**
 * Odmowa w chwili zapisu: brak/inne archiwum, inna ocena pliku, projekcja nie przechodzi lustra albo baza
 * jej nie przyjęła. Zostaje trwały znacznik „sprawdź ponownie” (`flag_ksef_original_recheck`, INV-25 —
 * idempotentny; błąd zapisu zgłasza i tak nie rzucający wrapper), klient dostaje `RECHECK` z numerem dokumentu,
 * a Sentry jedno zgłoszenie z odciskiem `[kind, invoiceId]` (powtórzone kliknięcie go nie mnoży).
 * Gdy `flag_*` odpowie `stale` / `not-pending` (stan zmienił się od kliknięcia, np. decyzja operatora w międzyczasie),
 * nic nie zostało oznaczone: klient dostaje `STALE` (odśwież stronę), bez tekstu „sprawdzimy” i bez alarmu.
 */
async function refuseOriginalForRecheck(args: {
  tenantId: string;
  userId: string;
  invoiceId: string;
  nr: string;
  originalKsefNumber: string;
  originalSha256: string;
  recheckKind: OriginalRecheckKind;
  alarmKind: string;
  alarmMessage: string;
  detail: string;
}): Promise<DecideKsefDuplicateResult> {
  const flagged = await callFlagKsefOriginalRecheck(createAdminClient(), {
    invoiceId: args.invoiceId,
    tenantId: args.tenantId,
    actorUserId: args.userId,
    originalKsefNumber: args.originalKsefNumber,
    originalSha256: args.originalSha256,
    kind: args.recheckKind,
  });
  if (flagged?.reason === 'stale' || flagged?.reason === 'not-pending') {
    return { success: false, error: DUPLICATE_DECISION_TEXTS.STALE };
  }
  Sentry.captureMessage(args.alarmMessage, {
    level: 'warning',
    // Wartość tagu w Sentry ma limit 200 znaków — opis rozjazdu bramy bywa dłuższy; pełny trafia do `extra`.
    tags: { area: 'ksef.duplicate-decision', kind: args.alarmKind, detail: args.detail.slice(0, 190) },
    fingerprint: [args.alarmKind, args.invoiceId],
    extra: { tenantId: args.tenantId, invoiceId: args.invoiceId, originalKsefNumber: args.originalKsefNumber, detail: args.detail },
  });
  return { success: false, error: DUPLICATE_DECISION_TEXTS.FAKTFLOW.RECHECK(args.nr) };
}

/**
 * „To ta sama sprzedaż” / „To inna sprzedaż” (PR B) i „Zapisz fakturę z KSeF w FaktWay” (PR C) na karcie
 * faktury (decyzje Bartosza 04.10, 07.10 i 08.10.2026). Kolejność: rola (właściciel/administrator),
 * środowisko KSeF serwera, fakty SESJĄ klienta (RLS; przy `faktflow-original` także blokada SQL sesji, 4.9)
 * i ta sama polityka co panel, wiązanie z tym, co pokazał panel (numer KSeF i SHA-256 oryginału, tryb,
 * oferta, środowisko — INV-8), wybór dozwolony w ofercie, „Rozumiem skutki”. Dopiero potem:
 *   - powody PR B: RPC `decide_ksef_duplicate` kluczem serwisowym (przejścia stanu są serwerowe);
 *   - `faktflow-original`, tryb `import`: suchy przebieg `prepareOriginalImport` (archiwum → SHA-256 →
 *     brama → projekcja; tylko odczyty) i `decide_ksef_duplicate_original` z projekcją; każda odmowa suchego
 *     przebiegu zostawia znacznik „sprawdź ponownie” (INV-25), tekst `RECHECK` i alarm — bez RPC decyzji;
 *   - `faktflow-original`, tryb `no-import` (oddana decyzja): to samo RPC bez projekcji i bez archiwum.
 * RPC sprawdza to samo w bazie i zapisuje audyt; akcja własnego audytu nie pisze. Po decyzji (także
 * `already_decided` i wczesny widok `decided`) alarmy ze stanu bazy: K bez daty nadania albo bez sesji.
 *
 * Ponowienie po zgubionej odpowiedzi (drugie kliknięcie): szkic wycofany tą samą decyzją daje sukces bez RPC
 * (z toastem z ZAPISANEJ decyzji i alarmami z bazy); RPC samo też odpowiada `already_decided`.
 */
export async function decideKsefDuplicateAction(
  input: DecideKsefDuplicateInput,
): Promise<DecideKsefDuplicateResult> {
  const T = DUPLICATE_DECISION_TEXTS;
  const F = T.FAKTFLOW;
  const ALARM = KSEF_ORIGINAL_ALARM_KINDS;
  try {
    const { supabase, user, tenantId, role } = await requireUserAndActiveOrg();
    if (!canManageKsefSend(role)) return { success: false, error: T.ROLE };
    if (!isDuplicateChoice(input.choice)) return { success: false, error: T.GENERIC };

    const env = configuredKsefEnvironment();
    if (env === null) return { success: false, error: KSEF_SEND_MESSAGES.envUnknown };

    const now = new Date();
    const facts = await loadDuplicateDecisionFacts(supabase, tenantId, input.invoiceId, undefined, { sqlBlocker: 'session' });
    const view = duplicateDecisionOptions({ facts, actor: 'client', canManage: true, environment: env, now });
    const nr = facts.invoice?.internal_number ?? '(bez numeru)';
    const toast = input.choice === 'same_sale' ? T.TOAST_SAME(nr) : T.TOAST_OTHER;

    if (view.kind === 'decided') {
      // Zapis oryginału z KSeF (`importedInvoiceId`): dokument nie ma już numeru — teksty nazywają DAWNY numer.
      const importedInvoiceId = view.importedInvoiceId ?? null;
      const nrOld = view.retiredInternalNumber ?? nr;
      if (view.choice === input.choice && view.originalKsefNumber === input.originalKsefNumber) {
        if (importedInvoiceId === null) return { success: true, message: toast };
        await reportOriginalDecisionAlarms(tenantId, input.invoiceId, importedInvoiceId);
        return { success: true, message: importedDecisionToast(view.offer, view.choice, nrOld) };
      }
      // Inny wybór (albo inny oryginał) niż zapisany — ten sam tekst co RPC (ALREADY / ALREADY_IMPORTED).
      if (importedInvoiceId !== null) {
        return {
          success: false,
          error: fillSqlText(
            DUPLICATE_DECISION_SQL_TEXTS.ALREADY_IMPORTED.template,
            nrOld,
            F.IMPORTED_CARD_CHOICE[decisionLabel(view.offer, view.choice)],
          ),
        };
      }
      return {
        success: false,
        error: fillSqlText(
          DUPLICATE_DECISION_SQL_TEXTS.ALREADY.template,
          nr,
          view.choice === 'same_sale' ? 'ta sama sprzedaż' : 'inna sprzedaż',
        ),
      };
    }
    if (view.kind === 'refused') return { success: false, error: view.message ?? T.GENERIC };
    if (view.kind !== 'decidable') {
      // Widok `review` (przegląd pliku) jest tylko dla operatora — klient nigdy go nie dostaje (polityka odmawia
      // `provenance-review`); gdyby jednak, odmowa przed jakimkolwiek zapisem (M2).
      return { success: false, error: fillSqlText(DUPLICATE_DECISION_SQL_TEXTS['provenance-review'].template, nr) };
    }

    // Wiązanie z tym, co pokazał panel (INV-8): oryginał, tryb, oferta, środowisko. Dla powodów PR B widok ma
    // `mode = offer = null`, a panel nie wysyła tych pól.
    const viewMode = view.mode ?? null;
    const viewOffer = view.offer ?? null;
    if (view.originalKsefNumber !== input.originalKsefNumber || view.originalSha256 !== input.originalSha256) {
      return { success: false, error: T.STALE };
    }
    if ((input.mode ?? null) !== viewMode || (input.offer ?? null) !== viewOffer) return { success: false, error: T.STALE };
    if (viewOffer !== null && (input.env ?? null) !== env) return { success: false, error: T.STALE };

    // Oferta „tylko zapis” (`record`) zna jeden wybór — inny to odmowa z numerem dokumentu.
    if (!(view.choices ?? BOTH_CHOICES).includes(input.choice)) {
      return { success: false, error: fillSqlText(DUPLICATE_DECISION_SQL_TEXTS.CHOICE.template, nr) };
    }
    if (view.needsConfirmation[input.choice] && !input.confirmed) {
      return { success: false, error: T.CONFIRM };
    }

    const faktflow = viewOffer !== null && viewMode !== null ? { offer: viewOffer, mode: viewMode } : null;

    // Tryb `import`: suchy przebieg PRZED RPC — tylko odczyty (archiwum), oddaje projekcję K dla `p_import`.
    let importPayload: KsefOriginalImportProjection | null = null;
    if (faktflow?.mode === 'import') {
      const marker = duplicateMarker(facts.submissions);
      const check = marker ? parseDuplicateCheck(marker.original_check) : null;
      if (!check || view.invoiceNumber === null) return { success: false, error: T.GENERIC };

      // NIP firmy (reguła `seller` bramy i lustra 4.8): z sesji klienta, jak w „Wyślij ponownie”.
      const { data: tenant, error: tenantError } = await supabase.from('tenants').select('nip').eq('id', tenantId).maybeSingle();
      const tenantNip = (tenant?.nip as string | null | undefined) ?? null;
      if (tenantError || !tenantNip) {
        Sentry.captureException(tenantError ?? new Error('decideKsefDuplicateAction: firma bez NIP'), {
          tags: { area: 'ksef.duplicate-decision' },
          extra: { tenantId, invoiceId: input.invoiceId },
        });
        return { success: false, error: F.READ_FAILED(nr) };
      }

      const prepared: PrepareOriginalImportResult = await prepareOriginalImport({
        tenantId,
        internalNumber: view.invoiceNumber,
        tenantNip,
        offer: faktflow.offer,
        check,
        ksefNumber: view.originalKsefNumber,
        env,
        now,
      });
      if (!prepared.ok) {
        const recheckKind = originalRecheckKindFor(prepared);
        if (recheckKind === null) {
          // Chwilowy błąd magazynu — bez znacznika (klient odświeża i klika jeszcze raz).
          Sentry.captureException(prepared.cause ?? new Error('prepareOriginalImport: odczyt archiwum nieudany'), {
            tags: { area: 'ksef.duplicate-decision' },
            extra: { tenantId, invoiceId: input.invoiceId },
          });
          return { success: false, error: F.READ_FAILED(nr) };
        }
        const detail = prepared.detail ? `${prepared.kind}:${prepared.detail}` : prepared.kind;
        return refuseOriginalForRecheck({
          tenantId,
          userId: user.id,
          invoiceId: input.invoiceId,
          nr,
          originalKsefNumber: view.originalKsefNumber,
          originalSha256: view.originalSha256,
          recheckKind,
          alarmKind: ALARM.recheck,
          alarmMessage: 'Zapis oryginału z KSeF odmówiony — faktura wraca do ponownego sprawdzenia',
          detail,
        });
      }
      importPayload = prepared.projection;
    }

    const admin = createAdminClient();
    // Wynik 9-argumentowego RPC jest podzbiorem wyniku `_original` (te same klucze, bez pól trybu).
    let rpc: { data: DecideKsefDuplicateOriginalResult | null; error: DuplicateRpcError | null };
    if (faktflow) {
      rpc = await callDecideKsefDuplicateOriginal(admin, {
        invoiceId: input.invoiceId,
        tenantId,
        actorUserId: user.id,
        choice: input.choice,
        via: 'client',
        originalKsefNumber: input.originalKsefNumber,
        originalSha256: input.originalSha256,
        env,
        note: null,
        mode: faktflow.mode,
        offer: faktflow.offer,
        importPayload,
      });
    } else {
      rpc = await callDecideKsefDuplicate(admin, {
        invoiceId: input.invoiceId,
        tenantId,
        actorUserId: user.id,
        choice: input.choice,
        via: 'client',
        originalKsefNumber: input.originalKsefNumber,
        originalSha256: input.originalSha256,
        env,
        note: null,
      });
    }
    const { data, error } = rpc;
    if (error) {
      const details = error.details ?? '';
      if (error.code === 'P0001' && details.startsWith('import-mismatch:')) {
        // Lustro TS przepuściło to, czego baza nie przyjęła (numer faktury albo NIP sprzedawcy) — rozjazd do naprawy.
        return refuseOriginalForRecheck({
          tenantId,
          userId: user.id,
          invoiceId: input.invoiceId,
          nr,
          originalKsefNumber: input.originalKsefNumber,
          originalSha256: input.originalSha256,
          recheckKind: 'import-mismatch',
          alarmKind: ALARM.importRefused,
          alarmMessage: 'Baza odrzuciła zapis oryginału z KSeF, który przepuściło lustro w TypeScript',
          detail: details,
        });
      }
      if (error.code === '22023' && details.startsWith('import-projection:')) {
        return refuseOriginalForRecheck({
          tenantId,
          userId: user.id,
          invoiceId: input.invoiceId,
          nr,
          originalKsefNumber: input.originalKsefNumber,
          originalSha256: input.originalSha256,
          recheckKind: 'import-projection',
          alarmKind: ALARM.importRefused,
          alarmMessage: 'Baza odrzuciła projekcję oryginału z KSeF, którą przepuściło lustro w TypeScript',
          detail: details,
        });
      }
      if (error.code === 'P0001' && error.message) {
        // Stan zmienił się od odczytu (tryb, oferta, wybór, blokada) — tekst z bazy dla klienta, bez alarmu.
        if (PASSTHROUGH_REFUSAL_DETAILS.has(details)) return { success: false, error: error.message };
        // Polityka TS pozwoliła, baza odmówiła — rozjazd TS↔SQL (np. wiersz `payments`
        // niewidoczny dla sesji, §7 p. 18). Komunikat bazy jest dla klienta (nazywa dokument).
        Sentry.captureMessage('Decyzja przy duplikacie 440: RPC odmówiło mimo zgody polityki', {
          level: 'warning',
          tags: { area: 'ksef.duplicate-decision' },
          extra: { tenantId, invoiceId: input.invoiceId, choice: input.choice },
        });
        return { success: false, error: error.message };
      }
      if (error.code === 'P0002') return { success: false, error: KSEF_SEND_MESSAGES.notFound };
      if (error.code === '42501') return { success: false, error: T.ROLE };
      Sentry.captureException(new Error(`decide_ksef_duplicate: błąd bazy ${error.code ?? 'bez kodu'}`), {
        tags: { area: 'ksef.duplicate-decision' },
        extra: { tenantId, invoiceId: input.invoiceId },
      });
      return { success: false, error: T.GENERIC };
    }

    let message = toast;
    if (faktflow) {
      if (data === null) {
        // Baza odpowiedziała bez błędu i bez wyniku — błąd programu; decyzja jest idempotentna, ponowienie
        // trafi w widok `decided` (sukces + alarmy z bazy).
        Sentry.captureException(new Error('decide_ksef_duplicate_original: pusty wynik'), {
          tags: { area: 'ksef.duplicate-decision' },
          extra: { tenantId, invoiceId: input.invoiceId },
        });
        return { success: false, error: T.GENERIC };
      }
      // Alarmy ze stanu bazy na każdej ścieżce sukcesu (nowa decyzja i `already_decided`); flagi z RPC nie są źródłem.
      const importedInvoiceId = data.imported_invoice_id ?? null;
      if (importedInvoiceId !== null) {
        await reportOriginalDecisionAlarms(tenantId, input.invoiceId, importedInvoiceId);
        // Toast z wyniku RPC (oferta, numer, który przeszedł na K), nie z wejścia.
        message = importedDecisionToast(data.offer ?? faktflow.offer, input.choice, data.retired_internal_number ?? nr);
      }
    }

    revalidatePath('/invoices');
    revalidatePath(`/invoices/${input.invoiceId}`);
    return { success: true, message };
  } catch (err) {
    if (err instanceof ActionAuthError) {
      return { success: false, error: err.message };
    }
    Sentry.captureException(err, { tags: { area: 'ksef.duplicate-decision' }, extra: { invoiceId: input.invoiceId } });
    return { success: false, error: T.GENERIC };
  }
}

// ═══════════════════════════════════════════════════════════════
// emailInvoiceAction — wysyłka faktury do nabywcy z PDF (Faza 33 Krok 8)
// ═══════════════════════════════════════════════════════════════

export type EmailInvoiceResult =
  | { success: true }
  | { success: false; error: string };

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Ile faktur firma może wysłać mailem w godzinie (AUD-102). */
const INVOICE_EMAILS_PER_HOUR = 30;

export async function emailInvoiceAction(
  invoiceId: string,
  recipientEmail: string,
): Promise<EmailInvoiceResult> {
  const email = recipientEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { success: false, error: 'Nieprawidłowy adres email.' };
  }

  let context: Awaited<ReturnType<typeof requireUserAndActiveOrg>>;
  try {
    // PDF uses a service-role loader, so the tenant must come from live
    // membership verification, never from the caller-controlled org cookie.
    context = await requireUserAndActiveOrg();
  } catch (err) {
    if (err instanceof ActionAuthError) {
      return { success: false, error: err.message };
    }
    throw err;
  }
  const { user, tenantId } = context;

  // Limit na firmę PRZED generowaniem PDF (AUD-102): wysyłka idzie z domeny
  // FaktWay na dowolny adres. Limit w pamięci procesu przy braku Redisa
  // wystarcza — jedna instancja aplikacji.
  const quota = await checkRateLimit({
    bucket: 'invoice_email',
    identifier: tenantId,
    limit: INVOICE_EMAILS_PER_HOUR,
    windowSeconds: 3600,
  });
  if (!quota.allowed) {
    return {
      success: false,
      error: `Osiągnięto limit ${INVOICE_EMAILS_PER_HOUR} wysyłek faktur mailem na godzinę. Spróbuj później.`,
    };
  }

  const pdfResult = await generateInvoicePdf(invoiceId, tenantId);
  if (!pdfResult.success) {
    return { success: false, error: pdfResult.error };
  }
  // B14: podgląd bez KODU I nie jest wizualizacją faktury dla nabywcy.
  if (pdfResult.missingKodI) {
    return {
      success: false,
      error: 'Nie wysyłamy tej faktury mailem: brak kodu QR KSeF (aplikacja nie ma zapisanego pliku XML). Nabywca znajdzie fakturę w KSeF.',
    };
  }

  const data = await loadInvoiceForPdf(invoiceId, tenantId);
  if (!data || data.tenantId !== tenantId) {
    return { success: false, error: 'Faktura nie istnieje.' };
  }

  const inv = data.invoice;
  const amount = invoiceEmailAmount(inv);
  const deliveryFailure = await verifyInvoicePdfDeliveryState(invoiceId, tenantId, pdfResult.qrStateKey, {
    refuseRetiredDraft: true,
  });
  if (deliveryFailure) {
    return { success: false, error: deliveryFailure.error };
  }
  const send = await sendInvoiceEmail({
    to: email,
    invoiceNumber: inv.internalNumber,
    sellerName: inv.seller.name,
    amountCaption: amount.caption,
    amountLabel: amount.label,
    dueDate: inv.payment.dueDate,
    pdf: pdfResult.pdf,
    pdfFilename: pdfResult.filename,
  });

  if (!send.sent) {
    return {
      success: false,
      error:
        send.reason === 'not-configured'
          ? 'Wysyłka email nie jest skonfigurowana.'
          : 'Nie udało się wysłać wiadomości.',
    };
  }

  await logAudit({
    action: 'invoice.emailed',
    tenantId,
    userId: user.id,
    entityType: 'invoice',
    entityId: invoiceId,
    metadata: { recipient: email },
  });

  return { success: true };
}
