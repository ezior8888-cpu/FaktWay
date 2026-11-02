/**
 * Zdarzenie `invoice/submit.requested` odtworzone z wiersza faktury — dla
 * ponowień bez udziału klienta (cron cyklu życia, operator; od A4b PR2b także
 * „Wyślij ponownie” klienta). Czysty moduł (bez Supabase i Next), żeby runner
 * i akcje dzieliły jedną definicję tego, co jest „kompletnym” wierszem.
 *
 * Źródła danych zdarzenia (A4b):
 *   - zwykła faktura: `fa3_data`;
 *   - zaliczka (ZAL): `fa3_data` + koperta `fa3_data.advanceEnvelope`;
 *   - korekta (KOR) i rozliczenie (ROZ): `fa3_data` + `special_data` (00137,
 *     zapis jednorazowy przy wystawieniu).
 * Zdarzenie ma te same klucze co pierwsze kolejkowanie
 * (`lib/invoices/ksef-submit-enqueue.ts`), więc granica wysyłki porówna
 * zapisaną kopię z samą sobą, a XML (ten sam `xml_generated_at`) wyjdzie
 * bajt w bajt taki sam.
 *
 * Decyzja Bartosza 06.10.2026 (b): pełna wysyłka KOR/ZAL/ROZ z kopii tylko
 * w dniu wystawienia (lustro bezpiecznika 00147 przy zleceniu; worker odmawia
 * po północy sam). Uzgodnienie („Tylko uzgodnij”, I5) datę pomija — nie wysyła.
 *
 * Każdy `select`, z którego powstaje wiersz źródłowy, zawiera
 * `KSEF_RESEND_SOURCE_COLUMNS`; kolumna niepobrana (`undefined`, w odróżnieniu
 * od `null`) to błąd programisty, nie stary dokument — dlatego wyjątek.
 */

import type { JobEvent } from '@/lib/jobs/enqueue';
import type { AdvanceInvoiceSettlementRow } from '@/lib/ksef/fa3-advance-generator';
import { isKindHeldForEnv } from '@/lib/ksef/kind-holds';
import { specialIssueDateIsToday } from '@/lib/ksef/special-issue-date';
import type { Invoice } from '@/types/invoice';
import type { AdvanceInvoiceData, CorrectionInvoiceData, FinalInvoiceData } from '@/types/invoice-types';
import type { KsefEnvironment } from '@/types/ksef';

/** Kolumny źródła ponowienia — w każdym `select` (cron, operator, od PR2b klient). */
export const KSEF_RESEND_SOURCE_COLUMN_KEYS = ['invoice_kind', 'issue_date', 'fa3_data', 'special_data'] as const;
/** To samo jako napis do `select` — literał, bo supabase-js wyprowadza typy z napisu. */
export const KSEF_RESEND_SOURCE_COLUMNS = 'invoice_kind, issue_date, fa3_data, special_data' as const;

export type KsefResendSourceColumn = (typeof KSEF_RESEND_SOURCE_COLUMN_KEYS)[number];
export type KsefResendSourceRow = Record<KsefResendSourceColumn, unknown>;

export type KsefRequeueSourceRow = KsefResendSourceRow & {
  id: string;
  tenant_id: string;
  tenants?: { nip: string | null } | { nip: string | null }[] | null;
};

export interface KsefSendPayload {
  invoice: Invoice;
  correctionData?: CorrectionInvoiceData;
  advanceData?: AdvanceInvoiceData;
  finalData?: FinalInvoiceData;
  finalAdvanceSettlementRows?: AdvanceInvoiceSettlementRow[];
  auditKind: 'regular' | 'correction' | 'advance' | 'final';
}

/** Fakty o ponowieniu z kopii — bez treści dokumentu, bezpieczne w komponencie klienckim. */
export interface KsefResendFacts {
  sendData: 'stored' | 'missing';
  kindHeld: boolean;
  issueDatePassed: boolean;
}

export type KsefRequeueRefusal = 'missing-special-data' | 'incomplete' | 'kind-held' | 'issue-date' | 'no-nip';

export type KsefRequeueEventResult =
  | { ok: true; event: JobEvent; sendAttemptId: string }
  | { ok: false; reason: KsefRequeueRefusal };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Kolumna niepobrana w `select` (`undefined`) — błąd, nie brak danych (`null`). */
export function assertResendColumnsSelected(row: object): void {
  for (const key of KSEF_RESEND_SOURCE_COLUMN_KEYS) {
    if ((row as Record<string, unknown>)[key] === undefined) {
      throw new Error(`KSEF_RESEND_SOURCE_COLUMNS: kolumna ${key} nie została pobrana`);
    }
  }
}

/**
 * Dane zdarzenia z wiersza — tylko jawne klucze, bez rozpakowywania jsonb.
 * `null`, gdy wiersz ich nie ma (dokument sprzed 00137 / sprzed koperty ZAL)
 * albo gdy kształt nie zgadza się z rodzajem (lustro granicy wysyłki).
 */
