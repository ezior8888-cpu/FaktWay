import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

// E1-W10 (plan „zero zgubionych faktur”, ryzyko M7): KSeF oddaje najwyżej
// 10 000 rekordów na zestaw filtrów `POST /invoices/query/metadata`, a po
// dojściu do limitu ustawia `isTruncated` (OpenAPI KSeF 2.0). Skrócony
// scenariusz MF opisuje trzy przypadki: `hasMore = false` → koniec,
// `hasMore` bez `isTruncated` → następna strona, `hasMore` z `isTruncated` →
// zawężenie `dateRange.from`. Nie mówi, co znaczy `isTruncated` na stronie
// z `hasMore = false`, a tak wygląda ostatnia strona obciętego wyniku, gdy
// `hasMore` znaczy „jest kolejna strona do pobrania”. Pętla skrzynki kończyła
// wtedy okno po 10 000 fakturach, a HWM z odpowiedzi przesuwał się ponad
// resztę: te faktury zakupu nigdy nie trafiały do skrzynki.
//
// Atrapy: HTTP (globalny `fetch`), sesja XAdES, baza (klient serwisowy,
// kursor HWM skrzynki) oraz karta FLO i push, które nie dotyczą okna.
// Prawdziwe: `ksefFetch`, `queryReceivedInvoices`, runner skrzynki.
//
// Ten test sprawdza poprawność pętli, nie pojemność: 41 zapytań w jednym
// przebiegu przekracza limit MF (16/min, 20/h na NIP i adres IP), więc na
// prawdziwym KSeF przebieg dostałby 429 wcześniej. To osobne ustalenie W10-b
// (plan, sekcja 8).

const st = vi.hoisted(() => ({
  /** Wiersze `invoices` zapisane przez runner (klient serwisowy). */
  invoices: [] as Array<Record<string, unknown>>,
  /** HWM skrzynki, od którego runner liczy okno. */
  hwm: null as string | null,
  /** Zapisy kursora skrzynki (`saveInboxHwm`). */
  saved: [] as Array<{ windowFrom: string; hwm: string; fetched: number; saved: number }>,
  /** Ile razy zapis kursora ma jeszcze paść (ponowienie po zapisie faktur). */
  failSaves: 0,
}));

vi.mock('@/lib/ksef/session-cache', () => ({
  ksefSessionCache: { getSession: async () => ({ accessToken: 'token' }), invalidate: () => undefined },
}));
vi.mock('@/lib/ksef/rate-limiter', () => ({
  ksefRateLimiter: { enqueue: (_nip: string, fn: () => unknown) => fn() },
}));
vi.mock('@/lib/supabase/admin-queries', () => ({ getTenantKsefCredentials: vi.fn(async () => ({ nip: '1234567890' })) }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: vi.fn() }));
vi.mock('@/lib/flo/functions/expense-inbox', () => ({
  buildInboxSummaryProposal: () => null,
  classifyInboxDocuments: () => [],
}));
vi.mock('@/lib/flo/functions/inbox-cursor', () => ({
  readInboxHwm: async () => st.hwm,
  saveInboxHwm: async (_tenantId: string, cursor: { windowFrom: string; hwm: string; fetched: number; saved: number }) => {
    if (st.failSaves > 0) {
      st.failSaves -= 1;
      throw new Error('zapis kursora skrzynki nieudany');
    }
    st.saved.push(cursor);
    st.hwm = cursor.hwm;
  },
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToTenant: vi.fn(async () => ({ sent: 0, failed: 0 })) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  // Synchronicznie jak prawdziwy (`logAuditSystem` nie czeka na klienta).
  createAdminClient: () => ({
    from: (table: string) => {
      let op: 'select' | 'insert' = 'select';
      let numbers = new Set<string>();
      let rows: Array<Record<string, unknown>> = [];
      const q = {
        select: () => q, eq: () => q, not: () => q, limit: () => q,
        in: (_col: string, values: string[]) => { numbers = new Set(values); return q; },
        insert: (r: Record<string, unknown> | Array<Record<string, unknown>>) => {
          op = 'insert';
          rows = Array.isArray(r) ? r : [r];
          return q;
        },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
          if (table !== 'invoices') return Promise.resolve({ data: null, error: null }).then(ok, fail);
          if (op === 'insert') {
            const inserted: Array<Record<string, unknown>> = rows.map((r, i) => ({
              ...r,
              id: `00000000-0000-4000-8000-${String(st.invoices.length + i).padStart(12, '0')}`,
            }));
            st.invoices.push(...inserted);
            return Promise.resolve({ data: inserted.map((r) => ({ id: r.id, ksef_number: r.ksef_number })), error: null })
              .then(ok, fail);
          }
          const found = st.invoices.filter((r) => numbers.has(r.ksef_number as string));
          return Promise.resolve({ data: found, error: null }).then(ok, fail);
        },
      };
      return q;
    },
  }),
}));

