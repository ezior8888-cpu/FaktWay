import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import type { Invoice, InvoiceLineItem } from '@/types/invoice';

/**
 * FZ-008 (ustalenie żelaznego filtra z 14.11.2026): faktura VAT za abonament FaktWay liczy
 * się od brutto, bo Stripe pobiera kwotę brutto (art. 106e ust. 7, 9 i 11
 * ustawy o VAT; `lib/billing/self-invoice.ts`, RPC `create_billing_vat_invoice`
 * w 00162). Walidacja przed wysyłką (`validateInvoice`) liczyła VAT pozycji
 * tylko od netto i porównywała kwoty na liczbach zmiennoprzecinkowych z progiem
 * 0,01. Dla ok. 10 % kwot brutto (np. 20,99 zł po kodzie rabatowym 30 % od
 * 29,99 zł) wysyłka kończyła się NonRetriableError i faktura nie trafiała do
 * KSeF. Atrapy tylko na granicach: baza (PostgREST, RPC), magazyn plików, KSeF.
 */

const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const PAYMENT = '11111111-1111-4111-8111-111111111111';
const SUBSCRIPTION = '44444444-4444-4444-8444-444444444444';
const VAT_INVOICE = '55555555-5555-4555-8555-555555555555';
const STRIPE_INVOICE = 'in_1PROMO30TEST';
const PAID_AT = '2026-11-14T10:00:00.000Z';
const NUMBER = 'FF/2026/11/0001';

const m = vi.hoisted(() => ({
  // baza dla runnera płatności (klient service_role z `@/lib/supabase/admin`)
  billingFrom: vi.fn(),
  billingRpc: vi.fn(),
  grossCents: 2099,
  // granice joba wysyłki (jak w `xml-dowod-runner.test.ts`)
  upload: vi.fn(),
  submit: vi.fn(),
  updateStatus: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  invoiceRow: {} as Record<string, unknown>,
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: m.billingFrom, rpc: m.billingRpc }),
}));
vi.mock('@/lib/storage/r2-client', () => ({ getR2Config: () => ({ bucketName: 'b' }), getR2Client: () => ({ send: vi.fn() }) }));
vi.mock('@/lib/storage/r2', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/storage/r2')>(),
  uploadInvoiceXml: m.upload,
  invoiceXmlExistsForId: vi.fn(async () => false),
}));
vi.mock('@/lib/storage/xml-documents', () => ({ recordXmlDocument: vi.fn() }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/ksef/submit', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ksef/submit')>(),
  submitInvoice: m.submit,
  checkInvoiceStatusByReference: vi.fn(),
  downloadKsefInvoice: vi.fn(),
}));
vi.mock('@/lib/ksef/submission-log', () => ({
  findOpenKsefSubmissionIntents: vi.fn(async () => []),
  promoteKsefSubmissionIntent: vi.fn(async () => false),
  abandonKsefSubmissionIntent: vi.fn(),
  recordKsefSubmissionIntent: vi.fn(),
  findKsefSessionRow: vi.fn(),
  findSubmissionPayloads: vi.fn(async () => []),
  findTenantInvoiceByKsefNumber: vi.fn(async () => null),
  closeKsefAttempt: vi.fn(),
  markKsefSubmissionsNumberTaken: vi.fn(),
  recordKsefDuplicateCheck: vi.fn(),
  recordKsefAcceptedSession: vi.fn(),
  markKsefAttemptDuplicatePending: vi.fn(),
  recordKsefSubmissionSent: vi.fn(),
  markKsefSubmission: vi.fn(),
  findOpenKsefSubmission: vi.fn(async () => null),
  findOwnKsefSessionXmlPath: vi.fn(async () => null),
  isOwnKsefSession: vi.fn(async () => true),
  findSessionReferenceForKsefNumber: vi.fn(async () => null),
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({ claimXmlGeneratedAt: async () => new Date('2026-11-14T10:05:00.000Z') }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false }) }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/submit-reference-boundary', () => ({ assertSubmitReferences: async () => 'regular' }));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireInvoiceTenant: vi.fn(), assertJobIdentity: vi.fn() }));
vi.mock('@/lib/supabase/admin-queries', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/supabase/admin-queries')>(),
  getTenantKsefCredentials: async () => ({ type: 'token', nip: '5260001246', token: 't' }),
  updateInvoiceStatus: m.updateStatus,
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: async () => {
    const q = {
      select: () => q, eq: () => q, in: () => q, or: () => q, update: () => q,
      maybeSingle: async () => ({ data: { ...m.invoiceRow }, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve),
    };
    return { from: () => q, rpc: async () => ({ data: '2026-11-14T10:05:00.000000+00:00', error: null }) };
  },
}));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: vi.fn() }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureException: m.captureException, captureMessage: m.captureMessage, addBreadcrumb: vi.fn() }));

