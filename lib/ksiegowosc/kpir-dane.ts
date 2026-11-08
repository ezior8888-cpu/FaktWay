/**
 * Odczyt KPiR za rok (plan księgowości JDG, K7). Liczy `zbudujKpir`
 * z `kpir.ts`; tu są tylko zapytania, klientem z sesji (RLS):
 * - faktury sprzedaży jak ewidencja przychodów (`czytajFakturyRoku`, K3);
 * - koszty jak KPiR w aplikacji (`lib/reports/kpir-data.ts`): uznane za
 *   koszt (`is_deductible`), pełne strony, filtr środowiska KSeF, a koszt
 *   z KSeF w walucie obcej bez przeglądu zatrzymuje księgę (C-11);
 * - wpisy ręczne z kolumną KPiR (00171) i wersje profilu (chyba że poda je
 *   wołający, który już je przeczytał).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { kpirCostAmount } from '@/lib/categorization/kpir-cost';
import { attachKsefNumbers, type ExportExpense } from '@/lib/exports/data-fetcher';
import { assertKsefExpensesReadyForPln, KsefExpenseCurrencyNotSupportedError } from '@/lib/expenses/ksef-currency-review';
import { filterExpensesForKsefEnvironment } from '@/lib/expenses/ksef-environment';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { czytajFakturyRoku, KOMUNIKAT_ODCZYT, KOMUNIKAT_SRODOWISKO, type OpcjeOdczytu } from '@/lib/ksiegowosc/ewidencja-dane';
import { zbudujKpir, type KosztKpir, type Kpir, type WpisKpir } from '@/lib/ksiegowosc/kpir';
import { czytajWersjeProfilu, type WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { czytajWpisyKpir, type RodzajWpisu } from '@/lib/ksiegowosc/wpisy-reczne';
import type { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/types/database';

export type WynikKpir =
  | { ok: true; kpir: Kpir; wpisy: (WpisKpir & { rodzaj: RodzajWpisu })[]; wersje: WersjaProfilu[] }
  | { ok: false; komunikat: string };

const KOLUMNY_KOSZTU =
  'id, source, ksef_invoice_id, issue_date, document_number, document_type, seller_name, seller_nip, seller_address, ' +
  'net_amount, vat_amount, gross_amount, vat_deductible_amount, kpir_column, category_label, is_reviewed, ocr_extracted_data';

interface WierszKosztu {
  id: string;
  source: string;
  ksef_invoice_id: string | null;
  issue_date: string;
  document_number: string | null;
  document_type: string;
  seller_name: string;
  seller_nip: string | null;
  seller_address: string | null;
  net_amount: number | string | null;
  vat_amount: number | string | null;
  gross_amount: number | string | null;
  vat_deductible_amount: number | string | null;
  kpir_column: string | null;
  category_label: string | null;
  is_reviewed: boolean;
  ocr_extracted_data: Json;
}

const doGroszy = (zl: number) => Math.round(zl * 100);

/** Identyfikator sprzedawcy jak K_4A/K_4B: NIP z 10 cyfr, inaczej brak. */
function identyfikator(nip: string | null): { kraj: string | null; identyfikator: string | null } {
  const cyfry = (nip ?? '').replace(/\D/g, '');
  return cyfry.length === 10 ? { kraj: 'PL', identyfikator: cyfry } : { kraj: null, identyfikator: null };
}

export const KOMUNIKAT_WALUTA_KOSZTU =
  'Część kosztów z KSeF jest w walucie obcej i czeka na przegląd kursu, więc KPiR teraz nie liczymy. Przegląd jest w Kosztach.';

