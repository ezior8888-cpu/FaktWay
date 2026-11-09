/**
 * Prawdziwa wysyłka faktur na KSeF TEST (plan „zero zgubionych faktur”, sesja H1a).
 *
 * Uruchom (bez sekretów, wszystko powstaje w locie):
 *   pnpm ksef:test-wysylka
 *
 * Ta sama droga co worker od XML do KSeF (`generateFA3Xml` -> `validateInvoiceXml` ->
 * `submitInvoice`), tylko bez bazy i magazynu plików. Pełny runner z bazą to sesja H1b.
 *
 * Co robi i czego NIE robi:
 * - rozmawia wyłącznie z KSeF TEST, a przy `KSEF_ENV=production` odmawia startu,
 * - przy każdym uruchomieniu losuje fikcyjny NIP z poprawną sumą kontrolną i tworzy
 *   certyfikat samopodpisany w pamięci (TEST je dopuszcza), nic nie zapisuje w repo,
 * - numer faktury ma identyfikator przebiegu, bo KSeF pilnuje unikalności numeru,
 * - dane TEST są współdzielone między integratorami, więc nie wysyłaj tu prawdziwych danych,
 * - scenariusz 17 (L1a) zmienia limity API tylko jednorazowej firmy A (`POST /testdata/rate-limits`,
 *   wyłącznie TEST) i przywraca je po pauzie; opis kroków i zasad przy `rateLimitPauseScenario`.
 *
 * Numery scenariuszy jak w sekcji 6 planu. Wynik: tabela w logu i podsumowanie joba.
 */

import { randomInt, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import type { KsefAuth } from '../lib/ksef/auth';
import {
  getKsefBaseUrl,
  isKsefLocalPause,
  isKsefRateLimitResponse,
  KsefApiError,
  ksefFetch,
} from '../lib/ksef/client';
import { prepareKsefCredentials } from '../lib/ksef/connect-credentials';
import {
  currentKsefNip,
  KSEF_PAUSE_DEFAULT_MS,
  ksefPausedUntil,
  runWithKsefNip,
} from '../lib/ksef/rate-limit-pause';
import { ksefSessionCache } from '../lib/ksef/session-cache';
import { KsefInvoiceRejectedError, submitInvoice } from '../lib/ksef/submit';
import { todayInWarsaw } from '../lib/format/warsaw-date';
import { generateFA3Xml } from '../lib/xml/fa3-generator';
import { validateInvoiceXml } from '../lib/xml/validator';
import { makeSelfSignedCertificate } from '../tests/helpers/self-signed-cert';
import type { Invoice } from '../types/invoice';
import type { InvoiceStatusResponse } from '../types/ksef';

const ENV = 'test' as const;
const UPO_WAIT_MS = 120_000;
const UPO_POLL_MS = 10_000;

/**
 * Scenariusz 17: najdłużej tyle czekamy na koniec blokady MF. Dłuższy
 * `Retry-After` = wiersz BŁĄD bez czekania, żeby bieg zmieścił się
 * w `timeout-minutes` workflow (25 min).
 */
const MAX_PAUSE_WAIT_MS = 5 * 60_000;
/** Zapas po końcu blokady, zanim skrypt znów zapyta KSeF w kontekście firmy A. */
const PAUSE_END_MARGIN_MS = 2_000;
/** Dopuszczalna różnica końca pauzy w aplikacji i `Retry-After` od MF (czas od odpowiedzi do zapisu). */
const PAUSE_UNTIL_TOLERANCE_MS = 2_000;

/**
 * Grupy, które przyjmuje `POST /testdata/rate-limits` (`SetRateLimitsRequest`
 * w `open-api.json` MF, wszystkie wymagane). `GET /rate-limits` zwraca jeszcze
 * `onlineSessionClose`, `batchSessionClose`, `anonymous` i `global`: tych POST
 * nie przyjmuje, więc ich nie wysyłamy.
 */
const SETTABLE_LIMIT_GROUPS = [
  'onlineSession',
  'batchSession',
  'invoiceSend',
  'invoiceStatus',
  'sessionList',
  'sessionInvoiceList',
  'sessionMisc',
  'invoiceMetadata',
  'invoiceExport',
  'invoiceExportStatus',
  'invoiceDownload',
  'collectiveIdentifier',
  'other',
] as const;

interface LimitValues {
  perSecond: number;
  perMinute: number;
  perHour: number;
}

/** Odpowiedź `GET /rate-limits` (`EffectiveApiRateLimits`): grupy na wierzchu obiektu. */
type RateLimits = Partial<Record<string, LimitValues>>;

type RawStatus = InvoiceStatusResponse & {
  invoicingMode?: string;
  invoicingDate?: string;
  acquisitionDate?: string;
};

interface References {
  sessionReferenceNumber: string;
  invoiceReferenceNumber: string;
}

interface Sent {
  xml: string;
  references?: References;
  raw?: RawStatus;
  accepted: boolean;
  error?: string;
}

interface Row {
  id: string;
  title: string;
  passed: boolean;
  facts: string;
}

function fictionalNip(): string {
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  for (;;) {
    const digits = Array.from({ length: 9 }, (_, i) => randomInt(i === 0 ? 1 : 0, 10));
    const control = digits.reduce((sum, digit, i) => sum + digit * weights[i]!, 0) % 11;
    if (control !== 10) return `${digits.join('')}${control}`;
  }
}

/** Świeża firma na TEST: losowy fikcyjny NIP i certyfikat samopodpisany w pamięci (TEST je dopuszcza). */
function makeFirm(): { ok: true; auth: KsefAuth } | { ok: false; problem: string } {
  const nip = fictionalNip();
  const material = makeSelfSignedCertificate({ kind: 'rsa', nip, subject: 'seal' });
  const prepared = prepareKsefCredentials({
    certificate: Buffer.from(material.certPem),
    privateKey: Buffer.from(material.keyPem),
  });
  if (!prepared.ok) return { ok: false, problem: prepared.problem };
  return {
    ok: true,
    auth: {
      type: 'xades',
      nip,
      certificatePem: prepared.certificatePem,
      privateKeyPem: prepared.privateKeyPem,
    },
  };
}

/** Dzień kalendarzowy przesunięty względem dzisiejszego w Polsce, w formacie P_1. */
function warsawDay(offsetDays: number): string {
  const [year, month, day] = todayInWarsaw().split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + offsetDays)).toISOString().slice(0, 10);
}

