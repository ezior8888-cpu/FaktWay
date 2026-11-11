/**
 * Odczyt KPiR za rok (plan księgowości JDG, K7). Liczy `zbudujKpir`
 * z `kpir.ts`; tu są tylko zapytania, klientem z sesji (RLS):
 * - faktury sprzedaży jak ewidencja przychodów (`czytajFakturyRoku`, K3);
 * - koszty jak KPiR w aplikacji (`lib/reports/kpir-data.ts`): uznane za
 *   koszt (`is_deductible`), pełne strony, filtr środowiska KSeF, a koszt
 *   z KSeF w walucie obcej bez przeglądu zatrzymuje księgę (C-11);
 * - wpisy ręczne z kolumną KPiR (00171) i wersje profilu (chyba że poda je
 *   wołający, który już je przeczytał);
 * - zapłacone składki społeczne z `tax_settlements` (K7.3, D21): Fundusz Pracy
 *   i FS jako koszt w dniu zapłaty;
 * - spisy z natury roku (K7.4, D19) dla pliku JPK_PKPIR i widoku.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { kpirCostAmount } from '@/lib/categorization/kpir-cost';
import { attachKsefNumbers, type ExportExpense } from '@/lib/exports/data-fetcher';
import { assertKsefExpensesReadyForPln, KsefExpenseCurrencyNotSupportedError } from '@/lib/expenses/ksef-currency-review';
import { filterExpensesForKsefEnvironment } from '@/lib/expenses/ksef-environment';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { czytajFakturyRoku, KOMUNIKAT_ODCZYT, KOMUNIKAT_SRODOWISKO, type OpcjeOdczytu } from '@/lib/ksiegowosc/ewidencja-dane';
import { zaplatyFunduszuPracy, zbudujKpir, type KosztKpir, type Kpir, type WpisKpir, type ZaplaconeSkladki } from '@/lib/ksiegowosc/kpir';
import { czytajWersjeProfilu, type WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { czytajSpisy, type Spis } from '@/lib/ksiegowosc/spis-z-natury';
import { czytajWpisyKpir, type RodzajWpisu } from '@/lib/ksiegowosc/wpisy-reczne';
import type { createAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/types/database';

export type WynikKpir =
  | { ok: true; kpir: Kpir; wpisy: (WpisKpir & { rodzaj: RodzajWpisu })[]; wersje: WersjaProfilu[]; spisy: Spis[] }
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

/**
 * Klucz dokumentu kosztu: NIP sprzedawcy (10 cyfr, bez kresek) i numer bez
 * spacji, wielkimi literami. Numer faktury jest jednoznaczny u wystawcy
 * (art. 106e ust. 1 pkt 2 ustawy o VAT). Bez NIP-u albo numeru: brak klucza.
 */
function kluczDokumentu(w: { seller_nip: string | null; document_number: string | null }): string | null {
  const nip = (w.seller_nip ?? '').replace(/\D/g, '');
  const numer = (w.document_number ?? '').replace(/\s+/g, '').toUpperCase();
  return nip.length === 10 && numer ? `${nip}|${numer}` : null;
}

interface DubelKosztu {
  numer: string;
  sprzedawca: string;
  ile: number;
}

/** Pierwszy dokument, który jest wśród kosztów więcej niż raz (F11-C1), np. zdjęcie i ta sama faktura ze Skrzynki. */
function zdublowanyDokument(wiersze: readonly WierszKosztu[]): DubelKosztu | null {
  const grupy = new Map<string, WierszKosztu[]>();
  for (const w of wiersze) {
    const klucz = kluczDokumentu(w);
    if (klucz) grupy.set(klucz, [...(grupy.get(klucz) ?? []), w]);
  }
  for (const grupa of grupy.values()) {
    if (grupa.length > 1) {
      return { numer: (grupa[0].document_number ?? '').trim(), sprzedawca: grupa[0].seller_name?.trim() || 'sprzedawcy bez nazwy', ile: grupa.length };
    }
  }
  return null;
}

