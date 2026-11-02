import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

// EXT-03 (sesja 26 planu skalowania 3000): każde żądanie HTTP do KSeF z
// podanym `audit` było wierszem w `audit_logs`, także każda strona skrzynki
// co 15 minut i każda próba odpytania statusu po wysyłce. Przy 2000 firm z
// KSeF to ok. 6,5 mln wierszy miesięcznie, które nic nie mówią: odpowiedź
// 200 z pustą skrzynką albo „faktura w kolejce”. Odpytywanie ma zapisywać
// wiersz tylko przy błędzie albo realnej zmianie, a operacje zmieniające stan
// (sesja, wysyłka, zamknięcie) i odczyty rozstrzygające wysyłkę — jak dotąd.
//
// Atrapy tylko dla HTTP (globalny `fetch`, sesja XAdES) i bazy (klient
// serwisowy). Prawdziwe: `ksefFetch`, `logAuditSystem`, `queryReceivedInvoices`,
// `submitInvoice`, runner skrzynki. Wiersze audytu liczymy na INSERT-ach do
// `audit_logs`, nie na atrapie `logAuditSystem`: `vi.mock` modułu ładowanego
// przez równoległe `import()` (zapis fire-and-forget w `ksefFetch`) gubił
// część wywołań — trafiały do prawdziwego modułu.

const st = vi.hoisted(() => ({
  /** INSERT-y do `audit_logs` (klient serwisowy). */
  auditRows: [] as Array<Record<string, unknown>>,
  /** Faktury przychodzące w bazie (klient serwisowy). */
  db: [] as Array<Record<string, unknown>>,
  hwm: null as string | null,
}));

vi.mock('@/lib/ksef/session-cache', () => ({
  ksefSessionCache: { getSession: async () => ({ accessToken: 'token' }) },
}));
vi.mock('@/lib/ksef/rate-limiter', () => ({
  ksefRateLimiter: { enqueue: (_nip: string, fn: () => unknown) => fn() },
}));
vi.mock('@/lib/ksef/encryption', () => ({
  generateSessionEncryption: async () => ({ encryptedSymmetricKey: 'k', initializationVector: 'iv' }),
  encryptInvoiceXml: () => ({
    invoiceHash: 'h', invoiceSize: 1, encryptedInvoiceHash: 'eh', encryptedInvoiceSize: 1, encryptedInvoiceContent: 'c',
  }),
}));
vi.mock('@/lib/supabase/admin-queries', () => ({ getTenantKsefCredentials: vi.fn(async () => ({ nip: '1234567890' })) }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: vi.fn() }));
vi.mock('@/lib/flo/functions/expense-inbox', () => ({
  buildInboxSummaryProposal: () => null,
  classifyInboxDocuments: () => [],
}));
vi.mock('@/lib/flo/functions/inbox-cursor', () => ({
  readInboxHwm: async () => st.hwm,
  saveInboxHwm: vi.fn(async () => undefined),
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToTenant: vi.fn(async () => ({ sent: 0, failed: 0 })) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  // Synchronicznie jak prawdziwy (`logAuditSystem` nie czeka na klienta).
  createAdminClient: () => ({
    from: (table: string) => {
      let op: 'select' | 'insert' = 'select';
      let numbers: string[] = [];
      let rows: Array<Record<string, unknown>> = [];
      const q = {
        select: () => q, eq: () => q, not: () => q, limit: () => q,
        in: (_col: string, values: string[]) => { numbers = values; return q; },
        insert: (r: Record<string, unknown> | Array<Record<string, unknown>>) => {
          op = 'insert';
          rows = Array.isArray(r) ? r : [r];
          return q;
        },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
          if (table === 'audit_logs') {
            st.auditRows.push(...rows);
            return Promise.resolve({ data: null, error: null }).then(ok, fail);
          }
          if (op === 'insert') {
            const inserted: Array<Record<string, unknown>> = rows.map((r, i) => ({ ...r, id: `id-${st.db.length + i}` }));
            st.db.push(...inserted);
            return Promise.resolve({ data: inserted.map((r) => ({ id: r.id, ksef_number: r.ksef_number })), error: null }).then(ok, fail);
          }
          const found = st.db.filter((r) => numbers.includes(r.ksef_number as string));
          return Promise.resolve({ data: found, error: null }).then(ok, fail);
        },
      };
      return q;
    },
  }),
}));

import { ksefFetch } from '@/lib/ksef/client';
import { checkInvoiceStatusByReference, listSessionInvoicesAfterClose, submitInvoice } from '@/lib/ksef/submit';
import { runInboxPollTenant } from '@/lib/jobs/runners/inbox-polling';
import type { KsefAuth } from '@/lib/ksef/auth';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVOICE = '11111111-1111-4111-8111-111111111111';
const AUTH = { nip: '1234567890' } as KsefAuth;
const HWM = '2026-10-02T11:58:00Z';

