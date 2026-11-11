import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 2.10, decyzja D1: „Link dla nabywcy” w istniejącej karcie „Dokument”
 * faktury, na końcu listy akcji (istniejące przyciski zostają na miejscach).
 * Przycisk widać tylko wtedy, gdy akcja tworzenia go przyjmie: strona liczy to
 * tymi samymi predykatami (`canManageBuyerLinks`, `buyerLinkRefusal`), a brak
 * kodu QR (brak skrótu pliku XML) chowa przycisk, bo PDF bez KODU I nie idzie
 * do nabywcy. Prawdziwe: strona i karta akcji; zastąpione: baza (w pamięci),
 * widok kliencki strony i przyciski bez związku z linkiem.
 */

const st = vi.hoisted(() => ({
  db: null as null | import('./helpers/ponowienie-specjalne-baza').MemoryDb,
  user: 'fixture-user',
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => st.db!.from(table),
    auth: { getUser: async () => ({ data: { user: { id: st.user } }, error: null }) },
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/components/invoices/invoice-detail-view', () => ({ InvoiceDetailView: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/invoices/actions-detail', () => ({ downloadInvoiceXmlAction: vi.fn() }));
vi.mock('@/components/invoices/email-invoice-button', () => ({ EmailInvoiceButton: () => null }));
vi.mock('@/components/invoices/failed-invoice-actions', () => ({ FailedInvoiceActions: () => null }));
vi.mock('@/components/invoices/draft-invoice-actions', () => ({ DraftInvoiceActions: () => null }));
vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));

const { default: InvoiceDetailPage } = await import('@/app/(dashboard)/invoices/[id]/page');
const { InvoiceActions } = await import('@/components/invoices/invoice-actions');
const { memoryDb } = await import('./helpers/ponowienie-specjalne-baza');
type InvoiceDetailInitial = import('@/components/invoices/invoice-detail-view').InvoiceDetailInitial;
type Row = import('./helpers/ponowienie-specjalne-baza').Row;

const TENANT = '11111111-1111-4111-8111-111111111111';
const ID = '33333333-3333-4333-8333-333333333391';
const XML_PATH = `${TENANT}/2026/10/${ID}.xml`;
const seller = { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1' } };

function accepted(patch: Row = {}): Row {
  return {
    id: ID,
    tenant_id: TENANT,
    direction: 'outgoing',
    origin: 'app',
    internal_number: 'FV/9/10/2026',
    invoice_type: 'VAT',
    invoice_kind: 'regular',
    issue_date: '2026-10-02',
    sale_date: '2026-10-02',
    ksef_status: 'accepted',
    ksef_number: '1234567890-20261002-0100A0B0C0D0-1A',
    ksef_accepted_at: '2026-10-02T09:00:00Z',
    ksef_environment: 'test',
    xml_storage_path: XML_PATH,
    net_total: 100,
    vat_total: 23,
    gross_total: 123,
    paid_amount: 0,
    payment_status: 'unpaid',
    last_error: null,
    last_error_code: null,
    seller_data: seller,
    buyer_data: { name: 'Nabywca' },
    payment_data: null,
    fa3_data: {},
    special_data: null,
    invoice_line_items: [],
    ...patch,
  };
}

function seed(row: Row, { role = 'owner', xml = true }: { role?: string; xml?: boolean } = {}) {
  st.db = memoryDb({
    invoices: [row],
    memberships: [{ user_id: st.user, organization_id: TENANT, status: 'active', role }],
    upo_receipts: [],
    ksef_submissions: [],
    xml_documents: xml ? [{ storage_path: XML_PATH, tenant_id: TENANT, invoice_id: ID, sha256_hash: 'ab'.repeat(32) }] : [],
  });
}

async function canShare(): Promise<boolean | undefined> {
  const el = (await InvoiceDetailPage({ params: Promise.resolve({ id: ID }) })) as ReactElement<{ initial: InvoiceDetailInitial }>;
  return el.props.initial.can_share_with_buyer;
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
});
afterEach(() => vi.unstubAllEnvs());

describe('strona faktury liczy „Link dla nabywcy” tymi samymi warunkami co akcja', () => {
  it('przyjęta faktura sprzedaży z FaktWay z plikiem XML: właściciel i członek zespołu widzą przycisk', async () => {
    seed(accepted());
    expect(await canShare()).toBe(true);
    seed(accepted(), { role: 'member' });
    expect(await canShare()).toBe(true);
  });

  it('zaliczkowa też', async () => {
    seed(accepted({ invoice_type: 'ZAL', invoice_kind: 'advance' }));
    expect(await canShare()).toBe(true);
  });

  it.each([
    ['księgowa', accepted(), { role: 'accountant' }],
    ['bez skrótu pliku XML (bez kodu QR)', accepted(), { xml: false }],
    ['szkic', accepted({ ksef_status: 'draft', ksef_number: null }), {}],
    ['korekta', accepted({ invoice_type: 'KOR', invoice_kind: 'correction' }), {}],
    ['import z KSeF', accepted({ origin: 'ksef_import' }), {}],
    ['inne środowisko KSeF', accepted({ ksef_environment: 'production' }), {}],
  ] as const)('%s: bez przycisku', async (_name, row, options) => {
    seed(row, options);
    expect(await canShare()).toBe(false);
  });
});

describe('karta „Dokument”: przycisk na końcu listy akcji', () => {
  const render = (canShareWithBuyer: boolean | undefined) =>
    renderToStaticMarkup(
      <InvoiceActions
        section="secondary"
        invoice={{
          id: ID,
          ksef_status: 'accepted',
          xml_storage_path: XML_PATH,
          invoice_type: 'VAT',
          invoice_kind: 'regular',
          ksef_resend_facts: { sendData: 'stored', kindHeld: false, issueDatePassed: false },
          ksef_environment_known: true,
          can_duplicate: true,
          can_set_recurring: true,
          can_share_with_buyer: canShareWithBuyer,
        }}
      />,
    );

  it('z flagą: „Link dla nabywcy” po wszystkich dotychczasowych akcjach', () => {
    const html = render(true);
    const order = ['Pobierz PDF', 'Drukuj', 'Pobierz XML', 'Duplikuj', 'Ustaw jako cykliczną', 'Link dla nabywcy'].map((label) => html.indexOf(label));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('bez flagi albo z false: przycisku nie ma, reszta bez zmian', () => {
    for (const flag of [false, undefined]) {
      const html = render(flag);
      expect(html).not.toContain('Link dla nabywcy');
      expect(html).toContain('Ustaw jako cykliczną');
    }
  });
});
