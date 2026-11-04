import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AUD-70 KOR (część K1): korekta zwykłej faktury wystawionej firmie z innego
 * państwa UE (numer VAT-UE) i stawka „np. II” w korekcie.
 *
 * - nabywca korekty = nabywca faktury pierwotnej, także firma z UE (VAT-UE
 *   w postaci kanonicznej, adres z krajem ≠ PL); zmiana typu nabywcy odpada,
 * - zapis w bazie jak przy zwykłej fakturze (AUD-70): `is_b2c=false`,
 *   `buyer_id_type='nip'`, `buyer_nip=NULL`, VAT-UE w `buyer_data`,
 * - „np. II” tylko dla nabywcy z UE poza PL i XI (Irlandia Płn. — towary),
 * - korekta kwotowa przejmuje stawkę bez VAT z faktury pierwotnej
 *   (serwer ją wyznacza; inna wartość od klienta — odrzucona).
 */

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  logAudit: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: mocks.requireAuth,
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.logAudit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({
  enqueueKsefSubmitAfterDraft: mocks.enqueue,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/xml/invoice-calculator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/invoice-calculator')>(),
  // Fikcyjny NIP 1234567890 nie ma poprawnej sumy kontrolnej — jak w innych testach akcji.
  validateNipChecksum: () => true,
}));

import {
  getCorrectionParentContextAction,
  saveAndSendCorrectionAction,
  saveCorrectionDraftAction,
} from '@/components/invoices/correction-actions';
import {
  correctionInvoiceSchema,
  correctionNpIiBuyerError,
  type CorrectionInvoiceSchemaIn,
} from '@/lib/validators/invoice-validators';
import {
  NP_II_NOT_FOR_XI_MESSAGE,
  NP_II_CORRECTION_BUYER_MESSAGE,
} from '@/lib/schemas/invoice-form';
import type { CorrectionInvoiceData } from '@/types/invoice-types';

const tenantId = '11111111-1111-4111-8111-111111111111';
const parentId = '22222222-2222-4222-8222-222222222222';
const sellerNip = '1234567890';
const parentNumber = 'FV/2026/10/1';
const ksefNumber = '1234567890-20261001-ABCDEF';
const plAddress = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };
const deAddress = { countryCode: 'DE', addressLine1: 'Teststraße 1', addressLine2: '10115 Berlin' };
const seller = { nip: sellerNip, name: 'Firma testowa', address: plAddress };
type Address = { countryCode: string; addressLine1: string; addressLine2?: string };

/** `buyer_data` zwykłej faktury dla firmy z UE — tak zapisuje ją `components/invoices/actions.ts`. */
const euParty = (vatUeNumber: string, address: Partial<Address> = deAddress) => ({
  vatUeNumber, name: 'Kunde GmbH', address, jst: 2, gv: 2,
});
const b2bParty = { nip: sellerNip, name: 'Nabywca testowy', address: plAddress, jst: 2, gv: 2 };

const euBuyer = (vatUeNumber = 'DE123456789', address: Address = deAddress) => ({
  type: 'eu' as const, vatUeNumber, name: 'Kunde GmbH', address,
});
const b2bBuyer = {
  type: 'b2b' as const, idType: 'nip' as const, nip: sellerNip, name: 'Nabywca testowy', address: plAddress,
};

const npIiLine = { name: 'Wdrożenie systemu', unit: 'usł.', quantity: 1, unitPriceNet: 1000, vatRate: 'np_ii' as const };
const dbLine = (vat_rate: string, unit_price_net = 1000) => ({
  name: 'Wdrożenie systemu', unit: 'usł.', quantity: 1, unit_price_net, vat_rate,
});

type Row = Record<string, unknown>;
type QueryLog = { table: string; operation: string; filters: Record<string, unknown>; payload?: unknown };
let parent: Row;
let lines: Row[];
let queries: QueryLog[];

