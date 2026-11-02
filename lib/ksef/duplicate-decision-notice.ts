/**
 * Ślad powiadomienia „Faktura … czeka na Twoją decyzję” (D-A4-1b-3 PR B,
 * decyzje Bartosza 07.10.2026 (5) i (12); spec §2.8).
 *
 * E-mail idzie DOKŁADNIE RAZ na fakturę i numer KSeF oryginału (K) —
 * trwały ślad w `audit_logs` (`invoice.ksef_duplicate_decision_notified`,
 * `metadata.original_ksef_number`). Operator może przypomnieć klientowi
 * najwyżej raz na 24 h; przypomnienie ma własny klucz idempotencji.
 *
 * PR C (00156, spec v3 5.7): ślad niesie `metadata.variant` (`pair` / `record` / `released` /
 * `review`). Powiadomienia mają dwie RODZINY śladów: `decision` („czeka na Twoją decyzję”,
 * ślady bez `variant` albo z `variant` innym niż `review`) i `review` („sprawdzamy fakturę
 * z KSeF” — ślad `review`). „Raz na (fakturę, K)” i reguła 24 h liczą ślady swojej rodziny,
 * więc „sprawdzamy” nie blokuje późniejszego powiadomienia o decyzji (po oddaniu).
 *
 * Fail-closed w obie strony:
 *   - błąd odczytu śladu RZUCA — „nie wiem, co wysłałem” to nie „nic nie
 *     wysłałem” (precedens `cert-expiry-alert.ts`);
 *   - błąd zapisu śladu RZUCA — nie `logAuditSystem`, który połyka błędy:
 *     zgubiony ślad złamałby „dokładnie raz”.
 *
 * Tylko klient serwisowy (`@/lib/supabase/admin`) — wywołania z joba
 * powiadomień i z akcji operatora (po `requireAdmin()`).
 */

import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';

import type { DuplicateNoticeVariant } from './duplicate-decision';

/** Akcja śladu w `audit_logs` (raport dzienny liczy ją w akcjach doby). */
export const DUPLICATE_NOTICE_ACTION = 'invoice.ksef_duplicate_decision_notified';

/** Odstęp między powiadomieniami o tej samej fakturze i K (decyzja 12). */
export const DUPLICATE_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Najwięcej śladów czytanych dla jednej faktury (przypomnienia są rzadkie). */
const NOTICE_READ_LIMIT = 200;

/** Najwięcej śladów czytanych naraz dla tabeli I5D; pełny limit = nie wiemy, czy to wszystkie. */
const NOTICE_BATCH_READ_LIMIT = 1000;

/**
 * Klucz idempotencji Resend: `ksef-duplicate-decision/{faktura}/{K}`, a dla
 * przypomnienia `…/przypomnienie-{n}`, gdzie `n` to liczba śladów przed
 * kliknięciem — podwójne kliknięcie przed zapisem trafia w ten sam klucz.
 */
export function duplicateNoticeKey(invoiceId: string, ksefNumber: string, reminder: number | null): string {
  const base = `ksef-duplicate-decision/${invoiceId}/${ksefNumber}`;
  return reminder === null ? base : `${base}/przypomnienie-${reminder}`;
}

/** PR C: klucz Resend powiadomienia „sprawdzamy fakturę z KSeF” (przegląd pliku) — raz na (fakturę, K). */
export function duplicateReviewNoticeKey(invoiceId: string, ksefNumber: string): string {
  return `ksef-duplicate-decision/${invoiceId}/${ksefNumber}/sprawdzamy`;
}

/**
 * PR C: klucz Resend e-maila po oddaniu decyzji klientowi przez operatora — `…/oddanie-{release_at}`
 * (`importGate.release.at` z RPC, w milisekundach). Ten sam klucz przy ponowieniu po zgubionej
 * odpowiedzi; Resend deduplikuje 24 h.
 */
export function duplicateReleaseNoticeKey(invoiceId: string, ksefNumber: string, releaseAt: string): string {
  const at = Date.parse(releaseAt);
  return `ksef-duplicate-decision/${invoiceId}/${ksefNumber}/oddanie-${Number.isNaN(at) ? encodeURIComponent(releaseAt) : at}`;
}

/** Rodzina śladów: `decision` („czeka na Twoją decyzję”, przypomnienia, oddanie) albo `review` („sprawdzamy”). */
export type DuplicateNoticeFamily = 'decision' | 'review';

