import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Akcje Kasy (plan kompletnej aplikacji, krok 3.7) na prawdziwej ścieżce:
 * schemat Zod, kontrola firmy formularza (UX-01), rola, mapowanie wyników RPC
 * i odświeżenie widoków. Atrapy tylko dla sesji, RPC i pamięci podręcznej.
 * Numer, blokadę serii, stan kasy, wpłatę do faktury, wyzwalacze i RLS
 * sprawdza tests/rls-kasa.test.ts na prawdziwym Postgresie.
 */

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  auth: vi.fn(),
  invalidate: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: m.invalidate }));
vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return { ActionAuthError, requireUserAndActiveOrg: m.auth };
});

const { correctCashDocumentAction, issueCashDocumentAction, openCashRegisterAction } = await import('@/app/actions/kasa');
const { ActionAuthError } = await import('@/lib/supabase/auth-context');

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const KEY = '44444444-4444-4444-8444-444444444444';
const DOC = '55555555-5555-4555-8555-555555555555';
const INVOICE = '66666666-6666-4666-8666-666666666666';
const PAYMENT = '77777777-7777-4777-8777-777777777777';
const NBSP = /[  ]/g;
const plain = (text: string) => text.replace(NBSP, ' ');

const dowod = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: KEY,
  kind: 'KP' as const,
  source: 'none' as const,
  invoiceId: '',
  paymentId: '',
  operationDate: '2026-11-09',
  amount: '1 234,56',
  title: '  Wpłata zaliczki ',
  counterpartyName: ' Jan Kowalski ',
  counterpartyNip: '',
  counterpartyAddressLine1: 'ul. Klienta 10',
  counterpartyAddressLine2: '02-001 Warszawa',
  relatedDocument: '',
  ...over,
});

function sesja(role = 'member') {
  return { supabase: { rpc: m.rpc }, tenantId: TENANT, user: { id: USER }, role };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  // 9.11.2026, 23:30 w Warszawie: w UTC to jeszcze ten sam dzień.
  vi.setSystemTime(new Date('2026-11-09T22:30:00Z'));
  m.auth.mockResolvedValue(sesja());
});

