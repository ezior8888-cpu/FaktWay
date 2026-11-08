/**
 * Wybór wpisów `ksef_submissions` w porządkach SQL: znacznik 440, wpis
 * `number_taken` szkicu wycofanego i zapisana na nim decyzja.
 *
 * Część barelu `./duplicate-decision` (plan usprawnień 3.7b). Spoza
 * `lib/ksef/duplicate-decision*.ts` importuj tylko z barelu `@/lib/ksef/duplicate-decision`.
 * CZYSTY moduł (komponenty klienckie i worker): bez bazy, KSeF, Node i `duplicate-verdict.ts`.
 */

import {
  DUPLICATE_DECISION_MODES,
  DUPLICATE_ORIGINAL_OFFERS,
  ORIGINAL_CORRECTABLE_BUYER_ID_KINDS,
  originalHasUncorrectableLine,
  type DuplicateDecisionMode,
  type DuplicateOriginalOffer,
} from './duplicate-check';
import { hasKey, isRecord, jsonText, str } from './duplicate-decision-jsonb';
import type { DuplicateChoice, DuplicateDecisionSubmissionRow, DuplicateVia } from './duplicate-decision-types';

// ─── Wybór wpisów (te same porządki co SQL) ──────────────────────────────────

/** Znacznik czasu do sortowania; `null` dla braku albo wartości nie do odczytu. */
function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Mikrosekundy ponad milisekundy (`timestamptz` z PostgREST ma 6 cyfr ułamka; `Date` czyta 3). */
function microsOf(value: string | null | undefined): number {
  const m = value ? /:\d{2}\.\d{3}(\d{1,3})/.exec(value) : null;
  return m ? Number(m[1]!.padEnd(3, '0')) : 0;
}

