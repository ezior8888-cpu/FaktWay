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
const labels = await import('@/lib/dashboard/inflow-labels');
const { PAID_EMPTY_STATE } = await import('@/lib/invoices/paid-labels');
const przeplywyAdaptery = await import('@/components/przeplywy/finora-1do1/adaptery');
const przeplywy = await import('@/components/przeplywy/finora-1do1/sloty');
const pulpit = await import('@/components/dashboard/finora/sloty');
const sprzedaz = await import('@/components/analizy/sprzedaz-grid');

/**
 * Koniec zakładania (FaktWay 1.0 §3 pkt 3): decyzję D-W z 23.10 odwołano
 * 02.11.2026 na polecenie Bartosza. Wpływ to wyłącznie prawdziwe pieniądze:
 * `paid_at` albo `Zaplacono = 1` + `DataZaplaty` z FA(3). Faktura bez wpłaty
 * z minionym terminem jest należnością po terminie, spodziewane wpływy to
 * otwarte faktury z terminem dziś lub później.
 */

const TENANT = 'firma-a';
/** Poniedziałek 02.11.2026, 10:00 w Warszawie. */
const NOW = new Date('2026-11-02T09:00:00Z');
const NOW_ISO = NOW.toISOString();
const TODAY = '2026-11-02';
const OD_POCZATKU_ROKU = { from: '2026-01-01' };

/** Faktura sprzedaży przyjęta w KSeF (aktywne środowisko testów: `test`), bez wpłat, po terminie. */
function faktura(id: string, fields: Row = {}): Row {
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
    issue_date: '2026-10-05',
    internal_number: `FV/${id}`,
    net_total: 1000,
    vat_total: 230,
    gross_total: 1230,
    buyer_nip: '1234567890',
    buyer_data: { name: 'Klient Testowy sp. z o.o.', nip: '1234567890' },
    is_b2c: false,
    payment_data: null,
    payment_due_date: '2026-10-19',
    payment_status: 'overdue',
    paid_amount: 0,
    paid_at: null,
    fa3_data: {},
    ...fields,
  };
}

const zaplacona = (id: string, paidAt: string, fields: Row = {}) =>
  faktura(id, { paid_amount: 1230, paid_at: paidAt, payment_status: 'paid', ...fields });

function korekta(id: string, parent: string, gross: number, fields: Row = {}): Row {
  return faktura(id, {
    invoice_kind: 'correction',
    invoice_type: 'KOR',
    parent_invoice_id: parent,
    internal_number: `KOR/${id}`,
    gross_total: gross,
    net_total: Math.round((gross / 1.23) * 100) / 100,
    vat_total: Math.round((gross - gross / 1.23) * 100) / 100,
    payment_status: 'unpaid',
    ...fields,
  });
}

function sb(invoices: Row[], reads?: Read[]) {
  return fakePostgrest({ invoices, expenses: [], tenants: [{ id: TENANT, vat_exemption_basis: null }] }, reads);
}

async function wplywy(invoices: Row[]) {
  return movements.receivedInflows(await getInflows(sb(invoices), TENANT, OD_POCZATKU_ROKU), TODAY);
}

async function prerender(node: ReactNode): Promise<string> {
  const { prelude } = await prerenderToNodeStream(<>{node}</>);
  let out = '';
  for await (const chunk of prelude) out += String(chunk);
  return out.replace(/<!-- -->/g, '').replace(/[  ]/g, ' ');
}