export interface DuplicateNotices {
  /** Liczba śladów powiadomień o tej fakturze i tym K. */
  count: number;
  /** Najnowszy ślad (ISO); `null` — bez powiadomienia. */
  lastAt: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

type NoticeRow = { tenant_id?: string | null; entity_id?: string | null; created_at: string | null; metadata: unknown };

/**
 * Jeden filtr śladu dla karty faktury i tabeli I5D: ta firma, ta faktura, ten K
 * (ślad o innym K się nie liczy — inny oryginał = nowa decyzja). Filtr po K
 * także w kodzie — wynik nie zależy od tego, jak baza czyta ścieżkę jsonb.
 */
const isNoticeOf = (r: NoticeRow, tenantId: string, invoiceId: string, ksefNumber: string): boolean =>
  r.tenant_id === tenantId && r.entity_id === invoiceId && isRecord(r.metadata) && r.metadata.original_ksef_number === ksefNumber;

/** Ślad bez `variant` (sprzed PR C) należy do rodziny `decision`; `variant: 'review'` — do `review`. */
const isInFamily = (r: NoticeRow, family: DuplicateNoticeFamily): boolean => {
  const isReview = isRecord(r.metadata) && r.metadata.variant === 'review';
  return family === 'review' ? isReview : !isReview;
};

function summarizeNotices(rows: readonly NoticeRow[]): DuplicateNotices {
  let lastAt: string | null = null;
  let lastMs = -Infinity;
  for (const r of rows) {
    const t = r.created_at ? Date.parse(r.created_at) : Number.NaN;
    if (!Number.isNaN(t) && t > lastMs) {
      lastMs = t;
      lastAt = r.created_at;
    }
  }
  return { count: rows.length, lastAt };
}

/**
 * Ślady powiadomień o fakturze `invoiceId` i numerze KSeF oryginału `ksefNumber`
 * w rodzinie `family` (domyślnie `decision`). Rzuca przy błędzie odczytu.
 */
export async function findDuplicateNotices(
  tenantId: string,
  invoiceId: string,
  ksefNumber: string,
  family: DuplicateNoticeFamily = 'decision',
): Promise<DuplicateNotices> {
  const { data, error } = await createAdminClient()
    .from('audit_logs')
    .select('tenant_id, entity_id, created_at, metadata')
    .eq('action', DUPLICATE_NOTICE_ACTION)
    .eq('tenant_id', tenantId)
    .eq('entity_id', invoiceId)
    .eq('metadata->>original_ksef_number', ksefNumber)
    .order('created_at', { ascending: false })
    .limit(NOTICE_READ_LIMIT);
  if (error) throw new Error(`Nie można odczytać śladu powiadomień o decyzji klienta: ${error.message}`);
  return summarizeNotices(
    ((data ?? []) as NoticeRow[]).filter((r) => isNoticeOf(r, tenantId, invoiceId, ksefNumber) && isInFamily(r, family)),
  );
}

/**
 * Ślady powiadomień dla wielu faktur naraz — tabela I5D w `/admin/ksef`
 * (przegląd PR B, #1/#4): JEDEN odczyt `audit_logs`, ten sam filtr co karta
 * faktury (`isNoticeOf`). Klucz mapy — `invoiceId`; faktura bez śladu ma
 * `{ count: 0 }`. Rzuca przy błędzie odczytu i przy wyniku obciętym limitem
 * („nie wiemy, czy to wszystkie” to nie „nie było powiadomienia”).
 */
export async function findDuplicateNoticesBatch(
  invoices: ReadonlyArray<{ invoiceId: string; tenantId: string; ksefNumber: string }>,
  family: DuplicateNoticeFamily = 'decision',
): Promise<Map<string, DuplicateNotices>> {
  const result = new Map<string, DuplicateNotices>(invoices.map((i) => [i.invoiceId, { count: 0, lastAt: null }]));
  if (invoices.length === 0) return result;
  const { data, error } = await createAdminClient()
    .from('audit_logs')
    .select('tenant_id, entity_id, created_at, metadata')
    .eq('action', DUPLICATE_NOTICE_ACTION)
    .in('entity_id', invoices.map((i) => i.invoiceId))
    .order('created_at', { ascending: false })
    .limit(NOTICE_BATCH_READ_LIMIT);
  if (error) throw new Error(`Nie można odczytać śladu powiadomień o decyzji klienta: ${error.message}`);
  const rows = (data ?? []) as NoticeRow[];
  if (rows.length >= NOTICE_BATCH_READ_LIMIT) {
    throw new Error(`Ślad powiadomień o decyzji klienta: ${rows.length} wierszy — wynik obcięty limitem`);
  }
  for (const i of invoices) {
    result.set(
      i.invoiceId,
      summarizeNotices(rows.filter((r) => isNoticeOf(r, i.tenantId, i.invoiceId, i.ksefNumber) && isInFamily(r, family))),
    );
  }
  return result;
}

export interface DuplicateNoticeRecord {
  tenantId: string;
  invoiceId: string;
  /** K — numer KSeF oryginału, o którym było powiadomienie. */
  ksefNumber: string;
  /** `auto` — job po `invoice/submit.failed`; `operator` — „Przypomnij klientowi”. */
  via: 'auto' | 'operator';
  idempotencyKey: string;
  emailed: boolean;
  pushSent: number;
  /** Numer przypomnienia (liczba śladów przed nim); `null` dla pierwszego powiadomienia. */
  reminder?: number | null;
  /** E-mail operatora przy przypomnieniu. */
  operatorEmail?: string | null;
  /** Operator przy przypomnieniu; `null` dla joba. */
  userId?: string | null;
  /** PR C: wariant powiadomienia (`review` — rodzina „sprawdzamy”); brak — ślad PR B (rodzina `decision`). */
  variant?: DuplicateNoticeVariant;
}

/**
 * Zapis śladu powiadomienia — bezpośredni insert do `audit_logs`. RZUCA przy
 * błędzie (job ponowi od zera z tym samym kluczem Resend; operator dostaje
 * komunikat, że ślad się nie zapisał).
 */
export async function recordDuplicateNotice(record: DuplicateNoticeRecord): Promise<void> {
  const { error } = await createAdminClient().from('audit_logs').insert({
    tenant_id: record.tenantId,
    user_id: record.userId ?? null,
    action: DUPLICATE_NOTICE_ACTION,
    entity_type: 'invoice',
    entity_id: record.invoiceId,
    metadata: {
      original_ksef_number: record.ksefNumber,
      via: record.via,
      idempotency_key: record.idempotencyKey,
      emailed: record.emailed,
      push_sent: record.pushSent,
      reminder: record.reminder ?? null,
      operator: record.operatorEmail ?? null,
      ...(record.variant ? { variant: record.variant } : {}),
      source: 'system',
    },
    ip_address: null,
    user_agent: record.via === 'operator' ? 'admin-ksef' : 'inngest-job',
  });
  if (error) throw new Error(`Nie można zapisać śladu powiadomienia o decyzji klienta: ${error.message}`);
}