/** `ORDER BY <czas> DESC NULLS LAST, id` — jak w 00148 (z dokładnością do mikrosekundy). */
function compareDescNullsLastThenId(
  a: { id: string },
  rawA: string | null | undefined,
  b: { id: string },
  rawB: string | null | undefined,
): number {
  const ta = timeOf(rawA);
  const tb = timeOf(rawB);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  }
  if (ta !== null) {
    const micro = microsOf(rawB) - microsOf(rawA);
    if (micro !== 0) return micro;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Znacznik 440: najnowszy wpis `intent`/`sent` z numerem oryginału
 * (`ORDER BY attempted_at DESC NULLS LAST, id`, 2.1.2 #7). Tego samego wyboru
 * używa ładowarka faktów.
 */
export function duplicateMarker<T extends Pick<DuplicateDecisionSubmissionRow, 'id' | 'status' | 'original_ksef_number' | 'attempted_at'>>(
  submissions: readonly T[],
): T | null {
  return [...submissions]
    .filter((s) => (s.status === 'intent' || s.status === 'sent') && s.original_ksef_number != null)
    .sort((a, b) => compareDescNullsLastThenId(a, a.attempted_at, b, b.attempted_at))[0] ?? null;
}

export type TakenRowFields = Pick<DuplicateDecisionSubmissionRow, 'id' | 'status' | 'original_ksef_number' | 'original_check' | 'completed_at'>;

const hasDecisionKey = (row: Pick<DuplicateDecisionSubmissionRow, 'original_check'>): boolean =>
  isRecord(row.original_check) && hasKey(row.original_check, 'decision');

/**
 * Wpis `number_taken`, który opisuje szkic wycofany — porządek wyzwalacza
 * (2.1.4 krok 2): najpierw z decyzją, potem z numerem oryginału, potem
 * `completed_at` malejąco (brak na końcu), potem `id`.
 */
export function retiredRow<T extends TakenRowFields>(submissions: readonly T[]): T | null {
  return [...submissions]
    .filter((s) => s.status === 'number_taken')
    .sort((a, b) => {
      const decided = Number(hasDecisionKey(b)) - Number(hasDecisionKey(a));
      if (decided !== 0) return decided;
      const withK = Number(b.original_ksef_number != null) - Number(a.original_ksef_number != null);
      if (withK !== 0) return withK;
      return compareDescNullsLastThenId(a, a.completed_at, b, b.completed_at);
    })[0] ?? null;
}

/** Napis z listy (`mode`, `offer`, rodzaj znacznika); inaczej `null`. */
export const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;

/** Decyzja zapisana na wpisie `number_taken` — pola, które czyta aplikacja. */
interface RowDecision {
  choice: DuplicateChoice;
  via: DuplicateVia;
  at: string;
  /** PR C (00156): tryb decyzji `faktflow-original`; `null` — decyzja PR B (bez klucza `mode`). */
  mode: DuplicateDecisionMode | null;
  /** PR C: oferta pokazana przy decyzji; `null` — decyzja PR B. */
  offer: DuplicateOriginalOffer | null;
  /** PR C, tryb `import`: faktura K zapisana z KSeF. */
  importedInvoiceId: string | null;
  /** PR C, tryb `import`: numer, który przeszedł z dokumentu na K. */
  retiredInternalNumber: string | null;
}

/**
 * `original_check->'decision'` z poprawnym wyborem (jak `->>'choice'` w wyzwalaczu); inaczej `null`.
 * PR C (5.5): także tryb, oferta, faktura K i dawny numer (decyzje `faktflow-original`).
 */
export function decisionOf(row: Pick<DuplicateDecisionSubmissionRow, 'original_check'>): RowDecision | null {
  if (!isRecord(row.original_check)) return null;
  const d = row.original_check.decision;
  if (!isRecord(d) || (d.choice !== 'same_sale' && d.choice !== 'other_sale')) return null;
  return {
    choice: d.choice,
    via: d.via === 'operator' ? 'operator' : 'client',
    at: typeof d.at === 'string' ? d.at : '',
    mode: oneOf(d.mode, DUPLICATE_DECISION_MODES),
    offer: oneOf(d.offer, DUPLICATE_ORIGINAL_OFFERS),
    importedInvoiceId: str(d.importedInvoiceId),
    retiredInternalNumber: str(d.retiredInternalNumber),
  };
}

/** Korekta faktury K istnieje w FaktWay tylko dla nabywcy z NIP albo numerem VAT-UE (F44). */
export const isCorrectableBuyer = (kind: unknown): boolean =>
  typeof kind === 'string' && (ORIGINAL_CORRECTABLE_BUYER_ID_KINDS as readonly string[]).includes(kind);

/** Decyzja z zapisem oryginału K na wpisie `number_taken` (lustro kroku 2 wyzwalacza 00156, 4.11). */
interface ImportedDecision {
  importedInvoiceId: string;
  /** `COALESCE(retiredInternalNumber, numer dokumentu, 'bez numeru')` — numer, który przeszedł na K. */
  nrOld: string;
  /** `->>'choice' = 'other_sale'`; każdy inny wybór to „ta sama sprzedaż” (jak wyzwalacz). */
  other: boolean;
  offer: DuplicateOriginalOffer | null;
  via: DuplicateVia;
  at: string;
  /** `decision.original.buyerIdKind ∉ ('nip','vat-ue')` — zdanie `FAKTFLOW.CORRECTION_PERSON` (6.4). */
  correctionForPerson: boolean;
  /** `originalHasUncorrectableLine(original_check.importGate)` — zdanie `FAKTFLOW.CORRECTION_RATE` (D-A4-1b-3-KORZW); bez bramy `false`. */
  correctionForRate: boolean;
}

/**
 * Lustro 4.11: `->>'importedInvoiceId'` nie NULL i wpis z K — tekst `*_IMPORTED`
 * (poprawność wyboru nie jest warunkiem, jak w wyzwalaczu). Bez K albo bez
 * `importedInvoiceId` (decyzja PR B, `no-import`) — `null`, teksty 00148.
 */
export function importedDecisionOf(row: TakenRowFields, invoiceNumber: string | null): ImportedDecision | null {
  if (row.original_ksef_number == null || !isRecord(row.original_check)) return null;
  const d = row.original_check.decision;
  if (!isRecord(d)) return null;
  const importedInvoiceId = jsonText(d.importedInvoiceId);
  if (importedInvoiceId === null) return null;
  const original = isRecord(d.original) ? d.original : null;
  return {
    importedInvoiceId,
    nrOld: jsonText(d.retiredInternalNumber) ?? invoiceNumber ?? 'bez numeru',
    other: jsonText(d.choice) === 'other_sale',
    offer: oneOf(d.offer, DUPLICATE_ORIGINAL_OFFERS),
    via: d.via === 'operator' ? 'operator' : 'client',
    at: typeof d.at === 'string' ? d.at : '',
    correctionForPerson: !isCorrectableBuyer(original?.buyerIdKind),
    // Podgląd pliku zostaje na znaczniku po decyzji (`importGate` nie jest ruszany) — baner liczy z niego jak panel.
    correctionForRate: originalHasUncorrectableLine(row.original_check.importGate),
  };
}
