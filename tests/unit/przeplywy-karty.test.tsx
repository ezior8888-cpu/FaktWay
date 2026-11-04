import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));

import { PULPIT_EMPTY } from '@/components/dashboard/pulpit/card-states';
import CashFlowCard from '@/components/przeplywy/finora/chart-cash-flow';
import { KpirFinanceCard, type KpirFinanceCardProps } from '@/components/przeplywy/finora/chart-finance';
import VatSummaryCard, { type VatSummaryCardProps } from '@/components/przeplywy/finora/chart-net-worth';
import TransactionDatatable from '@/components/przeplywy/finora/datatable-transaction';
import StatisticsAreaStatCard from '@/components/przeplywy/finora/statistics-area-stat-card';
import StatisticsAssetsLiabilities from '@/components/przeplywy/finora/statistics-assets-liabilities';
import StatisticsLiquiditySnapshot from '@/components/przeplywy/finora/statistics-liquidity-snapshot';
import { TaxSavingsGoalCard, VatLimitGoalCard, type VatLimitGoalCardProps } from '@/components/przeplywy/finora/statistics-savings-goal-card';
import TopCashFlowSourcesCard from '@/components/przeplywy/finora/widget-top-cash-flow-sources';
import UpcomingBillsCard, { dueInLabel, UPCOMING_EMPTY } from '@/components/przeplywy/finora/widget-upcoming-bills';
import RecentActivityCard from '@/components/przeplywy/finora/widget-recent-activity';
import { signedAmount } from '@/components/przeplywy/finora/operation-amount';
import type { CashFlowChartData, CashFlowOperation, FlowBucket, MonthFlow } from '@/lib/dashboard/cash-movements';
import { formatPlMoney } from '@/lib/format/pl';
import { PAID_EMPTY_STATE } from '@/lib/invoices/paid-labels';
import { tekstBezZnacznikow } from './helpers/tekst-html';

/**
 * Karty `/przeplywy` (plan Finora P2, etap E5) — każda w stanie z danymi
 * i pustym (§9 „Każdy PR etapu”, pkt 1). Bez danych przykładowych Finory:
 * żadnych kwot w dolarach ani awatarów ludzi.
 */

/** SSR wstawia <!-- --> między sąsiednie węzły tekstowe — usuwamy je. */
function html(node: ReactElement): string {
  return renderToStaticMarkup(node).replace(/<!-- -->/g, '');
}

function noTemplateData(out: string) {
  expect(out).not.toMatch(/\$[0-9]/);
  expect(out).not.toContain('images/avatars');
  expect(out).not.toMatch(/\b(Inflow|Outflow|Savings|Upcoming|Recent Activity|Counterparty|Showing)\b/);
}

const zl = (n: number) => `${formatPlMoney(n)} zł`;

// ─── Wpływy i wydatki ─────────────────────────────────────────────────────

const bucket = (key: string, inflow: number, outflow: number, inflowCount = inflow > 0 ? 1 : 0): FlowBucket => ({
  key, label: key, period: `okres ${key}`, inflow, outflow, inflowCount,
});

describe('CashFlowCard (Wpływy i wydatki)', () => {
  const data: CashFlowChartData = {
    week: [bucket('w1', 0, 0), bucket('w2', 100, 20)],
    month: [bucket('m1', 12_000, 3_000), bucket('m2', 8_000, 1_500.5)],
    year: [bucket('2026', 20_000, 4_500.5)],
  };

  it('stan z danymi: nagłówki, przełącznik, sumy widoku miesięcznego', () => {
    const out = html(<CashFlowCard data={data} />);
    expect(out).toContain('Wpływy i wydatki');
    expect(out).toContain('Wpłynęło');
    expect(out).toContain('Wydano');
    for (const tab of ['Tydzień', 'Miesiąc', 'Rok']) expect(out).toContain(`>${tab}<`);
    expect(out).toContain(`title="${zl(20_000)}"`);
    expect(out).toContain(`title="${zl(4_500.5)}"`);
    noTemplateData(out);
  });

  it('miesiąc bez oznaczonych wpłat: „—” i podpowiedź, nie „0 zł”', () => {
    const out = html(<CashFlowCard data={{ ...data, month: [bucket('m1', 0, 500)] }} />);
    expect(out).toContain('>—<');
    expect(out).toContain(PAID_EMPTY_STATE);
  });

  it('pusty stan: bez ruchów nie ma wykresu z osiami', () => {
    const empty = { week: [bucket('w', 0, 0)], month: [bucket('m', 0, 0)], year: [bucket('2026', 0, 0)] };
    const out = html(<CashFlowCard data={empty} />);
    expect(out).toContain(PAID_EMPTY_STATE);
    expect(out).not.toContain('data-slot="chart"');
  });
});

