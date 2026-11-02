import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ db: vi.fn(), enqueue: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => mocks.db() }));
vi.mock('@/lib/supabase/active-org', () => ({ getActiveOrgIdFromCookies: async () => 'firma-a' }));
// Akcje dokumentów specjalnych idą przez sesję po MFA i członkostwo (#71).
vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: async () => {
    const { createClient } = await import('@/lib/supabase/server');
    return { supabase: await createClient(), user: { id: 'fixture-user' }, tenantId: 'firma-a' };
  },
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: mocks.enqueue }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));

import { saveAndSendFinalAction, saveFinalAction } from '@/components/invoices/final-actions';
import { ROZ_SUBMISSION_HOLD_MESSAGE } from '@/lib/ksef/roz-submission-hold';
import { settlementRowFromAdvance, type AdvanceInvoiceDbRow } from '@/lib/invoices/advance-settlement';

/**
 * Akcja „Wystaw i wyślij” faktury rozliczającej: wiersze zaliczek muszą nieść
 * stawkę i rozbicie z faktur zaliczkowych (ROZ odejmuje je w P_13_x/P_14_x),
 * a zaliczka, której nie da się odjąć, wraca do formularza PRZED zapisem.
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let inserts: Array<{ table: string; value: unknown }>;

function database() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from(table: string) {
      const predicates: Array<(r: Row) => boolean> = [];
      let columns: string[] | null = null;
      let singular = false;
      let inserted: Row | null = null;
      const query = {
        select(selection = '*') {
          const parts = selection.split(',').map((s) => s.trim()).filter(Boolean);
          columns = parts.includes('*') ? null : parts;
          return query;
        },
        insert(value: Row | Row[]) {
          inserts.push({ table, value });
          inserted = Array.isArray(value) ? null : { id: 'roz-nowa', ...value };
          return query;
        },
        delete() { return query; },
        eq(k: string, v: unknown) { predicates.push((r) => r[k] === v); return query; },
        in(k: string, vs: unknown[]) { predicates.push((r) => vs.includes(r[k])); return query; },
        overlaps(k: string, vs: unknown[]) {
          predicates.push((r) => Array.isArray(r[k]) && (r[k] as unknown[]).some((v) => vs.includes(v)));
          return query;
        },
        // Tylko forma używana przez `findAdvancesAlreadySettled`.
        or(expr: string) {
          expect(expr).toBe('ksef_status.is.null,ksef_status.neq.rejected');
          predicates.push((r) => r.ksef_status == null || r.ksef_status !== 'rejected');
          return query;
        },
        single() { singular = true; return query; },
        maybeSingle() { singular = true; return query; },
        then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
          const project = (r: Row): Row => (columns ? Object.fromEntries(columns.map((c) => [c, r[c]])) : r);
          const rows = inserted ? [inserted] : (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)));
          const data = rows.map(project);
          return Promise.resolve({ data: singular ? data[0] ?? null : data, error: null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

const ZAL_23 = '11111111-1111-4111-8111-111111111111';
const ZAL_8 = '22222222-2222-4222-8222-222222222222';
const ZAL_5 = '33333333-3333-4333-8333-333333333333';

function zaliczka(id: string, gross: number, net: number, vat: number, rate: string): Row {
  return {
    id, tenant_id: 'firma-a', direction: 'outgoing', ksef_status: 'accepted', invoice_kind: 'advance',
    internal_number: `ZAL/${rate}`, ksef_number: null, issue_date: '2026-08-01',
    advance_amount: gross, gross_total: gross, net_total: net, vat_total: vat,
    fa3_data: { lines: [{ vatRate: rate, netAmount: net }] },
  };
}

function formularz(advanceInvoiceIds: string[], totalAdvances: number) {
  return {
    invoiceType: 'final',
    internalNumber: 'FR/2026/09/1',
    issueDate: '2026-09-20',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-10-04',
    bankAccount: '61109010140000071219812874',
    seller: { nip: '5260001246', name: 'ACME', address: { addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa', countryCode: 'PL' } },
    buyer: { type: 'b2b', idType: 'nip', nip: '5252241585', name: 'Klient', address: { addressLine1: 'ul. K 10', addressLine2: '02-001 Warszawa', countryCode: 'PL' } },
    splitPayment: false,
    advanceInvoiceIds,
    totalAdvances,
    // Dwie stawki — bez stawki zaliczki z bazy rozbicie musiałoby się wywrócić.
    lines: [
      { name: 'Wdrożenie', unit: 'usł.', quantity: 3, unitPriceNet: 10000, vatRate: '23' },
      { name: 'Szkolenie', unit: 'usł.', quantity: 1, unitPriceNet: 1000, vatRate: '8' },
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  // Wysyłka przyjmuje tylko dzisiejszą datę wystawienia (A1, W5) — testy
  // działają w dniu daty z danych testowych (2026-09-20).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-20T10:00:00Z'));
  tables = {
    // Pełny profil sprzedawcy — #85 bierze sprzedawcę z firmy, nie z formularza.
    tenants: [{ id: 'firma-a', nip: '5260001246', name: 'ACME', vat_cash_method: false, address_json: { addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa', countryCode: 'PL' } }],
    invoices: [
      zaliczka(ZAL_23, 12300, 10000, 2300, '23'),
      zaliczka(ZAL_8, 1080, 1000, 80, '8'),
      zaliczka(ZAL_5, 1050, 1000, 50, '5'),
    ],
  };
  inserts = [];
  mocks.db.mockReset().mockImplementation(database);
  mocks.enqueue.mockReset().mockResolvedValue({ ok: true, mode: 'queued' });
});

describe('faktura rozliczeniowa — zaliczki ze stawką', () => {
  it('można zapisać szkic z zaakceptowanymi zaliczkami', async () => {
    const wynik = await saveFinalAction(formularz([ZAL_23, ZAL_8], 13380), 'firma-a');
    expect(wynik).toMatchObject({ success: true });
    expect(inserts[0]).toMatchObject({
      table: 'invoices',
      value: { invoice_kind: 'final', invoice_type: 'ROZ', advance_invoice_ids: [ZAL_23, ZAL_8] },
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('A4b (00137): szkic zapisuje na wierszu finalData i wiersze rozliczenia zaliczek (te, które pójdą w zdarzeniu)', async () => {
    const wynik = await saveFinalAction(formularz([ZAL_23, ZAL_8], 13380), 'firma-a');
    expect(wynik).toMatchObject({ success: true });
    const value = inserts[0]?.value as Row;
    expect(value.special_data, 'INSERT ROZ bez special_data').toBeDefined();
    const special = JSON.parse(JSON.stringify(value.special_data)) as Record<string, Row & Row[]>;
    expect(Object.keys(special).sort()).toEqual(['finalAdvanceSettlementRows', 'finalData']);
    // Wiersze rozliczenia — ze stawką i rozbiciem z faktur zaliczkowych, w kolejności wyboru.
    const expectedRows = [ZAL_23, ZAL_8].map((id) =>
      settlementRowFromAdvance(tables.invoices.find((r) => r.id === id) as unknown as AdvanceInvoiceDbRow));
    expect(special.finalAdvanceSettlementRows).toEqual(JSON.parse(JSON.stringify(expectedRows)));
    expect(special.finalData).toMatchObject({
      invoiceType: 'final', internalNumber: 'FR/2026/09/1', advanceInvoiceIds: [ZAL_23, ZAL_8],
      seller: { nip: '5260001246', name: 'ACME' },
    });
  });

  it('zaliczka wskazana w innej ROZ nie trafi do drugiej; odrzucona ROZ ją zwalnia (AUD-67)', async () => {
    const roz = (id: string, status: string): Row => ({
      id, tenant_id: 'firma-a', direction: 'outgoing', invoice_kind: 'final', ksef_status: status,
      internal_number: `FR/${id}`, advance_invoice_ids: [ZAL_23],
    });
    tables.invoices.push(roz('odrzucona', 'rejected'));
    expect(await saveFinalAction(formularz([ZAL_23, ZAL_8], 13380), 'firma-a')).toMatchObject({ success: true });

    inserts = [];
    tables.invoices.push(roz('szkic', 'draft'));
    const wynik = await saveFinalAction(formularz([ZAL_23, ZAL_8], 13380), 'firma-a');
    expect(wynik).toMatchObject({ success: false, error: expect.stringContaining('FR/szkic') });
    expect(inserts).toEqual([]);
  });

  it('zaliczka w stawce spoza zamówienia wraca do formularza — bez szkicu i bez wysyłki', async () => {
    const wynik = await saveFinalAction(formularz([ZAL_23, ZAL_5], 13350), 'firma-a');
    expect(wynik).toMatchObject({ success: false });
    expect((wynik as { error: string }).error).toMatch(/nie ma pozycji w tej stawce/);
    expect(inserts).toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each(['test', 'production'])(
    'wstrzymuje wysyłkę ROZ przy KSEF_ENV=%s, zanim zapisze szkic lub zleci job',
    async (env) => {
      vi.stubEnv('KSEF_ENV', env);
      // Prior-period accepted ZAL can come from the other environment; the
      // existing invoice row does not record its KSeF environment.
      tables.invoices[0].issue_date = '2026-08-01';
      tables.invoices[0].ksef_number = '5260001246-20260801-0000000000-00';

      const wynik = await saveAndSendFinalAction(formularz([ZAL_23], 12300), 'firma-a');
      expect(wynik).toEqual({ success: false, error: ROZ_SUBMISSION_HOLD_MESSAGE });
      expect(inserts).toEqual([]);
      expect(mocks.enqueue).not.toHaveBeenCalled();
    },
  );
});
