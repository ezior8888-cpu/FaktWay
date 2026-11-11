import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Faktura do paragonu (FP, plan kompletnej aplikacji, krok 1.2) w formularzu
 * zwykłej faktury: ten sam schemat Zod w przeglądarce i w akcji serwera
 * (`invoiceFormSchema`), potem prawdziwa akcja `saveAndSendInvoiceAction`
 * z bazą w pamięci i atrapą kolejki KSeF. Zlecenie wysyłki niesie paragon,
 * a XML z niego ma FP i przechodzi oficjalny XSD FA(3).
 */

type Row = Record<string, unknown>;

const TENANT = 'ten-1';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  audit: vi.fn(),
  enqueue: vi.fn(),
  gus: vi.fn(),
}));

const state = {
  invoices: [] as Row[],
  invoice_line_items: [] as Row[],
  tenants: [] as Row[],
  invoiceInserts: [] as Row[],
  nextId: 1,
};

function fakeSupabase() {
  return {
    from(name: string) {
      const filters: Array<[string, unknown]> = [];
      let op: 'select' | 'insert' = 'select';
      let payload: Row | Row[] | null = null;
      const rows = () => (state as unknown as Record<string, Row[]>)[name] ?? [];
      const run = async (): Promise<{ data: Row[] | null; error: Row | null }> => {
        if (op === 'insert') {
          const list = Array.isArray(payload) ? payload : [payload!];
          const out = list.map((p) => {
            if (name === 'invoices') state.invoiceInserts.push(p);
            const row = { id: `${name}-${state.nextId++}`, ...p };
            rows().push(row);
            return row;
          });
          return { data: out, error: null };
        }
        return { data: rows().filter((r) => filters.every(([k, v]) => r[k] === v)), error: null };
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
        delete: () => q,
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

import { saveAndSendInvoiceAction, saveDraftAction } from '@/components/invoices/actions';
import { invoiceFormSchema, type InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { validateInvoiceXml } from '@/lib/xml/validator';
import type { Invoice } from '@/types/invoice';

// 9.11.2026 10:00 w Polsce: wysyłka tylko z dzisiejszą datą (A1).
const NOW = new Date('2026-11-09T09:00:00Z');
const DZIS = '2026-11-09';

/** Firma z NIP, paragon z 15.10.2026 na 1230 zł brutto. */
function formularz(extra: Record<string, unknown> = {}): InvoiceFormValues {
  return {
    internalNumber: 'FV/5/11/2026',
    issueDate: DZIS,
    saleDate: '2026-10-15',
    buyerNip: '5252241585',
    buyerName: 'Klient Sp. z o.o.',
    buyerAddressLine1: 'ul. Klienta 10',
    buyerAddressLine2: '02-001 Warszawa',
    buyerEmail: '',
    buyerIsConsumer: false,
    buyerPesel: '',
    buyerIdDocument: '',
    lines: [{ name: 'Rower miejski', unit: 'szt.', quantity: 1, unitPriceNet: 1000, vatRate: '23' }],
    paymentMethod: 'cash',
    paymentDueDate: DZIS,
    bankAccount: '',
    notes: '',
    receiptInvoice: true,
    receiptNumber: ' 000123 ',
    receiptDate: '2026-10-15',
    cashRegisterNumber: 'abc 123-456 7890',
    receiptRequestDate: '',
    buyerNipOnReceipt: true,
    ...extra,
  } as InvoiceFormValues;
}

const KONSUMENT = {
  buyerNip: '',
  buyerIsConsumer: true,
  buyerConsumerIdType: 'no_id',
  buyerNipOnReceipt: false,
};

function bledyPol(values: InvoiceFormValues): Record<string, string> {
  const r = invoiceFormSchema.safeParse(values);
  if (r.success) return {};
  return Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message]));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.invoices = [];
  state.invoice_line_items = [];
  state.invoiceInserts = [];
  state.tenants = [{
    id: TENANT, nip: '5260001246', name: 'Sklep Testowy',
    address_json: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' },
    vat_exemption_basis: null, vat_cash_method: false,
  }];
  mocks.auth.mockResolvedValue({ supabase: fakeSupabase(), user: { id: 'user-1' }, tenantId: TENANT, role: 'owner' });
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('formularz: walidacja faktury do paragonu (klient i serwer)', () => {
  it('firma z NIP, paragon z NIP, w terminie: przechodzi', () => {
    expect(bledyPol(formularz())).toEqual({});
  });

  it('niezmiennik: firma bez potwierdzenia NIP na paragonie: błąd przy polu „Paragon ma NIP nabywcy”', () => {
    expect(bledyPol(formularz({ buyerNipOnReceipt: false })).buyerNipOnReceipt).toMatch(
      /paragon ma NIP nabywcy \(art\. 106b ust\. 5/,
    );
  });

  it('osoba prywatna bez identyfikatora: przechodzi bez NIP', () => {
    expect(bledyPol(formularz(KONSUMENT))).toEqual({});
  });

  it('firma z UE: odmowa przy polu „Faktura do paragonu”', () => {
    expect(
      bledyPol(formularz({ buyerIsEu: true, buyerNip: '', buyerVatUe: 'DE123456789', buyerCountryCode: 'DE' })).receiptInvoice,
    ).toMatch(/firmy z UE/);
  });

  it('po terminie: odmowa z artykułem i datą końca terminu', () => {
    const e = bledyPol(formularz({ saleDate: '2026-07-31', receiptDate: '2026-07-31' }));
    expect(e.receiptDate).toMatch(/3 miesięcy od końca miesiąca sprzedaży \(art\. 106b ust\. 3 ustawy o VAT\)/);
    expect(e.receiptDate).toContain('31.10.2026');
  });

  it('po terminie, ale żądanie zgłoszone w terminie: przechodzi z datą żądania', () => {
    expect(bledyPol(formularz({ saleDate: '2026-07-31', receiptDate: '2026-07-31', receiptRequestDate: '2026-10-30' }))).toEqual({});
  });

  it('brak numeru paragonu albo zły numer kasy: błędy przy polach', () => {
    const e = bledyPol(formularz({ receiptNumber: '', cashRegisterNumber: '12345678' }));
    expect(e.receiptNumber).toMatch(/numer paragonu/i);
    expect(e.cashRegisterNumber).toMatch(/Numer unikatowy kasy/);
  });

  it('data sprzedaży inna niż data paragonu: błąd przy dacie sprzedaży', () => {
    expect(bledyPol(formularz({ saleDate: '2026-10-16' })).saleDate).toMatch(/data z paragonu \(15\.10\.2026\)/);
  });

  it('firma, paragon z 2026 r. do 450 zł brutto: odmowa', () => {
    const lines = [{ name: 'Drobiazg', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '23' }];
    expect(bledyPol(formularz({ lines })).receiptInvoice).toMatch(/do 450 zł brutto/);
  });

  it('bez zaznaczonej faktury do paragonu pola paragonu nie są sprawdzane', () => {
    expect(
      bledyPol(formularz({ receiptInvoice: false, receiptNumber: '', receiptDate: '', cashRegisterNumber: 'x', saleDate: '' })),
    ).toEqual({});
  });
});

describe('akcja „Wystaw i wyślij”: paragon trafia do faktury i do zlecenia wysyłki', () => {
  it('fa3_data i zdarzenie wysyłki mają paragon, XML z FP przechodzi XSD', async () => {
    const r = await saveAndSendInvoiceAction(formularz(), TENANT);
    expect(r).toMatchObject({ success: true });

    const insert = state.invoiceInserts[0]!;
    const zapisana = insert.fa3_data as Invoice;
    expect(zapisana.receipt).toEqual({
      receiptNumber: '000123',
      receiptDate: '2026-10-15',
      cashRegisterNumber: 'ABC1234567890',
      buyerNipOnReceipt: true,
    });
    expect(insert.sale_date).toBe('2026-10-15');

    const wyslana = mocks.enqueue.mock.calls[0]![0].invoice as Invoice;
    expect(wyslana.receipt).toEqual(zapisana.receipt);
    const xml = generateFA3Xml(wyslana);
    expect(xml).toContain('<FP>1</FP>');
    const wynik = await validateInvoiceXml(xml);
    expect(wynik.errors).toEqual([]);
  });

  it('osoba prywatna: paragon bez potwierdzenia NIP', async () => {
    await expect(saveAndSendInvoiceAction(formularz(KONSUMENT), TENANT)).resolves.toMatchObject({ success: true });
    const zapisana = state.invoiceInserts[0]!.fa3_data as Invoice;
    expect(zapisana.receipt).toEqual({ receiptNumber: '000123', receiptDate: '2026-10-15', cashRegisterNumber: 'ABC1234567890' });
  });

  it('data żądania wcześniejsza niż wystawienie zostaje w dokumentacji faktury', async () => {
    await saveAndSendInvoiceAction(formularz({ receiptRequestDate: '2026-11-02' }), TENANT);
    expect((state.invoiceInserts[0]!.fa3_data as Invoice).receipt?.requestDate).toBe('2026-11-02');
  });

  it('wywołanie akcji wprost z firmą bez NIP na paragonie: odmowa bez zapisu i bez kolejki', async () => {
    const r = await saveAndSendInvoiceAction(formularz({ buyerNipOnReceipt: false }), TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/paragon ma NIP nabywcy/) });
    expect(state.invoiceInserts).toHaveLength(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('szkic też przechodzi tę walidację (szkic da się potem wysłać)', async () => {
    const r = await saveDraftAction(formularz({ saleDate: '2026-07-31', receiptDate: '2026-07-31' }), TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/3 miesięcy/) });
    expect(state.invoiceInserts).toHaveLength(0);
  });

  it('zwykła faktura bez paragonu: fa3_data bez klucza `receipt` (bez zmian)', async () => {
    await saveAndSendInvoiceAction(formularz({ receiptInvoice: false, saleDate: '' }), TENANT);
    expect(state.invoiceInserts[0]!.fa3_data).not.toHaveProperty('receipt');
  });
});
