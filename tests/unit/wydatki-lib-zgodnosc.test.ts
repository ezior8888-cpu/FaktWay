import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan aplikacji mobilnej 4.3, etap M9: logika `reviewExpenseAction`
 * i `getOcrJobStatusAction` (`app/actions/expenses.ts`) leży w
 * `lib/expenses/review.ts` i `lib/expenses/ocr-status.ts`, żeby trasy
 * `/api/mobile/v1/wydatki/*` wołały te same funkcje co strona. Wgranie zdjęcia
 * jest w `lib/expenses/accept-upload.ts` od sesji 31 planu skalowania.
 *
 * Test zgodności (charakterystyka): akcja strony i funkcja z `lib/` na tych
 * samych danych robią te same zapytania i zapisy w tej samej kolejności
 * (odczyt wydatku, waluta faktury KSeF, UPDATE albo RPC `review_ksef_expense`),
 * uczą się kategorii tymi samymi argumentami, odświeżają te same ścieżki
 * i oddają to samo. Atrapy tylko dla bazy (klient Supabase z sesji, klient
 * serwisowy) i granic: sesja z ciasteczek, uczenie reguł, `revalidatePath`.
 */

type Call = { table: string; op: string; payload?: unknown; filters: Array<[string, unknown]>; columns?: string };

const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  rpcResult: { data: 'exp-1' as string | null, error: null as { message: string } | null },
  expense: null as Record<string, unknown> | null,
  expenseError: null as { code: string; message: string } | null,
  invoiceCurrency: 'PLN' as string | null,
  updateResult: { data: { id: 'exp-1' } as { id: string } | null, error: null as { code?: string; message: string } | null },
  ocrJob: null as Record<string, unknown> | null,
  ocrError: null as { code: string; message: string } | null,
  learn: vi.fn(),
  revalidate: vi.fn(),
  auth: vi.fn(),
  createClient: vi.fn(),
}));

function fakeSupabase() {
  return {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] };
      mocks.calls.push(call);
      const q = {
        select: (columns?: string) => {
          if (call.op === 'select') call.columns = columns;
          return q;
        },
        eq: (column: string, value: unknown) => {
          call.filters.push([column, value]);
          return q;
        },
        update: (payload: unknown) => {
          call.op = 'update';
          call.payload = payload;
          return q;
        },
        maybeSingle: async () => {
          if (call.op === 'update') return mocks.updateResult;
          if (table === 'expenses') return { data: mocks.expense, error: mocks.expenseError };
          if (table === 'invoices') return { data: mocks.invoiceCurrency === null ? null : { currency: mocks.invoiceCurrency }, error: null };
          if (table === 'ocr_jobs') return { data: mocks.ocrJob, error: mocks.ocrError };
          return { data: null, error: null };
        },
      };
      return q;
    },
  };
}

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/categorization', () => ({ learnFromCorrection: mocks.learn }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: vi.fn() }));
vi.mock('@/lib/supabase/auth-context', () => ({ requireUserAndActiveOrg: mocks.auth }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      mocks.rpc.push({ fn, args });
      return mocks.rpcResult;
    },
  }),
}));

import { getOcrJobStatusAction, reviewExpenseAction } from '@/app/actions/expenses';
import { readOcrJobStatus } from '@/lib/expenses/ocr-status';
import { reviewExpense, type ExpenseReviewUpdates } from '@/lib/expenses/review';

const TENANT = 'ten-1';
const USER = 'u-1';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-13T09:00:00Z');

const ocrExpense = (extra: Record<string, unknown> = {}) => ({
  seller_nip: '1234567890',
  seller_name: 'Stacja Testowa',
  kpir_column: 'col_13',
  category_label: 'Pozostałe wydatki',
  vat_amount: 18.7,
  vat_deductible_amount: 18.7,
  is_deductible: true,
  source: 'ocr_photo',
  ksef_invoice_id: null,
  issue_date: '2026-11-10',
  ocr_extracted_data: { currency: 'PLN', ocr_confidence: 0.92 },
  updated_at: '2026-11-10T08:00:00Z',
  ...extra,
});

