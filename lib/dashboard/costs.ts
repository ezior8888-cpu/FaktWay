import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import {
  kpirCostAmount,
  VAT_DEDUCTIBLE_DOCUMENTS,
} from '@/lib/categorization/kpir-cost';
import { KSEF_INVOICE_CATEGORY, KSEF_INVOICE_COST_SOURCE } from '@/lib/dashboard/ksef-invoice-cost';
import { assertKsefExpensesReadyForPln } from '@/lib/expenses/ksef-currency-review';
import { filterExpensesForKsefEnvironment } from '@/lib/expenses/ksef-environment';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import type { PageContext } from '@/lib/supabase/page-context';
import { roundToCents } from '@/lib/xml/invoice-calculator';

export { costHref, isKsefInvoiceCost, KSEF_INVOICE_CATEGORY, KSEF_INVOICE_COST_SOURCE } from '@/lib/dashboard/ksef-invoice-cost';

/**
 * Koszty — dwie drogi odczytu, obie tutaj:
 *
 * 1. `getCosts` — WYDATKI jak w KPiR (plan Finora §2.4 pkt 12), ta sama
 *    droga co eksport (`fetchExpensesForExport`): `expenses` z
 *    `is_deductible = true` w zakresie dat → `readCompletePages` →
 *    `filterExpensesForKsefEnvironment` → `assertKsefExpensesReadyForPln`.
 *    Czytają ją ekrany tabeli wydatków i Skrzynki (rozliczenie klienta).
 * 2. `getCostsWithKsefPurchases` — PEŁNE koszty kart Pulpitu, Przepływów
 *    i Analiz (PLAN-PRAWDZIWE-DANE E10, decyzja Bartosza D-K 23.10.2026):
 *    wydatki z drogi 1 plus faktury zakupu z KSeF, do których wydatku nie ma
 *    (archiwum z historii KSeF, faktura ze Skrzynki przed utworzeniem
 *    wydatku). Faktura i jej wydatek to JEDEN koszt (00121) — liczy się
 *    wydatek. KPiR, JPK, eksporty i tabela `expenses` się nie zmieniają.
 */

export interface CostEntry {
  id: string;
  issueDate: string;
  /**
   * Źródło wydatku (`ksef_inbox` = faktura ze skrzynki KSeF) — P9 liczy z niego
   * koszty skrzynki. Faktura zakupu z KSeF bez wydatku: `KSEF_INVOICE_COST_SOURCE`
   * (`id` to wtedy id faktury, nie wydatku — `costHref`).
   */
  source: string;
  sellerNip: string | null;
  sellerName: string | null;
  /** Koszt jak w KPiR: `kpirCostAmount` (netto + VAT bez prawa do odliczenia). */
  cost: number;
  /** Wypływ pieniędzy: `gross_amount` z tego samego wiersza. */
  outflow: number;
  /**
   * VAT do odliczenia: `vat_deductible_amount` tylko dla dokumentów
   * z `VAT_DEDUCTIBLE_DOCUMENTS` (ta sama reguła co JPK_V7M), inaczej 0.
   */
  vatDeductible: number;
  /**
   * Plan Finora P10 (analiza kosztów): kategoria z `category_label` (`null`,
   * gdy wydatek jej nie ma), VAT naliczony z dokumentu (`vat_amount`, bez
   * reguły odliczenia) i czy wydatek jest opisany (`is_reviewed`).
   */
  categoryLabel: string | null;
  vat: number;
  /** Numer dokumentu (faktura, paragon) — lista operacji na `/przeplywy`. */
  documentNumber: string | null;
  /**
   * Czy wydatek zatwierdzono (dane z OCR i KSeF czekają na akceptację).
   * Faktura z KSeF bez wydatku: `false`, ale nie jest „do opisania” — nie ma
   * czego opisać w Wydatkach (`isKsefInvoiceCost` rozstrzyga przed tym polem).
   */
  isReviewed: boolean;
}

