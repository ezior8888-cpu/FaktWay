#!/usr/bin/env node
/**
 * Atrapa KSeF po HTTP do testu obciążenia skrzynki. Tylko loopback.
 *
 * Kontrakt z OpenAPI MF (CIRFMF/ksef-docs, open-api.json), opóźnienia z założeń
 * testu: logowanie 2-4 s, zapytanie o metadane 300-800 ms. Limit z dokumentacji
 * (`/invoices/query/metadata`: 16/min i 20/h na parę NIP + adres IP) jest
 * egzekwowany osobno od losowych 429, żeby wynik pokazał, czy harmonogram sam się
 * w nim mieści.
 *
 * Odstępstwo od kontraktu: `GET /auth/{ref}` działa też bez Bearer i oddaje
 * `authenticationToken`, bo tak woła go dziś `lib/ksef/auth.ts` (osobne ustalenie
 * w opisie PR). Licznik `authStatusBezBearer` pokazuje, ile takich wywołań było.
 *
 * Numer NIP niesie poziom firmy (druga cyfra), więc odstępy między zapytaniami
 * da się policzyć na poziom bez wiedzy o bazie.
 *
 * Uruchamia to `run.ts`. Zmienne: ATRAPA_PORT, ATRAPA_BLAD_429, ATRAPA_BLAD_5XX,
 * ATRAPA_FAKTUR_NA_MIESIAC.
 */

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.ATRAPA_PORT ?? 0);
const CHANCE_429 = Number(process.env.ATRAPA_BLAD_429 ?? 0.005);
const CHANCE_5XX = Number(process.env.ATRAPA_BLAD_5XX ?? 0.005);
const INVOICES_PER_MONTH = Number(process.env.ATRAPA_FAKTUR_NA_MIESIAC ?? 60);

const ACCESS_TTL_MS = 15 * 60_000; // „kilkanaście minut”
const REFRESH_TTL_MS = 7 * 24 * 60 * 60_000; // „do 7 dni”
const SLOT_MS = 15 * 60_000;
const MONTH_MS = 30 * 24 * 60 * 60_000;
const INVOICE_CHANCE_PER_SLOT = (INVOICES_PER_MONTH * SLOT_MS) / MONTH_MS;

const LIMIT_PER_MINUTE = 16;
const LIMIT_PER_HOUR = 20;

const stats = {
  startedAt: Date.now(),
  requests: {},
  byStatus: {},
  logins: 0,
  refreshes: 0,
  refreshRejected: 0,
  queries: 0,
  xmlDownloads: 0,
  randomErrors429: 0,
  randomErrors5xx: 0,
  limitErrors429: 0,
  authStatusBezBearer: 0,
  inFlight: 0,
  inFlightMax: 0,
  firmsQueried: 0,
  invoicesServed: 0,
  gaps: { 1: [], 2: [], 3: [], 4: [], 0: [] },
};

const pendingAuth = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();
const lastQueryAt = new Map();
const queryHistory = new Map();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const between = (min, max) => min + Math.random() * (max - min);

