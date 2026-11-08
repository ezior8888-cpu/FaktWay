import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  existing: [] as Row[],
  filterError: null as { message: string } | null,
  filterChunks: [] as string[][],
  inserts: [] as Row[][],
  raceRows: null as Row[] | null,
  sellerRows: [] as Row[],
  classify: vi.fn((docs: unknown, known: ReadonlySet<string>) => {
    void docs;
    void known;
    return [] as unknown[];
  }),
}));

vi.mock('@/lib/supabase/admin-queries', () => ({ getTenantKsefCredentials: vi.fn(async () => ({})) }));
vi.mock('@/lib/ksef/inbox', () => ({ queryReceivedInvoices: vi.fn() }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: vi.fn() }));
vi.mock('@/lib/flo/functions/expense-inbox', () => ({
  buildInboxSummaryProposal: () => null,
  classifyInboxDocuments: (docs: unknown, known: ReadonlySet<string>) => db.classify(docs, known),
}));
// Harmonogram ma własny test (`skrzynka-przebieg-harmonogram`). Bez tej atrapy jego błąd
// (brak bazy) szedłby do logu i Sentry i zasłaniałby asercje o błędach przebiegu.
vi.mock('@/lib/ksef/inbox-schedule-db', () => ({
  readInboxPollState: async () => null,
  finishInboxPoll: async () => undefined,
}));
vi.mock('@/lib/flo/functions/inbox-cursor', () => ({
  readInboxHwm: async () => null,
  saveInboxHwm: vi.fn(),
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToTenant: vi.fn(async () => ({ sent: 0, failed: 0 })) }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => ({
    from: () => {
      let op: 'select' | 'insert' = 'select';
      let rows: Row[] = [];
      let inList: string[] | null = null;
      let sellerList: string[] | null = null;
      const filters = new Map<string, unknown>();
      const q = {
        select: () => q,
        eq: (col: string, value: unknown) => {
          filters.set(col, value);
          return q;
        },
        not: () => q,
        neq: () => q,
        limit: () => q,
        in: (col: string, list: string[]) => {
          if (col === 'ksef_number') inList = list;
          if (col === 'seller_nip') sellerList = list;
          return q;
        },
        insert: (r: Row[]) => {
          op = 'insert';
          rows = r;
          return q;
        },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => {
          let result: unknown = { data: [], error: null };
          if (op === 'insert') {
            db.inserts.push(rows);
            if (db.raceRows) {
              db.existing.push(...db.raceRows);
              db.raceRows = null;
              result = { data: null, error: { code: '23505', message: 'unique violation' } };
            } else if (rows.some((r) => db.existing.some((e) =>
              e.tenant_id === r.tenant_id && e.direction === r.direction &&
              e.ksef_environment === r.ksef_environment && e.ksef_number === r.ksef_number))) {
              result = { data: null, error: { code: '23505', message: 'unique violation' } };
            } else {
              const inserted: Row[] = rows.map((r, i) => ({ ...r, id: `id-${db.existing.length + i}` }));
              db.existing.push(...inserted);
              result = { data: inserted.map((r) => ({ id: r.id, ksef_number: r.ksef_number })), error: null };
            }
          } else if (sellerList) {
            const lista = sellerList;
            result = { data: db.sellerRows.filter((r) => lista.includes(r.seller_nip as string)), error: null };
          } else if (inList) {
            const numbers = inList;
            db.filterChunks.push(numbers);
            result = db.filterError
              ? { data: null, error: db.filterError }
              : { data: db.existing.filter((r) =>
                numbers.includes(r.ksef_number as string) &&
                [...filters].every(([col, value]) => r[col] === value)), error: null };
          }
          return Promise.resolve(result).then(ok, fail);
        },
      };
      return q;
    },
  }),
}));

import { queryReceivedInvoices } from '@/lib/ksef/inbox';
import { KSEF_NUMBERS_PER_QUERY, runInboxPollTenant } from '@/lib/jobs/runners/inbox-polling';