/**
 * Komunikat `filterExpensesForKsefEnvironment`, gdy nie da się ODCZYTAĆ
 * faktur KSeF (błąd PostgREST-a). To awaria odczytu, nie brak uzgodnienia —
 * klient nie ma czego uzgadniać, więc dostaje inny tekst.
 */
const PROVENANCE_READ_FAILED = 'KSeF expense invoice provenance check is unavailable';

const EXPENSE_COLUMNS =
  'id, source, ksef_invoice_id, issue_date, seller_nip, seller_name, document_number, category_label, net_amount, vat_amount, gross_amount, vat_deductible_amount, document_type, is_reviewed, ocr_extracted_data';

/**
 * Koszty z zakresu `[from, toExclusive)` (daty RRRR-MM-DD), posortowane po
 * `issue_date`, potem `id`.
 *
 * Wyjątki (karta pokazuje ich treść klientowi, więc są po polsku):
 * - niepełny odczyt stron — komunikat z `readCompletePages`;
 * - błąd odczytu faktur KSeF przy sprawdzaniu środowiska — „Nie można
 *   sprawdzić środowiska kosztów KSeF” (oryginał w `cause`);
 * - koszt ze skrzynki KSeF bez uzgodnionego środowiska — „Koszty ze skrzynki
 *   KSeF wymagają uzgodnienia środowiska KSeF” (oryginał w `cause`);
 * - koszt KSeF w walucie obcej bez przeglądu i kursu —
 *   `KsefExpenseCurrencyNotSupportedError` bez zmian.
 */
export async function getCosts(
  supabase: PageContext['supabase'],
  tenantId: string,
  range: { from: string; toExclusive: string },
): Promise<CostEntry[]> {
  const environment = requireConfiguredKsefEnvironment();

  const rows = await readCompletePages('Nie można odczytać kosztów', (from, to) =>
    supabase
      .from('expenses')
      .select(EXPENSE_COLUMNS, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('is_deductible', true)
      .gte('issue_date', range.from)
      .lt('issue_date', range.toExclusive)
      .order('id', { ascending: true })
      .range(from, to),
  );

  let visible: typeof rows;
  try {
    visible = await filterExpensesForKsefEnvironment(supabase, tenantId, environment, rows);
  } catch (cause) {
    // Funkcja wspólna z eksportem rzuca po angielsku; klient widzi ten tekst.
    if (cause instanceof Error && cause.message === PROVENANCE_READ_FAILED) {
      throw new Error('Nie można sprawdzić środowiska kosztów KSeF', { cause });
    }
    throw new Error('Koszty ze skrzynki KSeF wymagają uzgodnienia środowiska KSeF', { cause });
  }

  // C-11: koszt KSeF w walucie obcej bez przeglądu i kursu zatrzymuje kartę.
  await assertKsefExpensesReadyForPln(
    visible.map((row) => ({
      source: row.source,
      ksef_invoice_id: row.ksef_invoice_id,
      issue_date: row.issue_date,
      is_reviewed: row.is_reviewed === true,
      ocr_extracted_data: row.ocr_extracted_data ?? null,
    })),
    async (ids) => {
      const { data, error } = await supabase
        .from('invoices')
        .select('id, currency')
        .eq('tenant_id', tenantId)
        .in('id', ids);
      if (error) throw new Error('Nie można sprawdzić walut faktur KSeF');
      return new Map((data ?? []).map((row) => [row.id as string, row.currency as string | null]));
    },
  );

  visible.sort((a, b) =>
    a.issue_date.localeCompare(b.issue_date) || a.id.localeCompare(b.id));

  return visible.map((row) => ({
    id: row.id,
    issueDate: row.issue_date,
    source: String(row.source),
    sellerNip: typeof row.seller_nip === 'string' && row.seller_nip.trim()
      ? row.seller_nip.trim()
      : null,
    sellerName: typeof row.seller_name === 'string' && row.seller_name.trim()
      ? row.seller_name
      : null,
    cost: kpirCostAmount(row),
    outflow: Number(row.gross_amount ?? 0),
    // Brak typu dokumentu = faktura, jak w `nonDeductedVat` i eksporcie JPK.
    vatDeductible: VAT_DEDUCTIBLE_DOCUMENTS.has(row.document_type ?? 'invoice')
      ? Number(row.vat_deductible_amount ?? 0)
      : 0,
    categoryLabel: typeof row.category_label === 'string' && row.category_label.trim()
      ? row.category_label.trim()
      : null,
    vat: Number(row.vat_amount ?? 0),
    documentNumber: typeof row.document_number === 'string' && row.document_number.trim()
      ? row.document_number.trim()
      : null,
    isReviewed: row.is_reviewed === true,
  }));
}

/**
 * Suma `cost` dla każdego klucza miesiąca `RRRR-MM` z `monthKeys`, w tej
 * samej kolejności, zaokrąglona do groszy. Koszt spoza kluczy jest pomijany.
 */
export function sumCostsByMonth(
  entries: readonly CostEntry[],
  monthKeys: readonly string[],
): number[] {
  const byMonth = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.issueDate.slice(0, 7);
    byMonth.set(key, (byMonth.get(key) ?? 0) + entry.cost);
  }
  return monthKeys.map((key) => roundToCents(byMonth.get(key) ?? 0));
}

