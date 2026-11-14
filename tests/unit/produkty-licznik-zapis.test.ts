import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 2.6 planu kompletnej aplikacji: licznik użyć produktu z katalogu przy
 * zapisie faktury z formularza. Prawdziwe akcje `saveDraftAction`
 * i `saveAndSendInvoiceAction`; atrapa to tylko baza (PostgREST: INSERT
 * faktury i pozycji, RPC `product_usage_record` z 00204) i kolejka wysyłki.
 * Klucz produktu (ta sama normalizacja co indeks 00186), izolację firm
 * i atomowość licznika na prawdziwym Postgresie sprawdza
 * tests/rls-produkty-licznik.test.ts (job CI „RLS isolation”).
 *
 * Granice:
 * - po zapisie szkicu i po „Wystaw i wyślij” RPC dostaje pary nazwa +
 *   jednostka z pozycji bez powtórzeń, po zapisie pozycji, raz na fakturę;
 * - błąd RPC (np. brak funkcji przed wgraniem 00204) i wyjątek nie psują
 *   zapisu faktury: tylko wpis w logu;
 * - drugi zapis z tego samego otwarcia formularza (`request_done`, także dwa
 *   kliknięcia naraz) i nieudany zapis faktury albo pozycji nie wołają RPC;
 * - faktura z ponad 1000 różnych pozycji: wywołania po najwyżej 1000 par
 *   (limit funkcji w 00204).
 */

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  logAudit: vi.fn(),
  enqueue: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: mocks.requireAuth,
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.logAudit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: mocks.enqueue }));
vi.mock('@/lib/observability/logger', () => ({
  logger: { warn: mocks.warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: vi.fn() }));
// Fikcyjny NIP testowy 1234567890 nie ma poprawnej sumy kontrolnej.
vi.mock('@/lib/xml/invoice-calculator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/invoice-calculator')>(),
  validateNipChecksum: () => true,
}));

import { saveAndSendInvoiceAction, saveDraftAction } from '@/components/invoices/actions';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

type Row = Record<string, unknown>;
type DbError = { code: string; message: string };
type RpcOutcome = { data: unknown; error: DbError | null };

const NOW = new Date('2026-11-14T09:00:00Z');
const DZIS = '2026-11-14';
const tenantId = '11111111-1111-4111-8111-111111111111';
const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NIP = '1234567890';
const RPC = 'product_usage_record';

const db = {
  invoices: [] as Row[],
  lines: [] as Row[],
  events: [] as string[],
  rpcCalls: [] as Array<{ fn: string; args: Row }>,
  rpcResult: ((): RpcOutcome => ({ data: 0, error: null })) as (args: Row) => RpcOutcome,
  invoiceInsertError: null as DbError | null,
  linesInsertError: null as DbError | null,
  nextId: 1,
};

/** Jedno okrążenie sieci: równoległe zapisy przeplatają się jak na produkcji. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/** INSERT faktury jak w bazie: klucz zapisu z jednego otwarcia formularza (00199) i błąd ustawiony w teście. */
function insertInvoice(row: Row): { data: Row | null; error: DbError | null } {
  db.events.push('insert:invoices');
  if (row.number_request_key && db.invoices.some((r) => r.number_request_key === row.number_request_key)) {
    return { data: null, error: { code: 'P0001', message: 'invoice_number_request_done' } };
  }
  if (db.invoiceInsertError) return { data: null, error: db.invoiceInsertError };
  const stored = { id: `inv-${db.nextId++}`, ...row };
  db.invoices.push(stored);
  return { data: { id: stored.id }, error: null };
}

function from(table: string) {
  const filters: Record<string, unknown> = {};
  let operation: 'select' | 'insert' | 'delete' = 'select';
  let payload: Row | Row[] | null = null;
  const result = async (): Promise<{ data: unknown; error: unknown }> => {
    await tick();
    if (table === 'tenants') {
      return {
        data: {
          id: tenantId, nip: NIP, name: 'Firma testowa',
          address_json: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
          vat_exemption_basis: null, vat_cash_method: false,
        },
        error: null,
      };
    }
    if (table === 'invoices' && operation === 'insert') return insertInvoice(payload as Row);
    if (table === 'invoices' && operation === 'delete') {
      db.events.push('delete:invoices');
      db.invoices = db.invoices.filter((r) => r.id !== filters.id);
      return { data: null, error: null };
    }
    if (table === 'invoices' && filters.number_request_key) {
      const hit = db.invoices.find((r) => r.number_request_key === filters.number_request_key);
      return { data: hit ? { id: hit.id, internal_number: hit.internal_number } : null, error: null };
    }
    if (table === 'invoice_line_items' && operation === 'insert') {
      db.events.push('insert:invoice_line_items');
      if (db.linesInsertError) return { data: null, error: db.linesInsertError };
      db.lines.push(...(payload as Row[]));
      return { data: null, error: null };
    }
    return { data: null, error: null };
  };
  const chain = {
    select: () => chain,
    eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
    in: (key: string, values: unknown[]) => { filters[key] = values; return chain; },
    order: () => chain,
    limit: () => chain,
    insert: (p: Row | Row[]) => { operation = 'insert'; payload = p; return chain; },
    delete: () => { operation = 'delete'; return chain; },
    maybeSingle: async () => result(),
    single: async () => result(),
    then: <T,>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (e: unknown) => T) =>
      result().then(resolve, reject),
  };
  return chain;
}

