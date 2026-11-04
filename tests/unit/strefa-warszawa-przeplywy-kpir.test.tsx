import { Children, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  provenance: vi.fn(async () => undefined),
}));
// Strona KPiR pyta o tryb danych (dane przykładowe przed weryfikacją KSeF) — tu firma zweryfikowana.
vi.mock('@/lib/demo/tryb-danych', () => ({ trybDanych: async () => ({ tryb: 'prawdziwe', stan: 'C', verifiedAt: null }) }));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: mocks.context }));
vi.mock('@/lib/ksef/claim-environment', () => ({
  requireConfiguredKsefEnvironment: () => 'production',
}));
vi.mock('@/lib/ksef/accounting-provenance', () => ({
  assertAcceptedInvoiceEnvironmentComplete: mocks.provenance,
}));

import KpirPage from '@/app/(dashboard)/reports/kpir/page';
import { KpirFinanceCard } from '@/components/przeplywy/finora/chart-finance';
import { getCashFlowData } from '@/lib/dashboard/cash-flow';
import { estimateIncomeTaxThisYear } from '@/lib/dashboard/tax-estimate';
import { resolveKpirPeriod } from '@/lib/reports/kpir-data';
import type { PageContext } from '@/lib/supabase/page-context';
import { memoryClient } from './helpers/baza-w-pamieci';

/**
 * Plan Finora §2.4 pkt 10, ta sama przyczyna co w `getMonthlyFigures`:
 * „dziś” brane z pól daty w strefie procesu. Serwer chodzi w UTC, a komponenty
 * klienckie renderują się najpierw na serwerze, więc tuż po północy czasu
 * polskiego 1. dnia miesiąca (i w Nowy Rok) strona liczyła poprzedni miesiąc
 * albo rok. Wszystko tu bierze „dziś” z `todayInWarsaw`.
 */

const ORIGINAL_TZ = process.env.TZ;
function runInZone(zone: string) {
  // Node przelicza strefę przy każdym przypisaniu `process.env.TZ`.
  process.env.TZ = zone;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  runInZone('UTC');
});
afterEach(() => vi.useRealTimers());
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

/** 1 stycznia 2027, 00:30 czasu polskiego (CET, UTC+1). */
const NOWY_ROK_0030 = '2026-12-31T23:30:00Z';
/** 1 listopada 2026, 00:30 czasu polskiego (CET, UTC+1). */
const PIERWSZY_LISTOPADA_0030 = '2026-10-31T23:30:00Z';

const fv = (issue_date: string, net: number) => ({
  issue_date, net_total: net, gross_total: net * 1.23, invoice_kind: 'regular' as const,
});

describe('szacunek podatku — rok w Europe/Warsaw', () => {
  it('w Nowy Rok o 00:30 liczy już nowy rok od 1 stycznia, nie zysk z sierpnia–grudnia', () => {
    const estimate = estimateIncomeTaxThisYear(
      [fv('2026-11-10', 100_000)], [], new Date(NOWY_ROK_0030), '2026-08-01',
    );

    expect(estimate.label).toBe('Szac. podatek od 1 stycznia');
    expect(estimate.fullYear).toBe(true);
    expect(estimate.amount).toBe(0);
  });
});

