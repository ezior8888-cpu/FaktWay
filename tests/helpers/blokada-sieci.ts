/**
 * Blokada prawdziwej sieci w testach jednostkowych (TST-SIEC).
 *
 * Po co: dwa razy test po cichu szedł do prawdziwego API i przechodził tylko
 * dzięki temu, co odpowiedział serwer: PR #191 (GUS) i PR #537
 * (`POST /auth/token/refresh` do KSeF TEST, ratowała go odpowiedź 401).
 * `tests/setup.ts` instaluje tę blokadę przed każdym plikiem domyślnego
 * zestawu (`vitest.config.ts`). Testy RLS (`vitest.rls.config.ts`) mają
 * własny setup i łączą się z osobną bazą, więc blokady nie mają.
 *
 * Co blokuje (poza 127.0.0.0/8, `localhost` i `::1`):
 * 1. globalny `fetch`: adres http(s)/ws(s) odrzuca od razu, zanim powstanie
 *    zapytanie DNS; `data:` i `blob:` idą dalej;
 * 2. `net.Socket.prototype.connect`: przez nią idą `node:net`, `node:tls`,
 *    `node:http`, `node:https`, SDK (Stripe, S3, SMTP) i fetch z pakietu
 *    `undici`. Gniazdo dostaje błąd w następnym ticku, jak przy prawdziwej
 *    awarii połączenia (natychmiastowe `destroy` wywraca `tls.connect`).
 *    Gniazda IPC i unix (`path`) są lokalne i przechodzą.
 *
 * Każda próba trafia do rejestru, a `afterEach` z `tests/setup.ts` oblewa
 * test, nawet gdy kod pod testem połknął błąd (np. „sieć padła, idę dalej”).
 * Test, który celowo sprawdza blokadę, zabiera swoje próby przez
 * `zabierzZablokowanePolaczenia()`.
 *
 * `vi.stubGlobal('fetch', atrapa)` działa jak dotąd: Vitest zapamiętuje to,
 * co było w `globalThis`, czyli blokujący fetch, i `vi.unstubAllGlobals()`
 * przywraca blokadę, nie prawdziwy fetch.
 *
 * Czego nie widzi: procesów potomnych (testy skryptów `scripts/ops/*.sh`
 * uruchamiają bash z własnymi atrapami poleceń), `worker_threads`, UDP
 * (`node:dgram`) i samych zapytań DNS.
 *
 * Przypisanie do testu bierze nazwę testu trwającego w chwili próby
 * (`expect.getState()`). Próba z kodu, który wyciekł z poprzedniego testu
 * (timer, niedoczekana obietnica), albo z `it.concurrent` trafia więc na test
 * akurat trwający; adres w komunikacie wskazuje wtedy prawdziwe źródło.
 *
 * Wyjście: test, który naprawdę potrzebuje sieci, oznacz
 * `it.runIf(process.env.VITEST_PRAWDZIWA_SIEC === '1')` i uruchamiaj ręcznie
 * z `VITEST_PRAWDZIWA_SIEC=1`. Flaga wyłącza blokadę dla całego przebiegu,
 * głośno (ostrzeżenie na stderr raz na proces), i nie może trafić do CI
 * (pilnuje tego `tests/unit/siec-blokada-testow.test.ts`).
 */
import net from 'node:net';
import { expect } from 'vitest';

export const FLAGA_PRAWDZIWEJ_SIECI = 'VITEST_PRAWDZIWA_SIEC';

export interface ProbaSieci {
  /** `fetch` = globalny fetch, `gniazdo` = TCP/TLS (node:net, node:http, SDK). */
  kanal: 'fetch' | 'gniazdo';
  /** Metoda i adres (fetch) albo host:port (gniazdo), bez loginu, hasła i zapytania. */
  adres: string;
  /** Test trwający w chwili próby albo plik, gdy próba padła poza testem. */
  zrodlo: string;
}

type Connect = net.Socket['connect'];

interface StanBlokady {
  proby: ProbaSieci[];
}