function buildInvoice(sellerNip: string, number: string, issueDate: string): Invoice {
  return {
    internalNumber: number,
    type: 'VAT',
    issueDate,
    saleDate: issueDate,
    seller: {
      nip: sellerNip,
      name: 'Firma testowa KSeF TEST',
      address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
      email: 'test@example.invalid',
    },
    buyer: {
      nip: '2222222222',
      name: 'Nabywca testowy Sp. z o.o.',
      address: { countryCode: 'PL', addressLine1: 'ul. Nabywcy 5', addressLine2: '00-002 Warszawa' },
    },
    lines: [
      {
        ordinal: 1,
        name: 'Usługa testowa',
        unit: 'szt',
        quantity: 1,
        unitPriceNet: 100,
        netAmount: 100,
        vatRate: '23',
        vatAmount: 23,
        grossAmount: 123,
      },
    ],
    netTotal: 100,
    vatTotal: 23,
    grossTotal: 123,
    payment: {
      amountDue: 123,
      currency: 'PLN',
      dueDate: warsawDay(14),
      method: 'transfer',
      bankAccount: 'PL61109010140000071219812874',
    },
  };
}

async function readRawStatus(auth: KsefAuth, references: References): Promise<RawStatus> {
  const { accessToken } = await ksefSessionCache.getSession(auth, ENV);
  return ksefFetch<RawStatus>(
    `/sessions/${encodeURIComponent(references.sessionReferenceNumber)}/invoices/${encodeURIComponent(references.invoiceReferenceNumber)}`,
    { accessToken, env: ENV },
  );
}

