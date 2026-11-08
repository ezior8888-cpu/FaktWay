import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T4 i T5 (PLAN-PRAWDZIWE-DANE §5.4, §8, etap E2): atrapa bazy z danymi
 * przykładowymi zasila TE SAME loadery `lib/dashboard/*` co prawdziwe karty
 * Pulpitu i Przepływów (§6.1, §6.2). Każdy loader ma dać pełny, niepusty
 * wynik („pełna okazałość” przed weryfikacją KSeF), a liczby mają być
 * spójne jak w prawdziwej firmie usługowej: zysk < przychód, koszty <
 * przychód, wpływy według terminów płatności (`przykladoweWplywy` — bez oznaczonych
 * wpłat), daty względem `now` (strefa Warszawa). Od poprawki Bartosza
 * 23.10.2026 miesiące mają kształt wykresów Finory (zob. nagłówek
 * `lib/demo/dane-przykladowe.ts`) — dawne widełki 25–45 tys. zł i 30–40%
 * kosztów zastąpił kształt (`finora-wyglad-ladowanie.test.tsx`).
 *
 * Kształt propsów kart (adaptery) dochodzi w E5/E6 — tu loadery i spójność.
 */

const { analizyDemoSupabase, DEMO_TENANT } = await import('@/lib/demo/analizy-przykladowe');
const { fakePostgrest } = await import('@/lib/demo/fake-postgrest');
const { getSalesSeries, getMonthlyFigures } = await import('@/lib/dashboard/monthly-figures');
const { getCosts, getCostsWithKsefPurchases, KSEF_INVOICE_COST_SOURCE, sumCostsByMonth } = await import('@/lib/dashboard/costs');
const { buildMonthReport } = await import('@/lib/dashboard/pulpit-report');
const { inflowTerms } = await import('@/lib/dashboard/inflow-terms');
const { getTopClients, getTopProducts, warsawMonthWindow } = await import('@/lib/dashboard/rankings');
const { getInflows } = await import('@/lib/dashboard/inflows');
const {
  buildCashFlowChart,
  cashFlowOperations,
  monthFlows,
  przykladoweWplywy,
  nextMonthStart,
  receivedInflows,
  topCashFlowSources,
  upcomingInflows,
  yearsWindowStart,
} = await import('@/lib/dashboard/cash-movements');
const { countPendingReview, getCashFlowData } = await import('@/lib/dashboard/cash-flow');
const { countExpensesToReview, getLastInboxFetchAt } = await import('@/lib/dashboard/expense-stats');
const { getVatLimit } = await import('@/lib/dashboard/vat-limit');
const { getSalesInvoices, salesMonthStats } = await import('@/lib/analytics-finance/sales');
const { shiftMonthKey } = await import('@/lib/analytics-finance/months');
const { isSubjectiveVatExemption, readTenantVatExemption } = await import('@/lib/invoices/vat-exemption');
const { readTenantBusinessStart } = await import('@/lib/invoices/business-start');
const { todayInWarsaw } = await import('@/lib/format/warsaw-date');

type Supabase = ReturnType<typeof analizyDemoSupabase>;
type Row = Record<string, unknown>;

/** Piątek 23.10.2026, 10:00 w Warszawie — środek miesiąca. */
const NOW = new Date('2026-10-23T08:00:00Z');
const T = DEMO_TENANT;

/** Krańce kalendarza: okna przesuwają się z `now`, karty zostają pełne. */
const KRANCE: Array<[string, Date]> = [
  ['1. dzień miesiąca tuż po północy', new Date('2026-10-31T23:30:00Z')], // 1.11, 00:30 w Warszawie
  ['ostatni dzień miesiąca wieczorem', new Date('2026-10-31T21:30:00Z')], // 31.10, 22:30
  ['Nowy Rok', new Date('2027-01-01T09:00:00Z')],
  ['koniec lutego', new Date('2027-02-28T11:00:00Z')],
];

