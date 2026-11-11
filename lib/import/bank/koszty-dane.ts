/**
 * Odczyty serwerowe dla przelewów do dostawców z wyciągu (plan kompletnej
 * aplikacji, krok 3.2, część 3): koszty z listy „Do zapłaty” na rachunki
 * z pliku, zapisane identyfikatory zbiorcze, operacje rozstrzygnięte wcześniej
 * i ostatnie decyzje na ekran „Bank”. Klient z sesji (RLS); `payment_imports`
 * czytamy tylko przez RPC z 00196, bo tabela jest zamknięta dla sesji (00074).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { listaDoZaplaty } from '@/lib/expenses/do-zaplaty';
import { wczytajKosztyNaRachunki } from '@/lib/expenses/do-zaplaty-dane';
import { wczytajZapisaneIdentyfikatory } from '@/lib/expenses/identyfikator-zbiorczy-dane';
import type { ZapisanyIdentyfikator } from '@/lib/expenses/identyfikator-zbiorczy';
import { nipZIdentyfikatora } from '@/lib/invoices/identyfikator-zbiorczy';
import type { KsefEnvironment } from '@/types/ksef';

import {
  EXPENSE_LOAD_FAILED,
  identyfikatoryZbiorczeWTekscie,
  kosztDoPrzelewu,
  parseBankExpenseOperationsRpc,
  parseKnownBankOperationsRpc,
  wariantyRachunku,
  type KosztDoPrzelewu,
  type ZaplatyKosztowEkranu,
} from './koszty';

type RpcResult = PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
/** Funkcje z 00196; do czasu typów z produkcji (`types/database.ts`) przez ten kształt. */
interface ExpenseReadRpc {
  rpc(fn: 'bank_known_operations', args: { p_keys: string[] }): RpcResult;
  rpc(fn: 'bank_expense_operations'): RpcResult;
}

/**
 * Koszty z listy „Do zapłaty” na rachunki odbiorców z wyciągu, w kolejności listy
 * (`listaDoZaplaty`: termin, potem większa kwota). Błąd odczytu rzuca: „nie wiem”
 * to nie „brak kosztu”.
 */
export async function czytajKosztyNaRachunki(
  client: SupabaseClient,
  tenantId: string,
  srodowisko: KsefEnvironment,
  rachunki: readonly (string | null)[],
  dzis: string,
): Promise<KosztDoPrzelewu[]> {
  const warianty = wariantyRachunku(rachunki);
  if (warianty.length === 0) return [];
  const wiersze = await wczytajKosztyNaRachunki(client, tenantId, srodowisko, warianty);
  return listaDoZaplaty(wiersze, dzis)
    .pozycje.map(kosztDoPrzelewu)
    .filter((k): k is KosztDoPrzelewu => k !== null);
}

/**
 * Zapisane identyfikatory zbiorcze dla identyfikatorów z tytułów przelewów (NIP
 * sprzedawcy to pierwsze 10 cyfr identyfikatora). Brak identyfikatorów w tytułach
 * to brak zapytania; błąd odczytu to pusta lista (bez jednego kliknięcia przy
 * identyfikatorze, wybór klienta działa).
 */
export async function czytajZapisaneDlaTytulow(
  client: SupabaseClient,
  tenantId: string,
  srodowisko: KsefEnvironment,
  tytuly: readonly (string | null)[],
): Promise<ZapisanyIdentyfikator[]> {
  const nipy = [...new Set(tytuly.flatMap((t) => identyfikatoryZbiorczeWTekscie(t)).map(nipZIdentyfikatora))];
  if (nipy.length === 0) return [];
  return wczytajZapisaneIdentyfikatory(client, tenantId, srodowisko, nipy);
}

/** Klucze operacji, które firma już ma (potwierdzone albo pominięte). Błąd odczytu rzuca. */
export async function czytajZnaneOperacje(client: SupabaseClient, keys: readonly string[]): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const { data, error } = await (client as unknown as ExpenseReadRpc).rpc('bank_known_operations', { p_keys: [...keys] });
  if (error) throw new Error(`bank_known_operations: ${error.code ?? 'błąd'}`);
  const known = parseKnownBankOperationsRpc(data);
  if (!known) throw new Error('bank_known_operations: zły kształt wyniku');
  return known;
}

/** Ostatnie decyzje o przelewach do dostawców na ekran „Bank”; błąd to komunikat zamiast pustej listy. */
export async function czytajZaplatyKosztow(client: SupabaseClient): Promise<ZaplatyKosztowEkranu> {
  const { data, error } = await (client as unknown as ExpenseReadRpc).rpc('bank_expense_operations');
  if (error) console.error('[bank] bank_expense_operations', error.code);
  const parsed = error ? null : parseBankExpenseOperationsRpc(data);
  return parsed ? { ok: true, ...parsed } : { ok: false, error: EXPENSE_LOAD_FAILED };
}