async function send(auth: KsefAuth, xml: string): Promise<Sent> {
  const validation = await validateInvoiceXml(xml);
  if (!validation.valid) {
    return { xml, accepted: false, error: `XSD: ${JSON.stringify(validation.errors).slice(0, 300)}` };
  }
  let references: References | undefined;
  try {
    const result = await submitInvoice(xml, auth, ENV, undefined, {
      onInvoiceSent: async (sent) => {
        references = sent;
      },
    });
    const finalReferences = {
      sessionReferenceNumber: result.sessionReferenceNumber,
      invoiceReferenceNumber: result.invoiceReferenceNumber,
    };
    return { xml, references: finalReferences, raw: await readRawStatus(auth, finalReferences), accepted: true };
  } catch (error) {
    const raw = references ? await readRawStatus(auth, references).catch(() => undefined) : undefined;
    return {
      xml,
      references,
      raw,
      accepted: false,
      error: `${error instanceof KsefInvoiceRejectedError ? 'odrzucona' : 'błąd'}: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`,
    };
  }
}

function describeSent(sent: Sent): string {
  const raw = sent.raw;
  const parts = [
    `przyjęta: ${sent.accepted ? 'tak' : 'nie'}`,
    `kod: ${raw?.status.code ?? 'brak'}`,
    raw?.status.description ? `opis: ${raw.status.description}` : '',
    raw?.status.details?.length ? `szczegóły: ${raw.status.details.join('; ').slice(0, 300)}` : '',
    raw?.invoicingMode ? `tryb: ${raw.invoicingMode}` : '',
    raw?.invoicingDate ? `invoicingDate: ${raw.invoicingDate}` : '',
    raw?.ksefNumber ? `numer KSeF: ${raw.ksefNumber}` : '',
    !raw && sent.error ? sent.error : '',
  ];
  return parts.filter(Boolean).join(', ');
}

/** UPO bywa gotowe dopiero po zamknięciu sesji: czekamy ograniczony czas i tylko raportujemy brak. */
async function waitForUpo(auth: KsefAuth, references: References): Promise<string> {
  const deadline = Date.now() + UPO_WAIT_MS;
  for (;;) {
    const raw = await readRawStatus(auth, references);
    if (raw.upoDownloadUrl) {
      const response = await fetch(raw.upoDownloadUrl);
      const body = response.ok ? await response.text() : '';
      return `UPO: HTTP ${response.status}, zawiera numer KSeF: ${raw.ksefNumber && body.includes(raw.ksefNumber) ? 'tak' : 'nie'}`;
    }
    if (Date.now() > deadline) return `UPO: brak adresu po ${UPO_WAIT_MS / 1000} s`;
    await new Promise((resolve) => setTimeout(resolve, UPO_POLL_MS));
  }
}

function formatLimit(limit: LimitValues | undefined): string {
  return limit ? `${limit.perSecond}/${limit.perMinute}/${limit.perHour}` : 'brak';
}

function sameLimit(a: LimitValues | undefined, b: LimitValues | undefined): boolean {
  if (!a || !b) return false;
  return a.perSecond === b.perSecond && a.perMinute === b.perMinute && a.perHour === b.perHour;
}

function clock(ms: number | null): string {
  return ms === null ? 'brak' : `${new Date(ms).toISOString().slice(11, 19)} UTC`;
}

function seconds(ms: number | null): string {
  return ms === null ? 'brak' : `${Math.round(ms / 1000)} s`;
}

/** Limity bieżącego kontekstu (grupa `other`). Poza kolejką firmy, więc bez bramki L1a. */
function readLimits(accessToken: string): Promise<RateLimits> {
  return ksefFetch<RateLimits>('/rate-limits', { accessToken, env: ENV });
}

/** Treść 429 od MF: `status.details` (`application/json`) albo `detail` (`application/problem+json`). */
function rateLimitDetails(body: unknown): string {
  const clean = (text: string) => text.replace(/\s+/g, ' ').slice(0, 300);
  if (body && typeof body === 'object') {
    const shaped = body as { status?: { details?: unknown }; detail?: unknown };
    const details = shaped.status?.details;
    if (Array.isArray(details) && details.length > 0) return clean(details.map(String).join('; '));
    if (typeof shaped.detail === 'string') return clean(shaped.detail);
  }
  return typeof body === 'string' && body ? clean(body) : 'brak';
}