import { buildSelfInvoiceDraft } from '@/lib/billing/self-invoice';
import { clearOperatorCache } from '@/lib/billing/operator-config';
import { runSelfInvoicePayment } from '@/lib/jobs/runners/self-invoice-payment';
import { runSubmitInvoice } from '@/lib/jobs/runners/submit-invoice';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { lineVatMatchesRate, validateInvoice } from '@/lib/xml/invoice-calculator';
import { validateInvoiceXml } from '@/lib/xml/validator';

const ADDRESS = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };

/** Migawka opłaconej faktury Stripe (kształt „basil”), którą runner sprawdza przed wystawieniem. */
function stripeSnapshot(grossCents: number) {
  return {
    object: 'invoice',
    id: STRIPE_INVOICE,
    status: 'paid',
    currency: 'pln',
    amount_paid: grossCents,
    total: grossCents,
    amount_remaining: 0,
    customer: 'cus_test_1',
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_test_1' } },
    lines: {
      has_more: false,
      total_count: 1,
      data: [{
        object: 'line_item',
        currency: 'pln',
        quantity: 1,
        parent: { type: 'subscription_item_details', subscription_item_details: { proration: false, subscription: 'sub_test_1' } },
        pricing: { type: 'price_details', price_details: { price: 'price_test_monthly' } },
      }],
    },
  };
}

function paymentRow() {
  return {
    id: PAYMENT,
    tenant_id: CUSTOMER,
    amount_cents: m.grossCents,
    currency: 'pln',
    stripe_invoice_id: STRIPE_INVOICE,
    last_webhook_payload: stripeSnapshot(m.grossCents),
    status: 'succeeded',
    paid_at: PAID_AT,
    vat_invoice_id: null,
    vat_invoice_submitted_at: null,
    subscription_id: SUBSCRIPTION,
  };
}

const tenants: Record<string, Record<string, unknown>> = {
  [OPERATOR]: { id: OPERATOR, nip: '5260001246', name: 'Operator Testowy sp. z o.o.', address_json: ADDRESS },
  [CUSTOMER]: { id: CUSTOMER, nip: '5252241585', name: 'Klient Testowy', address_json: ADDRESS },
};

