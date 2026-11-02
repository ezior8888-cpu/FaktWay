import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Akcje „Zapłacone” (FaktWay 1.0 §3 pkt 3, 00158): prawdziwe akcje serwerowe,
 * atrapy tylko dla sesji i RPC. Same RPC, wyzwalacze i uprawnienia sprawdza
 * `tests/rls-zaplacone.test.ts` na prawdziwej bazie.
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
vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return { ActionAuthError, requireOrgRole: m.requireOrgRole };
});

const { markInvoicePaidAction, undoInvoicePaidAction } = await import('@/app/actions/invoice-payments');
const { ActionAuthError } = await import('@/lib/supabase/auth-context');
const { canChangeInvoicePayment, INVOICE_PAYMENT_ROLES, markPaidRefusalText } = await import('@/lib/invoices/manual-payment');

const INVOICE = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  m.requireOrgRole.mockResolvedValue({
    supabase: { rpc: m.rpc },
    tenantId: TENANT,
    user: { id: USER },
    role: 'member',
  });
});

describe('markInvoicePaidAction', () => {
  it('oznaczenie: RPC na kliencie sesji, pamięć podręczna, odświeżenie widoków, analityka; audyt zapisuje RPC', async () => {
    m.rpc.mockResolvedValue({
      data: {
        status: 'marked', amount: 1230, paid_on: '2026-11-02', payment_id: 'p1',
        reminders_cancelled: 2, internal_number: 'FV/1/2026',
      },
      error: null,
    });

    const result = await markInvoicePaidAction(INVOICE);

    expect(result).toEqual({ success: true, status: 'marked', amount: 1230, paidOn: '2026-11-02', number: 'FV/1/2026' });
    expect(m.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin', 'member']);
    expect(m.rpc).toHaveBeenCalledWith('mark_invoice_paid', { p_invoice_id: INVOICE, p_paid_on: null });
    // Wpis `invoice.marked_paid` robi sama funkcja w bazie, w transakcji z wpłatą (00158): akcja go nie dubluje.
    expect(m.logAudit).not.toHaveBeenCalled();
    expect(m.invalidate).toHaveBeenCalledWith(TENANT);
    expect(m.track).toHaveBeenCalledWith({
      userId: USER,
      tenantId: TENANT,
      event: 'invoice_marked_paid',
      properties: { source: 'manual', role: 'member' },
    });
    const paths = m.revalidate.mock.calls.map((call) => call[0]);
    expect(paths).toEqual(expect.arrayContaining([
      '/invoices', `/invoices/${INVOICE}`, '/payments/overdue', '/dashboard', '/przeplywy', '/analizy/sprzedaz',
    ]));
  });

  it('wybrana data idzie do RPC (audyt z customDate zapisuje RPC, nie akcja)', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'marked', amount: 100, paid_on: '2026-10-20' }, error: null });

    await markInvoicePaidAction(INVOICE, '2026-10-20');

    expect(m.rpc).toHaveBeenCalledWith('mark_invoice_paid', { p_invoice_id: INVOICE, p_paid_on: '2026-10-20' });
    expect(m.logAudit).not.toHaveBeenCalled();
  });

  it('„już zapłacona”: sukces bez audytu, bez zdarzenia i bez czyszczenia pamięci', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'already_paid', internal_number: 'FV/1/2026' }, error: null });

    const result = await markInvoicePaidAction(INVOICE);

    expect(result).toEqual({ success: true, status: 'already_paid', number: 'FV/1/2026' });
    expect(m.logAudit).not.toHaveBeenCalled();
    expect(m.track).not.toHaveBeenCalled();
    expect(m.invalidate).not.toHaveBeenCalled();
  });

  it.each([
    ['not_accepted', 'FV/1/2026', 'Faktura FV/1/2026 nie jest jeszcze przyjęta w KSeF. Zapłatę oznaczysz po jej przyjęciu.'],
    ['not_sales', 'FZ/9', 'Faktura FZ/9 to faktura zakupu. Zapłatę oznaczamy tylko przy fakturach sprzedaży.'],
    ['not_found', undefined, 'Nie znaleziono tej faktury w aktywnej firmie. Odśwież stronę albo przełącz firmę.'],
    ['future_date', 'FV/1/2026', 'Data zapłaty nie może być z przyszłości. Wybierz dzisiaj albo wcześniejszy dzień.'],
    ['nothing_to_pay', 'KOR/1', 'Faktura KOR/1 nie ma kwoty do zapłaty, więc nie ma czego oznaczać.'],
    ['corrected_to_zero', 'FV/2', 'Faktura FV/2 jest skorygowana do zera. Nabywca nic nie jest winien, więc nie ma czego oznaczać.'],
  ])('odmowa %s: tekst z numerem dokumentu i tym, co zrobić; bez audytu', async (code, number, text) => {
    m.rpc.mockResolvedValue({ data: { status: 'refused', code, internal_number: number }, error: null });

    expect(await markInvoicePaidAction(INVOICE)).toEqual({ success: false, error: text });
    expect(m.logAudit).not.toHaveBeenCalled();
    expect(m.invalidate).not.toHaveBeenCalled();
  });

  it('błąd bazy: ogólny komunikat bez angielskiej treści wyjątku', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '500', message: 'connection reset by peer' } });

    const result = await markInvoicePaidAction(INVOICE);

    expect(result).toEqual({
      success: false,
      error: 'Nie udało się oznaczyć zapłaty. Sprawdź połączenie i spróbuj ponownie.',
    });
    expect(m.logAudit).not.toHaveBeenCalled();
  });

  it('księgowa: odmowa z wyjaśnieniem, bez wołania RPC', async () => {
    m.requireOrgRole.mockRejectedValue(new ActionAuthError('Niewystarczające uprawnienia'));

    const result = await markInvoicePaidAction(INVOICE);

    expect(result).toEqual({
      success: false,
      error: 'Zapłatę oznacza właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.',
    });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('brak sesji: komunikat z sesji, bez wołania RPC', async () => {
    m.requireOrgRole.mockRejectedValue(new ActionAuthError('Niezalogowany'));

    expect(await markInvoicePaidAction(INVOICE)).toEqual({ success: false, error: 'Niezalogowany' });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each(['nie-uuid', ''])('zły identyfikator faktury %j: odmowa przed sesją i RPC', async (id) => {
    expect((await markInvoicePaidAction(id)).success).toBe(false);
    expect(m.requireOrgRole).not.toHaveBeenCalled();
  });

  it.each(['2026-13-01', '2026-02-30', 'wczoraj', ''])('niepoprawna data %j: odmowa przed RPC', async (day) => {
    const result = await markInvoicePaidAction(INVOICE, day);
    expect(result).toEqual({ success: false, error: 'Sprawdź datę zapłaty: ten rok wygląda na literówkę.' });
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe('undoInvoicePaidAction', () => {
  it('cofnięcie: pamięć podręczna i odświeżenie widoków; audyt zapisuje RPC', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'undone', amount: 1230, paid_on: '2026-11-02', reminders_restored: 1 }, error: null });

    expect(await undoInvoicePaidAction(INVOICE)).toEqual({ success: true, status: 'undone' });

    expect(m.rpc).toHaveBeenCalledWith('undo_invoice_paid', { p_invoice_id: INVOICE });
    // Wpis `invoice.paid_undone` robi funkcja w bazie, w transakcji z usunięciem wpłaty (00158).
    expect(m.logAudit).not.toHaveBeenCalled();
    expect(m.invalidate).toHaveBeenCalledWith(TENANT);
    expect(m.revalidate.mock.calls.map((call) => call[0])).toContain('/przeplywy');
    expect(m.track).not.toHaveBeenCalled();
  });

  it('„nie ma czego cofnąć”: sukces bez audytu', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'nothing_to_undo' }, error: null });

    expect(await undoInvoicePaidAction(INVOICE)).toEqual({ success: true, status: 'nothing_to_undo' });
    expect(m.logAudit).not.toHaveBeenCalled();
    expect(m.invalidate).not.toHaveBeenCalled();
  });

  it('obca firma: odmowa jak brak faktury', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'refused', code: 'not_found' }, error: null });

    expect(await undoInvoicePaidAction(INVOICE)).toEqual({
      success: false,
      error: 'Nie znaleziono tej faktury w aktywnej firmie. Odśwież stronę albo przełącz firmę.',
    });
  });

  it('błąd bazy: ogólny komunikat', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '500', message: 'boom' } });

    expect(await undoInvoicePaidAction(INVOICE)).toEqual({
      success: false,
      error: 'Nie udało się cofnąć zapłaty. Sprawdź połączenie i spróbuj ponownie.',
    });
  });
});

describe('role i teksty', () => {
  it('oznacza właściciel, administrator i członek firmy; księgowa ma wgląd', () => {
    expect([...INVOICE_PAYMENT_ROLES]).toEqual(['owner', 'admin', 'member']);
    expect(canChangeInvoicePayment('member')).toBe(true);
    expect(canChangeInvoicePayment('accountant')).toBe(false);
    expect(canChangeInvoicePayment(null)).toBe(false);
  });

  it('teksty dla klienta bez długich myślników', () => {
    for (const code of ['not_found', 'not_sales', 'not_accepted', 'future_date', 'invalid_date', 'nothing_to_pay', 'corrected_to_zero'] as const) {
      expect(markPaidRefusalText(code, 'FV/1')).not.toMatch(/[—–]/);
    }
  });
});
