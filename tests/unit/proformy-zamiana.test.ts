import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';

/**
 * Zamiana proformy albo oferty w fakturę albo fakturę zaliczkową (plan
 * kompletnej aplikacji, krok 2.4). Zamiana tylko OTWIERA formularz faktury
 * z danymi z dokumentu: nic nie zapisuje, nie wystawia i nie wysyła do KSeF.
 * Powiązanie (dokument i numer kolejnej zamiany) idzie do formularza
 * w ukrytych polach; zapis faktury wpisuje je w tym samym INSERT
 * (tests/unit/proformy-zamiana-zapis.test.ts). Druga faktura z tego samego
 * dokumentu dopiero po potwierdzeniu (`kolejna=1`).
 */

const TENANT = 'ten-1';
const DOKUMENT = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';

const m = vi.hoisted(() => ({
  formProps: [] as Array<Record<string, unknown>>,
  advanceProps: [] as Array<Record<string, unknown>>,
  ctx: { supabase: null as unknown, tenantId: 'ten-1' },
}));

vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: vi.fn(async () => m.ctx) }));
vi.mock('@/components/invoices/actions', () => ({
  prefillFromLastInvoiceAction: vi.fn().mockResolvedValue({ contractorName: 'Ostatni', values: {} }),
  prefillFromInvoiceAction: vi.fn(),
}));
vi.mock('@/lib/invoices/recurring/queries', () => ({ getRecurringInvoice: vi.fn() }));
vi.mock('@/lib/invoices/vat-exemption', () => ({ readTenantVatExemption: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/invoices/next-number', () => ({
  suggestNextInvoiceNumberForTenant: vi.fn().mockResolvedValue('FV/1/11/2026'),
}));
vi.mock('@/lib/invoices/load-tenant-seller', () => ({
  loadTenantSellerForForms: vi.fn().mockResolvedValue({
    tenantId: 'ten-1',
    seller: { nip: '2222222222', name: 'Moja Firma', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
  }),
}));
vi.mock('@/components/invoices/invoice-form', () => ({
  InvoiceForm: (props: Record<string, unknown>) => {
    m.formProps.push(props);
    return null;
  },
}));
vi.mock('@/components/invoices/advance-form', () => ({
  AdvanceInvoiceForm: (props: Record<string, unknown>) => {
    m.advanceProps.push(props);
    return null;
  },
}));

import NewAdvanceInvoicePage from '@/app/(dashboard)/invoices/new/advance/page';
import NewRegularInvoicePage from '@/app/(dashboard)/invoices/new/regular/page';
import { quoteItems, quoteTotals, type QuoteItemInput, type SalesQuote } from '@/lib/proformy/model';
import { advanceInvoiceFromQuote, loadQuoteSource, regularInvoiceFromQuote } from '@/lib/proformy/zamiana';

let db: MemoryDb;

const STRONA = {
  name: 'Kontrahent Testowy',
  nip: '1234567890',
  countryCode: 'PL',
  addressLine1: 'ul. Klienta 10',
  addressLine2: '02-001 Warszawa',
  email: 'zakupy@kontrahent.test',
};

function pozycjeBazy(inputs: QuoteItemInput[]) {
  return quoteItems(inputs);
}

const JEDNA_STAWKA: QuoteItemInput[] = [
  { name: 'Wdrożenie systemu', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' },
  { name: 'Szkolenie', unit: 'godz.', quantity: 2, unitPriceNet: 150, vatRate: '23' },
];

function wiersz(extra: Row = {}): Row {
  const items = (extra.items as ReturnType<typeof quoteItems> | undefined) ?? pozycjeBazy(JEDNA_STAWKA);
  const totals = quoteTotals(items);
  return {
    id: DOKUMENT,
    tenant_id: TENANT,
    kind: 'proforma',
    status: 'issued',
    number: 'PRO/1/2026',
    issue_date: '2026-11-11',
    valid_until: null,
    items,
    net_total: totals.netTotal,
    vat_total: totals.vatTotal,
    gross_total: totals.grossTotal,
    currency: 'PLN',
    contractor_id: null,
    counterparty: STRONA,
    issuer: { name: 'Moja Firma', nip: '2222222222', countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' },
    payment_method: 'transfer',
    payment_due_date: '2026-11-25',
    bank_account: 'PL61109010140000071219812874',
    notes: 'Płatne z góry',
    issued_at: '2026-11-11T09:30:00.000Z',
    created_at: '2026-11-11T09:00:00.000Z',
    ...extra,
  };
}

function faktura(extra: Row = {}): Row {
  return {
    id: 'inv-1', tenant_id: TENANT, internal_number: 'FV/1/11/2026', invoice_kind: 'regular', ksef_status: 'draft',
    sales_quote_id: DOKUMENT, sales_quote_seq: 1, ...extra,
  };
}

function dokument(extra: Partial<SalesQuote> = {}): SalesQuote {
  const items = extra.items ?? pozycjeBazy(JEDNA_STAWKA);
  return {
    id: DOKUMENT,
    tenantId: TENANT,
    kind: 'proforma',
    status: 'issued',
    number: 'PRO/1/2026',
    issueDate: '2026-11-11',
    validUntil: null,
    items,
    ...quoteTotals(items),
    currency: 'PLN',
    contractorId: null,
    counterparty: STRONA,
    issuer: { name: 'Moja Firma', nip: '2222222222', countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' },
    paymentMethod: 'transfer',
    paymentDueDate: '2026-11-25',
    bankAccount: 'PL61109010140000071219812874',
    notes: 'Płatne z góry',
    issuedAt: '2026-11-11T09:30:00.000Z',
    createdAt: '2026-11-11T09:00:00.000Z',
    ...extra,
  };
}

beforeEach(() => {
  m.formProps.length = 0;
  m.advanceProps.length = 0;
  db = memoryDb({ sales_quotes: [wiersz()], invoices: [] });
  m.ctx = { supabase: fakeSupabase(db), tenantId: TENANT };
});

describe('dane z dokumentu do formularza faktury', () => {
  it('zwykła faktura: nabywca z NIP, pozycje i sposób zapłaty; bez numeru, dat i uwag', () => {
    const { initialValues, notice } = regularInvoiceFromQuote({ quote: dokument(), invoices: [], seq: 1 });
    expect(initialValues).toEqual({
      buyerIsConsumer: false,
      buyerIsEu: false,
      buyerVatUe: '',
      buyerCountryCode: '',
      buyerNip: '1234567890',
      buyerName: 'Kontrahent Testowy',
      buyerAddressLine1: 'ul. Klienta 10',
      buyerAddressLine2: '02-001 Warszawa',
      buyerEmail: 'zakupy@kontrahent.test',
      lines: [
        { name: 'Wdrożenie systemu', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' },
        { name: 'Szkolenie', unit: 'godz.', quantity: 2, unitPriceNet: 150, vatRate: '23' },
      ],
      paymentMethod: 'transfer',
      bankAccount: 'PL61109010140000071219812874',
    });
    for (const pole of ['internalNumber', 'issueDate', 'saleDate', 'paymentDueDate', 'notes']) {
      expect(initialValues, pole).not.toHaveProperty(pole);
    }
    expect(notice).toMatchObject({ tone: 'info', title: expect.stringContaining('PRO/1/2026') });
    expect(notice.text).toMatch(/Zapisz szkic albo Wystaw i wyślij/);
  });

  it('oferta bez płatności: przelew jako domyślny sposób, rachunek pusty', () => {
    const { initialValues } = regularInvoiceFromQuote({
      quote: dokument({ kind: 'offer', number: 'OF/2/2026', paymentMethod: null, paymentDueDate: null, bankAccount: null, validUntil: '2026-12-11' }),
      invoices: [],
      seq: 1,
    });
    expect(initialValues).toMatchObject({ paymentMethod: 'transfer', bankAccount: '' });
  });

  it('faktura zaliczkowa: nabywca B2B, wartość umowy i zaliczka z kwoty brutto, jedna stawka, rachunek 26 cyfr', () => {
    const r = advanceInvoiceFromQuote({ quote: dokument(), invoices: [], seq: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.initialValues).toEqual({
      buyer: {
        type: 'b2b',
        idType: 'nip',
        nip: '1234567890',
        name: 'Kontrahent Testowy',
        address: { addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa', countryCode: 'PL' },
      },
      paymentMethod: 'transfer',
      bankAccount: '61109010140000071219812874',
      totalContractAmount: 1599,
      advanceAmount: 1599,
      vatRate: '23',
      description: 'Zamówienie według proformy PRO/1/2026',
    });
    expect(r.notice.text).toMatch(/kwot/i);
  });

  it('faktura zaliczkowa z kilku stawek VAT: odmowa z wyjściem, bez danych do formularza', () => {
    const items = pozycjeBazy([
      { name: 'Towar', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' },
      { name: 'Książka', unit: 'szt', quantity: 1, unitPriceNet: 50, vatRate: '5' },
    ]);
    const r = advanceInvoiceFromQuote({ quote: dokument({ items, ...quoteTotals(items) }), invoices: [], seq: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notice).toMatchObject({ tone: 'error', link: { href: `/proformy/${DOKUMENT}` } });
    expect(r.notice.text).toMatch(/23%.*5%/);
    expect(r.notice.text).toMatch(/zwykłą fakturę/);
  });

  it('faktura zaliczkowa ze stawką zw: odmowa z wyjściem', () => {
    const items = pozycjeBazy([{ name: 'Szkolenie', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: 'zw' }]);
    const r = advanceInvoiceFromQuote({ quote: dokument({ items, ...quoteTotals(items) }), invoices: [], seq: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notice.text).toMatch(/zw/);
    expect(r.notice.text).toMatch(/zwykłą fakturę/);
  });

  it('rachunek spoza Polski nie trafia do pola 26 cyfr faktury zaliczkowej', () => {
    const r = advanceInvoiceFromQuote({ quote: dokument({ bankAccount: 'DE89370400440532013000' }), invoices: [], seq: 1 });
    expect(r.ok && r.initialValues.bankAccount).toBe('');
  });
});

describe('loadQuoteSource: dokument do zamiany', () => {
  it('wystawiony dokument bez faktur: pierwsza zamiana', async () => {
    const r = await loadQuoteSource(m.ctx.supabase, TENANT, DOKUMENT, false);
    expect(r).toMatchObject({ ok: true, source: { seq: 1, invoices: [], quote: { id: DOKUMENT, number: 'PRO/1/2026' } } });
  });

  it('dokument z fakturą, bez potwierdzenia: odmowa z numerem istniejącej faktury i linkiem do dokumentu', async () => {
    db.tables.invoices = [faktura()];
    const r = await loadQuoteSource(m.ctx.supabase, TENANT, DOKUMENT, false);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.notice.tone).toBe('error');
    expect(r.notice.text).toContain('FV/1/11/2026');
    expect(r.notice.link).toEqual({ href: `/proformy/${DOKUMENT}`, label: expect.stringContaining('PRO/1/2026') });
  });

  it('dokument z fakturą, po potwierdzeniu: kolejna zamiana z następnym numerem', async () => {
    db.tables.invoices = [faktura(), faktura({ id: 'inv-2', internal_number: 'ZAL/2/11/2026', invoice_kind: 'advance', sales_quote_seq: 3 })];
    const r = await loadQuoteSource(m.ctx.supabase, TENANT, DOKUMENT, true);
    expect(r).toMatchObject({ ok: true, source: { seq: 4 } });
    if (!r.ok) return;
    expect(r.source.invoices.map((i) => i.internalNumber)).toEqual(['FV/1/11/2026', 'ZAL/2/11/2026']);
  });

  it('szkic dokumentu: odmowa, bo zamiana bierze tylko dokument z numerem', async () => {
    db.tables.sales_quotes = [wiersz({ status: 'draft', number: null, issuer: null, issued_at: null })];
    const r = await loadQuoteSource(m.ctx.supabase, TENANT, DOKUMENT, false);
    expect(r).toMatchObject({ ok: false, notice: { tone: 'error', title: expect.stringMatching(/wystaw/i) } });
  });

  it.each([
    ['dokument innej firmy', DOKUMENT, { tenant_id: 'ten-2' }],
    ['identyfikator spoza wzoru', 'abc', {}],
  ])('%s: „nie znaleziono”, pusty formularz', async (_opis, id, extra) => {
    db.tables.sales_quotes = [wiersz(extra)];
    const r = await loadQuoteSource(m.ctx.supabase, TENANT, id, false);
    expect(r).toMatchObject({ ok: false, notice: { title: expect.stringMatching(/Nie znaleziono/) } });
  });
});

async function stronaZwykla(params: Record<string, string>) {
  return renderToStaticMarkup(await NewRegularInvoicePage({ searchParams: Promise.resolve(params) }));
}

async function stronaZaliczki(params: Record<string, string>) {
  return renderToStaticMarkup(await NewAdvanceInvoicePage({ searchParams: Promise.resolve(params) }));
}

describe('/invoices/new/regular?proforma=<id>', () => {
  it('formularz z danymi dokumentu i ukrytym powiązaniem; bez banera ostatniej faktury', async () => {
    const html = await stronaZwykla({ proforma: DOKUMENT });
    expect(m.formProps.at(-1)).toMatchObject({
      initialValues: expect.objectContaining({ buyerName: 'Kontrahent Testowy', paymentMethod: 'transfer' }),
      salesQuoteId: DOKUMENT,
      salesQuoteSeq: '1',
      prefill: null,
      suggestedNumber: 'FV/1/11/2026',
    });
    expect(m.formProps.at(-1)?.recurringInvoiceId ?? null).toBeNull();
    expect(html).toContain('Faktura z proformy PRO/1/2026');
  });

  it('dokument ma już fakturę, bez potwierdzenia: pusty formularz bez powiązania, komunikat z wyjściem', async () => {
    db.tables.invoices = [faktura()];
    const html = await stronaZwykla({ proforma: DOKUMENT });
    expect(m.formProps.at(-1)).not.toHaveProperty('salesQuoteId');
    expect(m.formProps.at(-1)).not.toHaveProperty('initialValues');
    expect(html).toContain('FV/1/11/2026');
    expect(html).toContain(`href="/proformy/${DOKUMENT}"`);
  });

  it('po potwierdzeniu (kolejna=1): formularz z kolejnym numerem zamiany i informacją o istniejącej fakturze', async () => {
    db.tables.invoices = [faktura()];
    const html = await stronaZwykla({ proforma: DOKUMENT, kolejna: '1' });
    expect(m.formProps.at(-1)).toMatchObject({ salesQuoteId: DOKUMENT, salesQuoteSeq: '2' });
    expect(html).toMatch(/kolejna faktura/i);
    expect(html).toContain('FV/1/11/2026');
  });

  it('bez parametru: formularz jak dotąd, bez powiązania', async () => {
    await stronaZwykla({});
    expect(m.formProps.at(-1)).not.toHaveProperty('salesQuoteId');
    expect(m.formProps.at(-1)).toMatchObject({ prefill: { contractorName: 'Ostatni' } });
  });
});

describe('/invoices/new/advance?proforma=<id>', () => {
  it('formularz zaliczki z danymi dokumentu i ukrytym powiązaniem', async () => {
    const html = await stronaZaliczki({ proforma: DOKUMENT });
    expect(m.advanceProps.at(-1)).toMatchObject({
      tenantId: TENANT,
      initialValues: expect.objectContaining({ totalContractAmount: 1599, advanceAmount: 1599, vatRate: '23' }),
      salesQuoteId: DOKUMENT,
      salesQuoteSeq: '1',
    });
    expect(html).toContain('Faktura zaliczkowa z proformy PRO/1/2026');
  });

  it('kilka stawek VAT: pusty formularz zaliczki bez powiązania, komunikat z wyjściem', async () => {
    db.tables.sales_quotes = [wiersz({
      items: pozycjeBazy([
        { name: 'Towar', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' },
        { name: 'Książka', unit: 'szt', quantity: 1, unitPriceNet: 50, vatRate: '5' },
      ]),
    })];
    const html = await stronaZaliczki({ proforma: DOKUMENT });
    expect(m.advanceProps.at(-1)).not.toHaveProperty('salesQuoteId');
    expect(m.advanceProps.at(-1)).not.toHaveProperty('initialValues');
    expect(html).toContain(`href="/proformy/${DOKUMENT}"`);
  });

  it('bez parametru: formularz zaliczki jak dotąd', async () => {
    const html = await stronaZaliczki({});
    expect(m.advanceProps.at(-1)).toEqual({ initialSeller: expect.any(Object), tenantId: TENANT });
    expect(html).not.toMatch(/proform/i);
  });
});
