import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Zapis faktury otwartej z proformy albo oferty (plan kompletnej aplikacji,
 * krok 2.4) na prawdziwej ścieżce akcji (`saveDraftAction`,
 * `saveAndSendInvoiceAction`, `saveAdvanceAction`). Powiązanie z dokumentem
 * i numer kolejnej zamiany idą w TYM SAMYM INSERT co faktura; unikalny indeks
 * `uq_invoices_sales_quote_seq` (00198) przepuszcza jedną fakturę na numer
 * zamiany, więc ta sama proforma nie da drugiej faktury bez potwierdzenia
 * (potwierdzenie = kolejny numer zamiany z ekranu dokumentu). Atrapa to tylko
 * baza w pamięci z oboma unikalnymi indeksami faktur i kolejka KSeF; indeks,
 * klucz złożony i wyzwalacze na prawdziwym Postgresie: tests/rls-proformy.test.ts.
 *
 * NIP-y: formularz faktury sprawdza sumę kontrolną, więc zamiast `1234567890`
 * (suma kontrolna 10, czyli NIP niepoprawny) fikcyjne NIP-y z jednej cyfry,
 * jak w tests/fixtures/import-wiersze.
 */

type Row = Record<string, unknown>;

const TENANT = 'ten-1';
const DOKUMENT = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';
const SPRZEDAWCA_NIP = '2222222222';
const NABYWCA_NIP = '1111111111';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), audit: vi.fn(), enqueue: vi.fn(), gus: vi.fn() }));

const state = {
  invoices: [] as Row[],
  invoice_line_items: [] as Row[],
  tenants: [] as Row[],
  sales_quotes: [] as Row[],
  invoiceInserts: [] as Row[],
  nextId: 1,
};

function unique(row: Row): { code: string; message: string; details: string } | null {
  if (state.invoices.some((r) => r.tenant_id === row.tenant_id && r.internal_number === row.internal_number)) {
    return {
      code: '23505',
      message: 'duplicate key value violates unique constraint "uq_invoices_tenant_outgoing_internal_number"',
      details: 'Key (tenant_id, internal_number) already exists.',
    };
  }
  if (row.sales_quote_id != null && state.invoices.some(
    (r) => r.tenant_id === row.tenant_id && r.sales_quote_id === row.sales_quote_id && r.sales_quote_seq === row.sales_quote_seq,
  )) {
    return {
      code: '23505',
      message: 'duplicate key value violates unique constraint "uq_invoices_sales_quote_seq"',
      details: 'Key (tenant_id, sales_quote_id, sales_quote_seq) already exists.',
    };
  }
  return null;
}

function fakeSupabase() {
  return {
    from(name: string) {
      const filters: Array<[string, unknown]> = [];
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let payload: Row | Row[] | null = null;
      const rows = () => ((state as unknown as Record<string, Row[]>)[name] ??= []);
      const matches = (r: Row) => filters.every(([k, v]) => r[k] === v);
      const run = async (): Promise<{ data: Row[] | null; error: Row | null }> => {
        // Jedno okrążenie sieci: dwa równoległe zapisy przeplatają się jak na produkcji.
        await new Promise((r) => setTimeout(r, 0));
        if (op === 'insert') {
          const out: Row[] = [];
          for (const p of Array.isArray(payload) ? payload : [payload!]) {
            if (name === 'invoices') {
              state.invoiceInserts.push(p);
              const conflict = unique(p);
              if (conflict) return { data: null, error: conflict };
            }
            const row = { id: `${name}-${state.nextId++}`, ...p };
            rows().push(row);
            out.push(row);
          }
          return { data: out, error: null };
        }
        if (op === 'update') {
          const hit = rows().filter(matches);
          hit.forEach((r) => Object.assign(r, payload));
          return { data: hit, error: null };
        }
        if (op === 'delete') {
          const hit = rows().filter(matches);
          const keep = rows().filter((r) => !matches(r));
          rows().splice(0, rows().length, ...keep);
          return { data: hit, error: null };
        }
        return { data: rows().filter(matches), error: null };
      };
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return q;
        },
        order: () => q,
        limit: () => q,
        not: () => q,
        insert: (p: Row | Row[]) => {
          op = 'insert';
          payload = p;
          return q;
        },
        update: (p: Row) => {
          op = 'update';
          payload = p;
          return q;
        },
        delete: () => {
          op = 'delete';
          return q;
        },
        maybeSingle: async () => {
          const r = await run();
          return { data: r.data?.[0] ?? null, error: r.error };
        },
        single: async () => {
          const r = await run();
          return { data: r.data?.[0] ?? null, error: r.error };
        },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => run().then(ok, fail),
      };
      return q;
    },
  };
}

vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: mocks.auth,
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: mocks.enqueue }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: mocks.gus }));

import { saveAdvanceAction } from '@/components/invoices/advance-actions';
import { saveAndSendInvoiceAction, saveDraftAction } from '@/components/invoices/actions';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

