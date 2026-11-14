import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * E1-W10-b (plan „zero zgubionych faktur”, sekcja 8): okno skrzynki ponad
 * 16 stron (np. 4000 faktur po przerwie w certyfikacie) nie mieści się w limicie
 * MF dla `/invoices/query/metadata`: 16 zapytań na minutę i 20 na godzinę na
 * parę (NIP, adres IP). Przebieg szedł od HWM do końca okna bez tempa i bez
 * zapisu postępu, więc 429 w środku wyrzucał całą pracę, HWM stał, a następny
 * przebieg zaczynał od początku: pętla 429, nowe faktury stoją.
 *
 * Prawdziwe: runner, zapytanie o metadane ze stronami, klient HTTP KSeF z pauzą
 * firmy po 429 (L1a), zapis HWM, rachunek terminów. Atrapy: HTTP (KSeF
 * z limitami MF), baza w pamięci (RPC jak 00160), sesja i poświadczenia KSeF,
 * karta FLO, push.
 *
 * Oczekiwane: przebieg mieści się w budżecie zapytań, HWM idzie do przodu
 * częściowo (data ostatniej pobranej faktury), następny przebieg zaczyna
 * dokładnie tam, każda faktura jest w bazie raz, a MF nie odpowiada 429.
 */

type Row = Record<string, unknown>;

const NOW = Date.parse('2026-11-02T11:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DATA = { tenantId: TENANT, nip: '1234567890', environment: 'test' as const };
/** HWM sprzed przerwy: 13 dni zaległości, czyli jedno okno API (do 90 dni). */
const START_HWM = '2026-10-20T08:00:00.000Z';
/** Limity MF dla `/invoices/query/metadata` na parę (NIP, adres IP). */
const MF_PER_MINUTE = 16;
const MF_PER_HOUR = 20;

const st = vi.hoisted(() => ({
  invoices: [] as Record<string, unknown>[],
  audit: [] as Record<string, unknown>[],
  cursor: null as Record<string, unknown> | null,
  schedule: null as Record<string, unknown> | null,
  ksefInvoices: [] as Array<Record<string, unknown>>,
  ksefHwm: null as string | null,
  /** Zapytania przyjęte przez MF. */
  queries: [] as Array<{ at: number; from: string; to: string; pageOffset: number }>,
  /** Chwile, w których MF odpowiedział 429. */
  limited: [] as number[],
  /** Tyle następnych zapytań dostanie 429, jakby limit zużył ktoś inny. */
  forced429: 0,
  failSteps: new Set<string>(),
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', () => ({
  getTenantKsefCredentials: vi.fn(async () => ({ type: 'token', nip: '1234567890', token: 'fikcyjny' })),
}));
vi.mock('@/lib/ksef/session-cache', () => ({
  ksefSessionCache: {
    getSession: vi.fn(async () => ({ accessToken: 'token-dostepu' })),
    invalidate: vi.fn(),
  },
}));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: vi.fn(async () => undefined) }));
vi.mock('@/lib/flo/functions/expense-inbox', () => ({
  buildInboxSummaryProposal: () => null,
  classifyInboxDocuments: (docs: unknown) => docs,
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToTenant: vi.fn(async () => ({ sent: 0, failed: 0 })) }));

/** Baza w pamięci: faktury, kursor skrzynki, harmonogram (RPC jak 00160), audyt. */
function fakeDb() {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'ksef_inbox_poll_state') {
        return { data: st.schedule ? [{ ...st.schedule, subscription_active: true }] : [], error: null };
      }
      if (name === 'finish_ksef_inbox_poll') {
        st.schedule = {
          ...(st.schedule ?? {}),
          next_poll_at: args.p_next_poll_at,
          activity_tier: args.p_activity_tier,
          poll_lease_until: null,
          consecutive_errors: args.p_error_class ? Number(st.schedule?.consecutive_errors ?? 0) + 1 : 0,
          last_error_class: args.p_error_class ?? null,
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
        gt: () => q,
        order: () => q,
        limit: () => q,
        in: (column: string, list: string[]) => {
          if (column === 'ksef_number') numbers = list;
          return q;
        },
        insert: (r: Row | Row[]) => { op = 'insert'; rows = Array.isArray(r) ? r : [r]; return q; },
        upsert: (r: Row) => { op = 'upsert'; rows = [r]; return q; },
        maybeSingle: async () => ({ data: table === 'ksef_inbox_cursor' ? st.cursor : null, error: null }),
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
          let result: unknown = { data: [], error: null };
          if (op === 'upsert' && table === 'ksef_inbox_cursor') {
            st.cursor = rows[0]!;
            result = { error: null };
          } else if (op === 'insert' && table === 'invoices') {
            const inserted: Row[] = rows.map((r) => ({ ...r, id: `id-${String(r.ksef_number)}` }));
            st.invoices.push(...inserted);
            result = { data: inserted.map((r) => ({ id: r.id, ksef_number: r.ksef_number })), error: null };
          } else if (op === 'insert') {
            st.audit.push(...rows);
            result = { error: null };
          } else if (numbers && table === 'invoices') {
            const wanted = new Set(numbers);
            result = { data: st.invoices.filter((r) => wanted.has(r.ksef_number as string)), error: null };
          }
          return Promise.resolve(result).then(ok, fail);
        },
      };
      return q;
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => fakeDb() }));
// Bez `async`: `lib/audit/log-system.ts` woła go bez `await`, runner z `await`.
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => fakeDb() }));