function billingDatabase() {
  m.billingFrom.mockImplementation((table: string) => {
    if (table === 'tenants') {
      return { select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: tenants[id] ?? null, error: null }) }) }) };
    }
    if (table === 'subscriptions') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({
          data: { plan: 'monthly', tenant_id: CUSTOMER, stripe_subscription_id: 'sub_test_1', stripe_customer_id: 'cus_test_1' },
          error: null,
        }) }) }),
      };
    }
    if (table !== 'stripe_payments') throw new Error(`nieoczekiwana tabela: ${table}`);
    return {
      select: (columns: string) => ({ eq: () => ({ maybeSingle: async () => ({
        data: columns === 'status' ? { status: 'succeeded' } : paymentRow(),
        error: null,
      }) }) }),
      update: () => ({ eq: () => ({ eq: () => ({ is: () => ({ select: () => ({
        maybeSingle: async () => ({ data: { id: PAYMENT }, error: null }),
      }) }) }) }) }),
    };
  });
  m.billingRpc.mockImplementation(async (name: string) => {
    if (name !== 'create_billing_vat_invoice') throw new Error(`nieoczekiwane RPC: ${name}`);
    return { data: [{ invoice_id: VAT_INVOICE, internal_number: NUMBER, created: true }], error: null };
  });
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const sentEvent = vi.fn();
const billingCtx: JobContext = {
  attempt: 0,
  logger,
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: sentEvent, scheduleAfter: vi.fn() },
};
const submitCtx: JobContext = {
  attempt: 0,
  logger,
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

/** Płatność `grossCents` → runner faktury za abonament → job wysyłki do KSeF. */
async function wystawIWyslij(grossCents: number) {
  m.grossCents = grossCents;
  const billed = await runSelfInvoicePayment({
    tenantId: CUSTOMER,
    paymentId: PAYMENT,
    stripeInvoiceId: STRIPE_INVOICE,
    amountCents: grossCents,
    taxCents: 0,
    currency: 'pln',
    paidAt: PAID_AT,
  }, billingCtx);
  expect(billed).toMatchObject({ success: true, invoiceId: VAT_INVOICE, internalNumber: NUMBER });
  expect(sentEvent).toHaveBeenCalledOnce();
  const [, submitEvent] = sentEvent.mock.calls[0]! as [string, { name: string; data: { invoice: Invoice } }];
  expect(submitEvent.name).toBe('invoice/submit.requested');
  const rpcInvoice = m.billingRpc.mock.calls[0]![1].p_invoice as Invoice;
  await runSubmitInvoice(submitEvent.data as Parameters<typeof runSubmitInvoice>[0], submitCtx);
  return { rpcInvoice, sentInvoice: submitEvent.data.invoice };
}

const zl = (grosze: number) => Math.round(grosze) / 100;

/** VAT od brutto z art. 106e ust. 7 i 11 w liczbach całkowitych: ⌊(brutto·23·2 + 123) / 246⌋ (pół grosza w górę). */
const vatOdBruttoGr = (bruttoGr: number) => Math.floor((bruttoGr * 23 * 2 + 123) / 246);

async function draftFor(grossCents: number): Promise<Invoice> {
  const draft = await buildSelfInvoiceDraft(CUSTOMER, {
    grossCents,
    paidAt: PAID_AT,
    stripeInvoiceId: STRIPE_INVOICE,
    plan: 'monthly',
  });
  if (!draft) throw new Error('draft faktury za abonament nie powstał');
  return { ...draft.invoice, internalNumber: NUMBER };
}

/** Grosze z kwoty w złotych (kwoty faktury mają najwyżej dwa miejsca). */
const gr = (value: number) => Math.round(value * 100);

beforeEach(() => {
  vi.clearAllMocks();
  clearOperatorCache();
  vi.stubEnv('KSEF_ENV', 'test');
  vi.stubEnv('FAKTFLOW_OPERATOR_TENANT_ID', OPERATOR);
  vi.stubEnv('STRIPE_PRICE_MONTHLY', 'price_test_monthly');
  vi.stubEnv('STRIPE_PRICE_ANNUAL', 'price_test_annual');
  billingDatabase();
  m.upload.mockResolvedValue({ storagePath: `${OPERATOR}/2026/11/${VAT_INVOICE}/a.xml`, sha256Hash: 'ab'.repeat(32), sizeBytes: 321, etag: '"e"' });
  m.submit.mockResolvedValue({ ksefNumber: 'K-ABONAMENT', acquisitionTimestamp: '2026-11-14T10:06:00Z', sessionReferenceNumber: 'S-1', invoiceReferenceNumber: 'R-1' });
  m.invoiceRow = { id: VAT_INVOICE, direction: 'outgoing', ksef_status: 'queued', ksef_number: null, ksef_environment: 'test', invoice_type: 'VAT', invoice_kind: 'regular', fa3_data: {} };
});
afterEach(() => vi.unstubAllEnvs());

describe('FZ-008: faktura za abonament od brutto przechodzi wysyłkę do KSeF', () => {
  it('20,99 zł (29,99 zł z kodem rabatowym 30 %): runner wystawia fakturę 17,07 + 3,92, a job wysyłki przyjmuje ją do KSeF', async () => {
    const { rpcInvoice, sentInvoice } = await wystawIWyslij(2099);

    // Kontrakt bazy (00162): netto = round(brutto / 1,23), VAT = brutto − netto.
    expect({ net: rpcInvoice.netTotal, vat: rpcInvoice.vatTotal, gross: rpcInvoice.grossTotal }).toEqual({ net: 17.07, vat: 3.92, gross: 20.99 });
    expect(sentInvoice.lines[0]).toMatchObject({ netAmount: 17.07, vatAmount: 3.92, grossAmount: 20.99, vatRate: '23' });

    expect(m.submit).toHaveBeenCalledOnce();
    expect(m.updateStatus).toHaveBeenCalledWith(VAT_INVOICE, expect.objectContaining({ ksef_status: 'accepted', ksef_number: 'K-ABONAMENT' }), OPERATOR);
  });

  it('29,99 zł bez kodu: ta sama ścieżka jak dotąd (24,38 + 5,61)', async () => {
    const { rpcInvoice } = await wystawIWyslij(2999);
    expect({ net: rpcInvoice.netTotal, vat: rpcInvoice.vatTotal }).toEqual({ net: 24.38, vat: 5.61 });
    expect(m.updateStatus).toHaveBeenCalledWith(VAT_INVOICE, expect.objectContaining({ ksef_status: 'accepted' }), OPERATOR);
  });

  it.each([1, 99, 2099, 2249, 2999, 29990, 100_000_000])(
    'plik FA(3) dla %i gr zgodny z XSD, a P_13_1, P_14_1 i P_15 to netto, VAT i brutto faktury',
    async (grossCents) => {
      const invoice = await draftFor(grossCents);
      const xml = generateFA3Xml(invoice, { generatedAt: new Date('2026-11-14T10:05:00.000Z') });
      expect((await validateInvoiceXml(xml)).errors).toEqual([]);
      const pole = (name: string) => xml.match(new RegExp(`<${name}>([^<]+)</${name}>`))?.[1];
      expect(pole('P_13_1')).toBe(invoice.netTotal.toFixed(2));
      expect(pole('P_14_1')).toBe(invoice.vatTotal.toFixed(2));
      expect(pole('P_15')).toBe(zl(grossCents).toFixed(2));
    },
  );
});

describe('FZ-008: niezmiennik faktury za abonament na kwotach brutto', () => {
  const now = new Date('2026-11-14T12:00:00.000Z');

  async function problemy(grossCents: number): Promise<string[]> {
    const invoice = await draftFor(grossCents);
    const line = invoice.lines[0]!;
    const out: string[] = [];
    if (gr(line.netAmount) + gr(line.vatAmount) !== grossCents) out.push(`${grossCents}: netto + VAT ≠ brutto`);
    if (gr(line.vatAmount) !== vatOdBruttoGr(grossCents)) out.push(`${grossCents}: VAT ≠ wzór z art. 106e ust. 7`);
    for (const e of validateInvoice(invoice, now)) out.push(`${grossCents}: ${e}`);
    return out;
  }

  it('każda kwota od 0,01 do 1 000,00 zł: netto + VAT = brutto, VAT z ust. 7, walidacja wysyłki bez błędów', async () => {
    const zle: string[] = [];
    for (let g = 1; g <= 100_000 && zle.length < 5; g++) zle.push(...await problemy(g));
    expect(zle).toEqual([]);
  }, 120_000); // 100 000 faktur z prawdziwego buildera: ok. 8 s lokalnie

  it('losowe kwoty od 1 000,01 do 1 000 000,00 zł', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 100_001, max: 100_000_000 }), async (g) => {
        expect(await problemy(g)).toEqual([]);
      }),
      { numRuns: 2000 },
    );
  });
});