type Entry = { action: string; entityId?: string; metadata: Record<string, unknown> };
const rows = (): Entry[] => st.auditRows.map((r) => ({
  action: r.action as string,
  entityId: (r.entity_id as string | null) ?? undefined,
  metadata: r.metadata as Record<string, unknown>,
}));
const actions = () => rows().map((r) => r.action);

/**
 * Zapis audytu jest fire-and-forget (`void` + import dynamiczny) — czekamy,
 * aż liczba wpisów przestanie rosnąć przez 50 ms (prawdziwy czas: zegar
 * w testach wysyłki jest atrapą tylko dla `setTimeout`).
 */
async function flushAudit(): Promise<void> {
  let last = -1;
  let quietSince = performance.now();
  while (performance.now() - quietSince < 50) {
    await new Promise((resolve) => setImmediate(resolve));
    const n = st.auditRows.length;
    if (n !== last) {
      last = n;
      quietSince = performance.now();
    }
  }
}

function reply(status: number, body?: unknown) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(body === undefined ? {} : { 'content-type': 'application/json' }),
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

type Route = (method: string, path: string) => ReturnType<typeof reply> | Promise<never>;
function ksefHttp(route: Route) {
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) =>
    route(init?.method ?? 'GET', new URL(url).pathname.replace(/^\/v2/, '')));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function faktura(n: number) {
  return {
    ksefNumber: `5260001246-20260925-${String(n).padStart(12, '0')}-00`,
    invoiceNumber: `FV ${n}/2026`, acquisitionDate: '2026-09-25T10:00:00Z', issueDate: '2026-09-25',
    invoicingDate: '2026-09-25T10:00:00Z', permanentStorageDate: '2026-09-25T10:00:00Z', invoiceType: 'Vat',
    seller: { nip: '5260001246', name: 'Dostawca' }, buyer: { identifier: { type: 'Nip', value: '1234567890' } },
    currency: 'PLN', grossAmount: 123, netAmount: 100, vatAmount: 23, invoiceHash: `hash-${n}`,
  };
}

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};
const DATA = { tenantId: TENANT, nip: '1234567890', environment: 'test' as const };

beforeAll(async () => {
  // Pierwszy import dynamiczny modułu audytu bywa wolny — rozgrzewamy go,
  // żeby „0 wierszy” w testach znaczyło brak zapisu, a nie spóźniony zapis.
  ksefHttp(() => reply(200, {}));
  await ksefFetch('/rozgrzewka', { env: 'test', audit: { tenantId: TENANT, action: 'session.open' } });
  await vi.waitFor(() => expect(st.auditRows).not.toHaveLength(0));
  vi.unstubAllGlobals();
});

beforeEach(() => {
  st.auditRows = [];
  st.db = [];
  st.hwm = '2026-10-02T11:00:00.000Z';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ksefFetch — kiedy zapisać wiersz audytu', () => {
  it('domyślnie zapisuje każdą odpowiedź, także 200 (pozostali wywołujący bez zmian)', async () => {
    ksefHttp(() => reply(201, { referenceNumber: 'SO-1' }));
    await ksefFetch('/sessions/online', { method: 'POST', env: 'test', audit: { tenantId: TENANT, action: 'session.open' } });
    await flushAudit();
    expect(rows()).toEqual([
      expect.objectContaining({ action: 'ksef.session.open', metadata: expect.objectContaining({ httpStatus: 201 }) }),
    ]);
  });

  it("`when: 'error'` — odpowiedź 2xx bez wiersza", async () => {
    ksefHttp(() => reply(200, { invoices: [], hasMore: false }));
    await ksefFetch('/invoices/query/metadata', {
      method: 'POST', env: 'test', audit: { tenantId: TENANT, action: 'inbox.poll', when: 'error' },
    });
    await flushAudit();
    expect(rows()).toEqual([]);
  });

  it("`when: 'error'` — 429, 503, przekroczony czas i błąd sieci zapisują wiersz", async () => {
    const audit = { tenantId: TENANT, action: 'inbox.poll', when: 'error' as const };
    for (const status of [429, 503]) {
      ksefHttp(() => reply(status, { exception: {} }));
      await expect(ksefFetch('/x', { env: 'test', audit })).rejects.toMatchObject({ status });
    }
    vi.stubGlobal('fetch', vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })));
    await expect(ksefFetch('/x', { env: 'test', timeoutMs: 5, audit })).rejects.toMatchObject({ status: 408 });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(ksefFetch('/x', { env: 'test', audit })).rejects.toThrow('fetch failed');
    await flushAudit();
    expect(rows().map((r) => r.metadata.httpStatus)).toEqual([429, 503, 408, 0]);
    expect(actions()).toEqual(Array(4).fill('ksef.inbox.poll'));
  });
});

