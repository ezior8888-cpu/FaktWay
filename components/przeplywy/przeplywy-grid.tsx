import { cache, Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import { RiArrowRightLine, RiErrorWarningLine } from '@remixicon/react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent } from '@/components/ui/card';
import { PulpitCardHeader } from '@/components/dashboard/pulpit/card-header';
import { PulpitCardSkeleton } from '@/components/dashboard/pulpit/card-states';
import { PULPIT_GENERIC_ERROR, pulpitErrorMessage } from '@/components/dashboard/pulpit/pulpit-grid';
import { SectionErrorBoundary } from '@/components/dashboard/section-error-boundary';
import { getDashboardActiveOrgVerified } from '@/lib/dashboard-shell-data';
import { countPendingReview, getCashFlowData } from '@/lib/dashboard/cash-flow';
import {
  buildCashFlowChart,
  cashFlowOperations,
  monthFlows,
  nextMonthStart,
  topCashFlowSources,
  upcomingInflows,
  yearsWindowStart,
} from '@/lib/dashboard/cash-movements';
import { getCosts } from '@/lib/dashboard/costs';
import { getInflows } from '@/lib/dashboard/inflows';
import { getMonthlyFigures, getSalesSeries } from '@/lib/dashboard/monthly-figures';
import { warsawMonthWindow } from '@/lib/dashboard/rankings';
import { getReceivables, RECEIVABLES_NOTE } from '@/lib/dashboard/receivables';
import { getVatLimit } from '@/lib/dashboard/vat-limit';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { plural } from '@/lib/i18n/plural';
import { PAID_EMPTY_STATE, PAID_NOTE } from '@/lib/invoices/paid-labels';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import type { PageContext } from '@/lib/supabase/page-context';
import { cn } from '@/lib/utils';

import CashFlowCard from './finora/chart-cash-flow';
import { KpirFinanceCard } from './finora/chart-finance';
import VatSummaryCard from './finora/chart-net-worth';
import TransactionDatatable from './finora/datatable-transaction';
import StatisticsAreaStatCard from './finora/statistics-area-stat-card';
import StatisticsAssetsLiabilities from './finora/statistics-assets-liabilities';
import StatisticsLiquiditySnapshot from './finora/statistics-liquidity-snapshot';
import { TaxSavingsGoalCard, VatLimitGoalCard } from './finora/statistics-savings-goal-card';
import TopCashFlowSourcesCard from './finora/widget-top-cash-flow-sources';
import UpcomingBillsCard from './finora/widget-upcoming-bills';
import RecentActivityCard from './finora/widget-recent-activity';

/**
 * Siatka `/przeplywy` (plan Finora P2 ← Finora `dashboard/cash-flow/page.tsx`
 * + pierwszy rząd `dashboard/net-worth/page.tsx`). Każda karta to osobny
 * asynchroniczny Server Component w `<Suspense>` + `SectionErrorBoundary`
 * (§2.4 pkt 15): strażnik, który rzuci (faktura w EUR, przyjęta faktura bez
 * środowiska, niepełna strona), zabiera JEDNĄ kartę z treścią wyjątku.
 * Strona nie woła na swoim poziomie żadnej funkcji z §2.4.
 *
 * Karty z tymi samymi danymi biorą je przez `cache()` — jedno zapytanie na
 * żądanie. Wpłaty i koszty mają osobne ładowarki: kafel „Wpłynęło” czeka
 * tylko na wpłaty, „Wydano” tylko na koszty, więc strażnik jednego źródła
 * nie zabiera kafla drugiego. Karty łączące oba źródła (wykres, „Skąd
 * i dokąd”, operacje) padają przez każde z nich. Wykres „Wpływy i wydatki”
 * czyta pięć lat (widok „Rok”), reszta kart ruchów — 12 miesięcy: stary
 * koszt w walucie obcej zatrzymuje wtedy tylko wykres i karty łączone.
 */

export interface PrzeplywyCardProps {
  supabase: PageContext['supabase'];
  tenantId: string;
  /** Chwila żądania jako ISO — jeden „teraz” dla wszystkich kart. */
  nowIso: string;
}

type WithClass = PrzeplywyCardProps & { className?: string };

/** Ostatnie 12 miesięcy: listy, kafle miesiąca, źródła. */
const RECENT_MONTHS = 12;

const loadCashFlowData = cache((supabase: PageContext['supabase'], tenantId: string, nowIso: string) =>
  getCashFlowData(supabase, tenantId, new Date(nowIso)));

type Span = 'recent' | 'years';

function movementsRange(nowIso: string, span: Span) {
  const now = new Date(nowIso);
  const today = todayInWarsaw(now);
  return span === 'years'
    ? { from: yearsWindowStart(today), toExclusive: nextMonthStart(today) }
    : warsawMonthWindow(now, RECENT_MONTHS);
}

/** Wpłaty — osobno od kosztów, żeby strażnik kosztów nie zabierał kafla wpływów. */
const loadInflows = cache((supabase: PageContext['supabase'], tenantId: string, nowIso: string, span: Span) =>
  getInflows(supabase, tenantId, movementsRange(nowIso, span)));

/** Koszty — osobno od wpłat, żeby strażnik wpłat nie zabierał kafla wydatków. */
const loadCosts = cache((supabase: PageContext['supabase'], tenantId: string, nowIso: string, span: Span) =>
  getCosts(supabase, tenantId, movementsRange(nowIso, span)));

/** Karty łączące oba źródła (wykres, źródła, operacje) — czekają na obie ładowarki. */
async function loadMovements(supabase: PageContext['supabase'], tenantId: string, nowIso: string, span: Span) {
  const [inflows, costs] = await Promise.all([
    loadInflows(supabase, tenantId, nowIso, span),
    loadCosts(supabase, tenantId, nowIso, span),
  ]);
  return { inflows, costs, today: todayInWarsaw(new Date(nowIso)) };
}

const loadReceivables = cache((supabase: PageContext['supabase'], tenantId: string, nowIso: string) =>
  getReceivables(supabase, tenantId, new Date(nowIso)));

const loadMonthlyFigures = cache((supabase: PageContext['supabase'], tenantId: string, nowIso: string) =>
  getMonthlyFigures(supabase, tenantId, new Date(nowIso)));

const loadExemption = cache((supabase: PageContext['supabase'], tenantId: string) =>
  readTenantVatExemption(supabase, tenantId));

/** Adres pomocy — wyjście z karty zatrzymanej przez strażnika (protokół napraw pkt 4). */
const HELP_EMAIL = 'pomoc@faktway.pl';

/** Karta błędu jednej karty: tytuł, treść wyjątku i wyjście (napisz do nas). */
export function PrzeplywyCardError({
  title,
  message,
  className,
}: {
  title: string;
  message: string;
  className?: string;
}) {
  return (
    <Card className={cn('shadow-none', className)} role="status">
      <PulpitCardHeader title={title} />
      <CardContent className="space-y-2">
        <p className="text-muted-foreground text-sm">{message}</p>
        <p className="text-muted-foreground text-sm">
          Pozostałe karty działają. Jeśli komunikat nie znika, napisz do nas:{' '}
          <a href={`mailto:${HELP_EMAIL}`} className="text-primary underline-offset-4 hover:underline">
            {HELP_EMAIL}
          </a>
        </p>
      </CardContent>
    </Card>
  );
}

/** Ładowarka karty: dane albo karta błędu z treścią wyjątku (filtr `pulpitErrorMessage`). */
async function loadCard(title: string, className: string | undefined, render: () => Promise<ReactNode>) {
  try {
    return await render();
  } catch (error) {
    const message = pulpitErrorMessage(error);
    if (message === PULPIT_GENERIC_ERROR) console.error(`[przeplywy] karta „${title}”:`, error);
    return <PrzeplywyCardError title={title} message={message} className={className} />;
  }
}

// ─── Karty ────────────────────────────────────────────────────────────────

export async function KpirFinanceSlotCard({ supabase, tenantId, nowIso, className }: WithClass) {
  return loadCard('Przychody i koszty', className, async () => {
    const [data, verified] = await Promise.all([
      loadCashFlowData(supabase, tenantId, nowIso),
      getDashboardActiveOrgVerified(),
    ]);
    return (
      <KpirFinanceCard
        months={data.months}
        revenue={data.revenue}
        costs={data.costs}
        profit={data.profit}
        report={data.report}
        revenueChangePct={data.revenueChangePct}
        costsHint={!verified && data.costs.every((c) => c === 0) ? 'connect-ksef' : 'none'}
        className={className}
      />
    );
  });
}

export async function CashFlowSlotCard({ supabase, tenantId, nowIso, className }: WithClass) {
  return loadCard('Wpływy i wydatki', className, async () => {
    const { inflows, costs, today } = await loadMovements(supabase, tenantId, nowIso, 'years');
    return <CashFlowCard data={buildCashFlowChart(inflows, costs, today)} className={className} />;
  });
}

/**
 * Pierścień z „Savings goal”: firma zwolniona podmiotowo widzi „Limit
 * zwolnienia z VAT” (`getVatLimit`), płatnik VAT — „Odłóż na podatek”
 * (`estimateIncomeTaxThisYear` z `getCashFlowData`).
 */
export async function GoalSlotCard({ supabase, tenantId, nowIso, className }: WithClass) {
  let exemption: string | null;
  try {
    exemption = await loadExemption(supabase, tenantId);
  } catch (error) {
    return <PrzeplywyCardError title="Odłóż na podatek" message={pulpitErrorMessage(error)} className={className} />;
  }
  if (isSubjectiveVatExemption(exemption)) {
    return loadCard('Limit zwolnienia z VAT', className, async () => {
      const overview = await getVatLimit(supabase, tenantId, new Date(nowIso));
      // Szacunek podatku to dopisek — jego awaria nie zabiera licznika limitu.
      const taxEstimate = await loadCashFlowData(supabase, tenantId, nowIso)
        .then((data) => data.taxEstimate)
        .catch(() => null);
      return <VatLimitGoalCard {...overview} taxEstimate={taxEstimate} className={className} />;
    });
  }
  return loadCard('Odłóż na podatek', className, async () => {
    const data = await loadCashFlowData(supabase, tenantId, nowIso);
    return <TaxSavingsGoalCard estimate={data.taxEstimate} className={className} />;
  });
}

export async function InflowMonthSlotCard({ supabase, tenantId, nowIso, className }: WithClass) {
  return loadCard('Wpłynęło w tym miesiącu', className, async () => {
    const inflows = await loadInflows(supabase, tenantId, nowIso, 'recent');
    const flow = monthFlows(inflows, [], todayInWarsaw(new Date(nowIso))).inflow;
    return (
      <StatisticsAreaStatCard
        chartKey="income"
        title="Wpłynęło w tym miesiącu"
        flow={flow}
        color="var(--chart-4)"
        note={PAID_NOTE}
        empty={
          flow.count === 0
            ? { message: PAID_EMPTY_STATE, href: '/invoices', linkLabel: 'Przejdź do faktur' }
            : null
        }
        className={className}
      />
    );
  });
}

export async function OutflowMonthSlotCard({ supabase, tenantId, nowIso, className }: WithClass) {
  return loadCard('Wydano w tym miesiącu', className, async () => {
    const [costs, verified] = await Promise.all([
      loadCosts(supabase, tenantId, nowIso, 'recent'),
      getDashboardActiveOrgVerified(),
    ]);
    const flow = monthFlows([], costs, todayInWarsaw(new Date(nowIso))).outflow;
    return (
      <StatisticsAreaStatCard
        chartKey="expense"
        title="Wydano w tym miesiącu"
        flow={flow}
        color="var(--chart-4)"
        note="brutto, według daty dokumentu"
        empty={
          !verified && costs.length === 0
            ? {
                message: 'Podłącz KSeF, a faktury kosztowe pobierzemy same',
                href: '/settings/ksef',
                linkLabel: 'Podłącz KSeF',
              }
            : null
        }
        className={className}
      />
    );
  });
}

export async function SourcesSlotCard({ supabase, tenantId, nowIso, className }: WithClass) {
  return loadCard('Skąd i dokąd płyną pieniądze', className, async () => {
    const { inflows, costs, today } = await loadMovements(supabase, tenantId, nowIso, 'recent');
    return (
      <TopCashFlowSourcesCard
        title="Skąd i dokąd płyną pieniądze"
        subTitle="Ostatnie 12 miesięcy"
        sources={topCashFlowSources(inflows, costs, today)}
        className={className}
      />
    );
  });
}

export async function UpcomingSlotCard({ supabase, tenantId, nowIso, className }: WithClass) {
  return loadCard('Spodziewane wpływy', className, async () => {
    // Spodziewane wpływy to otwarte faktury z terminem od dziś z `getInflows` (wspólna reguła kart Finory).
    const today = todayInWarsaw(new Date(nowIso));
    const upcoming = upcomingInflows(await getInflows(supabase, tenantId, { from: today }), today);
    return (
      <UpcomingBillsCard
        title="Spodziewane wpływy"
        subTitle="Najbliższe 30 dni"
        bills={upcoming.items}
        count={upcoming.count}
        note={RECEIVABLES_NOTE}
        className={className}
      />
    );
  });
}

export async function RecentSlotCard({ supabase, tenantId, nowIso, className }: WithClass) {
  return loadCard('Ostatnie operacje', className, async () => {
    const { inflows, costs, today } = await loadMovements(supabase, tenantId, nowIso, 'recent');
    return (
      <RecentActivityCard
        title="Ostatnie operacje"
        activity={cashFlowOperations(inflows, costs, today).slice(0, 5)}
        className={className}
      />
    );
  });
}

export async function VatSummarySlotCard({ supabase, tenantId, nowIso, className }: WithClass) {
  return loadCard('Podsumowanie podatku VAT', className, async () => {
    const [figures, series] = await Promise.all([
      loadMonthlyFigures(supabase, tenantId, nowIso),
      getSalesSeries(supabase, tenantId, new Date(nowIso)),
    ]);
    return (
      <VatSummaryCard
        monthName={figures.monthName}
        totalNet={figures.totalNet}
        totalVat={figures.totalVat}
        totalGross={figures.totalGross}
        vatDueLabel={figures.vatDueLabel}
        daysToVatDue={figures.daysToVatDue}
        acceptedCount={figures.acceptedCount}
        prevAcceptedCount={figures.prevAcceptedCount}
        hasPrevMonth={figures.hasPrevMonth}
        draftCount={figures.draftCount}
        momGrossPct={figures.momGrossPct}
        isBestMonthOfYear={figures.isBestMonthOfYear}
        sales={{
          months: series.months,
          currentSeries: series.currentSeries,
          prevSeries: series.prevSeries,
          currentMonthKey: series.currentMonthKey,
          year: Number(series.currentMonthKey.slice(0, 4)),
        }}
        className={className}
      />
    );
  });
}

/** Podpis kart na sumie należności (§2.4 pkt 11): „Należności” i „Zaległości” mówią to samo. */
function receivablesNote(foreignCurrencyCount: number): string {
  return foreignCurrencyCount > 0
    ? `${RECEIVABLES_NOTE} · Pominięto ${foreignCurrencyCount} ${plural(foreignCurrencyCount, ['fakturę', 'faktury', 'faktur'])} w walucie obcej`
    : RECEIVABLES_NOTE;
}

export async function ReceivablesSlotCard({ supabase, tenantId, nowIso, className }: WithClass) {
  return loadCard('Należności', className, async () => {
    const r = await loadReceivables(supabase, tenantId, nowIso);
    return (
      <StatisticsAssetsLiabilities
        notDue={r.notDue}
        overdue={r.overdue}
        count={r.count}
        overdueCount={r.overdueCount}
        note={receivablesNote(r.foreignCurrencyCount)}
        className={className}
      />
    );
  });
}

export async function OverdueSlotCard({ supabase, tenantId, nowIso, className }: WithClass) {
  return loadCard('Zaległości', className, async () => {
    const r = await loadReceivables(supabase, tenantId, nowIso);
    return (
      <StatisticsLiquiditySnapshot
        overdue={r.overdue}
        total={r.total}
        oldestOverdueDays={r.oldestOverdueDays}
        note={receivablesNote(r.foreignCurrencyCount)}
        className={className}
      />
    );
  });
}

export async function OperationsSlotCard({ supabase, tenantId, nowIso, className }: WithClass) {
  return loadCard('Wszystkie operacje', className, async () => {
    const { inflows, costs, today } = await loadMovements(supabase, tenantId, nowIso, 'recent');
    return (
      <Card className={cn('py-0 shadow-none', className)}>
        <TransactionDatatable data={cashFlowOperations(inflows, costs, today)} />
      </Card>
    );
  });
}

/** Baner „N wydatków czeka na akceptację” nad siatką (jak na starej stronie). */
export async function PendingReviewAlert({ supabase, tenantId }: Omit<PrzeplywyCardProps, 'nowIso'>) {
  const count = await countPendingReview(supabase, tenantId);
  if (count <= 0) return null;
  const label = `${count} ${plural(count, ['wydatek czeka', 'wydatki czekają', 'wydatków czeka'])} na akceptację`;
  return (
    <Alert>
      <RiErrorWarningLine aria-hidden />
      <AlertTitle>
        <Link href="/expenses?filter=unreviewed" className="inline-flex items-center gap-1">
          {label}
          <RiArrowRightLine className="size-3.5" aria-hidden />
        </Link>
      </AlertTitle>
      <AlertDescription>Sprawdź dane rozpoznane automatycznie i zatwierdź</AlertDescription>
    </Alert>
  );
}

// ─── Siatka ───────────────────────────────────────────────────────────────

function Slot({
  title,
  className,
  variant,
  children,
}: {
  title: string;
  className?: string;
  variant: 'tile' | 'chart' | 'list';
  children: ReactNode;
}) {
  return (
    <SectionErrorBoundary
      fallback={<PrzeplywyCardError title={title} message="Nie udało się wyświetlić karty." className={className} />}
    >
      <Suspense fallback={<PulpitCardSkeleton variant={variant} className={className} />}>{children}</Suspense>
    </SectionErrorBoundary>
  );
}

export function PrzeplywyGrid({ className, ...props }: PrzeplywyCardProps & { className?: string }) {
  return (
    <div className={cn('grid grid-cols-6 gap-6', className)}>
      {/* Plan P2: karty P1 „Przychody i koszty” i „Ten miesiąc” nad siatką
          Przepływów — na każdej szerokości, bo Pulpit pokazuje dziś dane
          przykładowe, a liczby miesiąca muszą gdzieś być. */}
      <Slot title="Przychody i koszty" variant="chart" className="col-span-full">
        <KpirFinanceSlotCard {...props} className="col-span-full" />
      </Slot>

      {/* Cash Flow — rzędy 1:1 */}
      <Slot title="Wpływy i wydatki" variant="chart" className="col-span-full xl:col-span-4">
        <CashFlowSlotCard {...props} className="col-span-full xl:col-span-4" />
      </Slot>
      <Slot title="Odłóż na podatek" variant="chart" className="col-span-full xl:col-span-2">
        <GoalSlotCard {...props} className="col-span-full xl:col-span-2" />
      </Slot>

      <Slot title="Wpłynęło w tym miesiącu" variant="tile" className="col-span-full sm:col-span-3">
        <InflowMonthSlotCard {...props} className="col-span-full sm:col-span-3" />
      </Slot>
      <Slot title="Wydano w tym miesiącu" variant="tile" className="col-span-full sm:col-span-3">
        <OutflowMonthSlotCard {...props} className="col-span-full sm:col-span-3" />
      </Slot>

      <Slot title="Skąd i dokąd płyną pieniądze" variant="list" className="col-span-full lg:col-span-2">
        <SourcesSlotCard {...props} className="col-span-full lg:col-span-2" />
      </Slot>
      <Slot title="Spodziewane wpływy" variant="list" className="col-span-full lg:col-span-2">
        <UpcomingSlotCard {...props} className="col-span-full lg:col-span-2" />
      </Slot>
      <Slot title="Ostatnie operacje" variant="list" className="col-span-full lg:col-span-2">
        <RecentSlotCard {...props} className="col-span-full lg:col-span-2" />
      </Slot>

      {/* Pierwszy rząd Net Worth: Podsumowanie VAT + Należności / Zaległości.
          Prawa kolumna od `md` do `lg` idzie na całą szerokość w rzędzie (w
          szablonie obok niej stała następna karta Net Worth, tu — tabela). */}
      <Slot title="Podsumowanie podatku VAT" variant="chart" className="col-span-full lg:col-span-4">
        <VatSummarySlotCard {...props} className="col-span-full lg:col-span-4" />
      </Slot>
      <div className="col-span-full flex flex-col gap-6 sm:max-lg:flex-row lg:col-span-2">
        <Slot title="Należności" variant="tile" className="flex-1">
          <ReceivablesSlotCard {...props} className="flex-1" />
        </Slot>
        <Slot title="Zaległości" variant="tile" className="flex-1">
          <OverdueSlotCard {...props} className="flex-1" />
        </Slot>
      </div>

      <Slot title="Wszystkie operacje" variant="list" className="col-span-full">
        <OperationsSlotCard {...props} className="col-span-full" />
      </Slot>
    </div>
  );
}
