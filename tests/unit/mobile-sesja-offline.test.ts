/**
 * Start aplikacji bez internetu z wygasłym tokenem (mobile/src/lib/logowanie/token.ts,
 * etap M7, przegląd M5b): konto z sesji zapisanej w pęku kluczy, ale konto z
 * 2FA bez kodu w tej sesji nie wchodzi, także bez sieci.
 */
import { describe, expect, it } from 'vitest';

import { daneTokenu, sesjaZTekstu, wymagaKoduBezSieci, type SesjaZapisana } from '../../mobile/src/lib/logowanie/token';

function jwt(tresc: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(tresc)}.podpis`;
}

const UZYTKOWNIK = '11111111-1111-4111-8111-111111111111';

function sesja(poziom: string, czynniki: SesjaZapisana['user']['factors']): SesjaZapisana {
  return {
    access_token: jwt({ sub: UZYTKOWNIK, session_id: 'sesja-1', aal: poziom, exp: 1_700_000_000 }),
    refresh_token: 'odswiezenie',
    user: { id: UZYTKOWNIK, email: 'test@example.test', factors: czynniki },
  };
}

describe('token sesji telefonu', () => {
  it('czyta identyfikatory, poziom i czas ważności bez sieci', () => {
    expect(daneTokenu(jwt({ sub: UZYTKOWNIK, session_id: 'sesja-1', aal: 'aal2', exp: 123 }))).toEqual({
      uzytkownik: UZYTKOWNIK,
      sesja: 'sesja-1',
      poziom: 'aal2',
      wygasa: 123,
    });
  });

  it('śmieci zamiast tokenu dają pusty wynik', () => {
    expect(daneTokenu(undefined)).toEqual({});
    expect(daneTokenu('nie.token')).toEqual({});
    expect(daneTokenu('a.@@@.c')).toEqual({});
  });
});

describe('sesja zapisana w pęku kluczy', () => {
  it('czyta sesję supabase-js; niepełna albo uszkodzona to brak sesji', () => {
    const s = sesja('aal1', []);
    expect(sesjaZTekstu(JSON.stringify(s))?.user.id).toBe(UZYTKOWNIK);
    expect(sesjaZTekstu(null)).toBeUndefined();
    expect(sesjaZTekstu('{')).toBeUndefined();
    expect(sesjaZTekstu(JSON.stringify({ access_token: 'x', user: { id: UZYTKOWNIK } }))).toBeUndefined();
    expect(sesjaZTekstu(JSON.stringify({ ...s, user: {} }))).toBeUndefined();
  });

  it('konto z TOTP i sesja bez kodu (AAL1): bez sieci też do logowania', () => {
    expect(wymagaKoduBezSieci(sesja('aal1', [{ factor_type: 'totp', status: 'verified' }]))).toBe(true);
  });

  it('konto z TOTP po kodzie (AAL2) i konto bez 2FA: dane z poprzedniego otwarcia', () => {
    expect(wymagaKoduBezSieci(sesja('aal2', [{ factor_type: 'totp', status: 'verified' }]))).toBe(false);
    expect(wymagaKoduBezSieci(sesja('aal1', []))).toBe(false);
    expect(wymagaKoduBezSieci(sesja('aal1', null))).toBe(false);
    // Niedokończone włączanie 2FA (czynnik niezweryfikowany) nie wymaga kodu, jak na stronie.
    expect(wymagaKoduBezSieci(sesja('aal1', [{ factor_type: 'totp', status: 'unverified' }]))).toBe(false);
  });
});
