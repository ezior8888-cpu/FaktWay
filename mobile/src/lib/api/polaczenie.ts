/**
 * Klient API i odczytów z bazy na sesji telefonu (`lib/supabase.ts`).
 * Logika ponowień leży w `rdzen.ts`; tu tylko skąd token i jak odświeżyć.
 * Adres serwera strony z `EXPO_PUBLIC_API_URL` (`mobile/.env.local`, poza
 * gitem; lokalnie `http://localhost:3000`, symulator widzi Maca pod localhost).
 */
import { isAuthRetryableFetchError } from '@supabase/supabase-js';

import { przedCzasem, utworzKlienta, zBazy, type OdpowiedzBazy, type Odswiezenie, type Token, type Wynik } from '@/lib/api/rdzen';
import { supabase } from '@/lib/supabase';

export const ADRES_API = process.env.EXPO_PUBLIC_API_URL?.trim() || undefined;

/** Dłużej niż tyle telefon nie czeka na odświeżenie tokenu przed pobraniem danych. */
const LIMIT_TOKENU_MS = 6000;

async function token(): Promise<Token> {
  if (!supabase) return { brak: 'sesja' };
  // `getSession` odświeża wygasły token sam; bez sieci zwraca błąd do ponowienia i zostawia sesję w pęku kluczy.
  const wynik = await przedCzasem(supabase.auth.getSession(), LIMIT_TOKENU_MS);
  if (wynik === 'czas') return { brak: 'polaczenie' };
  const { data, error } = wynik;
  if (data.session) return { token: data.session.access_token };
  return { brak: error && isAuthRetryableFetchError(error) ? 'polaczenie' : 'sesja' };
}

async function odswiez(): Promise<Odswiezenie> {
  if (!supabase) return 'koniec';
  const { data, error } = await supabase.auth.refreshSession();
  if (data.session) return 'ok';
  return error && isAuthRetryableFetchError(error) ? 'polaczenie' : 'koniec';
}

const zaleznosci = {
  adres: ADRES_API,
  token,
  odswiez,
  pobierz: (adres: string, opcje: { method: string; headers: Record<string, string>; body?: string }) => fetch(adres, opcje),
};

/** `GET`/`POST` na `/api/mobile/v1/<sciezka>`. */
export const zapytajApi = utworzKlienta(zaleznosci);

/** Odczyt z bazy tokenem telefonu; `zapytanie` dostaje token do nagłówka `Authorization`. */
export function czytajZBazy<T>(zapytanie: (token: string) => PromiseLike<OdpowiedzBazy<T>>): Promise<Wynik<T>> {
  return zBazy(zaleznosci, zapytanie);
}
