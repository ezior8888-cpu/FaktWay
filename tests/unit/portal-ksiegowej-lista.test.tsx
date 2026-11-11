import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-063 (audyt bloku 1): portal księgowej pokazywał 100 ostatnich wierszy
 * `invoices` każdego statusu i obu kierunków — szkice i odrzucone faktury
 * przemieszane z kosztami, statusy po angielsku („accepted”, „draft”),
 * a „Pobierz XML” przy dokumentach bez pliku kończył się błędem 404.
 */

type Call = [string, unknown[]];
const st = vi.hoisted(() => ({ calls: [] as Call[], invoices: [] as unknown[], count: 0 }));

vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit', 'range', 'update']) {
        chain[m] = (...args: unknown[]) => { st.calls.push([`${table}.${m}`, args]); return chain; };
      }
      chain.maybeSingle = async () => {
        if (table === 'accountant_access') {
          return {
            data: {
              id: 'acc-1', tenant_id: 'ten-1', accountant_name: 'Anna', accountant_email: 'anna@example.test',
              access_level: 'read_download', expires_at: '2099-01-01T00:00:00Z', revoked_at: null, use_count: 0,
            },
            error: null,
          };
        }
        if (table === 'tenants') return { data: { name: 'Moja Firma', nip: '5260001246' }, error: null };
        return { data: null, error: null };
      };
      chain.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve({ data: table === 'invoices' ? st.invoices : null, error: null, count: st.count }).then(ok, fail);
      return chain;
    },
  }),
}));

import { AccountantInvoiceList } from '@/components/accountant/invoice-list';
import { ACCOUNTANT_PORTAL_STATUSES, loadAccountantPortal } from '@/lib/accountant/load-accountant-portal';

beforeEach(() => {
  st.calls = [];
  st.invoices = [];
  st.count = 0;
});

describe('portal księgowej — dane (F-063)', () => {
  it('pobiera tylko dokumenty księgowe (bez szkiców i odrzuconych), z kierunkiem i ścieżką XML', async () => {
    st.invoices = [
      { id: 'i1', internal_number: 'FV/1', issue_date: '2026-09-10', gross_total: 123, ksef_status: 'accepted', direction: 'outgoing', xml_storage_path: 'x/1.xml' },
    ];
    st.count = 1;
    const data = await loadAccountantPortal('token-1');
    // Zapytanie o liczbę i o wiersze strony: oba z tymi samymi statusami.
    const inCalls = st.calls.filter(([name]) => name === 'invoices.in');
    expect(inCalls.length).toBeGreaterThan(0);
    for (const call of inCalls) expect(call).toEqual(['invoices.in', ['ksef_status', [...ACCOUNTANT_PORTAL_STATUSES]]]);
    expect(ACCOUNTANT_PORTAL_STATUSES).not.toContain('draft');
    expect(ACCOUNTANT_PORTAL_STATUSES).not.toContain('rejected');
    const select = st.calls
      .filter(([name]) => name === 'invoices.select')
      .map(([, args]) => args[0] as string)
      .find((cols) => cols.includes('internal_number'))!;
    expect(select).toContain('direction');
    expect(select).toContain('xml_storage_path');
    expect(data?.invoices[0]).toMatchObject({ direction: 'outgoing', xml_storage_path: 'x/1.xml' });
  });

  it('strony po 50 zamiast twardego limitu 100 (krok 6.2): zakres z numeru strony, liczba wszystkich pozycji', async () => {
    st.count = 160;
    const first = await loadAccountantPortal('token-1');
    expect(st.calls.filter(([name]) => name === 'invoices.limit')).toEqual([]);
    expect(st.calls.filter(([name]) => name === 'invoices.range')).toEqual([['invoices.range', [0, 49]]]);
    expect(first?.invoicesPage).toEqual({ page: 1, pages: 4, total: 160, pageSize: 50 });

    st.calls = [];
    const third = await loadAccountantPortal('token-1', { page: 3 });
    expect(st.calls.filter(([name]) => name === 'invoices.range')).toEqual([['invoices.range', [100, 149]]]);
    expect(third?.invoicesPage).toMatchObject({ page: 3, pages: 4 });
    // Tylko firma z tokenu.
    const tenantFilters = st.calls.filter(([name, args]) => name === 'invoices.eq' && args[0] === 'tenant_id');
    expect(tenantFilters.length).toBeGreaterThan(0);
    for (const [, args] of tenantFilters) expect(args[1]).toBe('ten-1');
  });
});

describe('portal księgowej — lista (F-063)', () => {
  const rows = [
    { id: 'i1', internal_number: 'FV/1', issue_date: '2026-09-10', gross_total: 123, ksef_status: 'accepted', direction: 'outgoing', xml_storage_path: 'x/1.xml' },
    { id: 'i2', internal_number: 'ZAK/7', issue_date: '2026-09-11', gross_total: 50, ksef_status: 'accepted', direction: 'incoming', xml_storage_path: null },
    { id: 'i3', internal_number: 'FV/2', issue_date: '2026-09-12', gross_total: 10, ksef_status: 'offline_queued', direction: 'outgoing', xml_storage_path: null },
  ];
  const html = renderToStaticMarkup(<AccountantInvoiceList invoices={rows} total={rows.length} canDownload token="t" />);

  it('rodzaj dokumentu i statusy po polsku', () => {
    expect(html).toContain('Sprzedaż');
    expect(html).toContain('Koszt');
    expect(html).toContain('Przyjęta w KSeF');
    expect(html).toContain('Offline — czeka na KSeF');
    expect(html).not.toContain('>accepted<');
  });

  it('kwota faktury zakupu w walucie obcej z kodem waluty, nie „zł” (krok 6.2, jak lista faktur w aplikacji)', () => {
    const foreign = [{ ...rows[1]!, id: 'i9', gross_total: 50, currency: 'EUR' }];
    const out = renderToStaticMarkup(<AccountantInvoiceList invoices={foreign} total={1} canDownload={false} token="t" />);
    expect(out).toContain('50,00 EUR');
    expect(out).not.toContain('50,00 zł');
  });

  it('ładowarka czyta walutę faktury', async () => {
    st.count = 1;
    await loadAccountantPortal('token-1');
    const select = st.calls
      .filter(([name]) => name === 'invoices.select')
      .map(([, args]) => args[0] as string)
      .find((cols) => cols.includes('internal_number'))!;
    expect(select).toContain('currency');
  });

  it('„Pobierz XML” tylko przy dokumencie z plikiem', () => {
    // Plan Finora §7.2: tabela od `lg` i karty poniżej to ten sam zbiór
    // dokumentów — warunek liczymy w KAŻDYM z widoków osobno.
    const [, table = '', cards = ''] = html.split(/data-view="(?:table|cards)"/);
    expect(table.match(/Pobierz XML/g)).toHaveLength(1);
    expect(cards.match(/Pobierz XML/g)).toHaveLength(1);
    expect(html.match(/Pobierz XML/g)).toHaveLength(2);
    expect(html).toContain('/accountant/t/download/i1');
    expect(html).not.toContain('/download/i2');
  });
});
