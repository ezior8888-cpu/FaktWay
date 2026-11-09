import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 6.2 planu kompletnej aplikacji, PR 1: księgowa widzi w portalu koszty
 * firmy za wybrany miesiąc (data, dostawca, numer, numer KSeF, netto, VAT,
 * brutto, kolumna KPiR, status przeglądu), strona po stronie zamiast
 * twardego limitu. Tylko firma z tokenu: każde zapytanie filtruje po
 * `tenant_id` wiersza dostępu, nigdy po czymś z adresu.
 */

type Call = { table: string; method: string; args: unknown[] };

const st = vi.hoisted(() => ({
  calls: [] as Call[],
  access: null as Record<string, unknown> | null,
  tenant: null as Record<string, unknown> | null,
  expenseCount: 0 as number | null,
  expenses: [] as unknown[],
  expensesError: null as { message: string } | null,
  invoices: [] as unknown[],
  audit: vi.fn(),
  limit: vi.fn(),
  load: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: st.audit }));
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '203.0.113.5' }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: st.limit }));
vi.mock('next/navigation', () => ({ notFound: st.notFound, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/expenses/finora/month-selector', () => ({
  default: ({ month, basePath }: { month: string; basePath: string }) => `WYBOR-MIESIACA:${month}:${basePath}`,
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const own: Call[] = [];
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'range', 'limit', 'update', 'is']) {
        chain[method] = (...args: unknown[]) => {
          const call = { table, method, args };
          own.push(call);
          st.calls.push(call);
          return chain;
        };
      }
      const result = () => {
        if (table === 'accountant_access') return { data: st.access, error: null };
        if (table === 'tenants') return { data: st.tenant, error: null };
        if (table === 'expenses') {
          if (st.expensesError) return { data: null, error: st.expensesError, count: null };
          const head = own.some((c) => c.method === 'select' && (c.args[1] as { head?: boolean } | undefined)?.head);
          return head ? { data: null, error: null, count: st.expenseCount } : { data: st.expenses, error: null, count: st.expenseCount };
        }
        if (table === 'invoices') return { data: st.invoices, error: null };
        return { data: null, error: null };
      };
      chain.maybeSingle = async () => result();
      chain.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, fail);
      return chain;
    },
  }),
}));

import { AccountantExpenseList } from '@/components/accountant/expense-list';
import { loadAccountantExpenses } from '@/lib/accountant/load-accountant-expenses';

const ACCESS = {
  id: 'acc-1', tenant_id: 'ten-1', accountant_name: 'Anna', accountant_email: 'anna@example.test',
  access_level: 'read_only', expires_at: '2099-01-01T00:00:00Z', revoked_at: null, use_count: 4,
};

const KSEF_COST = {
  id: 'e1', issue_date: '2026-10-05', seller_name: 'Hurtownia Testowa sp. z o.o.', seller_nip: '1234567890',
  document_type: 'invoice', document_number: 'FV/10/2026', net_amount: 100, vat_amount: 23, gross_amount: 123,
  kpir_column: 'col_13', is_reviewed: true, source: 'ksef_inbox', source_file_path: null, source_file_mime: null,
  ksef_invoice_id: 'inv-1',
};
const PHOTO_COST = {
  ...KSEF_COST, id: 'e2', issue_date: '2026-10-04', seller_name: 'Stacja Paliw Testowa', seller_nip: null,
  document_type: 'receipt', document_number: null, net_amount: 81.3, vat_amount: 18.7, gross_amount: 100,
  kpir_column: null, is_reviewed: false, source: 'ocr_photo',
  source_file_path: 'tenants/ten-1/expenses/2026/10/job-1.jpg', source_file_mime: 'image/jpeg', ksef_invoice_id: null,
};
const NO_FILE_COST = { ...PHOTO_COST, id: 'e3', source: 'manual', source_file_path: null, source_file_mime: null };
// Ścieżka spoza folderu firmy (np. stary wiersz z błędem) nie daje pliku, choć wiersz jest tej firmy.
const FOREIGN_PATH_COST = { ...PHOTO_COST, id: 'e4', source_file_path: 'tenants/ten-2/expenses/2026/10/job-9.jpg' };
const LINKED_INVOICE = {
  id: 'inv-1', tenant_id: 'ten-1', ksef_number: '1234567890-20261005-ABCDEF123456-01', xml_storage_path: 'ten-1/2026/10/inv-1.xml',
};

