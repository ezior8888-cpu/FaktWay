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
 * prawdziwej usługi.
 */
import { createServer, get, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ZEWNETRZNY = 'https://blokada-sieci.invalid/v2/auth/token/refresh';
const KOMUNIKAT = /Blokada sieci w testach/;

function obecnyTest(): string {
  return expect.getState().currentTestName ?? '';
}

function bladZdarzenia(emitter: NodeJS.EventEmitter): Promise<Error> {
  return new Promise((resolve) => emitter.once('error', resolve));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('blokada sieci w testach jednostkowych', () => {
  it('globalny fetch na adres zewnętrzny odrzuca od razu, z adresem i nazwą testu', async () => {
    const blad = await fetch(ZEWNETRZNY).then(
      () => null,
      (error: unknown) => error as Error,
    );

    expect(blad?.message).toMatch(KOMUNIKAT);
    expect(blad?.message).toContain(ZEWNETRZNY);
    expect(blad?.message).toContain(obecnyTest());
  });

  it('fetch z obiektem URL i Request też jest blokowany, z metodą w komunikacie', async () => {
    await expect(fetch(new URL(ZEWNETRZNY))).rejects.toThrow(KOMUNIKAT);
    await expect(fetch(new Request(ZEWNETRZNY, { method: 'POST', body: '{}' }))).rejects.toThrow(
      `POST ${ZEWNETRZNY}`,
    );
  });

  it('node:http na host zewnętrzny dostaje błąd blokady zamiast połączenia', async () => {
    const zadanie = get('http://blokada-sieci.invalid/gus');
    const blad = await bladZdarzenia(zadanie);

    expect(blad.message).toMatch(KOMUNIKAT);
    expect(blad.message).toContain('blokada-sieci.invalid:80');
    expect(blad.message).toContain(obecnyTest());
  });

  it('gniazdo TCP na zewnętrzny adres IP jest blokowane bez czekania na limit czasu', async () => {
    const gniazdo = connect({ host: '192.0.2.10', port: 443 });
    const blad = await bladZdarzenia(gniazdo);

    expect(blad.message).toMatch(KOMUNIKAT);
    expect(blad.message).toContain('192.0.2.10:443');
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
  });

  it("vi.stubGlobal('fetch') działa, a vi.unstubAllGlobals() przywraca blokadę, nie prawdziwy fetch", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('atrapa')));
    expect(await (await fetch(ZEWNETRZNY)).text()).toBe('atrapa');

    vi.unstubAllGlobals();

    await expect(fetch(ZEWNETRZNY)).rejects.toThrow(KOMUNIKAT);
  });
});