function from(table: string) {
  const record: QueryLog = { table, operation: 'select', filters: {} };
  queries.push(record);
  const result = () => {
    if (table === 'tenants') {
      return { data: { id: tenantId, nip: sellerNip, name: 'Firma testowa', address_json: plAddress }, error: null };
    }
    if (table === 'invoices' && record.operation === 'insert') {
      return { data: { id: '33333333-3333-4333-8333-333333333333' }, error: null };
    }
    if (table === 'invoices') {
      const match = Object.entries(record.filters).every(([key, value]) => parent[key] === value);
      return { data: match ? parent : null, error: null };
    }
    if (table === 'invoice_line_items' && record.operation === 'select') {
      return { data: lines, error: null };
    }
    return { data: null, error: null };
  };
  const chain = {
    select: () => chain,
    eq: (key: string, value: unknown) => { record.filters[key] = value; return chain; },
    order: () => chain,
    insert: (payload: unknown) => { record.operation = 'insert'; record.payload = payload; return chain; },
    maybeSingle: async () => result(),
    single: async () => result(),
    then: <T,>(resolve: (value: ReturnType<typeof result>) => T) => Promise.resolve(result()).then(resolve),
  };
  return chain;
}

function setParent(buyerData: unknown, rates: string[], totals?: { net: number; vat: number; gross: number }) {
  lines = rates.map((rate) => dbLine(rate));
  const net = 1000 * rates.length;
  const vat = rates.reduce((sum, rate) => sum + (rate === '23' ? 230 : 0), 0);
  parent = {
    ...parent,
    buyer_data: buyerData,
    net_total: totals?.net ?? net,
    vat_total: totals?.vat ?? vat,
    gross_total: totals?.gross ?? net + vat,
  };
}

function payload(patch: Partial<CorrectionInvoiceSchemaIn> = {}): CorrectionInvoiceSchemaIn {
  return {
    invoiceType: 'correction',
    internalNumber: 'KOR/2026/10/1',
    issueDate: '2026-10-02',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-10-16',
    parentInvoiceId: parentId,
    parentInvoiceNumber: parentNumber,
    parentInvoiceIssueDate: '2026-10-01',
    parentKsefNumber: ksefNumber,
    correctionType: 'before_after',
    correctionReason: 'Rabat po reklamacji',
    typKorekty: '2',
    seller,
    buyer: euBuyer(),
    linesBefore: [npIiLine],
    linesAfter: [{ ...npIiLine, unitPriceNet: 800 }],
    ...patch,
  };
}

const amountChange = (patch: Record<string, unknown> = {}) => ({
  netDelta: -100, vatDelta: 0, grossDelta: -100, description: 'Rabat posprzedażowy', ...patch,
}) as CorrectionInvoiceSchemaIn['amountChange'];

function insertOf(table: string) {
  return queries.find((query) => query.table === table && query.operation === 'insert')?.payload;
}

