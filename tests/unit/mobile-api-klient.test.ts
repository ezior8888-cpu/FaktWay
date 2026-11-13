/**
 * Klient API aplikacji na telefon (mobile/src/lib/api/, plan aplikacji 4.3,
 * „Stan po M6”, etap M7): każdy kod błędu z kontraktu ma swoją reakcję, 401
 * odświeża sesję i ponawia raz, awaria GoTrue i brak sieci nigdy nie kończą
 * sesji, a odczyt z bazy zawsze niesie token telefonu.
 */
import { describe, expect, it, vi } from 'vitest';

import { MOBILE_ACTIVE_ORG_HEADER, MOBILE_API_ERROR_CODES, MOBILE_IDEMPOTENCY_HEADER } from '../../lib/api/mobile/kontrakt';
import { bladApi, KOMUNIKATY, kodBledu, rodzajBledu, sekundyPonowienia } from '../../mobile/src/lib/api/bledy';
import { BRAK_ADRESU_API, przedCzasem, utworzKlienta, zBazy, type Odswiezenie, type Token, type Zaleznosci } from '../../mobile/src/lib/api/rdzen';

type Odp = { status: number; cialo?: unknown; naglowki?: Record<string, string> };

function odpowiedz({ status, cialo = null, naglowki = {} }: Odp) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => naglowki[n] ?? null },
    json: async () => cialo,
  };
}

function blad(status: number, code: string, naglowki: Record<string, string> = {}): Odp {
  return { status, cialo: { error: { code, message: 'opis' } }, naglowki };
}

function zaleznosci(odpowiedzi: (Odp | Error)[], opcje: { tokeny?: Token[]; odswiezenia?: Odswiezenie[]; adres?: string } = {}) {
  const tokeny = [...(opcje.tokeny ?? [{ token: 'tok-1' }, { token: 'tok-2' }])];
  const odswiezenia = [...(opcje.odswiezenia ?? ['ok'])];
  const pobierz = vi.fn(async (_adres: string, _o: { method: string; headers: Record<string, string>; body?: string }) => {
    const n = odpowiedzi.shift();
    if (!n) throw new Error('za dużo żądań');
    if (n instanceof Error) throw n;
    return odpowiedz(n);
  });
  const odswiez = vi.fn(async () => odswiezenia.shift() ?? 'koniec');
  const z: Zaleznosci = {
    adres: 'adres' in opcje ? opcje.adres : 'http://localhost:3000/',
    token: async () => tokeny.shift() ?? tokeny[0] ?? { token: 'tok-x' },
    odswiez,
    pobierz,
  };
  return { z, pobierz, odswiez };
}