beforeEach(() => {
  st.calls = [];
  st.access = { ...ACCESS };
  st.tenant = { name: 'Moja Firma', nip: '1234567890' };
  st.expenseCount = 4;
  st.expenses = [KSEF_COST, PHOTO_COST, NO_FILE_COST, FOREIGN_PATH_COST];
  st.expensesError = null;
  st.invoices = [LINKED_INVOICE];
  st.audit.mockReset();
  st.limit.mockReset();
  st.limit.mockResolvedValue({ allowed: true, remaining: 10, retryAfter: 0 });
  st.load.mockReset();
});

const callsOf = (table: string, method: string) =>
  st.calls.filter((c) => c.table === table && c.method === method).map((c) => c.args);

describe('portal księgowej: lista kosztów (dane)', () => {
  it('miesiąc od pierwszego do ostatniego dnia, tylko firma z tokenu, numer KSeF z faktury tej firmy', async () => {
    const data = await loadAccountantExpenses('token-1', { month: '2026-10', page: 1 });

    expect(data).not.toBeNull();
    // Każde zawężenie po firmie to firma z wiersza dostępu.
    const tenantFilters = st.calls.filter((c) => c.method === 'eq' && c.args[0] === 'tenant_id').map((c) => c.args[1]);
    expect(tenantFilters.length).toBeGreaterThanOrEqual(3);
    expect(new Set(tenantFilters)).toEqual(new Set(['ten-1']));
    expect(callsOf('expenses', 'eq')).toContainEqual(['tenant_id', 'ten-1']);
    expect(callsOf('expenses', 'gte')).toContainEqual(['issue_date', '2026-10-01']);
    expect(callsOf('expenses', 'lte')).toContainEqual(['issue_date', '2026-10-31']);
    expect(callsOf('expenses', 'order')[0]).toEqual(['issue_date', { ascending: false }]);
    expect(callsOf('expenses', 'range')).toEqual([[0, 49]]);
    expect(callsOf('expenses', 'limit')).toEqual([]);
    // Faktura z KSeF czytana tylko w tej firmie i tylko dla wierszy tej strony.
    expect(callsOf('invoices', 'eq')).toContainEqual(['tenant_id', 'ten-1']);
    expect(callsOf('invoices', 'in')).toEqual([['id', ['inv-1']]]);

    expect(data!.month).toBe('2026-10');
    if (data!.expenses.status !== 'ok') throw new Error('oczekiwana lista');
    expect(data!.expenses.page).toEqual({ page: 1, pages: 1, total: 4, pageSize: 50 });
    const [ksef, photo, none, foreign] = data!.expenses.rows;
    expect(ksef).toMatchObject({ id: 'e1', ksef_number: LINKED_INVOICE.ksef_number, file_kind: 'xml', net_amount: 100, vat_amount: 23, gross_amount: 123 });
    expect(photo).toMatchObject({ id: 'e2', ksef_number: null, file_kind: 'photo' });
    expect(none).toMatchObject({ id: 'e3', file_kind: null });
    expect(foreign).toMatchObject({ id: 'e4', file_kind: null });
    // Do widoku nie trafiają ścieżki magazynu.
    expect(JSON.stringify(data!.expenses.rows)).not.toContain('tenants/');
  });

  it('druga strona: zakres 50-99; strona za końcem listy to ostatnia strona', async () => {
    st.expenseCount = 120;
    const second = await loadAccountantExpenses('token-1', { month: '2026-10', page: 2 });
    expect(callsOf('expenses', 'range')).toEqual([[50, 99]]);
    expect(second!.expenses).toMatchObject({ status: 'ok', page: { page: 2, pages: 3, total: 120, pageSize: 50 } });

    st.calls = [];
    const beyond = await loadAccountantExpenses('token-1', { month: '2026-10', page: 9 });
    expect(callsOf('expenses', 'range')).toEqual([[100, 149]]);
    expect(beyond!.expenses).toMatchObject({ status: 'ok', page: { page: 3, pages: 3, total: 120 } });
  });

  it.each([
    ['cofnięty', { revoked_at: '2026-10-01T00:00:00Z' }],
    ['wygasły', { expires_at: '2026-01-01T00:00:00Z' }],
  ])('token %s: brak danych i żadnego zapytania o koszty', async (_name, patch) => {
    st.access = { ...ACCESS, ...patch };
    expect(await loadAccountantExpenses('token-1', { month: '2026-10', page: 1 })).toBeNull();
    expect(st.calls.some((c) => c.table === 'expenses')).toBe(false);
    expect(st.audit).not.toHaveBeenCalled();
  });

  it('nieznany token: brak danych', async () => {
    st.access = null;
    expect(await loadAccountantExpenses('token-x', { month: '2026-10', page: 1 })).toBeNull();
    expect(st.calls.some((c) => c.table === 'expenses')).toBe(false);
  });

  it('błąd odczytu kosztów to stan błędu, nie pusta lista', async () => {
    st.expensesError = { message: 'boom' };
    const data = await loadAccountantExpenses('token-1', { month: '2026-10', page: 1 });
    expect(data!.expenses).toEqual({ status: 'error' });
  });

  it('wejście liczy się jak wejście do portalu: licznik i wpis w audycie bez treści dokumentów', async () => {
    await loadAccountantExpenses('token-1', { month: '2026-10', page: 1 });
    expect(callsOf('accountant_access', 'update')[0]![0]).toMatchObject({ use_count: 5 });
    expect(st.audit).toHaveBeenCalledTimes(1);
    const entry = st.audit.mock.calls[0]![0] as { action: string; tenantId: string; metadata: Record<string, unknown> };
    expect(entry).toMatchObject({ action: 'accountant.access_used', tenantId: 'ten-1', entityId: 'acc-1' });
    expect(entry.metadata).toMatchObject({ via: 'accountant_portal', view: 'expenses', month: '2026-10' });
    expect(JSON.stringify(entry)).not.toMatch(/Hurtownia|FV\/10|123|tenants\//);
  });
});

describe('portal księgowej: lista kosztów (widok)', () => {
  const rows = [
    { ...KSEF_COST, ksef_number: LINKED_INVOICE.ksef_number, file_kind: 'xml' as const },
    { ...PHOTO_COST, ksef_number: null, file_kind: 'photo' as const },
    { ...NO_FILE_COST, ksef_number: null, file_kind: null },
  ];
  const page = { page: 1, pages: 1, total: 3, pageSize: 50 };
  const render = (canDownload: boolean) =>
    renderToStaticMarkup(
      <AccountantExpenseList rows={rows} page={page} canDownload={canDownload} token="t" month="2026-10" />,
    );

  it('kolumny i wartości: data, dostawca, numer, numer KSeF, netto, VAT, brutto, KPiR, status', () => {
    const html = render(true);
    for (const text of ['Data', 'Dostawca', 'Numer', 'Numer KSeF', 'Netto', 'VAT', 'Brutto', 'Kolumna KPiR', 'Status',
      '05.10.2026', 'Hurtownia Testowa', 'NIP 1234567890', 'FV/10/2026', LINKED_INVOICE.ksef_number,
      '100,00 zł', '23,00 zł', '123,00 zł', '81,30 zł', '18,70 zł', 'Pozostałe', 'Opisany', 'Do opisania']) {
      expect(html).toContain(text);
    }
    expect(html).toMatch(/3 (<!-- -->)?pozycje/);
    expect(html).toContain('październik 2026');
  });

  it('podgląd pliku przy każdym poziomie, pobranie tylko przy dostępie z pobieraniem', () => {
    const withDownload = render(true);
    const viewOnly = render(false);
    for (const html of [withDownload, viewOnly]) {
      expect(html).toContain('href="/accountant/t/expenses/e1/view"');
      expect(html).toContain('href="/accountant/t/expenses/e2/view"');
      expect(html).not.toContain('/expenses/e3/');
    }
    expect(withDownload).toContain('href="/accountant/t/expenses/e1/download"');
    expect(withDownload).toContain('href="/accountant/t/expenses/e2/download"');
    expect(viewOnly).not.toContain('/download');
    // Tabela od `lg` i karty poniżej to ten sam zbiór: linki w każdym widoku osobno.
    const [, table = '', cards = ''] = withDownload.split(/data-view="(?:table|cards)"/);
    expect(table.match(/\/view"/g)).toHaveLength(2);
    expect(cards.match(/\/view"/g)).toHaveLength(2);
  });

  it('bez długich myślników w nowych tekstach', () => {
    expect(render(true)).not.toMatch(/[—–]/);
  });

  it('pusta lista: komunikat z miesiącem', () => {
    const html = renderToStaticMarkup(
      <AccountantExpenseList rows={[]} page={{ page: 1, pages: 1, total: 0, pageSize: 50 }} canDownload={false} token="t" month="2026-10" />,
    );
    expect(html).toContain('Brak kosztów za październik 2026');
  });
});
