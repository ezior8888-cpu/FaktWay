import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 6.2, PR 1: zakładka „Koszty” portalu księgowej (`/accountant/<token>/expenses`)
 * i strony list. Miesiąc i strona z adresu, firma tylko z tokenu (ładowarka),
 * linki portalu bez wstępnego pobierania (zwykłe `<a>`): wejście do portalu
 * zapisuje wpis w audycie i liczy się do limitu prób.
 */

const st = vi.hoisted(() => ({
  loadExpenses: vi.fn(),
  loadPortal: vi.fn(),
  limit: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({ notFound: st.notFound, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/accountant/load-accountant-expenses', () => ({ loadAccountantExpenses: st.loadExpenses }));
vi.mock('@/lib/accountant/load-accountant-portal', () => ({ loadAccountantPortal: st.loadPortal }));
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '203.0.113.5' }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: st.limit }));
vi.mock('@/components/exports/accountant-export-buttons', () => ({ AccountantExportButtons: () => 'PRZYCISKI-EKSPORTU' }));
vi.mock('@/components/expenses/finora/month-selector', () => ({
  default: ({ month, basePath }: { month: string; basePath: string }) => `WYBOR-MIESIACA:${month}:${basePath}`,
}));

import AccountantExpensesPage from '@/app/accountant/[token]/expenses/page';
import AccountantPortalPage from '@/app/accountant/[token]/page';

const ACCESS = {
  id: 'a', tenant_id: 'ten-1', accountant_name: 'Anna', accountant_email: 'a@example.test',
  access_level: 'download', expires_at: '2099-01-01T00:00:00Z',
};
const TENANT = { name: 'Moja Firma', nip: '1234567890' };
const ROW = {
  id: 'e1', issue_date: '2026-10-05', seller_name: 'Hurtownia Testowa', seller_nip: '1234567890',
  document_type: 'invoice', document_number: 'FV/10/2026', net_amount: 100, vat_amount: 23, gross_amount: 123,
  kpir_column: 'col_13', is_reviewed: true, ksef_number: '1234567890-20261005-ABCDEF123456-01', file_kind: 'xml',
};

function expensesData(page = { page: 2, pages: 3, total: 120, pageSize: 50 }) {
  return { access: ACCESS, tenant: TENANT, month: '2026-10', expenses: { status: 'ok', rows: [ROW], page } };
}

const render = async (searchParams: Record<string, string> = {}, token = 'tok%20en') =>
  renderToStaticMarkup(
    await AccountantExpensesPage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(searchParams) }),
  );

beforeEach(() => {
  st.loadExpenses.mockReset();
  st.loadPortal.mockReset();
  st.limit.mockReset();
  st.limit.mockResolvedValue({ allowed: true, remaining: 10, retryAfter: 0 });
});

describe('portal księgowej: strona kosztów', () => {
  it('miesiąc i strona z adresu, token zdekodowany', async () => {
    st.loadExpenses.mockResolvedValue(expensesData());
    await render({ miesiac: '2026-10', strona: '2' });
    expect(st.loadExpenses).toHaveBeenCalledWith('tok en', { month: '2026-10', page: 2 });
  });

  it('zły miesiąc albo strona z adresu: bieżący miesiąc i pierwsza strona', async () => {
    st.loadExpenses.mockResolvedValue(expensesData());
    await render({ miesiac: '2026-13', strona: '-4' });
    const [, options] = st.loadExpenses.mock.calls[0]!;
    expect(options.page).toBe(1);
    expect(options.month).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    expect(options.month).not.toBe('2026-13');
  });

  it('nagłówek firmy, zakładki, wybór miesiąca i strony jako zwykłe linki', async () => {
    st.loadExpenses.mockResolvedValue(expensesData());
    const html = await render({ miesiac: '2026-10', strona: '2' }, 'tok');
    for (const text of ['Moja Firma', 'NIP: 1234567890', 'Z pobieraniem', 'Anna', 'Hurtownia Testowa', 'Strona 2 z 3']) {
      expect(html).toContain(text);
    }
    expect(html).toContain('WYBOR-MIESIACA:2026-10:/accountant/tok/expenses');
    expect(html).toContain('href="/accountant/tok"');
    expect(html).toMatch(/href="\/accountant\/tok\/expenses"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/accountant\/tok\/expenses"/);
    expect(html).toContain('href="/accountant/tok/expenses?miesiac=2026-10&amp;strona=1"');
    expect(html).toContain('href="/accountant/tok/expenses?miesiac=2026-10&amp;strona=3"');
    expect(html).not.toMatch(/[—–]/);
  });

  it('nieważny token: notFound', async () => {
    st.loadExpenses.mockResolvedValue(null);
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('błąd odczytu: komunikat zamiast pustej listy', async () => {
    st.loadExpenses.mockResolvedValue({ ...expensesData(), expenses: { status: 'error' } });
    const html = await render();
    expect(html).toContain('Nie udało się wczytać kosztów');
    expect(html).not.toContain('Brak kosztów');
  });
});

describe('portal księgowej: strona dokumentów ze stronami', () => {
  const invoice = { id: 'i1', internal_number: 'FV/1', issue_date: '2026-09-10', gross_total: 1230, ksef_status: 'accepted', direction: 'outgoing', xml_storage_path: 'x/1.xml' };

  it('strona z adresu do ładowarki, liczba wszystkich pozycji i linki stron', async () => {
    st.loadPortal.mockResolvedValue({
      access: ACCESS, tenant: TENANT, invoices: [invoice],
      invoicesPage: { page: 2, pages: 4, total: 160, pageSize: 50 }, invoicesError: false,
    });
    const html = renderToStaticMarkup(
      await AccountantPortalPage({ params: Promise.resolve({ token: 'tok' }), searchParams: Promise.resolve({ strona: '2' }) }),
    );
    expect(st.loadPortal).toHaveBeenCalledWith('tok', { page: 2 });
    expect(html).toMatch(/160 (<!-- -->)?pozycji/);
    expect(html).toContain('Strona 2 z 4');
    expect(html).toContain('href="/accountant/tok?strona=1"');
    expect(html).toContain('href="/accountant/tok?strona=3"');
    expect(html).toContain('href="/accountant/tok/expenses"');
    // „Pobierz XML” faktury dalej jest, a lista nie ma już twardego limitu w tekście.
    expect(html).toContain('href="/accountant/tok/download/i1"');
  });
});
