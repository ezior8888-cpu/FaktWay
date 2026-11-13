/**
 * Logowanie hasłem przez API strony (plan aplikacji mobilnej, etap M6b,
 * decyzja D16): `POST /api/mobile/v1/logowanie` zamiast `signInWithPassword`
 * wprost do GoTrue. GoTrue z włączoną captchą (`docs/runbooks/captcha-w-gotrue.md`,
 * krok 2) odrzuca logowanie hasłem bez tokenu Turnstile, a telefon go nie ma;
 * trasa loguje kluczem serwera, za limitami prób i z wpisem w audycie.
 *
 * Odpowiedź serwera zamieniamy na te same kody komunikatów co w M5b
 * (`BLEDY_LOGOWANIA`). Sesję wkłada do klienta Supabase `lib/logowanie/supabase.ts`
 * (`setSession`); kod 2FA, odświeżanie i wylogowanie idą dalej wprost do GoTrue,
 * bo captchy nie wymagają.
 *
 * Bez React Native: testy w `tests/unit/mobile-logowanie-api.test.ts`.
 */
import { kodBledu as kodBleduApi } from '../api/bledy';
import type { LogowanieOdpowiedz, LogowanieZadanie, MobileApiErrorCode } from '../api/kontrakt';
import { adresTrasy, type Zaleznosci } from '../api/rdzen';
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
