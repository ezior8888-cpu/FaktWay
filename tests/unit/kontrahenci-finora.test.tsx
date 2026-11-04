import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ value: 'production' as string }));
const ctx = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: ctx.get }));
vi.mock('@/lib/ksef/claim-environment', () => ({ requireConfiguredKsefEnvironment: () => env.value }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/app/actions/reminders', () => ({ toggleContractorRemindersAction: vi.fn() }));
vi.mock('@/app/actions/validation', () => ({ bulkValidateContractorsAction: vi.fn() }));
vi.mock('@/app/actions/contractors', () => ({ deleteContractorAction: vi.fn(), updateContractorAction: vi.fn() }));

import {
  ActiveContractorsTile,
  ContractorsCountTile,
  OverdueContractorsTile,
  VatToCheckTile,
} from '@/app/(dashboard)/contractors/_components/contractor-stat-tiles';
import { ContractorsTable, type ContractorTableRow } from '@/app/(dashboard)/contractors/_components/contractors-table';
import ContractorsPage from '@/app/(dashboard)/contractors/page';
import {
  countActiveContractors,
  countContractorsWithOverdue,
  needsVatCheck,
  normalizeNip,
  receivablesByNip,
} from '@/lib/contractors/overview';
import type { ReceivableInvoice } from '@/lib/dashboard/receivables';
import type { PageContext } from '@/lib/supabase/page-context';

/**
 * P13 (PLAN-FINORA §5): kafle Kontrahenci / Aktywni (90 dni) / Z zaległościami
 * / Status VAT do sprawdzenia i kolumny Należności / Po terminie. Należności
 * to wyłącznie `getReceivables` (§2.4 pkt 11) po NIP; „Aktywni” — faktury
 * przyjęte w aktywnym środowisku (§2.4 pkt 2), nie `last_used_at`.
 */

type Row = Record<string, unknown>;
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-10-20T10:00:00Z'); // 20.10.2026 w Warszawie

function receivable(overrides: Partial<ReceivableInvoice>): ReceivableInvoice {
  return { id: 'x', internalNumber: 'FV/1', buyerName: 'B', buyerNip: '1234567890', paymentDueDate: null, outstanding: 100, daysOverdue: 0, ...overrides };
}

describe('normalizeNip i rozkład należności po NIP', () => {
  it('NIP bez spacji i myślników, wielkie litery; pusty → null', () => {
    expect(normalizeNip('123-456-78-90')).toBe('1234567890');
    expect(normalizeNip(' de 123 456 789 ')).toBe('DE123456789');
    expect(normalizeNip('')).toBeNull();
    expect(normalizeNip(null)).toBeNull();
  });

  it('suma należności i liczba po terminie per NIP; nabywca bez NIP pominięty', () => {
    const byNip = receivablesByNip({ byInvoice: [
      receivable({ id: 'a', buyerNip: '1234567890', outstanding: 100.1, daysOverdue: 5 }),
      receivable({ id: 'b', buyerNip: '123-456-78-90', outstanding: 200.2, daysOverdue: 0 }),
      receivable({ id: 'c', buyerNip: '5260001246', outstanding: 50, daysOverdue: 1 }),
      receivable({ id: 'd', buyerNip: null, outstanding: 999, daysOverdue: 30 }),
    ] });
    expect(byNip.get('1234567890')).toEqual({ outstanding: 300.3, overdueCount: 1 });
    expect(byNip.get('5260001246')).toEqual({ outstanding: 50, overdueCount: 1 });
    expect(byNip.size).toBe(2);
  });

  it('„Z zaległościami” liczy kontrahentów z kartoteki (każdy NIP raz)', () => {
    const contractors = [
      { id: '1', nip: '1234567890' }, { id: '2', nip: '1234567890' },
      { id: '3', nip: '5260001246' }, { id: '4', nip: '7777777777' }, { id: '5', nip: null },
    ];
    expect(countContractorsWithOverdue(contractors, { byInvoice: [
      receivable({ buyerNip: '1234567890', daysOverdue: 3 }),
      receivable({ buyerNip: '5260001246', daysOverdue: 0 }),
      receivable({ buyerNip: '9999999999', daysOverdue: 9 }), // spoza kartoteki
      receivable({ buyerNip: null, daysOverdue: 9 }),
    ] })).toBe(1);
  });

  it.each([
    ['active', null, false], ['active', 'Rachunek spoza białej listy', true], ['exempt', null, false],
    ['inactive', null, true], ['unknown', null, true], [null, null, true],
  ])('status VAT %s (ostrzeżenie: %s) → do sprawdzenia: %s', (vat_status, validation_warning, expected) => {
    expect(needsVatCheck({ vat_status, validation_warning })).toBe(expected);
  });
});

/** Baza w pamięci z filtrami używanymi przez moduł, licznikiem `exact` i stronami. */
function database(tables: Record<string, Row[]>, failOnTable?: string) {
  return {
    from(table: string) {
      const predicates: Array<(row: Row) => boolean> = [];
      let head = false;
      let range: [number, number] | null = null;
      const builder = {
        select: (_cols: string, opts?: { head?: boolean }) => { head = opts?.head === true; return builder; },
        eq: (c: string, v: unknown) => { predicates.push((r) => r[c] === v); return builder; },
        is: (c: string, v: null) => { predicates.push((r) => (r[c] ?? null) === v); return builder; },
        gte: (c: string, v: string) => { predicates.push((r) => String(r[c]) >= v); return builder; },
        lt: (c: string, v: string) => { predicates.push((r) => String(r[c]) < v); return builder; },
        gt: (c: string, v: number) => { predicates.push((r) => Number(r[c]) > v); return builder; },
        in: (c: string, v: unknown[]) => { predicates.push((r) => v.includes(r[c])); return builder; },
        not: (c: string, op: string, v: unknown) => {
          predicates.push((r) => op === 'is' ? r[c] != null : !(Array.isArray(r[c]) && (r[c] as unknown[]).length === 0) && v === '{}');
          return builder;
        },
        // Wyszukiwanie po nazwie/NIP: w testach fraza nie pasuje do niczego.
        or: () => { predicates.push(() => false); return builder; },
        limit: () => builder,
        order: () => builder,
        range: (from: number, to: number) => { range = [from, to]; return builder; },
        then(resolve: (v: unknown) => unknown) {
          if (failOnTable === table) return Promise.resolve({ data: null, count: null, error: { message: 'permission denied for table' } }).then(resolve);
          const matching = (tables[table] ?? []).filter((r) => predicates.every((p) => p(r)))
            .sort((a, b) => String(a.id).localeCompare(String(b.id)));
          const data = range ? matching.slice(range[0], range[1] + 1) : matching;
          return Promise.resolve({ data: head ? null : data, count: matching.length, error: null }).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as PageContext['supabase'];
}

let seq = 0;
function sale(overrides: Row = {}): Row {
  seq += 1;
  return {
    id: `inv-${String(seq).padStart(5, '0')}`, tenant_id: TENANT, direction: 'outgoing', ksef_status: 'accepted',
    ksef_environment: 'production', issue_date: '2026-10-01', buyer_nip: '1234567890', buyer_data: null, ...overrides,
  };
}

describe('countActiveContractors — faktury z §2.4 pkt 2 w ostatnich 90 dniach', () => {
  const contractors = [
    { id: 'c1', nip: '1234567890' }, { id: 'c2', nip: '526-000-12-46' }, { id: 'c3', nip: '7777777777' },
    { id: 'c4', nip: '8888888888' }, { id: 'c5', nip: '9999999999' }, { id: 'c6', nip: '1111111111' },
  ];
  beforeEach(() => { env.value = 'production'; seq = 0; });

  it('liczy tylko przyjęte, sprzedażowe, z aktywnego środowiska, z okna 90 dni i tej firmy', async () => {
    const db = database({ invoices: [
      sale({ buyer_nip: '1234567890' }),
      sale({ buyer_nip: null, buyer_data: { nip: '5260001246' } }),
      sale({ buyer_nip: '7777777777', ksef_environment: 'test' }),
      sale({ buyer_nip: '8888888888', ksef_status: 'draft', ksef_environment: null }),
      sale({ buyer_nip: '9999999999', direction: 'incoming' }),
      sale({ buyer_nip: '1111111111', issue_date: '2026-07-22' }), // 91. dzień wstecz
      sale({ buyer_nip: '1111111111', tenant_id: 'inna-firma' }),
      sale({ buyer_nip: '1234567890', issue_date: '2026-07-23' }), // 90. dzień — w oknie, ten sam NIP
    ] });
    expect(await countActiveContractors(db, TENANT, contractors, NOW)).toBe(2);
  });

  it('przyjęta faktura bez środowiska w oknie zatrzymuje kafel', async () => {
    const db = database({ invoices: [sale({ ksef_environment: null })] });
    await expect(countActiveContractors(db, TENANT, contractors, NOW))
      .rejects.toThrow('Przyjęte faktury wymagają uzgodnienia środowiska KSeF');
  });

  it('ponad 1000 faktur: czyta wszystkie strony', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => sale({ buyer_nip: i === 1199 ? '7777777777' : '1234567890' }));
    expect(await countActiveContractors(database({ invoices: many }), TENANT, contractors, NOW)).toBe(2);
  });
});

describe('kafle /contractors — dane i błąd', () => {
  beforeEach(() => { env.value = 'production'; seq = 0; });

  it('Kontrahenci, Aktywni, Status VAT do sprawdzenia z kartoteki', async () => {
    const db = database({
      contractors: [
        { id: 'c1', tenant_id: TENANT, nip: '1234567890', vat_status: 'active', validation_warning: null },
        { id: 'c2', tenant_id: TENANT, nip: '5260001246', vat_status: 'unknown', validation_warning: null },
        { id: 'c3', tenant_id: 'inna', nip: '7777777777', vat_status: 'inactive', validation_warning: null },
      ],
      invoices: [sale({ buyer_nip: '1234567890', issue_date: '2026-10-19' })],
    });
    const props = { supabase: db, tenantId: TENANT, now: NOW };
    const count = renderToStaticMarkup(await ContractorsCountTile(props));
    expect(count).toContain('Kontrahenci');
    expect(count).toMatch(/>2</);
    const active = renderToStaticMarkup(await ActiveContractorsTile(props));
    expect(active).toContain('Aktywni (90 dni)');
    expect(active).toMatch(/>1</);
    const vat = renderToStaticMarkup(await VatToCheckTile(props));
    expect(vat).toContain('Status VAT do sprawdzenia');
    expect(vat).toMatch(/>1</);
  });

  it('Z zaległościami: podpis §2.4 pkt 11; błąd odczytu → polska część komunikatu, bez PostgREST-a', async () => {
    const ok = database({
      contractors: [{ id: 'c1', tenant_id: TENANT, nip: '1234567890', vat_status: 'active', validation_warning: null }],
      invoices: [],
    });
    const html = renderToStaticMarkup(await OverdueContractorsTile({ supabase: ok, tenantId: TENANT }));
    expect(html).toContain('Z zaległościami');
    expect(html).toContain('Bez importów i faktur skorygowanych');

    const failing = database({ contractors: [] }, 'contractors');
    const error = renderToStaticMarkup(await ContractorsCountTile({ supabase: failing, tenantId: TENANT }));
    expect(error).toContain('Nie można odczytać kontrahentów');
    expect(error).not.toContain('permission denied');
  });
});

describe('ContractorsTable — układ Finory', () => {
  const row = (overrides: Partial<ContractorTableRow> = {}): ContractorTableRow => ({
    id: 'c1', nip: '1234567890', name: 'Klient spółka akcyjna', address: { addressLine1: 'Prosta 1', addressLine2: '00-001 Warszawa' },
    email: 'k@example.test', vat_status: 'active', validation_warning: null, reminder_excluded: false,
    receivables: { outstanding: 2460, overdueCount: 2 }, ...overrides,
  });

  it('kolumny, należności, po terminie, przełącznik i akcje', () => {
    const html = renderToStaticMarkup(<ContractorsTable contractors={[row()]} q="" emptyText="Brak wyników." note="Należności: bez importów" />);
    for (const text of ['Nazwa', 'NIP', 'Status VAT', 'Należności', 'Po terminie', 'Przypomnienia', 'Akcje',
      'Klient S.A.', '1234567890', 'Czynny VAT', '2460,00 zł', '2 faktury', 'Sprawdź wszystkich', 'Pozycje']) {
      expect(html).toContain(text);
    }
    expect(html).toContain('role="switch"');
    // Nazwa przełącznika z kontrahentem (WCAG 2.4.6), bez stanu — stan ogłasza rola switch.
    expect(html).toContain('aria-label="Przypomnienia dla Klient S.A."');
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toContain('aria-label="Przypomnienia włączone"');
    expect(html).toContain('aria-label="Edytuj kontrahenta"');
    expect(html).toContain('name="q"');
    expect(html).not.toContain('ff-glass-pane');
    expect(html).not.toContain('backdrop-blur');
  });

  it('należności nieznane → „—”, nie „0”; wykluczony kontrahent → przełącznik wyłączony', () => {
    const html = renderToStaticMarkup(
      <ContractorsTable contractors={[row({ receivables: null, reminder_excluded: true })]} q="" emptyText="Brak wyników." />,
    );
    expect(html).not.toContain('2460,00 zł');
    expect(html).toContain('aria-label="Przypomnienia dla Klient S.A."');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('—');
  });

  it('strona bez kontrahentów: „Brak kontrahentów” i „Wystaw fakturę” (e2e 04); z frazą: komunikat w tabeli', async () => {
    ctx.get.mockResolvedValue({ supabase: database({ contractors: [], invoices: [] }), tenantId: TENANT });
    const empty = renderToStaticMarkup(await ContractorsPage({ searchParams: Promise.resolve({}) }));
    expect(empty).toContain('Brak kontrahentów');
    expect(empty).toContain('href="/invoices/new"');
    const searched = renderToStaticMarkup(await ContractorsPage({ searchParams: Promise.resolve({ q: 'xyz' }) }));
    expect(searched).toContain('Brak kontrahentów dla „xyz”.');
  });

  it('strona: należności z getReceivables trafiają do wiersza kontrahenta po NIP', async () => {
    const contractor = {
      id: 'c1', tenant_id: TENANT, nip: '123-456-78-90', name: 'Dłużnik', address: null, email: null,
      vat_status: 'active', validation_warning: null, last_used_at: null, reminder_excluded: false,
    };
    const owed = {
      id: 'inv-1', tenant_id: TENANT, direction: 'outgoing', origin: 'app', ksef_status: 'accepted',
      ksef_environment: 'production', invoice_kind: 'regular', invoice_type: 'VAT', currency: 'PLN',
      gross_total: 1230, paid_amount: 230, payment_data: null, payment_due_date: '2020-01-10',
      payment_status: 'unpaid', buyer_nip: '1234567890', buyer_data: { name: 'Dłużnik' }, internal_number: 'FV/1',
      parent_invoice_id: null, advance_invoice_ids: [], issue_date: '2020-01-01',
    };
    ctx.get.mockResolvedValue({ supabase: database({ contractors: [contractor], invoices: [owed] }), tenantId: TENANT });
    const html = renderToStaticMarkup(await ContractorsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('1000,00 zł');
    expect(html).toContain('1 faktura');
  });

  it('faktura w walucie obcej: strona i kafel mówią, że ją pominięto (nie udają zera)', async () => {
    const contractor = {
      id: 'c1', tenant_id: TENANT, nip: '1234567890', name: 'Klient z EUR', address: null, email: null,
      vat_status: 'active', validation_warning: null, last_used_at: null, reminder_excluded: false,
    };
    const eur = {
      id: 'inv-eur', tenant_id: TENANT, direction: 'outgoing', origin: 'app', ksef_status: 'accepted',
      ksef_environment: 'production', invoice_kind: 'regular', invoice_type: 'VAT', currency: 'EUR',
      gross_total: 500, paid_amount: 0, payment_data: null, payment_due_date: '2020-01-10',
      payment_status: 'unpaid', buyer_nip: '1234567890', buyer_data: { name: 'Klient z EUR' }, internal_number: 'FV/EUR/1',
      parent_invoice_id: null, advance_invoice_ids: [], issue_date: '2020-01-01',
    };
    const db = database({ contractors: [contractor], invoices: [eur] });
    ctx.get.mockResolvedValue({ supabase: db, tenantId: TENANT });
    const html = renderToStaticMarkup(await ContractorsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('Pominięto 1 fakturę w walucie obcej');
    const tile = renderToStaticMarkup(await OverdueContractorsTile({ supabase: db, tenantId: TENANT }));
    expect(tile).toContain('Pominięto 1 fakturę w walucie obcej');
  });

  it('bez waluty obcej: brak dopisku o pominięciu', async () => {
    ctx.get.mockResolvedValue({ supabase: database({ contractors: [{ id: 'c1', tenant_id: TENANT, nip: '1234567890', name: 'K' }], invoices: [] }), tenantId: TENANT });
    const html = renderToStaticMarkup(await ContractorsPage({ searchParams: Promise.resolve({}) }));
    expect(html).not.toContain('w walucie obcej');
  });

  it('brak wyników wyszukiwania: komunikat i „Wyczyść”', () => {
    const html = renderToStaticMarkup(<ContractorsTable contractors={[]} q="xyz" emptyText="Brak kontrahentów dla „xyz”." />);
    expect(html).toContain('Brak kontrahentów dla „xyz”.');
    expect(html).toContain('href="/contractors"');
    expect(html).toContain('Brak pozycji');
  });
});