// Stan w `globalThis`, nie w module: setup i plik testu mogą dostać osobne
// egzemplarze tego modułu, a łatka na `fetch` i `Socket` jest jedna na proces.
const KLUCZ: unique symbol = Symbol.for('faktway.testy.blokada-sieci');
const KLUCZ_OSTRZEZENIA: unique symbol = Symbol.for('faktway.testy.blokada-sieci.ostrzezenie');
type GlobalZBlokada = typeof globalThis & { [KLUCZ]?: StanBlokady; [KLUCZ_OSTRZEZENIA]?: true };

const PROTOKOLY_SIECIOWE = new Set(['http:', 'https:', 'ws:', 'wss:']);

export class ZablokowanaSiecError extends Error {
  readonly proba: ProbaSieci;

  constructor(proba: ProbaSieci) {
    super(
      `Blokada sieci w testach: połączenie z ${proba.adres} (${proba.kanal}) w trakcie: ${proba.zrodlo}. ` +
        'Testy jednostkowe nie wychodzą poza 127.0.0.1, localhost i ::1. ' +
        "Podstaw atrapę: vi.stubGlobal('fetch', …) albo vi.mock modułu klienta. " +
        `Test, który naprawdę potrzebuje sieci: ${FLAGA_PRAWDZIWEJ_SIECI}=1, opis w tests/helpers/blokada-sieci.ts.`,
    );
    this.name = 'ZablokowanaSiecError';
    this.proba = proba;
  }
}

/** Pętla zwrotna: `localhost`, 127.0.0.0/8 i `::1` w każdym zapisie IPv6 (także w nawiasach z URL). */
export function czyHostLokalny(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (h === 'localhost') return true;
  if (net.isIPv4(h)) return h.split('.')[0] === '127';
  if (net.isIPv6(h)) {
    // Parser URL sprowadza każdy zapis (0::1, 0:0:0:0:0:0:0:1) do postaci kanonicznej.
    try {
      return new URL(`http://[${h}]/`).hostname === '[::1]';
    } catch {
      return false;
    }
  }
  return false;
}

function stan(): StanBlokady | undefined {
  return (globalThis as GlobalZBlokada)[KLUCZ];
}

/** Czy blokada działa w tym procesie (setup ją zainstalował i flaga jej nie wyłączyła). */
export function czyBlokadaZainstalowana(): boolean {
  return stan() !== undefined;
}

function zrodloProby(): string {
  try {
    const { currentTestName, testPath } = expect.getState();
    if (currentTestName) return `test „${currentTestName}”`;
    if (testPath) return `kod poza testem w ${testPath}`;
  } catch {
    // expect poza przebiegiem Vitest: zostaje opis ogólny.
  }
  return 'kod poza testem';
}

function zarejestruj(kanal: ProbaSieci['kanal'], adres: string): ZablokowanaSiecError {
  const proba: ProbaSieci = { kanal, adres, zrodlo: zrodloProby() };
  stan()?.proby.push(proba);
  return new ZablokowanaSiecError(proba);
}

/** Zablokowany adres żądania fetch albo `null`, gdy żądanie może iść dalej. */
function zablokowanyFetch(input: unknown, init: unknown): string | null {
  let href: string;
  let metoda: string | undefined;
  if (typeof init === 'object' && init !== null && typeof (init as { method?: unknown }).method === 'string') {
    metoda = (init as { method: string }).method;
  }
  try {
    if (typeof input === 'object' && input !== null && typeof (input as { url?: unknown }).url === 'string') {
      // Request (także z innego realm, np. jsdom): adres i metoda z obiektu.
      const zadanie = input as { url: string; method?: unknown };
      href = zadanie.url;
      if (metoda === undefined && typeof zadanie.method === 'string') metoda = zadanie.method;
    } else {
      // String i URL: ta sama konwersja co w fetch (toString).
      href = String(input);
    }
  } catch {
    return null;
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    // Natywny fetch odrzuci błędny adres sam, bez sieci.
    return null;
  }
  if (!PROTOKOLY_SIECIOWE.has(url.protocol) || czyHostLokalny(url.hostname)) return null;
  return `${(metoda ?? 'GET').toUpperCase()} ${url.origin}${url.pathname}`;
}

/**
 * Zablokowany cel `Socket.prototype.connect` albo `null`. Kształty argumentów
 * jak w `normalizeArgs` z `node:net`: znormalizowana tablica od `net.connect`,
 * `(options, cb)`, `(port, host?, cb?)` i `(path, cb?)`.
 */