/** Brak KPiR przy zdublowanym dokumencie kosztu: numer, sprzedawca i co zrobić. */
export function komunikatDublaKosztu(d: DubelKosztu): string {
  return (
    `Dokument ${d.numer} od ${d.sprzedawca} jest w kosztach ${d.ile} razy (np. zdjęcie i ta sama faktura ze Skrzynki KSeF), więc KPiR teraz nie liczymy, żeby nie wpisać kosztu podwójnie. ` +
    'W Kosztach zostaw w KPiR jeden koszt tego dokumentu (u pozostałych wyłącz „Uwzględnij w KPiR”). Jeśli to jeden dokument podzielony na kilka kosztów, napisz do nas.'
  );
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
  // F11-C2: wydatki na reprezentację nie są kosztem (art. 23 ust. 1 pkt 23 ustawy o PIT).
  const widoczne = (await filterExpensesForKsefEnvironment(client, tenantId, srodowisko, wiersze)).filter(
    (w) => !czyReprezentacja(w.category_label),
  );
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
  // F11-C1: KPiR ma jeden wiersz na dowód; ten sam dokument dwa razy to podwójny koszt.
  const dubel = zdublowanyDokument(widoczne);
  if (dubel) return { komunikat: komunikatDublaKosztu(dubel) };

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

interface WierszZaplaty {
  id: string;
  okres: string;
  wersja: number;
  kwota_gr: number | string;
  zaplacone_o: string;
  spoleczne_bez_fp: number | string | null;
}

/**
 * Zapłacone wersje składek społecznych firmy (wszystkie lata: dopłata za okres
 * z poprzedniego roku liczy przyrost od wcześniejszej zapłaty). Przed 00168
 * tabeli nie ma: to brak zapłat, nie awaria.
 */
async function zaplaconeSkladki(client: SupabaseClient, tenantId: string): Promise<ZaplaconeSkladki[]> {
  const wiersze = await readCompletePages<WierszZaplaty>('kpir: zapłacone składki', async (from, to) => {
    const wynik = await client
      .from('tax_settlements')
      .select('id, okres, wersja, kwota_gr, zaplacone_o, spoleczne_bez_fp:migawka->spoleczneBezFpGr', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('rodzaj', 'zus_spoleczne')
      .eq('status', 'zaplacone')
      .order('id', { ascending: true })
      .range(from, to);
    // Przed wgraniem 00168: Postgres 42P01, PostgREST PGRST205.
    if (wynik.error && (wynik.error.code === '42P01' || wynik.error.code === 'PGRST205')) return { data: [], count: 0, error: null };
    return { data: wynik.data as WierszZaplaty[] | null, count: wynik.count, error: wynik.error };
  });
  return wiersze.map((w) => ({
    id: w.id,
    okres: w.okres.slice(0, 7),
    wersja: w.wersja,
    kwotaGr: Number(w.kwota_gr),
    spoleczneBezFpGr: Number(w.spoleczne_bez_fp ?? 0),
    zaplaconeO: w.zaplacone_o,
  }));
}

export async function czytajKpir(client: SupabaseClient, tenantId: string, rok: number, opcje: OpcjeOdczytu = {}): Promise<WynikKpir> {
  // Faktury (z kursami NBP) i reszta księgi naraz; błąd faktur ma pierwszeństwo.
  const reszta = Promise.all([
    koszty(client, tenantId, rok),
    czytajWpisyKpir(client, tenantId, `${rok}-01-01`, `${rok}-12-31`),
    opcje.wersje ? [...opcje.wersje] : czytajWersjeProfilu(client, tenantId),
    zaplaconeSkladki(client, tenantId),
    czytajSpisy(client, tenantId, rok),
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
  const [k, wpisy, wersje, skladki, spisy] = odczyt.r;
  if (!Array.isArray(k)) return { ok: false, komunikat: k.komunikat };
  const zaplatyFp = zaplatyFunduszuPracy(skladki);
  return { ok: true, kpir: zbudujKpir({ rok, faktury: faktury.faktury, koszty: k, wpisy, zaplatyFp, wersje, kursy: faktury.kursy }), wpisy, wersje, spisy };
}

/**
 * Kategoria „Reprezentacja” (także nadana przez Skrzynkę albo OCR, np. dla
 * restauracji): wydatki na reprezentację, w tym usługi gastronomiczne, nie są
 * kosztem uzyskania przychodu (art. 23 ust. 1 pkt 23 ustawy o PIT), więc nie
 * wchodzą do KPiR ani JPK_PKPIR (F11-C2). Koszt zostaje w Kosztach.
 */
function czyReprezentacja(kategoria: string | null): boolean {
  return /^\s*reprezentacj/i.test(kategoria ?? '');
}