describe('issueCashDocumentAction', () => {
  it('KP bez faktury: firma formularza sprawdzona, RPC z kwotą jako liczbą, stroną i kluczem; widok Kasy odświeżony', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'issued', document_id: DOC, number: 'KP/3/2026', kind: 'KP', amount: 1234.56, payment_recorded: false },
      error: null,
    });

    const result = await issueCashDocumentAction(dowod(), TENANT);

    expect(result).toEqual({ success: true, status: 'issued', documentId: DOC, number: 'KP/3/2026', paymentRecorded: false, invoiceNumber: null });
    expect(m.auth).toHaveBeenCalledWith({ expectedTenantId: TENANT });
    expect(m.rpc).toHaveBeenCalledWith('issue_cash_document', {
      p_kind: 'KP',
      p_idempotency_key: KEY,
      p_operation_date: '2026-11-09',
      p_amount: 1234.56,
      p_title: 'Wpłata zaliczki',
      p_counterparty: { name: 'Jan Kowalski', nip: null, addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
      p_related_document: null,
      p_invoice_id: null,
      p_payment_id: null,
    });
    expect(m.revalidate.mock.calls.map((call) => call[0])).toContain('/kasa');
    expect(m.invalidate).not.toHaveBeenCalled();
  });

  it('KP do faktury: identyfikator faktury w RPC; zapisana wpłata odświeża faktury i pulpit', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'issued', document_id: DOC, number: 'KP/4/2026', kind: 'KP', invoice_id: INVOICE, invoice_number: 'FV/1/2026', payment_recorded: true },
      error: null,
    });

    const result = await issueCashDocumentAction(dowod({ source: 'invoice', invoiceId: INVOICE }), TENANT);

    expect(result).toMatchObject({ success: true, number: 'KP/4/2026', paymentRecorded: true, invoiceNumber: 'FV/1/2026' });
    expect(m.rpc.mock.calls[0]![1]).toMatchObject({ p_invoice_id: INVOICE, p_payment_id: null });
    expect(m.invalidate).toHaveBeenCalledWith(TENANT);
    expect(m.revalidate.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining(['/kasa', '/invoices', `/invoices/${INVOICE}`, '/payments/overdue', '/przeplywy']),
    );
  });

  it('KP do zapisanej wpłaty: identyfikator wpłaty w RPC, bez faktury', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'issued', document_id: DOC, number: 'KP/5/2026', kind: 'KP', invoice_id: INVOICE }, error: null });

    await issueCashDocumentAction(dowod({ source: 'payment', paymentId: PAYMENT }), TENANT);

    expect(m.rpc.mock.calls[0]![1]).toMatchObject({ p_invoice_id: null, p_payment_id: PAYMENT });
  });

  it('ponowienie z tym samym kluczem: sukces „już wystawiony” z tym samym dowodem; widoki i tak odświeżone', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'already_issued', document_id: DOC, number: 'KP/3/2026', kind: 'KP' }, error: null });

    const result = await issueCashDocumentAction(dowod(), TENANT);

    expect(result).toMatchObject({ success: true, status: 'already_issued', documentId: DOC, number: 'KP/3/2026' });
    expect(m.revalidate).toHaveBeenCalled();
  });

  it('za mało gotówki: odmowa ze stanem kasy, dniem i wyjściem; pole kwoty', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'refused', code: 'insufficient_cash', available: 100, available_on: '2026-11-05', amount: 150 },
      error: null,
    });

    const result = await issueCashDocumentAction(dowod({ kind: 'KW', amount: '150' }), TENANT);

    expect(result).toMatchObject({ success: false, field: 'amount' });
    expect(plain((result as { error: string }).error)).toMatch(/^W kasie na koniec dnia 05\.11\.2026 jest 100,00 zł, a wypłata to 150,00 zł\./);
    expect(m.revalidate).not.toHaveBeenCalled();
  });

  it('odmowa faktury z record_invoice_payment: tekst z 3.1 z numerem faktury i resztą', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'refused', code: 'invoice_refused', invoice_code: 'over_remaining', remaining: 930, internal_number: 'FV/1/2026' },
      error: null,
    });

    const result = await issueCashDocumentAction(dowod({ source: 'invoice', invoiceId: INVOICE }), TENANT);

    expect(plain((result as { error: string }).error)).toBe(
      'Kwota jest większa niż pozostało do zapłaty na fakturze FV/1/2026 (930,00 PLN). FaktWay nie zapisuje nadpłat: wpisz kwotę najwyżej do tej reszty.',
    );
  });

  it('firma zmieniła się od otwarcia formularza: odmowa z sesji, bez RPC', async () => {
    m.auth.mockRejectedValue(new ActionAuthError('Aktywna firma zmieniła się od otwarcia formularza.'));

    expect(await issueCashDocumentAction(dowod(), 'inna-firma')).toEqual({
      success: false,
      error: 'Aktywna firma zmieniła się od otwarcia formularza.',
    });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('księgowa: odmowa z wyjaśnieniem, bez RPC', async () => {
    m.auth.mockResolvedValue(sesja('accountant'));

    expect(await issueCashDocumentAction(dowod(), TENANT)).toEqual({
      success: false,
      error: 'Dowody kasowe wystawia właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.',
    });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ amount: '0' }, 'amount'],
    [{ operationDate: '2026-11-10' }, 'operationDate'],
    [{ title: ' ' }, 'title'],
  ])('błąd pola %o: odmowa przy polu, przed sesją i RPC', async (over, field) => {
    const result = await issueCashDocumentAction(dowod(over), TENANT);

    expect(result).toMatchObject({ success: false, field });
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('zły klucz idempotencji: ogólna odmowa przed sesją', async () => {
    expect((await issueCashDocumentAction(dowod({ idempotencyKey: 'nie-uuid' }), TENANT)).success).toBe(false);
    expect(m.auth).not.toHaveBeenCalled();
  });

  it('błąd bazy: ogólny komunikat bez treści wyjątku', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } });

    expect(await issueCashDocumentAction(dowod(), TENANT)).toEqual({
      success: false,
      error: 'Nie udało się wystawić dowodu. Sprawdź połączenie i spróbuj ponownie.',
    });
  });
});