describe('skrzynka — przebieg bez zmian nie zapisuje audytu', () => {
  it('przebieg bez nowych faktur: 0 wierszy (było: wiersz na każdą stronę)', async () => {
    ksefHttp(() => reply(200, { invoices: [], hasMore: false, isTruncated: false, permanentStorageHwmDate: HWM }));
    await runInboxPollTenant(DATA, ctx);
    await flushAudit();
    expect(rows()).toEqual([]);
  });

  it('dwie strony faktur, które już są w bazie: 0 wierszy', async () => {
    st.db = [faktura(1), faktura(2)].map((f, i) => ({
      id: `stara-${i}`, ksef_number: f.ksefNumber, ksef_environment: 'test', fa3_data: { invoiceHash: f.invoiceHash },
      seller_nip: f.seller.nip, issue_date: f.issueDate, gross_total: f.grossAmount,
    }));
    const pages = [
      { invoices: [faktura(1)], hasMore: true, isTruncated: false, permanentStorageHwmDate: HWM },
      { invoices: [faktura(2)], hasMore: false, isTruncated: false, permanentStorageHwmDate: HWM },
    ];
    ksefHttp(() => reply(200, pages.shift()));
    await runInboxPollTenant(DATA, ctx);
    await flushAudit();
    expect(rows()).toEqual([]);
  });

  it('429 na drugiej stronie: tylko wiersz błędu tej strony, przebieg rzuca', async () => {
    const replies = [
      reply(200, { invoices: [faktura(1)], hasMore: true, isTruncated: false, permanentStorageHwmDate: HWM }),
      reply(429, { exception: {} }),
    ];
    ksefHttp(() => replies.shift()!);
    await expect(runInboxPollTenant(DATA, ctx)).rejects.toMatchObject({ status: 429 });
    await flushAudit();
    expect(rows()).toEqual([
      expect.objectContaining({
        action: 'ksef.inbox.poll',
        metadata: expect.objectContaining({ httpStatus: 429, error: 'HTTP 429', pageOffset: 1 }),
      }),
    ]);
  });

  it('nowe faktury na dwóch stronach: jeden wiersz podsumowania (liczba, strony, okno)', async () => {
    const pages = [
      { invoices: [faktura(1)], hasMore: true, isTruncated: false, permanentStorageHwmDate: HWM },
      { invoices: [faktura(2)], hasMore: false, isTruncated: false, permanentStorageHwmDate: HWM },
    ];
    ksefHttp(() => reply(200, pages.shift()));
    await runInboxPollTenant(DATA, ctx);
    await flushAudit();
    expect(rows()).toEqual([
      expect.objectContaining({
        action: 'ksef.inbox.poll',
        metadata: expect.objectContaining({
          summary: true,
          requests: 2,
          fetched: 2,
          added: 2,
          windowFrom: '2026-10-02T11:00:00.000Z',
          hwm: HWM,
        }),
      }),
    ]);
    expect(rows()[0]!.metadata.windowTo).toEqual(expect.any(String));
  });

  it('ponowienie przebiegu po zapisie faktur nie dopisuje drugiego podsumowania', async () => {
    const page = { invoices: [faktura(1), faktura(2)], hasMore: false, isTruncated: false, permanentStorageHwmDate: HWM };
    ksefHttp(() => reply(200, page));
    await runInboxPollTenant(DATA, ctx);
    // pg-boss powtarza cały handler: to samo okno, te same faktury, już w bazie.
    await runInboxPollTenant(DATA, ctx);
    await flushAudit();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.metadata).toMatchObject({ summary: true, added: 2 });
  });
});

