/**
 * Kod 2FA w aplikacji przez API (plan aplikacji mobilnej, etap M6c):
 * `POST /api/mobile/v1/kod` zamiast `mfa.challengeAndVerify` wprost do GoTrue,
 * które omijało limit prób kodu i audyt strony.
 *
 * Rdzeń bez React Native (`mobile/src/lib/logowanie/przez-api.ts`) na
 * prawdziwym kliencie API telefonu (`utworzKlienta`: token sesji, po 401
 * odświeżenie i jedno ponowienie, brak sieci nie wylogowuje). Odpowiedź
 * serwera to kod komunikatu z ekranu kodu (`BLEDY_LOGOWANIA`, teksty strony).
 * Sesję AAL2 wkłada potem do klienta Supabase `lib/logowanie/supabase.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

import { utworzKlienta, type Odswiezenie, type Token, type Zaleznosci } from '../../mobile/src/lib/api/rdzen';
import { potwierdzKodPrzezApi } from '../../mobile/src/lib/logowanie/przez-api';
import { BLEDY_LOGOWANIA } from '../../mobile/src/lib/logowanie/typy';

type Odp = { status: number; cialo?: unknown; naglowki?: Record<string, string> };

function zaleznosci(odpowiedzi: Array<Odp | Error>, opcje: { tokeny?: Token[]; odswiezenia?: Odswiezenie[]; adres?: string } = {}) {
  const tokeny = [...(opcje.tokeny ?? [{ token: 'aal1-1' }, { token: 'aal1-2' }])];
  const odswiezenia = [...(opcje.odswiezenia ?? ['ok'])];
  const pobierz = vi.fn(async (_adres: string, _opcje: { method: string; headers: Record<string, string>; body?: string }) => {
    const nastepna = odpowiedzi.shift();
    if (!nastepna) throw new Error('za dużo żądań');
    if (nastepna instanceof Error) throw nastepna;
    const naglowki = nastepna.naglowki ?? {};
    return {
      ok: nastepna.status >= 200 && nastepna.status < 300,
      status: nastepna.status,
      headers: { get: (nazwa: string) => naglowki[nazwa] ?? null },
      json: async () => nastepna.cialo ?? null,
    };
  });
  const odswiez = vi.fn(async () => odswiezenia.shift() ?? 'koniec');
  const z: Zaleznosci = {
    adres: 'adres' in opcje ? opcje.adres : 'http://localhost:3000/',
    token: async () => tokeny.shift() ?? { token: 'aal1-x' },
    odswiez,
    pobierz,
  };
  return { zapytaj: utworzKlienta(z), pobierz, odswiez };
}

const blad = (status: number, code: string, naglowki: Record<string, string> = {}): Odp =>
  ({ status, cialo: { error: { code, message: 'opis serwera' } }, naglowki });
const SESJA = { accessToken: 'aal2.token.x', refreshToken: 'odswiez-aal2' };

describe('kod 2FA przez API (M6c)', () => {
  it('POST na /api/mobile/v1/kod z tokenem sesji AAL1 i kodem; sesja AAL2 z odpowiedzi', async () => {
    const { zapytaj, pobierz } = zaleznosci([{ status: 200, cialo: { sesja: SESJA } }]);
    await expect(potwierdzKodPrzezApi(zapytaj, '246810')).resolves.toEqual({ ok: true, sesja: SESJA });
    expect(pobierz).toHaveBeenCalledTimes(1);
    const [adres, opcje] = pobierz.mock.calls[0]!;
    expect(adres).toBe('http://localhost:3000/api/mobile/v1/kod');
    expect(opcje.method).toBe('POST');
    expect(opcje.headers).toMatchObject({ Authorization: 'Bearer aal1-1', 'Content-Type': 'application/json' });
    expect(JSON.parse(opcje.body!)).toEqual({ kod: '246810' });
  });

  it('wygasły token (401): odświeżenie sesji i jedno ponowienie, bez zgubienia kodu', async () => {
    const { zapytaj, pobierz, odswiez } = zaleznosci([blad(401, 'invalid_token'), { status: 200, cialo: { sesja: SESJA } }]);
    await expect(potwierdzKodPrzezApi(zapytaj, '246810')).resolves.toEqual({ ok: true, sesja: SESJA });
    expect(odswiez).toHaveBeenCalledTimes(1);
    expect(pobierz.mock.calls[1]![1].headers.Authorization).toBe('Bearer aal1-2');
    expect(JSON.parse(pobierz.mock.calls[1]![1].body!)).toEqual({ kod: '246810' });
  });

  it('sesja nie czeka na kod (409 mfa_not_required): dalej na obecnej sesji, bez nowej', async () => {
    const { zapytaj } = zaleznosci([blad(409, 'mfa_not_required')]);
    await expect(potwierdzKodPrzezApi(zapytaj, '246810')).resolves.toEqual({ ok: true, sesja: null });
  });

  it.each([
    ['zły kod', 'zly_kod', blad(400, 'invalid_code')],
    ['limit prób kodu', 'za_duzo_prob', blad(429, 'rate_limited', { 'Retry-After': '240' })],
    ['bez Redisa (fail-closed) albo GoTrue niedostępny', 'kod_niedostepny', blad(503, 'service_unavailable', { 'Retry-After': '60' })],
    ['awaria GoTrue przy sprawdzeniu sesji', 'kod_niedostepny', blad(503, 'session_verification_failed')],
    ['przerwa techniczna', 'kod_niedostepny', blad(503, 'maintenance')],
    ['zła treść żądania', 'nieznany', blad(400, 'invalid_request')],
    ['błąd serwera', 'nieznany', blad(500, 'internal_error')],
    ['bramka bez treści JSON', 'kod_niedostepny', { status: 502 }],
    ['200 bez sesji', 'nieznany', { status: 200, cialo: { cos: 1 } }],
  ] as const)('%s: komunikat %s', async (_opis, kod, odpowiedz) => {
    const { zapytaj } = zaleznosci([odpowiedz]);
    await expect(potwierdzKodPrzezApi(zapytaj, '246810')).resolves.toEqual({ ok: false, blad: kod });
    expect(BLEDY_LOGOWANIA[kod]).toBeTruthy();
  });

  it('brak sieci: brak_polaczenia, bez ponowienia (kod nie idzie drugi raz)', async () => {
    const { zapytaj, pobierz } = zaleznosci([new TypeError('Network request failed')]);
    await expect(potwierdzKodPrzezApi(zapytaj, '246810')).resolves.toEqual({ ok: false, blad: 'brak_polaczenia' });
    expect(pobierz).toHaveBeenCalledTimes(1);
  });

  it('sesja nie do odświeżenia: nieznany (ekran wraca do logowania przez anulujKod)', async () => {
    const { zapytaj } = zaleznosci([blad(401, 'invalid_token')], { odswiezenia: ['koniec'] });
    await expect(potwierdzKodPrzezApi(zapytaj, '246810')).resolves.toEqual({ ok: false, blad: 'nieznany' });
  });

  it('bez adresu serwera (EXPO_PUBLIC_API_URL): nieznany, bez żądania', async () => {
    const { zapytaj, pobierz } = zaleznosci([], { adres: undefined });
    await expect(potwierdzKodPrzezApi(zapytaj, '246810')).resolves.toEqual({ ok: false, blad: 'nieznany' });
    expect(pobierz).not.toHaveBeenCalled();
  });

  it('tekst kod_niedostepny jak na stronie (verification_unavailable)', () => {
    expect(BLEDY_LOGOWANIA.kod_niedostepny).toBe('Nie możemy teraz sprawdzić kodu. Spróbuj ponownie za chwilę.');
  });
});