import { runInboxPollTenant } from '@/lib/jobs/runners/inbox-polling';
import { INBOX_CATCH_UP_INTERVAL_MS } from '@/lib/ksef/inbox-schedule';

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
      sendEvent: async () => undefined,
      scheduleAfter: vi.fn(),
    },
  };
}

/**
 * Chwila w mikrosekundach. KSeF podaje daty z ułamkiem do 6 cyfr, a `Date.parse`
 * ucina do milisekund. Atrapa porównuje jak KSeF, więc punkt wznowienia
 * zaokrąglony w górę gubi fakturę także tutaj.
 */
function micros(iso: string): number {
  const m = /^(.+T\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/.exec(iso);
  if (!m) throw new Error(`atrapa: nieznany zapis daty ${iso}`);
  return Date.parse(`${m[1]}${m[3]}`) * 1000 + Number((m[2] ?? '').padEnd(6, '0'));
}

/** Data obcięta do milisekund (zapis ISO). */
function msFloor(iso: unknown): string {
  return new Date(Date.parse(String(iso))).toISOString();
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

/**
 * `count` faktur w grupach po `perGroup` z tą samą chwilą zapisu (z mikrosekundami:
 * `.456789`), grupy co `gapMs`. Granica strony wypada w środku grupy, więc
 * wznowienie od daty ostatniej faktury musi wziąć resztę grupy.
 */
function invoicesFrom(startMs: number, count: number, perGroup: number, gapMs: number, firstNumber = 0) {
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(startMs + Math.floor(i / perGroup) * gapMs).toISOString().replace('Z', '789Z');
    return ksefInvoice(firstNumber + i, at);
  });
}

/**
 * Atrapa KSeF po HTTP. Limity MF liczone w oknach przesuwnych; ponad limit 429
 * z `Retry-After` do zwolnienia miejsca. Faktury z okna po dacie trwałego zapisu
 * (`from` i `to` włącznie, `to` nie dalej niż HWM), strony jak w OpenAPI.
 */
const fakeFetch = vi.fn(async (url: string, init: { body?: string }) => {
  const now = Date.now();
  const json = { 'content-type': 'application/json' };
  const minute = st.queries.filter((q) => q.at > now - MINUTE);
  const hour = st.queries.filter((q) => q.at > now - HOUR);
  if (st.forced429 > 0 || minute.length >= MF_PER_MINUTE || hour.length >= MF_PER_HOUR) {
    const forced = st.forced429 > 0;
    if (forced) st.forced429 -= 1;
    st.limited.push(now);
    const freeAt = forced
      ? now + MINUTE
      : Math.max(
          minute.length >= MF_PER_MINUTE ? minute[0]!.at + MINUTE : 0,
          hour.length >= MF_PER_HOUR ? hour[0]!.at + HOUR : 0,
        );
    return new Response(JSON.stringify({ message: 'atrapa: limit' }), {
      status: 429,
      headers: { ...json, 'retry-after': String(Math.max(1, Math.ceil((freeAt - now) / 1000))) },
    });
  }
  const parsed = new URL(url);
  const body = JSON.parse(init.body ?? '{}') as { dateRange: { from: string; to: string } };
  const pageOffset = Number(parsed.searchParams.get('pageOffset') ?? 0);
  const pageSize = Number(parsed.searchParams.get('pageSize') ?? 250);
  st.queries.push({ at: now, from: body.dateRange.from, to: body.dateRange.to, pageOffset });
  const from = micros(body.dateRange.from);
  const to = Math.min(micros(body.dateRange.to), st.ksefHwm ? micros(st.ksefHwm) : Infinity);
  const inWindow = st.ksefInvoices.filter((inv) => {
    const at = micros(inv.permanentStorageDate as string);
    return at >= from && at <= to;
  });
  const page = inWindow.slice(pageOffset * pageSize, (pageOffset + 1) * pageSize);
  return new Response(JSON.stringify({
    invoices: page,
    hasMore: (pageOffset + 1) * pageSize < inWindow.length,
    isTruncated: false,
    permanentStorageHwmDate: st.ksefHwm,
  }), { status: 200, headers: json });
});

