import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Akcje „Zapisz wpłatę” i „Cofnij wpłatę” (plan kompletnej aplikacji, krok 3.1,
 * 00176): prawdziwe akcje serwerowe, atrapy tylko dla sesji i RPC. RPC,
 * wyzwalacze, klucz idempotencji i uprawnienia sprawdza
 * `tests/rls-wplaty-czesciowe.test.ts` na prawdziwej bazie.
 */

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  requireOrgRole: vi.fn(),
  logAudit: vi.fn(),
  invalidate: vi.fn(),
  track: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: m.logAudit }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: m.invalidate }));
vi.mock('@/lib/analytics/server', () => ({ trackServer: m.track }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: vi.fn(async () => ({ ids: [] })) }));
vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return { ActionAuthError, requireOrgRole: m.requireOrgRole };
});

const { recordInvoicePaymentAction, voidInvoicePaymentAction } = await import('@/app/actions/invoice-payments');
const { ActionAuthError } = await import('@/lib/supabase/auth-context');

const INVOICE = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const KEY = '44444444-4444-4444-8444-444444444444';
const PAYMENT = '55555555-5555-4555-8555-555555555555';
const NBSP = /[  ]/g;
const plain = (text: string) => text.replace(NBSP, ' ');

const input = (over: Record<string, unknown> = {}) => ({
  invoiceId: INVOICE,
  idempotencyKey: KEY,
  amount: '300,00',
  paidOn: '2026-11-02',
  note: '  przelew z mBanku ',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  // 9.11.2026, 23:30 w Warszawie: w UTC to jeszcze ten sam dzień.
  vi.setSystemTime(new Date('2026-11-09T22:30:00Z'));
  m.requireOrgRole.mockResolvedValue({
    supabase: { rpc: m.rpc },
    tenantId: TENANT,
    user: { id: USER },
    role: 'member',
  });
});