// 11.11.2026 11:00 w Polsce.
const NOW = new Date('2026-11-11T10:00:00Z');
const DZIS = '2026-11-11';

function formularz(internalNumber: string, extra: Partial<InvoiceFormValues> = {}): InvoiceFormValues {
  return {
    internalNumber, issueDate: DZIS, saleDate: '',
    buyerNip: NABYWCA_NIP, buyerName: 'Kontrahent Testowy', buyerAddressLine1: 'ul. Klienta 10',
    buyerAddressLine2: '02-001 Warszawa', buyerEmail: '', buyerIsConsumer: false,
    buyerPesel: '', buyerIdDocument: '', paymentMethod: 'transfer', paymentDueDate: '2026-11-25',
    bankAccount: 'PL61109010140000071219812874',
    lines: [{ name: 'Wdrożenie systemu', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' }],
    ...extra,
  };
}

/** Formularz otwarty z proformy: dokument i numer zamiany z ukrytych pól. */
const zDokumentu = (internalNumber: string, seq = '1', extra: Partial<InvoiceFormValues> = {}) =>
  formularz(internalNumber, { salesQuoteId: DOKUMENT, salesQuoteSeq: seq, ...extra });

function zaliczka(extra: Record<string, unknown> = {}) {
  return {
    invoiceType: 'advance',
    internalNumber: 'ZAL/1/11/2026',
    issueDate: DZIS,
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-25',
    bankAccount: '61109010140000071219812874',
    splitPayment: false,
    notes: '',
    seller: { nip: SPRZEDAWCA_NIP, name: 'Moja Firma', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
    buyer: { type: 'b2b', idType: 'nip', nip: NABYWCA_NIP, name: 'Kontrahent Testowy', address: { addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa', countryCode: 'PL' } },
    advanceAmount: 1230,
    totalContractAmount: 1230,
    vatRate: '23',
    description: 'Zamówienie według proformy PRO/1/2026',
    ...extra,
  };
}

function fakturyDokumentu(): Row[] {
  return state.invoices.filter((r) => r.sales_quote_id === DOKUMENT);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.invoices = [];
  state.invoice_line_items = [];
  state.invoiceInserts = [];
  state.tenants = [{
    id: TENANT, nip: SPRZEDAWCA_NIP, name: 'Moja Firma',
    address_json: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' },
    vat_exemption_basis: null, vat_cash_method: false,
  }];
  state.sales_quotes = [{ id: DOKUMENT, tenant_id: TENANT, kind: 'proforma', status: 'issued', number: 'PRO/1/2026' }];
  mocks.auth.mockResolvedValue({ supabase: fakeSupabase(), user: { id: 'user-1' }, tenantId: TENANT, role: 'owner' });
  mocks.enqueue.mockImplementation(async ({ invoiceId }: { invoiceId: string }) => {
    const row = state.invoices.find((r) => r.id === invoiceId);
    if (row) row.ksef_status = 'queued';
    return { ok: true, mode: 'online_queued' };
  });
});

describe('faktura z proformy: zapis powiązania', () => {
  it('„Zapisz szkic”: powiązanie i numer zamiany w tym samym INSERT, bez wysyłki do KSeF, audyt zamiany', async () => {
    const r = await saveDraftAction(zDokumentu('FV/1/11/2026'), TENANT);

    expect(r).toMatchObject({ success: true });
    expect(state.invoiceInserts).toHaveLength(1);
    expect(state.invoiceInserts[0]).toMatchObject({ sales_quote_id: DOKUMENT, sales_quote_seq: 1, ksef_status: 'draft' });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'sales_quote.converted',
      tenantId: TENANT,
      entityType: 'sales_quote',
      entityId: DOKUMENT,
      metadata: expect.objectContaining({ invoiceKind: 'regular', seq: 1, internalNumber: 'FV/1/11/2026', quoteNumber: 'PRO/1/2026' }),
    }));
  });

  it('„Wystaw i wyślij”: jedna wysyłka, faktura powiązana z dokumentem', async () => {
    const r = await saveAndSendInvoiceAction(zDokumentu('FV/1/11/2026'), TENANT);
    expect(r).toMatchObject({ success: true });
    expect(fakturyDokumentu()).toHaveLength(1);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('drugi raz ta sama proforma bez potwierdzenia (numer zamiany już zajęty): odmowa przed zapisem, z numerem faktury', async () => {
    state.invoices = [{ id: 'inv-0', tenant_id: TENANT, internal_number: 'FV/9/10/2026', invoice_kind: 'regular', ksef_status: 'accepted', sales_quote_id: DOKUMENT, sales_quote_seq: 1 }];

    const r = await saveDraftAction(zDokumentu('FV/1/11/2026'), TENANT);

    expect(r).toMatchObject({ success: false, error: expect.stringContaining('FV/9/10/2026') });
    expect(state.invoiceInserts).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('kolejna faktura po potwierdzeniu (następny numer zamiany): zapis', async () => {
    state.invoices = [{ id: 'inv-0', tenant_id: TENANT, internal_number: 'ZAL/9/10/2026', invoice_kind: 'advance', ksef_status: 'accepted', sales_quote_id: DOKUMENT, sales_quote_seq: 1 }];
    const r = await saveDraftAction(zDokumentu('FV/1/11/2026', '2'), TENANT);
    expect(r).toMatchObject({ success: true });
    expect(state.invoiceInserts[0]).toMatchObject({ sales_quote_id: DOKUMENT, sales_quote_seq: 2 });
    expect(fakturyDokumentu()).toHaveLength(2);
  });

  it('dwa zapisy naraz z tego samego formularza: jedna faktura, druga odmowa z numerem tej pierwszej', async () => {
    const [a, b] = await Promise.all([
      saveAndSendInvoiceAction(zDokumentu('FV/1/11/2026'), TENANT),
      saveAndSendInvoiceAction(zDokumentu('FV/2/11/2026'), TENANT),
    ]);
    const wyniki = [a, b];
    expect(wyniki.filter((w) => w.success)).toHaveLength(1);
    expect(fakturyDokumentu()).toHaveLength(1);
    const numer = String(fakturyDokumentu()[0]!.internal_number);
    expect(wyniki.find((w) => !w.success)).toMatchObject({ success: false, error: expect.stringContaining(numer) });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('ponowienie tego samego zapisu po udanym zapisie: bez drugiej faktury', async () => {
    await expect(saveDraftAction(zDokumentu('FV/1/11/2026'), TENANT)).resolves.toMatchObject({ success: true });
    const ponowienie = await saveDraftAction(zDokumentu('FV/1/11/2026'), TENANT);
    expect(ponowienie).toMatchObject({ success: false, error: expect.stringContaining('FV/1/11/2026') });
    expect(fakturyDokumentu()).toHaveLength(1);
  });

  it.each([
    ['szkic dokumentu (bez numeru)', { status: 'draft', number: null }],
    ['dokument innej firmy', { tenant_id: 'ten-2' }],
  ])('%s: odmowa bez zapisu faktury', async (_opis, zmiana) => {
    state.sales_quotes = [{ ...state.sales_quotes[0]!, ...zmiana }];
    const r = await saveDraftAction(zDokumentu('FV/1/11/2026'), TENANT);
    expect(r).toMatchObject({ success: false });
    expect(state.invoiceInserts).toEqual([]);
  });

  it('numer zamiany bez dokumentu: odmowa schematu, bez zapisu', async () => {
    const r = await saveDraftAction(formularz('FV/1/11/2026', { salesQuoteSeq: '1' }), TENANT);
    expect(r).toMatchObject({ success: false });
    expect(state.invoiceInserts).toEqual([]);
  });

  it('zwykła faktura bez dokumentu: INSERT bez kolumn powiązania (jak przed zmianą)', async () => {
    await expect(saveDraftAction(formularz('FV/1/11/2026'), TENANT)).resolves.toMatchObject({ success: true });
    expect(state.invoiceInserts[0]).not.toHaveProperty('sales_quote_id');
    expect(state.invoiceInserts[0]).not.toHaveProperty('sales_quote_seq');
    expect(mocks.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'sales_quote.converted' }));
  });
});

describe('faktura zaliczkowa z proformy: zapis powiązania', () => {
  it('szkic zaliczki z powiązaniem w tym samym INSERT i audytem zamiany', async () => {
    const r = await saveAdvanceAction(zaliczka({ salesQuoteId: DOKUMENT, salesQuoteSeq: '1' }), TENANT);
    expect(r).toMatchObject({ success: true });
    expect(state.invoiceInserts[0]).toMatchObject({ invoice_kind: 'advance', sales_quote_id: DOKUMENT, sales_quote_seq: 1 });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'sales_quote.converted',
      entityId: DOKUMENT,
      metadata: expect.objectContaining({ invoiceKind: 'advance', seq: 1 }),
    }));
  });

  it('numer zamiany zajęty: odmowa przed zapisem zaliczki', async () => {
    state.invoices = [{ id: 'inv-0', tenant_id: TENANT, internal_number: 'FV/9/10/2026', invoice_kind: 'regular', ksef_status: 'draft', sales_quote_id: DOKUMENT, sales_quote_seq: 1 }];
    const r = await saveAdvanceAction(zaliczka({ salesQuoteId: DOKUMENT, salesQuoteSeq: '1' }), TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringContaining('FV/9/10/2026') });
    expect(state.invoiceInserts).toEqual([]);
  });

  it('zaliczka bez dokumentu: INSERT bez kolumn powiązania', async () => {
    await expect(saveAdvanceAction(zaliczka(), TENANT)).resolves.toMatchObject({ success: true });
    expect(state.invoiceInserts[0]).not.toHaveProperty('sales_quote_id');
  });
});