import { runInboxPollTenant } from '@/lib/jobs/runners/inbox-polling';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DATA = { tenantId: TENANT, nip: '1234567890', environment: 'test' as const };
const START_HWM = '2026-10-02T11:00:00.000Z';
/** HWM KSeF: wszystkie faktury z atrapy leżą poniżej, więc KSeF gwarantuje ich komplet. */
const KSEF_HWM = '2026-10-05T00:00:00.000Z';
/** Limit techniczny KSeF na zestaw filtrów (OpenAPI: `isTruncated`). */
const KSEF_LIMIT = 10_000;
const TOTAL = KSEF_LIMIT + 1;
/** Bezpiecznik pętli skrzynki (`MAX_REQUESTS` w `lib/ksef/inbox.ts`). */
const MAX_REQUESTS = 400;

type Invoice = ReturnType<typeof faktura>;

function faktura(n: number): {
  ksefNumber: string; invoiceNumber: string; acquisitionDate: string; issueDate: string; invoicingDate: string;
  permanentStorageDate: string; invoiceType: string; seller: { nip: string; name: string };
  buyer: { identifier: { type: string; value: string } }; currency: string; grossAmount: number;
  netAmount: number; vatAmount: number; invoiceHash: string;
} {
  // Co sekundę od starego HWM, rosnąco. 10 000. i 10 001. faktura mają tę samą
  // chwilę: zawężenie musi zacząć od daty ostatniego rekordu WŁĄCZNIE, inaczej
  // gubi fakturę z tej samej chwili tuż za limitem.
  const at = new Date(Date.parse(START_HWM) + Math.min(n, KSEF_LIMIT) * 1000).toISOString();
  return {
    ksefNumber: `5260001246-20261002-${n.toString(16).toUpperCase().padStart(12, '0')}-00`,
    invoiceNumber: `FV ${n}/2026`, acquisitionDate: at, issueDate: '2026-10-02',
    invoicingDate: at, permanentStorageDate: at, invoiceType: 'Vat',
    seller: { nip: '5260001246', name: 'Dostawca' }, buyer: { identifier: { type: 'Nip', value: '1234567890' } },
    currency: 'PLN', grossAmount: 123, netAmount: 100, vatAmount: 23, invoiceHash: `hash-${n}`,
  };
}

const KSEF_INVOICES: Invoice[] = Array.from({ length: TOTAL }, (_, i) => faktura(i + 1));

/**
 * Jak MF czyta flagę obcięcia:
 *  - `last-page`: `hasMore` = jest kolejna strona do pobrania, `isTruncated` na
 *    ostatniej stronie obciętego wyniku (tej z 10 000. rekordem, `hasMore = false`);
 *  - `every-page`: `isTruncated` na każdej stronie obciętego wyniku.
 */
type TruncationFlag = 'last-page' | 'every-page';

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

interface MetadataQuery {
  from: string;
  pageOffset: number;
}

