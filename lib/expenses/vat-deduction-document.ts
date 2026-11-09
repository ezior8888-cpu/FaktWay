/**
 * Czy dokument kosztowy daje odliczenie VAT: rodzaj dokumentu i data jego
 * wystawienia (nie data wgrania). Jedna reguła dla JPK_V7M (wiersze zakupu,
 * K_42/K_43, P_42/P_43), VAT w module księgowości („Ten miesiąc”, „Ile
 * odłożyć”) i kafli „VAT do odliczenia” (`getCosts`).
 *
 * Paragon z NIP nabywcy do 450 zł (100 euro) jest fakturą uproszczoną tylko
 * do 31.12.2026: art. 145n ust. 1 pkt 2 ustawy o VAT (Dz.U. 2026 poz. 1263)
 * pozwala do tego dnia wystawiać paragony fiskalne uznane za faktury
 * z art. 106e ust. 5 pkt 3. Od 1.01.2027 paragon nie jest fakturą, a podatek
 * naliczony to podatek z faktur (art. 86 ust. 2 pkt 1 lit. a), więc paragon
 * z NIP z datą od 1.01.2027 odliczenia nie daje. VAT odliczy się z faktury do
 * paragonu w KSeF, która przychodzi do skrzynki jak każda faktura.
 *
 * Koszt w PIT (`kpirCostAmount`) celowo zostaje bez zmian, dopóki księgowa
 * nie rozstrzygnie, czy paragon bez faktury jest kosztem i w jakiej kwocie.
 *
 * Moduł bez zależności od serwera: używa go też formularz przeglądu kosztu.
 */

import { VAT_DEDUCTIBLE_DOCUMENTS } from '@/lib/categorization/kpir-cost';
import { addDaysToIsoDate, todayInWarsaw } from '@/lib/format/warsaw-date';

/** Pierwszy dzień, w którym paragon z NIP nie jest już fakturą uproszczoną. */
export const RECEIPT_WITH_NIP_NOT_INVOICE_FROM = '2027-01-01';

/** Paragon z NIP nabywcy do 450 zł, czyli faktura uproszczona spoza KSeF (rodzaj z OCR). */
const RECEIPT_WITH_NIP = 'simplified_invoice';

export interface CostNotice {
  title: string;
  body: string;
}

export const RECEIPT_WITH_NIP_2027_NOTICE: CostNotice = {
  title: 'Od 1 stycznia 2027 r. paragon z NIP nie jest fakturą',
  body:
    'VAT odliczysz tylko z faktury w KSeF, więc poproś sprzedawcę o fakturę do paragonu. ' +
    'Do tego czasu FaktWay nie wlicza VAT z tego paragonu do odliczenia. ' +
    'W kosztach podatku dochodowego paragon zostaje na razie tak jak dotąd, w kwocie netto. ' +
    'Czy bez faktury może być kosztem i w jakiej kwocie, potwierdzamy jeszcze z księgową.',
};

export const RECEIPT_WITH_NIP_NO_DATE_NOTICE: CostNotice = {
  title: 'Brak daty wystawienia paragonu',
  body:
    'Paragon z NIP jest fakturą uproszczoną tylko do 31 grudnia 2026 r., a bez daty nie da się tego sprawdzić, ' +
    'więc FaktWay nie odlicza z niego VAT. Datę z paragonu wpisuje się w polu „Data wystawienia”.',
};

export interface CostDocument {
  /** Rodzaj dokumentu (`costDocumentType`); brak to faktura, jak dotąd w JPK i KPiR. */
  documentType: string | null | undefined;
  /** Data wystawienia dokumentu: RRRR-MM-DD albo znacznik czasu ISO. */
  issueDate: string | null | undefined;
}

export type VatDeduction =
  | { deductible: true }
  | { deductible: false; reason: 'document_type'; notice: null }
  | { deductible: false; reason: 'receipt_with_nip_from_2027' | 'missing_issue_date'; notice: CostNotice };

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Dzień wystawienia w Polsce (RRRR-MM-DD) albo `null`, gdy daty nie ma albo
 * jest zła. Znacznik czasu ze strefą liczy się jako dzień w Europe/Warsaw
 * (23:30 UTC 31.12.2026 to już 1.01.2027); bez strefy to czas polski.
 */
export function issueDayInWarsaw(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (ISO_DAY.test(v)) return addDaysToIsoDate(v, 0);
  const m = ISO_TIMESTAMP.exec(v);
  if (!m) return null;
  if (!m[2]) return addDaysToIsoDate(m[1]!, 0);
  const at = new Date(v);
  return Number.isNaN(at.getTime()) ? null : todayInWarsaw(at);
}

export function vatDeductionForDocument(doc: CostDocument): VatDeduction {
  const type = doc.documentType ?? 'invoice';
  if (!VAT_DEDUCTIBLE_DOCUMENTS.has(type)) return { deductible: false, reason: 'document_type', notice: null };
  if (type !== RECEIPT_WITH_NIP) return { deductible: true };
  const day = issueDayInWarsaw(doc.issueDate);
  if (day === null) {
    return { deductible: false, reason: 'missing_issue_date', notice: RECEIPT_WITH_NIP_NO_DATE_NOTICE };
  }
  if (day >= RECEIPT_WITH_NIP_NOT_INVOICE_FROM) {
    return { deductible: false, reason: 'receipt_with_nip_from_2027', notice: RECEIPT_WITH_NIP_2027_NOTICE };
  }
  return { deductible: true };
}

export function documentAllowsVatDeduction(doc: CostDocument): boolean {
  return vatDeductionForDocument(doc).deductible;
}

export interface CostDocumentRow {
  document_type?: string | null;
  source?: string | null;
  ksef_invoice_id?: string | null;
  ocr_extracted_data?: unknown;
}

/**
 * Rodzaj dokumentu kosztu z wiersza `expenses`. OCR zapisuje paragon z NIP
 * (fakturę uproszczoną) jako `invoice` (`process-ocr.ts`), a rozpoznany
 * rodzaj zostaje w `ocr_extracted_data.document_type`. Koszt z KSeF to
 * faktura z KSeF, więc liczy się zapisany rodzaj.
 */
export function costDocumentType(row: CostDocumentRow): string {
  const stored = row.document_type ?? 'invoice';
  const fromKsef = row.source === 'ksef_inbox' || Boolean(row.ksef_invoice_id);
  if (stored === 'invoice' && !fromKsef && ocrDocumentType(row.ocr_extracted_data) === RECEIPT_WITH_NIP) {
    return RECEIPT_WITH_NIP;
  }
  return stored;
}

function ocrDocumentType(data: unknown): unknown {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>).document_type
    : undefined;
}