// ─── Pierścień ────────────────────────────────────────────────────────────

describe('TaxSavingsGoalCard (Odłóż na podatek)', () => {
  it('kwota, zastrzeżenia, bez procentu', () => {
    const out = html(
      <TaxSavingsGoalCard estimate={{ amount: 4560.5, label: 'Szac. podatek od 1 stycznia', subtitle: '19% liniowy', fullYear: true }} />,
    );
    expect(out).toContain('Odłóż na podatek');
    expect(out).toContain('Szac. podatek od 1 stycznia');
    expect(out).toContain(`${zl(4560.5)} · 19% liniowy`);
    expect(out).not.toMatch(/>\d+%</);
    noTemplateData(out);
  });

  it('zero do odłożenia (strata) to fakt, nie pusty stan', () => {
    const out = html(<TaxSavingsGoalCard estimate={{ amount: 0, label: 'Szac. podatek od 1 stycznia', subtitle: '19% liniowy', fullYear: true }} />);
    expect(out).toContain(zl(0));
  });
});

describe('VatLimitGoalCard (Limit zwolnienia z VAT)', () => {
  const base: VatLimitGoalCardProps = {
    cumulative: [50_000, 120_000],
    used: 120_000,
    annualLimit: 240_000,
    startedOn: '2025-03-01',
    limit: {
      effectiveLimit: 240_000, prorated: false, activeDays: 365, daysInYear: 365, pct: 50, remaining: 120_000,
      level: 'ok', formula: '240 000 zł', crossesOn: '2026-12-14',
    },
    lowerBound: null,
  };

  it('procent, kwoty, prognoza, zastrzeżenie i dopisek o podatku dochodowym', () => {
    const out = html(
      <VatLimitGoalCard
        {...base}
        taxEstimate={{ amount: 1900, label: 'Szac. podatek od 1 stycznia', subtitle: '19% liniowy', fullYear: true }}
      />,
    );
    expect(out).toContain('Limit zwolnienia z VAT');
    expect(out).toContain(`${zl(120_000)} z ${zl(240_000)}`);
    expect(out).toContain('Przy obecnym tempie limit skończy się ok. 14.12.2026');
    expect(out).toContain('dolicz sam');
    expect(out).toContain(`Szac. podatek od 1 stycznia: ${zl(1900)} · 19% liniowy`);
    noTemplateData(out);
  });

  it('przekroczenie: komunikat w kolorze destructive', () => {
    const out = html(
      <VatLimitGoalCard {...base} used={250_000} cumulative={[250_000]} limit={{ ...base.limit!, pct: 104.1, remaining: 0, level: 100 }} />,
    );
    expect(out).toMatch(/text-destructive[^>]*>Limit przekroczony/);
  });

  it('limit proporcjonalny: data rozpoczęcia w podpisie', () => {
    const out = html(<VatLimitGoalCard {...base} startedOn="2026-07-01" limit={{ ...base.limit!, prorated: true }} />);
    expect(out).toContain('limit proporcjonalny: działalność od 01.07.2026');
  });

  it('bez daty rozpoczęcia: dolna granica i link do ustawień', () => {
    const out = html(
      <VatLimitGoalCard {...base} startedOn={null} limit={null} lowerBound={{ pct: 85.2, level: 80, remaining: 35_520 }} />,
    );
    expect(out).toContain('Co najmniej 85% pełnego limitu');
    expect(out).toContain('href="/settings#data-rozpoczecia"');
    expect(out).toContain('Podaj datę rozpoczęcia działalności');
  });

  it('pusty stan: bez sprzedaży nie ma pierścienia', () => {
    const out = html(<VatLimitGoalCard {...base} cumulative={[0, 0]} used={0} />);
    expect(out).toContain(PULPIT_EMPTY.noInvoices);
    expect(out).toContain('href="/invoices/new"');
    expect(out).not.toContain('data-slot="chart"');
  });
});

// ─── Kafle miesiąca ───────────────────────────────────────────────────────

const flow = (fields: Partial<MonthFlow> = {}): MonthFlow => ({
  amount: 34_600, prevAmount: 30_000, count: 3, changePct: 15.33,
  daily: [{ date: '2026-10-01', value: 0 }, { date: '2026-10-02', value: 34_600 }],
  ...fields,
});

