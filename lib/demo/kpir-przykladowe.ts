import type { KpirExpenseRow, KpirInvoiceRow } from '@/lib/reports/kpir-totals';
import { roundToCents } from '@/lib/xml/invoice-calculator';

/**
 * Dane przykładowe KPiR (poprawka Bartosza 21.10.2026): firma przed weryfikacją
 * KSeF widzi księgę „w pełnej okazałości” — wynik miesiąca, wykres, pierścień
 * kosztów i wpisy. Wiersze są układane w wybranym miesiącu (dzień z próbki),
 * więc przełączanie miesięcy działa. Firmy i NIP-y są fikcyjne.
 */

const r2 = roundToCents;
const pad = (n: number) => String(n).padStart(2, '0');

function dzien(year: number, month: number, day: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(Math.min(day, last))}`;
}

function poprzedni(year: number, month: number, day: number): string {
  return month === 1 ? dzien(year - 1, 12, day) : dzien(year, month - 1, day);
}

type Koszt = [id: string, day: number, name: string, nr: string, cat: string, gross: number,
  col: KpirExpenseRow['kpir_column'], extra?: Partial<KpirExpenseRow>];

const KOSZTY: Koszt[] = [
  ['d1', 5, 'Transport Przykład sp. z o.o.', 'TR/{M}/{R}/0042', 'Transport towaru', 369, 'col_11'],
  ['d2', 10, 'Jan Przykładowy', 'UZ/{R}/{M}', 'Wynagrodzenia', 3000, 'col_12',
    { net_amount: 3000, vat_amount: 0, vat_deductible_amount: 0, vat_rate: 'zw', document_type: 'other' }],
  ['d3', 12, 'Hosting Przykład S.A.', 'F/{M}/{R}/3321', 'Usługi IT', 61.5, 'col_13'],
  ['d4', 13, 'Laboratorium Badawcze Przykład sp. z o.o.', 'LB/{R}/{M}/007', 'Badania B+R', 1845, 'col_15'],
  ['d5', 17, 'Przykładowy Sklep Biurowy sp. z o.o.', 'FS 114/{M}/{R}', 'Materiały biurowe', 123, 'col_10'],
  // Bez kolumny KPiR: nie wchodzi do sum, trafia do „Do sprawdzenia”.
  ['d6', 19, 'Restauracja Przykład', 'PAR {R}/{M}/19/88', 'Spotkanie z klientem', 184.5, null, { document_type: 'receipt' }],
  ['d7', 20, 'Stacja Paliw Przykład sp. z o.o.', 'FV/{R}/{M}/8812', 'Paliwo', 246, 'col_13'],
];

type Sprzedaz = [id: string, day: number, nr: string, gross: number, name: string, extra?: Partial<KpirInvoiceRow>];

const SPRZEDAZ: Sprzedaz[] = [
  ['s1', 8, 'FV/{M}/{R}/011', 2460, 'Biuro Projektowe Kowalski'],
  ['s2', 9, 'FV/ZAL/{M}/{R}/002', 2460, 'Przykładowa Firma Handlowa sp. z o.o.', { invoice_kind: 'advance' }],
  // ROZ: zamówienie 10 000 netto, zaliczki 4 000 — przychód 6 000.
  ['s3', 14, 'FV/ROZ/{M}/{R}/001', 12300, 'Przykładowa Firma Handlowa sp. z o.o.',
    { invoice_kind: 'final', net_total: 10000, settled_advances_net: 4000 }],
  ['s4', 15, 'FV/{M}/{R}/013', 1230, 'Przykładowa Firma Handlowa sp. z o.o.'],
  ['s5', 16, 'FV/KOR/{M}/{R}/001', -615, 'Biuro Projektowe Kowalski', { invoice_kind: 'correction', net_total: -500 }],
  ['s6', 18, 'FV/{M}/{R}/014', 4920, 'Hurtownia Przykład sp. z o.o.'],
];

export function kpirPrzykladowe(month: number, year: number): { expenses: KpirExpenseRow[]; invoices: KpirInvoiceRow[] } {
  const nr = (t: string) => t.replaceAll('{M}', pad(month)).replaceAll('{R}', String(year));
  const expenses = KOSZTY.map(([id, day, name, numer, cat, gross, col, extra]): KpirExpenseRow => {
    const date = dzien(year, month, day);
    const net = r2(gross / 1.23);
    return {
      id, tenant_id: 'przyklad-kpir', issue_date: date, seller_name: name, seller_nip: '1234567890', seller_address: null,
      document_number: nr(numer), document_type: 'invoice', category_label: cat, gross_amount: gross, net_amount: net,
      vat_amount: r2(gross - net), vat_deductible_amount: r2(gross - net), vat_rate: '23', kpir_column: col,
      is_deductible: true, is_reviewed: col !== null, source: 'manual', ksef_invoice_id: null, notes: null,
      categorization_confidence: null, categorization_method: null, created_by: null, ocr_extracted_data: null,
      ocr_job_id: null, source_file_mime: null, source_file_path: null,
      created_at: `${date}T10:00:00Z`, updated_at: `${date}T10:00:00Z`,
      ...extra,
    };
  });
  const invoices: KpirInvoiceRow[] = [
    // Sprzedaż z końca poprzedniego miesiąca, faktura z 2. dnia — wpis z datą sprzedaży.
    {
      id: 's0', internal_number: nr('FV/{M}/{R}/009'), issue_date: dzien(year, month, 2), sale_date: poprzedni(year, month, 29),
      gross_total: 3690, net_total: 3000, buyer_data: { name: 'Pracownia Przykład s.c.', nip: '1234567890' }, invoice_kind: 'regular',
    },
    ...SPRZEDAZ.map(([id, day, numer, gross, name, extra]): KpirInvoiceRow => {
      const date = dzien(year, month, day);
      return {
        id, internal_number: nr(numer), issue_date: date, sale_date: date, gross_total: gross, net_total: r2(gross / 1.23),
        buyer_data: { name, nip: '1234567890' }, invoice_kind: 'regular', ...extra,
      };
    }),
  ];
  return { expenses, invoices };
}
