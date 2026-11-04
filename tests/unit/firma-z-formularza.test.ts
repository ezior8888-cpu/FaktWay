import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * UX-01 (przyczyna: WZR-02 / MOD-S01 z przeglądu architektury 26.10).
 *
 * Biuro rachunkowe ma dwie karty. W pierwszej jest formularz wyrenderowany
 * dla firmy A, w drugiej ktoś przełącza się na firmę B — ciasteczko aktywnej
 * firmy wskazuje teraz B. Akcja wystawiania brała firmę z ciasteczka w chwili
 * kliknięcia, więc zwykła faktura VAT zapisywała się i szła do KSeF jako
 * dokument firmy B, z nabywcą i pozycjami z formularza firmy A.
 *
 * Naprawa: strona podaje formularzowi id firmy, dla której go wyrenderowała,
 * a formularz odsyła je akcji jako `expectedTenantId`. Akcja porównuje je
 * z firmą z ciasteczka w `requireUserAndActiveOrg` i przy niezgodności albo
 * braku pola odmawia — zanim przeczyta dane firmy, zapisze dokument albo
 * zleci wysyłkę. Pole służy wyłącznie do porównania: firmą dokumentu dalej
 * jest firma z sesji (ciasteczko + aktywne członkostwo).
 *
 * Ścieżka prawdziwa: akcje wystawiania, `requireUserAndActiveOrg`,
 * `getVerifiedMfaState`, schematy Zod. Atrapy: klienty Supabase (baza),
 * ciasteczka (HTTP), kolejka wysyłki i audyt (zapisy w bazie), GUS (HTTP).
 */

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(), createAdminClient: vi.fn(), cookies: vi.fn(),
  getSession: vi.fn(), getUser: vi.fn(), getClaims: vi.fn(),
  from: vi.fn(), adminFrom: vi.fn(),
  audit: vi.fn(), enqueue: vi.fn(), gus: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient, createAdminClient: mocks.createAdminClient }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: mocks.enqueue }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: mocks.gus }));
vi.mock('@/lib/xml/invoice-calculator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/invoice-calculator')>(),
  // Fikcyjne NIP-y testowe nie mają poprawnej sumy kontrolnej.
  validateNipChecksum: () => true,
}));

import { saveAndSendInvoiceAction, saveDraftAction } from '@/components/invoices/actions';
import { saveAdvanceAction, saveAndSendAdvanceAction } from '@/components/invoices/advance-actions';
import { saveAndSendCorrectionAction, saveCorrectionDraftAction } from '@/components/invoices/correction-actions';
import { saveAndSendFinalAction, saveFinalAction } from '@/components/invoices/final-actions';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { ACTIVE_ORG_COOKIE } from '@/lib/supabase/active-org';
import type { CorrectionInvoiceSchemaIn } from '@/lib/validators/invoice-validators';

/** Komunikat odmowy: która firma jest aktywna i obie drogi wyjścia (protokół, pkt 4). */
const firmaZmieniona = (aktywna: string | null) =>
  `Aktywna firma zmieniła się od otwarcia formularza${aktywna ? ` (teraz: ${aktywna})` : ''}. `
  + 'Przełącz firmę z powrotem w karcie, w której ją zmieniono, i zapisz ponownie '
  + '— albo odśwież tę stronę i wypełnij formularz dla aktywnej firmy.';
const FIRMA_ZMIENIONA = firmaZmieniona('Firma B');

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** Firma, w której użytkownik NIE jest członkiem (np. podrobione ciasteczko). */
const TENANT_OBCA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const USER = 'user-biuro-rachunkowe';
const TOKEN = 'synthetic-access-token';
const ADDRESS = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };
const TENANTS: Record<string, { id: string; nip: string; name: string }> = {
  [TENANT_A]: { id: TENANT_A, nip: '1234567890', name: 'Firma A' },
  [TENANT_B]: { id: TENANT_B, nip: '0987654321', name: 'Firma B' },
};
const sellerOf = (tenantId: string) => ({ nip: TENANTS[tenantId]!.nip, name: TENANTS[tenantId]!.name, address: ADDRESS });

