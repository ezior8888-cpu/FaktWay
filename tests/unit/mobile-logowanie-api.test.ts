/**
 * Logowanie hasłem w aplikacji przez API (plan aplikacji mobilnej, etap M6b,
 * decyzja D16): `POST /api/mobile/v1/logowanie` zamiast `signInWithPassword`
 * wprost do GoTrue, które z captchą odrzuca telefon bez tokenu Turnstile.
 *
 * Rdzeń bez React Native (`mobile/src/lib/logowanie/przez-api.ts`): adres
 * trasy, treść żądania i odpowiedź serwera na kod komunikatu z M5b
 * (`BLEDY_LOGOWANIA`, te same teksty co przed M6b). Sesję wkłada potem do
 * klienta Supabase `zaplecze` (`lib/logowanie/supabase.ts`).
 */
import { describe, expect, it, vi } from 'vitest';

import { zalogujPrzezApi } from '../../mobile/src/lib/logowanie/przez-api';
import { BLEDY_LOGOWANIA } from '../../mobile/src/lib/logowanie/typy';

type Odp = { status: number; cialo?: unknown };

function pobieranie(odpowiedz: Odp | Error) {
  return vi.fn(async (_adres: string, _opcje: { method: string; headers: Record<string, string>; body?: string }) => {
    if (odpowiedz instanceof Error) throw odpowiedz;
    return {
      ok: odpowiedz.status >= 200 && odpowiedz.status < 300,
      status: odpowiedz.status,
      headers: { get: () => null },
      json: async () => odpowiedz.cialo ?? null,
    };
  });
}

const blad = (status: number, code: string): Odp => ({ status, cialo: { error: { code, message: 'opis serwera' } } });
const SESJA = { accessToken: 'a.b.c', refreshToken: 'odswiez-1' };

describe('logowanie hasłem przez API (M6b)', () => {
  it('POST na /api/mobile/v1/logowanie z e-mailem i hasłem, bez tokenu', async () => {
    const pobierz = pobieranie({ status: 200, cialo: { sesja: SESJA, wymagaKodu: false } });
    const wynik = await zalogujPrzezApi({ adres: 'http://localhost:3000/', pobierz }, ' Ja@Firma.pl ', 'tajne hasło');
    expect(wynik).toEqual({ ok: true, sesja: SESJA, wymagaKodu: false });
    expect(pobierz).toHaveBeenCalledTimes(1);
    const [adres, opcje] = pobierz.mock.calls[0]!;
    expect(adres).toBe('http://localhost:3000/api/mobile/v1/logowanie');
    expect(opcje.method).toBe('POST');
    expect(opcje.headers).toMatchObject({ 'Content-Type': 'application/json', Accept: 'application/json' });
    expect(opcje.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(opcje.body!)).toEqual({ email: 'Ja@Firma.pl', haslo: 'tajne hasło' });
  });

  it('konto z 2FA: wymagaKodu z serwera', async () => {
    const pobierz = pobieranie({ status: 200, cialo: { sesja: SESJA, wymagaKodu: true } });
    await expect(zalogujPrzezApi({ adres: 'http://x.test', pobierz }, 'a@b.pl', 'h')).resolves.toMatchObject({ ok: true, wymagaKodu: true });
  });

  it.each([
    ['złe dane', blad(400, 'invalid_credentials'), 'zle_dane'],
    ['zła treść żądania', blad(400, 'invalid_request'), 'zle_dane'],
    ['limit prób', blad(429, 'rate_limited'), 'za_duzo_prob'],
    ['logowanie niedostępne (bez Redisa albo captcha)', blad(503, 'login_unavailable'), 'captcha'],
    ['przerwa techniczna', blad(503, 'maintenance'), 'nieznany'],
    ['GoTrue albo baza niedostępne', blad(503, 'service_unavailable'), 'nieznany'],
    ['błąd serwera', blad(500, 'internal_error'), 'nieznany'],
    ['bramka bez treści JSON', { status: 502 }, 'nieznany'],
    ['200 bez sesji', { status: 200, cialo: { wymagaKodu: false } }, 'nieznany'],
  ] as const)('%s: komunikat %s z M5b', async (_opis, odpowiedz, kod) => {
    const wynik = await zalogujPrzezApi({ adres: 'http://x.test', pobierz: pobieranie(odpowiedz) }, 'a@b.pl', 'h');
    expect(wynik).toEqual({ ok: false, blad: kod });
    expect(BLEDY_LOGOWANIA[kod]).toBeTruthy();
  });

  it('brak sieci albo przerwane żądanie: brak_polaczenia', async () => {
    const wynik = await zalogujPrzezApi({ adres: 'http://x.test', pobierz: pobieranie(new TypeError('Network request failed')) }, 'a@b.pl', 'h');
    expect(wynik).toEqual({ ok: false, blad: 'brak_polaczenia' });
  });

  it('bez adresu serwera (EXPO_PUBLIC_API_URL): nieznany, bez żądania', async () => {
    const pobierz = pobieranie({ status: 200, cialo: { sesja: SESJA, wymagaKodu: false } });
    await expect(zalogujPrzezApi({ adres: undefined, pobierz }, 'a@b.pl', 'h')).resolves.toEqual({ ok: false, blad: 'nieznany' });
    expect(pobierz).not.toHaveBeenCalled();
  });
});