// ─── Pełne koszty kart: faktury zakupu z KSeF + wydatki (E10, D-K) ────────

/** Faktury zakupu z KSeF: Skrzynka i archiwum z historii (`processImportedInvoices`, `ksef_history`). */
const KSEF_PURCHASE_ORIGINS = ['ksef_inbox', 'ksef_import'];

/**
 * Nazwa sprzedawcy: `seller_data` (historia) albo metadane Skrzynki
 * (`fa3_data.seller`) — ścieżką JSON, bez czytania całego `fa3_data`.
 * Wydatki powiązane z fakturą (`ksef_invoice_id`) w tym samym zapytaniu —
 * osadzenie po kluczu obcym (jak `critical-alerts-monitor`), bez odczytu
 * na każdą setkę faktur.
 */
const PURCHASE_COLUMNS =
  'id, issue_date, internal_number, ksef_number, seller_nip, seller_data, ksef_seller_name:fa3_data->seller->>name, net_total, vat_total, gross_total, currency, linked_expenses:expenses!expenses_ksef_invoice_id_fkey(id)';

/** Tyle NIP-ów na jedno `.in()` — długość adresu PostgREST-a. */
const LOOKUP_CHUNK = 100;

/**
 * Faktura zakupu z KSeF w walucie obcej, do której nie ma jeszcze wydatku.
 * Kursu przy fakturze nie zapisujemy (Skrzynka ma tylko metadane), a kurs
 * NBP i przegląd kwot ma wydatek (`auto-categorize-inbox`) — bez niego nie
 * zgadujemy złotówek, karta stoi (wzór C-11). Wyjście dla klienta: wydatek
 * z tej faktury w Wydatkach (Skrzynka tworzy go po pobraniu; od chwili, gdy
 * istnieje, decyduje on i karta rusza). Wyjście operatora: cron
 * `inbox-backfill` ponawia kategoryzację faktur z `_pendingFullFetch`.
 */
export class KsefPurchaseCurrencyError extends Error {
  constructor(documentNumber: string, currency: string) {
    super(
      `Raport wstrzymany: faktura zakupu ${documentNumber} z KSeF jest w ${currency || 'nieznanej walucie'}. ` +
        'Sprawdź jej przeliczenie na złote w Wydatkach.',
    );
    this.name = 'KsefPurchaseCurrencyError';
  }
}

