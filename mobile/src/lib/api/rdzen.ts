/**
 * Rdzeń klienta API i odczytów z bazy (plan aplikacji 4.3, etap M7), bez
 * React Native i bez Supabase: token, odświeżenie i `fetch` przychodzą z
 * zewnątrz (`lib/api/polaczenie.ts`), więc testy (`tests/unit/mobile-api-klient.test.ts`)
 * sprawdzają tę samą ścieżkę co telefon.
 *
 * Każde żądanie niesie `Authorization: Bearer <token sesji>`, a trasy z danymi
 * firmy `X-Active-Org`. Po 401 telefon odświeża sesję i ponawia raz
 * (token dostępu wygasa co godzinę); koniec sesji dopiero, gdy odświeżenie
 * nie przejdzie. Brak internetu nigdy nie kończy sesji.
 */
import { bladApi, bladTelefonu, type BladApi } from './bledy';
import { MOBILE_ACTIVE_ORG_HEADER } from './kontrakt';

/** Token dostępu z sesji telefonu albo powód, dla którego go nie ma. */
export type Token = { token: string } | { brak: 'sesja' | 'polaczenie' };

/** Wynik odświeżenia sesji: nowy token, brak sieci albo sesja nie do uratowania. */
export type Odswiezenie = 'ok' | 'polaczenie' | 'koniec';

export type Zaleznosci = {
  /** `EXPO_PUBLIC_API_URL`, np. `http://localhost:3000`; bez niego API jest niedostępne. */
  adres: string | undefined;
  token: () => Promise<Token>;
  odswiez: () => Promise<Odswiezenie>;
  pobierz: (adres: string, opcje: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
    ok: boolean;
    status: number;
    headers: { get: (nazwa: string) => string | null };
    json: () => Promise<unknown>;
  }>;
};

export type Wynik<T> = { ok: true; dane: T; status: number } | { ok: false; blad: BladApi };

export type OpcjeZapytania = { metoda?: 'GET' | 'POST'; firma?: string | null; cialo?: unknown };

export const BRAK_ADRESU_API = 'Aplikacja nie ma adresu serwera FaktWay (EXPO_PUBLIC_API_URL).';

/**
 * Wynik obietnicy albo `'czas'`, gdy nie zdąży. Bez sieci `supabase-js`
 * ponawia odświeżenie tokenu z odstępami przez 30 s (`getSession`), a ani
 * ekran startowy, ani nota „Bez internetu” nie mogą tyle czekać. Sama
 * obietnica biegnie dalej: udane odświeżenie da znać zdarzeniem `TOKEN_REFRESHED`.
 */
export function przedCzasem<T>(obietnica: PromiseLike<T>, ms: number): Promise<T | 'czas'> {
  let zegar: ReturnType<typeof setTimeout> | undefined;
  const czas = new Promise<'czas'>((gotowe) => {
    zegar = setTimeout(() => gotowe('czas'), ms);
  });
  return Promise.race([Promise.resolve(obietnica), czas]).finally(() => clearTimeout(zegar));
}

/** Ścieżka względem `/api/mobile/v1`, np. `konto`. */
export function adresTrasy(adres: string, sciezka: string): string {
  return `${adres.replace(/\/+$/, '')}/api/mobile/v1/${sciezka.replace(/^\/+/, '')}`;
}

/** Nagłówki żądania do API: token zawsze, firma przy trasach z danymi firmy. */
export function naglowki(token: string, firma?: string | null, zCialem = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(zCialem ? { 'Content-Type': 'application/json' } : {}),
    ...(firma ? { [MOBILE_ACTIVE_ORG_HEADER]: firma } : {}),
  };
}

/**
 * Wspólna pętla: token, próba, po `sesja` odświeżenie i druga próba.
 * `proba` zwraca wynik albo błąd do sklasyfikowania.
 */