/** Atrapa `POST /invoices/query/metadata`: filtr po PermanentStorage, rosnąco, ograniczenie do HWM, limit 10 000. */
function fakeKsef(flag: TruncationFlag, opts: { failOnRequest?: number } = {}) {
  const queries: MetadataQuery[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/v2/, '');
    if ((init?.method ?? 'GET') !== 'POST' || path !== '/invoices/query/metadata') {
      throw new Error(`nieoczekiwane żądanie ${init?.method ?? 'GET'} ${path}`);
    }
    const body = JSON.parse(init?.body ?? '{}') as {
      subjectType: string;
      dateRange: { dateType: string; from: string; to: string; restrictToPermanentStorageHwmDate?: boolean };
    };
    expect(body).toMatchObject({ subjectType: 'subject2', dateRange: { dateType: 'PermanentStorage', restrictToPermanentStorageHwmDate: true } });
    expect(parsed.searchParams.get('sortOrder')).toBe('Asc');
    const pageOffset = Number(parsed.searchParams.get('pageOffset'));
    const pageSize = Number(parsed.searchParams.get('pageSize'));
    queries.push({ from: body.dateRange.from, pageOffset });
    if (opts.failOnRequest === queries.length) return reply(503, { exception: { exceptionDetailList: [] } });

    const fromMs = Date.parse(body.dateRange.from);
    const toMs = Math.min(Date.parse(body.dateRange.to), Date.parse(KSEF_HWM));
    const matched = KSEF_INVOICES.filter((inv) => {
      const at = Date.parse(inv.permanentStorageDate);
      return at >= fromMs && at < toMs;
    });
    const available = matched.slice(0, KSEF_LIMIT);
    const invoices = available.slice(pageOffset * pageSize, (pageOffset + 1) * pageSize);
    const hasMore = (pageOffset + 1) * pageSize < available.length;
    const truncated = matched.length > KSEF_LIMIT;
    return reply(200, {
      invoices,
      hasMore,
      isTruncated: flag === 'every-page' ? truncated : truncated && !hasMore,
      permanentStorageHwmDate: KSEF_HWM,
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { queries };
}

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const savedNumbers = () => st.invoices.map((r) => r.ksef_number as string);

/** Faktury z KSeF poniżej zapisanego HWM, których nie ma w bazie: HWM je przeskoczył i już do nich nie wróci. */
function skippedBelowHwm(hwm: string): string[] {
  const saved = new Set(savedNumbers());
  return KSEF_INVOICES
    .filter((inv) => Date.parse(inv.permanentStorageDate) < Date.parse(hwm) && !saved.has(inv.ksefNumber))
    .map((inv) => inv.invoiceNumber);
}

beforeEach(() => {
  st.invoices = [];
  st.hwm = START_HWM;
  st.saved = [];
  st.failSaves = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('skrzynka KSeF — okno z 10 001 fakturami (limit 10 000 na zapytanie)', () => {
  // `last-page` był czerwony przed naprawą E1-W10; `every-page` (zawężenie już
  // po pierwszej stronie, przypadek opisany przez MF) przechodził i ma przechodzić dalej.
  it.each<TruncationFlag>(['last-page', 'every-page'])(
    'isTruncated (%s) — 10 001 wierszy bez dubli, HWM nie przeskakuje żadnej faktury',
    async (flag) => {
      const ksef = fakeKsef(flag);

      await expect(runInboxPollTenant(DATA, ctx)).resolves.toMatchObject({ fetched: TOTAL, newlyAdded: TOTAL });

      expect(st.invoices).toHaveLength(TOTAL);
      expect(new Set(savedNumbers()).size).toBe(TOTAL);
      expect(st.saved).toHaveLength(1);
      expect(skippedBelowHwm(st.saved[0]!.hwm)).toEqual([]);
      // HWM się przesuwa (do HWM KSeF, w oknie przebiegu), a nie tylko „nie przeskakuje”.
      expect(st.saved[0]!.hwm).toBe(KSEF_HWM);
      // Zawężenie: nowe `from` od daty ostatniego pobranego rekordu, strona od zera.
      const narrowed = ksef.queries.filter((q) => q.from !== START_HWM);
      expect(narrowed[0]).toMatchObject({ pageOffset: 0 });
      // Koszt pętli: 40 stron po 250 i jedno zapytanie po zawężeniu, w bezpieczniku
      // pętli. Limit MF przekracza (W10-b, nagłówek pliku).
      expect(ksef.queries).toHaveLength(41);
      expect(ksef.queries.length).toBeLessThanOrEqual(MAX_REQUESTS);
    },
  );

  it('błąd KSeF na zapytaniu po zawężeniu — nic nie zapisane, HWM stoi; ponowienie od zera pobiera komplet', async () => {
    fakeKsef('last-page', { failOnRequest: 41 });
    await expect(runInboxPollTenant(DATA, ctx)).resolves.toMatchObject({ fetched: 0, newlyAdded: 0, failed: 'ksef' });
    expect(st.invoices).toHaveLength(0);
    expect(st.saved).toEqual([]);
    expect(st.hwm).toBe(START_HWM);

    vi.unstubAllGlobals();
    fakeKsef('last-page');
    await runInboxPollTenant(DATA, ctx);
    expect(new Set(savedNumbers()).size).toBe(TOTAL);
    expect(skippedBelowHwm(st.saved[0]!.hwm)).toEqual([]);
  });

  it('ponowienie po zapisie faktur, a przed zapisem HWM — bez dubli, potem HWM się przesuwa', async () => {
    fakeKsef('last-page');
    st.failSaves = 1;
    await expect(runInboxPollTenant(DATA, ctx)).rejects.toThrow('zapis kursora');
    expect(st.invoices).toHaveLength(TOTAL);
    expect(st.hwm).toBe(START_HWM);

    // pg-boss powtarza cały handler: to samo okno, te same 10 001 faktur, już w bazie.
    await expect(runInboxPollTenant(DATA, ctx)).resolves.toMatchObject({ fetched: TOTAL, newlyAdded: 0 });
    expect(st.invoices).toHaveLength(TOTAL);
    expect(st.saved).toHaveLength(1);
    expect(skippedBelowHwm(st.saved[0]!.hwm)).toEqual([]);
  });
});