describe('correctCashDocumentAction', () => {
  const korekta = (over: Record<string, unknown> = {}) => ({ documentId: DOC, idempotencyKey: KEY, reason: '  Zła kwota ', ...over });

  it('korekta: RPC z dowodem, przyczyną i kluczem; cofnięta wpłata odświeża faktury', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'issued', document_id: 'korekta-1', number: 'KP/7/2026', corrects_number: 'KP/3/2026', payment_voided: true, invoice_id: INVOICE, invoice_number: 'FV/1/2026' },
      error: null,
    });

    const result = await correctCashDocumentAction(korekta());

    expect(result).toEqual({
      success: true, status: 'issued', documentId: 'korekta-1', number: 'KP/7/2026', correctsNumber: 'KP/3/2026',
      paymentVoided: true, invoiceNumber: 'FV/1/2026',
    });
    expect(m.rpc).toHaveBeenCalledWith('correct_cash_document', { p_document_id: DOC, p_reason: 'Zła kwota', p_idempotency_key: KEY });
    expect(m.invalidate).toHaveBeenCalledWith(TENANT);
    expect(m.revalidate.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(['/kasa', `/kasa/${DOC}`, `/invoices/${INVOICE}`]));
  });

  it('już skorygowany: odmowa z numerami obu dowodów', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'refused', code: 'already_corrected', number: 'KP/3/2026', correction_number: 'KP/7/2026' }, error: null });

    expect(await correctCashDocumentAction(korekta())).toEqual({
      success: false,
      error: 'Dowód KP/3/2026 ma już korektę KP/7/2026. Jeśli trzeba, wystaw nowy dowód z poprawnymi danymi.',
    });
  });

  it('„Zapłacone” po wpłacie z KP: odmowa z dniem, kwotą i kolejnością kroków', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'refused', code: 'payment_refused', payment_code: 'manual_first', number: 'KP/3/2026', internal_number: 'FV/1/2026', manual_paid_on: '2026-11-06', manual_amount: 930 },
      error: null,
    });

    const result = await correctCashDocumentAction(korekta());

    expect(plain((result as { error: string }).error)).toMatch(/^Faktura FV\/1\/2026 ma oznaczenie „Zapłacone” z 06\.11\.2026 na 930,00 zł/);
  });

  it('bez przyczyny: odmowa przy polu, bez RPC', async () => {
    expect(await correctCashDocumentAction(korekta({ reason: '  ' }))).toMatchObject({ success: false, field: 'reason' });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('księgowa: odmowa, bez RPC', async () => {
    m.auth.mockResolvedValue(sesja('accountant'));

    expect((await correctCashDocumentAction(korekta())).success).toBe(false);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('ponowienie: sukces „już wystawiona”', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'already_issued', document_id: 'korekta-1', number: 'KP/7/2026', corrects_number: 'KP/3/2026' }, error: null });

    expect(await correctCashDocumentAction(korekta())).toMatchObject({ success: true, status: 'already_issued', number: 'KP/7/2026' });
  });
});

describe('openCashRegisterAction', () => {
  it('stan początkowy zero: firma formularza, RPC z datą i kwotą', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'opened', register_id: 'r-1' }, error: null });

    expect(await openCashRegisterAction({ openingDate: '2026-11-01', openingBalance: '0' }, TENANT)).toEqual({ success: true, status: 'opened' });
    expect(m.auth).toHaveBeenCalledWith({ expectedTenantId: TENANT });
    expect(m.rpc).toHaveBeenCalledWith('open_cash_register', { p_opening_date: '2026-11-01', p_opening_balance: 0 });
    expect(m.revalidate.mock.calls.map((call) => call[0])).toContain('/kasa');
  });

  it('po pierwszym dowodzie: odmowa ze stanem i drogą przez dowód', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'refused', code: 'documents_exist', opening_balance: 500, opening_date: '2026-11-01' }, error: null });

    const result = await openCashRegisterAction({ openingDate: '2026-11-02', openingBalance: '600' }, TENANT);

    expect(plain((result as { error: string }).error)).toMatch(/^Stanu początkowego nie zmienia się po wystawieniu pierwszego dowodu\. Kasa ma stan początkowy 500,00 zł na 01\.11\.2026\./);
  });

  it('data z przyszłości: odmowa przy polu, bez sesji', async () => {
    expect(await openCashRegisterAction({ openingDate: '2026-11-10', openingBalance: '0' }, TENANT)).toMatchObject({ success: false, field: 'openingDate' });
    expect(m.auth).not.toHaveBeenCalled();
  });

  it('księgowa: odmowa, bez RPC', async () => {
    m.auth.mockResolvedValue(sesja('accountant'));

    expect((await openCashRegisterAction({ openingDate: '2026-11-01', openingBalance: '0' }, TENANT)).success).toBe(false);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