export function storedSendPayload(row: KsefResendSourceRow): KsefSendPayload | null {
  assertResendColumnsSelected(row);
  const fa3 = row.fa3_data;
  if (!isRecord(fa3) || !Array.isArray(fa3.lines)) return null;
  const invoice = fa3 as unknown as Invoice;
  const special = row.special_data;
  switch (row.invoice_kind) {
    case 'regular':
      return special === null ? { invoice, auditKind: 'regular' } : null;
    case 'advance': {
      const envelope = fa3.advanceEnvelope;
      return special === null && isRecord(envelope)
        ? { invoice, advanceData: envelope as unknown as AdvanceInvoiceData, auditKind: 'advance' }
        : null;
    }
    case 'correction': {
      const correctionData = isRecord(special) ? special.correctionData : undefined;
      return isRecord(correctionData)
        ? { invoice, correctionData: correctionData as unknown as CorrectionInvoiceData, auditKind: 'correction' }
        : null;
    }
    case 'final': {
      const finalData = isRecord(special) ? special.finalData : undefined;
      const rows = isRecord(special) ? special.finalAdvanceSettlementRows : undefined;
      return isRecord(finalData) && Array.isArray(rows) && rows.length > 0
        ? {
          invoice,
          finalData: finalData as unknown as FinalInvoiceData,
          finalAdvanceSettlementRows: rows as AdvanceInvoiceSettlementRow[],
          auditKind: 'final',
        }
        : null;
    }
    default:
      // Rodzaj nieznany (także NULL) — nigdy domyślnie „zwykła”.
      return null;
  }
}

export function ksefSendDataStatus(row: KsefResendSourceRow): 'stored' | 'missing' {
  return storedSendPayload(row) ? 'stored' : 'missing';
}

export function ksefResendFacts(row: KsefResendSourceRow, env: KsefEnvironment | null, now: Date = new Date()): KsefResendFacts {
  const payload = storedSendPayload(row);
  // Decyzja Bartosza 06.10.2026 (b): lustro bezpiecznika 00147 przy zleceniu — runner czyta
  // fa3_data.issueDate, hak sesji datę P_1 z danych dokumentu; tu oba i kolumna.
  // Usunąć razem z nim, gdy B2 obejmie wszystkie rodzaje.
  const dates = payload
    ? [row.issue_date, payload.invoice.issueDate,
      payload.correctionData?.issueDate ?? payload.advanceData?.issueDate ?? payload.finalData?.issueDate]
    : [row.issue_date];
  return {
    sendData: payload ? 'stored' : 'missing',
    kindHeld: isKindHeldForEnv(row.invoice_kind, env),
    issueDatePassed: row.invoice_kind !== 'regular' && !dates.every((date) => specialIssueDateIsToday(date, now)),
  };
}

/** Dane zdarzenia albo powód odmowy — kolejność: dane → rodzaj wstrzymany → data (bez uzgodnienia). */
export function ksefSendPayloadFromRow(
  row: KsefResendSourceRow,
  options: { environment: KsefEnvironment | null; reconcileOnly: boolean; now?: Date },
): { ok: true; payload: KsefSendPayload } | { ok: false; reason: Exclude<KsefRequeueRefusal, 'no-nip'> } {
  const payload = storedSendPayload(row);
  if (!payload) return { ok: false, reason: row.invoice_kind === 'regular' ? 'incomplete' : 'missing-special-data' };
  const facts = ksefResendFacts(row, options.environment, options.now);
  // Także uzgodnienie: runner zatrzymuje hamulec przed uzgodnieniem i nadpisuje kod.
  if (facts.kindHeld) return { ok: false, reason: 'kind-held' };
  if (facts.issueDatePassed && !options.reconcileOnly) return { ok: false, reason: 'issue-date' };
  return { ok: true, payload };
}

export function buildKsefRequeueEvent(
  row: KsefRequeueSourceRow,
  environment: KsefEnvironment,
  sendAttemptId: string,
  options: { reconcileOnly: boolean; now?: Date },
): KsefRequeueEventResult {
  if (typeof row.id !== 'string' || typeof row.tenant_id !== 'string') {
    throw new Error('KSEF_RESEND_SOURCE_COLUMNS: wiersz bez id albo tenant_id');
  }
  const built = ksefSendPayloadFromRow(row, { environment, reconcileOnly: options.reconcileOnly, now: options.now });
  if (!built.ok) return built;
  const { invoice, correctionData, advanceData, finalData, finalAdvanceSettlementRows } = built.payload;
  const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
  const nip = (tenant?.nip ?? invoice.seller?.nip ?? '').replace(/\s+/g, '');
  if (!nip) return { ok: false, reason: 'no-nip' };

  return {
    ok: true,
    sendAttemptId,
    event: {
      groupId: row.tenant_id,
      // Etykieta w `pgboss.job`, nie deduplikacja (`lib/jobs/enqueue.ts`): przed
      // drugim zleceniem chroni przejście statusu w RPC.
      singletonKey: row.id,
      name: 'invoice/submit.requested',
      data: {
        tenantId: row.tenant_id,
        invoiceId: row.id,
        invoice,
        nip,
        environment,
        ...(correctionData ? { correctionData } : {}),
        ...(advanceData ? { advanceData } : {}),
        ...(finalData ? { finalData, finalAdvanceSettlementRows } : {}),
        sendAttemptId,
        // Runner w tym trybie nigdy nie wysyła od nowa (brak wpisu → RESULT_UNCERTAIN / NOT_IN_KSEF).
        ...(options.reconcileOnly ? { reconcileOnly: true } : {}),
      },
    },
  };
}
