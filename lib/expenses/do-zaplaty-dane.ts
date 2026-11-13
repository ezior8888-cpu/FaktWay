/**
 * Odczyt listy „Do zapłaty” (krok 3.4, część 1) kluczem sesji (RLS).
 * Kolumny z 00177 dojdą do `types/database.ts` po wgraniu migracji (typy
 * z produkcji, AGENTS.md), do tego czasu klient bez typów i własny kształt
 * wiersza (`WierszKosztuDoZaplaty`).
 *
 * Koszty z faktury z innego środowiska KSeF (np. TEST na produkcji) nie są
 * prawdziwymi zobowiązaniami, więc ich tu nie ma, jak w `filterExpensesForKsefEnvironment`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import type { KsefEnvironment } from '@/types/ksef';

import type { WierszKosztuDoZaplaty } from './do-zaplaty';
import type { WierszKosztuDoPliku } from './plik-przelewow';

export const LIMIT_DO_ZAPLATY = 500;

// `issue_date` kosztu i faktury (P_1): od dnia wystawienia zależy skutek rachunku spoza wykazu w PIT (`biala-lista-pit.ts`).
const KOLUMNY =
  'id, seller_name, seller_nip, document_number, gross_amount, vat_amount, payment_due_date, payment_account, ' +
  'payment_split, payment_terms, paid_at, issue_date, ' +
  'faktura:invoices!expenses_ksef_invoice_id_fkey(ksef_number, internal_number, currency, ksef_environment, issue_date)';

type Wiersz = WierszKosztuDoZaplaty & { faktura: (WierszKosztuDoZaplaty['faktura'] & { ksef_environment: string | null }) | null };

export async function wczytajKosztyDoZaplaty(
  supabase: unknown,
  tenantId: string,
  srodowisko: KsefEnvironment,
): Promise<{ wiersze: WierszKosztuDoZaplaty[]; obcieta: boolean } | { blad: string }> {
  const { data, error } = await (supabase as SupabaseClient)
    .from('expenses')
    .select(KOLUMNY)
    .eq('tenant_id', tenantId)
    .is('paid_at', null)
    .not('payment_due_date', 'is', null)
    .order('payment_due_date', { ascending: true })
    .limit(LIMIT_DO_ZAPLATY);
  if (error) return { blad: error.message };
  const wiersze = ((data ?? []) as unknown as Wiersz[]).filter(
    (w) => !w.faktura || w.faktura.ksef_environment === srodowisko,
  );
  return { wiersze, obcieta: (data ?? []).length >= LIMIT_DO_ZAPLATY };
}

/**
 * Koszty z listy „Do zapłaty” na rachunki z wyciągu (krok 3.2, część 3): te
 * same kolumny i warunki co lista, tylko z `payment_account` z podanych
 * wariantów (z „PL” i bez). Odczyt w całości albo błąd (`readCompletePages`):
 * niepełna lista dałaby fałszywe „brak propozycji” albo złą propozycję przy
 * kilku kosztach na tę samą kwotę. Koszty z innego środowiska KSeF odpadają.
 */
export async function wczytajKosztyNaRachunki(
  supabase: unknown,
  tenantId: string,
  srodowisko: KsefEnvironment,
  rachunki: readonly string[],
): Promise<WierszKosztuDoZaplaty[]> {
  if (rachunki.length === 0) return [];
  const client = supabase as SupabaseClient;
  const wiersze = await readCompletePages<Wiersz>('Koszty do zapłaty na rachunki z wyciągu', async (from, to) => {
    const wynik = await client
      .from('expenses')
      .select(KOLUMNY, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .is('paid_at', null)
      .not('payment_due_date', 'is', null)
      .in('payment_account', [...rachunki])
      .order('id', { ascending: true })
      .range(from, to);
    return { data: wynik.data as unknown as Wiersz[] | null, count: wynik.count, error: wynik.error };
  });
  return wiersze.filter((w) => !w.faktura || w.faktura.ksef_environment === srodowisko);
}

/**
 * Zaznaczone koszty do pliku przelewów (krok 3.4, część 2): te same kolumny
 * co lista i adres sprzedawcy, także koszty już zapłacone (plik mówi wtedy,
 * dlaczego ich pominął). Koszty z innego środowiska KSeF odpadają jak na liście.
 */
export async function wczytajKosztyDoPliku(
  supabase: unknown,
  tenantId: string,
  srodowisko: KsefEnvironment,
  ids: readonly string[],
): Promise<{ wiersze: WierszKosztuDoPliku[] } | { blad: string }> {
  const { data, error } = await (supabase as SupabaseClient)
    .from('expenses')
    .select(`${KOLUMNY}, seller_address`)
    .eq('tenant_id', tenantId)
    .in('id', [...ids]);
  if (error) return { blad: error.message };
  const wiersze = ((data ?? []) as unknown as Array<Wiersz & { seller_address: string | null }>).filter(
    (w) => !w.faktura || w.faktura.ksef_environment === srodowisko,
  );
  return { wiersze };
}