interface RunRecord {
  at: number;
  /** HWM przed przebiegiem (początek okna). */
  from: string;
  /** HWM po przebiegu. */
  cursor: string;
  /** Zapytania przyjęte przez MF w tym przebiegu. */
  requests: number;
  /** Następny przebieg po tylu ms od startu tego. */
  nextInMs: number;
  result: unknown;
}

/**
 * Kolejne przebiegi w terminach z harmonogramu (termin zapisany przez przebieg),
 * aż HWM dojdzie do HWM KSeF. HWM KSeF idzie z czasem: minuta przed „teraz”.
 */
async function runUntilCaughtUp(maxRuns: number, beforeRun?: (index: number) => void): Promise<RunRecord[]> {
  const runs: RunRecord[] = [];
  let now = NOW;
  for (let i = 0; i < maxRuns; i += 1) {
    vi.setSystemTime(now);
    st.ksefHwm = new Date(now - MINUTE).toISOString();
    st.schedule = {
      ...st.schedule!,
      next_poll_at: new Date(now - 1000).toISOString(),
      poll_lease_until: new Date(now + 30 * MINUTE).toISOString(),
    };
    beforeRun?.(i);
    const from = st.cursor!.window_to as string;
    const before = st.queries.length;
    const result = await runInboxPollTenant(DATA, context())
      .catch((e: unknown) => ({ thrown: e instanceof Error ? e.message : String(e) }));
    const next = Date.parse(st.schedule.next_poll_at as string);
    runs.push({
      at: now,
      from,
      cursor: st.cursor!.window_to as string,
      requests: st.queries.length - before,
      nextInMs: next - now,
      result,
    });
    if (st.cursor!.window_to === st.ksefHwm) break;
    now = next;
  }
  return runs;
}

/** Najwięcej zapytań w dowolnym oknie przesuwnym długości `windowMs`. */
function maxInWindow(times: number[], windowMs: number): number {
  return Math.max(0, ...times.map((t) => times.filter((u) => u > t - windowMs && u <= t).length));
}