/** Tekst widoczny i ukryty (dymki `title`, `sr-only`). */
function napisy(markup: string): string {
  return [markup.replace(/<[^>]+>/g, ' '), ...[...markup.matchAll(/title="([^"]*)"/g)].map((m) => m[1])].join(' ');
}

describe('wpływ to wyłącznie prawdziwe pieniądze', () => {
  it('faktura bez wpłaty z minionym terminem nie jest wpływem', async () => {
    expect(await wplywy([faktura('a')])).toEqual([]);
  });

  it('faktura bez wpłaty i bez terminu nie jest wpływem', async () => {
    expect(await wplywy([faktura('a', { payment_due_date: null, payment_status: 'unpaid' })])).toEqual([]);
  });

  it('faktura z wpłatą częściową nie jest wpływem, dopóki nie jest zapłacona w całości', async () => {
    expect(await wplywy([faktura('a', { paid_amount: 400, payment_status: 'partial' })])).toEqual([]);
  });

  it('paid_at: wpływ w dniu zapłaty w Warszawie, kwota wpłaty', async () => {
    const entries = await wplywy([zaplacona('a', '2026-10-09T22:30:00Z')]);
    expect(entries.map((e) => [e.id, e.date, e.basis, e.amount, e.outstanding])).toEqual([
      ['a', '2026-10-10', 'paid', 1230, 0],
    ]);
  });

  it('Zaplacono + DataZaplaty z FA(3): wpływ w tym dniu, także z pliku i z historii KSeF', async () => {
    const entries = await wplywy([
      faktura('a', { origin: 'ksef_import', fa3_data: { parsed: { paidDate: '2026-10-03' } } }),
    ]);
    expect(entries.map((e) => [e.id, e.date, e.basis, e.amount])).toEqual([['a', '2026-10-03', 'paid', 1230]]);
  });

  it('karty: kafel, wykres, źródła i operacje liczą tylko zapłaconą fakturę', async () => {
    const entries = await getInflows(
      sb([zaplacona('z', '2026-11-01T10:00:00Z'), faktura('po-terminie', { payment_due_date: '2026-11-01' })]),
      TENANT,
      OD_POCZATKU_ROKU,
    );
    expect(movements.monthFlows(entries, [], TODAY).inflow).toMatchObject({ amount: 1230, count: 1 });
    expect(movements.buildCashFlowChart(entries, [], TODAY).month.at(-1)).toMatchObject({ inflow: 1230, inflowCount: 1 });
    expect(movements.topCashFlowSources(entries, [], TODAY)[0]).toMatchObject({ amount: 1230, count: 1 });
    expect(movements.cashFlowOperations(entries, [], TODAY).map((o) => [o.id, o.status])).toEqual([['in:z', 'paid']]);
  });

  it('operacje nie znają już statusów „wg terminu” i „wg wystawienia”', async () => {
    const ops = movements.cashFlowOperations(
      await getInflows(sb([faktura('t'), faktura('w', { payment_due_date: null })]), TENANT, OD_POCZATKU_ROKU),
      [],
      TODAY,
    );
    expect(ops).toEqual([]);
  });
});

describe('spodziewane wpływy: otwarte faktury z terminem dziś lub później', () => {
  it('termin dziś i później tak; miniony termin, brak terminu i zapłacona nie', async () => {
    const entries = await getInflows(
      sb([
        faktura('dzis', { payment_due_date: TODAY, payment_status: 'unpaid' }),
        faktura('pozniej', { payment_due_date: '2026-11-20', payment_status: 'unpaid' }),
        faktura('po-terminie'),
        faktura('bez-terminu', { payment_due_date: null, payment_status: 'unpaid' }),
        zaplacona('zaplacona', '2026-11-01T10:00:00Z', { payment_due_date: '2026-11-20' }),
      ]),
      TENANT,
      OD_POCZATKU_ROKU,
    );
    expect(movements.upcomingInflows(entries, TODAY).items.map((i) => [i.id, i.daysLeft, i.amount])).toEqual([
      ['dzis', 0, 1230],
      ['pozniej', 18, 1230],
    ]);
  });

  it('wpłata częściowa: spodziewana jest tylko reszta', async () => {
    const entries = await getInflows(
      sb([faktura('a', { payment_due_date: '2026-11-20', paid_amount: 400, payment_status: 'partial' })]),
      TENANT,
      OD_POCZATKU_ROKU,
    );
    expect(movements.upcomingInflows(entries, TODAY).items.map((i) => i.amount)).toEqual([830]);
  });
});

describe('korekta to nie zapłata', () => {
  it('korekta in minus do faktury bez wpłaty nie jest ruchem pieniędzy', async () => {
    expect(await wplywy([
      faktura('a'),
      korekta('k', 'a', -123, { issue_date: '2026-10-25', payment_due_date: null }),
    ])).toEqual([]);
  });

  it('korekta in minus do zapłaconej faktury: osobny ruch w dniu wystawienia korekty, razem kwota po korekcie', async () => {
    const entries = await wplywy([
      zaplacona('a', '2026-10-10T10:00:00Z'),
      korekta('k', 'a', -123, { issue_date: '2026-10-25', payment_due_date: '2026-11-08' }),
    ]);
    expect(entries.map((e) => [e.id, e.date, e.basis, e.amount, e.outstanding])).toEqual([
      ['a', '2026-10-10', 'paid', 1230, 0],
      ['k', '2026-10-25', 'correction', -123, 0],
    ]);
    expect(entries.reduce((s, e) => s + e.amount, 0)).toBe(1107);
  });

  it('korekta in minus do faktury zapłaconej wg FA(3) też jest ruchem', async () => {
    const entries = await wplywy([
      faktura('a', { origin: 'file_import', fa3_data: { parsed: { paidDate: '2026-10-03' } } }),
      korekta('k', 'a', -123, { issue_date: '2026-10-25', payment_due_date: null }),
    ]);
    expect(entries.map((e) => [e.id, e.basis, e.amount])).toEqual([
      ['a', 'paid', 1230],
      ['k', 'correction', -123],
    ]);
  });

  it('rodzic zapłacony przed zakresem odczytu: dodatkowy odczyt rozstrzyga, że korekta jest ruchem', async () => {
    const reads: Read[] = [];
    const rows = [
      zaplacona('a', '2026-03-10T10:00:00Z', { issue_date: '2026-03-01', payment_due_date: '2026-03-15' }),
      korekta('k', 'a', -123, { issue_date: '2026-10-25', payment_due_date: null }),
    ];
    const entries = await getInflows(sb(rows, reads), TENANT, { from: '2026-10-01' });
    expect(movements.receivedInflows(entries, TODAY).map((e) => [e.id, e.basis, e.amount])).toEqual([
      ['k', 'correction', -123],
    ]);
    expect(reads.length).toBeGreaterThan(1);
  });

  it('rodzic bez wpłaty przed zakresem odczytu: korekta nie jest ruchem', async () => {
    const entries = await getInflows(
      sb([
        faktura('a', { issue_date: '2026-03-01', payment_due_date: '2026-03-15' }),
        korekta('k', 'a', -123, { issue_date: '2026-10-25', payment_due_date: null }),
      ]),
      TENANT,
      { from: '2026-10-01' },
    );
    expect(movements.receivedInflows(entries, TODAY)).toEqual([]);
  });

  it('korekta in plus bez wpłaty: czeka na oznaczenie, po oznaczeniu jest wpływem', async () => {
    const otwarta = korekta('k', 'a', 123, { issue_date: '2026-10-25', payment_due_date: '2026-11-08' });
    const rodzic = zaplacona('a', '2026-10-10T10:00:00Z');
    const przed = await getInflows(sb([rodzic, otwarta]), TENANT, OD_POCZATKU_ROKU);
    expect(movements.receivedInflows(przed, TODAY).map((e) => e.id)).toEqual(['a']);
    expect(movements.upcomingInflows(przed, TODAY).items.map((i) => [i.id, i.amount])).toEqual([['k', 123]]);

    const po = await wplywy([
      rodzic,
      { ...otwarta, paid_amount: 123, paid_at: '2026-11-01T10:00:00Z', payment_status: 'paid' },
    ]);
    expect(po.map((e) => [e.id, e.date, e.basis, e.amount])).toEqual([
      ['a', '2026-10-10', 'paid', 1230],
      ['k', '2026-11-01', 'paid', 123],
    ]);
  });
});

// Recenzja PR #358, pkt 1. „Zapłacone” (`mark_invoice_paid`) zapisuje całą resztę brutto
// faktury, a korekta nie rusza `paid_amount`: faktura 1000 zł, korekta −300 z 28.10,
// zapłacone 2.11 to w kasie 700 zł. Korekta wystawiona do dnia zapłaty należy do wpływu
// z tej wpłaty (jeden ruch w dniu zapłaty); osobnym ruchem jest dopiero korekta późniejsza.
describe('korekta wystawiona do dnia zapłaty zmniejsza wpływ z tej wpłaty', () => {
  const zaplaconaTysiac = (fields: Row = {}) => zaplacona('a', '2026-11-02T08:00:00Z', {
    gross_total: 1000, net_total: 813.01, vat_total: 186.99, paid_amount: 1000, ...fields,
  });
  const minus300 = (issued: string, fields: Row = {}) =>
    korekta('k', 'a', -300, { issue_date: issued, payment_due_date: null, ...fields });
  const skrot = (entries: Array<{ id: string; date: string; basis: string; amount: number }>) =>
    entries.map((e) => [e.id, e.date, e.basis, e.amount]);

  it('korekta sprzed zapłaty: jeden ruch +700 w dniu zapłaty, bez ujemnego ruchu w dniu korekty', async () => {
    const entries = await getInflows(sb([zaplaconaTysiac(), minus300('2026-10-28')]), TENANT, OD_POCZATKU_ROKU);
    expect(skrot(movements.receivedInflows(entries, TODAY))).toEqual([['a', '2026-11-02', 'paid', 700]]);
    expect(movements.buildCashFlowChart(entries, [], TODAY).month.slice(-2).map((m) => [m.key, m.inflow, m.inflowCount]))
      .toEqual([['2026-10', 0, 0], ['2026-11', 700, 1]]);
    expect(movements.monthFlows(entries, [], TODAY).inflow).toMatchObject({ amount: 700, count: 1 });
  });

  it('okno odczytu zaczyna się po wystawieniu korekty: wpływ i tak jest po korekcie', async () => {
    const entries = await getInflows(sb([zaplaconaTysiac(), minus300('2026-10-28')]), TENANT, { from: '2026-11-01' });
    expect(skrot(entries)).toEqual([['a', '2026-11-02', 'paid', 700]]);
  });

  it('korekta w dniu zapłaty jest wliczona, dzień później to osobny ruch; suma ta sama', async () => {
    const wDniuZaplaty = await getInflows(sb([zaplaconaTysiac(), minus300('2026-11-02')]), TENANT, OD_POCZATKU_ROKU);
    expect(skrot(wDniuZaplaty)).toEqual([['a', '2026-11-02', 'paid', 700]]);

    const dzienPozniej = await getInflows(
      sb([zaplaconaTysiac({ paid_at: '2026-11-01T10:00:00Z' }), minus300('2026-11-02')]),
      TENANT,
      OD_POCZATKU_ROKU,
    );
    expect(skrot(dzienPozniej)).toEqual([['a', '2026-11-01', 'paid', 1000], ['k', '2026-11-02', 'correction', -300]]);
    expect(dzienPozniej.reduce((s, e) => s + e.amount, 0)).toBe(700);
  });

  it('faktura zapłacona wg FA(3) i skorygowana do daty zapłaty: kwota po korekcie', async () => {
    const entries = await getInflows(sb([
      faktura('a', {
        origin: 'file_import', gross_total: 1000, net_total: 813.01, vat_total: 186.99,
        fa3_data: { parsed: { paidDate: '2026-10-30' } },
      }),
      minus300('2026-10-28'),
    ]), TENANT, OD_POCZATKU_ROKU);
    expect(skrot(entries)).toEqual([['a', '2026-10-30', 'paid', 700]]);
  });

  it('korekta in plus przed zapłatą to osobny dług, nie część wpłaty', async () => {
    const plus200 = korekta('k', 'a', 200, { issue_date: '2026-10-28', payment_due_date: '2026-11-15' });
    const entries = await getInflows(sb([zaplaconaTysiac(), plus200]), TENANT, OD_POCZATKU_ROKU);
    expect(skrot(movements.receivedInflows(entries, TODAY))).toEqual([['a', '2026-11-02', 'paid', 1000]]);
    expect(movements.upcomingInflows(entries, TODAY).items.map((i) => [i.id, i.amount])).toEqual([['k', 200]]);
  });
});

describe('należności: po terminie to należność, nie wpływ', () => {
  it('Pulpit (prawdziwe dane): należność po terminie widać i prowadzi do listy zaległości', async () => {
    const out = await prerender(
      <pulpit.NaleznosciSlot
        supabase={sb([
          faktura('po-terminie', { payment_due_date: '2026-10-19' }),
          faktura('w-terminie', { payment_due_date: '2026-11-20', payment_status: 'unpaid' }),
        ])}
        tenantId={TENANT}
        nowIso={NOW_ISO}
        tryb="prawdziwe"
        kosztyKsefOd={null}
      />,
    );
    expect(out).toContain('50% zaległe');
    expect(out).toContain('/payments/overdue');
    expect(out).toContain('W terminie');
    expect(napisy(out)).not.toMatch(/według terminów płatności/);
  });

  it('Analizy (prawdziwe dane): wiersz „Po terminie” liczy zaległość', async () => {
    const markup = await prerender(await sprzedaz.ReceivablesSlot({
      supabase: sb([faktura('po-terminie', { payment_due_date: '2026-10-19' })]),
      tenantId: TENANT,
      nowIso: NOW_ISO,
      month: '2026-11',
      tryb: 'prawdziwe',
      kosztyKsefOd: null,
    }));
    expect(markup).toContain('Po terminie');
    expect(markup).toContain('1230,00 zł · 1 faktura');
    expect(napisy(markup)).not.toMatch(/według terminów płatności/);
  });
});

describe('napisy prowadzą do oznaczenia zapłaty', () => {
  const POZOSTALOSC_D_W = /wg terminów|według terminów|terminy płatności|zakładamy|klient nic nie oznacza/i;

  it('podpisy nie mówią już o terminach', () => {
    expect(labels.INFLOW_NOTE).toBe('według oznaczonych wpłat');
    expect(przeplywyAdaptery.PODTYTUL_WYKRESU).toBe('Oznaczone wpłaty i koszty brutto');
    for (const text of [
      labels.INFLOW_NOTE,
      labels.INFLOW_EMPTY,
      labels.INFLOW_EMPTY_TITLE,
      przeplywyAdaptery.PODTYTUL_WYKRESU,
      przeplywyAdaptery.PODTYTUL_WYKRESU_DYMEK,
      przeplywyAdaptery.SPODZIEWANE_NOTA,
    ]) {
      expect(text).not.toMatch(POZOSTALOSC_D_W);
      expect(text).not.toMatch(/[—–]/);
    }
  });

  it('pusty kafel wpływów prowadzi do oznaczenia i mieści się w miejscu podpisu', () => {
    const pusty = przeplywyAdaptery.wplywyMiesiacaProps(movements.monthFlows([], [], TODAY).inflow, [], 'prawdziwe');
    expect(pusty.amount).toBe('—');
    expect(pusty.comparison).toMatch(/oznacz/i);
    expect(pusty.amountTitle).toMatch(/Zapłacone/);
    expect(pusty.comparison.length).toBeLessThanOrEqual('wobec poprzedniego miesiąca'.length);
  });

  it('kafel „Opłacone” listy faktur prowadzi do oznaczenia', () => {
    expect(PAID_EMPTY_STATE).toMatch(/oznacz/i);
    expect(PAID_EMPTY_STATE).not.toMatch(/[—–]/);
  });

  it('puste listy Przepływów mają link do faktur', () => {
    const zrodla = przeplywyAdaptery.zrodlaProps([], 'prawdziwe');
    const aktywnosc = przeplywyAdaptery.aktywnoscProps([], 'prawdziwe');
    for (const lista of [zrodla, aktywnosc]) {
      expect(lista.empty).toMatch(/oznacz/i);
      expect(lista.emptyLink).toEqual({ label: 'Przejdź do faktur', href: '/invoices' });
    }
    // Atrapa nie ma prawdziwych dokumentów, a w synchronizacji mówimy, że faktury się pobierają.
    expect(przeplywyAdaptery.zrodlaProps([], 'przyklad').emptyLink).toBeNull();
    expect(przeplywyAdaptery.aktywnoscProps([], 'synchronizacja').emptyLink).toBeNull();
    expect(przeplywyAdaptery.tabelaProps([], 'prawdziwe').empty).toMatch(/oznacz/i);
  });

  it('Spodziewane wpływy (prawdziwe dane): bez odwołania do decyzji D-W', async () => {
    const out = await prerender(
      <przeplywy.SpodziewaneSlot
        supabase={sb([faktura('a', { payment_due_date: '2026-11-20', payment_status: 'unpaid' })])}
        tenantId={TENANT}
        nowIso={NOW_ISO}
        tryb="prawdziwe"
        kosztyKsefOd={null}
      />,
    );
    expect(napisy(out)).not.toMatch(POZOSTALOSC_D_W);
  });

  it('kafel wpływów i podtytuł: pieniądze, nie założenie', async () => {
    const out = await prerender(
      <przeplywy.WplywySlot supabase={sb([])} tenantId={TENANT} nowIso={NOW_ISO} tryb="prawdziwe" kosztyKsefOd={null} />,
    );
    expect(out).toContain('Wpłynęło w tym miesiącu');
    expect(napisy(out)).not.toMatch(POZOSTALOSC_D_W);
  });

  it('Należności na Pulpicie mówią, jak zdjąć zapłaconą fakturę', async () => {
    const out = await prerender(
      <pulpit.NaleznosciSlot supabase={sb([faktura('a')])} tenantId={TENANT} nowIso={NOW_ISO} tryb="prawdziwe" kosztyKsefOd={null} />,
    );
    expect(out).toContain('Zapłacone');
    expect(napisy(out)).not.toMatch(POZOSTALOSC_D_W);
  });
});