describe('kody błędów kontraktu', () => {
  it('każdy kod z kontraktu ma reakcję telefonu', () => {
    const oczekiwane: Record<string, string> = {
      missing_token: 'sesja',
      invalid_token: 'sesja',
      mfa_required: 'kod',
      missing_org: 'firma',
      no_active_org: 'firma',
      // Faktury (M8): zdanie serwera mówi, co poprawić; brak klucza to błąd programu w telefonie.
      missing_idempotency_key: 'serwer',
      idempotency_conflict: 'odmowa',
      invoice_invalid: 'odmowa',
      not_found: 'odmowa',
      not_draft: 'odmowa',
      ksef_send_refused: 'odmowa',
      rate_limited: 'ponow',
      maintenance: 'ponow',
      session_verification_failed: 'ponow',
      service_unavailable: 'ponow',
      internal_error: 'serwer',
      // `POST /logowanie` (M6b; ekran logowania ma własne teksty, `lib/logowanie/przez-api.ts`) i treść
      // spoza kontraktu w `POST /faktury` (M8): błąd programu, nie klienta.
      invalid_request: 'serwer',
      invalid_credentials: 'serwer',
      login_unavailable: 'ponow',
      // Tylko `POST /kod` (M6c); ekran kodu ma własne teksty (`lib/logowanie/przez-api.ts`).
      invalid_code: 'serwer',
      mfa_not_required: 'serwer',
      // Należności, przypomnienia, PDF (M10a): zdanie serwera mówi, co zrobić.
      forbidden: 'odmowa',
      payment_refused: 'odmowa',
      reminder_refused: 'odmowa',
      pdf_unavailable: 'odmowa',
    };
    expect(Object.keys(oczekiwane).sort()).toEqual([...MOBILE_API_ERROR_CODES].sort());
    for (const kod of MOBILE_API_ERROR_CODES) expect(rodzajBledu(500, kod)).toBe(oczekiwane[kod]);
  });

  it('odmowa faktury (422) niesie zdanie serwera i pole formularza', () => {
    const b = bladApi(422, { error: { code: 'invoice_invalid', message: 'Nazwa wymagana', field: 'buyerName' } });
    expect(b).toEqual({ rodzaj: 'odmowa', kod: 'invoice_invalid', status: 422, ponowZaSekund: undefined, komunikat: 'Nazwa wymagana', pole: 'buyerName' });
    // Bez zdania od serwera: tekst ogólny, bez pola.
    expect(bladApi(409, { error: { code: 'not_draft', message: ' ' } })).toMatchObject({ rodzaj: 'odmowa', komunikat: KOMUNIKATY.odmowa });
    expect(bladApi(409, { error: { code: 'not_draft', message: 'x', field: 'buyerName' } }).pole).toBeUndefined();
  });

  it('zdanie serwera bez długich myślników (ZASADY-DESIGNU.md, sekcja 8)', () => {
    const b = bladApi(422, { error: { code: 'invoice_invalid', message: 'NIP firmy — 10 cyfr i suma kontrolna', field: 'buyerNip' } });
    expect(b.komunikat).toBe('NIP firmy: 10 cyfr i suma kontrolna');
    expect(bladApi(422, { error: { code: 'ksef_send_refused', message: 'Najpierw wgraj certyfikat KSeF w Ustawienia KSeF — bez niego wysyłka nie jest możliwa.' } }).komunikat)
      .toBe('Najpierw wgraj certyfikat KSeF w Ustawienia KSeF: bez niego wysyłka nie jest możliwa.');
  });

  it('awaria GoTrue (503) to „ponów”, nigdy koniec sesji', () => {
    const b = bladApi(503, { error: { code: 'session_verification_failed', message: 'x' } }, '5');
    expect(b).toMatchObject({ rodzaj: 'ponow', kod: 'session_verification_failed', status: 503, ponowZaSekund: 5 });
  });

  it('bez kodu z kontraktu decyduje status', () => {
    expect(rodzajBledu(401)).toBe('sesja');
    expect(rodzajBledu(502)).toBe('ponow');
    expect(rodzajBledu(504)).toBe('ponow');
    expect(rodzajBledu(404)).toBe('serwer');
    expect(rodzajBledu(0)).toBe('polaczenie');
    expect(kodBledu({ error: { code: 'nieznany' } })).toBeUndefined();
    expect(kodBledu('<html>')).toBeUndefined();
  });

  it('Retry-After w sekundach albo jako data', () => {
    expect(sekundyPonowienia('30')).toBe(30);
    expect(sekundyPonowienia('Fri, 13 Nov 2026 12:00:30 GMT', Date.parse('Fri, 13 Nov 2026 12:00:00 GMT'))).toBe(30);
    expect(sekundyPonowienia('jutro')).toBeUndefined();
    expect(sekundyPonowienia(null)).toBeUndefined();
  });

  it('przerwa techniczna ma własny tekst', () => {
    expect(bladApi(503, { error: { code: 'maintenance', message: 'x' } }).komunikat).toMatch(/przerwa techniczna/);
  });
});

