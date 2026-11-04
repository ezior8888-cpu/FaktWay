import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prerenderToNodeStream } from 'react-dom/static';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakePostgrest, type Row } from '../helpers/fake-postgrest';

vi.mock('@/lib/dashboard-shell-data', () => ({ getDashboardActiveOrgVerified: async () => true }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/przeplywy',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const costs = await import('@/lib/dashboard/costs');
const { costVatSummary } = await import('@/lib/analytics-finance/costs');
const { cashFlowOperations } = await import('@/lib/dashboard/cash-movements');
const { getCashFlowData } = await import('@/lib/dashboard/cash-flow');
const { tabelaProps } = await import('@/components/przeplywy/finora-1do1/adaptery');
const { recentCostItems } = await import('@/components/analizy/adapters');
const { podpisKosztow } = await import('@/components/analizy/podpisy');
const { pulpitErrorMessage } = await import('@/components/dashboard/pulpit/pulpit-grid');
const przeplywy = await import('@/components/przeplywy/finora-1do1/sloty');
const pulpit = await import('@/components/dashboard/finora/sloty');
const koszty = await import('@/components/analizy/koszty-grid');

/**
 * PLAN-PRAWDZIWE-DANE E10, decyzja Bartosza D-K (23.10.2026): wykresy i karty
 * kosztów Pulpitu, Przepływów i Analiz liczą PEŁNE koszty z KSeF — faktury
 * zakupu z KSeF (Skrzynka i archiwum z historii) w aktywnym środowisku plus
 * wydatki spoza KSeF, bez podwójnego liczenia. KPiR, JPK, eksporty i tabela
 * `expenses` bez zmian: `getCosts` dalej widzi tylko wydatki.
 */

const TENANT = 'firma-a';
const NOW = new Date('2026-10-23T08:00:00Z');
const NOW_ISO = NOW.toISOString();
const RANGE = { from: '2026-09-01', toExclusive: '2026-11-01' };

/** Faktura zakupu z KSeF — domyślnie archiwum z historii (bez wydatku). */
function zakup(id: string, fields: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    direction: 'incoming',
    origin: 'ksef_import',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    ksef_number: `0000000011-20261005-${id}`,
    internal_number: `FZ/${id}`,
    issue_date: '2026-10-05',
    seller_nip: '0000000011',
    seller_data: { name: 'Dostawca Przykład sp. z o.o.', nip: '0000000011' },
    fa3_data: {},
    currency: 'PLN',
    net_total: 1000,
    vat_total: 230,
    gross_total: 1230,
    ...fields,
  };
}

function wydatek(id: string, fields: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    source: 'manual',
    ksef_invoice_id: null,
    issue_date: '2026-10-07',
    seller_nip: '0000000022',
    seller_name: 'Sklep Przykład',
    document_number: `PAR ${id}`,
    is_deductible: true,
    is_reviewed: true,
    document_type: 'invoice',
    net_amount: 100,
    vat_amount: 23,
    gross_amount: 123,
    vat_deductible_amount: 23,
    category_label: 'Materiały biurowe',
    ocr_extracted_data: null,
    ...fields,
  };
}

/** Wydatek utworzony przez Skrzynkę dla faktury `invoiceId` (00121: jeden na fakturę). */
function wydatekSkrzynki(id: string, invoiceId: string, fields: Row = {}): Row {
  return wydatek(id, {
    source: 'ksef_inbox',
    ksef_invoice_id: invoiceId,
    issue_date: '2026-10-05',
    seller_nip: '0000000011',
    seller_name: 'Dostawca Przykład sp. z o.o.',
    document_number: `FZ/${invoiceId}`,
    net_amount: 1000,
    vat_amount: 230,
    gross_amount: 1230,
    vat_deductible_amount: 230,
    category_label: 'Oprogramowanie',
    ...fields,
  });
}

function sb(tables: Record<string, Row[]>) {
  return fakePostgrest({ invoices: [], expenses: [], ...tables });
}

const spacje = (s: string) => s.replace(/[  ]/g, ' ');

async function prerender(node: ReactNode): Promise<string> {
  const { prelude } = await prerenderToNodeStream(<>{node}</>);
  let out = '';
  for await (const chunk of prelude) out += String(chunk);
  return spacje(out.replace(/<!-- -->/g, ''));
}

