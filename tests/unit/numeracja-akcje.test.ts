import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 2.5 (numeracja) na prawdziwych akcjach zapisu: zwykła faktura,
 * zaliczkowa, końcowa (rozliczeniowa) i korekta. Atrapa to tylko baza: RPC
 * `invoice_number_next` (kolejny numer z licznika serii) i INSERT faktury
 * z regułą wyzwalacza 00199 (licznik musi być kolejnym wolnym, inaczej
 * `invoice_number_moved`) oraz unikalnymi indeksami numeru i klucza zapisu.
 * Wyzwalacz, blokadę serii i wyścig na prawdziwym Postgresie sprawdza
 * tests/rls-numeracja.test.ts (job CI „RLS isolation”).
 *
 * Granice:
 * - numer z serii trafia wszędzie, gdzie faktura go niesie (kolumna, fa3_data,
 *   koperta zaliczki i korekty, zlecenie wysyłki), także gdy baza nadała inny
 *   numer niż podpowiedź z formularza;
 * - dwa wystawienia naraz w jednej serii dają dwa różne kolejne numery;
 * - drugi zapis z tego samego otwarcia formularza nie tworzy drugiej faktury;
 * - formularz bez serii (dzisiejsza numeracja) zapisuje wiersz bez zmian.
 */

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  logAudit: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: mocks.requireAuth,
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.logAudit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: mocks.enqueue }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: vi.fn() }));
vi.mock('@/lib/xml/invoice-calculator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/invoice-calculator')>(),
  validateNipChecksum: () => true,
}));

import { saveAndSendInvoiceAction, saveDraftAction } from '@/components/invoices/actions';
import { saveAdvanceAction } from '@/components/invoices/advance-actions';
import { saveCorrectionDraftAction } from '@/components/invoices/correction-actions';
import { saveFinalAction } from '@/components/invoices/final-actions';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';
import type { CorrectionInvoiceSchemaIn } from '@/lib/validators/invoice-validators';

type Row = Record<string, unknown>;

const NOW = new Date('2026-11-11T09:00:00Z');
const DZIS = '2026-11-11';
const tenantId = '11111111-1111-4111-8111-111111111111';
const SERIES = '0c0b5a9e-1d2f-4e3a-8b4c-5d6e7f809102';
const KEY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const parentId = '22222222-2222-4222-8222-222222222222';
const advanceId = '44444444-4444-4444-8444-444444444444';
const sellerNip = '1234567890';
const address = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };
const seller = { nip: sellerNip, name: 'Firma testowa', address };
const buyer = { type: 'b2b' as const, idType: 'nip' as const, nip: sellerNip, name: 'Nabywca testowy', address };

/** Seria „FV/{N}/{MM}/{RRRR}” z licznikiem miesięcznym. */
const render = (counter: number) => `FV/${counter}/11/2026`;

const db = {
  invoices: [] as Row[],
  inserts: [] as Row[],
  counter: 0,
  rpcCalls: [] as Array<{ fn: string; args: Row }>,
  nextId: 1,
};

const parent: Row = {
  id: parentId, tenant_id: tenantId, direction: 'outgoing', invoice_kind: 'regular',
  ksef_status: 'accepted', ksef_environment: 'test', issue_date: '2026-10-15',
  internal_number: 'FV/9/10/2026', ksef_number: '1234567890-20261015-ABCDEF',
  seller_data: seller, buyer_data: { nip: sellerNip, name: 'Nabywca testowy', address, jst: 2, gv: 2 },
  buyer_nip: sellerNip, net_total: 1000, vat_total: 230, gross_total: 1230,
};

/** Kolejny wolny licznik: po ostatnim nadanym, z pominięciem numerów zajętych przez inne faktury. */
function nextFree(): number {
  let c = db.counter + 1;
  while (db.invoices.some((r) => r.internal_number === render(c))) c++;
  return c;
}

/** INSERT faktury jak w bazie: wyzwalacz 00199 (klucz, licznik), potem indeksy unikalne. */
function insertInvoice(row: Row): { data: Row | null; error: Row | null } {
  db.inserts.push(row);
  if (row.number_request_key && db.invoices.some((r) => r.number_request_key === row.number_request_key)) {
    return { data: null, error: { code: 'P0001', message: 'invoice_number_request_done' } };
  }
  if (row.number_counter != null) {
    const expected = nextFree();
    if (row.number_counter !== expected) {
      return { data: null, error: { code: 'P0001', message: 'invoice_number_moved', details: render(expected) } };
    }
  }
  if (db.invoices.some((r) => r.internal_number === row.internal_number)) {
    return {
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint "uq_invoices_tenant_outgoing_internal_number"' },
    };
  }
  if (row.number_counter != null) db.counter = row.number_counter as number;
  const stored = { id: `inv-${db.nextId++}`, ...row };
  db.invoices.push(stored);
  return { data: { id: stored.id }, error: null };
}