async function zPonowieniem<T>(z: Pick<Zaleznosci, 'token' | 'odswiez'>, proba: (token: string) => Promise<Wynik<T>>): Promise<Wynik<T>> {
  for (let podejscie = 0; podejscie < 2; podejscie++) {
    const t = await z.token();
    if ('brak' in t) return { ok: false, blad: bladTelefonu(t.brak) };
    const wynik = await proba(t.token);
    if (wynik.ok || wynik.blad.rodzaj !== 'sesja' || podejscie > 0) return wynik;
    const odswiezenie = await z.odswiez();
    if (odswiezenie === 'polaczenie') return { ok: false, blad: bladTelefonu('polaczenie') };
    if (odswiezenie === 'koniec') return wynik;
  }
  // Pętla zawsze kończy się w środku; to tylko dla typów.
  return { ok: false, blad: bladTelefonu('sesja') };
}

/** Klient tras `/api/mobile/v1`. */
export function utworzKlienta(z: Zaleznosci) {
  return function zapytaj<T>(sciezka: string, opcje: OpcjeZapytania = {}): Promise<Wynik<T>> {
    const adres = z.adres;
    if (!adres) return Promise.resolve({ ok: false, blad: bladTelefonu('serwer', BRAK_ADRESU_API) });
    const zCialem = opcje.cialo !== undefined;
    return zPonowieniem<T>(z, async (token) => {
      let odp: Awaited<ReturnType<Zaleznosci['pobierz']>>;
      try {
        odp = await z.pobierz(adresTrasy(adres, sciezka), {
          method: opcje.metoda ?? 'GET',
          headers: naglowki(token, opcje.firma, zCialem),
          ...(zCialem ? { body: JSON.stringify(opcje.cialo) } : {}),
        });
      } catch {
        return { ok: false, blad: bladTelefonu('polaczenie') };
      }
      const cialo = await odp.json().catch(() => null);
      if (odp.ok) return { ok: true, dane: cialo as T, status: odp.status };
      return { ok: false, blad: bladApi(odp.status, cialo, odp.headers.get('Retry-After')) };
    });
  };
}

/** Odpowiedź PostgREST z `@supabase/supabase-js` w kształcie, którego tu potrzebujemy. */
export type OdpowiedzBazy<T> = { data: T | null; error: { message?: string; code?: string } | null; status: number };

/**
 * Błąd odczytu z bazy na ten sam język co API. Bez sieci `supabase-js` daje
 * status 0; wygasły token PostgREST odrzuca 401 (kod `PGRST301`/`PGRST303`).
 */
export function bladBazy(odp: Pick<OdpowiedzBazy<unknown>, 'status' | 'error'>): BladApi {
  if (odp.status === 0) return bladTelefonu('polaczenie');
  if (odp.status === 401) return { ...bladTelefonu('sesja'), status: 401 };
  if (odp.status === 429 || odp.status === 502 || odp.status === 503 || odp.status === 504) return { ...bladTelefonu('ponow'), status: odp.status };
  return { ...bladTelefonu('serwer'), status: odp.status };
}

/**
 * Odczyt z bazy tokenem telefonu (RLS jak na stronie), z tym samym
 * ponowieniem po 401 co API. Token idzie w zapytaniu jawnie: bez niego
 * `supabase-js` wysłałby klucz publiczny, a RLS oddałby pustą listę zamiast błędu.
 */
export function zBazy<T>(z: Pick<Zaleznosci, 'token' | 'odswiez'>, zapytanie: (token: string) => PromiseLike<OdpowiedzBazy<T>>): Promise<Wynik<T>> {
  return zPonowieniem<T>(z, async (token) => {
    let odp: OdpowiedzBazy<T>;
    try {
      odp = await zapytanie(token);
    } catch {
      return { ok: false, blad: bladTelefonu('polaczenie') };
    }
    if (odp.error || odp.data === null) return { ok: false, blad: bladBazy(odp) };
    return { ok: true, dane: odp.data, status: odp.status };
  });
}