function describeError(error: unknown): string {
  if (isKsefLocalPause(error) && error instanceof KsefApiError) {
    return `lokalna pauza (bez żądania do MF), zostało ${seconds(error.retryAfterMs)}`;
  }
  if (error instanceof KsefApiError) {
    return [
      `HTTP ${error.status}`,
      error.retryAfterMs !== null ? `Retry-After ${seconds(error.retryAfterMs)}` : '',
      error.status === 429 ? `treść: ${rateLimitDetails(error.body)}` : '',
    ]
      .filter(Boolean)
      .join(', ');
  }
  return error instanceof Error ? error.message.slice(0, 200) : String(error);
}

/**
 * Uruchamia `fn` i liczy żądania HTTP, które w tym czasie wychodzą z procesu
 * (skrypt nie robi nic równolegle). `block`: żadne nie wychodzi, atrapa
 * odrzuca je bez sieci, więc nawet zepsuta bramka L1a nie uderzy w KSeF
 * drugi raz w czasie pauzy.
 */
async function withRequestCount<T>(
  mode: 'forward' | 'block',
  fn: () => Promise<T>,
): Promise<{ requests: string[]; value?: T; error?: unknown }> {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    requests.push(`${method} ${url.replace(getKsefBaseUrl(ENV), '')}`);
    if (mode === 'block') throw new Error('skrypt: żądanie zatrzymane w kroku bramki L1a');
    return original(input, init);
  };
  try {
    return { requests, value: await fn() };
  } catch (error) {
    return { requests, error };
  } finally {
    globalThis.fetch = original;
  }
}

interface Probe {
  group: string;
  status: number | 'lokalna' | 'sieć';
  retryAfterMs: number | null;
  details: string;
  at: number;
}

/**
 * Jedna sonda poza kolejką firmy: surowy `ksefFetch` bez `runWithKsefNip`,
 * więc bramka L1a jej nie zatrzymuje i nie zapisuje pauzy. Liczy się do grupy
 * MF podanej w `group` (`x-rate-limits` operacji w `open-api.json`).
 */
async function probe(group: string, path: string, accessToken: string): Promise<Probe> {
  try {
    await ksefFetch(path, { accessToken, env: ENV });
    return { group, status: 200, retryAfterMs: null, details: '', at: Date.now() };
  } catch (error) {
    const at = Date.now();
    if (isKsefLocalPause(error)) return { group, status: 'lokalna', retryAfterMs: null, details: '', at };
    if (error instanceof KsefApiError) {
      return {
        group,
        status: error.status,
        retryAfterMs: error.retryAfterMs,
        details: error.status === 429 ? rateLimitDetails(error.body) : '',
        at,
      };
    }
    return { group, status: 'sieć', retryAfterMs: null, details: describeError(error), at };
  }
}