/** Jedno okrążenie sieci: równoległe zapisy przeplatają się jak na produkcji. */
const tick = () => new Promise((r) => setTimeout(r, 0));

function from(table: string) {
  const filters: Record<string, unknown> = {};
  let operation: 'select' | 'insert' | 'delete' = 'select';
  let payload: Row | Row[] | null = null;
  const result = async (): Promise<{ data: unknown; error: unknown }> => {
    await tick();
    if (table === 'tenants') {
      return { data: { id: tenantId, nip: sellerNip, name: 'Firma testowa', address_json: address, vat_cash_method: false, vat_exemption_basis: null }, error: null };
    }
    if (table === 'invoices' && operation === 'insert') return insertInvoice(payload as Row);
    if (table === 'invoices' && operation === 'delete') {
      db.invoices = db.invoices.filter((r) => r.id !== filters.id);
      return { data: null, error: null };
    }
    if (table === 'invoices' && filters.number_request_key) {
      const hit = db.invoices.find((r) => r.number_request_key === filters.number_request_key);
      return { data: hit ? { id: hit.id, internal_number: hit.internal_number } : null, error: null };
    }
    if (table === 'invoices' && filters.id === parentId) {
      const match = Object.entries(filters).every(([key, value]) => parent[key] === value);
      return { data: match ? parent : null, error: null };
    }
    if (table === 'invoices' && Array.isArray(filters.id)) {
      return { data: [{ id: advanceId, internal_number: 'ZAL/1/10/2026', ksef_number: 'KSEF-TEST-1',
        issue_date: '2026-10-20', advance_amount: 123, gross_total: 123, invoice_kind: 'advance',
        buyer_nip: sellerNip, buyer_data: { nip: sellerNip, name: 'Nabywca testowy' } }], error: null };
    }
    if (table === 'invoices') return { data: [], error: null };
    if (table === 'invoice_line_items' && operation === 'select') {
      return { data: [{ name: 'Usługa', unit: 'szt', quantity: 1, unit_price_net: 1000, vat_rate: '23' }], error: null };
    }
    return { data: null, error: null };
  };
  const chain = {
    select: () => chain,
    eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
    or: () => chain,
    in: (key: string, values: unknown[]) => { filters[key] = values; return chain; },
    not: () => chain,
    overlaps: () => chain,
    order: () => chain,
    limit: () => chain,
    insert: (p: Row | Row[]) => { operation = 'insert'; payload = p; return chain; },
    delete: () => { operation = 'delete'; return chain; },
    maybeSingle: async () => result(),
    single: async () => result(),
    then: <T,>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (e: unknown) => T) => result().then(resolve, reject),
  };
  return chain;
}

async function rpc(fn: string, args: Row) {
  db.rpcCalls.push({ fn, args });
  await tick();
  if (fn === 'invoice_number_next') {
    if (args.p_series_id !== SERIES) return { data: { status: 'refused', code: 'not_found' }, error: null };
    const counter = nextFree();
    return { data: { status: 'ok', counter, period: '2026-11', number: render(counter) }, error: null };
  }
  return { data: null, error: { code: 'PGRST202', message: `brak funkcji ${fn}` } };
}

const fromSeries = (preview = render(1), key = KEY_A) => ({ numberSeriesId: SERIES, numberPreview: preview, numberRequestKey: key });