/** Koszty roku z KSeF i spoza KSeF, z numerem KSeF powiązanej faktury. */
async function koszty(client: SupabaseClient, tenantId: string, rok: number): Promise<KosztKpir[] | { komunikat: string }> {
  const srodowisko = requireConfiguredKsefEnvironment();
  const wiersze = await readCompletePages<WierszKosztu>('kpir: koszty', async (from, to) => {
    const wynik = await client
      .from('expenses')
      .select(KOLUMNY_KOSZTU, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('is_deductible', true)
      .gte('issue_date', `${rok}-01-01`)
      .lte('issue_date', `${rok}-12-31`)
      .order('id', { ascending: true })
      .range(from, to);
    return { data: wynik.data as WierszKosztu[] | null, count: wynik.count, error: wynik.error };
  });
  const widoczne = await filterExpensesForKsefEnvironment(client, tenantId, srodowisko, wiersze);
  try {
    await assertKsefExpensesReadyForPln(widoczne, async (ids) => {
      const { data, error } = await client.from('invoices').select('id, currency').eq('tenant_id', tenantId).in('id', ids);
      if (error) throw new Error('Nie można sprawdzić walut faktur KSeF');
      return new Map(((data ?? []) as { id: string; currency: string | null }[]).map((r) => [r.id, r.currency]));
    });
  } catch (e) {
    // Do Kosztów odsyła tylko koszt w walucie bez przeglądu; błąd zapytania to błąd odczytu (`czytajKpir`).
    if (e instanceof KsefExpenseCurrencyNotSupportedError) return { komunikat: KOMUNIKAT_WALUTA_KOSZTU };
    throw e;
  }

  // Numer KSeF faktury, z której powstał koszt (K_3B), tą samą drogą co eksport.
  const zNumerem: ExportExpense[] = widoczne.map((w) => ({
    id: w.id,
    issueDate: w.issue_date,
    documentNumber: w.document_number ?? '',
    documentType: w.document_type,
    sellerName: w.seller_name,
    sellerNip: w.seller_nip,
    sellerAddress: w.seller_address,
    netAmount: Number(w.net_amount ?? 0),
    vatAmount: Number(w.vat_amount ?? 0),
    grossAmount: Number(w.gross_amount ?? 0),
    vatDeductibleAmount: Number(w.vat_deductible_amount ?? 0),
    kpirColumn: w.kpir_column,
    categoryLabel: w.category_label,
  }));
  await attachKsefNumbers(
    client as unknown as ReturnType<typeof createAdminClient>,
    tenantId,
    zNumerem,
    new Map(widoczne.filter((w) => w.ksef_invoice_id).map((w) => [w.id, w.ksef_invoice_id as string])),
  );

  return widoczne.map((w, i) => ({
    id: w.id,
    data: w.issue_date,
    dowod: (w.document_number ?? '').trim(),
    numerKsef: zNumerem[i].ksefNumber ?? null,
    kontrahent: { nazwa: w.seller_name, adres: w.seller_address, ...identyfikator(w.seller_nip) },
    opis: w.category_label?.trim() || 'Zakup',
    kolumnaAplikacji: w.kpir_column,
    kwotaGr: doGroszy(kpirCostAmount(w)),
  }));
}

export async function czytajKpir(client: SupabaseClient, tenantId: string, rok: number, opcje: OpcjeOdczytu = {}): Promise<WynikKpir> {
  // Faktury (z kursami NBP) i reszta księgi naraz; błąd faktur ma pierwszeństwo.
  const reszta = Promise.all([
    koszty(client, tenantId, rok),
    czytajWpisyKpir(client, tenantId, `${rok}-01-01`, `${rok}-12-31`),
    opcje.wersje ? [...opcje.wersje] : czytajWersjeProfilu(client, tenantId),
  ]).then(
    (r) => ({ ok: true as const, r }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  const faktury = await czytajFakturyRoku(client, tenantId, rok, opcje);
  const odczyt = await reszta;
  if (!faktury.ok) return faktury;
  if (!odczyt.ok) {
    const e = odczyt.e;
    console.error('[kpir] odczyt', e instanceof Error ? e.message : e);
    return { ok: false, komunikat: e instanceof Error && e.message.includes('environment') ? KOMUNIKAT_SRODOWISKO : KOMUNIKAT_ODCZYT };
  }
  const [k, wpisy, wersje] = odczyt.r;
  if (!Array.isArray(k)) return { ok: false, komunikat: k.komunikat };
  return { ok: true, kpir: zbudujKpir({ rok, faktury: faktury.faktury, koszty: k, wpisy, wersje, kursy: faktury.kursy }), wpisy, wersje };
}