/** Faktura z jedną pozycją o podanych kwotach (bez przeliczania) — tylko do sprawdzania walidatora. */
function fakturaZPozycja(line: Pick<InvoiceLineItem, 'unitPriceNet' | 'netAmount' | 'vatAmount' | 'grossAmount' | 'vatRate'>): Invoice {
  return {
    internalNumber: 'FV/1',
    type: 'VAT',
    issueDate: '2026-11-14',
    saleDate: '2026-11-14',
    seller: { nip: '5260001246', name: 'Sprzedawca', address: ADDRESS },
    buyer: { nip: '5252241585', name: 'Nabywca', address: ADDRESS },
    lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, ...line }],
    netTotal: line.netAmount,
    vatTotal: line.vatAmount,
    grossTotal: line.grossAmount,
    payment: { amountDue: line.grossAmount, currency: 'PLN', dueDate: '2026-11-14', method: 'card' },
    annotations: line.vatRate === 'zw' ? { vatExemptionBasis: 'art. 113 ust. 1 ustawy o VAT' } : undefined,
  } as Invoice;
}

describe('FZ-008: VAT pozycji w walidacji wysyłki (art. 106e ust. 1 pkt 14, ust. 7, 9 i 11)', () => {
  const now = new Date('2026-11-14T12:00:00.000Z');

  it('VAT od netto i VAT od brutto przechodzą', () => {
    expect(validateInvoice(fakturaZPozycja({ unitPriceNet: 17.07, netAmount: 17.07, vatAmount: 3.93, grossAmount: 21, vatRate: '23' }), now)).toEqual([]);
    expect(validateInvoice(fakturaZPozycja({ unitPriceNet: 17.07, netAmount: 17.07, vatAmount: 3.92, grossAmount: 20.99, vatRate: '23' }), now)).toEqual([]);
  });

  it('stawki 8 % i 5 %: VAT od brutto przechodzi także tam, gdzie różni się o grosz od VAT od netto', () => {
    // Pierwsze trzy kwoty brutto w każdej stawce, przy których VAT od brutto ≠ VAT od netto z tego samego netto.
    const rozne: Array<{ rate: '8' | '5'; g: number }> = [];
    for (const rate of ['8', '5'] as const) {
      const s = Number(rate);
      for (let g = 1; g <= 20_000 && rozne.filter((r) => r.rate === rate).length < 3; g++) {
        const v = Math.floor((g * s * 2 + (100 + s)) / (2 * (100 + s)));
        const n = g - v;
        if (Math.floor((n * s + 50) / 100) !== v) rozne.push({ rate, g });
      }
    }
    expect(rozne.length).toBe(6);
    for (const { rate, g } of rozne) {
      const s = Number(rate);
      const v = Math.floor((g * s * 2 + (100 + s)) / (2 * (100 + s)));
      const invoice = fakturaZPozycja({ unitPriceNet: zl(g - v), netAmount: zl(g - v), vatAmount: zl(v), grossAmount: zl(g), vatRate: rate });
      expect(validateInvoice(invoice, now)).toEqual([]);
    }
  });

  it('VAT niezgodny z obiema metodami jest odrzucany, także gdy różnica to 1 grosz, którą liczby zmiennoprzecinkowe przepuszczały', () => {
    // netto 0,08, stawka 23 %: od netto 0,0184 → 0,02; VAT 0,03 daje brutto 0,11, a od brutto 0,11·23/123 = 0,0206 → 0,02.
    // Dawniej cała faktura przechodziła: |0,02 − 0,03| i |0,10 − 0,11| wychodziły na liczbach zmiennoprzecinkowych ≤ 0,01.
    const errors = validateInvoice(fakturaZPozycja({ unitPriceNet: 0.08, netAmount: 0.08, vatAmount: 0.03, grossAmount: 0.11, vatRate: '23' }), now);
    expect(errors).toEqual(['Pozycja 1: VAT (0.03) nie wynika ze stawki 23%: od netto 0.08 wychodzi 0.02, a od brutto 0.11 wychodzi 0.02.']);
    expect(validateInvoice(fakturaZPozycja({ unitPriceNet: 17.07, netAmount: 17.07, vatAmount: 3.94, grossAmount: 21.01, vatRate: '23' }), now)).not.toEqual([]);
    expect(validateInvoice(fakturaZPozycja({ unitPriceNet: 17.07, netAmount: 17.07, vatAmount: 3.91, grossAmount: 20.98, vatRate: '23' }), now)).not.toEqual([]);
  });

  it('brutto pozycji różne od netto + VAT jest odrzucane', () => {
    const errors = validateInvoice(fakturaZPozycja({ unitPriceNet: 17.07, netAmount: 17.07, vatAmount: 3.92, grossAmount: 21, vatRate: '23' }), now);
    expect(errors.join(' ')).toMatch(/Pozycja 1: brutto \(21\) to nie netto \+ VAT \(20\.99\)/);
  });

  it('stawka bez VAT (zw, 0 %) z VAT w pozycji jest odrzucana', () => {
    for (const vatRate of ['zw', '0'] as const) {
      const errors = validateInvoice(fakturaZPozycja({ unitPriceNet: 100, netAmount: 100, vatAmount: 0.01, grossAmount: 100.01, vatRate }), now);
      expect(errors.join(' ')).toMatch(/Pozycja 1: stawka/);
    }
  });
});