function describeProbe(probe: Probe): string {
  return [
    `${probe.group}: ${typeof probe.status === 'number' ? `HTTP ${probe.status}` : probe.status}`,
    probe.retryAfterMs !== null ? `Retry-After ${seconds(probe.retryAfterMs)}` : '',
    probe.details ? `treść: ${probe.details}` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/** Obie sondy przeszły = MF zablokował samą grupę; obie 429 = cały kontekst (NIP). */
function blockScope(probes: Probe[]): 'grupa' | 'kontekst' | 'mieszane' {
  if (probes.every((p) => p.status === 200)) return 'grupa';
  if (probes.every((p) => p.status === 429)) return 'kontekst';
  return 'mieszane';
}

interface PauseScenarioState {
  /** `GET /rate-limits` firmy A przed zmianą. */
  defaults: RateLimits | null;
  /** `POST /testdata/rate-limits` wysłany (także bez odpowiedzi): limity trzeba przywrócić. */
  limitsChanged: boolean;
  /** Najpóźniejszy znany koniec blokady MF firmy A (ms), 0 = brak. */
  blockEnd: number;
}

/**
 * Scenariusz 17 (L1a, plan „zero zgubionych faktur”): pauza firmy po 429 na
 * KSeF TEST i pomiar, czy MF po 429 blokuje samą grupę żądań, czy cały
 * kontekst (MF tego nie opisuje, `ksef-docs/limity/limity-api.md`).
 *
 *   1. Świeża firma A (`makeFirm`), logowanie, `GET /rate-limits`: domyślne
 *      `onlineSession` i `invoiceStatus` idą do faktów, bo źródła MF są
 *      sprzeczne co do domyślnych limitów TEST.
 *   2. `POST /testdata/rate-limits` (tylko TEST, kontekst firmy A): 13 grup
 *      z domyślnych, `onlineSession` 1/s i 1/min; `GET` potwierdza zmianę.
 *   3. Faktura a1 firmy A (przyjęta). 4. Druga wysyłka A: prawdziwy 429 od MF
 *      na otwarciu sesji, z `Retry-After`; jedno żądanie.
 *   5. Bramka L1a: od razu trzecia wysyłka A kończy się lokalną pauzą bez
 *      żądania (atrapa `fetch` blokuje każde), a koniec pauzy w aplikacji
 *      to chwila 429 plus `Retry-After`.
 *   6. Po jednej sondzie poza kolejką firmy na grupę: `other`
 *      (`GET /rate-limits`) i `invoiceStatus` (status a1).
 *   7. Firma B (firma skryptu) wysyła w trakcie pauzy A, bez czekania.
 *   8. Czekanie na koniec blokady (najwyżej `MAX_PAUSE_WAIT_MS`), potem
 *      `DELETE /testdata/rate-limits` i `GET` z powrotem do domyślnych
 *      (`restoreRateLimits`, także po przerwaniu kroków 3–7).
 *
 * Zasady: dokładnie jeden wyzwolony 429, najwyżej jedna sonda na grupę, nigdy
 * drugie uderzenie w `onlineSession` w czasie pauzy. Hamulca wysyłki (429
 * z 5 firm w 10 minut) skrypt nie wywołuje: 429 dostaje tylko firma A.
 * UPO w pauzie dowodzi test lokalny (`tests/unit/ksef-pauza-429.test.ts`),
 * nie ten scenariusz.
 */
async function rateLimitPauseScenario(
  firmB: KsefAuth,
  xmlFor: (sellerNip: string, suffix: string) => string,
): Promise<Row> {
  const facts: string[] = [];
  const state: PauseScenarioState = { defaults: null, limitsChanged: false, blockEnd: 0 };
  let passed = false;
  const firm = makeFirm();
  if (!firm.ok) {
    facts.push(`certyfikat firmy A odrzucony lokalnie: ${firm.problem}`);
  } else {
    try {
      passed = await runRateLimitPause(firm.auth, firmB, xmlFor, state, facts);
    } catch (error) {
      facts.push(`przerwany: ${describeError(error)}`);
      passed = false;
    }
    if (state.limitsChanged) passed = (await restoreRateLimits(firm.auth, state, facts)) && passed;
  }
  facts.push('UPO w pauzie: test lokalny tests/unit/ksef-pauza-429.test.ts, nie ten scenariusz');
  return {
    id: '17',
    title: 'Pauza firmy po 429 (L1a) i zasięg blokady MF, bez UPO',
    passed,
    facts: facts.join('; '),
  };
}

/** Kroki 1–7 scenariusza 17. Zwraca, czy wszystkie przeszły; fakty dopisuje do `facts`. */
async function runRateLimitPause(
  authA: KsefAuth,
  firmB: KsefAuth,
  xmlFor: (sellerNip: string, suffix: string) => string,
  state: PauseScenarioState,
  facts: string[],
): Promise<boolean> {
  const nipA = authA.nip;

  // 1. Domyślne limity świeżej firmy.
  const { accessToken } = await ksefSessionCache.getSession(authA, ENV);
  const defaults = await readLimits(accessToken);
  facts.push(
    `firma A ${nipA}, domyślne limity TEST (s/min/h): onlineSession ${formatLimit(defaults.onlineSession)}, invoiceStatus ${formatLimit(defaults.invoiceStatus)}`,
  );
  const rateLimits: Record<string, LimitValues> = {};
  const missing: string[] = [];
  for (const group of SETTABLE_LIMIT_GROUPS) {
    const limit = defaults[group];
    if (limit) rateLimits[group] = { perSecond: limit.perSecond, perMinute: limit.perMinute, perHour: limit.perHour };
    else missing.push(group);
  }
  if (missing.length > 0) {
    facts.push(`GET /rate-limits bez grup: ${missing.join(', ')}`);
    return false;
  }
  state.defaults = defaults;

  // 2. Jedno otwarcie sesji na minutę; reszta grup bez zmian.
  const onlineSession: LimitValues = { perSecond: 1, perMinute: 1, perHour: rateLimits.onlineSession.perHour };
  rateLimits.onlineSession = onlineSession;
  state.limitsChanged = true;
  await ksefFetch('/testdata/rate-limits', { method: 'POST', accessToken, env: ENV, body: { rateLimits } });
  const applied = await readLimits(accessToken);
  facts.push(`po POST /testdata/rate-limits onlineSession ${formatLimit(applied.onlineSession)}`);
  if (!sameLimit(applied.onlineSession, onlineSession)) return false;

  // 3. Pierwsza faktura firmy A zużywa jedyne otwarcie sesji w minucie.
  const firstStartedAt = Date.now();
  const first = await send(authA, xmlFor(nipA, '17A-1'));
  facts.push(`a1: ${describeSent(first)}`);
  if (!first.accepted || !first.references) return false;
  const a1 = first.references;

  // 4. Druga wysyłka: prawdziwy 429 od MF (nie lokalna pauza) z `Retry-After`.
  const second = await withRequestCount('forward', () => submitInvoice(xmlFor(nipA, '17A-2'), authA, ENV));
  const rateLimitedAt = Date.now();
  facts.push(
    `druga wysyłka A (${seconds(rateLimitedAt - firstStartedAt)} od startu pierwszej): ${second.error === undefined ? 'przyjęta, bez 429' : describeError(second.error)}, żądań do MF: ${second.requests.length}`,
  );
  const rateLimited = isKsefRateLimitResponse(second.error) ? second.error : null;
  if (!rateLimited) return false;
  const retryAfterMs = rateLimited.retryAfterMs;
  state.blockEnd = rateLimitedAt + (retryAfterMs ?? KSEF_PAUSE_DEFAULT_MS);
  let passed = retryAfterMs !== null && second.requests.length === 1;

  // 5. Bramka L1a: trzecia wysyłka nie wychodzi z aplikacji.
  const third = await withRequestCount('block', () => submitInvoice(xmlFor(nipA, '17A-3'), authA, ENV));
  const pausedUntil = await ksefPausedUntil(ENV, nipA);
  const expectedUntil = retryAfterMs === null ? null : rateLimitedAt + retryAfterMs;
  if (pausedUntil !== null) state.blockEnd = Math.max(state.blockEnd, pausedUntil);
  const gateHeld = isKsefLocalPause(third.error) && third.requests.length === 0;
  const untilMatches =
    pausedUntil !== null && expectedUntil !== null && Math.abs(pausedUntil - expectedUntil) <= PAUSE_UNTIL_TOLERANCE_MS;
  facts.push(
    `bramka L1a, trzecia wysyłka A: ${third.error === undefined ? 'przeszła' : describeError(third.error)}, żądań do MF: ${third.requests.length}${third.requests.length > 0 ? ` (zatrzymane w skrypcie: ${third.requests.join(', ')})` : ''}, pauza w aplikacji do ${clock(pausedUntil)} (MF: ${clock(expectedUntil)})`,
  );
  passed = gateHeld && untilMatches && passed;

  // 6. Zasięg blokady: po jednej sondzie na grupę, poza kolejką firmy.
  if (currentKsefNip() !== null) {
    facts.push('sondy pominięte: skrypt jest w kontekście firmy, bramka by je zatrzymała');
    passed = false;
  } else {
    const probes = [
      await probe('other', '/rate-limits', accessToken),
      await probe(
        'invoiceStatus',
        `/sessions/${encodeURIComponent(a1.sessionReferenceNumber)}/invoices/${encodeURIComponent(a1.invoiceReferenceNumber)}`,
        accessToken,
      ),
    ];
    for (const result of probes) {
      if (result.status === 429) {
        state.blockEnd = Math.max(state.blockEnd, result.at + (result.retryAfterMs ?? KSEF_PAUSE_DEFAULT_MS));
      }
    }
    facts.push(`zasięg blokady MF: ${blockScope(probes)} (${probes.map(describeProbe).join(', ')})`);
    // Pomiar jest ważny tylko z odpowiedzią 200 albo 429 (inny kod nie mówi nic o blokadzie).
    passed = probes.every((p) => p.status === 200 || p.status === 429) && passed;
  }

  // 7. Firma B w trakcie pauzy A: bez czekania.
  const firmBStartedAt = Date.now();
  const b = await send(firmB, xmlFor(firmB.nip, '17'));
  const pauseLeftMs = pausedUntil === null ? 0 : pausedUntil - firmBStartedAt;
  facts.push(
    `firma B (${pauseLeftMs > 0 ? `${seconds(pauseLeftMs)} przed końcem pauzy A` : 'poza pauzą A'}): ${describeSent(b)}`,
  );
  return b.accepted && pauseLeftMs > 0 && passed;
}

/**
 * Krok 8 scenariusza 17: czeka na koniec blokady MF firmy A (najwyżej
 * `MAX_PAUSE_WAIT_MS`), przywraca domyślne limity i sprawdza je. Dłuższa
 * blokada: bez czekania i bez `DELETE` (żądanie w blokadzie mogłoby ją
 * wydłużyć); zmienione limity zostają wtedy na jednorazowym fikcyjnym NIP.
 */
async function restoreRateLimits(
  authA: KsefAuth,
  state: PauseScenarioState,
  facts: string[],
): Promise<boolean> {
  const appPause = await ksefPausedUntil(ENV, authA.nip);
  const blockEnd = Math.max(state.blockEnd, appPause ?? 0);
  const waitMs = blockEnd > 0 ? blockEnd + PAUSE_END_MARGIN_MS - Date.now() : 0;
  if (waitMs > MAX_PAUSE_WAIT_MS) {
    facts.push(
      `blokada do ${clock(blockEnd)}, dłużej niż ${MAX_PAUSE_WAIT_MS / 60_000} min: bez czekania i bez DELETE /testdata/rate-limits (zmienione limity zostają na jednorazowym NIP ${authA.nip})`,
    );
    return false;
  }
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const stillPaused = await ksefPausedUntil(ENV, authA.nip);
    facts.push(
      `czekanie na koniec pauzy: ${seconds(waitMs)}, pauza w aplikacji ${stillPaused === null ? 'zakończona' : `do ${clock(stillPaused)}`}`,
    );
  }
  try {
    const { accessToken } = await ksefSessionCache.getSession(authA, ENV);
    // W kontekście firmy A: po pauzie bramka L1a musi przepuścić.
    const restored = await runWithKsefNip(authA.nip, async () => {
      await ksefFetch('/testdata/rate-limits', { method: 'DELETE', accessToken, env: ENV });
      return readLimits(accessToken);
    });
    const differs = SETTABLE_LIMIT_GROUPS.filter((group) => !sameLimit(restored[group], state.defaults?.[group]));
    facts.push(
      differs.length === 0
        ? `po DELETE /testdata/rate-limits limity domyślne (onlineSession ${formatLimit(restored.onlineSession)})`
        : `po DELETE /testdata/rate-limits inne niż domyślne: ${differs.map((group) => `${group} ${formatLimit(restored[group])}`).join(', ')}`,
    );
    return differs.length === 0;
  } catch (error) {
    facts.push(`przywrócenie limitów nieudane: ${describeError(error)}`);
    return false;
  }
}

async function main(): Promise<number> {
  if (process.env.KSEF_ENV === 'production') {
    console.error('Odmowa: ten skrypt działa wyłącznie na KSeF TEST.');
    return 2;
  }

  const runId = randomUUID().slice(0, 8).toUpperCase();
  const firm = makeFirm();
  if (!firm.ok) {
    console.error(`Certyfikat testowy odrzucony lokalnie: ${firm.problem}`);
    return 2;
  }
  const auth = firm.auth;
  const nip = auth.nip;

  console.log(`KSeF: ${getKsefBaseUrl(ENV)}, przebieg ${runId}, fikcyjny NIP ${nip}`);
  const generatedAt = new Date();
  const xmlForSeller = (sellerNip: string, suffix: string, issueDate: string) =>
    generateFA3Xml(buildInvoice(sellerNip, `H1A/${runId}/${suffix}`, issueDate), { generatedAt });
  const xmlFor = (suffix: string, issueDate: string) => xmlForSeller(nip, suffix, issueDate);
  const rows: Row[] = [];

  // 1. Zwykła faktura z dzisiejszą datą.
  const regularXml = xmlFor('1', warsawDay(0));
  const regular = await send(auth, regularXml);
  const upo = regular.references ? await waitForUpo(auth, regular.references) : 'UPO: bez sesji';
  rows.push({
    id: '1',
    title: 'Zwykła faktura, P_1 = dziś',
    passed: regular.accepted && Boolean(regular.raw?.ksefNumber) && regular.raw?.invoicingMode === 'Online',
    facts: `${describeSent(regular)}, ${upo}`,
  });

  // 2. Ten sam plik drugi raz: KSeF odrzuca jako duplikat i wskazuje oryginał.
  const duplicate = await send(auth, regularXml);
  rows.push({
    id: '2',
    title: 'Ten sam plik drugi raz',
    passed:
      !duplicate.accepted &&
      duplicate.raw?.status.code === 440 &&
      duplicate.raw.status.extensions?.originalKsefNumber === regular.raw?.ksefNumber,
    facts: `${describeSent(duplicate)}, oryginał: ${duplicate.raw?.status.extensions?.originalKsefNumber ?? 'brak'}`,
  });

  // 3. Data wystawienia z przyszłości: odrzucenie semantyczne (450).
  const future = await send(auth, xmlFor('3', warsawDay(1)));
  rows.push({
    id: '3',
    title: 'Odrzucenie: P_1 = jutro',
    passed: !future.accepted && future.raw?.status.code === 450,
    facts: describeSent(future),
  });

  // 13. Założenie B1 (art. 106nda ust. 16): KSeF przyjmuje taką fakturę i sam nadaje tryb offline.
  const yesterday = await send(auth, xmlFor('13', warsawDay(-1)));
  rows.push({
    id: '13',
    title: 'P_1 = wczoraj, bez offlineMode',
    passed: yesterday.accepted && Boolean(yesterday.raw?.ksefNumber) && yesterday.raw?.invoicingMode === 'Offline',
    facts: describeSent(yesterday),
  });

  // 13b. KSeF nie pilnuje terminu dosłania, więc musi go pilnować aplikacja (sesja B2).
  const overdue = await send(auth, xmlFor('13b', warsawDay(-5)));
  rows.push({
    id: '13b',
    title: 'P_1 = 5 dni temu, bez offlineMode',
    passed: overdue.accepted && overdue.raw?.invoicingMode === 'Offline',
    facts: describeSent(overdue),
  });

  // 17. L1a: pauza firmy po 429 i zasięg blokady MF (firma A jednorazowa, firma B = ta wyżej).
  rows.push(await rateLimitPauseScenario(auth, (sellerNip, suffix) => xmlForSeller(sellerNip, suffix, warsawDay(0))));

  const report = [
    `## KSeF TEST: wysyłka, przebieg ${runId}`,
    '',
    '| Scenariusz | Wynik | Co odpowiedział KSeF |',
    '|---|---|---|',
    ...rows.map((row) => `| ${row.id}. ${row.title} | ${row.passed ? 'OK' : 'BŁĄD'} | ${row.facts.replaceAll('|', '/')} |`),
    '',
  ].join('\n');
  console.log(`\n${report}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

  return rows.every((row) => row.passed) ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
