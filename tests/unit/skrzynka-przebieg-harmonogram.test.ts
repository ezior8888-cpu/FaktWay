import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * Przebieg jednej firmy z harmonogramem (00160). Prawdziwe: runner, zapytanie
 * o metadane ze stronami, klient HTTP KSeF, zapis HWM, rachunek terminów.
 * Atrapy tylko dla HTTP (`fetch`) i bazy (w pamięci, z RPC jak 00160).
 *
 * Trzy rzeczy, które tu muszą się zgadzać:
 *   - termin następnego przebiegu zależy od poziomu i od rodzaju błędu,
 *   - po długiej przerwie przebieg nadrabia cały okres od HWM (okna 90 dni,
 *     strony), bez względu na to, jak rzadko firma jest odpytywana,
 *   - ponowienie od zera po każdym kroku nie dubluje faktur ani zdarzeń.
 */

type Row = Record<string, unknown>;

const NOW = new Date('2026-11-02T11:00:00Z');
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DATA = { tenantId: TENANT, nip: '1234567890', environment: 'test' as const };

const st = vi.hoisted(() => ({
  invoices: [] as Record<string, unknown>[],
  cursor: null as Record<string, unknown> | null,
  schedule: null as Record<string, unknown> | null,
  subscriptionActive: true,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  failRpc: new Set<string>(),
  ksefInvoices: [] as Array<Record<string, unknown>>,
  ksefHwm: '2026-11-02T10:59:00.000Z' as string | null,
  ksefStatus: 200,
  ksefHeaders: {} as Record<string, string>,
  ksefQueries: [] as Array<{ from: string; to: string; pageOffset: number }>,
  credentialsError: null as Error | null,
  sessionError: null as Error | null,
  failSteps: new Set<string>(),
  events: [] as Array<{ step: string; events: Array<Record<string, unknown>> }>,
  push: vi.fn(async () => ({ sent: 0, failed: 0 })),
  proposal: vi.fn(async () => undefined),
  sentry: vi.fn(),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: st.sentry, captureMessage: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', () => ({
  getTenantKsefCredentials: vi.fn(async () => {
    if (st.credentialsError) throw st.credentialsError;
    return { type: 'token', nip: '1234567890', token: 'fikcyjny' };
  }),
}));
vi.mock('@/lib/ksef/session-cache', () => ({
  ksefSessionCache: {
    getSession: vi.fn(async () => {
      if (st.sessionError) throw st.sessionError;
      return { accessToken: 'token-dostepu' };
    }),
    invalidate: vi.fn(),
  },
}));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: st.proposal }));
vi.mock('@/lib/flo/functions/expense-inbox', () => ({
  buildInboxSummaryProposal: () => ({ kind: 'expense.inbox' }),
  classifyInboxDocuments: (docs: unknown) => docs,
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToTenant: st.push }));

function fakeDb() {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      st.rpcCalls.push({ name, args });
      if (st.failRpc.delete(name)) return { data: null, error: { message: `fixture ${name}` } };
      if (name === 'ksef_inbox_poll_state') {
        return { data: st.schedule ? [{ ...st.schedule, subscription_active: st.subscriptionActive }] : [], error: null };
      }
      if (name === 'finish_ksef_inbox_poll') {
        st.schedule = {
          ...(st.schedule ?? {}),
          next_poll_at: args.p_next_poll_at,
          activity_tier: args.p_activity_tier,
          poll_lease_until: null,
          consecutive_errors: args.p_error_class ? Number(st.schedule?.consecutive_errors ?? 0) + 1 : 0,
          last_error_class: args.p_error_class ?? null,
          last_invoice_at: Number(args.p_new_invoices) > 0 ? NOW.toISOString() : st.schedule?.last_invoice_at ?? null,
        };
        return { data: args.p_next_poll_at, error: null };
      }
      return { data: null, error: { message: `nieznane RPC ${name}` } };
    },
    from: (table: string) => {
      let op: 'select' | 'insert' | 'upsert' = 'select';
      let rows: Row[] = [];
      let numbers: string[] | null = null;
      const q = {
        select: () => q,
        eq: () => q,
        not: () => q,
        limit: () => q,
        in: (column: string, list: string[]) => {
          if (column === 'ksef_number') numbers = list;
          return q;
        },
        insert: (r: Row[]) => { op = 'insert'; rows = r; return q; },
        upsert: (r: Row) => { op = 'upsert'; rows = [r]; return q; },
        maybeSingle: async () => ({ data: table === 'ksef_inbox_cursor' ? st.cursor : null, error: null }),
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
          let result: unknown = { data: [], error: null };
          if (op === 'upsert' && table === 'ksef_inbox_cursor') {
            st.cursor = rows[0]!;
            result = { error: null };
          } else if (op === 'insert') {
            const inserted: Row[] = rows.map((r) => ({ ...r, id: `id-${String(r.ksef_number)}` }));
            st.invoices.push(...inserted);
            result = { data: inserted.map((r) => ({ id: r.id, ksef_number: r.ksef_number })), error: null };
          } else if (numbers) {
            const list = numbers;
            result = { data: st.invoices.filter((r) => list.includes(r.ksef_number as string)), error: null };
          }
          return Promise.resolve(result).then(ok, fail);
        },
      };
      return q;
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => fakeDb() }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: async () => fakeDb() }));