function demo(now: Date = NOW, opcje?: { zwolnionyZVat?: boolean }): Supabase {
  return analizyDemoSupabase(now, 'test', opcje);
}

async function wszystkie(sb: Supabase, table: string): Promise<Row[]> {
  const { data } = await sb.from(table).select('*');
  return (data ?? []) as Row[];
}

function malejaco(values: readonly number[]): boolean {
  return values.every((v, i) => i === 0 || values[i - 1]! >= v);
}

const suma = (values: readonly number[]) => values.reduce((s, v) => s + v, 0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── T4: Pulpit ──────────────────────────────────────────────────────────────

describe('T4 Pulpit: loadery kart na atrapie dają pełne wyniki', () => {
  it('Finanse + Raport: 7 miesięcy przychodu netto i kosztów, zysk = przychód − koszty', async () => {
    const sb = demo();
    const series = await getSalesSeries(sb, T, NOW, { months: 7, withPrevYear: false });
    const keys = series.months.map((m) => m.key);
    // E10: karty liczą koszty `getCostsWithKsefPurchases` (faktury zakupu z KSeF + wydatki).
    const costs = sumCostsByMonth(
      await getCostsWithKsefPurchases(sb, T, { from: `${keys[0]}-01`, toExclusive: nextMonthStart(todayInWarsaw(NOW)) }),
      keys,
    );
    expect(series.netSeries).toHaveLength(7);
    expect(series.netSeries.every((v) => v > 0)).toBe(true);
    expect(costs.every((v) => v > 0)).toBe(true);
    keys.forEach((_, i) => expect(costs[i]!).toBeLessThan(series.netSeries[i]!));

    const report = buildMonthReport(series.netSeries, costs);
    expect(report.revenue).toBeGreaterThan(0);
    expect(report.costs).toBeGreaterThan(0);
    expect(report.profit).toBeCloseTo(report.revenue - report.costs, 2);
    expect(report.profit).toBeLessThan(report.revenue);
    expect(report.monthlyAverageNet).not.toBeNull();
  });

  it('Kafle: faktury miesiąca z poprzednim miesiącem, średnia faktura w obu miesiącach', async () => {
    const sb = demo();
    const figures = await getMonthlyFigures(sb, T, NOW);
    expect(figures.acceptedCount).toBeGreaterThan(0);
    expect(figures.hasPrevMonth).toBe(true);
    expect(figures.totalNet).toBeGreaterThan(0);
    expect(figures.totalVat).toBeGreaterThan(0);

    const month = todayInWarsaw(NOW).slice(0, 7);
    const prev = shiftMonthKey(month, -1);
    const invoices = await getSalesInvoices(sb, T, warsawMonthWindow(NOW, 2));
    expect(salesMonthStats(invoices, month, prev).avgPerInvoice).not.toBeNull();
    expect(salesMonthStats(invoices, prev, shiftMonthKey(prev, -1)).avgPerInvoice).not.toBeNull();
  });

  it('Przychód: 5 miesięcy i to samo okno rok wcześniej (24 miesiące historii)', async () => {
    const series = await getSalesSeries(demo(), T, NOW, { months: 5, withPrevYear: true });
    expect(series.netSeries.every((v) => v > 0)).toBe(true);
    expect(series.prevSeries).toHaveLength(5);
    expect(series.prevSeries.every((v) => v > 0)).toBe(true);
  });

  it('VAT: firma czynna (tenants bez podstawy zwolnienia), VAT należny w każdym z 12 miesięcy', async () => {
    const sb = demo();
    expect(await readTenantVatExemption(sb, T)).toBeNull();
    const series = await getSalesSeries(sb, T, NOW, { months: 12, withPrevYear: false });
    expect(series.vatSeries).toHaveLength(12);
    expect(series.vatSeries.every((v) => v > 0)).toBe(true);
    // Stawka 23%: VAT należny miesiąca to ~23% netto (bez korekt dokładnie).
    series.vatSeries.forEach((vat, i) => expect(vat / series.netSeries[i]!).toBeCloseTo(0.23, 2));
  });

  it('wariant „zwolniony z VAT” (tylko testy): podstawa w tenants, VAT 0, limit poniżej progu', async () => {
    const sb = demo(NOW, { zwolnionyZVat: true });
    const basis = await readTenantVatExemption(sb, T);
    expect(isSubjectiveVatExemption(basis)).toBe(true);
    const series = await getSalesSeries(sb, T, NOW, { months: 12, withPrevYear: false });
    expect(series.vatSeries.every((v) => v === 0)).toBe(true);
    expect(series.netSeries.every((v) => v > 0)).toBe(true);

    const limit = await getVatLimit(sb, T, NOW);
    // Poprawka 23.10.2026: historia od stycznia sprzed 4 lat (widok „Rocznie”), działalność od 5 lat.
    expect(limit.startedOn).toBe('2021-10-01');
    expect(limit.used).toBeGreaterThan(0);
    expect(limit.limit).not.toBeNull();
    expect(limit.limit!.pct).toBeGreaterThan(30);
    expect(limit.limit!.pct).toBeLessThan(100);
  });

  // Poprawka 23.10.2026: 5 lat (dawniej 3) — przed najstarszą fakturą, bo historia sięga stycznia sprzed 4 lat.
  it('data rozpoczęcia działalności: 5 lat wstecz od bieżącego miesiąca', async () => {
    expect(await readTenantBusinessStart(demo(), T)).toBe('2021-10-01');
  });

  // Atrapa bez wpłat: Należności to przyszłe terminy (`inflowTerms`), nie faktury po terminie.
  it('Należności: wszystkie trzy kolumny terminów, suma kolumn = suma karty', async () => {
    const today = todayInWarsaw(NOW);
    const terms = inflowTerms(await getInflows(demo(), T, { from: today }), today);
    expect(terms.buckets.map((b) => b.count > 0)).toEqual([true, true, true]);
    expect(suma(terms.buckets.map((b) => b.amount))).toBeCloseTo(terms.total, 2);
    expect(suma(terms.buckets.map((b) => b.pct))).toBe(100);
  });

  it('Rankingi: 5 produktów (z j.m.) i 5 klientów z % zmiany, malejąco', async () => {
    const sb = demo();
    const products = await getTopProducts(sb, T, NOW);
    expect(products).toHaveLength(5);
    expect(products.every((p) => p.unit !== null && p.net > 0)).toBe(true);
    expect(malejaco(products.map((p) => p.net))).toBe(true);

    const clients = await getTopClients(sb, T, NOW);
    expect(clients).toHaveLength(5);
    expect(clients.every((c) => c.changePct !== null && c.nip !== null)).toBe(true);
    expect(malejaco(clients.map((c) => c.net))).toBe(true);
    // Klienci rosną i maleją — nie same strzałki w górę.
    expect(clients.some((c) => c.changePct! > 0)).toBe(true);
    expect(clients.some((c) => c.changePct! < 0)).toBe(true);
  });
});

// ─── T4: Przepływy ───────────────────────────────────────────────────────────

describe('T4 Przepływy: loadery kart na atrapie dają pełne wyniki', () => {
  const today = todayInWarsaw(NOW);
  const recent = warsawMonthWindow(NOW, 12);
  const years = { from: yearsWindowStart(today), toExclusive: nextMonthStart(today) };

  it('wykres: 7 tygodni, 7 miesięcy z wpłatami i kosztami, lata od pierwszego z danymi', async () => {
    const sb = demo();
    const chart = buildCashFlowChart(przykladoweWplywy(await getInflows(sb, T, years), today), await getCostsWithKsefPurchases(sb, T, years), today);
    expect(chart.week).toHaveLength(7);
    expect(chart.week.some((b) => b.inflow > 0)).toBe(true);
    expect(chart.week.some((b) => b.outflow > 0)).toBe(true);
    expect(chart.month).toHaveLength(7);
    expect(chart.month.every((b) => b.inflow > 0 && b.outflow > 0 && b.inflowCount > 0)).toBe(true);
    // Poprawka 23.10.2026: pięć lat jak „Rocznie” w Finorze (dawniej co najmniej dwa).
    expect(chart.year).toHaveLength(5);
    expect(chart.year.every((b) => b.inflow > 0 && b.outflow > 0)).toBe(true);
  });

  it('kafle miesiąca: „Wpłynęło” ma krzywą z kilku dni, ostatni punkt = kwota kafla; koszty miesiąca', async () => {
    const sb = demo();
    const { inflow, outflow } = monthFlows(przykladoweWplywy(await getInflows(sb, T, recent), today), await getCostsWithKsefPurchases(sb, T, recent), today);
    expect(inflow.amount).toBeGreaterThan(0);
    expect(inflow.changePct).not.toBeNull();
    expect(new Set(inflow.daily.map((p) => p.value)).size).toBeGreaterThanOrEqual(3);
    expect(inflow.daily.at(-1)!.value).toBe(inflow.amount);
    expect(outflow.amount).toBeGreaterThan(0);
    expect(outflow.daily.at(-1)!.value).toBe(outflow.amount);
  });

  it('źródła: co najmniej 5 po każdej stronie, malejąco', async () => {
    const sb = demo();
    const inflows = przykladoweWplywy(await getInflows(sb, T, recent), today);
    const costs = await getCostsWithKsefPurchases(sb, T, recent);
    const wplywy = topCashFlowSources(inflows, [], today);
    const wydatki = topCashFlowSources([], costs, today);
    expect(wplywy).toHaveLength(5);
    expect(wydatki).toHaveLength(5);
    expect(malejaco(wplywy.map((s) => s.amount))).toBe(true);
    expect(malejaco(wydatki.map((s) => s.amount))).toBe(true);
    expect(topCashFlowSources(inflows, costs, today)).toHaveLength(5);
  });

  it('Spodziewane wpływy: co najmniej 5 faktur z terminem w 30 dni, rosnąco po terminie', async () => {
    const upcoming = upcomingInflows(await getInflows(demo(), T, { from: today }), today);
    expect(upcoming.count).toBeGreaterThanOrEqual(5);
    expect(upcoming.items).toHaveLength(5);
    const dates = upcoming.items.map((i) => i.dueDate);
    expect([...dates].sort()).toEqual(dates);
  });

  it('operacje: co najmniej 8 w 12 miesiącach (dwie strony tabeli), od najnowszej', async () => {
    const sb = demo();
    const ops = cashFlowOperations(przykladoweWplywy(await getInflows(sb, T, recent), today), await getCostsWithKsefPurchases(sb, T, recent), today);
    expect(ops.length).toBeGreaterThanOrEqual(8);
    expect(ops.some((o) => o.direction === 'in')).toBe(true);
    expect(ops.some((o) => o.direction === 'out' && o.status === 'pending')).toBe(true);
    const dates = ops.map((o) => o.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('podatek: szacunek od 1 stycznia > 0, przychód i koszty w 6 miesiącach', async () => {
    const data = await getCashFlowData(demo(), T, NOW);
    expect(data.taxEstimate.fullYear).toBe(true);
    expect(data.taxEstimate.amount).toBeGreaterThan(0);
    expect(data.revenue.every((v) => v > 0)).toBe(true);
    expect(data.costs.every((v) => v > 0)).toBe(true);
    data.profit.forEach((p, i) => expect(p).toBeCloseTo(data.revenue[i]! - data.costs[i]!, 2));
  });

  it('wydatki do opisania i ostatnie pobranie ze Skrzynki (limit + maybeSingle)', async () => {
    const sb = demo();
    expect(await countPendingReview(sb, T)).toBeGreaterThanOrEqual(1);
    expect(await countExpensesToReview(sb, T)).toBeGreaterThanOrEqual(1);
    // E10: demo ma faktury ze Skrzynki — „ostatnie pobranie” sprawdza osobny test niżej.
    expect(await getLastInboxFetchAt(sb, T)).not.toBeNull();
  });
});

// ─── T5: spójność demo ───────────────────────────────────────────────────────

describe('T5 spójność: firma usługowa, liczby i daty względem now', () => {
  /**
   * Dawniej: przychód 25–45 tys. zł netto i koszty 30–40% w każdym miesiącu.
   * Poprawka Bartosza 23.10.2026 („przywróć stare wykresy”): miesiące mają
   * kształt Finory (słupki 20–50 tys. zł brutto, linia VAT od 11 tys.), więc
   * widełki zastępuje sama spójność — kształt pilnuje `finora-wyglad-ladowanie`.
   * Zrzuty 24.10.2026: koszty 55–90% wpływów jak „Przepływy” Finory, więc
   * sufit kosztów wobec przychodu netto świadomie 0,9 (dawniej 0,7) — zysk
   * zostaje w każdym miesiącu.
   */
  it('12 pełnych miesięcy: zysk > 0, koszty < przychód netto, sprzedaż do 50 tys. zł brutto', async () => {
    const sb = demo();
    const series = await getSalesSeries(sb, T, NOW, { months: 13, withPrevYear: false });
    const keys = series.months.map((m) => m.key);
    // E10: karty liczą koszty `getCostsWithKsefPurchases` (faktury zakupu z KSeF + wydatki).
    const costs = sumCostsByMonth(
      await getCostsWithKsefPurchases(sb, T, { from: `${keys[0]}-01`, toExclusive: nextMonthStart(todayInWarsaw(NOW)) }),
      keys,
    );
    for (let i = 0; i < 13; i++) {
      const net = series.netSeries[i]!;
      expect(net, keys[i]).toBeGreaterThan(0);
      expect(costs[i]!, keys[i]).toBeGreaterThan(0);
      expect(costs[i]! / net, keys[i]).toBeLessThanOrEqual(0.9 + 1e-9);
      expect(series.currentSeries[i]!, keys[i]).toBeLessThanOrEqual(50_000);
    }
  });

  // Pliki `lib/demo` bez zmian: atrapa nie ma `paid_at`, miniony termin gra rolę wpłaty (`przykladoweWplywy`).
  it('faktury: bez oznaczonych wpłat, status jak wyzwalacz 00073 dla wpłaty 0, vat_total = brutto − netto', async () => {
    const invoices = await wszystkie(demo(), 'invoices');
    const today = todayInWarsaw(NOW);
    expect(invoices.length).toBeGreaterThan(0);
    for (const inv of invoices) {
      const gross = Number(inv.gross_total);
      expect(Number(inv.vat_total)).toBeCloseTo(gross - Number(inv.net_total), 2);
      expect(inv.sale_date).toBe(inv.issue_date);
      expect(String(inv.issue_date) <= today).toBe(true);
      expect(inv.paid_at, String(inv.id)).toBeNull();
      expect(Number(inv.paid_amount), String(inv.id)).toBe(0);
      const due = inv.payment_due_date as string | null;
      expect(inv.payment_status).toBe(due !== null && due < today ? 'overdue' : 'unpaid');
    }
  });

  // Poprawka 23.10.2026: dawniej 24 miesiące; widok „Rocznie” ma pięć lat jak w Finorze.
  it('historia od stycznia sprzed 4 lat: najstarsza faktura i wydatek w styczniu roku Y−4', async () => {
    const sb = demo();
    const year = Number(todayInWarsaw(NOW).slice(0, 4));
    const oldest = (rows: Row[]) => rows.map((r) => String(r.issue_date)).sort()[0]!.slice(0, 7);
    expect(oldest(await wszystkie(sb, 'invoices'))).toBe(`${year - 4}-01`);
    expect(oldest(await wszystkie(sb, 'expenses'))).toBe(`${year - 4}-01`);
  });

  it('nazwy z „Przykład”, NIP-y fikcyjne (same zera na początku)', async () => {
    const sb = demo();
    for (const inv of await wszystkie(sb, 'invoices')) {
      expect((inv.buyer_data as { name: string }).name).toContain('Przykład');
      expect(String(inv.buyer_nip)).toMatch(/^0000\d{6}$/);
    }
    for (const exp of await wszystkie(sb, 'expenses')) {
      expect(String(exp.seller_name)).toContain('Przykład');
      if (exp.seller_nip !== null) expect(String(exp.seller_nip)).toMatch(/^0000\d{6}$/);
    }
  });

  describe.each(KRANCE)('%s: okna przesuwają się, karty zostają pełne', (_, now) => {
    beforeEach(() => vi.setSystemTime(now));

    it('przychód, koszty i wpływy bieżącego miesiąca, kolumny należności, wpływy i klienci', async () => {
      const sb = demo(now);
      const today = todayInWarsaw(now);
      const series = await getSalesSeries(sb, T, now, { months: 12, withPrevYear: true });
      expect(series.netSeries.every((v) => v > 0)).toBe(true);
      expect(series.prevSeries.every((v) => v > 0)).toBe(true);
      expect(series.vatSeries.every((v) => v > 0)).toBe(true);

      const recent = warsawMonthWindow(now, 12);
      const costs = await getCostsWithKsefPurchases(sb, T, recent);
      expect(costs.some((c) => c.issueDate.startsWith(today.slice(0, 7)))).toBe(true);
      expect(costs.every((c) => c.issueDate <= today)).toBe(true);

      const future = await getInflows(sb, T, { from: today });
      expect(inflowTerms(future, today).buckets.map((b) => b.count > 0)).toEqual([true, true, true]);
      expect(upcomingInflows(future, today).count).toBeGreaterThanOrEqual(5);

      const clients = await getTopClients(sb, T, now);
      expect(clients).toHaveLength(5);
      expect(clients.every((c) => c.changePct !== null)).toBe(true);

      const inflows = przykladoweWplywy(await getInflows(sb, T, recent), today);
      // Okno do końca miesiąca ma też terminy po dziś — karty liczą tylko wpływy do dziś.
      expect(receivedInflows(inflows, today).length).toBeGreaterThan(0);
      expect(topCashFlowSources(inflows, [], today).length).toBe(5);
      await expect(getCashFlowData(sb, T, now)).resolves.toBeDefined();
    });
  });
});

// ─── E10: koszty z KSeF w demo tą samą definicją co kartach ──────────────────

describe('E10 (D-K): demo ma faktury zakupu z KSeF i liczy je jak prawdziwa firma', () => {
  const recent = warsawMonthWindow(NOW, 12);

  it('faktury zakupu: ze Skrzynki (z wydatkiem) i z historii KSeF (bez wydatku), w aktywnym środowisku', async () => {
    const sb = demo();
    const invoices = await wszystkie(sb, 'invoices');
    const expenses = await wszystkie(sb, 'expenses');
    const zakupy = invoices.filter((i) => i.direction === 'incoming');
    const skrzynka = zakupy.filter((i) => i.origin === 'ksef_inbox');
    const historia = zakupy.filter((i) => i.origin === 'ksef_import');
    expect(skrzynka.length).toBeGreaterThan(0);
    expect(historia.length).toBeGreaterThan(0);
    expect(zakupy.every((i) => i.ksef_status === 'accepted' && i.ksef_environment === 'test' && i.currency === 'PLN')).toBe(true);
    // Skrzynka: dokładnie jeden wydatek na fakturę (00121); historia: archiwum bez wydatków.
    for (const inv of skrzynka) expect(expenses.filter((e) => e.ksef_invoice_id === inv.id)).toHaveLength(1);
    for (const inv of historia) expect(expenses.filter((e) => e.ksef_invoice_id === inv.id)).toHaveLength(0);
    // Wydatki spoza KSeF zostają (OCR i ręczne, w tym paragony).
    expect(expenses.some((e) => e.source === 'ocr_photo' && e.ksef_invoice_id === null)).toBe(true);
    expect(expenses.some((e) => e.source === 'manual' && e.ksef_invoice_id === null)).toBe(true);
  });

  it('karty liczą każdą fakturę raz: wydatki + faktury z historii; KPiR (getCosts) — same wydatki', async () => {
    const sb = demo();
    const pelne = await getCostsWithKsefPurchases(sb, T, recent);
    const wydatki = await getCosts(sb, T, recent);
    const historia = pelne.filter((e) => e.source === KSEF_INVOICE_COST_SOURCE);
    expect(historia.length).toBeGreaterThan(0);
    expect(pelne).toHaveLength(wydatki.length + historia.length);
    expect(new Set(pelne.map((e) => e.id)).size).toBe(pelne.length);
    expect(historia.every((e) => e.categoryLabel === 'Faktury z KSeF' && e.sellerName?.includes('Przykład'))).toBe(true);
  });

  it('ostatnie pobranie ze Skrzynki: najnowsza faktura ze Skrzynki (historia się nie liczy)', async () => {
    const sb = demo();
    const skrzynka = (await wszystkie(sb, 'invoices')).filter((i) => i.direction === 'incoming' && i.origin === 'ksef_inbox');
    const najnowsza = skrzynka.map((i) => String(i.created_at)).sort().at(-1);
    expect(await getLastInboxFetchAt(sb, T)).toBe(najnowsza);
  });
});

// ─── Atrapa: operatory ───────────────────────────────────────────────────────

describe('atrapa PostgREST-a: operatory loaderów, reszta rzuca', () => {
  const tables = {
    tenants: [{ id: 'a', vat_exemption_basis: null }, { id: 'b', vat_exemption_basis: 'x' }],
  };

  it('maybeSingle: jeden wiersz, null bez wiersza, błąd przy wielu (jak PostgREST)', async () => {
    const sb = fakePostgrest(tables);
    expect((await sb.from('tenants').select('id').eq('id', 'a').maybeSingle()).data).toEqual({ id: 'a' });
    expect((await sb.from('tenants').select('id').eq('id', 'zzz').maybeSingle()).data).toBeNull();
    const many = await sb.from('tenants').select('id').maybeSingle();
    expect(many.data).toBeNull();
    expect(many.error).not.toBeNull();
  });

  it('limit: tyle wierszy, ile poproszono', async () => {
    const { data } = await fakePostgrest(tables).from('tenants').select('id').order('id', { ascending: false }).limit(1);
    expect(data).toEqual([{ id: 'b' }]);
  });

  it('nieobsłużony operator rzuca, zamiast udawać pusty wynik', () => {
    const builder = fakePostgrest(tables).from('tenants').select('id') as unknown as Record<string, unknown>;
    // E11: `or` z prostymi warunkami jest obsłużone; zagnieżdżone i nieznane operatory rzucają.
    expect(() => (builder.or as (f: string) => unknown)('and(id.eq.a,id.eq.b)')).toThrow(/nieobsługiwane/);
    expect(() => (builder.or as (f: string) => unknown)('id.like.a%')).toThrow(/nieobsługiwane/);
    expect(() => (builder.ilike as (c: string, v: string) => unknown)('id', 'a%')).toThrow();
    expect(() => fakePostgrest(tables).from('tenants').select('id').not('id', 'like', 'a%')).toThrow(/nieobsługiwane/);
  });
});
