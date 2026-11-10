/**
 * TST-SIEC: test jednostkowy nie może wyjść do prawdziwej sieci.
 *
 * Dwa razy test po cichu szedł do prawdziwego API i przechodził tylko dzięki
 * odpowiedzi serwera: PR #191 (GUS) i PR #537 (`POST /auth/token/refresh`
 * do KSeF TEST). Blokada z `tests/setup.ts` ma odrzucić takie połączenie od
 * razu, z adresem i nazwą testu w komunikacie, także gdy sieć działa.
 *
 * Adresy zewnętrzne są celowo martwe (`.invalid`, TEST-NET 192.0.2.0/24),
 * więc bez blokady test pada na DNS albo limicie czasu i nigdy nie dotyka
 * prawdziwej usługi. Próby, które ten plik wywołuje celowo, zabiera
 * z rejestru `zabierzZablokowanePolaczenia()`; inaczej `afterEach`
 * z `tests/setup.ts` oblałby test.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, get, type Server } from 'node:http';
import { connect, Socket, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FLAGA_PRAWDZIWEJ_SIECI,
  czyBlokadaZainstalowana,
  czyHostLokalny,
  sprawdzBlokadeSieci,
  zabierzZablokowanePolaczenia,
  zainstalujBlokadeSieci,
} from '../helpers/blokada-sieci';

const ZEWNETRZNY = 'https://blokada-sieci.invalid/v2/auth/token/refresh';
const KOMUNIKAT = /Blokada sieci w testach/;
// Ręczny przebieg z flagą celowo wyłącza blokadę (głośno), więc jej testy
// nie mają wtedy czego sprawdzać. Bez flagi biegną zawsze: zepsuty setup
// (blokada niezainstalowana) daje czerwone, nie pominięte.
const FLAGA_WLACZONA = process.env[FLAGA_PRAWDZIWEJ_SIECI] === '1';

function obecnyTest(): string {
  return expect.getState().currentTestName ?? '';
}

function bladZdarzenia(emitter: NodeJS.EventEmitter): Promise<Error> {
  return new Promise((resolve) => emitter.once('error', resolve));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.skipIf(FLAGA_WLACZONA)('blokada sieci w testach jednostkowych', () => {
  it('setup z vitest.config.ts zainstalował blokadę w tym procesie', () => {
    expect(czyBlokadaZainstalowana()).toBe(true);
  });

  it('globalny fetch na adres zewnętrzny odrzuca od razu, z adresem i nazwą testu', async () => {
    const blad = await fetch(ZEWNETRZNY).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(blad?.message).toMatch(KOMUNIKAT);
    expect(blad?.message).toContain(ZEWNETRZNY);
    expect(blad?.message).toContain(obecnyTest());
    expect(zabierzZablokowanePolaczenia()).toEqual([
      { kanal: 'fetch', adres: `GET ${ZEWNETRZNY}`, zrodlo: `test „${obecnyTest()}”` },
    ]);
  });

  it('fetch z obiektem URL i Request też jest blokowany, z metodą w komunikacie', async () => {
    await expect(fetch(new URL(ZEWNETRZNY))).rejects.toThrow(KOMUNIKAT);
    await expect(fetch(new Request(ZEWNETRZNY, { method: 'POST', body: '{}' }))).rejects.toThrow(
      `POST ${ZEWNETRZNY}`,
    );
    expect(zabierzZablokowanePolaczenia().map((p) => p.adres)).toEqual([
      `GET ${ZEWNETRZNY}`,
      `POST ${ZEWNETRZNY}`,
    ]);
  });

  it('komunikat nie powtarza loginu, hasła ani zapytania z adresu', async () => {
    await expect(fetch('https://uzytkownik:haslo@blokada-sieci.invalid/gus?klucz=sekret')).rejects.toThrow(
      'GET https://blokada-sieci.invalid/gus',
    );
    const [proba] = zabierzZablokowanePolaczenia();
    expect(proba.adres).not.toMatch(/haslo|sekret|uzytkownik/);
  });

  it('node:http na host zewnętrzny dostaje błąd blokady zamiast połączenia', async () => {
    const zadanie = get('http://blokada-sieci.invalid/gus');
    const blad = await bladZdarzenia(zadanie);

    expect(blad.message).toMatch(KOMUNIKAT);
    expect(blad.message).toContain('blokada-sieci.invalid:80');
    expect(blad.message).toContain(obecnyTest());
    expect(zabierzZablokowanePolaczenia()).toMatchObject([{ kanal: 'gniazdo', adres: 'blokada-sieci.invalid:80' }]);
  });

  it('gniazdo TCP na zewnętrzny adres IP jest blokowane bez czekania na limit czasu', async () => {
    const gniazdo = connect({ host: '192.0.2.10', port: 443 });
    const blad = await bladZdarzenia(gniazdo);

    expect(blad.message).toMatch(KOMUNIKAT);
    expect(blad.message).toContain('192.0.2.10:443');
    expect(zabierzZablokowanePolaczenia()).toMatchObject([{ kanal: 'gniazdo', adres: '192.0.2.10:443' }]);
  });

  it('serwer lokalny na 127.0.0.1 działa jak dotąd (testy Stripe)', async () => {
    const serwer: Server = createServer((_req, res) => res.end('lokalnie'));
    await new Promise<void>((resolve) => serwer.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = serwer.address() as AddressInfo;
      const odpowiedz = await fetch(`http://127.0.0.1:${port}/`);
      expect(await odpowiedz.text()).toBe('lokalnie');
    } finally {
      await new Promise<void>((resolve) => serwer.close(() => resolve()));
    }
    expect(zabierzZablokowanePolaczenia()).toEqual([]);
  });

  it("vi.stubGlobal('fetch') działa, a vi.unstubAllGlobals() przywraca blokadę, nie prawdziwy fetch", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('atrapa')));
    expect(await (await fetch(ZEWNETRZNY)).text()).toBe('atrapa');
    expect(zabierzZablokowanePolaczenia()).toEqual([]);

    vi.unstubAllGlobals();

    await expect(fetch(ZEWNETRZNY)).rejects.toThrow(KOMUNIKAT);
    expect(zabierzZablokowanePolaczenia()).toHaveLength(1);
  });

  it('błąd połknięty przez kod pod testem i tak oblewa test w afterEach', async () => {
    // Jak kod, który przy awarii sieci po cichu zwraca wartość zastępczą.
    const wynik = await fetch(ZEWNETRZNY).then(
      () => 'odpowiedź',
      () => 'wartość zastępcza',
    );
    expect(wynik).toBe('wartość zastępcza');

    // sprawdzBlokadeSieci to funkcja z afterEach w tests/setup.ts.
    expect(() => sprawdzBlokadeSieci()).toThrow(`test „${obecnyTest()}”: GET ${ZEWNETRZNY} (fetch)`);
    expect(zabierzZablokowanePolaczenia()).toEqual([]);
    expect(() => sprawdzBlokadeSieci()).not.toThrow();
  });

  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['127.0.0.1', true],
    ['127.0.0.53', true],
    ['::1', true],
    ['[::1]', true],
    ['0::1', true],
    ['0:0:0:0:0:0:0:1', true],
    ['api-test.ksef.mf.gov.pl', false],
    ['wyszukiwarkaregontest.stat.gov.pl', false],
    ['localhost.example.com', false],
    ['127.0.0.1.nip.io', false],
    ['0.0.0.0', false],
    ['10.0.0.1', false],
    ['::ffff:8.8.8.8', false],
  ])('host %s lokalny: %s', (host, lokalny) => {
    expect(czyHostLokalny(host)).toBe(lokalny);
  });
});

describe(`flaga ${FLAGA_PRAWDZIWEJ_SIECI}`, () => {
  it.skipIf(FLAGA_WLACZONA)('wyłącza blokadę tylko jawnie i głośno, z jednym ostrzeżeniem na proces', () => {
    const ostrzezenie = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fetchPrzed = globalThis.fetch;

    expect(zainstalujBlokadeSieci({ [FLAGA_PRAWDZIWEJ_SIECI]: '1' })).toBe(false);
    expect(zainstalujBlokadeSieci({ [FLAGA_PRAWDZIWEJ_SIECI]: '1' })).toBe(false);
    expect(ostrzezenie).toHaveBeenCalledTimes(1);
    expect(ostrzezenie).toHaveBeenCalledWith(expect.stringContaining(`${FLAGA_PRAWDZIWEJ_SIECI}=1`));
    // Inna wartość niż „1” nie wyłącza blokady.
    expect(zainstalujBlokadeSieci({ [FLAGA_PRAWDZIWEJ_SIECI]: 'true' })).toBe(true);
    expect(globalThis.fetch).toBe(fetchPrzed);
  });

  it.skipIf(FLAGA_WLACZONA)('drugie zainstalowanie bez flagi niczego nie podmienia', () => {
    const fetchPrzed = globalThis.fetch;
    const connectPrzed = Socket.prototype.connect;

    expect(zainstalujBlokadeSieci({})).toBe(true);
    expect(globalThis.fetch).toBe(fetchPrzed);
    expect(Socket.prototype.connect).toBe(connectPrzed);
  });

  it('nie jest ustawiona w CI ani w konfiguracji Vitest', () => {
    const katalog = '.github/workflows';
    const pliki = [
      ...readdirSync(katalog).map((plik) => join(katalog, plik)),
      'vitest.config.ts',
      'vitest.rls.config.ts',
      'package.json',
    ];
    const zFlaga = pliki.filter((plik) => readFileSync(plik, 'utf8').includes(FLAGA_PRAWDZIWEJ_SIECI));
    expect(zFlaga).toEqual([]);
    // Skan widzi znany przypadek dodatni: ten plik zawiera nazwę flagi.
    expect(readFileSync('tests/helpers/blokada-sieci.ts', 'utf8')).toContain(FLAGA_PRAWDZIWEJ_SIECI);
  });
});