const ksefExpense = (extra: Record<string, unknown> = {}) =>
  ocrExpense({ source: 'ksef_inbox', ksef_invoice_id: 'inv-1', ocr_extracted_data: { source: 'ksef_inbox', currency: 'PLN' }, ...extra });

type Outcome = { result: unknown; calls: Call[]; rpc: typeof mocks.rpc; learn: unknown[][]; revalidate: unknown[][] };

function snapshot(result: unknown): Outcome {
  return {
    result,
    calls: structuredClone(mocks.calls),
    rpc: structuredClone(mocks.rpc),
    learn: mocks.learn.mock.calls.map((c) => [...c]),
    revalidate: mocks.revalidate.mock.calls.map((c) => [...c]),
  };
}

function reset() {
  mocks.calls = [];
  mocks.rpc = [];
  mocks.learn.mockClear();
  mocks.revalidate.mockClear();
}

/** Akcja strony i funkcja z `lib/` na tym samym stanie bazy. */
async function bothReview(expenseId: string, updates: ExpenseReviewUpdates) {
  reset();
  const action = snapshot(await reviewExpenseAction(expenseId, structuredClone(updates)));
  reset();
  const lib = await reviewExpense({ supabase: fakeSupabase() as never, userId: USER, tenantId: TENANT }, expenseId, structuredClone(updates));
  return { action, lib: snapshot(lib) };
}

