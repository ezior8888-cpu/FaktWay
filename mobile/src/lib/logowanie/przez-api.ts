/**
 * Logowanie hasłem przez API strony (plan aplikacji mobilnej, etap M6b,
 * decyzja D16): `POST /api/mobile/v1/logowanie` zamiast `signInWithPassword`
 * wprost do GoTrue. GoTrue z włączoną captchą (`docs/runbooks/captcha-w-gotrue.md`,
 * krok 2) odrzuca logowanie hasłem bez tokenu Turnstile, a telefon go nie ma;
 * trasa loguje kluczem serwera, za limitami prób i z wpisem w audycie.
 *
 * Odpowiedź serwera zamieniamy na te same kody komunikatów co w M5b
 * (`BLEDY_LOGOWANIA`). Sesję wkłada do klienta Supabase `lib/logowanie/supabase.ts`
 * (`setSession`); odświeżanie i wylogowanie idą dalej wprost do GoTrue, bo
 * captchy nie wymagają.
 *
 * Kod 2FA od M6c też przez API (`POST /api/mobile/v1/kod`, `potwierdzKodPrzezApi`):
 * wprost w GoTrue omijał limit prób kodu i audyt strony.
 *
 * Bez React Native: testy w `tests/unit/mobile-logowanie-api.test.ts`
 * i `tests/unit/mobile-kod-api.test.ts`.
 */
import { kodBledu as kodBleduApi } from '../api/bledy';
import type { KodOdpowiedz, KodZadanie, LogowanieOdpowiedz, LogowanieZadanie, MobileApiErrorCode } from '../api/kontrakt';
import { adresTrasy, type OpcjeZapytania, type Wynik, type Zaleznosci } from '../api/rdzen';
import type { KodBledu } from './typy';

export type WynikLogowaniaApi = ({ ok: true } & LogowanieOdpowiedz) | { ok: false; blad: KodBledu };

/** Kod z kontraktu na komunikat ekranu logowania; reszta (przerwa, awaria, 500) to „Spróbuj ponownie”. */
const KOMUNIKAT_KODU: Partial<Record<MobileApiErrorCode, KodBledu>> = {
  invalid_credentials: 'zle_dane',
  // Ekran sprawdza puste pola sam; zły kształt adresu GoTrue też nazywa złymi danymi.
  invalid_request: 'zle_dane',
  rate_limited: 'za_duzo_prob',
  // Serwer nie może teraz bezpiecznie logować (bez limitów prób albo GoTrue odrzucił klucz): ten sam tekst co odmowa captchy.
  login_unavailable: 'captcha',
};

function sesjaZOdpowiedzi(cialo: unknown): LogowanieOdpowiedz | undefined {
  if (typeof cialo !== 'object' || cialo === null) return undefined;
  const { sesja, wymagaKodu } = cialo as { sesja?: unknown; wymagaKodu?: unknown };
  if (typeof sesja !== 'object' || sesja === null || typeof wymagaKodu !== 'boolean') return undefined;
  const { accessToken, refreshToken } = sesja as { accessToken?: unknown; refreshToken?: unknown };
  if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken) return undefined;
  return { sesja: { accessToken, refreshToken }, wymagaKodu };
}

export async function zalogujPrzezApi(
  z: Pick<Zaleznosci, 'adres' | 'pobierz'>,
  email: string,
  haslo: string,
): Promise<WynikLogowaniaApi> {
  if (!z.adres) return { ok: false, blad: 'nieznany' };
  const cialo: LogowanieZadanie = { email: email.trim(), haslo };
  let odp: Awaited<ReturnType<Zaleznosci['pobierz']>>;
  try {
    odp = await z.pobierz(adresTrasy(z.adres, 'logowanie'), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(cialo),
    });
  } catch {
    return { ok: false, blad: 'brak_polaczenia' };
  }
  const tresc = await odp.json().catch(() => null);
  if (odp.ok) {
    const wynik = sesjaZOdpowiedzi(tresc);
    return wynik ? { ok: true, ...wynik } : { ok: false, blad: 'nieznany' };
  }
  const kod = kodBleduApi(tresc);
  return { ok: false, blad: (kod && KOMUNIKAT_KODU[kod]) || (odp.status === 429 ? 'za_duzo_prob' : 'nieznany') };
}

/** Klient tras `/api/mobile/v1` z `utworzKlienta` (`lib/api/rdzen.ts`): token sesji, po 401 odświeżenie i jedno ponowienie. */
type Zapytaj = <T>(sciezka: string, opcje?: OpcjeZapytania) => Promise<Wynik<T>>;

/** `sesja: null`: sesja nie czekała na kod (409 `mfa_not_required`), telefon zostaje na obecnej. */
export type WynikKoduApi = { ok: true; sesja: KodOdpowiedz['sesja'] | null } | { ok: false; blad: KodBledu };

function sesjaKodu(cialo: unknown): KodOdpowiedz['sesja'] | undefined {
  if (typeof cialo !== 'object' || cialo === null) return undefined;
  const { sesja } = cialo as { sesja?: unknown };
  if (typeof sesja !== 'object' || sesja === null) return undefined;
  const { accessToken, refreshToken } = sesja as { accessToken?: unknown; refreshToken?: unknown };
  if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken) return undefined;
  return { accessToken, refreshToken };
}

/**
 * `POST /api/mobile/v1/kod` (M6c) tokenem sesji AAL1. Odpowiedź serwera to kod
 * komunikatu ekranu kodu; sesję AAL2 wkłada potem `lib/logowanie/supabase.ts`.
 * Brak sieci nie ponawia (kod nie idzie drugi raz bez dotknięcia klienta).
 */
export async function potwierdzKodPrzezApi(zapytaj: Zapytaj, kod: string): Promise<WynikKoduApi> {
  const cialo: KodZadanie = { kod };
  const wynik = await zapytaj<unknown>('kod', { metoda: 'POST', cialo });
  if (wynik.ok) {
    const sesja = sesjaKodu(wynik.dane);
    return sesja ? { ok: true, sesja } : { ok: false, blad: 'nieznany' };
  }
  const { kod: kodApi, rodzaj, status } = wynik.blad;
  if (kodApi === 'mfa_not_required') return { ok: true, sesja: null };
  if (kodApi === 'invalid_code') return { ok: false, blad: 'zly_kod' };
  if (kodApi === 'rate_limited' || status === 429) return { ok: false, blad: 'za_duzo_prob' };
  if (rodzaj === 'polaczenie') return { ok: false, blad: 'brak_polaczenia' };
  // Bez Redisa (fail-closed), GoTrue niedostępny, przerwa techniczna: „spróbuj za chwilę”, nigdy wylogowanie.
  if (rodzaj === 'ponow') return { ok: false, blad: 'kod_niedostepny' };
  return { ok: false, blad: 'nieznany' };
}