describe('klient /api/mobile/v1', () => {
  it('wysyła token i firmę; bez firmy bez nagłówka firmy', async () => {
    const { z, pobierz } = zaleznosci([{ status: 200, cialo: { a: 1 } }, { status: 200, cialo: { b: 2 } }]);
    const zapytaj = utworzKlienta(z);
    await expect(zapytaj('konto', { firma: '11111111-1111-4111-8111-111111111111' })).resolves.toEqual({ ok: true, dane: { a: 1 }, status: 200 });
    await zapytaj('/konto');
    const [adres, o] = pobierz.mock.calls[0];
    expect(adres).toBe('http://localhost:3000/api/mobile/v1/konto');
    expect(o.method).toBe('GET');
    expect(o.headers.Authorization).toBe('Bearer tok-1');
    expect(o.headers[MOBILE_ACTIVE_ORG_HEADER]).toBe('11111111-1111-4111-8111-111111111111');
    expect(pobierz.mock.calls[1][1].headers[MOBILE_ACTIVE_ORG_HEADER]).toBeUndefined();
    expect(pobierz.mock.calls[1][0]).toBe('http://localhost:3000/api/mobile/v1/konto');
  });

  it('POST z ciałem ma Content-Type i JSON', async () => {
    const { z, pobierz } = zaleznosci([{ status: 201, cialo: { zapisane: true } }]);
    await utworzKlienta(z)('sesja', { metoda: 'POST', cialo: { x: 1 } });
    expect(pobierz.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{"x":1}', headers: { 'Content-Type': 'application/json' } });
  });

  it('zapis z kluczem (M8): ten sam Idempotency-Key także w ponowieniu po odświeżeniu sesji', async () => {
    const { z, pobierz } = zaleznosci([blad(401, 'invalid_token'), { status: 201, cialo: { powtorzenie: false } }]);
    const klucz = '0c4e5f1a-7b2d-4c3e-9f10-111111111111';
    await utworzKlienta(z)('faktury', { metoda: 'POST', cialo: { wyslij: true }, klucz });
    expect(pobierz.mock.calls.map((c) => c[1].headers[MOBILE_IDEMPOTENCY_HEADER])).toEqual([klucz, klucz]);
    // Bez klucza (np. odczyt konta) nagłówka nie ma.
    const bez = zaleznosci([{ status: 200, cialo: {} }]);
    await utworzKlienta(bez.z)('konto');
    expect(bez.pobierz.mock.calls[0][1].headers[MOBILE_IDEMPOTENCY_HEADER]).toBeUndefined();
  });

  it('401 invalid_token: odświeża sesję i ponawia raz z nowym tokenem', async () => {
    const { z, pobierz, odswiez } = zaleznosci([blad(401, 'invalid_token'), { status: 200, cialo: { ok: 1 } }]);
    const w = await utworzKlienta(z)('konto');
    expect(w).toEqual({ ok: true, dane: { ok: 1 }, status: 200 });
    expect(odswiez).toHaveBeenCalledTimes(1);
    expect(pobierz.mock.calls.map((c) => c[1].headers.Authorization)).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  it('401 po odświeżeniu: koniec, bez trzeciej próby', async () => {
    const { z, pobierz, odswiez } = zaleznosci([blad(401, 'invalid_token'), blad(401, 'invalid_token')]);
    const w = await utworzKlienta(z)('konto');
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.blad.rodzaj).toBe('sesja');
    expect(pobierz).toHaveBeenCalledTimes(2);
    expect(odswiez).toHaveBeenCalledTimes(1);
  });

  it('odświeżenie odrzucone przez serwer: sesja (telefon kończy ją sam)', async () => {
    const { z, pobierz } = zaleznosci([blad(401, 'invalid_token')], { odswiezenia: ['koniec'] });
    const w = await utworzKlienta(z)('konto');
    expect(!w.ok && w.blad.rodzaj).toBe('sesja');
    expect(pobierz).toHaveBeenCalledTimes(1);
  });

  it('odświeżenie bez sieci: brak połączenia, nie wylogowanie', async () => {
    const { z } = zaleznosci([blad(401, 'invalid_token')], { odswiezenia: ['polaczenie'] });
    const w = await utworzKlienta(z)('konto');
    expect(!w.ok && w.blad.rodzaj).toBe('polaczenie');
  });

  it('503 i 403 mfa_required bez odświeżania sesji', async () => {
    const { z, odswiez } = zaleznosci([blad(503, 'session_verification_failed', { 'Retry-After': '2' }), blad(403, 'mfa_required')]);
    const zapytaj = utworzKlienta(z);
    const a = await zapytaj('konto');
    const b = await zapytaj('konto');
    expect(!a.ok && a.blad).toMatchObject({ rodzaj: 'ponow', ponowZaSekund: 2 });
    expect(!b.ok && b.blad.rodzaj).toBe('kod');
    expect(odswiez).not.toHaveBeenCalled();
  });

  it('fetch bez sieci i token bez sieci: brak połączenia', async () => {
    const { z } = zaleznosci([new TypeError('Network request failed')]);
    const a = await utworzKlienta(z)('konto');
    expect(!a.ok && a.blad.rodzaj).toBe('polaczenie');

    const b = zaleznosci([], { tokeny: [{ brak: 'polaczenie' }] });
    const w = await utworzKlienta(b.z)('konto');
    expect(!w.ok && w.blad.rodzaj).toBe('polaczenie');
    expect(b.pobierz).not.toHaveBeenCalled();
  });

  it('bez adresu API nie wysyła nic i mówi, czego brakuje', async () => {
    const { z, pobierz } = zaleznosci([], { adres: undefined });
    const w = await utworzKlienta(z)('konto');
    expect(!w.ok && w.blad.komunikat).toBe(BRAK_ADRESU_API);
    expect(pobierz).not.toHaveBeenCalled();
  });

  it('odpowiedź bez JSON-a (np. strona błędu bramki) nie wywraca klienta', async () => {
    const { z } = zaleznosci([{ status: 502, cialo: undefined }]);
    const w = await utworzKlienta(z)('konto');
    expect(!w.ok && w.blad.rodzaj).toBe('ponow');
  });
});

describe('odczyt z bazy tokenem telefonu', () => {
  it('przekazuje token do zapytania i oddaje dane', async () => {
    const { z } = zaleznosci([]);
    const zapytanie = vi.fn(async (token: string) => ({ data: [token], error: null, status: 200 }));
    await expect(zBazy(z, zapytanie)).resolves.toEqual({ ok: true, dane: ['tok-1'], status: 200 });
  });

  it('status 0 (brak sieci w supabase-js) to brak połączenia', async () => {
    const { z } = zaleznosci([]);
    const w = await zBazy(z, async () => ({ data: null, error: { message: 'TypeError: Network request failed' }, status: 0 }));
    expect(!w.ok && w.blad.rodzaj).toBe('polaczenie');
  });

  it('401 (wygasły JWT w PostgREST): odświeżenie i druga próba z nowym tokenem', async () => {
    const { z, odswiez } = zaleznosci([]);
    const tokeny: string[] = [];
    const w = await zBazy(z, async (token) => {
      tokeny.push(token);
      return tokeny.length === 1 ? { data: null, error: { code: 'PGRST301' }, status: 401 } : { data: [1], error: null, status: 200 };
    });
    expect(w.ok).toBe(true);
    expect(tokeny).toEqual(['tok-1', 'tok-2']);
    expect(odswiez).toHaveBeenCalledTimes(1);
  });

  it('bez tokenu nie pyta bazy (klucz publiczny dałby pustą listę zamiast błędu)', async () => {
    const { z } = zaleznosci([], { tokeny: [{ brak: 'sesja' }] });
    const zapytanie = vi.fn();
    const w = await zBazy(z, zapytanie);
    expect(!w.ok && w.blad.rodzaj).toBe('sesja');
    expect(zapytanie).not.toHaveBeenCalled();
  });

  it('wyjątek w zapytaniu to brak połączenia', async () => {
    const { z } = zaleznosci([]);
    const w = await zBazy(z, async () => {
      throw new TypeError('Network request failed');
    });
    expect(!w.ok && w.blad.rodzaj).toBe('polaczenie');
  });
});

describe('limit czasu na odświeżenie tokenu', () => {
  it('bez sieci (odświeżenie ponawiane do 30 s) start nie czeka dłużej niż limit', async () => {
    vi.useFakeTimers();
    try {
      const nigdy = new Promise<string>(() => undefined);
      const wynik = przedCzasem(nigdy, 3000);
      await vi.advanceTimersByTimeAsync(3000);
      await expect(wynik).resolves.toBe('czas');
    } finally {
      vi.useRealTimers();
    }
  });

  it('szybka odpowiedź wygrywa z limitem', async () => {
    await expect(przedCzasem(Promise.resolve('sesja'), 3000)).resolves.toBe('sesja');
  });
});