function zablokowaneGniazdo(args: readonly unknown[]): string | null {
  const pierwszy: unknown = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  let host: unknown;
  let port: unknown;
  if (typeof pierwszy === 'object' && pierwszy !== null) {
    const opcje = pierwszy as { host?: unknown; port?: unknown; path?: unknown };
    if (typeof opcje.path === 'string' && opcje.path !== '') return null;
    host = opcje.host;
    port = opcje.port;
  } else if (typeof pierwszy === 'string' && !(Number(pierwszy) >= 0)) {
    return null;
  } else {
    port = pierwszy;
    host = args[1];
  }
  const cel = typeof host === 'string' && host !== '' ? host : 'localhost';
  if (czyHostLokalny(cel)) return null;
  return `${net.isIPv6(cel) ? `[${cel}]` : cel}:${String(port)}`;
}

/**
 * Instaluje blokadę w tym procesie. Zwraca `false`, gdy flaga
 * `VITEST_PRAWDZIWA_SIEC=1` ją wyłącza (z ostrzeżeniem raz na proces, nigdy
 * po cichu). Drugie wywołanie niczego nie zmienia.
 */
export function zainstalujBlokadeSieci(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const globalny = globalThis as GlobalZBlokada;
  if (env[FLAGA_PRAWDZIWEJ_SIECI] === '1') {
    if (!globalny[KLUCZ_OSTRZEZENIA]) {
      globalny[KLUCZ_OSTRZEZENIA] = true;
      // Prosto do stderr: `console` w setupie Vitest 4 przechwytuje i przy
      // zielonym pliku nie pokazuje, a to ostrzeżenie ma być widać zawsze.
      process.stderr.write(
        `[blokada sieci] ${FLAGA_PRAWDZIWEJ_SIECI}=1: testy mogą łączyć się z prawdziwą siecią. Tylko ręcznie, nigdy w CI.\n`,
      );
    }
    return false;
  }
  if (globalny[KLUCZ]) return true;

  const natywnyFetch = globalThis.fetch;
  const natywnyConnect = net.Socket.prototype.connect;
  globalny[KLUCZ] = { proby: [] };

  const fetchZBlokada: typeof fetch = (input, init) => {
    const adres = zablokowanyFetch(input, init);
    if (adres !== null) return Promise.reject(zarejestruj('fetch', adres));
    return natywnyFetch(input, init);
  };
  globalThis.fetch = fetchZBlokada;

  function connectZBlokada(this: net.Socket, ...args: unknown[]): net.Socket {
    const adres = zablokowaneGniazdo(args);
    if (adres === null) return Reflect.apply(natywnyConnect, this, args) as net.Socket;
    const blad = zarejestruj('gniazdo', adres);
    // W następnym ticku: wywołujący (tls.connect, http.Agent) dokończy
    // konfigurację gniazda i podepnie obsługę 'error', zanim błąd przyjdzie.
    process.nextTick(() => this.destroy(blad));
    return this;
  }
  net.Socket.prototype.connect = connectZBlokada as Connect;
  return true;
}

/** Zwraca i czyści próby zarejestrowane od ostatniego sprawdzenia. */
export function zabierzZablokowanePolaczenia(): ProbaSieci[] {
  const aktualny = stan();
  return aktualny ? aktualny.proby.splice(0) : [];
}

/**
 * Oblewa test, gdy od ostatniego sprawdzenia była próba wyjścia do sieci,
 * także połknięta przez kod pod testem. Woła ją `tests/setup.ts`.
 */
export function sprawdzBlokadeSieci(): void {
  const proby = zabierzZablokowanePolaczenia();
  if (proby.length === 0) return;
  const lista = proby.map((p) => `- ${p.zrodlo}: ${p.adres} (${p.kanal})`).join('\n');
  throw new Error(
    `Blokada sieci w testach: ${proby.length} ${proby.length === 1 ? 'próba' : 'prób(y)'} połączenia ` +
      'z siecią poza 127.0.0.1, localhost i ::1 (kod pod testem mógł połknąć błąd blokady):\n' +
      `${lista}\nPodstaw atrapę: vi.stubGlobal('fetch', …) albo vi.mock modułu klienta.`,
  );
}