function html(node: ReactNode): string {
  return spacje(renderToStaticMarkup(<>{node}</>).replace(/<!-- -->/g, ''));
}

function description(out: string): string {
  return out.match(/data-slot="card-description"[^>]*>([^<]*)</)?.[1] ?? '';
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Jedna definicja kosztów ─────────────────────────────────────────────────

describe('getCostsWithKsefPurchases — faktury zakupu z KSeF + wydatki spoza KSeF', () => {
  it('faktura zakupu z historii KSeF bez wydatku jest w kosztach: netto do wyniku, brutto do przepływów', async () => {
    const db = sb({ invoices: [zakup('z1')] });
    const entries = await costs.getCostsWithKsefPurchases(db, TENANT, RANGE);
    expect(entries).toEqual([{
      id: 'z1',
      issueDate: '2026-10-05',
      source: costs.KSEF_INVOICE_COST_SOURCE,
      sellerNip: '0000000011',
      sellerName: 'Dostawca Przykład sp. z o.o.',
      cost: 1000,
      outflow: 1230,
      vatDeductible: 230,
      categoryLabel: 'Faktury z KSeF',
      vat: 230,
      documentNumber: 'FZ/z1',
      isReviewed: false,
    }]);
    expect(costs.costHref(entries[0]!)).toBe('/invoices/z1');
    // KPiR, JPK i eksporty czytają `getCosts` — tam faktury bez wydatku dalej nie ma.
    expect(await costs.getCosts(db, TENANT, RANGE)).toEqual([]);
  });

  it('faktura ze Skrzynki z powiązanym wydatkiem liczy się raz — z wydatku (kategoria, koszt jak w KPiR)', async () => {
    const entries = await costs.getCostsWithKsefPurchases(sb({
      invoices: [zakup('z2', { origin: 'ksef_inbox', seller_data: null, fa3_data: { seller: { nip: '0000000011', name: 'Dostawca Przykład sp. z o.o.' } } })],
      expenses: [wydatekSkrzynki('w2', 'z2')],
    }), TENANT, RANGE);
    expect(entries.map((e) => e.id)).toEqual(['w2']);
    expect(entries[0]).toMatchObject({ source: 'ksef_inbox', categoryLabel: 'Oprogramowanie', cost: 1000, outflow: 1230 });
    expect(costs.costHref(entries[0]!)).toBe('/expenses/w2');
  });

  it('wydatek decyduje: powiązany wydatek wyłączony z kosztów (np. waluta do przeglądu) wyłącza też fakturę', async () => {
    const entries = await costs.getCostsWithKsefPurchases(sb({
      invoices: [zakup('z3', { origin: 'ksef_inbox' })],
      expenses: [wydatekSkrzynki('w3', 'z3', { is_deductible: false })],
    }), TENANT, RANGE);
    expect(entries).toEqual([]);
  });

  it('wydatek z OCR bez faktury z KSeF liczy się jak dotąd', async () => {
    const entries = await costs.getCostsWithKsefPurchases(sb({
      expenses: [wydatek('w4', { source: 'ocr_photo' })],
    }), TENANT, RANGE);
    expect(entries.map((e) => [e.id, e.source, e.cost, e.outflow])).toEqual([['w4', 'ocr_photo', 100, 123]]);
  });

  it('ten sam dokument wpisany ręcznie albo z OCR (NIP sprzedawcy + numer) liczy się raz — z wydatku', async () => {
    const entries = await costs.getCostsWithKsefPurchases(sb({
      invoices: [zakup('z5', { internal_number: 'FV 15/10/2026' }), zakup('z6', { internal_number: 'FV 16/10/2026' })],
      expenses: [
        // Ten sam numer innym zapisem (wielkość liter, spacje) i ten sam NIP — ten sam dokument.
        wydatek('w5', { source: 'ocr_photo', seller_nip: '0000000011', document_number: ' fv 15/10/2026 ', net_amount: 1000, vat_amount: 230, gross_amount: 1230, vat_deductible_amount: 230 }),
        // Ten sam numer, inny dostawca — inny dokument.
        wydatek('w6', { seller_nip: '0000000099', document_number: 'FV 16/10/2026' }),
      ],
    }), TENANT, RANGE);
    expect(entries.map((e) => e.id).sort()).toEqual(['w5', 'w6', 'z6']);
  });

  it('środowisko TEST nie wchodzi do PROD: ani faktura, ani wydatek powiązany z fakturą z TEST', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    const entries = await costs.getCostsWithKsefPurchases(sb({
      invoices: [
        zakup('z-test', { ksef_environment: 'test' }),
        zakup('z-test-skrzynka', { ksef_environment: 'test', origin: 'ksef_inbox' }),
        zakup('z-prod', { ksef_environment: 'production' }),
      ],
      expenses: [wydatekSkrzynki('w-test', 'z-test-skrzynka')],
    }), TENANT, RANGE);
    expect(entries.map((e) => e.id)).toEqual(['z-prod']);
  });

  it('poza kosztami: sprzedaż, faktury nieprzyjęte, dokumenty przychodzące spoza KSeF i spoza okna', async () => {
    const entries = await costs.getCostsWithKsefPurchases(sb({
      invoices: [
        zakup('sprzedaz', { direction: 'outgoing' }),
        zakup('odrzucona', { ksef_status: 'rejected' }),
        zakup('z-ocr', { origin: 'ocr' }),
        zakup('z-pliku', { origin: 'file_import' }),
        zakup('stara', { issue_date: '2026-08-31' }),
        zakup('ok'),
      ],
    }), TENANT, RANGE);
    expect(entries.map((e) => e.id)).toEqual(['ok']);
  });

  it('korekta zakupu in minus: ujemny koszt i ujemny wypływ (zwrot)', async () => {
    const [entry] = await costs.getCostsWithKsefPurchases(sb({
      invoices: [zakup('kor', { net_total: -100, vat_total: -23, gross_total: -123 })],
    }), TENANT, RANGE);
    expect([entry!.cost, entry!.outflow, entry!.vat]).toEqual([-100, -123, -23]);
  });

  it('firma zwolniona podmiotowo (art. 113): VAT z faktury nie do odliczenia — koszt brutto, jak wydatek ze Skrzynki', async () => {
    const [entry] = await costs.getCostsWithKsefPurchases(sb({
      tenants: [{ id: TENANT, vat_exemption_basis: 'art. 113 ust. 1 ustawy o VAT' }],
      invoices: [zakup('z7')],
    }), TENANT, RANGE);
    expect([entry!.cost, entry!.vatDeductible]).toEqual([1230, 0]);
  });

  it('nazwa sprzedawcy z faktury ze Skrzynki (metadane KSeF), gdy wydatku jeszcze nie ma', async () => {
    const [entry] = await costs.getCostsWithKsefPurchases(sb({
      invoices: [zakup('z8', { origin: 'ksef_inbox', seller_data: null, fa3_data: { seller: { nip: '0000000011', name: 'Skrzynka Przykład S.A.' } } })],
    }), TENANT, RANGE);
    expect(entry!.sellerName).toBe('Skrzynka Przykład S.A.');
  });

  it('faktura zakupu w walucie obcej bez wydatku zatrzymuje kartę komunikatem z numerem dokumentu', async () => {
    const error = await costs.getCostsWithKsefPurchases(sb({
      invoices: [zakup('z9', { origin: 'ksef_inbox', currency: 'EUR', net_total: 100, vat_total: 99.5, gross_total: 123 })],
    }), TENANT, RANGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(costs.KsefPurchaseCurrencyError);
    const message = pulpitErrorMessage(error);
    expect(message).toContain('FZ/z9');
    expect(message).toContain('EUR');
    expect(message).toContain('Wydatkach');
  });

  it('faktura w walucie obcej z wydatkiem (czeka na przegląd kursu) nie zatrzymuje karty — decyduje wydatek', async () => {
    const entries = await costs.getCostsWithKsefPurchases(sb({
      invoices: [zakup('z10', { origin: 'ksef_inbox', currency: 'EUR' })],
      expenses: [wydatekSkrzynki('w10', 'z10', { is_deductible: false, is_reviewed: false })],
    }), TENANT, RANGE);
    expect(entries).toEqual([]);
  });
});

// ─── Karty na tej samej definicji ───────────────────────────────────────────

describe('karty na pełnych kosztach: faktura z historii KSeF bez wydatku', () => {
  const tables = () => ({ invoices: [zakup('z1', { issue_date: '2026-10-05' })], expenses: [] as Row[] });

  it('Przepływy: „Koszty w tym miesiącu (brutto)” liczy fakturę z KSeF', async () => {
    const out = await prerender(
      <przeplywy.KosztySlot supabase={sb(tables())} tenantId={TENANT} nowIso={NOW_ISO} tryb="prawdziwe" kosztyKsefOd={null} />,
    );
    expect(out).toContain('1230 zł');
  });

  it('Pulpit: Raport „Ten miesiąc” — koszty netto z faktury z KSeF', async () => {
    const out = await prerender(
      <pulpit.FinanseSlot supabase={sb(tables())} tenantId={TENANT} nowIso={NOW_ISO} tryb="prawdziwe" kosztyKsefOd={null} />,
    );
    expect(out).toContain('1000,00 zł');
  });

  it('Przepływy: „Odłóż na podatek” i wykres KPiR czytają te same koszty', async () => {
    const data = await getCashFlowData(sb(tables()), TENANT, NOW);
    expect(data.costs.at(-1)).toBe(1000);
    expect(data.costEntries.map((e) => e.id)).toEqual(['z1']);
  });

  it('Analizy: „Przychody a koszty” — koszt z faktury, podpis mówi o KSeF i wydatkach', async () => {
    const out = html(await koszty.CostIncomeExpenseSlot({
      supabase: sb(tables()), tenantId: TENANT, nowIso: NOW_ISO, month: '2026-10', tryb: 'prawdziwe', kosztyKsefOd: null,
    }));
    expect(out).toContain('1000,00 zł');
    expect(description(out)).toBe('Netto · z KSeF i wydatków, bez VAT do odliczenia');
  });

  it('Analizy: podpis kart kosztów — „Z KSeF i wydatków”; historia zakupów niepełna — „Z wydatków, KSeF od DD.MM”', async () => {
    expect(podpisKosztow('brutto, 6 mies.', '')).toBe('Z KSeF i wydatków · brutto, 6 mies.');
    expect(podpisKosztow('brutto, 6 mies.', 'KSeF od 09.10')).toBe('Z wydatków, KSeF od 09.10 · brutto, 6 mies.');
    const p = { supabase: sb(tables()), tenantId: TENANT, nowIso: NOW_ISO, month: '2026-10', tryb: 'prawdziwe' as const };
    expect(description(html(await koszty.CostTrendSlot({ ...p, kosztyKsefOd: null })))).toBe('Z KSeF i wydatków · brutto, 6 mies.');
    expect(description(html(await koszty.CostTrendSlot({ ...p, kosztyKsefOd: '2026-10-09T08:00:00Z' }))))
      .toBe('Z wydatków, KSeF od 09.10 · brutto, 6 mies.');
  });

  it('Analizy: „VAT z wydatków” — VAT z faktury jest, ale faktura nie jest „do opisania” (nie ma wydatku)', async () => {
    const entries = await costs.getCostsWithKsefPurchases(sb(tables()), TENANT, RANGE);
    expect(costVatSummary(entries, '2026-10')).toEqual({ vat: 230, vatDeductible: 230, toReview: 0 });
  });

  it('Analizy: „Ostatnie wydatki” linkuje fakturę z KSeF do faktury, wydatek do wydatku', async () => {
    const entries = await costs.getCostsWithKsefPurchases(sb({ ...tables(), expenses: [wydatek('w1')] }), TENANT, RANGE);
    expect(recentCostItems(entries, '2026-10', true).map((i) => i.href)).toEqual(['/expenses/w1', '/invoices/z1']);
  });

  it('Przepływy: operacja z faktury z KSeF — kategoria i status prawdziwe, menu otwiera fakturę', async () => {
    const entries = await costs.getCostsWithKsefPurchases(sb(tables()), TENANT, RANGE);
    // E11: operacje biorą „dziś” (wpływy po dziś to Spodziewane wpływy).
    const ops = cashFlowOperations([], entries, '2026-10-23');
    expect(ops).toEqual([expect.objectContaining({ id: 'out:z1', category: 'Faktury z KSeF', status: 'ksef', href: '/invoices/z1' })]);
    const [row] = tabelaProps(ops, 'prawdziwe').rows;
    expect(row).toMatchObject({ category: 'Faktury z KSeF', status: 'ksef', openLabel: 'Otwórz fakturę', href: '/invoices/z1' });
  });
});