/** Okno 48 h powoduje nakładające się importy; 00120 rozstrzyga wyścig w DB. */

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};
const DATA = { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', nip: '1234567890', environment: 'test' as const };

function faktura(n: number, sellerNip = '5260001246') {
  const numer = `1234567890-20260925-${String(n).padStart(12, '0')}-00`;
  return {
    ksefNumber: numer,
    invoiceNumber: `FV ${n}/2026`,
    acquisitionDate: '2026-09-25T10:00:00Z',
    issueDate: '2026-09-25',
    seller: { nip: sellerNip, name: 'Dostawca' },
    buyer: { identifier: { type: 'Nip', value: '1234567890' } },
    currency: 'PLN',
    grossAmount: 123,
    netAmount: 100,
    vatAmount: 23,
  };
}

function storedInvoice(n: number, env: string | null = 'test', patch: Row = {}): Row {
  const invoice = faktura(n);
  return {
    id: `stored-${n}`,
    tenant_id: DATA.tenantId,
    direction: 'incoming',
    ksef_environment: env,
    ksef_number: invoice.ksefNumber,
    seller_nip: invoice.seller.nip,
    issue_date: invoice.issueDate,
    gross_total: invoice.grossAmount,
    fa3_data: {},
    ...patch,
  };
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  vi.clearAllMocks();
  db.existing = [];
  db.filterError = null;
  db.filterChunks = [];
  db.inserts = [];
  db.raceRows = null;
  db.sellerRows = [];
  db.classify.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('skrzynka KSeF: filtr już zapisanych faktur', () => {
  it('błąd zapytania NIE znaczy „nic nie ma” — job pada, nic się nie zapisuje', async () => {
    vi.mocked(queryReceivedInvoices).mockResolvedValue({ invoices: [faktura(1), faktura(2)], hwm: null } as never);
    db.filterError = { message: 'URI Too Long' };

    await expect(runInboxPollTenant(DATA, ctx)).rejects.toThrow(/Nie można sprawdzić/);
    expect(db.inserts).toEqual([]);
  });

  it('pytamy paczkami, żeby adres nie przekroczył limitu, i zapisujemy tylko nowe', async () => {
    const wszystkie = Array.from({ length: 250 }, (_, i) => faktura(i));
    vi.mocked(queryReceivedInvoices).mockResolvedValue({ invoices: wszystkie, hwm: null } as never);
    db.existing = [storedInvoice(0), storedInvoice(120), storedInvoice(249)];

    await runInboxPollTenant(DATA, ctx);

    expect(db.filterChunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(Math.max(...db.filterChunks.map((c) => c.length))).toBeLessThanOrEqual(KSEF_NUMBERS_PER_QUERY);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toHaveLength(247);
  });

  it('ta sama faktura dwa razy w jednej paczce z KSeF trafia do bazy raz', async () => {
    vi.mocked(queryReceivedInvoices).mockResolvedValue({ invoices: [faktura(7), faktura(7), faktura(8)], hwm: null } as never);

    await runInboxPollTenant(DATA, ctx);

    expect(db.inserts[0]!.map((r) => r.ksef_number)).toEqual([faktura(7).ksefNumber, faktura(8).ksefNumber]);
  });

  it('wszystko już zapisane — żadnego insertu', async () => {
    vi.mocked(queryReceivedInvoices).mockResolvedValue({ invoices: [faktura(1)], hwm: null } as never);
    db.existing = [storedInvoice(1)];

    await expect(runInboxPollTenant(DATA, ctx)).resolves.toMatchObject({ newlyAdded: 0 });
    expect(db.inserts).toEqual([]);
  });

  it('różni sprzedawcy mogą mieć ten sam własny numer FV/1', async () => {
    const first = faktura(1, '1111111111');
    const second = { ...faktura(2, '2222222222'), invoiceNumber: first.invoiceNumber };
    vi.mocked(queryReceivedInvoices).mockResolvedValue({ invoices: [first, second], hwm: null } as never);

    await expect(runInboxPollTenant(DATA, ctx)).resolves.toMatchObject({ newlyAdded: 2 });
    expect(db.inserts[0]!.map((r) => r.internal_number)).toEqual([first.invoiceNumber, first.invoiceNumber]);
    expect(db.inserts[0]!.every((r) => r.origin === 'ksef_inbox')).toBe(true);
  });

  it('po konflikcie równoległego batcha ponawia tylko nowe faktury i tylko je ogłasza', async () => {
    vi.mocked(queryReceivedInvoices).mockResolvedValue({ invoices: [faktura(1), faktura(2)], hwm: null } as never);
    db.raceRows = [storedInvoice(1)];

    await expect(runInboxPollTenant(DATA, ctx)).resolves.toMatchObject({ newlyAdded: 1 });
    expect(db.inserts.map((attempt) => attempt.map((row) => row.ksef_number))).toEqual([
      [faktura(1).ksefNumber, faktura(2).ksefNumber],
      [faktura(2).ksefNumber],
    ]);
    const invoiceFanout = vi.mocked(ctx.step.sendEvent).mock.calls.find(([name]) => name === 'fan-out-new-invoices');
    expect(invoiceFanout?.[1]).toHaveLength(1);
    expect((invoiceFanout?.[1] as Array<{ data: { ksefNumber: string } }>)[0]?.data.ksefNumber).toBe(faktura(2).ksefNumber);
  });

  it('ten sam numer KSeF w innym środowisku nie blokuje bieżącego importu', async () => {
    vi.mocked(queryReceivedInvoices).mockResolvedValue({ invoices: [faktura(1)], hwm: null } as never);
    db.existing = [storedInvoice(1, 'production')];

    await expect(runInboxPollTenant(DATA, ctx)).resolves.toMatchObject({ newlyAdded: 1 });
  });

  it('historyczne nieznane środowisko zatrzymuje import bez zgadywania', async () => {
    vi.mocked(queryReceivedInvoices).mockResolvedValue({ invoices: [faktura(1)], hwm: null } as never);
    db.existing = [storedInvoice(1, null)];

    await expect(runInboxPollTenant(DATA, ctx)).rejects.toThrow(/bez środowiska/);
    expect(db.inserts).toEqual([]);
  });

  it('konflikt skrótu treści nie jest cicho pomijany', async () => {
    vi.mocked(queryReceivedInvoices).mockResolvedValue({ invoices: [{ ...faktura(1), invoiceHash: 'new-hash' }], hwm: null } as never);
    db.existing = [storedInvoice(1, 'test', { fa3_data: { invoiceHash: 'old-hash' } })];

    await expect(runInboxPollTenant(DATA, ctx)).rejects.toThrow(/Konflikt tożsamości/);
    expect(db.inserts).toEqual([]);
  });
});

describe('skrzynka KSeF: sito nieznanego sprzedawcy', () => {
  // Recenzja ChatGPT nr 2 (25.09): zapytanie o znanych sprzedawców szło po
  // zapisie i widziało właśnie wstawione faktury — każdy wyglądał na znanego.
  it('„znany” to widziany PRZED tym przebiegiem, nie właśnie zapisany', async () => {
    vi.mocked(queryReceivedInvoices).mockResolvedValue({ invoices: [faktura(1, '1111111111'), faktura(2, '2222222222')], hwm: null } as never);
    db.sellerRows = [
      { id: 'dawna-faktura', seller_nip: '1111111111' },
      // Wiersze z bieżącego zapisu (atrapa nadaje im id-0, id-1):
      { id: 'id-0', seller_nip: '1111111111' },
      { id: 'id-1', seller_nip: '2222222222' },
    ];

    await runInboxPollTenant(DATA, ctx);

    const known = db.classify.mock.calls[0]![1];
    expect([...known]).toEqual(['1111111111']);
  });
});
