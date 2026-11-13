/**
 * Klient Supabase aplikacji (plan aplikacji 4.2, etap M5b): sesja w pęku
 * kluczy telefonu (`expo-secure-store`), nie w zwykłej pamięci aplikacji.
 *
 * Adres i klucz publiczny (`anon`) przychodzą z `EXPO_PUBLIC_SUPABASE_URL`
 * i `EXPO_PUBLIC_SUPABASE_ANON_KEY` (plik `mobile/.env.local`, poza gitem).
 * Bez nich `supabase` jest `null` i aplikacja działa na danych przykładowych
 * (logowanie z M5a), np. w buildzie na telefon Bartosza bez bazy.
 */
import { createClient, type SupportedStorage } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

/**
 * Pęk kluczy przyjmuje krótkie wartości (Expo ostrzega powyżej 2048 bajtów),
 * a sesja z tokenami jest dłuższa, więc zapisujemy ją w kawałkach. Każdy zapis
 * dostaje nowe pokolenie: najpierw kawałki `<klucz>.<pokolenie>.<i>`, potem
 * wskaźnik `<klucz>.n` = `<pokolenie>:<liczba>`, na końcu sprzątanie starych.
 * Przerwany zapis zostawia więc poprzednią, całą sesję, a nie zlepek dwóch.
 */
const KAWALEK = 1800;
const OPCJE: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

type Wskaznik = { pokolenie: string; liczba: number };

async function wczytajWskaznik(klucz: string): Promise<Wskaznik | undefined> {
  const [pokolenie, liczba] = (await SecureStore.getItemAsync(`${klucz}.n`, OPCJE))?.split(':') ?? [];
  const n = Number(liczba);
  return pokolenie && Number.isInteger(n) && n > 0 ? { pokolenie, liczba: n } : undefined;
}

function usunPokolenie(klucz: string, w: Wskaznik): Promise<void[]> {
  return Promise.all(Array.from({ length: w.liczba }, (_, i) => SecureStore.deleteItemAsync(`${klucz}.${w.pokolenie}.${i}`, OPCJE)));
}

export const magazynSesji: SupportedStorage = {
  async getItem(klucz) {
    const w = await wczytajWskaznik(klucz);
    if (!w) return null;
    const kawalki = await Promise.all(Array.from({ length: w.liczba }, (_, i) => SecureStore.getItemAsync(`${klucz}.${w.pokolenie}.${i}`, OPCJE)));
    return kawalki.every((k) => k !== null) ? kawalki.join('') : null;
  },
  async setItem(klucz, wartosc) {
    const stary = await wczytajWskaznik(klucz);
    const pokolenie = Date.now().toString(36);
    const kawalki = wartosc.match(new RegExp(`[\\s\\S]{1,${KAWALEK}}`, 'g')) ?? [''];
    await Promise.all(kawalki.map((k, i) => SecureStore.setItemAsync(`${klucz}.${pokolenie}.${i}`, k, OPCJE)));
    await SecureStore.setItemAsync(`${klucz}.n`, `${pokolenie}:${kawalki.length}`, OPCJE);
    if (stary && stary.pokolenie !== pokolenie) await usunPokolenie(klucz, stary);
  },
  async removeItem(klucz) {
    const w = await wczytajWskaznik(klucz);
    await SecureStore.deleteItemAsync(`${klucz}.n`, OPCJE);
    if (w) await usunPokolenie(klucz, w);
  },
};

const ADRES = process.env.EXPO_PUBLIC_SUPABASE_URL;
const KLUCZ_PUBLICZNY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Klucz sesji w pęku kluczy: ten sam, który `supabase-js` wybiera sam
 * (`sb-<pierwsza część hosta>-auth-token`), więc sesje sprzed M7 zostają.
 * Jawnie, bo start bez sieci czyta sesję wprost (`sesjaZPekuKluczy`).
 */
const KLUCZ_SESJI = ADRES ? `sb-${new URL(ADRES).hostname.split('.')[0]}-auth-token` : undefined;

export const supabase =
  ADRES && KLUCZ_PUBLICZNY
    ? createClient(ADRES, KLUCZ_PUBLICZNY, {
        auth: {
          storage: magazynSesji,
          storageKey: KLUCZ_SESJI,
          persistSession: true,
          // Odświeżanie tokenu włącza i wyłącza sesja przy zmianie AppState (zalecenie Supabase dla React Native).
          autoRefreshToken: false,
          detectSessionInUrl: false,
          // Google wraca kodem do wymiany (`exchangeCodeForSession`), nie tokenem w adresie.
          flowType: 'pkce',
        },
      })
    : null;

/** Sesja zapisana w pęku kluczy, bez sieci i bez odświeżania (JSON zapisany przez `supabase-js`). */
export function sesjaZPekuKluczy(): Promise<string | null> {
  return KLUCZ_SESJI ? magazynSesji.getItem(KLUCZ_SESJI) as Promise<string | null> : Promise.resolve(null);
}

/** Drobne ustawienia tego telefonu (blokada, zapamiętany e-mail) w pęku kluczy. */
export const ustawienia = {
  wczytaj: (klucz: string) => SecureStore.getItemAsync(`faktway.${klucz}`, OPCJE),
  zapisz: (klucz: string, wartosc: string) => SecureStore.setItemAsync(`faktway.${klucz}`, wartosc, OPCJE),
  usun: (klucz: string) => SecureStore.deleteItemAsync(`faktway.${klucz}`, OPCJE),
};