async function rpc(fn: string, args: Row): Promise<RpcOutcome> {
  db.rpcCalls.push({ fn, args });
  db.events.push(`rpc:${fn}`);
  await tick();
  return db.rpcResult(args);
}

const line = (name: string, unit: string) => ({ name, unit, quantity: 1, unitPriceNet: 100, vatRate: '23' as const });

const form = (extra: Partial<InvoiceFormValues> = {}): InvoiceFormValues => ({
  internalNumber: 'FV/2026/11/014', issueDate: DZIS, saleDate: '',
  buyerNip: NIP, buyerName: 'Nabywca testowy', buyerAddressLine1: 'ul. B 2',
  buyerAddressLine2: '00-002 Warszawa', buyerEmail: '', buyerIsConsumer: false,
  buyerPesel: '', buyerIdDocument: '', paymentMethod: 'transfer', paymentDueDate: '2026-11-28',
  bankAccount: 'PL61109010140000071219812874',
  lines: [
    line('Usługa programistyczna', 'godz.'),
    line('Usługa programistyczna', 'godz.'),
    line('Konsultacja', 'szt.'),
  ],
  numberRequestKey: KEY,
  ...extra,
});

const usageCalls = () => db.rpcCalls.filter((c) => c.fn === RPC);
const warned = () => mocks.warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db.invoices = [];
  db.lines = [];
  db.events = [];
  db.rpcCalls = [];
  db.rpcResult = () => ({ data: 2, error: null });
  db.invoiceInsertError = null;
  db.linesInsertError = null;
  db.nextId = 1;
  mocks.requireAuth.mockResolvedValue({ supabase: { from, rpc }, user: { id: 'fixture-user' }, tenantId, role: 'owner' });
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('licznik użyć produktu po zapisie faktury z formularza', () => {
  it('szkic: po zapisie pozycji RPC dostaje pary nazwa + jednostka bez powtórzeń, raz', async () => {
    const result = await saveDraftAction(form(), tenantId);

    expect(result).toMatchObject({ success: true, invoiceId: 'inv-1' });
    expect(usageCalls()).toEqual([
      {
        fn: RPC,
        args: { p_lines: [{ name: 'Usługa programistyczna', unit: 'godz.' }, { name: 'Konsultacja', unit: 'szt.' }] },
      },
    ]);
    expect(db.events).toEqual(['insert:invoices', 'insert:invoice_line_items', `rpc:${RPC}`]);
  });

  it('pary są dokładnie takie, jak w pozycjach: klucz produktu (wielkość liter, odstępy) liczy baza', async () => {
    await saveDraftAction(form({ lines: [line('Konsultacja', 'szt.'), line('  KONSULTACJA ', 'szt.')] }), tenantId);

    expect(usageCalls()[0]?.args).toEqual({
      p_lines: [{ name: 'Konsultacja', unit: 'szt.' }, { name: '  KONSULTACJA ', unit: 'szt.' }],
    });
  });

  it('„Wystaw i wyślij”: RPC po zapisie pozycji, faktura idzie do kolejki', async () => {
    const result = await saveAndSendInvoiceAction(form(), tenantId);

    expect(result).toMatchObject({ success: true, invoiceId: 'inv-1' });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(usageCalls()).toHaveLength(1);
    expect(usageCalls()[0]!.args).toEqual({
      p_lines: [{ name: 'Usługa programistyczna', unit: 'godz.' }, { name: 'Konsultacja', unit: 'szt.' }],
    });
    expect(db.events.indexOf(`rpc:${RPC}`)).toBeGreaterThan(db.events.indexOf('insert:invoice_line_items'));
  });

  it('„Wystaw i wyślij” bez certyfikatu KSeF: szkic zostaje z pozycjami, więc licznik też', async () => {
    mocks.enqueue.mockResolvedValue({ ok: false, error: 'Brak certyfikatu KSeF. Najpierw wgraj certyfikat.' });

    const result = await saveAndSendInvoiceAction(form(), tenantId);

    expect(result).toMatchObject({ success: false, invoiceId: 'inv-1' });
    expect(usageCalls()).toHaveLength(1);
  });

  it('błąd RPC (brak funkcji przed wgraniem 00204) nie psuje zapisu: tylko wpis w logu', async () => {
    db.rpcResult = () => ({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function public.product_usage_record(p_lines) in the schema cache' },
    });

    const result = await saveDraftAction(form(), tenantId);

    expect(result).toMatchObject({ success: true, invoiceId: 'inv-1' });
    expect(db.invoices).toHaveLength(1);
    expect(db.lines).toHaveLength(3);
    expect(usageCalls()).toHaveLength(1);
    expect(warned()).toContain('[produkty] licznik użyć');
    expect(warned()).toContain('PGRST202');
  });

  it('wyjątek przy RPC (zerwane połączenie) nie psuje „Wystaw i wyślij”: tylko wpis w logu', async () => {
    db.rpcResult = () => {
      throw new Error('fetch failed');
    };

    const result = await saveAndSendInvoiceAction(form(), tenantId);

    expect(result).toMatchObject({ success: true, invoiceId: 'inv-1' });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(warned()).toContain('[produkty] licznik użyć');
    expect(warned()).toContain('fetch failed');
  });
});