interface PurchaseRow {
  id: string;
  issue_date: string;
  internal_number: string | null;
  ksef_number: string | null;
  seller_nip: string | null;
  seller_data: unknown;
  ksef_seller_name: unknown;
  net_total: number | string | null;
  vat_total: number | string | null;
  gross_total: number | string | null;
  currency: string | null;
  /** Wydatki z `ksef_invoice_id` = ta faktura (00121: najwyżej jeden). */
  linked_expenses: Array<{ id: string }> | null;
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/** NIP do porównań: same cyfry, dokładnie 10 — inaczej brak. */
function nip10(value: unknown): string | null {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  return digits.length === 10 ? digits : null;
}

/** Numer dokumentu do porównań: bez odstępów i wielkości liter („fv 1/10” = „FV1/10”). */
function documentKey(value: unknown): string | null {
  const key = typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : '';
  return key || null;
}

function purchaseNumber(row: PurchaseRow): string | null {
  return text(row.internal_number) ?? text(row.ksef_number);
}

function sellerNameOf(row: PurchaseRow): string | null {
  const data = row.seller_data;
  const fromData = data && typeof data === 'object' && !Array.isArray(data)
    ? text((data as Record<string, unknown>).name)
    : null;
  return fromData ?? text(row.ksef_seller_name);
}

/**
 * Faktury zakupu, które mają już wydatek — więc liczy się wydatek, nie faktura:
 *
 * - wydatek powiązany (`ksef_invoice_id`, 00121: najwyżej jeden na fakturę;
 *   osadzony w odczycie faktur), bez względu na `is_deductible` — wydatek
 *   wyłączony z kosztów (waluta do przeglądu, koszt prywatny) wyłącza też
 *   fakturę, jak w KPiR;
 * - ten sam dokument wpisany ręcznie albo z OCR, bez powiązania: ten sam NIP
 *   sprzedawcy i numer (numer faktury jest unikalny u wystawcy). Bez daty —
 *   OCR potrafi wziąć datę sprzedaży zamiast wystawienia. Zapytanie szuka
 *   NIP-u w zapisie 10 cyfr (tak zapisują OCR i Skrzynka); NIP wpisany ręcznie
 *   z kreskami nie zostanie rozpoznany i dokument policzy się dwa razy.
 */
async function purchasesWithExpense(
  supabase: PageContext['supabase'],
  tenantId: string,
  purchases: readonly PurchaseRow[],
): Promise<Set<string>> {
  const covered = new Set<string>();
  for (const purchase of purchases) {
    if ((purchase.linked_expenses?.length ?? 0) > 0) covered.add(purchase.id);
  }

  const byDocument = new Map<string, string[]>();
  for (const purchase of purchases) {
    if (covered.has(purchase.id)) continue;
    const nip = nip10(purchase.seller_nip);
    const number = documentKey(purchaseNumber(purchase));
    if (!nip || !number) continue;
    const key = `${nip}|${number}`;
    byDocument.set(key, [...(byDocument.get(key) ?? []), purchase.id]);
  }
  const nips = [...new Set([...byDocument.keys()].map((key) => key.slice(0, 10)))];
  for (let start = 0; start < nips.length; start += LOOKUP_CHUNK) {
    const chunk = nips.slice(start, start + LOOKUP_CHUNK);
    const rows = await readCompletePages('Nie można odczytać kosztów', (from, to) =>
      supabase
        .from('expenses')
        .select('id, seller_nip, document_number', { count: 'exact' })
        .eq('tenant_id', tenantId)
        .is('ksef_invoice_id', null)
        .in('seller_nip', chunk)
        .order('id', { ascending: true })
        .range(from, to),
    );
    for (const row of rows) {
      const nip = nip10(row.seller_nip);
      const number = documentKey(row.document_number);
      if (!nip || !number) continue;
      for (const id of byDocument.get(`${nip}|${number}`) ?? []) covered.add(id);
    }
  }
  return covered;
}

/**
 * Faktura zakupu jako koszt — tak, jak zaksięgowałaby ją Skrzynka
 * (`auto-categorize-inbox`): czynny podatnik odlicza VAT (koszt = netto),
 * firma zwolniona podmiotowo nie (koszt = brutto, `kpirCostAmount`).
 * Korekta ma kwoty różnicy ze znakiem — koszt i wypływ wychodzą ujemne.
 */
function purchaseCost(row: PurchaseRow, vatExempt: boolean): CostEntry {
  const net = Number(row.net_total ?? 0);
  const vat = Number(row.vat_total ?? 0);
  const vatDeductible = vatExempt ? 0 : vat;
  return {
    id: row.id,
    issueDate: row.issue_date,
    source: KSEF_INVOICE_COST_SOURCE,
    sellerNip: text(row.seller_nip),
    sellerName: sellerNameOf(row),
    cost: kpirCostAmount({ net_amount: net, vat_amount: vat, vat_deductible_amount: vatDeductible, document_type: 'invoice' }),
    outflow: Number(row.gross_total ?? 0),
    vatDeductible,
    categoryLabel: KSEF_INVOICE_CATEGORY,
    vat,
    documentNumber: purchaseNumber(row),
    isReviewed: false,
  };
}

/**
 * PEŁNE koszty z zakresu `[from, toExclusive)` dla kart Pulpitu, Przepływów
 * i Analiz (E10, D-K) — jedna definicja:
 *
 * - wydatki jak w KPiR (`getCosts`: ręczne, OCR, import, ze Skrzynki);
 * - faktury zakupu z KSeF w aktywnym środowisku (`direction = 'incoming'`,
 *   przyjęte, pochodzenie Skrzynka albo historia), do których nie ma
 *   wydatku (`purchasesWithExpense`): kategoria „Faktury z KSeF”, koszt
 *   netto do wyniku (`cost`), brutto do przepływów (`outflow`).
 *
 * Posortowane po dacie dokumentu, potem `id`. Wyjątki kart jak w `getCosts`
 * oraz `KsefPurchaseCurrencyError` (faktura w walucie obcej bez wydatku).
 */
export async function getCostsWithKsefPurchases(
  supabase: PageContext['supabase'],
  tenantId: string,
  range: { from: string; toExclusive: string },
): Promise<CostEntry[]> {
  const environment = requireConfiguredKsefEnvironment();
  const [expenses, purchases] = await Promise.all([
    getCosts(supabase, tenantId, range),
    readCompletePages<PurchaseRow>('Nie można odczytać faktur zakupu z KSeF', (from, to) =>
      supabase
        .from('invoices')
        .select(PURCHASE_COLUMNS, { count: 'exact' })
        .eq('tenant_id', tenantId)
        .eq('direction', 'incoming')
        .eq('ksef_status', 'accepted')
        .eq('ksef_environment', environment)
        .in('origin', KSEF_PURCHASE_ORIGINS)
        .gte('issue_date', range.from)
        .lt('issue_date', range.toExclusive)
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ]);
  if (purchases.length === 0) return expenses;

  const covered = await purchasesWithExpense(supabase, tenantId, purchases);
  const remaining = purchases.filter((purchase) => !covered.has(purchase.id));
  if (remaining.length === 0) return expenses;

  // C-11: bez kursu przy fakturze nie zgadujemy złotówek.
  const foreign = remaining.find((purchase) => purchase.currency?.trim().toUpperCase() !== 'PLN');
  if (foreign) {
    throw new KsefPurchaseCurrencyError(
      purchaseNumber(foreign) ?? foreign.id,
      foreign.currency?.trim().toUpperCase() ?? '',
    );
  }

  const vatExempt = isSubjectiveVatExemption(await readTenantVatExemption(supabase, tenantId));
  return [...expenses, ...remaining.map((purchase) => purchaseCost(purchase, vatExempt))]
    .sort((a, b) => a.issueDate.localeCompare(b.issueDate) || a.id.localeCompare(b.id));
}