const regular = (internalNumber: string, extra: Partial<InvoiceFormValues> = {}): InvoiceFormValues => ({
  internalNumber, issueDate: DZIS, saleDate: '',
  buyerNip: '5252241585', buyerName: 'Klient', buyerAddressLine1: 'ul. B 2',
  buyerAddressLine2: '00-002 Warszawa', buyerEmail: '', buyerIsConsumer: false,
  buyerPesel: '', buyerIdDocument: '', paymentMethod: 'transfer', paymentDueDate: '2026-11-25',
  bankAccount: 'PL61109010140000071219812874',
  lines: [{ name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
  ...extra,
});

const common = (internalNumber: string) => ({
  internalNumber, issueDate: DZIS, paymentMethod: 'transfer' as const,
  paymentDueDate: '2026-11-25', bankAccount: '1'.repeat(26), seller, buyer, splitPayment: false,
});
const advanceInput = (extra: Row = {}) => ({
  ...common(render(1)), invoiceType: 'advance' as const, advanceAmount: 123,
  totalContractAmount: 1000, vatRate: '23' as const, description: 'Testowa zaliczka na usługę', ...extra,
});
const finalInput = (extra: Row = {}) => ({
  ...common(render(1)), invoiceType: 'final' as const, advanceInvoiceIds: [advanceId], totalAdvances: 123,
  lines: [{ name: 'Testowa usługa', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' as const }], ...extra,
});
const line = { name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' as const };
const correctionInput = (extra: Partial<CorrectionInvoiceSchemaIn> = {}): CorrectionInvoiceSchemaIn => ({
  invoiceType: 'correction', internalNumber: render(1), issueDate: DZIS,
  paymentMethod: 'transfer', paymentDueDate: '2026-11-25', parentInvoiceId: parentId,
  parentInvoiceNumber: 'FV/9/10/2026', parentInvoiceIssueDate: '2026-10-15',
  parentKsefNumber: '1234567890-20261015-ABCDEF', correctionType: 'before_after',
  correctionReason: 'Rabat po reklamacji', typKorekty: '2', seller, buyer,
  linesBefore: [line], linesAfter: [{ ...line, unitPriceNet: 800 }],
  ...extra,
});

const lastInsert = () => db.inserts.at(-1)!;
const fa3 = (row: Row) => row.fa3_data as Row;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db.invoices = [];
  db.inserts = [];
  db.counter = 0;
  db.rpcCalls = [];
  db.nextId = 1;
  mocks.requireAuth.mockResolvedValue({ supabase: { from, rpc }, user: { id: 'fixture-user' }, tenantId, role: 'owner' });
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('zwykła faktura: numer z licznika serii', () => {
  it('szkic: numer, seria, okres, licznik i klucz w INSERT; ten sam numer w fa3_data', async () => {
    const result = await saveDraftAction(regular(render(1), fromSeries()), tenantId);

    expect(result).toMatchObject({ success: true });
    expect(lastInsert()).toMatchObject({
      internal_number: 'FV/1/11/2026',
      number_series_id: SERIES,
      number_period: '2026-11',
      number_counter: 1,
      number_request_key: KEY_A,
    });
    expect(fa3(lastInsert()).internalNumber).toBe('FV/1/11/2026');
  });

  it('podpowiedź z formularza jest już zajęta: baza nadaje kolejny numer i ten numer idzie wszędzie', async () => {
    db.invoices.push({ id: 'inv-old', internal_number: render(1), number_counter: 1 });
    db.counter = 1;

    const result = await saveAndSendInvoiceAction(regular(render(1), fromSeries(render(1))), tenantId);

    expect(result).toMatchObject({ success: true });
    expect(lastInsert()).toMatchObject({ internal_number: 'FV/2/11/2026', number_counter: 2 });
    expect(fa3(lastInsert()).internalNumber).toBe('FV/2/11/2026');
    const enqueued = mocks.enqueue.mock.calls[0]![0] as { invoice: { internalNumber: string }; internalNumberForAudit: string };
    expect(enqueued.invoice.internalNumber).toBe('FV/2/11/2026');
    expect(enqueued.internalNumberForAudit).toBe('FV/2/11/2026');
  });

  it('dwa wystawienia naraz w jednej serii: dwie faktury z dwoma kolejnymi numerami', async () => {
    const [a, b] = await Promise.all([
      saveAndSendInvoiceAction(regular(render(1), fromSeries(render(1), KEY_A)), tenantId),
      saveAndSendInvoiceAction(regular(render(1), fromSeries(render(1), KEY_B)), tenantId),
    ]);

    expect([a.success, b.success]).toEqual([true, true]);
    expect(db.invoices.map((r) => r.internal_number).sort()).toEqual(['FV/1/11/2026', 'FV/2/11/2026']);
    const wyslane = mocks.enqueue.mock.calls.map((c) => (c[0] as { invoice: { internalNumber: string } }).invoice.internalNumber);
    expect(wyslane.sort()).toEqual(['FV/1/11/2026', 'FV/2/11/2026']);
  });

  it('podwójne kliknięcie (ten sam klucz zapisu): jedna faktura, drugi wynik podaje jej numer', async () => {
    const [a, b] = await Promise.all([
      saveAndSendInvoiceAction(regular(render(1), fromSeries(render(1), KEY_A)), tenantId),
      saveAndSendInvoiceAction(regular(render(1), fromSeries(render(1), KEY_A)), tenantId),
    ]);

    expect(db.invoices).toHaveLength(1);
    const odrzucony = [a, b].find((r) => !r.success);
    expect(odrzucony).toMatchObject({ success: false, invoiceId: db.invoices[0]!.id });
    expect(odrzucony && !odrzucony.success ? odrzucony.error : '').toContain('FV/1/11/2026');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('numer wpisany ręcznie w serii: numer z pola, seria bez licznika', async () => {
    const result = await saveDraftAction(regular('FV/50/11/2026', fromSeries(render(1))), tenantId);

    expect(result).toMatchObject({ success: true });
    expect(lastInsert()).toMatchObject({ internal_number: 'FV/50/11/2026', number_series_id: SERIES });
    expect(lastInsert()).not.toHaveProperty('number_counter');
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('formularz bez serii (dzisiejsza numeracja): wiersz bez nowych kolumn i bez wywołań numeracji', async () => {
    const result = await saveDraftAction(regular('FV/2026/11/007'), tenantId);

    expect(result).toMatchObject({ success: true });
    expect(lastInsert()).toMatchObject({ internal_number: 'FV/2026/11/007' });
    for (const column of ['number_series_id', 'number_period', 'number_counter', 'number_request_key']) {
      expect(lastInsert()).not.toHaveProperty(column);
    }
    expect(db.rpcCalls).toHaveLength(0);
  });
});

describe('zaliczkowa, końcowa i korekta: numer z licznika serii', () => {
  it('zaliczka: numer z bazy w kolumnie, w fa3_data i w kopercie zaliczki', async () => {
    db.invoices.push({ id: 'inv-old', internal_number: render(1), number_counter: 1 });
    db.counter = 1;

    const result = await saveAdvanceAction(advanceInput(fromSeries(render(1))), tenantId);

    expect(result).toMatchObject({ success: true });
    const row = lastInsert();
    expect(row).toMatchObject({ internal_number: 'FV/2/11/2026', invoice_kind: 'advance', number_counter: 2, number_series_id: SERIES });
    expect(fa3(row).internalNumber).toBe('FV/2/11/2026');
    expect((fa3(row).advanceEnvelope as Row).internalNumber).toBe('FV/2/11/2026');
  });

  it('faktura końcowa: numer z bazy w kolumnie i w danych faktury', async () => {
    const result = await saveFinalAction(finalInput(fromSeries(render(1))), tenantId);

    expect(result).toMatchObject({ success: true });
    const row = lastInsert();
    expect(row).toMatchObject({ internal_number: 'FV/1/11/2026', invoice_kind: 'final', number_counter: 1 });
    expect(fa3(row).internalNumber).toBe('FV/1/11/2026');
    expect(((row.special_data as Row).finalData as Row).internalNumber).toBe('FV/1/11/2026');
  });

  it('korekta: numer z bazy w kolumnie, fa3_data i danych korekty do ponowienia wysyłki', async () => {
    db.invoices.push({ id: 'inv-old', internal_number: render(1), number_counter: 1 });
    db.counter = 1;

    const result = await saveCorrectionDraftAction(correctionInput(fromSeries(render(1))), tenantId);

    expect(result).toMatchObject({ success: true });
    const row = lastInsert();
    expect(row).toMatchObject({ internal_number: 'FV/2/11/2026', invoice_kind: 'correction', number_counter: 2 });
    expect(fa3(row).internalNumber).toBe('FV/2/11/2026');
    expect(((row.special_data as Row).correctionData as Row).internalNumber).toBe('FV/2/11/2026');
  });

  it('zaliczka bez serii: wiersz bez nowych kolumn (dzisiejsza numeracja)', async () => {
    const result = await saveAdvanceAction(advanceInput({ internalNumber: 'ZAL/2026/11/1' }), tenantId);

    expect(result).toMatchObject({ success: true });
    expect(lastInsert()).toMatchObject({ internal_number: 'ZAL/2026/11/1' });
    expect(lastInsert()).not.toHaveProperty('number_series_id');
    expect(db.rpcCalls).toHaveLength(0);
  });
});