import { runInboxPollTenant } from '@/lib/jobs/runners/inbox-polling';
import { KsefApiError } from '@/lib/ksef/client';
import { classifyInboxPollError } from '@/lib/ksef/inbox-poll-errors';
import { INBOX_CATCH_UP_INTERVAL_MS, nextInboxPollAfterSuccess } from '@/lib/ksef/inbox-schedule';

function context(): JobContext {
  return {
    attempt: 0,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    step: {
      run: async (name, fn) => {
        if (st.failSteps.delete(name)) throw new Error(`fixture ${name}`);
        return fn();
      },
      sleep: vi.fn(),
      sendEvent: async (name, events) => {
        if (st.failSteps.delete(name)) throw new Error(`fixture ${name}`);
        st.events.push({ step: name, events: (Array.isArray(events) ? events : [events]) as unknown as Array<Record<string, unknown>> });
      },
      scheduleAfter: vi.fn(),
    },
  };
}

function ksefInvoice(n: number, storedAt: string) {
  return {
    ksefNumber: `5260001246-20260101-${String(n).padStart(12, '0')}-00`,
    invoiceNumber: `FV ${n}/2026`,
    acquisitionDate: storedAt,
    permanentStorageDate: storedAt,
    issueDate: storedAt.slice(0, 10),
    invoiceType: 'Vat',
    seller: { nip: '5260001246', name: 'Dostawca' },
    buyer: { identifier: { type: 'Nip', value: '1234567890' } },
    currency: 'PLN',
    grossAmount: 123,
    netAmount: 100,
    vatAmount: 23,
  };
}

/** Atrapa KSeF po HTTP: filtruje po oknie, stronicuje jak OpenAPI, podaje HWM. */
const fakeFetch = vi.fn(async (url: string, init: { body?: string }) => {
  const headers = new Headers({ 'content-type': 'application/json', ...st.ksefHeaders });
  if (st.ksefStatus !== 200) {
    return new Response(JSON.stringify({ message: 'atrapa' }), { status: st.ksefStatus, headers });
  }
  const parsed = new URL(url);
  const body = JSON.parse(init.body ?? '{}') as { dateRange: { from: string; to: string } };
  const pageOffset = Number(parsed.searchParams.get('pageOffset') ?? 0);
  const pageSize = Number(parsed.searchParams.get('pageSize') ?? 250);
  st.ksefQueries.push({ from: body.dateRange.from, to: body.dateRange.to, pageOffset });
  const inWindow = st.ksefInvoices.filter((inv) => {
    const at = Date.parse(inv.permanentStorageDate as string);
    return at >= Date.parse(body.dateRange.from) && at <= Date.parse(body.dateRange.to);
  });
  const page = inWindow.slice(pageOffset * pageSize, (pageOffset + 1) * pageSize);
  return new Response(JSON.stringify({
    invoices: page,
    hasMore: (pageOffset + 1) * pageSize < inWindow.length,
    isTruncated: false,
    permanentStorageHwmDate: st.ksefHwm,
  }), { status: 200, headers });
});