describe('StatisticsAreaStatCard (Wpłynęło / Wydano w tym miesiącu)', () => {
  it('kwota z pełnym tytułem, zmiana zielona przy wzroście', () => {
    const out = html(<StatisticsAreaStatCard chartKey="income" title="Wpłynęło w tym miesiącu" flow={flow()} color="var(--chart-4)" note="według oznaczonych wpłat" />);
    expect(out).toContain('Wpłynęło w tym miesiącu');
    expect(out).toContain(`title="${zl(34_600)}"`);
    expect(out).toContain('według oznaczonych wpłat');
    expect(out).toMatch(/text-green-800[^>]*>\+15%/);
    expect(out).toContain('vs poprzedni miesiąc');
    noTemplateData(out);
  });

  it('spadek czerwony; bez poprzedniego miesiąca — bez procentu', () => {
    expect(html(<StatisticsAreaStatCard chartKey="e" title="Wydano" flow={flow({ changePct: -8.4 })} color="x" />))
      .toMatch(/text-destructive[^>]*>−8%/);
    const out = html(<StatisticsAreaStatCard chartKey="e" title="Wydano" flow={flow({ changePct: null })} color="x" />);
    expect(out).toContain('Brak danych z poprzedniego miesiąca');
    expect(out).not.toMatch(/[+−]?\d+%</);
  });

  it('pusty stan wpływów: tekst i link zamiast „0 zł”', () => {
    const out = html(
      <StatisticsAreaStatCard
        chartKey="income"
        title="Wpłynęło w tym miesiącu"
        flow={flow({ amount: 0, count: 0 })}
        color="x"
        empty={{ message: PAID_EMPTY_STATE, href: '/invoices', linkLabel: 'Przejdź do faktur' }}
      />,
    );
    expect(out).toContain(PAID_EMPTY_STATE);
    expect(out).toContain('href="/invoices"');
    expect(out).not.toContain(zl(0));
    expect(out).not.toContain('0 zł');
  });
});

// ─── Listy ────────────────────────────────────────────────────────────────

describe('TopCashFlowSourcesCard', () => {
  it('klient z plusem na zielono, dostawca z minusem, udział jako pasek', () => {
    const out = html(
      <TopCashFlowSourcesCard
        title="Skąd i dokąd płyną pieniądze"
        subTitle="Ostatnie 12 miesięcy"
        sources={[
          { key: 'in:nip:1', name: 'Alfa sp. z o.o.', direction: 'in', consumers: false, nip: '1234567890', amount: 18_204, count: 3, share: 70 },
          { key: 'out:nip:2', name: 'Biuro S.A.', direction: 'out', consumers: false, nip: null, amount: 1_850, count: 1, share: 46 },
          { key: 'in:b2c', name: 'Konsumenci', direction: 'in', consumers: true, nip: null, amount: 100, count: 1, share: 1 },
        ]}
      />,
    );
    expect(out).toContain('Skąd i dokąd płyną pieniądze');
    expect(out).toContain('Ostatnie 12 miesięcy');
    expect(out).toMatch(/text-green-700[^>]*>\+18\s?204,00 zł/);
    expect(out).toMatch(/text-destructive[^>]*>−1850,00 zł/);
    expect(out).toContain('Klient · NIP 1234567890');
    expect(out).toContain('Dostawca');
    expect(out).toContain('Klienci indywidualni');
    expect(out).toContain('aria-label="Udział: 70%"');
    noTemplateData(out);
  });

  it('pusty stan', () => {
    expect(html(<TopCashFlowSourcesCard title="Skąd i dokąd płyną pieniądze" sources={[]} />)).toContain(PAID_EMPTY_STATE);
  });
});