/** Prawdziwe JWT z KSeF ma ok. 1,5 KB, więc pamięć sesji w workerze liczy się realnie. */
function fakeToken(prefix) {
  return `${prefix}.${randomBytes(1100).toString('base64url')}`;
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(text);
  stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function bearer(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Skrót FNV-1a: ta sama firma i to samo okno dają zawsze te same faktury. */
function hash01(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 2 ** 32;
}

function invoiceFor(nip, slot) {
  const at = new Date(slot * SLOT_MS + 5 * 60_000).toISOString();
  const seller = '5260001246';
  const number = String(slot).padStart(12, '0');
  return {
    ksefNumber: `${seller}-${at.slice(0, 10).replaceAll('-', '')}-${number}-${nip.slice(-2)}`,
    invoiceNumber: `FV/${nip.slice(-4)}/${slot}`,
    issueDate: at.slice(0, 10),
    invoicingDate: at,
    acquisitionDate: at,
    permanentStorageDate: at,
    seller: { nip: seller, name: 'Dostawca atrapy KSeF' },
    buyer: { identifier: { type: 'Nip', value: nip }, name: 'Firma testu obciążenia' },
    netAmount: 100,
    vatAmount: 23,
    grossAmount: 123,
    currency: 'PLN',
    invoicingMode: 'Online',
    invoiceType: 'Vat',
    formCode: { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' },
    isSelfInvoicing: false,
    hasAttachment: false,
    invoiceHash: `${nip}-${slot}`,
  };
}

function metadataResponse(nip, body, query) {
  const from = Date.parse(body?.dateRange?.from);
  const to = Math.min(Date.parse(body?.dateRange?.to), Date.now() - 60_000);
  const invoices = [];
  if (Number.isFinite(from) && Number.isFinite(to)) {
    for (let slot = Math.floor(from / SLOT_MS); slot * SLOT_MS <= to; slot += 1) {
      const at = slot * SLOT_MS + 5 * 60_000;
      if (at < from || at > to) continue;
      if (hash01(`${nip}|${slot}`) < INVOICE_CHANCE_PER_SLOT) invoices.push(invoiceFor(nip, slot));
    }
  }
  const pageSize = Number(query.get('pageSize') ?? 250);
  const pageOffset = Number(query.get('pageOffset') ?? 0);
  const page = invoices.slice(pageOffset * pageSize, (pageOffset + 1) * pageSize);
  stats.invoicesServed += page.length;
  return {
    invoices: page,
    hasMore: (pageOffset + 1) * pageSize < invoices.length,
    isTruncated: false,
    permanentStorageHwmDate: new Date(Date.now() - 60_000).toISOString(),
  };
}

/** Okna przesuwne jak w dokumentacji: najpierw minutowe, potem godzinowe. */
function overDocumentedLimit(nip, now) {
  const history = queryHistory.get(nip) ?? [];
  const recent = history.filter((t) => t > now - 3_600_000);
  recent.push(now);
  queryHistory.set(nip, recent);
  const lastMinute = recent.filter((t) => t > now - 60_000).length;
  return lastMinute > LIMIT_PER_MINUTE || recent.length > LIMIT_PER_HOUR;
}

function randomFailure(res) {
  const roll = Math.random();
  if (roll < CHANCE_429) {
    stats.randomErrors429 += 1;
    json(res, 429, { status: 429, detail: 'atrapa: losowe 429' }, { 'Retry-After': String(Math.round(between(30, 120))) });
    return true;
  }
  if (roll < CHANCE_429 + CHANCE_5XX) {
    stats.randomErrors5xx += 1;
    json(res, 503, { status: 503, detail: 'atrapa: losowe 503' });
    return true;
  }
  return false;
}

function tierDigit(nip) {
  const digit = Number(nip[1]);
  return Number.isInteger(digit) && digit >= 1 && digit <= 4 ? digit : 0;
}

function issueTokens(nip) {
  const access = fakeToken('dostep');
  const refresh = fakeToken('odswiez');
  accessTokens.set(access, { nip, until: Date.now() + ACCESS_TTL_MS });
  refreshTokens.set(refresh, { nip, until: Date.now() + REFRESH_TTL_MS });
  return {
    accessToken: { token: access, validUntil: new Date(Date.now() + ACCESS_TTL_MS).toISOString() },
    refreshToken: { token: refresh, validUntil: new Date(Date.now() + REFRESH_TTL_MS).toISOString() },
  };
}

/** Żywy token dostępu → NIP; wygasłe sprzątamy, żeby atrapa nie puchła. */
function accessNip(req) {
  const token = bearer(req);
  const entry = token ? accessTokens.get(token) : null;
  if (!entry) return null;
  if (entry.until < Date.now()) {
    accessTokens.delete(token);
    return null;
  }
  return entry.nip;
}

async function handle(req, res, url) {
  const path = url.pathname.replace(/^\/v2/, '');
  const key = path
    .replace(/\/auth\/[0-9A-Za-z-]+$/, (m) => (/(challenge|xades-signature|ksef-token)$/.test(m) ? m : '/auth/{ref}'))
    .replace(/\/invoices\/ksef\/.+$/, '/invoices/ksef/{n}');
  stats.requests[`${req.method} ${key}`] = (stats.requests[`${req.method} ${key}`] ?? 0) + 1;

  if (req.method === 'POST' && path === '/auth/challenge') {
    await delay(between(100, 250));
    return json(res, 200, {
      challenge: `20261102-CR-${randomBytes(8).toString('hex').toUpperCase()}`,
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      clientIp: '127.0.0.1',
    });
  }

  if (req.method === 'POST' && path === '/auth/xades-signature') {
    const body = await readBody(req);
    await delay(between(300, 700));
    const nip = /<(?:\w+:)?Nip>(\d{10})</.exec(body)?.[1];
    if (!nip) return json(res, 400, { status: 400, detail: 'atrapa: brak NIP w XML' });
    if (!body.includes('Signature')) return json(res, 400, { status: 400, detail: 'atrapa: brak podpisu' });
    stats.logins += 1;
    const ref = `20261102-AU-${randomBytes(6).toString('hex').toUpperCase()}`;
    const authenticationToken = { token: fakeToken('uwierzytelnienie'), validUntil: new Date(Date.now() + 600_000).toISOString() };
    pendingAuth.set(ref, { nip, readyAt: Date.now() + between(1000, 2400), authenticationToken });
    pendingAuth.set(authenticationToken.token, { nip });
    return json(res, 202, { referenceNumber: ref, authenticationToken });
  }

  if (req.method === 'GET' && /^\/auth\/[^/]+$/.test(path)) {
    await delay(between(50, 150));
    if (!bearer(req)) stats.authStatusBezBearer += 1;
    const entry = pendingAuth.get(path.slice('/auth/'.length));
    if (!entry) return json(res, 400, { status: 400, detail: 'atrapa: brak operacji (21304)' });
    if (Date.now() < entry.readyAt) {
      return json(res, 200, { status: { code: 100, description: 'Uwierzytelnianie w toku' } });
    }
    return json(res, 200, {
      status: { code: 200, description: 'Uwierzytelnianie zakończone sukcesem' },
      authenticationToken: entry.authenticationToken,
    });
  }

  if (req.method === 'POST' && path === '/auth/token/redeem') {
    await delay(between(100, 250));
    const entry = pendingAuth.get(bearer(req));
    if (!entry?.nip) return json(res, 401, { status: 401, detail: 'atrapa: zły token uwierzytelniania' });
    return json(res, 200, issueTokens(entry.nip));
  }

  if (req.method === 'POST' && path === '/auth/token/refresh') {
    await delay(between(150, 400));
    if (randomFailure(res)) return undefined;
    const entry = refreshTokens.get(bearer(req));
    if (!entry || entry.until < Date.now()) {
      stats.refreshRejected += 1;
      return json(res, 401, { status: 401, detail: 'atrapa: refresh token nieważny' });
    }
    stats.refreshes += 1;
    const access = fakeToken('dostep');
    accessTokens.set(access, { nip: entry.nip, until: Date.now() + ACCESS_TTL_MS });
    return json(res, 200, { accessToken: { token: access, validUntil: new Date(Date.now() + ACCESS_TTL_MS).toISOString() } });
  }

  if (req.method === 'POST' && path === '/invoices/query/metadata') {
    const raw = await readBody(req);
    await delay(between(300, 800));
    const nip = accessNip(req);
    if (!nip) return json(res, 401, { status: 401, detail: 'atrapa: token dostępu nieważny' });
    const now = Date.now();
    stats.queries += 1;
    const previous = lastQueryAt.get(nip);
    if (previous) stats.gaps[tierDigit(nip)].push(now - previous);
    else stats.firmsQueried += 1;
    lastQueryAt.set(nip, now);
    if (overDocumentedLimit(nip, now)) {
      stats.limitErrors429 += 1;
      return json(res, 429, { status: 429, detail: 'atrapa: limit 16/min albo 20/h' }, { 'Retry-After': '300' });
    }
    if (randomFailure(res)) return undefined;
    return json(res, 200, metadataResponse(nip, JSON.parse(raw), url.searchParams));
  }

  if (req.method === 'GET' && path.startsWith('/invoices/ksef/')) {
    await delay(between(100, 300));
    if (!accessNip(req)) return json(res, 401, { status: 401, detail: 'atrapa: token dostępu nieważny' });
    stats.xmlDownloads += 1;
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end('<?xml version="1.0" encoding="UTF-8"?><Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/"/>');
    stats.byStatus[200] = (stats.byStatus[200] ?? 0) + 1;
    return undefined;
  }

  return json(res, 404, { status: 404, detail: `atrapa: nie znam ${req.method} ${path}` });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function statsBody() {
  const gapsByTier = {};
  const names = { 1: 'hot', 2: 'warm', 3: 'cold', 4: 'dormant', 0: 'inne' };
  for (const [digit, list] of Object.entries(stats.gaps)) {
    const sorted = [...list].sort((a, b) => a - b);
    gapsByTier[names[digit]] = {
      count: sorted.length,
      p50_s: sorted.length ? Math.round(percentile(sorted, 50) / 1000) : null,
      p95_s: sorted.length ? Math.round(percentile(sorted, 95) / 1000) : null,
      min_s: sorted.length ? Math.round(sorted[0] / 1000) : null,
      max_s: sorted.length ? Math.round(sorted[sorted.length - 1] / 1000) : null,
    };
  }
  const { gaps: _gaps, ...rest } = stats;
  return { ...rest, gapsByTier, uptimeSeconds: Math.round((Date.now() - stats.startedAt) / 1000) };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__stats') return json(res, 200, statsBody());
  stats.inFlight += 1;
  stats.inFlightMax = Math.max(stats.inFlightMax, stats.inFlight);
  try {
    await handle(req, res, url);
  } catch (error) {
    json(res, 500, { status: 500, detail: `atrapa: ${error.message}` });
  } finally {
    stats.inFlight -= 1;
  }
  return undefined;
});

server.keepAliveTimeout = 60_000;
server.listen(PORT, '127.0.0.1', () => {
  // Pierwsza linia stdout to adres: czyta ją `run.ts`.
  console.log(JSON.stringify({ port: server.address().port }));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