/** Wynik akcji to wynik `lib/` bez powodu odmowy (`reason` jest tylko dla tras telefonu). */
function asAction(result: unknown) {
  const r = result as { success: boolean; error?: string };
  return r.success ? { success: true } : { success: false, error: r.error };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.expense = null;
  mocks.expenseError = null;
  mocks.invoiceCurrency = 'PLN';
  mocks.updateResult = { data: { id: 'exp-1' }, error: null };
  mocks.rpcResult = { data: 'exp-1', error: null };
  mocks.ocrJob = null;
  mocks.ocrError = null;
  mocks.learn.mockReset();
  mocks.createClient.mockReset();
  mocks.createClient.mockImplementation(async () => fakeSupabase());
  mocks.auth.mockReset();
  mocks.auth.mockImplementation(async () => ({ supabase: fakeSupabase(), user: { id: USER }, tenantId: TENANT, role: 'member' }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reviewExpense z lib/ robi to samo co reviewExpenseAction', () => {
  const cases: Array<{ name: string; expense: () => Record<string, unknown> | null; updates: ExpenseReviewUpdates; setup?: () => void }> = [
    {
      name: 'koszt ze zdjęcia: nowa kategoria i VAT (uczenie reguły, odliczenie od nowa)',
      expense: () => ocrExpense(),
      updates: {
        seller_name: 'Stacja Testowa',
        seller_nip: '1234567890',
        document_number: '0051/2026',
        issue_date: '2026-11-10',
        net_amount: 81.3,
        vat_amount: 10,
        gross_amount: 91.3,
        kpir_column: 'col_13',
        category_label: 'Paliwo',
        is_deductible: true,
        confirmForeignCurrencyReview: false,
        notes: 'Delegacja',
      },
    },
    {
      name: 'koszt ze zdjęcia bez zmian (same wartości z odczytu)',
      expense: () => ocrExpense(),
      updates: { seller_name: 'Stacja Testowa', vat_amount: 18.7, kpir_column: 'col_13', category_label: 'Pozostałe wydatki', is_deductible: true },
    },
    {
      name: 'koszt ze zdjęcia w EUR bez kursu: potwierdzenie złotych',
      expense: () => ocrExpense({ is_deductible: false, ocr_extracted_data: { currency: 'EUR', gross_amount: 25 } }),
      updates: { gross_amount: 107.5, net_amount: 87.4, vat_amount: 20.1, is_deductible: false, confirmPlnAmounts: true },
    },
    {
      name: 'koszt ze zdjęcia w EUR bez kursu: KPiR bez potwierdzenia to odmowa',
      expense: () => ocrExpense({ is_deductible: false, ocr_extracted_data: { currency: 'EUR' } }),
      updates: { is_deductible: true },
    },
    {
      name: 'koszt ze zdjęcia w EUR bez kursu: zapis poza KPiR zostaje do opisania',
      expense: () => ocrExpense({ is_deductible: false, ocr_extracted_data: { currency: 'EUR' } }),
      updates: { is_deductible: false, notes: 'Hotel' },
    },
    {
      name: 'koszt z KSeF w złotych: RPC z kluczem serwisowym',
      expense: () => ksefExpense(),
      updates: { kpir_column: 'col_10', category_label: 'Materiały biurowe', is_deductible: true },
    },
    {
      name: 'koszt z KSeF: RPC oddaje inny identyfikator (zmiana w międzyczasie)',
      expense: () => ksefExpense(),
      updates: { is_deductible: true },
      setup: () => {
        mocks.rpcResult = { data: null, error: null };
      },
    },
    {
      name: 'koszt z KSeF: błąd RPC',
      expense: () => ksefExpense(),
      updates: { is_deductible: true },
      setup: () => {
        mocks.rpcResult = { data: null, error: { message: 'boom' } };
      },
    },
    {
      name: 'koszt z KSeF: pole spoza schematu KSeF',
      expense: () => ksefExpense(),
      updates: { is_deductible: true, confirmPlnAmounts: true },
    },
    {
      name: 'koszt z KSeF w EUR bez potwierdzenia porównania',
      expense: () => ksefExpense(),
      updates: { is_deductible: true },
      setup: () => {
        mocks.invoiceCurrency = 'EUR';
      },
    },
    {
      name: 'niespójne powiązanie z KSeF (faktura bez źródła ksef_inbox)',
      expense: () => ocrExpense({ ksef_invoice_id: 'inv-1' }),
      updates: { is_deductible: true },
    },
    { name: 'wydatku nie ma', expense: () => null, updates: { is_deductible: true } },
    {
      name: 'błąd odczytu wydatku (strona mówi „nie istnieje”)',
      expense: () => null,
      updates: { is_deductible: true },
      setup: () => {
        mocks.expenseError = { code: '08006', message: 'connection lost' };
      },
    },
    {
      name: 'UPDATE nie trafił w wiersz',
      expense: () => ocrExpense(),
      updates: { is_deductible: true },
      setup: () => {
        mocks.updateResult = { data: null, error: null };
      },
    },
    {
      name: 'UPDATE z błędem bazy',
      expense: () => ocrExpense(),
      updates: { is_deductible: true },
      setup: () => {
        mocks.updateResult = { data: null, error: { code: '23514', message: 'check violated' } };
      },
    },
    {
      name: 'uczenie reguły rzuca: zapis i tak się udaje',
      expense: () => ocrExpense(),
      updates: { category_label: 'Paliwo' },
      setup: () => {
        mocks.learn.mockRejectedValue(new Error('rule failed'));
      },
    },
  ];

  it.each(cases)('$name', async ({ expense, updates, setup }) => {
    mocks.expense = expense();
    setup?.();
    const { action, lib } = await bothReview('exp-1', updates);
    expect(action.calls).toEqual(lib.calls);
    expect(action.rpc).toEqual(lib.rpc);
    expect(action.learn).toEqual(lib.learn);
    expect(action.revalidate).toEqual(lib.revalidate);
    expect(action.result).toEqual(asAction(lib.result));
  });

  it('akcja bez sesji: „Brak autoryzacji” bez zapytań', async () => {
    mocks.auth.mockRejectedValue(new Error('Niezalogowany'));
    reset();
    expect(await reviewExpenseAction('exp-1', { is_deductible: true })).toEqual({ success: false, error: 'Brak autoryzacji' });
    expect(mocks.calls).toEqual([]);
  });
});

describe('reviewExpense: powód odmowy dla tras telefonu', () => {
  const ctx = () => ({ supabase: fakeSupabase() as never, userId: USER, tenantId: TENANT });

  it.each([
    ['brak wiersza', () => { mocks.expense = null; }, 'not_found'],
    ['błąd odczytu', () => { mocks.expense = null; mocks.expenseError = { code: '08006', message: 'x' }; }, 'read_failed'],
    ['zasada waluty', () => { mocks.expense = ocrExpense({ is_deductible: false, ocr_extracted_data: { currency: 'EUR' } }); }, 'refused'],
    ['UPDATE bez wiersza', () => { mocks.expense = ocrExpense(); mocks.updateResult = { data: null, error: null }; }, 'not_found'],
    ['UPDATE z błędem', () => { mocks.expense = ocrExpense(); mocks.updateResult = { data: null, error: { message: 'x' } }; }, 'write_failed'],
    ['KSeF: zmiana w międzyczasie', () => { mocks.expense = ksefExpense(); mocks.rpcResult = { data: null, error: null }; }, 'conflict'],
    ['KSeF: błąd RPC', () => { mocks.expense = ksefExpense(); mocks.rpcResult = { data: null, error: { message: 'x' } }; }, 'write_failed'],
    ['KSeF: pole spoza schematu', () => { mocks.expense = ksefExpense(); }, 'invalid'],
  ])('%s → %s', async (_name, setup, reason) => {
    setup();
    const updates: ExpenseReviewUpdates = reason === 'invalid' ? { is_deductible: true, confirmPlnAmounts: true } : { is_deductible: true };
    const result = await reviewExpense(ctx(), 'exp-1', updates);
    expect(result).toMatchObject({ success: false, reason });
  });

  it('refuseKsef: koszt z KSeF odrzucony przed zapisem, bez RPC i bez odczytu faktury', async () => {
    mocks.expense = ksefExpense();
    reset();
    const result = await reviewExpense(ctx(), 'exp-1', { is_deductible: true }, { refuseKsef: true });
    expect(result).toMatchObject({ success: false, reason: 'ksef' });
    expect(mocks.rpc).toEqual([]);
    expect(mocks.calls.map((c) => c.table)).toEqual(['expenses']);
  });

  it('refuseKsef nie dotyczy kosztu ze zdjęcia', async () => {
    mocks.expense = ocrExpense();
    expect(await reviewExpense(ctx(), 'exp-1', { is_deductible: true }, { refuseKsef: true })).toEqual({ success: true });
  });
});

describe('readOcrJobStatus z lib/ robi to samo co getOcrJobStatusAction', () => {
  const job = { id: JOB_ID, status: 'completed', error_message: null, expense_id: 'exp-1', extracted_data: null };

  it.each([
    ['zadanie jest', () => { mocks.ocrJob = job; }],
    ['zadania nie ma', () => { mocks.ocrJob = null; }],
    ['błąd odczytu', () => { mocks.ocrError = { code: '08006', message: 'connection lost' }; }],
  ])('%s', async (_name, setup) => {
    setup();
    reset();
    const action = snapshot(await getOcrJobStatusAction(JOB_ID));
    reset();
    const lib = snapshot(await readOcrJobStatus(fakeSupabase() as never, JOB_ID));
    expect(action).toEqual(lib);
  });

  it('nie-UUID: bez zapytania do bazy w obu', async () => {
    reset();
    expect(await readOcrJobStatus(fakeSupabase() as never, 'job-1')).toEqual(await getOcrJobStatusAction('job-1'));
    expect(mocks.calls).toEqual([]);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