function savedOnce(expected: number) {
  expect(st.invoices).toHaveLength(expected);
  expect(new Set(st.invoices.map((r) => r.ksef_number)).size).toBe(expected);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('KSEF_ENV', 'test');
  vi.stubGlobal('fetch', fakeFetch);
  fakeFetch.mockClear();
  st.invoices = [];
  st.audit = [];
  st.cursor = { window_to: START_HWM };
  st.schedule = {
    next_poll_at: new Date(NOW - 1000).toISOString(),
    poll_lease_until: null,
    consecutive_errors: 0,
    last_invoice_at: null,
    last_activity_at: new Date(NOW - HOUR).toISOString(),
  };
  st.ksefInvoices = [];
  st.ksefHwm = null;
  st.queries = [];
  st.limited = [];
  st.forced429 = 0;
  st.failSteps = new Set();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('E1-W10-b: okno skrzynki ponad 16 stron', () => {
  it('przebieg w budżecie, HWM częściowy, następny przebieg od tego miejsca: bez luki, bez dubli, bez 429', async () => {
    // 4321 faktur = 18 stron po 250: jeden przebieg „do końca okna” nie zmieści się
    // ani w 16 zapytaniach na minutę, ani w 20 na godzinę.
    const TOTAL = 4321;
    st.ksefInvoices = invoicesFrom(Date.parse(START_HWM) + 60_456, TOTAL, 7, 30 * MINUTE);

    const runs = await runUntilCaughtUp(40);

    // Każda faktura dokładnie raz, mimo granic stron w środku grup z tą samą datą.
    savedOnce(TOTAL);
    // MF ani razu nie odpowiedział 429; w żadnej godzinie nie poszło więcej niż
    // 12 zapytań (przebiegi co 5 minut), przy limicie 20.
    expect(st.limited).toEqual([]);
    expect(maxInWindow(st.queries.map((q) => q.at), HOUR)).toBeLessThanOrEqual(12);
    // Budżet: jedno zapytanie (jedna strona) na przebieg, więc nadrabianie idzie
    // w wielu przebiegach.
    expect(runs.map((r) => r.requests)).toEqual(runs.map(() => 1));
    expect(runs.length).toBeGreaterThan(16);
    // HWM częściowy = data ostatniej faktury z odpowiedzi (do milisekundy, w dół).
    expect(runs[0]!.from).toBe(START_HWM);
    expect(runs[0]!.cursor).toBe(msFloor(st.ksefInvoices[249]!.permanentStorageDate));
    // Ciągłość: każdy przebieg zaczyna od HWM zapisanego przez poprzedni, a HWM rośnie.
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i]!.from).toBe(runs[i - 1]!.cursor);
      expect(Date.parse(runs[i]!.cursor)).toBeGreaterThan(Date.parse(runs[i - 1]!.cursor));
    }
    // Przebieg częściowy: następny za 5 minut; po nadrobieniu zwykły rytm firmy.
    for (const run of runs.slice(0, -1)) expect(run.nextInMs).toBe(INBOX_CATCH_UP_INTERVAL_MS);
    expect(runs.at(-1)!.nextInMs).toBeGreaterThan(INBOX_CATCH_UP_INTERVAL_MS);
    // Koniec: HWM z KSeF z ostatniego przebiegu.
    expect(st.cursor!.window_to).toBe(st.ksefHwm);
    // Wiersz podsumowania w audycie mówi, gdzie przebieg częściowy skończył.
    const summaries = st.audit
      .filter((r) => r.action === 'ksef.inbox.poll' && (r.metadata as Row).summary === true)
      .map((r) => (r.metadata as Row).resumeFrom);
    expect(summaries).toEqual([...runs.slice(0, -1).map((r) => r.cursor), null]);
  });

  it('cała strona z datą początku okna (do milisekundy): przebieg bierze następną stronę, aż HWM ruszy', async () => {
    // 300 faktur zapisanych w tej samej milisekundzie co HWM: z jednej strony nie
    // da się wyznaczyć punktu wznowienia za HWM. Przebieg z budżetem 1 stałby
    // w miejscu na zawsze, więc pyta dalej, ale tylko do pierwszego postępu.
    st.ksefInvoices = [
      ...Array.from({ length: 300 }, (_, i) => ksefInvoice(i, START_HWM.replace('Z', '500Z'))),
      ...invoicesFrom(Date.parse(START_HWM) + 60_456, 500, 7, 30 * MINUTE, 300),
    ];

    const runs = await runUntilCaughtUp(20);

    savedOnce(800);
    expect(st.limited).toEqual([]);
    expect(runs[0]!.requests).toBe(2);
    expect(Date.parse(runs[0]!.cursor)).toBeGreaterThan(Date.parse(START_HWM));
    expect(runs.slice(1).map((r) => r.requests)).toEqual(runs.slice(1).map(() => 1));
    expect(st.cursor!.window_to).toBe(st.ksefHwm);
  });

  it('ponowienie po „advance-hwm” w trakcie nadrabiania: ta sama strona jeszcze raz, bez dubli, ten sam punkt wznowienia', async () => {
    st.ksefInvoices = invoicesFrom(Date.parse(START_HWM) + 60_456, 1200, 7, 30 * MINUTE);
    st.failSteps = new Set(['advance-hwm']);

    const runs = await runUntilCaughtUp(20);

    // Pierwszy przebieg zapisał faktury, ale nie HWM: job pada, HWM stoi.
    expect(runs[0]!.result).toEqual({ thrown: 'fixture advance-hwm' });
    expect(runs[0]!.cursor).toBe(START_HWM);
    // Drugi zaczyna od tego samego miejsca, dubli nie zapisuje, a HWM dochodzi
    // do tego samego punktu, który zapisałby pierwszy.
    expect(runs[1]!.from).toBe(START_HWM);
    expect(runs[1]!.cursor).toBe(msFloor(st.ksefInvoices[249]!.permanentStorageDate));
    expect(runs.map((r) => r.requests)).toEqual(runs.map(() => 1));
    savedOnce(1200);
    expect(st.limited).toEqual([]);
    expect(st.cursor!.window_to).toBe(st.ksefHwm);
  });

  it('429 w trakcie nadrabiania (limit zużył ktoś inny): HWM zostaje w punkcie częściowym, wznowienie po Retry-After', async () => {
    st.ksefInvoices = invoicesFrom(Date.parse(START_HWM) + 60_456, 1200, 7, 30 * MINUTE);

    const runs = await runUntilCaughtUp(20, (i) => {
      if (i === 1) st.forced429 = 1;
    });

    expect(runs.length).toBeGreaterThan(2);
    expect(runs[1]!.result).toMatchObject({ failed: 'rate_limit' });
    // Postęp pierwszego przebiegu nie przepada: HWM stoi w jego punkcie, nie na starcie.
    expect(runs[1]!.cursor).toBe(runs[0]!.cursor);
    expect(Date.parse(runs[0]!.cursor)).toBeGreaterThan(Date.parse(START_HWM));
    expect(runs[1]!.nextInMs).toBeGreaterThanOrEqual(MINUTE);
    expect(runs[2]!.from).toBe(runs[0]!.cursor);
    expect(st.limited).toHaveLength(1);
    savedOnce(1200);
    expect(st.cursor!.window_to).toBe(st.ksefHwm);
  });
});