describe('UpcomingBillsCard (Spodziewane wpływy)', () => {
  it('termin słownie, kwota do zapłaty, link do faktury, podpis należności', () => {
    const out = html(
      <UpcomingBillsCard
        title="Spodziewane wpływy"
        subTitle="Najbliższe 30 dni"
        bills={[
          { id: 'a', name: 'Gamma S.A.', internalNumber: 'FV/1/2026', dueDate: '2026-10-20', daysLeft: 0, amount: 1230 },
          { id: 'b', name: 'Delta', internalNumber: null, dueDate: '2026-10-25', daysLeft: 5, amount: 99.9 },
        ]}
        count={7}
        note="Bez importów i faktur skorygowanych"
      />,
    );
    expect(out).toContain('Najbliższe 30 dni');
    expect(out).toContain('Termin dziś · FV/1/2026');
    expect(out).toContain('Termin za 5 dni');
    expect(out).toContain(zl(1230));
    expect(out).toContain('href="/invoices/a"');
    expect(out).toContain('Pokazano 2 z 7 · Bez importów i faktur skorygowanych');
    noTemplateData(out);
  });

  it('liczebniki terminu', () => {
    expect(dueInLabel(1)).toBe('Termin jutro');
    expect(dueInLabel(2)).toBe('Termin za 2 dni');
    expect(dueInLabel(22)).toBe('Termin za 22 dni');
  });

  it('pusty stan', () => {
    const out = html(<UpcomingBillsCard title="Spodziewane wpływy" subTitle="Najbliższe 30 dni" bills={[]} count={0} note="x" />);
    expect(out).toContain(UPCOMING_EMPTY);
  });
});

const operation = (fields: Partial<CashFlowOperation> = {}): CashFlowOperation => ({
  id: 'in:a', direction: 'in', date: '2026-10-12', counterparty: 'Alfa sp. z o.o.', nip: '1', reference: 'FV/1',
  category: 'Sprzedaż', status: 'paid', amount: 3200, href: '/invoices/a', ...fields,
});

describe('RecentActivityCard (Ostatnie operacje)', () => {
  it('wpłata z plusem, wydatek z minusem, data po polsku', () => {
    const out = html(
      <RecentActivityCard
        title="Ostatnie operacje"
        activity={[operation(), operation({ id: 'out:b', direction: 'out', counterparty: 'Biuro', amount: 1850, href: '/expenses/b', status: 'reviewed' })]}
      />,
    );
    expect(out).toContain('Wpłata · 12.10.2026');
    expect(out).toContain(`+${zl(3200)}`);
    expect(out).toContain(`−${zl(1850)}`);
    expect(out).toContain('href="/expenses/b"');
    noTemplateData(out);
  });

  it('znak kwoty: korekta kosztu in minus to pieniądze z powrotem', () => {
    expect(signedAmount({ direction: 'out', amount: -20 })).toBe(`+${zl(20)}`);
  });

  it('pusty stan', () => {
    expect(html(<RecentActivityCard title="Ostatnie operacje" activity={[]} />)).toContain(PAID_EMPTY_STATE);
  });
});

describe('TransactionDatatable (Wszystkie operacje)', () => {
  const rows = Array.from({ length: 7 }, (_, i) =>
    operation({ id: `in:${i}`, counterparty: `Klient ${i}`, href: `/invoices/${i}` }));

  it('filtry, kolumny po polsku, paginacja po pięć, karty poniżej lg', () => {
    const out = html(<TransactionDatatable data={[...rows, operation({ id: 'out:x', direction: 'out', status: 'pending', category: 'Paliwo', counterparty: 'Stacja' })]} />);
    expect(out).toContain('Wszystkie operacje');
    expect(out).toContain('Ostatnie 12 miesięcy');
    for (const header of ['Kontrahent', 'Kategoria', 'Kwota', 'Status', 'Akcje']) expect(out).toContain(header);
    expect(tekstBezZnacznikow(out)).toContain('Pozycje 1–5 z 8');
    expect(out).toContain('Poprzednia');
    expect(out).toContain('Następna');
    expect(out).toContain('Opłacona');
    expect(out).toContain('hidden lg:block');
    expect(out).toContain('lg:hidden');
    expect(out).not.toContain('Stacja'); // szósty i dalsze wiersze na kolejnej stronie
    noTemplateData(out);
  });

  it('nagłówki sortowania: rola przycisku i aria-sort na komórce (WCAG 4.1.2)', () => {
    const out = html(<TransactionDatatable data={rows} />);
    const sortable = out.match(/<th[^>]*aria-sort="none"[^>]*>\s*<div[^>]*role="button"[^>]*tabindex="0"/g) ?? [];
    expect(sortable.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/<div(?![^>]*role="button")[^>]*tabindex="0"/);
  });

  it('pusty stan', () => {
    const out = html(<TransactionDatatable data={[]} />);
    expect(out).toContain('Brak wyników.');
    expect(out).toContain('Brak pozycji');
  });
});

// ─── Rząd z Net Worth ─────────────────────────────────────────────────────