describe('recordInvoicePaymentAction', () => {
  it('zapis: RPC na kliencie sesji z kwotą w groszach, dniem, kluczem, notatką i PLN; widoki odświeżone; audyt robi RPC', async () => {
    m.rpc.mockResolvedValue({
      data: {
        status: 'recorded', payment_id: PAYMENT, amount: 300, paid_on: '2026-11-02', remaining: 930,
        payment_status: 'partial', reminders_cancelled: 0, internal_number: 'FV/1/2026',
      },
      error: null,
    });

    const result = await recordInvoicePaymentAction(input());

    expect(result).toEqual({
      success: true, status: 'recorded', paymentId: PAYMENT, amount: 300, paidOn: '2026-11-02',
      remaining: 930, paidInFull: false, number: 'FV/1/2026',
    });
    expect(m.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin', 'member']);
    expect(m.rpc).toHaveBeenCalledWith('record_invoice_payment', {
      p_invoice_id: INVOICE,
      p_amount: 300,
      p_paid_on: '2026-11-02',
      p_idempotency_key: KEY,
      p_note: 'przelew z mBanku',
      p_currency: 'PLN',
    });
    // Wpis `invoice.payment_recorded` robi funkcja w bazie, w transakcji z wpłatą (00176).
    expect(m.logAudit).not.toHaveBeenCalled();
    expect(m.invalidate).toHaveBeenCalledWith(TENANT);
    expect(m.revalidate.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([
      '/invoices', `/invoices/${INVOICE}`, '/payments/overdue', '/dashboard', '/przeplywy', '/analizy/sprzedaz',
    ]));
    // Wpłata częściowa nie jest „oznaczeniem zapłaty”: bez zdarzenia analityki.
    expect(m.track).not.toHaveBeenCalled();
  });

  it('wpłata, która zamyka fakturę: analityka jak przy „Zapłacone”, ze źródłem wpłaty', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'recorded', payment_id: PAYMENT, amount: 930, paid_on: '2026-11-02', remaining: 0, payment_status: 'paid', internal_number: 'FV/1/2026' },
      error: null,
    });

    const result = await recordInvoicePaymentAction(input({ amount: '930' }));

    expect(result).toMatchObject({ success: true, paidInFull: true, remaining: 0 });
    expect(m.track).toHaveBeenCalledWith({
      userId: USER, tenantId: TENANT, event: 'invoice_marked_paid', properties: { source: 'payment_entry', role: 'member' },
    });
  });

  it('pusta notatka idzie jako null, kwota „1 234,56” jako liczba', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'recorded', payment_id: PAYMENT, amount: 1234.56, paid_on: '2026-11-02', remaining: 0, payment_status: 'paid' }, error: null });

    await recordInvoicePaymentAction(input({ amount: '1 234,56', note: '   ' }));

    expect(m.rpc).toHaveBeenCalledWith('record_invoice_payment', expect.objectContaining({ p_amount: 1234.56, p_note: null }));
  });

  it('ponowienie z tym samym kluczem: sukces „już zapisana”, bez drugiej wpłaty; widoki i tak odświeżone (pierwsza próba mogła paść po zapisie)', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'already_recorded', payment_id: PAYMENT, amount: 300, paid_on: '2026-11-02', remaining: 930, payment_status: 'partial', voided: false, internal_number: 'FV/1/2026' },
      error: null,
    });

    const result = await recordInvoicePaymentAction(input());

    expect(result).toEqual({
      success: true, status: 'already_recorded', paymentId: PAYMENT, amount: 300, paidOn: '2026-11-02',
      remaining: 930, paidInFull: false, number: 'FV/1/2026',
    });
    expect(m.invalidate).toHaveBeenCalledWith(TENANT);
    expect(m.track).not.toHaveBeenCalled();
  });

  it.each([
    ['not_accepted', { internal_number: 'FV/1/2026' }, 'Faktura FV/1/2026 nie jest jeszcze przyjęta w KSeF. Wpłatę zapiszesz po jej przyjęciu.'],
    ['not_sales', { internal_number: 'FZ/9' }, 'Faktura FZ/9 to faktura zakupu. Wpłaty zapisujemy tylko przy fakturach sprzedaży.'],
    ['not_found', {}, 'Nie znaleziono tej faktury w aktywnej firmie. Odśwież stronę albo przełącz firmę.'],
    ['already_paid', { internal_number: 'FV/1/2026' }, 'Faktura FV/1/2026 jest już zapłacona w całości, więc nie ma na co zapisać wpłaty. Jeśli któraś wpłata to pomyłka, cofnij ją w historii wpłat.'],
    ['corrected_to_zero', { internal_number: 'FV/2' }, 'Faktura FV/2 jest skorygowana do zera. Nabywca nic nie jest winien, więc nie ma na co zapisać wpłaty.'],
    ['over_remaining', { internal_number: 'FV/1/2026', remaining: 930 }, 'Kwota jest większa niż pozostało do zapłaty na fakturze FV/1/2026 (930,00 PLN). FaktWay nie zapisuje nadpłat: wpisz kwotę najwyżej do tej reszty.'],
    ['key_reused', {}, 'Ta wpłata była już zapisana z innymi danymi. Odśwież stronę i zapisz ją jeszcze raz.'],
    ['invoice_currency', { internal_number: 'FV/3', currency: 'EUR' }, 'Faktura FV/3 jest w walucie EUR. Wpłaty zapisujemy na razie tylko do faktur w złotych (PLN). Wpłatę tej faktury trzeba na razie odnotować poza FaktWay.'],
  ])('odmowa %s: tekst z numerem dokumentu i tym, co zrobić; bez odświeżania', async (code, extra, text) => {
    m.rpc.mockResolvedValue({ data: { status: 'refused', code, ...extra }, error: null });

    const result = await recordInvoicePaymentAction(input());

    expect(result.success).toBe(false);
    expect(plain((result as { error: string }).error)).toBe(text);
    expect(m.invalidate).not.toHaveBeenCalled();
  });

  it('odmowa kwoty z bazy wskazuje pole „Kwota”', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'refused', code: 'over_remaining', remaining: 10, internal_number: 'FV/1' }, error: null });
    expect(await recordInvoicePaymentAction(input())).toMatchObject({ success: false, field: 'amount' });
    m.rpc.mockResolvedValue({ data: { status: 'refused', code: 'future_date' }, error: null });
    expect(await recordInvoicePaymentAction(input())).toMatchObject({ success: false, field: 'paidOn' });
  });

  it('waluta inna niż PLN: odmowa przed sesją i RPC', async () => {
    const result = await recordInvoicePaymentAction(input({ currency: 'EUR' }));

    expect(result).toEqual({ success: false, error: 'Wpłaty zapisujemy na razie tylko w złotych (PLN). Wpisz kwotę w złotych.', field: 'amount' });
    expect(m.requireOrgRole).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['kwota zero', { amount: '0' }, 'amount'],
    ['kwota ujemna', { amount: '-1' }, 'amount'],
    ['trzy miejsca po przecinku', { amount: '1,234' }, 'amount'],
    ['jutro w Warszawie', { paidOn: '2026-11-10' }, 'paidOn'],
    ['data nieistniejąca', { paidOn: '2026-02-30' }, 'paidOn'],
    ['notatka za długa', { note: 'x'.repeat(501) }, 'note'],
  ])('%s: odmowa z polem przed RPC', async (_label, over, field) => {
    const result = await recordInvoicePaymentAction(input(over));

    expect(result).toMatchObject({ success: false, field });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['zły identyfikator faktury', { invoiceId: 'nie-uuid' }],
    ['brak klucza idempotencji', { idempotencyKey: '' }],
    ['klucz nie jest UUID', { idempotencyKey: 'abc' }],
  ])('%s: ogólna odmowa przed sesją i RPC', async (_label, over) => {
    const result = await recordInvoicePaymentAction(input(over));

    expect(result).toEqual({ success: false, error: 'Nie udało się zapisać wpłaty. Sprawdź połączenie i spróbuj ponownie.' });
    expect(m.requireOrgRole).not.toHaveBeenCalled();
  });

  it('księgowa: odmowa z wyjaśnieniem, bez wołania RPC', async () => {
    m.requireOrgRole.mockRejectedValue(new ActionAuthError('Niewystarczające uprawnienia'));

    expect(await recordInvoicePaymentAction(input())).toEqual({
      success: false,
      error: 'Wpłaty zapisuje właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.',
    });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('błąd bazy: ogólny komunikat bez angielskiej treści wyjątku', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '500', message: 'connection reset by peer' } });

    expect(await recordInvoicePaymentAction(input())).toEqual({
      success: false,
      error: 'Nie udało się zapisać wpłaty. Sprawdź połączenie i spróbuj ponownie.',
    });
    expect(m.invalidate).not.toHaveBeenCalled();
  });
});