function finishCalls() {
  return st.rpcCalls.filter((c) => c.name === 'finish_ksef_inbox_poll').map((c) => c.args);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('KSEF_ENV', 'test');
  vi.stubGlobal('fetch', fakeFetch);
  fakeFetch.mockClear();
  st.invoices = [];
  st.cursor = { window_to: '2026-11-02T10:45:00.000Z' };
  st.schedule = {
    next_poll_at: '2026-11-02T10:59:00.000Z',
    poll_lease_until: '2026-11-02T11:25:00.000Z',
    consecutive_errors: 0,
    last_invoice_at: null,
    last_activity_at: '2026-11-02T10:00:00.000Z',
  };
  st.subscriptionActive = true;
  st.rpcCalls = [];
  st.failRpc = new Set();
  st.ksefInvoices = [];
  st.ksefHwm = '2026-11-02T10:59:00.000Z';
  st.ksefStatus = 200;
  st.ksefHeaders = {};
  st.ksefQueries = [];
  st.credentialsError = null;
  st.sessionError = null;
  st.failSteps = new Set();
  st.events = [];
  st.push.mockClear();
  st.proposal.mockClear();
  st.sentry.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('przebieg firmy: termin po sukcesie', () => {
  it('firma gorąca: następny termin w jej miejscu cyklu 15 minut, dzierżawa w dół, błędy na zero', async () => {
    const result = await runInboxPollTenant(DATA, context());
    expect(result).toEqual({ fetched: 0, newlyAdded: 0 });
    const [finish] = finishCalls();
    expect(finish).toMatchObject({
      p_tenant_id: TENANT,
      p_activity_tier: 'hot',
      p_new_invoices: 0,
      p_error_class: null,
      p_next_poll_at: nextInboxPollAfterSuccess({ tenantId: TENANT, tier: 'hot', now: NOW }).toISOString(),
      p_started_at: NOW.toISOString(),
    });
  });

  it('poziom liczony z danych: brak aktywności od 40 dni i brak faktur = zimna', async () => {
    st.schedule!.last_activity_at = '2026-09-20T10:00:00.000Z';
    await runInboxPollTenant(DATA, context());
    expect(finishCalls()[0]).toMatchObject({
      p_activity_tier: 'cold',
      p_next_poll_at: nextInboxPollAfterSuccess({ tenantId: TENANT, tier: 'cold', now: NOW }).toISOString(),
    });
  });

  it('brak subskrypcji i brak ruchu = uśpiona, nawet przy nowej fakturze', async () => {
    st.subscriptionActive = false;
    st.schedule!.last_activity_at = '2026-09-20T10:00:00.000Z';
    st.ksefInvoices = [ksefInvoice(1, '2026-11-02T10:50:00.000Z')];
    await runInboxPollTenant(DATA, context());
    expect(finishCalls()[0]).toMatchObject({ p_activity_tier: 'dormant', p_new_invoices: 1 });
  });

  it('brak subskrypcji, ale ktoś pracuje w aplikacji = gorąca', async () => {
    st.subscriptionActive = false;
    await runInboxPollTenant(DATA, context());
    expect(finishCalls()[0]).toMatchObject({ p_activity_tier: 'hot' });
  });

  it('nowa faktura robi firmę gorącą w tym samym przebiegu', async () => {
    st.schedule!.last_activity_at = '2026-09-20T10:00:00.000Z';
    st.ksefInvoices = [ksefInvoice(1, '2026-11-02T10:50:00.000Z')];
    const result = await runInboxPollTenant(DATA, context());
    expect(result).toEqual({ fetched: 1, newlyAdded: 1 });
    expect(finishCalls()[0]).toMatchObject({ p_activity_tier: 'hot', p_new_invoices: 1 });
  });

  it('firma bez wiersza harmonogramu (zlecenie sprzed wdrożenia): przebieg idzie, wiersz powstaje', async () => {
    st.schedule = null;
    await expect(runInboxPollTenant(DATA, context())).resolves.toEqual({ fetched: 0, newlyAdded: 0 });
    expect(st.ksefQueries).toHaveLength(1);
    expect(finishCalls()).toHaveLength(1);
  });
});

describe('zadanie zbędne (drugie zadanie tej samej firmy)', () => {
  it('kończy się jednym odczytem harmonogramu, bez KSeF i bez zapisu', async () => {
    st.schedule = {
      next_poll_at: '2026-11-02T11:15:00.000Z',
      poll_lease_until: null,
      consecutive_errors: 0,
      last_invoice_at: null,
      last_activity_at: null,
    };
    const result = await runInboxPollTenant(DATA, context());
    expect(result).toMatchObject({ fetched: 0, newlyAdded: 0, skipped: 'not-due' });
    expect(fakeFetch).not.toHaveBeenCalled();
    expect(st.rpcCalls.map((c) => c.name)).toEqual(['ksef_inbox_poll_state']);
    expect(st.cursor).toEqual({ window_to: '2026-11-02T10:45:00.000Z' });
  });
});

describe('przebieg firmy: termin po błędzie', () => {
  it('zły certyfikat: klasa credentials, odstęp co najmniej godzina, job nie pada', async () => {
    st.sessionError = new KsefApiError(401, 'nie', 'KSeF API POST /auth/xades-signature failed: 401');
    const result = await runInboxPollTenant(DATA, context());
    expect(result).toMatchObject({ fetched: 0, newlyAdded: 0, failed: 'credentials' });
    const [finish] = finishCalls();
    expect(finish).toMatchObject({ p_error_class: 'credentials', p_new_invoices: 0 });
    expect(Date.parse(finish!.p_next_poll_at as string) - NOW.getTime()).toBeGreaterThanOrEqual(3_600_000);
    expect(st.sentry).not.toHaveBeenCalled();
  });

  it('kolejne błędy certyfikatu oddalają termin aż do doby', async () => {
    const delays: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      st.sessionError = new Error('KSeF auth failed: certyfikat odwołany');
      st.schedule!.poll_lease_until = '2026-11-02T11:25:00.000Z';
      await runInboxPollTenant(DATA, context());
      delays.push(Date.parse(finishCalls().at(-1)!.p_next_poll_at as string) - NOW.getTime());
    }
    for (let i = 1; i < 6; i += 1) expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    expect(delays.at(-1)).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it('brak poświadczeń i odszyfrowanie: klasa credentials; awaria odczytu bazy: other', async () => {
    const cred = Object.assign(new Error('brak'), { name: 'KsefCredentialsError', reason: 'decrypt' });
    st.credentialsError = cred;
    await runInboxPollTenant(DATA, context());
    expect(finishCalls().at(-1)).toMatchObject({ p_error_class: 'credentials' });

    st.schedule!.poll_lease_until = '2026-11-02T11:25:00.000Z';
    st.credentialsError = Object.assign(new Error('baza'), { name: 'KsefCredentialsError', reason: 'tenant-read' });
    await expect(runInboxPollTenant(DATA, context())).rejects.toThrow('baza');
    expect(finishCalls().at(-1)).toMatchObject({ p_error_class: 'other' });
  });

  it('KSeF 503: klasa ksef, krótki odstęp, job nie pada, HWM stoi', async () => {
    st.ksefStatus = 503;
    const result = await runInboxPollTenant(DATA, context());
    expect(result).toMatchObject({ failed: 'ksef' });
    const [finish] = finishCalls();
    expect(finish).toMatchObject({ p_error_class: 'ksef' });
    expect(Date.parse(finish!.p_next_poll_at as string) - NOW.getTime()).toBeLessThan(10 * 60_000);
    expect(st.cursor).toEqual({ window_to: '2026-11-02T10:45:00.000Z' });
  });

  it('KSeF 429: czekamy tyle, ile każe Retry-After', async () => {
    st.ksefStatus = 429;
    st.ksefHeaders = { 'retry-after': '1800' };
    const result = await runInboxPollTenant(DATA, context());
    expect(result).toMatchObject({ failed: 'rate_limit' });
    const [finish] = finishCalls();
    expect(finish).toMatchObject({ p_error_class: 'rate_limit' });
    expect(Date.parse(finish!.p_next_poll_at as string) - NOW.getTime()).toBeGreaterThanOrEqual(1_800_000);
  });

  it('401 z zapytania: jedna próba od czystej sesji, bo refresh token żyje długo, a sesję można unieważnić', async () => {
    const { ksefSessionCache } = await import('@/lib/ksef/session-cache');
    fakeFetch.mockImplementationOnce(async () => new Response(JSON.stringify({ message: 'atrapa' }), {
      status: 401, headers: { 'content-type': 'application/json' },
    }));
    await expect(runInboxPollTenant(DATA, context())).resolves.toEqual({ fetched: 0, newlyAdded: 0 });
    expect(ksefSessionCache.invalidate).toHaveBeenCalledWith('1234567890', 'test');
    expect(finishCalls()[0]).toMatchObject({ p_error_class: null });
    expect(st.ksefQueries).toHaveLength(1);
  });

  it('401 po czystej sesji: klasa credentials, bez trzeciej próby', async () => {
    st.ksefStatus = 401;
    await expect(runInboxPollTenant(DATA, context())).resolves.toMatchObject({ failed: 'credentials' });
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('KSeF nie podał HWM: bez przesunięcia okna i bez udawania sukcesu', async () => {
    st.ksefHwm = null;
    await runInboxPollTenant(DATA, context());
    expect(finishCalls()[0]).toMatchObject({ p_error_class: 'ksef' });
    expect(st.cursor).toEqual({ window_to: '2026-11-02T10:45:00.000Z' });
  });

  it('błąd nieoczekiwany: klasa other, job pada (Sentry i dziennik przebiegów), termin krótki', async () => {
    st.failSteps = new Set(['filter-existing']);
    st.ksefInvoices = [ksefInvoice(1, '2026-11-02T10:50:00.000Z')];
    await expect(runInboxPollTenant(DATA, context())).rejects.toThrow('fixture filter-existing');
    expect(finishCalls()[0]).toMatchObject({ p_error_class: 'other' });
  });

  it('harmonogram nie zatrzymuje pobierania: awaria odczytu i zapisu stanu nie gubi przebiegu', async () => {
    st.failRpc = new Set(['ksef_inbox_poll_state', 'finish_ksef_inbox_poll']);
    st.ksefInvoices = [ksefInvoice(1, '2026-11-02T10:50:00.000Z')];
    const ctx = context();
    await expect(runInboxPollTenant(DATA, ctx)).resolves.toEqual({ fetched: 1, newlyAdded: 1 });
    expect(st.invoices).toHaveLength(1);
    expect(ctx.logger.error).toHaveBeenCalled();
    expect(st.sentry).toHaveBeenCalled();
  });
});

describe('klasy błędów', () => {
  const err = (status: number, path: string, retryAfter: number | null = null) =>
    new KsefApiError(status, 'atrapa', `KSeF API POST ${path} failed: ${status}`, retryAfter);

  it.each<[string, unknown, string]>([
    ['503 z zapytania', err(503, '/invoices/query/metadata'), 'ksef'],
    ['408 (nasz timeout)', err(408, '/invoices/query/metadata'), 'ksef'],
    ['429', err(429, '/invoices/query/metadata', 60_000), 'rate_limit'],
    ['401 z logowania', err(401, '/auth/xades-signature'), 'credentials'],
    ['403 z zapytania (brak uprawnienia)', err(403, '/invoices/query/metadata'), 'credentials'],
    ['400 z logowania (KSeF odrzuca podpis)', err(400, '/auth/xades-signature'), 'credentials'],
    ['400 z zapytania (nasze zapytanie jest złe)', err(400, '/invoices/query/metadata'), 'other'],
    ['status logowania ≥ 400', new Error('KSeF auth failed: certyfikat odwołany'), 'credentials'],
    ['logowanie bez odpowiedzi', new Error('KSeF auth polling timed out after 20 attempts'), 'ksef'],
    ['błąd sieci', Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }), 'ksef'],
    ['brak certyfikatu', Object.assign(new Error('x'), { name: 'KsefCredentialsError', reason: 'missing' }), 'credentials'],
    ['odczyt bazy', Object.assign(new Error('x'), { name: 'KsefCredentialsError', reason: 'tenant-read' }), 'other'],
    ['nasz błąd', new Error('coś innego'), 'other'],
  ])('%s', (_name, error, expected) => {
    expect(classifyInboxPollError(error).errorClass).toBe(expected);
  });

  it('429 niesie Retry-After, a szczegół nie ma treści odpowiedzi', () => {
    const failure = classifyInboxPollError(err(429, '/invoices/query/metadata', 60_000));
    expect(failure.retryAfterMs).toBe(60_000);
    expect(failure.detail).toContain('HTTP 429');
    expect(failure.detail).not.toContain('atrapa');
  });
});

describe('przebieg po długiej przerwie', () => {
  const DAY = 86_400_000;

  it('firma uśpiona po dobie: okno od HWM, nic nie ginie', async () => {
    st.cursor = { window_to: '2026-11-01T11:00:00.000Z' };
    st.schedule!.last_activity_at = null;
    st.subscriptionActive = false;
    st.ksefInvoices = [
      ksefInvoice(1, '2026-11-01T12:00:00.000Z'),
      ksefInvoice(2, '2026-11-01T23:30:00.000Z'),
      ksefInvoice(3, '2026-11-02T10:58:00.000Z'),
    ];
    await expect(runInboxPollTenant(DATA, context())).resolves.toEqual({ fetched: 3, newlyAdded: 3 });
    expect(st.ksefQueries[0]).toMatchObject({ from: '2026-11-01T11:00:00.000Z', to: NOW.toISOString() });
    expect(st.cursor!.window_to).toBe('2026-11-02T10:59:00.000Z');
  });

  // E1-W10-b: dawniej 600 faktur równo przez 200 dni, trzy przebiegi (okna
  // 90 + 90 + 20 dni) i kilka stron w jednym przebiegu. Teraz przebieg pyta
  // o jedną stronę (`INBOX_METADATA_REQUESTS_PER_RUN`), więc dane mają oba
  // powody nadrabiania naraz: rzadkie faktury (okno 90 dni bez budżetu) i gęste
  // (budżet przed końcem okna). Stąd cztery przebiegi zamiast trzech.
  it('przerwa 200 dni: okna do 90 dni i przebiegi po jednej stronie co 5 minut, bez dziur, potem zwykły rytm', async () => {
    const start = NOW.getTime() - 200 * DAY;
    st.cursor = { window_to: new Date(start).toISOString() };
    // 100 faktur w pierwszych 90 dniach (jedna strona), 500 w kolejnych 110
    // (dwa przebiegi kończą się na budżecie).
    const sparse = Array.from({ length: 100 }, (_, i) =>
      ksefInvoice(i, new Date(start + (i + 1) * (90 * DAY / 101)).toISOString()));
    const dense = Array.from({ length: 500 }, (_, i) =>
      ksefInvoice(100 + i, new Date(start + 90 * DAY + (i + 1) * (110 * DAY / 501)).toISOString()));
    st.ksefInvoices = [...sparse, ...dense];
    const saved = () => new Set(st.invoices.map((r) => r.ksef_number));

    const passes: Array<{ from: string; next: number }> = [];
    let now = NOW.getTime();
    for (let pass = 0; pass < 10; pass += 1) {
      vi.setSystemTime(now);
      st.ksefHwm = new Date(now - 60_000).toISOString();
      st.schedule!.poll_lease_until = new Date(now + 60_000).toISOString();
      st.schedule!.next_poll_at = new Date(now - 1000).toISOString();
      const from = st.cursor!.window_to as string;
      await runInboxPollTenant(DATA, context());
      const next = Date.parse(finishCalls().at(-1)!.p_next_poll_at as string);
      passes.push({ from, next: next - now });
      // Po każdym przebiegu: nic poniżej zapisanego HWM nie przepadło.
      const hwm = Date.parse(st.cursor!.window_to as string);
      expect(st.ksefInvoices.filter((inv) =>
        Date.parse(inv.permanentStorageDate as string) < hwm && !saved().has(inv.ksefNumber))).toEqual([]);
      if (hwm >= now - 120_000) break;
      now = next;
    }

    // Okno 90 dni z rzadkimi fakturami, dwa przebiegi na budżecie w gęstych,
    // ostatni dochodzi do HWM KSeF. Trzy pierwsze nadrabiają od razu.
    expect(passes).toHaveLength(4);
    expect(passes.slice(0, 3).map((p) => p.next)).toEqual(Array.from({ length: 3 }, () => INBOX_CATCH_UP_INTERVAL_MS));
    expect(passes[3]!.next).toBeGreaterThan(INBOX_CATCH_UP_INTERVAL_MS);
    // Okna przylegają: całe okno = jego koniec, budżet = data ostatniej pobranej faktury.
    expect(Date.parse(passes[1]!.from) - Date.parse(passes[0]!.from)).toBe(90 * DAY);
    expect(passes[2]!.from).toBe(dense[249]!.permanentStorageDate);
    expect(passes[3]!.from).toBe(dense[498]!.permanentStorageDate);
    // Jedno zapytanie na przebieg, każde w limicie 90 dni.
    expect(st.ksefQueries).toHaveLength(passes.length);
    for (const q of st.ksefQueries) {
      expect(Date.parse(q.to) - Date.parse(q.from)).toBeLessThanOrEqual(90 * DAY);
    }
    // Każda faktura dokładnie raz.
    expect(saved().size).toBe(600);
    expect(st.invoices).toHaveLength(600);
  });
});

describe('ponowienie od zera po każdym kroku', () => {
  const invoices = () => [
    ksefInvoice(1, '2026-11-02T10:50:00.000Z'),
    ksefInvoice(2, '2026-11-02T10:51:00.000Z'),
  ];
  const categorized = () => st.events
    .filter((e) => e.step === 'fan-out-auto-categorize-inbox')
    .flatMap((e) => e.events.map((ev) => (ev.data as Row).invoiceId));

  /** Pierwszy przebieg pada na kroku, drugi (pg-boss zaczyna od zera) kończy pracę. */
  async function failThenRetry(step: string, opts: { rethrows: boolean }) {
    st.ksefInvoices = invoices();
    st.failSteps = new Set([step]);
    if (opts.rethrows) {
      await expect(runInboxPollTenant(DATA, context())).rejects.toThrow(`fixture ${step}`);
    } else {
      await runInboxPollTenant(DATA, context());
    }
    st.schedule!.poll_lease_until = '2026-11-02T11:25:00.000Z';
    st.schedule!.next_poll_at = NOW.toISOString();
    return runInboxPollTenant(DATA, context());
  }

  it.each(['inbox-window', 'query-ksef', 'filter-existing', 'save-received-invoices'])(
    'po „%s”: przed zapisem nic się nie stało, drugi przebieg robi wszystko raz',
    async (step) => {
      await failThenRetry(step, { rethrows: true });
      expect(st.invoices).toHaveLength(2);
      expect(categorized()).toEqual(['id-5260001246-20260101-000000000001-00', 'id-5260001246-20260101-000000000002-00']);
      expect(st.cursor!.window_to).toBe('2026-11-02T10:59:00.000Z');
      expect(st.push).toHaveBeenCalledOnce();
    },
  );

  it('po „fan-out-auto-categorize-inbox”: faktury są, HWM stoi, drugi przebieg nie dubluje (zdarzenia dośle cron uzupełniający)', async () => {
    await failThenRetry('fan-out-auto-categorize-inbox', { rethrows: true });
    expect(st.invoices).toHaveLength(2);
    expect(categorized()).toEqual([]);
    expect(st.cursor!.window_to).toBe('2026-11-02T10:59:00.000Z');
  });

  it('po „advance-hwm”: faktury i zdarzenia raz, drugi przebieg tylko przesuwa HWM', async () => {
    await failThenRetry('advance-hwm', { rethrows: true });
    expect(st.invoices).toHaveLength(2);
    expect(categorized()).toHaveLength(2);
    expect(st.push).toHaveBeenCalledOnce();
    expect(st.cursor!.window_to).toBe('2026-11-02T10:59:00.000Z');
  });

  it('po zapisie terminu (finish): faktury raz, a brak zapisu tylko wydłuża czekanie do końca dzierżawy', async () => {
    st.ksefInvoices = invoices();
    st.failRpc = new Set(['finish_ksef_inbox_poll']);
    const scheduleBefore = { ...st.schedule };
    await runInboxPollTenant(DATA, context());
    expect(st.schedule).toEqual(scheduleBefore);
    expect(st.invoices).toHaveLength(2);
    await runInboxPollTenant(DATA, context());
    expect(st.invoices).toHaveLength(2);
    expect(categorized()).toHaveLength(2);
    expect(st.schedule!.poll_lease_until).toBeNull();
  });
});