describe('bez licznika, gdy faktura się nie zapisała', () => {
  it('drugi zapis z tego samego otwarcia formularza (request_done): bez drugiego wywołania', async () => {
    const first = await saveDraftAction(form(), tenantId);
    const second = await saveDraftAction(form(), tenantId);

    expect(first).toMatchObject({ success: true, invoiceId: 'inv-1' });
    expect(second).toMatchObject({ success: false, invoiceId: 'inv-1' });
    expect(db.invoices).toHaveLength(1);
    expect(usageCalls()).toHaveLength(1);
  });

  it('dwa kliknięcia „Wystaw i wyślij” naraz: jedna faktura, jedno wywołanie', async () => {
    const [a, b] = await Promise.all([saveAndSendInvoiceAction(form(), tenantId), saveAndSendInvoiceAction(form(), tenantId)]);

    expect([a.success, b.success].sort()).toEqual([false, true]);
    expect(db.invoices).toHaveLength(1);
    expect(usageCalls()).toHaveLength(1);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('numer zajęty (23505), potem zapis z innym numerem: jedno wywołanie, dla zapisanej faktury', async () => {
    db.invoiceInsertError = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "uq_invoices_tenant_outgoing_internal_number"',
    };
    const refused = await saveDraftAction(form(), tenantId);
    expect(refused).toMatchObject({ success: false });
    expect(usageCalls()).toHaveLength(0);

    db.invoiceInsertError = null;
    const saved = await saveDraftAction(form({ internalNumber: 'FV/2026/11/015' }), tenantId);

    expect(saved).toMatchObject({ success: true, invoiceId: 'inv-1' });
    expect(usageCalls()).toHaveLength(1);
  });

  it('błąd zapisu pozycji (faktura cofnięta), potem ponowny zapis: jedno wywołanie', async () => {
    db.linesInsertError = { code: '23514', message: 'new row violates check constraint' };
    const refused = await saveAndSendInvoiceAction(form(), tenantId);
    expect(refused).toMatchObject({ success: false });
    expect(db.events).toContain('delete:invoices');
    expect(usageCalls()).toHaveLength(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();

    db.linesInsertError = null;
    const saved = await saveAndSendInvoiceAction(form(), tenantId);

    expect(saved).toMatchObject({ success: true });
    expect(db.invoices).toHaveLength(1);
    expect(usageCalls()).toHaveLength(1);
  });
});

describe('limit funkcji 00204', () => {
  it('ponad 1000 różnych pozycji: wywołania po najwyżej 1000 par, wszystkie pary raz', async () => {
    const lines = Array.from({ length: 1001 }, (_, i) => ({ ...line(`Produkt ${i + 1}`, 'szt.'), unitPriceNet: 1 }));

    const result = await saveDraftAction(form({ lines }), tenantId);

    expect(result).toMatchObject({ success: true });
    const sent = usageCalls().map((c) => c.args.p_lines as Array<{ name: string; unit: string }>);
    expect(sent.map((pairs) => pairs.length)).toEqual([1000, 1]);
    expect(sent.flat().map((p) => p.name)).toEqual(lines.map((l) => l.name));
  });
});
