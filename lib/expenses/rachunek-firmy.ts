/**
 * Rachunek firmy (`tenants.bank_account`, migracja 00183): z niego plik
 * przelewów z listy „Do zapłaty” zleca przelewy (krok 3.4, część 2). Zapis
 * 26 cyfr NRB z poprawną liczbą kontrolną; walidacja jedna dla formularza
 * w Ustawieniach i akcji serwerowej. Wzór: `lib/invoices/business-start.ts`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { isMissingColumnError } from '@/lib/invoices/business-start';
import { nrb } from '@/lib/expenses/elixir0';

/** Kotwica sekcji w Ustawieniach (link z listy „Do zapłaty”). */
export const KOTWICA_RACHUNKU_FIRMY = 'rachunek-firmy';

/**
 * Wpis z formularza: pusty = brak rachunku (`null`), inaczej 26 cyfr bez
 * „PL”, spacji i kresek. Rzuca `Error` z polskim komunikatem.
 */
export function normalizujRachunekFirmy(input: string | null | undefined): string | null {
  const wpis = (input ?? '').replace(/[\s-]/g, '').toUpperCase();
  if (wpis === '') return null;
  if (/^[A-Z]{2}/.test(wpis) && !wpis.startsWith('PL')) {
    throw new Error('Plik przelewów obsługuje tylko polski rachunek (NRB, 26 cyfr).');
  }
  const cyfry = wpis.replace(/^PL/, '');
  if (!/^\d{26}$/.test(cyfry)) {
    throw new Error('Podaj 26 cyfr numeru rachunku (NRB). Spacje i „PL” na początku można zostawić.');
  }
  const numer = nrb(cyfry);
  if (!numer) {
    throw new Error(
      'Ten numer rachunku nie przechodzi kontroli cyfr kontrolnych (możliwa literówka). Sprawdź go w bankowości albo w umowie rachunku.',
    );
  }
  return numer;
}

/**
 * Odczyt odporny na kolejność wdrożenia: przed 00183 brak kolumny to brak
 * rachunku. Zapisany numer, który nie przechodzi kontroli, też to brak
 * rachunku (plik nie powstanie z błędnym rachunkiem zleceniodawcy). Każdy inny
 * błąd rzuca: „nie wiem” to nie „brak rachunku”.
 */
export async function readTenantBankAccount(client: SupabaseClient, tenantId: string): Promise<string | null> {
  const { data, error } = await client.from('tenants').select('bank_account').eq('id', tenantId).maybeSingle();
  if (error) {
    if (isMissingColumnError(error.code)) return null;
    throw new Error(`Nie można odczytać rachunku firmy: ${error.message}`);
  }
  const raw = (data as { bank_account?: unknown } | null)?.bank_account;
  return typeof raw === 'string' ? nrb(raw) : null;
}

/** Zapis do czytania: „45 1050 1038 0000 0000 0000 1234”. */
export function rachunekFirmyDoCzytania(numer: string): string {
  return [numer.slice(0, 2), ...(numer.slice(2).match(/.{1,4}/g) ?? [])].join(' ');
}
