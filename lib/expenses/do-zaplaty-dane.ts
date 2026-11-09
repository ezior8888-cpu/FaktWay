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

import type { KsefEnvironment } from '@/types/ksef';

import type { WierszKosztuDoZaplaty } from './do-zaplaty';

export const LIMIT_DO_ZAPLATY = 500;

const KOLUMNY =
  'id, seller_name, seller_nip, document_number, gross_amount, vat_amount, payment_due_date, payment_account, ' +
  'payment_split, payment_terms, paid_at, ' +
  'faktura:invoices!expenses_ksef_invoice_id_fkey(ksef_number, internal_number, currency, ksef_environment)';

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