function expectNoWrite() {
  expect(queries.some((query) => query.operation === 'insert')).toBe(false);
  expect(mocks.enqueue).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  // Wysyłka przyjmuje tylko dzisiejszą datę wystawienia (A1, W5) — testy
  // działają w dniu daty z danych testowych (2026-10-02).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-02T10:00:00Z'));
  queries = [];
  parent = {
    id: parentId, tenant_id: tenantId, direction: 'outgoing', invoice_kind: 'regular',
    ksef_status: 'accepted', ksef_environment: 'test',
    issue_date: '2026-10-01', internal_number: parentNumber, ksef_number: ksefNumber,
    seller_data: seller,
  };
  setParent(euParty('DE123456789'), ['np_ii']);
  mocks.requireAuth.mockResolvedValue({
    supabase: { from },
    user: { id: 'fixture-user' },
    tenantId,
    role: 'member',
  });
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ════════════════════════════════════════════════════════════════════════════
// Reguła np. II — wspólna dla akcji, formularza i generatora
// ════════════════════════════════════════════════════════════════════════════

describe('correctionNpIiBuyerError', () => {
  it.each([
    ['DE', euBuyer('DE123456789')],
    ['EL (Grecja)', euBuyer('EL123456789', { ...deAddress, countryCode: 'GR' })],
  ])('np. II dla firmy z UE (%s) — bez błędu', (_label, buyer) => {
    expect(correctionNpIiBuyerError({ buyer, linesBefore: [npIiLine], linesAfter: [npIiLine] })).toBeNull();
    expect(correctionNpIiBuyerError({ buyer, amountChange: { vatRate: 'np_ii' } })).toBeNull();
  });

  it('np. II dla Irlandii Płn. (XI) — odrzucone osobnym komunikatem', () => {
    const buyer = euBuyer('XI123456789', { ...deAddress, countryCode: 'XI' });
    expect(correctionNpIiBuyerError({ buyer, linesAfter: [npIiLine] })).toBe(NP_II_NOT_FOR_XI_MESSAGE);
    expect(correctionNpIiBuyerError({ buyer, amountChange: { vatRate: 'np_ii' } })).toBe(NP_II_NOT_FOR_XI_MESSAGE);
    // np. I (poza krajem) dla XI jest w porządku.
    expect(correctionNpIiBuyerError({ buyer, linesAfter: [{ vatRate: 'np' }] })).toBeNull();
  });

  it.each([
    ['pozycja przed', { linesBefore: [npIiLine] }],
    ['pozycja po', { linesAfter: [{ vatRate: '23' }, npIiLine] }],
    ['korekta kwotowa', { amountChange: { vatRate: 'np_ii' } }],
  ])('np. II dla firmy z NIP (%s) — odrzucone', (_label, patch) => {
    expect(correctionNpIiBuyerError({ buyer: b2bBuyer, ...patch })).toBe(NP_II_CORRECTION_BUYER_MESSAGE);
  });

  it('stawka korekty kwotowej liczy się tylko w korekcie kwotowej', () => {
    const amountChange = { vatRate: 'np_ii' };
    expect(correctionNpIiBuyerError({ buyer: b2bBuyer, correctionType: 'before_after', amountChange }))
      .toBeNull();
    expect(correctionNpIiBuyerError({ buyer: b2bBuyer, correctionType: 'amount_change', amountChange }))
      .toBe(NP_II_CORRECTION_BUYER_MESSAGE);
  });

  it('bez np. II — bez błędu, także dla firmy z NIP', () => {
    expect(correctionNpIiBuyerError({
      buyer: b2bBuyer, linesBefore: [{ vatRate: '23' }], linesAfter: [{ vatRate: 'np' }], amountChange: { vatRate: 'oo' },
    })).toBeNull();
  });

  it('przyjmuje dane generatora KOR (`CorrectionInvoiceData`)', () => {
    // Typ sprawdza tsc: generator woła regułę wprost na danych korekty.
    const fromGenerator: (data: CorrectionInvoiceData) => string | null = correctionNpIiBuyerError;
    expect(fromGenerator).toBe(correctionNpIiBuyerError);
  });

  it('schemat korekty odrzuca np. II dla firmy z NIP (klient i serwer)', () => {
    const result = correctionInvoiceSchema.safeParse(payload({ buyer: b2bBuyer }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toContain(NP_II_CORRECTION_BUYER_MESSAGE);
    expect(correctionInvoiceSchema.safeParse(payload()).success).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Kontekst faktury pierwotnej dla formularza
// ════════════════════════════════════════════════════════════════════════════

describe('getCorrectionParentContextAction — nabywca z UE', () => {
  it('firma z UE: nabywca typu eu, VAT-UE i np. II dozwolone, stawka korekty kwotowej', async () => {
    const res = await getCorrectionParentContextAction(parentId);
    expect(res).toMatchObject({
      success: true,
      buyer: { type: 'eu', vatUeNumber: 'DE123456789', name: 'Kunde GmbH', address: deAddress },
      buyerVatUe: 'DE123456789',
      npIiAllowed: true,
      amountChangeVatRate: 'np_ii',
      linesBefore: [npIiLine],
    });
    if (res.success) expect(res.buyer).not.toHaveProperty('nip');
    expectNoWrite();
  });

  it('numer VAT-UE w bazie w innej postaci — kanoniczny', async () => {
    setParent(euParty('de 123.456-789'), ['np_ii']);
    expect(await getCorrectionParentContextAction(parentId)).toMatchObject({
      success: true, buyer: { vatUeNumber: 'DE123456789' }, buyerVatUe: 'DE123456789',
    });
  });

  it('Grecja: VAT-UE z EL, adres z GR', async () => {
    setParent(euParty('EL123456789', { ...deAddress, countryCode: 'GR' }), ['np_ii']);
    expect(await getCorrectionParentContextAction(parentId)).toMatchObject({
      success: true, buyer: { vatUeNumber: 'EL123456789', address: { countryCode: 'GR' } }, npIiAllowed: true,
    });
  });

  it('Irlandia Płn. (XI): nabywca z UE, ale bez np. II', async () => {
    setParent(euParty('XI123456789', { ...deAddress, countryCode: 'XI' }), ['np']);
    expect(await getCorrectionParentContextAction(parentId)).toMatchObject({
      success: true, buyer: { type: 'eu', vatUeNumber: 'XI123456789' }, npIiAllowed: false, amountChangeVatRate: 'np',
    });
  });

  it.each([
    ['Irlandia Płn. (XI)', euParty('XI123456789', { ...deAddress, countryCode: 'XI' }), NP_II_NOT_FOR_XI_MESSAGE],
    ['firma z NIP', b2bParty, NP_II_CORRECTION_BUYER_MESSAGE],
  ])('faktura z np. II dla nabywcy bez prawa do np. II (%s) — odmowa od razu', async (_label, buyerData, message) => {
    setParent(buyerData, ['np_ii']);
    expect(await getCorrectionParentContextAction(parentId)).toEqual({ success: false, error: message });
  });

  it('firma z NIP: bez VAT-UE, bez np. II, stawka z kwot', async () => {
    setParent(b2bParty, ['23']);
    const res = await getCorrectionParentContextAction(parentId);
    expect(res).toMatchObject({ success: true, buyer: { type: 'b2b', nip: sellerNip }, npIiAllowed: false });
    if (res.success) {
      expect(res.buyerVatUe).toBeUndefined();
      expect(res.amountChangeVatRate).toBeUndefined();
    }
  });

  it.each([
    ['polski numer VAT-UE zamiast NIP', euParty('PL1234567890', plAddress), 'PL'],
    ['nieczytelny numer VAT-UE', euParty('US123456789'), 'VAT-UE'],
    ['adres w Polsce', euParty('DE123456789', plAddress), 'kraj'],
    ['brak kraju w adresie', euParty('DE123456789', { addressLine1: 'Teststraße 1', addressLine2: '10115 Berlin' }), 'kraj'],
    ['osoba prywatna', { name: 'Jan Testowy', address: plAddress, noIdMarker: true }, 'NIP'],
  ])('odmawia, gdy na fakturze pierwotnej: %s', async (_label, buyerData, fragment) => {
    setParent(buyerData, ['np']);
    const res = await getCorrectionParentContextAction(parentId);
    expect(res).toMatchObject({ success: false, error: expect.stringContaining(fragment) });
    expectNoWrite();
  });

  it.each([
    ['np_ii', 'np_ii'],
    ['np II', 'np_ii'],
    ['np I', 'np'],
    ['np', 'np'],
  ])('stawka „%s” z bazy → %s', async (stored, expected) => {
    setParent(euParty('DE123456789'), [stored]);
    expect(await getCorrectionParentContextAction(parentId)).toMatchObject({
      success: true, linesBefore: [{ vatRate: expected }],
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Zapis korekty
// ════════════════════════════════════════════════════════════════════════════

describe('saveCorrectionDraftAction — nabywca z UE', () => {
  it('przed/po: kolumny nabywcy jak przy zwykłej fakturze dla firmy z UE, pozycje np. II', async () => {
    const res = await saveCorrectionDraftAction(payload(), tenantId);
    expect(res).toMatchObject({ success: true });
    const invoice = insertOf('invoices') as Row;
    expect(invoice).toMatchObject({
      is_b2c: false,
      buyer_id_type: 'nip',
      buyer_nip: null,
      buyer_data: { vatUeNumber: 'DE123456789', name: 'Kunde GmbH', address: { countryCode: 'DE' } },
      fa3_data: expect.objectContaining({ buyer: expect.objectContaining({ vatUeNumber: 'DE123456789' }) }),
      net_total: -200, vat_total: 0, gross_total: -200,
    });
    expect(invoice.buyer_data).not.toHaveProperty('nip');
    expect(insertOf('invoice_line_items')).toEqual([expect.objectContaining({ vat_rate: 'np_ii', vat_amount: 0 })]);
  });

  it('numer VAT-UE od klienta w innej postaci — zapisany kanoniczny z faktury pierwotnej', async () => {
    const res = await saveCorrectionDraftAction(payload({ buyer: euBuyer('de123456789') }), tenantId);
    expect(res).toMatchObject({ success: true });
    expect(insertOf('invoices')).toMatchObject({ buyer_data: { vatUeNumber: 'DE123456789' } });
  });

  it('firma z NIP: kolumny nabywcy jawnie (is_b2c=false, nip)', async () => {
    setParent(b2bParty, ['23']);
    const res = await saveCorrectionDraftAction(payload({
      buyer: b2bBuyer,
      linesBefore: [{ ...npIiLine, vatRate: '23' }],
      linesAfter: [{ ...npIiLine, vatRate: '23', unitPriceNet: 800 }],
    }), tenantId);
    expect(res).toMatchObject({ success: true });
    expect(insertOf('invoices')).toMatchObject({ is_b2c: false, buyer_id_type: 'nip', buyer_nip: sellerNip });
  });

  it.each([
    ['inny numer VAT-UE', () => euBuyer('DE999999999')],
    ['inna nazwa', () => ({ ...euBuyer(), name: 'Andere GmbH' })],
    ['inny kraj adresu', () => euBuyer('DE123456789', { ...deAddress, countryCode: 'AT' })],
    ['inny adres', () => euBuyer('DE123456789', { ...deAddress, addressLine1: 'Andere Straße 2' })],
    ['firma z NIP zamiast z UE', () => b2bBuyer],
  ])('odrzuca nabywcę innego niż na fakturze pierwotnej (%s)', async (_label, buyer) => {
    // Pozycje np. I — odrzucenie wynika z nabywcy, nie z reguły np. II.
    setParent(euParty('DE123456789'), ['np']);
    const res = await saveCorrectionDraftAction(payload({
      buyer: buyer(),
      linesBefore: [{ ...npIiLine, vatRate: 'np' }],
      linesAfter: [{ ...npIiLine, vatRate: 'np', unitPriceNet: 800 }],
    }), tenantId);
    expect(res).toMatchObject({ success: false, error: expect.stringContaining('nabywcę') });
    expectNoWrite();
  });

  it('odrzuca nabywcę z UE, gdy na fakturze pierwotnej jest firma z NIP', async () => {
    setParent(b2bParty, ['np']);
    const res = await saveCorrectionDraftAction(payload({
      linesBefore: [{ ...npIiLine, vatRate: 'np' }],
      linesAfter: [{ ...npIiLine, vatRate: 'np', unitPriceNet: 800 }],
    }), tenantId);
    expect(res).toMatchObject({ success: false, error: expect.stringContaining('nabywcę') });
    expectNoWrite();
  });

  it('odrzuca np. II w korekcie faktury dla firmy z NIP', async () => {
    setParent(b2bParty, ['23']);
    const res = await saveCorrectionDraftAction(payload({
      buyer: b2bBuyer,
      linesBefore: [{ ...npIiLine, vatRate: '23' }],
      linesAfter: [{ ...npIiLine, unitPriceNet: 800 }],
    }), tenantId);
    expect(res).toMatchObject({ success: false, error: expect.stringContaining(NP_II_CORRECTION_BUYER_MESSAGE) });
    expectNoWrite();
  });

  it('odrzuca np. II dla Irlandii Płn. (XI)', async () => {
    const xiAddress = { ...deAddress, countryCode: 'XI' };
    setParent(euParty('XI123456789', xiAddress), ['np_ii']);
    const res = await saveCorrectionDraftAction(payload({ buyer: euBuyer('XI123456789', xiAddress) }), tenantId);
    expect(res).toMatchObject({ success: false, error: expect.stringContaining(NP_II_NOT_FOR_XI_MESSAGE) });
    expectNoWrite();
  });

  it('anulowanie faktury np. II — pozycje z bazy, stawka np_ii', async () => {
    const res = await saveCorrectionDraftAction(payload({
      correctionType: 'cancellation', linesBefore: undefined, linesAfter: undefined,
    }), tenantId);
    expect(res).toMatchObject({ success: true });
    expect(insertOf('invoice_line_items')).toEqual([
      expect.objectContaining({ vat_rate: 'np_ii', quantity: -1, net_amount: -1000 }),
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Korekta kwotowa — stawka bez VAT z faktury pierwotnej
// ════════════════════════════════════════════════════════════════════════════

describe('korekta kwotowa — stawka bez VAT wyznacza serwer', () => {
  const amountPayload = (change: CorrectionInvoiceSchemaIn['amountChange']) => payload({
    correctionType: 'amount_change', linesBefore: undefined, linesAfter: undefined, amountChange: change,
  });

  it('faktura np. II, klient bez stawki: zapis z np_ii (nie „0 KR”)', async () => {
    const res = await saveCorrectionDraftAction(amountPayload(amountChange()), tenantId);
    expect(res).toMatchObject({ success: true });
    expect(insertOf('invoice_line_items')).toEqual([
      expect.objectContaining({ vat_rate: 'np_ii', net_amount: -100, vat_amount: 0, gross_amount: -100 }),
    ]);
  });

  it('faktura np. II, klient z tą samą stawką: wysyłka (TEST) niesie np_ii w danych korekty', async () => {
    const res = await saveAndSendCorrectionAction(amountPayload(amountChange({ vatRate: 'np_ii' })), tenantId);
    expect(res).toMatchObject({ success: true });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const { correctionData, invoice } = mocks.enqueue.mock.calls[0]![0];
    expect(correctionData.amountChange).toMatchObject({ vatRate: 'np_ii', netDelta: -100, vatDelta: 0 });
    expect(correctionData.buyer).toMatchObject({ type: 'eu', vatUeNumber: 'DE123456789' });
    expect(invoice.buyer).toMatchObject({ vatUeNumber: 'DE123456789' });
    expect(invoice.buyer.nip).toBeUndefined();
  });

  it('stan przed z bazy, nie z formularza (P_18 w XML liczy się z faktury pierwotnej)', async () => {
    const res = await saveAndSendCorrectionAction(payload({
      correctionType: 'amount_change',
      linesBefore: [{ name: 'Inna', unit: 'szt.', quantity: 1, unitPriceNet: 1, vatRate: 'oo' }],
      linesAfter: undefined,
      amountChange: amountChange({ vatRate: 'np_ii' }),
    }), tenantId);
    expect(res).toMatchObject({ success: true });
    const { correctionData } = mocks.enqueue.mock.calls[0]![0];
    expect(correctionData.linesBefore.map((l: { vatRate: string }) => l.vatRate)).toEqual(['np_ii']);
  });

  it.each([
    ['np. II, klient wysyła np', ['np_ii'], { vatRate: 'np' }, 'różni się od stawki'],
    ['23%, klient wysyła oo', ['23'], { vatRate: 'oo' }, 'różni się od stawki'],
    ['np. II, klient wysyła VAT ≠ 0', ['np_ii'], { vatDelta: -23, grossDelta: -123 }, 'różnica VAT musi być 0'],
    ['np. II i 23% razem, VAT 0 (stawka niejednoznaczna)', ['23', 'np_ii'], {}, 'niejednoznaczna'],
    ['np i np. II razem, VAT 0 (stawka niejednoznaczna)', ['np', 'np_ii'], {}, 'niejednoznaczna'],
  ])('odrzuca: %s', async (_label, rates, change, fragment) => {
    setParent(euParty('DE123456789'), rates);
    const res = await saveCorrectionDraftAction(amountPayload(amountChange(change)), tenantId);
    expect(res).toMatchObject({ success: false, error: expect.stringContaining(fragment) });
    expectNoWrite();
  });

  it('faktura z 23% i np. II: korekta z VAT 23% przechodzi jako 23', async () => {
    setParent(euParty('DE123456789'), ['23', 'np_ii']);
    const res = await saveCorrectionDraftAction(amountPayload(amountChange({ vatDelta: -23, grossDelta: -123 })), tenantId);
    expect(res).toMatchObject({ success: true });
    expect(insertOf('invoice_line_items')).toEqual([expect.objectContaining({ vat_rate: '23' })]);
  });

  it('faktura dla firmy z NIP ze stawką oo: korekta kwotowa z oo', async () => {
    setParent(b2bParty, ['oo']);
    const res = await saveCorrectionDraftAction({ ...amountPayload(amountChange()), buyer: b2bBuyer }, tenantId);
    expect(res).toMatchObject({ success: true });
    expect(insertOf('invoice_line_items')).toEqual([expect.objectContaining({ vat_rate: 'oo' })]);
  });

  it('faktura dla firmy z NIP ze stawką 23%: zachowanie bez zmian (stawka z kwot)', async () => {
    setParent(b2bParty, ['23']);
    const res = await saveCorrectionDraftAction({
      ...amountPayload(amountChange({ vatDelta: -23, grossDelta: -123 })), buyer: b2bBuyer,
    }, tenantId);
    expect(res).toMatchObject({ success: true });
    expect(insertOf('invoice_line_items')).toEqual([expect.objectContaining({ vat_rate: '23' })]);
  });
});

describe('wstrzymanie wysyłki KOR w PROD obejmuje korektę dla firmy z UE', () => {
  it('PROD: brak zapisu i kolejki', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    parent.ksef_environment = 'production';
    const res = await saveAndSendCorrectionAction(payload(), tenantId);
    expect(res).toMatchObject({ success: false, error: expect.stringContaining('PROD') });
    expectNoWrite();
  });
});