describe('przepływy — okno sześciu miesięcy w Europe/Warsaw', () => {
  it('1 listopada o 00:30 okno kończy się na listopadzie także przy renderze na serwerze w UTC', async () => {
    vi.setSystemTime(new Date(PIERWSZY_LISTOPADA_0030));
    const sprzedaz = (id: string, issue_date: string, net: number) => ({
      id, tenant_id: 'firma-a', direction: 'outgoing', ksef_status: 'accepted', ksef_environment: 'production',
      currency: 'PLN', invoice_kind: 'regular', advance_invoice_ids: [], issue_date, net_total: net, gross_total: net * 1.23,
    });
    const supabase = memoryClient({
      invoices: [sprzedaz('maj', '2026-05-20', 5_000), sprzedaz('listopad', '2026-11-01', 1_000)],
      expenses: [],
    }) as unknown as PageContext['supabase'];

    // Od E5 (plan Finora) okno liczy `getCashFlowData` — karta tylko je pokazuje.
    const data = await getCashFlowData(supabase, 'firma-a', new Date());
    const html = renderToStaticMarkup(
      <KpirFinanceCard
        months={data.months}
        revenue={data.revenue}
        costs={data.costs}
        profit={data.profit}
        report={data.report}
        revenueChangePct={data.revenueChangePct}
        costsHint="none"
      />,
    );

    expect(data.months.map((m) => m.longLabel)).toContain('lis 2026');
    expect(data.months.map((m) => m.longLabel)).not.toContain('maj 2026');
    expect(data.revenue.at(-1)).toBe(1_000);
    expect(html).toContain('lis 2026');
    expect(html).not.toContain('maj 2026');
  });
});

describe('KPiR — domyślny miesiąc w Europe/Warsaw', () => {
  function emptyDatabase() {
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'gte', 'lte', 'lt', 'is', 'order', 'range']) {
      builder[method] = () => builder;
    }
    builder.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: [], count: 0, error: null }).then(resolve);
    return { from: () => builder };
  }

  async function kpirView(searchParams: { month?: string; year?: string }) {
    mocks.context.mockResolvedValue({ supabase: emptyDatabase(), tenantId: 'firma-a' });
    const page = await KpirPage({ searchParams: Promise.resolve(searchParams) });
    const view = Children.toArray(page.props.children).find(
      (child) => (child as ReactElement<{ month?: number }>).props?.month !== undefined,
    ) as ReactElement<{ month: number; year: number }>;
    const call = mocks.provenance.mock.calls[0] as unknown as [unknown, { periodStart: string; periodEnd: string }];
    return { month: view.props.month, year: view.props.year, period: call[1] };
  }

  it('1 listopada o 00:30 bez parametrów pokazuje listopad, nie październik', async () => {
    vi.setSystemTime(new Date(PIERWSZY_LISTOPADA_0030));

    const result = await kpirView({});

    expect(result.month).toBe(11);
    expect(result.year).toBe(2026);
    expect(result.period).toMatchObject({ periodStart: '2026-11-01', periodEnd: '2026-11-30' });
  });

  it('w Nowy Rok o 00:30 bez parametrów pokazuje styczeń nowego roku', async () => {
    vi.setSystemTime(new Date(NOWY_ROK_0030));

    const result = await kpirView({});

    expect(result.month).toBe(1);
    expect(result.year).toBe(2027);
    expect(result.period).toMatchObject({ periodStart: '2027-01-01', periodEnd: '2027-01-31' });
  });

  it('resolveKpirPeriod (odczyt KPiR wyjęty ze strony): ta sama reguła dnia w Polsce', () => {
    expect(resolveKpirPeriod({}, new Date(PIERWSZY_LISTOPADA_0030)))
      .toEqual({ month: 11, year: 2026, periodStart: '2026-11-01', periodEnd: '2026-11-30' });
    expect(resolveKpirPeriod({}, new Date(NOWY_ROK_0030)))
      .toEqual({ month: 1, year: 2027, periodStart: '2027-01-01', periodEnd: '2027-01-31' });
    runInZone('Europe/Warsaw');
    expect(resolveKpirPeriod({ month: '3', year: '2026' }, new Date('2026-03-15T12:00:00Z')))
      .toMatchObject({ periodStart: '2026-03-01', periodEnd: '2026-03-31' });
  });

  it('granice okresu nie cofają się o dzień, gdy proces chodzi w strefie polskiej', async () => {
    runInZone('Europe/Warsaw');
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));

    const result = await kpirView({ month: '3', year: '2026' });

    expect(result.period).toMatchObject({ periodStart: '2026-03-01', periodEnd: '2026-03-31' });
  });
});