/**
 * Wyrocznia niezależna od kodu: liczby całkowite BigInt, połówka w górę
 * (art. 106e ust. 11), wzory z ust. 1 pkt 14 (od netto) i ust. 7 (od brutto).
 */
function wyroczniaVat(nettoGr: number, vatGr: number, stawka: number): boolean {
  const [n, v, s] = [BigInt(nettoGr), BigInt(vatGr), BigInt(stawka)];
  const [dwa, sto] = [BigInt(2), BigInt(100)];
  const odNetto = (dwa * s * n + sto) / (dwa * sto);
  const brutto = n + v;
  const odBrutto = (dwa * s * brutto + (sto + s)) / (dwa * (sto + s));
  return v === odNetto || v === odBrutto;
}

describe('FZ-008: VAT pozycji przyjęty wtedy i tylko wtedy, gdy wynika z netto albo z brutto', () => {
  const now = new Date('2026-11-14T12:00:00.000Z');
  const STAWKI = [['23', 23], ['8', 8], ['5', 5], ['0', 0]] as const;
  const bladVat = (errors: string[]) => errors.some((e) => e.includes('nie wynika ze stawki') || e.includes('nie ma VAT'));

  it('losowe netto do 10 mln zł, VAT w pobliżu VAT od netto, stawki 23, 8, 5 i 0 %', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: -3, max: 3 }),
        fc.constantFrom(...STAWKI),
        (nettoGr, przesuniecie, [vatRate, stawka]) => {
          const vatGr = Math.max(0, Math.floor((2 * stawka * nettoGr + 100) / 200) + przesuniecie);
          const invoice = fakturaZPozycja({
            unitPriceNet: nettoGr / 100,
            netAmount: nettoGr / 100,
            vatAmount: vatGr / 100,
            grossAmount: (nettoGr + vatGr) / 100,
            vatRate,
          });
          expect(bladVat(validateInvoice(invoice, now))).toBe(!wyroczniaVat(nettoGr, vatGr, stawka));
        },
      ),
      { numRuns: 5000 },
    );
  });

  it('remis (dokładnie pół grosza) rozstrzyga połówka w górę: stawka 4 % spoza listy, netto 0,13 zł', () => {
    // od netto 0,13 · 4 % = 0,0052 → 0,01; od brutto 0,13 · 4/104 = 0,005 → 0,01. VAT 0 nie wynika z żadnej metody.
    expect(lineVatMatchesRate(13, 0, 4)).toBe(false);
    expect(lineVatMatchesRate(13, 1, 4)).toBe(true);
  });

  it('nieznana stawka w pozycji: błąd z nazwą stawki i tym, co zrobić', () => {
    const invoice = fakturaZPozycja({ unitPriceNet: 100, netAmount: 100, vatAmount: 7, grossAmount: 107, vatRate: '7' as never });
    expect(validateInvoice(invoice, now)).toContain('Pozycja 1: nieznana stawka VAT „7”. Wybierz w pozycji stawkę z listy formularza.');
  });
});
