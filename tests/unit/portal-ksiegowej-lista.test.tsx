import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-063 (audyt bloku 1): portal księgowej pokazywał 100 ostatnich wierszy
 * `invoices` każdego statusu i obu kierunków — szkice i odrzucone faktury
 * przemieszane z kosztami, statusy po angielsku („accepted”, „draft”),
 * a „Pobierz XML” przy dokumentach bez pliku kończył się błędem 404.
 */

type Call = [string, unknown[]];
const st = vi.hoisted(() => ({ calls: [] as Call[], invoices: [] as unknown[] }));

vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update']) {
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
        Promise.resolve({ data: table === 'invoices' ? st.invoices : null, error: null }).then(ok, fail);
      return chain;
    },
  }),
}));

import { AccountantInvoiceList } from '@/components/accountant/invoice-list';
import { ACCOUNTANT_PORTAL_STATUSES, loadAccountantPortal } from '@/lib/accountant/load-accountant-portal';

beforeEach(() => {
  st.calls = [];
  st.invoices = [];
});

describe('portal księgowej — dane (F-063)', () => {
  it('pobiera tylko dokumenty księgowe (bez szkiców i odrzuconych), z kierunkiem i ścieżką XML', async () => {
    st.invoices = [
      { id: 'i1', internal_number: 'FV/1', issue_date: '2026-09-10', gross_total: 123, ksef_status: 'accepted', direction: 'outgoing', xml_storage_path: 'x/1.xml' },
    ];
    const data = await loadAccountantPortal('token-1');
    const inCall = st.calls.find(([name]) => name === 'invoices.in');
    expect(inCall).toEqual(['invoices.in', ['ksef_status', [...ACCOUNTANT_PORTAL_STATUSES]]]);
    expect(ACCOUNTANT_PORTAL_STATUSES).not.toContain('draft');
    expect(ACCOUNTANT_PORTAL_STATUSES).not.toContain('rejected');
    const select = st.calls.find(([name]) => name === 'invoices.select')![1][0] as string;
    expect(select).toContain('direction');
    expect(select).toContain('xml_storage_path');
    expect(data?.invoices[0]).toMatchObject({ direction: 'outgoing', xml_storage_path: 'x/1.xml' });
  });
});

describe('portal księgowej — lista (F-063)', () => {
  const rows = [
    { id: 'i1', internal_number: 'FV/1', issue_date: '2026-09-10', gross_total: 123, ksef_status: 'accepted', direction: 'outgoing', xml_storage_path: 'x/1.xml' },
    { id: 'i2', internal_number: 'ZAK/7', issue_date: '2026-09-11', gross_total: 50, ksef_status: 'accepted', direction: 'incoming', xml_storage_path: null },
    { id: 'i3', internal_number: 'FV/2', issue_date: '2026-09-12', gross_total: 10, ksef_status: 'offline_queued', direction: 'outgoing', xml_storage_path: null },
  ];
  const html = renderToStaticMarkup(<AccountantInvoiceList invoices={rows} canDownload token="t" />);

  it('rodzaj dokumentu i statusy po polsku', () => {
    expect(html).toContain('Sprzedaż');
    expect(html).toContain('Koszt');
    expect(html).toContain('Przyjęta w KSeF');
    expect(html).toContain('Offline — czeka na KSeF');
    expect(html).not.toContain('>accepted<');
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
