/**
 * Wyłącznik modułu księgowości (plan księgowości JDG, krok K1, D10 i D11).
 *
 * TRZY WARSTWY, OD NAJMOCNIEJSZEJ. Każda następna może tylko ZABRAĆ:
 *
 * 1. GLOBALNY STOP: `killKsiegowosc` w `global_feature_flags` (migracja
 *    00165 zakłada wiersz z `false`). Odczyt przez cache 60 s, bez wdrożenia,
 *    tak jak `killFloAgent` w runbooku FLO.
 * 2. BLOKADA W KODZIE: `BLOKADY` niżej. Obszar niezbudowany albo czekający
 *    na prawnika jest wyłączony bez względu na bazę. Włączenie wymaga
 *    commita z uzasadnieniem i przeglądu.
 * 3. FIRMA: `tenant_feature_flags.ksiegowosc_enabled` (00165, domyślnie
 *    `false`). W przeciwieństwie do FLO to WŁĄCZENIE, nie wyłączenie: moduł
 *    widzi tylko firma dopisana do pilotażu (D11, warunek B6). Zapis ma
 *    wyłącznie klucz serwisowy; klient czyta swój wiersz (RLS z 00031).
 *
 * Warstwa 3 NIE ODWRACA warstwy 2: `ksiegowosc_enabled = true` dla obszaru
 * zablokowanego w kodzie jest ignorowane.
 *
 * Ścieżka operatora do czasu przycisku w `/admin/flags` (pilotaż, krok K8):
 * UPDATE na `global_feature_flags` i `tenant_feature_flags` kluczem
 * serwisowym. Od K2 kod puszcza obszar `ustawienia`, od K3 `ewidencja`, od K4
 * `ten_miesiac`, od K5 `terminy`, od K6 `vat`, więc o nich decyduje flaga
 * firmy; pozostałe obszary są zablokowane w kodzie.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { getGlobalFlag } from '@/lib/feature-flags/global-flags';
import { isMissingColumnError } from '@/lib/invoices/business-start';

export type ObszarModulu =
  | 'ustawienia'
  | 'ewidencja'
  | 'ten_miesiac'
  | 'terminy'
  | 'vat'
  | 'wysylka_jpk'
  | 'kpir';

export type PowodBlokady =
  /** Obszar jeszcze nie zbudowany. */
  | 'nie_zbudowane'
  /** Czeka na pisemną opinię prawnika (sekcja 11 planu). */
  | 'prawnik';

export interface StatusObszaru {
  wlaczony: boolean;
  powod?: PowodBlokady;
  /** Zdanie dla człowieka, który zajrzy tu za pół roku. */
  notatka?: string;
}

const BLOKADY: Readonly<Record<ObszarModulu, StatusObszaru>> = {
  // K2: kreator zbudowany, więc kod go puszcza; widzi go tylko firma
  // z `ksiegowosc_enabled = true` (pilotaż), reszta dostaje 404.
  ustawienia: { wlaczony: true, notatka: 'Kreator ustawień podatkowych (K2).' },
  ewidencja: { wlaczony: true, notatka: 'Ewidencja przychodów ryczałtu, wpisy ręczne i JPK_EWP (K3).' },
  ten_miesiac: { wlaczony: true, notatka: 'Ryczałt, składki i zdrowotna za miesiąc z zatwierdzaniem (K4).' },
  terminy: { wlaczony: true, notatka: 'Przypomnienia o terminach, push o wyliczonym miesiącu i karta „Odłóż na podatek” (K5).' },
  vat: { wlaczony: true, notatka: 'VAT za miesiąc, plik JPK_V7M(3) do pobrania, lista wysyłek z UPO (K6).' },
  wysylka_jpk: {
    wlaczony: false,
    powod: 'prawnik',
    notatka: 'Wysyłka JPK_V7M danymi autoryzującymi (D9): po próbie na środowisku testowym MF i opinii prawnika.',
  },
  kpir: { wlaczony: false, powod: 'nie_zbudowane', notatka: 'KPiR, skala i liniowy: krok K7.' },
};

export function statusObszaru(obszar: ObszarModulu): StatusObszaru {
  return BLOKADY[obszar];
}

export type Warstwa = 'globalny_stop' | 'blokada_w_kodzie' | 'firma';

export interface Werdykt {
  wlaczony: boolean;
  /** Która warstwa zdecydowała. */
  rozstrzygnela: Warstwa;
  /** Dla operatora: dlaczego tak. */
  notatka: string;
}

/** Rozstrzygnięcie warstw, funkcja czysta (testy każdej kombinacji bez bazy). */
export function rozstrzygnij(wejscie: {
  globalnyStop: boolean;
  kod: StatusObszaru;
  firmaWlaczona: boolean;
}): Werdykt {
  if (wejscie.globalnyStop) {
    return { wlaczony: false, rozstrzygnela: 'globalny_stop', notatka: 'Moduł zatrzymany globalnie (killKsiegowosc).' };
  }
  if (!wejscie.kod.wlaczony) {
    return { wlaczony: false, rozstrzygnela: 'blokada_w_kodzie', notatka: wejscie.kod.notatka ?? 'Obszar zablokowany w kodzie.' };
  }
  if (!wejscie.firmaWlaczona) {
    return {
      wlaczony: false,
      rozstrzygnela: 'firma',
      notatka: 'Firma poza pilotażem (tenant_feature_flags.ksiegowosc_enabled = false).',
    };
  }
  return { wlaczony: true, rozstrzygnela: 'firma', notatka: 'Firma w pilotażu.' };
}

/**
 * Czy firma jest w pilotażu. Przed wgraniem 00165 kolumny nie ma: to znaczy
 * „nie”, a nie awaria. Każdy inny błąd rzuca, bo „nie wiem” to nie „nie”.
 */
export async function czytajFlageFirmy(client: SupabaseClient, tenantId: string): Promise<boolean> {
  const { data, error } = await client
    .from('tenant_feature_flags')
    .select('ksiegowosc_enabled')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) {
    if (isMissingColumnError(error.code)) return false;
    throw new Error(`Nie można odczytać wyłącznika księgowości: ${error.message}`);
  }
  return (data as { ksiegowosc_enabled?: unknown } | null)?.ksiegowosc_enabled === true;
}

/**
 * Czy obszar modułu działa dla firmy. Klient z sesji (RLS) na stronach,
 * klucz serwisowy w zadaniach. Kod blokuje, zanim padnie jakiekolwiek
 * zapytanie.
 */
export async function czyKsiegowoscWlaczona(
  client: SupabaseClient,
  tenantId: string,
  obszar: ObszarModulu,
  /** Wstrzykiwany tylko w testach; produkcyjnie zawsze prawdziwy odczyt flagi. */
  czytajGlobalnyStop: () => Promise<boolean> = () => getGlobalFlag('killKsiegowosc'),
): Promise<Werdykt> {
  const kod = statusObszaru(obszar);
  if (!kod.wlaczony) return rozstrzygnij({ globalnyStop: false, kod, firmaWlaczona: false });
  if (await czytajGlobalnyStop()) return rozstrzygnij({ globalnyStop: true, kod, firmaWlaczona: false });
  return rozstrzygnij({ globalnyStop: false, kod, firmaWlaczona: await czytajFlageFirmy(client, tenantId) });
}