describe('voidInvoicePaymentAction', () => {
  it('cofnięcie: RPC z identyfikatorem wpłaty, odświeżenie widoków; audyt robi RPC', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'voided', mode: 'voided', payment_id: PAYMENT, invoice_id: INVOICE, amount: 300, paid_on: '2026-11-02', remaining: 1230, payment_status: 'overdue', reminders_restored: 0, internal_number: 'FV/1/2026' },
      error: null,
    });

    expect(await voidInvoicePaymentAction(PAYMENT)).toEqual({ success: true, status: 'voided', amount: 300, number: 'FV/1/2026' });

    expect(m.rpc).toHaveBeenCalledWith('void_invoice_payment', { p_payment_id: PAYMENT });
    expect(m.logAudit).not.toHaveBeenCalled();
    expect(m.invalidate).toHaveBeenCalledWith(TENANT);
    expect(m.revalidate.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining(['/invoices', `/invoices/${INVOICE}`, '/przeplywy']));
  });

  it('drugie cofnięcie: sukces „już cofnięta”', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'already_voided', payment_id: PAYMENT, invoice_id: INVOICE, internal_number: 'FV/1/2026' }, error: null });

    expect(await voidInvoicePaymentAction(PAYMENT)).toEqual({ success: true, status: 'already_voided', amount: null, number: 'FV/1/2026' });
  });

  it.each([
    ['not_found', {}, 'Nie znaleziono tej wpłaty w aktywnej firmie. Odśwież stronę albo przełącz firmę.'],
    ['manual_first', { internal_number: 'FV/1/2026', manual_paid_on: '2026-11-05', manual_amount: 930 }, 'Faktura FV/1/2026 ma oznaczenie „Zapłacone” z 05.11.2026 na 930,00 PLN, policzone jako reszta po tej wpłacie. Najpierw cofnij to oznaczenie, potem tę wpłatę.'],
  ])('odmowa %s: tekst z wyjściem, bez odświeżania', async (code, extra, text) => {
    m.rpc.mockResolvedValue({ data: { status: 'refused', code, ...extra }, error: null });

    const result = await voidInvoicePaymentAction(PAYMENT);

    expect(result.success).toBe(false);
    expect(plain((result as { error: string }).error)).toBe(text);
    expect(m.invalidate).not.toHaveBeenCalled();
  });

  it('wpłata z importu: odmowa z drogą przez Pomoc', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'refused', code: 'not_voidable' }, error: null });

    expect(await voidInvoicePaymentAction(PAYMENT)).toMatchObject({ success: false, error: expect.stringMatching(/Pomoc/) });
  });

  it('zły identyfikator wpłaty: odmowa przed sesją', async () => {
    expect((await voidInvoicePaymentAction('nie-uuid')).success).toBe(false);
    expect(m.requireOrgRole).not.toHaveBeenCalled();
  });

  it('księgowa: odmowa z wyjaśnieniem, bez wołania RPC', async () => {
    m.requireOrgRole.mockRejectedValue(new ActionAuthError('Niewystarczające uprawnienia'));

    expect(await voidInvoicePaymentAction(PAYMENT)).toEqual({
      success: false,
      error: 'Wpłaty cofa właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.',
    });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('błąd bazy: ogólny komunikat', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '500', message: 'boom' } });

    expect(await voidInvoicePaymentAction(PAYMENT)).toEqual({
      success: false,
      error: 'Nie udało się cofnąć wpłaty. Sprawdź połączenie i spróbuj ponownie.',
    });
  });
});
