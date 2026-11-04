/**
 * Klient Supabase z typami bazy dla faktur cyklicznych (migracja 00154).
 *
 * Od 20.10.2026 `types/database.ts` (wygenerowany z produkcji po wgraniu
 * 00154) zna tabelę `recurring_invoices` i kolumny `invoices.recurring_*`,
 * więc rozszerzenie typów i rzutowanie przez `unknown` zniknęły. Zostaje
 * jedno miejsce, które klienta nieotypowanego (`lib/supabase/server.ts`
 * daje dziś wiersze `any`, testy podają atrapę) traktuje jak otypowanego
 * `Database` — żeby literówka w nazwie kolumny była błędem kompilacji, nie
 * pustym wynikiem na produkcji. To ten sam obiekt klienta (sesja z RLS albo
 * klucz serwisowy — taki, jaki przyszedł).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/types/database';
import { RECURRING_FREQUENCIES, type RecurringFrequency, type RecurringInvoiceRow } from '@/types/recurring-invoice';

/** Kolumny dodane do `invoices` w 00154. */
export type InvoiceRecurringColumns = Pick<
  Database['public']['Tables']['invoices']['Row'],
  'recurring_invoice_id' | 'recurring_period'
>;

export type RecurringClient = SupabaseClient<Database>;

/** Ten sam klient, otypowany `Database` (sesja, `createClient`, klucz serwisowy, atrapa w testach). */
export function recurringDb(supabase: SupabaseClient<Database> | SupabaseClient): RecurringClient {
  return supabase as RecurringClient;
}

/** Wiersz `recurring_invoices` tak, jak go zwraca baza (`frequency` jako tekst). */
export type RecurringInvoiceDbRow = Database['public']['Tables']['recurring_invoices']['Row'];

function isRecurringFrequency(value: string): value is RecurringFrequency {
  return (RECURRING_FREQUENCIES as readonly string[]).includes(value);
}

/**
 * Wiersz z bazy → typ domenowy. `frequency` zawęża CHECK z 00154
 * (`monthly` / `quarterly` / `yearly`), więc inna wartość to błąd schematu,
 * nie danych klienta — rzucamy, zamiast liczyć harmonogram z nieznanej
 * częstotliwości.
 */
export function toRecurringRow(raw: RecurringInvoiceDbRow): RecurringInvoiceRow {
  if (!isRecurringFrequency(raw.frequency)) {
    throw new Error(`Nieznana częstotliwość faktury cyklicznej: ${raw.frequency}`);
  }
  return {
    id: raw.id,
    tenant_id: raw.tenant_id,
    template_invoice_id: raw.template_invoice_id,
    name: raw.name,
    frequency: raw.frequency,
    day_of_month: Number(raw.day_of_month),
    next_run_date: raw.next_run_date,
    active: raw.active,
    created_by: raw.created_by,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}