describe('StatisticsAssetsLiabilities (Należności)', () => {
  it('przed i po terminie, podpis', () => {
    const out = html(<StatisticsAssetsLiabilities notDue={7500} overdue={2500} count={4} overdueCount={1} note="Bez importów i faktur skorygowanych" />);
    expect(out).toContain('Należności');
    expect(out).toContain('Przed terminem / po terminie');
    expect(out).toContain('width:75%');
    expect(out).toContain(`Przed terminem: ${zl(7500)} (3 faktury)`);
    expect(out).toContain(`Po terminie: ${zl(2500)} (1 faktura)`);
    expect(out).toContain('Bez importów i faktur skorygowanych');
    noTemplateData(out);
  });

  it('pusty stan', () => {
    const out = html(<StatisticsAssetsLiabilities notDue={0} overdue={0} count={0} overdueCount={0} note="x" />);
    expect(out).toContain('Brak otwartych należności');
    expect(out).not.toContain('width:');
  });
});

describe('StatisticsLiquiditySnapshot (Zaległości)', () => {
  it('procent po terminie, kwota, najstarsza zaległość', () => {
    const out = html(<StatisticsLiquiditySnapshot overdue={2500} total={10_000} oldestOverdueDays={1} note="Bez importów i faktur skorygowanych" />);
    expect(out).toContain('Bez importów i faktur skorygowanych');
    expect(out).toContain('Po terminie: 25% należności');
    expect(out).toContain('>25%<');
    expect(out).toContain(`title="${zl(2500)}"`);
    expect(out).toContain('Najstarsza: 1 dzień po terminie');
    expect(out).toContain('href="/payments/overdue"');
  });

  it('zero należności: pusty stan, nie „0%”', () => {
    const out = html(<StatisticsLiquiditySnapshot overdue={0} total={0} oldestOverdueDays={null} note="Bez importów i faktur skorygowanych" />);
    expect(out).toContain('Brak otwartych należności');
    expect(out).toContain('Bez importów i faktur skorygowanych');
    expect(out).not.toContain('0%');
  });
});

describe('VatSummaryCard (Podsumowanie podatku VAT)', () => {
  const props: VatSummaryCardProps = {
    monthName: 'październik 2026',
    totalNet: 10_000,
    totalVat: 2_300,
    totalGross: 12_300,
    vatDueLabel: '25.11.2026',
    daysToVatDue: 36,
    acceptedCount: 5,
    prevAcceptedCount: 3,
    hasPrevMonth: true,
    draftCount: 2,
    momGrossPct: 12,
    isBestMonthOfYear: false,
    sales: {
      months: [{ key: '2026-09', label: 'Wrz' }, { key: '2026-10', label: 'Paź' }],
      currentSeries: [8_000, 12_300],
      prevSeries: [5_000, 0],
      currentMonthKey: '2026-10',
      year: 2026,
    },
  };

  it('treść dawnego VatSummaryCard + liczby miesiąca i podpis wykresu sprzedaży', () => {
    const out = html(<VatSummaryCard {...props} />);
    expect(out).toContain('Podsumowanie podatku VAT');
    expect(out).toContain('październik 2026 · faktury przyjęte w bieżącym środowisku KSeF');
    expect(out).toContain('Eksport PDF');
    expect(out).toContain('href="/reports/exports"');
    for (const label of ['Netto', 'VAT należny', 'Brutto']) expect(out).toContain(label);
    expect(out).toContain(zl(10_000));
    expect(out).toContain(zl(2_300));
    expect(out).toContain(zl(12_300));
    expect(out).toContain('Termin płatności VAT: 25.11.2026 — pozostało 36 dni');
    expect(out).toContain('5 faktur');
    expect(out).toContain('(poprzedni miesiąc: 3)');
    expect(out).toContain('Szkice lokalne bez przypisanego środowiska:');
    expect(out).toContain('+12% m/m');
    expect(out).toContain('Sprzedaż brutto w ostatnich 6 miesiącach');
    expect(out).toContain('>2026<');
    expect(out).toContain('2025');
    noTemplateData(out);
  });

  it('jeden dzień do terminu, najlepszy miesiąc, brak poprzedniego', () => {
    const out = html(<VatSummaryCard {...props} daysToVatDue={1} isBestMonthOfYear hasPrevMonth={false} />);
    expect(out).toContain('pozostało 1 dzień');
    expect(out).toContain('najlepszy wynik w roku');
    expect(out).toContain('(brak przyjętych w poprzednim miesiącu)');
  });

  it('bez sprzedaży w 6 miesiącach i rok wcześniej: pusty stan zamiast wykresu', () => {
    const out = html(<VatSummaryCard {...props} sales={{ ...props.sales, currentSeries: [0, 0], prevSeries: [0, 0] }} />);
    expect(out).toContain(PULPIT_EMPTY.noInvoices);
    expect(out).not.toContain('data-slot="chart"');
  });

  it('bez sprzedaży w 6 miesiącach, ale rok wcześniej była: wykres z linią roku poprzedniego i dopisek', () => {
    const out = html(<VatSummaryCard {...props} sales={{ ...props.sales, currentSeries: [0, 0] }} />);
    expect(out).not.toContain(PULPIT_EMPTY.noInvoices);
    expect(out).toContain('data-slot="chart"');
    expect(out).toContain('Brak przyjętych faktur w tym okresie');
    expect(out).toContain('Wykres sprzedaży brutto ostatnich 6 miesięcy na tle roku 2025');
  });
});