const vatForm: InvoiceFormValues = {
  internalNumber: 'FV/1/10/2026', issueDate: '2026-10-27', saleDate: '',
  buyerNip: '5252241585', buyerName: 'Nabywca firmy A', buyerAddressLine1: 'ul. B 2',
  buyerAddressLine2: '00-002 Warszawa', buyerEmail: '', buyerIsConsumer: false,
  buyerPesel: '', buyerIdDocument: '', paymentMethod: 'transfer', paymentDueDate: '2026-11-10',
  bankAccount: 'PL61109010140000071219812874',
  lines: [{ name: 'Usługa dla A', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
};
const buyer = { type: 'b2b' as const, idType: 'nip' as const, nip: '5252241585', name: 'Nabywca', address: ADDRESS };
const special = (tenantId: string) => ({
  internalNumber: 'SPEC/10/2026', issueDate: '2026-10-27', paymentMethod: 'transfer' as const,
  paymentDueDate: '2026-11-03', bankAccount: '1'.repeat(26), seller: sellerOf(tenantId), buyer,
});
const advanceInput = (tenantId: string) => ({
  ...special(tenantId), invoiceType: 'advance' as const, advanceAmount: 123,
  totalContractAmount: 1000, vatRate: '23' as const, description: 'Zaliczka na usługę', splitPayment: false,
});
const finalInput = (tenantId: string) => ({
  ...special(tenantId), invoiceType: 'final' as const,
  advanceInvoiceIds: ['22222222-2222-4222-8222-222222222222'], totalAdvances: 123, splitPayment: false,
  lines: [{ name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23' as const }],
});
const correctionInput = (tenantId: string): CorrectionInvoiceSchemaIn => ({
  ...special(tenantId), invoiceType: 'correction', internalNumber: 'KOR/10/2026',
  parentInvoiceId: '33333333-3333-4333-8333-333333333333', parentInvoiceNumber: 'FV/1/09/2026',
  parentInvoiceIssueDate: '2026-09-10', parentKsefNumber: '1234567890-20260910-ABCDEF',
  correctionType: 'amount_change', correctionReason: 'Rabat', typKorekty: '2',
  amountChange: { netDelta: -10, vatDelta: -2.3, grossDelta: -12.3, description: 'Rabat' },
});

type Query = { table: string; operation: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
let queries: Query[];
let adminQueries: Array<{ table: string; filters: Record<string, unknown> }>;
let tenantNameFails: boolean;
let cookieTenant: string | null;

/** Baza z dwiema firmami jednego użytkownika — wiersz `tenants` wg filtra `id`. */
function from(table: string) {
  const query: Query = { table, operation: 'select', filters: {} };
  queries.push(query);
  const one = () => {
    if (table === 'tenants') {
      const row = TENANTS[String(query.filters.id)];
      return { data: row ? { ...row, address_json: ADDRESS, vat_exemption_basis: null, vat_cash_method: false } : null, error: null };
    }
    if (query.operation === 'insert' && table === 'invoices') return { data: { id: 'nowa-faktura' }, error: null };
    return { data: null, error: null };
  };
  const many = () => (query.operation === 'select' ? { data: [], error: null } : { data: null, error: null });
  const chain = {
    select: () => chain,
    eq: (key: string, value: unknown) => { query.filters[key] = value; return chain; },
    in: () => chain, or: () => chain, not: () => chain, overlaps: () => chain,
    order: () => chain, limit: () => chain,
    insert: (payload: unknown) => { query.operation = 'insert'; query.payload = payload; return chain; },
    update: (payload: unknown) => { query.operation = 'update'; query.payload = payload; return chain; },
    delete: () => { query.operation = 'delete'; return chain; },
    single: async () => one(),
    maybeSingle: async () => one(),
    then: <T,>(resolve: (value: ReturnType<typeof many>) => T) => Promise.resolve(many()).then(resolve),
  };
  return chain;
}

/**
 * Klient serwisowy: członkostwo (użytkownik jest aktywnym członkiem OBU firm)
 * i nazwa firmy do komunikatu odmowy.
 */
function adminFrom(table: string) {
  const filters: Record<string, unknown> = {};
  adminQueries.push({ table, filters });
  const chain = {
    select: () => chain,
    eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
    maybeSingle: async () => {
      if (table === 'tenants') {
        if (tenantNameFails) throw new Error('baza niedostępna');
        const row = TENANTS[String(filters.id)];
        return { data: row ? { name: row.name } : null, error: null };
      }
      return {
        data: table === 'memberships' && filters.user_id === USER && String(filters.organization_id) in TENANTS
          ? { role: 'owner', status: 'active' }
          : null,
        error: null,
      };
    },
  };
  return chain;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  // „Wystaw i wyślij” przyjmuje tylko dzisiejszą datę wystawienia (F-092, A1).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T10:00:00Z'));
  queries = [];
  adminQueries = [];
  tenantNameFails = false;
  cookieTenant = TENANT_B;
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: TOKEN } }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: {
    id: USER, email: 'biuro@example.test', factors: [{ id: 'f', factor_type: 'totp', status: 'verified' }],
  } }, error: null });
  mocks.getClaims.mockResolvedValue({ data: { claims: { sub: USER, aal: 'aal2' } }, error: null });
  mocks.cookies.mockResolvedValue({
    get: (key: string) => (key === ACTIVE_ORG_COOKIE && cookieTenant ? { value: cookieTenant } : undefined),
  });
  mocks.createClient.mockResolvedValue({
    auth: { getSession: mocks.getSession, getUser: mocks.getUser, getClaims: mocks.getClaims },
    from: mocks.from,
  });
  mocks.from.mockImplementation(from);
  mocks.adminFrom.mockImplementation(adminFrom);
  mocks.createAdminClient.mockReturnValue({ from: mocks.adminFrom });
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

type IssueAction = (expectedTenantId: unknown) => Promise<{ success: boolean; error?: string }>;

/**
 * Każda akcja wystawiania wywołana z formularza wyrenderowanego dla `formTenant`:
 * dane dokumentu (sprzedawca na ZAL/ROZ/KOR) i `expectedTenantId` są z tej firmy.
 */
const ISSUE_PATHS: Array<{ path: string; kind: 'szkic' | 'wyślij'; invoke: (formTenant: string) => IssueAction }> = [
  { path: 'VAT', kind: 'szkic', invoke: () => (id) => saveDraftAction(vatForm, id as string) },
  { path: 'VAT', kind: 'wyślij', invoke: () => (id) => saveAndSendInvoiceAction(vatForm, id as string) },
  { path: 'ZAL', kind: 'szkic', invoke: (t) => (id) => saveAdvanceAction(advanceInput(t), id as string) },
  { path: 'ZAL', kind: 'wyślij', invoke: (t) => (id) => saveAndSendAdvanceAction(advanceInput(t), id as string) },
  { path: 'ROZ', kind: 'szkic', invoke: (t) => (id) => saveFinalAction(finalInput(t), id as string) },
  { path: 'ROZ', kind: 'wyślij', invoke: (t) => (id) => saveAndSendFinalAction(finalInput(t), id as string) },
  { path: 'KOR', kind: 'szkic', invoke: (t) => (id) => saveCorrectionDraftAction(correctionInput(t), id as string) },
  { path: 'KOR', kind: 'wyślij', invoke: (t) => (id) => saveAndSendCorrectionAction(correctionInput(t), id as string) },
];

function expectNothingReadOrWritten() {
  // Klient sesji nie dostał ani jednego zapytania: bez odczytu profilu firmy B,
  // bez zapisu dokumentu i pozycji, bez zlecenia wysyłki i wpisu audytu.
  expect(mocks.from).not.toHaveBeenCalled();
  expect(queries.filter((q) => q.operation !== 'select')).toEqual([]);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
}

describe('UX-01: akcja wystawia dokument tylko za firmę, dla której wyrenderowano formularz', () => {
  describe.each(ISSUE_PATHS)('$path — $kind', ({ invoke }) => {
    it('formularz firmy A, ciasteczko firmy B (druga karta) → odmowa bez odczytu i zapisu', async () => {
      const result = await invoke(TENANT_A)(TENANT_A);
      expect(result).toEqual({ success: false, error: FIRMA_ZMIENIONA });
      expectNothingReadOrWritten();
    });

    it.each([
      ['brak pola (karta sprzed wdrożenia)', undefined],
      ['puste pole', ''],
      ['nie tekst', { tenantId: TENANT_B }],
    ])('%s → odmowa bez odczytu i zapisu', async (_label, expectedTenantId) => {
      const result = await invoke(TENANT_B)(expectedTenantId);
      expect(result).toEqual({ success: false, error: FIRMA_ZMIENIONA });
      expectNothingReadOrWritten();
    });

    it('ciasteczko firmy bez członkostwa → odmowa dostępu przed porównaniem, bez odczytu nazwy tej firmy', async () => {
      // Kolejność w requireUserAndActiveOrg: członkostwo, dopiero potem nazwa do
      // komunikatu. Odwrotnie klient serwisowy pokazałby nazwę obcej firmy.
      cookieTenant = TENANT_OBCA;
      const result = await invoke(TENANT_A)(TENANT_A);
      expect(result).toEqual({ success: false, error: 'Brak dostępu do aktywnej organizacji' });
      expect(adminQueries.filter((q) => q.table === 'tenants')).toEqual([]);
      expectNothingReadOrWritten();
    });

    it('formularz i ciasteczko tej samej firmy → kontrola przepuszcza, akcja czyta profil tej firmy', async () => {
      const result = await invoke(TENANT_B)(TENANT_B);
      expect(result.error).not.toBe(FIRMA_ZMIENIONA);
      expect(queries).toContainEqual(expect.objectContaining({ table: 'tenants', filters: { id: TENANT_B } }));
      expect(queries.some((q) => q.table === 'tenants' && q.filters.id === TENANT_A)).toBe(false);
    });
  });

  it('VAT: zgodna firma zapisuje i wysyła dokument tej firmy (ścieżka szczęśliwa bez zmian)', async () => {
    const result = await saveAndSendInvoiceAction(vatForm, TENANT_B);
    expect(result).toEqual({ success: true, invoiceId: 'nowa-faktura', offline: false });
    const insert = queries.find((q) => q.table === 'invoices' && q.operation === 'insert');
    expect(insert?.payload).toMatchObject({ tenant_id: TENANT_B, seller_nip: TENANTS[TENANT_B]!.nip });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_B }));
  });

  it('ZAL: zgodna firma zapisuje szkic tej firmy', async () => {
    const result = await saveAdvanceAction(advanceInput(TENANT_B), TENANT_B);
    expect(result).toEqual({ success: true, invoiceId: 'nowa-faktura' });
    const insert = queries.find((q) => q.table === 'invoices' && q.operation === 'insert');
    expect(insert?.payload).toMatchObject({ tenant_id: TENANT_B, seller_nip: TENANTS[TENANT_B]!.nip });
  });

  it('pole z formularza nie wybiera firmy: id firmy, której użytkownik nie ma w ciasteczku, nie zmienia firmy dokumentu', async () => {
    // Ciasteczko A, pole B — odmowa, a nie dokument firmy B.
    cookieTenant = TENANT_A;
    const result = await saveDraftAction(vatForm, TENANT_B);
    expect(result).toEqual({ success: false, error: firmaZmieniona('Firma A') });
    expectNothingReadOrWritten();
  });

  it('komunikat podaje nazwę AKTYWNEJ firmy — nazwy firmy z pola formularza nie czyta nikt', async () => {
    const obca = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const result = await saveAndSendInvoiceAction(vatForm, obca);
    expect(result).toEqual({ success: false, error: FIRMA_ZMIENIONA });
    const tenantReads = adminQueries.filter((q) => q.table === 'tenants');
    expect(tenantReads).toEqual([{ table: 'tenants', filters: { id: TENANT_B } }]);
    expectNothingReadOrWritten();
  });

  it('nazwa aktywnej firmy się nie odczytała → ta sama odmowa, komunikat bez nazwy', async () => {
    tenantNameFails = true;
    const result = await saveAndSendAdvanceAction(advanceInput(TENANT_A), TENANT_A);
    expect(result).toEqual({ success: false, error: firmaZmieniona(null) });
    expectNothingReadOrWritten();
  });

  it('zgodna firma: bez odczytu nazwy firmy (kontrola nie dokłada zapytań)', async () => {
    await saveDraftAction(vatForm, TENANT_B);
    expect(adminQueries.filter((q) => q.table === 'tenants')).toEqual([]);
  });
});
