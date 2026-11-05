import type { ReactNode } from 'react';
import { prerenderToNodeStream } from 'react-dom/static';
import { describe, expect, it, vi } from 'vitest';

import { fakePostgrest, type Read, type Row } from '../helpers/fake-postgrest';

vi.mock('@/lib/dashboard-shell-data', () => ({ getDashboardActiveOrgVerified: async () => true }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/przeplywy',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const { getInflows } = await import('@/lib/dashboard/inflows');
const movements = await import('@/lib/dashboard/cash-movements');
const { inflowTerms } = await import('@/lib/dashboard/inflow-terms');
const przeplywy = await import('@/components/przeplywy/finora-1do1/sloty');
const przeplywyAdaptery = await import('@/components/przeplywy/finora-1do1/adaptery');
const pulpit = await import('@/components/dashboard/finora/sloty');

/**
 * Recenzja E11, poprawki 2, po odwołaniu D-W (02.11.2026):
 *
 * 1. Korekta wystawiona PRZED terminem faktury bez wpłaty zmienia kwotę, którą
 *    nabywca zapłaci — w KSeF nie ma anulowania, „anulowana” faktura to korekta
 *    do zera. Spodziewane wpływy nie mogą pokazywać faktury pierwotnej w pełnej
 *    kwocie, a wykres nie może pokazać korekty jako osobnego wpływu.
 * 2. Jedna faktura jest albo wpływem (wykres, kafel, źródła, operacje), albo
 *    spodziewanym wpływem — nigdy jednym i drugim.
 */

const TENANT = 'firma-a';
/** Piątek 23.10.2026, 10:00 w Warszawie. */
const NOW = new Date('2026-10-23T08:00:00Z');
const NOW_ISO = NOW.toISOString();
const TODAY = '2026-10-23';

function sprzedaz(id: string, fields: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    direction: 'outgoing',
    origin: 'app',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    parent_invoice_id: null,
    advance_invoice_ids: [],
    currency: 'PLN',
    issue_date: '2026-10-01',
    internal_number: `FV/${id}`,
    net_total: 1000,
    vat_total: 230,
    gross_total: 1230,
    buyer_nip: '1234567890',
    buyer_data: { name: 'Klient Testowy sp. z o.o.', nip: '1234567890' },
    is_b2c: false,
    payment_data: null,
    payment_due_date: '2026-11-30',
    payment_status: 'unpaid',
    paid_amount: 0,
    paid_at: null,
    fa3_data: {},
    ...fields,
  };
}

/** Korekta faktury `parent` — kwoty to różnica ze znakiem (AUD-21), termin domyślny formularza: +14 dni. */
function korekta(id: string, parent: string, gross: number, fields: Row = {}): Row {
  const net = Math.round((gross / 1.23) * 100) / 100;
  return sprzedaz(id, {
    invoice_kind: 'correction',
    invoice_type: 'KOR',
    parent_invoice_id: parent,
    internal_number: `KOR/${id}`,
    net_total: net,
    vat_total: Math.round((gross - net) * 100) / 100,
    gross_total: gross,
    ...fields,
  });
}

function sb(invoices: Row[], reads?: Read[]) {
  return fakePostgrest({ invoices, expenses: [], tenants: [{ id: TENANT, vat_exemption_basis: null }] }, reads);
}

async function prerender(node: ReactNode): Promise<string> {
  const { prelude } = await prerenderToNodeStream(<>{node}</>);
  let out = '';
  for await (const chunk of prelude) out += String(chunk);
  return out.replace(/<!-- -->/g, '').replace(/[  ]/g, ' ');
}

// Faktura z terminem 30.11 „anulowana” korektą do zera z 02.10 (termin korekty 16.10 już minął).
const ANULOWANA = [
  sprzedaz('a', { buyer_data: { name: 'Alfa Przykład', nip: '1234567890' } }),
  korekta('ka', 'a', -1230, { issue_date: '2026-10-02', payment_due_date: '2026-10-16' }),
];

describe('korekta przed terminem zmienia kwotę spodziewanego wpływu', () => {
  it('korekta do zera: faktury nie ma w spodziewanych, choć dni korekty są przed zakresem', async () => {
    const entries = await getInflows(sb(ANULOWANA), TENANT, { from: TODAY });
    expect(movements.upcomingInflows(entries, TODAY, 60).count).toBe(0);
    expect(inflowTerms(entries, TODAY).total).toBe(0);
  });

  it('korekta częściowa: spodziewana jest kwota po korekcie, w dniu terminu faktury pierwotnej', async () => {
    const entries = await getInflows(sb([
      sprzedaz('a', { payment_due_date: '2026-11-10' }),
      korekta('ka', 'a', -369, { issue_date: '2026-10-02', payment_due_date: '2026-10-16' }),
    ]), TENANT, { from: TODAY });
    const terms = inflowTerms(entries, TODAY);
    expect(terms.total).toBe(861);
    expect(terms.count).toBe(1);
    expect(movements.upcomingInflows(entries, TODAY).items.map((i) => [i.id, i.dueDate, i.amount])).toEqual([
      ['a', '2026-11-10', 861],
    ]);
  });

  it('wykres: korekta do zera przed terminem nie jest ujemnym wpływem w swoim dniu', async () => {
    const entries = await getInflows(sb(ANULOWANA), TENANT, { from: '2026-10-01' });
    const ops = movements.cashFlowOperations(entries, [], TODAY);
    expect(ops).toEqual([]);
    expect(movements.monthFlows(entries, [], TODAY).inflow.amount).toBe(0);
  });

  it('korekta po terminie faktury bez wpłaty: osobna pozycja, ale nie ruch pieniędzy (nikt nic nie zapłacił)', async () => {
    const entries = await getInflows(sb([
      sprzedaz('a', { issue_date: '2026-09-01', payment_due_date: '2026-09-15' }),
      korekta('ka', 'a', -123, { issue_date: '2026-10-05', payment_due_date: null }),
    ]), TENANT, { from: '2026-09-01' });
    expect(entries.map((e) => [e.id, e.date, e.amount])).toEqual([
      ['a', '2026-09-15', 1230],
      ['ka', '2026-10-05', -123],
    ]);
    expect(movements.receivedInflows(entries, TODAY)).toEqual([]);
  });

  it('Spodziewane wpływy pokazują kwotę po korekcie; Należności pomijają fakturę skorygowaną (RECEIVABLES_NOTE)', async () => {
    const dane = [
      sprzedaz('a', { payment_due_date: '2026-11-10', buyer_data: { name: 'Alfa Przykład', nip: '1234567890' } }),
      korekta('ka', 'a', -369, { issue_date: '2026-10-02', payment_due_date: '2026-10-16' }),
    ];
    const przeplywyOut = await prerender(
      <przeplywy.SpodziewaneSlot supabase={sb(dane)} tenantId={TENANT} nowIso={NOW_ISO} tryb="prawdziwe" kosztyKsefOd={null} />,
    );
    expect(przeplywyOut).toContain('861,00 zł');
    expect(przeplywyOut).not.toContain('1230,00 zł');
    const pulpitOut = await prerender(
      <pulpit.NaleznosciSlot supabase={sb(dane)} tenantId={TENANT} nowIso={NOW_ISO} tryb="prawdziwe" kosztyKsefOd={null} />,
    );
    expect(pulpitOut).toContain('0 faktur');
  });

  it('bez faktur z terminem od dziś nie ma dodatkowego odczytu korekt', async () => {
    const reads: Read[] = [];
    await getInflows(sb([sprzedaz('a', { payment_due_date: '2026-10-01' })], reads), TENANT, { from: TODAY });
    expect(reads.length).toBe(1);
  });
});

describe('jedna faktura: wpływ albo spodziewany — nie oba', () => {
  const entries = [
    { id: 'dzis', date: TODAY, basis: 'due' as const, amount: 1000, outstanding: 1000 },
    { id: 'wczoraj', date: '2026-10-22', basis: 'due' as const, amount: 400, outstanding: 400 },
    { id: 'zaplata-dzis', date: TODAY, basis: 'paid' as const, amount: 250, outstanding: 0 },
    { id: 'wystawiona-dzis', date: TODAY, basis: 'issued' as const, amount: 50, outstanding: 50 },
  ].map((e) => ({
    ...e,
    dueDate: e.basis === 'issued' ? null : e.date,
    invoiceKind: 'regular',
    internalNumber: `FV/${e.id}`,
    buyerKey: 'nip:1234567890',
    buyerName: 'Klient Testowy sp. z o.o.',
    buyerNip: '1234567890',
    consumers: false,
  }));

  it('termin dziś: spodziewany, a nie na wykresie, w kaflu i w operacjach; wpływ to sama wpłata', () => {
    expect(movements.upcomingInflows(entries, TODAY).items.map((i) => i.id)).toEqual(['dzis']);
    expect(inflowTerms(entries, TODAY).total).toBe(1000);
    expect(movements.receivedInflows(entries, TODAY).map((e) => e.id)).toEqual(['zaplata-dzis']);
    expect(movements.monthFlows(entries, [], TODAY).inflow.amount).toBe(250);
    expect(movements.cashFlowOperations(entries, [], TODAY).map((o) => o.id)).toEqual(['in:zaplata-dzis']);
    const chart = movements.buildCashFlowChart(entries, [], TODAY);
    expect(chart.month.at(-1)?.inflow).toBe(250);
  });

  it('pusty kafel, gdy jedyna faktura ma termin dziś: prowadzi do oznaczenia zapłaty', () => {
    const tylkoDzis = entries.filter((e) => e.id === 'dzis');
    const dane = przeplywyAdaptery.wplywyMiesiacaProps(
      movements.monthFlows(tylkoDzis, [], TODAY).inflow,
      przeplywyAdaptery.krzywaWplywow(tylkoDzis, TODAY),
      'prawdziwe',
    );
    expect(dane.amount).toBe('—');
    // Krzywa 8 tygodni (zrzuty 24.10.2026) też bez terminu dziś — to jeszcze nie wpływ.
    expect(dane.chartData.every((p) => p.value === 0)).toBe(true);
    expect(`${dane.comparison} ${dane.amountTitle}`).not.toMatch(/brak faktur/i);
    expect(dane.comparison).toBe('Oznacz wpłatę przy fakturze');
    expect(dane.amountTitle).toContain('Zapłacone');
    expect(dane.comparison.length).toBeLessThanOrEqual('wobec poprzedniego miesiąca'.length);
  });

  it('suma: wpływy + spodziewane, bez podwójnego liczenia; po terminie i bez terminu ani tu, ani tu', () => {
    const received = movements.receivedInflows(entries, TODAY).reduce((s, e) => s + e.amount, 0);
    expect(received + inflowTerms(entries, TODAY).total).toBe(1250);
  });
});