describe('wysyłka — odpytanie statusu: jeden wiersz na fakturę zamiast wiersza na próbę', () => {
  function sendPath(statuses: Array<ReturnType<typeof reply>>) {
    return ksefHttp((method, path) => {
      if (method === 'POST' && path === '/sessions/online') return reply(201, { referenceNumber: 'SO-1' });
      if (method === 'POST' && path === '/sessions/online/SO-1/invoices') return reply(202, { referenceNumber: 'INV-1' });
      if (method === 'GET' && path === '/sessions/SO-1/invoices/INV-1') return statuses.shift()!;
      if (method === 'POST' && path === '/sessions/online/SO-1/close') return reply(204);
      throw new Error(`nieoczekiwane żądanie ${method} ${path}`);
    });
  }
  const status = (code: number, extra: Record<string, unknown> = {}) =>
    reply(200, { referenceNumber: 'INV-1', invoiceHash: 'h', status: { code, description: `kod ${code}` }, ...extra });

  /** Odpytanie czeka 2 s między próbami — przewijamy zegar, aż wysyłka się rozstrzygnie. */
  async function drive<T>(run: Promise<T>): Promise<T> {
    let done = false;
    const settled = run.then(() => { done = true; }, () => { done = true; });
    while (!done) await vi.advanceTimersByTimeAsync(2000);
    await settled;
    return run;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  it('trzy próby odpytania: open, send, jeden wiersz odpytania, close', async () => {
    sendPath([status(150), status(150), status(200, { ksefNumber: '5260001246-20261002-0000000000AB-01', acquisitionTimestamp: '2026-10-02T10:00:00Z' })]);
    const result = await drive(submitInvoice('<Faktura/>', AUTH, 'test', { tenantId: TENANT, invoiceId: INVOICE }));
    expect(result.ksefNumber).toBe('5260001246-20261002-0000000000AB-01');
    await flushAudit();
    expect(actions()).toEqual(['ksef.session.open', 'ksef.invoice.send', 'ksef.invoice.poll', 'ksef.session.close']);
    const poll = rows()[2]!;
    expect(poll.entityId).toBe(INVOICE);
    expect(poll.metadata).toMatchObject({
      summary: true, sessionRef: 'SO-1', attempts: 3, outcome: 'accepted', statusCode: 200,
      ksefNumber: '5260001246-20261002-0000000000AB-01',
    });
    expect(poll.metadata.durationMs).toEqual(expect.any(Number));
  });

  it('odrzucenie w statusie: podsumowanie z wynikiem i kodem KSeF', async () => {
    sendPath([status(150), status(450)]);
    await expect(drive(submitInvoice('<Faktura/>', AUTH, 'test', { tenantId: TENANT, invoiceId: INVOICE })))
      .rejects.toMatchObject({ name: 'KsefInvoiceRejectedError', code: 450 });
    await flushAudit();
    expect(actions()).toEqual(['ksef.session.open', 'ksef.invoice.send', 'ksef.invoice.poll', 'ksef.session.close']);
    expect(rows()[2]!.metadata).toMatchObject({ summary: true, attempts: 2, outcome: 'rejected', statusCode: 450 });
  });

  it('błąd HTTP przy odpytaniu: wiersz błędu tej próby i podsumowanie', async () => {
    sendPath([status(150), reply(503, { exception: {} })]);
    await expect(drive(submitInvoice('<Faktura/>', AUTH, 'test', { tenantId: TENANT, invoiceId: INVOICE })))
      .rejects.toMatchObject({ status: 503 });
    await flushAudit();
    expect(actions()).toEqual([
      'ksef.session.open', 'ksef.invoice.send', 'ksef.invoice.poll', 'ksef.invoice.poll', 'ksef.session.close',
    ]);
    const [error, summary] = [rows()[2]!, rows()[3]!];
    expect(error.metadata).toMatchObject({ httpStatus: 503, attempt: 1 });
    expect(error.metadata.summary).toBeUndefined();
    expect(summary.metadata).toMatchObject({ summary: true, attempts: 2, outcome: 'request-error', statusCode: 150 });
  });
});

describe('odczyty, które rozstrzygają wysyłkę — wiersz przy każdym wywołaniu, jak dotąd', () => {
  it('uzgodnienie statusu po numerze referencyjnym', async () => {
    ksefHttp(() => reply(200, { referenceNumber: 'INV-1', status: { code: 150, description: 'W kolejce' } }));
    await checkInvoiceStatusByReference(
      { sessionReferenceNumber: 'SO-1', invoiceReferenceNumber: 'INV-1' }, AUTH, 'test', { tenantId: TENANT, invoiceId: INVOICE },
    );
    await flushAudit();
    expect(actions()).toEqual(['ksef.invoice.reconcile']);
  });

  it('lista faktur sesji po zamknięciu (pusta lista = plik nie dotarł, więc wysyłamy ponownie)', async () => {
    ksefHttp((method, path) => (method === 'POST' && path === '/sessions/online/SO-1/close'
      ? reply(204)
      : reply(200, { invoices: [] })));
    await listSessionInvoicesAfterClose('SO-1', AUTH, 'test', { tenantId: TENANT, invoiceId: INVOICE });
    await flushAudit();
    expect(actions()).toEqual(['ksef.session.close', 'ksef.session.invoices']);
  });
});