describe('KpirFinanceCard (Przychody i koszty / Ten miesiąc)', () => {
  const base: KpirFinanceCardProps = {
    months: Array.from({ length: 6 }, (_, i) => ({ key: `2026-0${i + 5}`, label: `M${i + 1}`, longLabel: `m${i + 1} 2026` })),
    revenue: [1000, 2000, 3000, 4000, 5000, 6000],
    costs: [100, 200, 300, 400, 500, 1500.55],
    profit: [900, 1800, 2700, 3600, 4500, 4499.45],
    report: { revenue: 6000, costs: 1500.55, profit: 4499.45, monthlyAverageNet: 3000 },
    revenueChangePct: 20,
    costsHint: 'none',
  };

  it('stan z danymi: liczby miesiąca, zmiana, średnia, link do KPiR', () => {
    const out = html(<KpirFinanceCard {...base} />);
    expect(out).toContain('Przychody i koszty');
    expect(out).toContain('Ostatnie 6 miesięcy');
    expect(out).toContain('Ten miesiąc');
    expect(out).toContain(`Średnio miesięcznie: ${zl(3000)}`);
    expect(out).toMatch(new RegExp(`data-figure="profit"[^>]*>${zl(4499.45)}<`));
    expect(out).toMatch(new RegExp(`data-figure="revenue"[^>]*>${zl(6000)}<`));
    expect(out).toMatch(new RegExp(`data-figure="costs"[^>]*>${zl(1500.55)}<`));
    expect(out).toMatch(/text-green-700[^>]*>\+20% vs poprzedni miesiąc/);
    expect(out).toMatch(/<a[^>]*href="\/reports\/kpir"[^>]*>Zobacz KPiR<\/a>/);
    expect(out).not.toContain('href="/przeplywy"');
    noTemplateData(out);
  });

  it('strata: „Strata” bez minusa, kolor destructive', () => {
    const out = html(<KpirFinanceCard {...base} report={{ ...base.report, profit: -250.1 }} />);
    expect(out).toContain('>Strata<');
    expect(out).toMatch(/text-destructive[^>]*data-figure="profit"[^>]*>250,10 zł</);
  });

  it('jeden miesiąc z wartością: liczby bez wykresu, z dochodem', () => {
    const single = [0, 0, 0, 0, 0, 5000];
    const out = html(<KpirFinanceCard {...base} revenue={single} costs={[0, 0, 0, 0, 0, 1000]} profit={[0, 0, 0, 0, 0, 4000]} />);
    expect(out).toContain('Przychody netto · m6 2026');
    expect(out).toContain('Dochód · m6 2026');
    expect(out).toContain(`title="${zl(4000)}"`);
    expect(out).toContain(PULPIT_EMPTY.trendAfterSecondMonth);
  });

  it('pusty stan i podpowiedź KSeF', () => {
    const zeros = [0, 0, 0, 0, 0, 0];
    const out = html(
      <KpirFinanceCard
        {...base}
        revenue={zeros}
        costs={zeros}
        profit={zeros}
        report={{ revenue: 0, costs: 0, profit: 0, monthlyAverageNet: null }}
        revenueChangePct={null}
        costsHint="connect-ksef"
      />,
    );
    expect(out).toContain(PULPIT_EMPTY.noInvoices);
    expect(out).toContain(PULPIT_EMPTY.connectKsef);
    expect(out).toContain('Średnia pojawi się po pierwszym pełnym miesiącu');
    expect(out).not.toContain('vs poprzedni miesiąc');
  });
});
