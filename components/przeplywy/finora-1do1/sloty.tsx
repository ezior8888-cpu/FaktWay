import { cache, type ReactNode } from 'react';
import { RiBillLine, RiMoneyDollarCircleLine, RiReceiptLine } from '@remixicon/react';

import { ODSWIEZ, notaKosztowKsef } from '@/components/dashboard/finora/adaptery';
import { PULPIT_GENERIC_ERROR, pulpitErrorMessage } from '@/components/dashboard/pulpit/pulpit-grid';
import { SectionErrorBoundary } from '@/components/dashboard/section-error-boundary';
import { PrzeplywyCardError } from '@/components/przeplywy/przeplywy-grid';
import { Card } from '@/components/ui/card';
import { getCashFlowData } from '@/lib/dashboard/cash-flow';
import {
  buildCashFlowChart,
  cashFlowOperations,
  monthFlows,
  nextMonthStart,
  przykladoweWplywy,
  topCashFlowSources,
  upcomingInflows,
  yearsWindowStart,
} from '@/lib/dashboard/cash-movements';
import { getCostsWithKsefPurchases } from '@/lib/dashboard/costs';
import { getInflows } from '@/lib/dashboard/inflows';
import { warsawMonthWindow } from '@/lib/dashboard/rankings';
import { getVatLimit } from '@/lib/dashboard/vat-limit';
import type { TrybDanych } from '@/lib/demo/tryb-danych';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import { czytajOdlozyc } from '@/lib/ksiegowosc/odlozyc';
import { czyKsiegowoscWlaczona } from '@/lib/ksiegowosc/wylacznik';
import type { PageContext } from '@/lib/supabase/page-context';
import { cn } from '@/lib/utils';

import {
  aktywnoscProps,
  kosztyMiesiacaProps,
  krzywaKosztow,
  krzywaWplywow,
  limitProps,
  odlozycProps,
  podatekProps,
  tabelaProps,
  wplywyMiesiacaProps,
  wplywySpodziewaneProps,
  wykresProps,
  zrodlaProps,
} from './adaptery';
import CashFlowCard from './chart-cash-flow';
import TransactionDatatable from './datatable-transaction';
import StatisticsAreaStatCard from './statistics-area-stat-card';
import StatisticsSavingsGoalCard from './statistics-savings-goal-card';
import RecentActivityCard from './widget-recent-activity';
import TopCashFlowSourcesCard from './widget-top-cash-flow-sources';
import UpcomingBillsCard from './widget-upcoming-bills';

/**
 * Sloty Przepływów (PLAN-PRAWDZIWE-DANE §5.6, §6.2, E6): każda karta Finory
 * to osobny asynchroniczny loader z własną kartą błędu
 * i `SectionErrorBoundary`. Strażnik, który rzuci (faktura w EUR, przyjęta
 * faktura bez środowiska), zabiera JEDNĄ kartę z treścią wyjątku i wyjściem
 * (`PrzeplywyCardError`: „napisz do nas”), reszta Przepływów działa.
 *
 * Ładowanie jak przed E6 (poprawka Bartosza 23.10.2026: „przejścia nie są już
 * takie clean”): bez `Suspense` i szkieletu w każdej karcie. Strona pobiera
 * dane wszystkich kart RÓWNOLEGLE (`Promise.all` na slotach, które nigdy nie
 * odrzucają) i renderuje się raz, w całości; wejście treści animuje
 * `ff-route-content`, a trasa ma własny, pusty `loading.tsx`.
 *
 * Ładowarki jak w dawnej siatce (`components/przeplywy/przeplywy-grid.tsx`):
 * wpływy i koszty OSOBNO (strażnik jednego źródła nie zabiera kafla
 * drugiego), każde w dwóch oknach — 12 miesięcy (kafle, źródła, operacje,
 * tabela) i 5 lat (wykres, zakładka „Rocznie”); React `cache()` — jedno
 * zapytanie na żądanie. Okno wpływów nie ma końca, więc ten sam odczyt
 * 12 miesięcy daje też przyszłe terminy do „Spodziewanych wpływów”; karty
 * wpływów biorą same prawdziwe pieniądze (`receivedInflows` w `cash-movements`).
 *
 * Oba tryby idą tymi samymi slotami: w trybie `przyklad` `supabase` to
 * atrapa bazy (`kontekstDanych`), w pozostałych — sesja klienta (RLS).
 * Tryb decyduje o linkach wierszy, tekście pustego stanu i o tym, że atrapa
 * bez wpłat liczy miniony termin jak wpłatę (`przykladoweWplywy`).
 */

export interface PrzeplywySlotProps {
  supabase: PageContext['supabase'];
  tenantId: string;
  /** Chwila żądania jako ISO — jeden „teraz” dla wszystkich kart. */
  nowIso: string;
  tryb: TrybDanych;
  /** Od kiedy koszty z KSeF są pełne (`trybDanych().kosztyKsefOd`, Z9/E10: „KSeF od DD.MM”); `null` — bez zastrzeżenia. */
  kosztyKsefOd: string | null;
}

type SlotProps = PrzeplywySlotProps & { className?: string };

/** Ostatnie 12 miesięcy: kafle miesiąca, źródła, operacje, tabela. */
const RECENT_MONTHS = 12;

type Span = 'recent' | 'years';

function movementsRange(nowIso: string, span: Span) {
  const now = new Date(nowIso);
  const today = todayInWarsaw(now);
  return span === 'years'
    ? { from: yearsWindowStart(today), toExclusive: nextMonthStart(today) }
    : warsawMonthWindow(now, RECENT_MONTHS);
}

/** Wpływy od początku okna, bez końca (przyszłe terminy też — Spodziewane wpływy). */
const loadInflows = cache(async (
  supabase: PageContext['supabase'],
  tenantId: string,
  nowIso: string,
  span: Span,
  tryb: TrybDanych,
) => {
  const entries = await getInflows(supabase, tenantId, { from: movementsRange(nowIso, span).from });
  return tryb === 'przyklad' ? przykladoweWplywy(entries, todayInWarsaw(new Date(nowIso))) : entries;
});

/** E10 (D-K): koszty = faktury zakupu z KSeF + wydatki spoza KSeF (KPiR bez zmian). */
const loadCosts = cache((supabase: PageContext['supabase'], tenantId: string, nowIso: string, span: Span) =>
  getCostsWithKsefPurchases(supabase, tenantId, movementsRange(nowIso, span)));

async function loadMovements(supabase: PageContext['supabase'], tenantId: string, nowIso: string, span: Span, tryb: TrybDanych) {
  const [inflows, costs] = await Promise.all([
    loadInflows(supabase, tenantId, nowIso, span, tryb),
    loadCosts(supabase, tenantId, nowIso, span),
  ]);
  return { inflows, costs, today: todayInWarsaw(new Date(nowIso)) };
}

const loadOperations = cache(async (supabase: PageContext['supabase'], tenantId: string, nowIso: string, tryb: TrybDanych) => {
  const { inflows, costs, today } = await loadMovements(supabase, tenantId, nowIso, 'recent', tryb);
  return cashFlowOperations(inflows, costs, today);
});

/** Dane karty albo karta błędu z treścią wyjątku dla klienta. */
async function zaladujKarte(title: string, className: string | undefined, render: () => Promise<ReactNode>) {
  try {
    return await render();
  } catch (error) {
    const message = pulpitErrorMessage(error);
    if (message === PULPIT_GENERIC_ERROR) console.error(`[przeplywy] karta „${title}”:`, error);
    return <PrzeplywyCardError title={title} message={message} className={className} />;
  }
}

/**
 * Karta w granicy błędu renderu (komponent kliencki karty). Dane są już
 * pobrane, a wyjątek loadera to karta błędu — slot nigdy nie odrzuca, więc
 * `Promise.all` strony działa jak `Promise.allSettled`.
 */
async function slot(title: string, className: string | undefined, karta: () => Promise<ReactNode>) {
  const tresc = await zaladujKarte(title, className, karta);
  return (
    <SectionErrorBoundary
      fallback={<PrzeplywyCardError title={title} message="Nie udało się wyświetlić karty." className={className} />}
    >
      {tresc}
    </SectionErrorBoundary>
  );
}

// ─── Kolory kółek ikon Finory, po kolei (jak w szablonie każdej listy) ────

const KOLORY_ZRODEL = [
  'bg-primary/10 text-primary dark:bg-primary/20',
  'bg-chart-2/10 text-chart-2',
  'bg-chart-3/10 text-chart-3',
  'bg-chart-4/10 text-chart-4',
  'bg-chart-5/10 text-chart-5',
];
const KOLORY_AKTYWNOSCI = [
  'bg-primary/10 text-primary dark:bg-primary/20',
  'bg-chart-4/10 text-chart-4',
  'bg-chart-2/10 text-chart-2',
  'bg-chart-3/10 text-chart-3',
  'bg-chart-5/10 text-chart-5',
];
const KOLORY_TERMINOW = [
  'bg-primary/10 text-primary dark:bg-primary/20',
  'bg-chart-2/10 text-chart-2',
  'bg-chart-4/10 text-chart-4',
  'bg-chart-3/10 text-chart-3',
  'bg-chart-5/10 text-chart-5',
];

// ─── Karty ────────────────────────────────────────────────────────────────

async function WykresKarta({ supabase, tenantId, nowIso, tryb, className }: SlotProps) {
  return zaladujKarte('Przepływy pieniężne', className, async () => {
    const { inflows, costs, today } = await loadMovements(supabase, tenantId, nowIso, 'years', tryb);
    const dane = wykresProps(buildCashFlowChart(inflows, costs, today), tryb);
    return (
      <CashFlowCard
        key={tenantId}
        tabs={dane.tabs}
        subTitle={dane.subTitle}
        subTitleHint={dane.subTitleHint}
        menuItems={[ODSWIEZ, { label: 'Wydatki', href: '/expenses' }]}
        demo={tryb === 'przyklad'}
        className={className}
      />
    );
  });
}

/**
 * Pierścień „Cel oszczędnościowy”: firma zwolniona podmiotowo (art. 113)
 * widzi limit zwolnienia z VAT, płatnik VAT — „Odłóż na podatek” (Z10).
 */
async function PierscienKarta({ supabase, tenantId, nowIso, tryb, className }: SlotProps) {
  let exemption: string | null;
  try {
    exemption = await readTenantVatExemption(supabase, tenantId);
  } catch (error) {
    return <PrzeplywyCardError title="Odłóż na podatek" message={pulpitErrorMessage(error)} className={className} />;
  }
  if (isSubjectiveVatExemption(exemption)) {
    return zaladujKarte('Limit zwolnienia z VAT', className, async () => (
      <StatisticsSavingsGoalCard
        {...limitProps(await getVatLimit(supabase, tenantId, new Date(nowIso)), tryb)}
        className={className}
      />
    ));
  }
  return zaladujKarte('Odłóż na podatek', className, async () => {
    // Pilotaż księgowości (K5, D13): szacunek z modułu zamiast 19 % liniowego.
    // Pozostałe firmy i tryb przykładowy bez zmian; błąd odczytu wyłącznika to „nie”.
    const pilotaz =
      tryb !== 'przyklad' &&
      (await czyKsiegowoscWlaczona(supabase, tenantId, 'terminy').then((w) => w.wlaczony, () => false));
    if (pilotaz) {
      const dzis = todayInWarsaw(new Date(nowIso));
      const szacunek = await czytajOdlozyc(supabase, tenantId, dzis);
      return <StatisticsSavingsGoalCard {...odlozycProps(szacunek)} className={className} />;
    }
    const data = await getCashFlowData(supabase, tenantId, new Date(nowIso));
    return <StatisticsSavingsGoalCard {...podatekProps(data.taxEstimate, tryb)} className={className} />;
  });
}

/** Tytuł kafla wpływów: kwota to prawdziwe pieniądze, oznaczone wpłaty (D-W odwołane 02.11.2026). */
const TYTUL_WPLYWOW = 'Wpłynęło w tym miesiącu';

async function WplywyKarta({ supabase, tenantId, nowIso, tryb, className }: SlotProps) {
  return zaladujKarte(TYTUL_WPLYWOW, className, async () => {
    const inflows = await loadInflows(supabase, tenantId, nowIso, 'recent', tryb);
    const today = todayInWarsaw(new Date(nowIso));
    const flow = monthFlows(inflows, [], today).inflow;
    return (
      <StatisticsAreaStatCard
        chartKey="income"
        title={TYTUL_WPLYWOW}
        {...wplywyMiesiacaProps(flow, krzywaWplywow(inflows, today), tryb)}
        color="var(--chart-4)"
        badgeClassName="bg-chart-4/10 text-chart-4"
        className={className}
      />
    );
  });
}

async function KosztyKarta({ supabase, tenantId, nowIso, tryb, kosztyKsefOd, className }: SlotProps) {
  return zaladujKarte('Koszty w tym miesiącu (brutto)', className, async () => {
    const costs = await loadCosts(supabase, tenantId, nowIso, 'recent');
    const today = todayInWarsaw(new Date(nowIso));
    const flow = monthFlows([], costs, today).outflow;
    return (
      <StatisticsAreaStatCard
        chartKey="expense"
        title="Koszty w tym miesiącu (brutto)"
        {...kosztyMiesiacaProps(flow, krzywaKosztow(costs, today), tryb, notaKosztowKsef(tryb, kosztyKsefOd, today.slice(0, 7)))}
        color="var(--chart-4)"
        badgeClassName="bg-chart-4/10 text-chart-4"
        className={className}
      />
    );
  });
}

async function ZrodlaKarta({ supabase, tenantId, nowIso, tryb, className }: SlotProps) {
  return zaladujKarte('Największe źródła przepływów', className, async () => {
    const { inflows, costs, today } = await loadMovements(supabase, tenantId, nowIso, 'recent', tryb);
    const dane = zrodlaProps(topCashFlowSources(inflows, costs, today), tryb);
    return (
      <TopCashFlowSourcesCard
        title="Największe źródła przepływów"
        sources={dane.items.map((s, i) => ({
          ...s,
          icon: s.direction === 'in' ? <RiReceiptLine /> : <RiBillLine />,
          iconClassName: KOLORY_ZRODEL[i],
        }))}
        empty={dane.empty}
        emptyLink={dane.emptyLink}
        menuItems={[ODSWIEZ, { label: 'Kontrahenci', href: '/contractors' }]}
        className={className}
      />
    );
  });
}

async function SpodziewaneKarta({ supabase, tenantId, nowIso, tryb, className }: SlotProps) {
  return zaladujKarte('Spodziewane wpływy', className, async () => {
    const inflows = await loadInflows(supabase, tenantId, nowIso, 'recent', tryb);
    const upcoming = upcomingInflows(inflows, todayInWarsaw(new Date(nowIso)));
    const dane = wplywySpodziewaneProps(upcoming.items, tryb);
    return (
      <UpcomingBillsCard
        title="Spodziewane wpływy"
        subTitle="Następne 30 dni"
        note={dane.note}
        bills={dane.items.map((b, i) => ({ ...b, icon: <RiReceiptLine />, iconClassName: KOLORY_TERMINOW[i] }))}
        empty={dane.empty}
        menuItems={[ODSWIEZ, { label: 'Faktury', href: '/invoices' }]}
        className={className}
      />
    );
  });
}

async function AktywnoscKarta({ supabase, tenantId, nowIso, tryb, className }: SlotProps) {
  return zaladujKarte('Ostatnia aktywność', className, async () => {
    const dane = aktywnoscProps((await loadOperations(supabase, tenantId, nowIso, tryb)).slice(0, 5), tryb);
    return (
      <RecentActivityCard
        title="Ostatnia aktywność"
        activity={dane.items.map(({ rodzaj, ...a }, i) => ({
          ...a,
          icon: rodzaj === 'wplata' ? <RiMoneyDollarCircleLine /> : <RiBillLine />,
          iconClassName: KOLORY_AKTYWNOSCI[i],
        }))}
        empty={dane.empty}
        emptyLink={dane.emptyLink}
        menuItems={[ODSWIEZ, { label: 'Wydatki', href: '/expenses' }]}
        className={className}
      />
    );
  });
}

async function OperacjeKarta({ supabase, tenantId, nowIso, tryb, className }: SlotProps) {
  return zaladujKarte('Wszystkie operacje', className, async () => {
    const dane = tabelaProps(await loadOperations(supabase, tenantId, nowIso, tryb), tryb);
    return (
      <Card className={cn('py-0 shadow-none', className)}>
        <TransactionDatatable key={tenantId} data={dane.rows} emptyMessage={dane.empty} />
      </Card>
    );
  });
}

// ─── Sloty (karta + granica błędu; bez Suspense — strona czeka na wszystkie) ─

export function WykresSlot(props: SlotProps) {
  return slot('Przepływy pieniężne', props.className, () => WykresKarta(props));
}

export function PierscienSlot(props: SlotProps) {
  return slot('Odłóż na podatek', props.className, () => PierscienKarta(props));
}

export function WplywySlot(props: SlotProps) {
  return slot(TYTUL_WPLYWOW, props.className, () => WplywyKarta(props));
}

export function KosztySlot(props: SlotProps) {
  return slot('Koszty w tym miesiącu (brutto)', props.className, () => KosztyKarta(props));
}

export function ZrodlaSlot(props: SlotProps) {
  return slot('Największe źródła przepływów', props.className, () => ZrodlaKarta(props));
}

export function SpodziewaneSlot(props: SlotProps) {
  return slot('Spodziewane wpływy', props.className, () => SpodziewaneKarta(props));
}

export function AktywnoscSlot(props: SlotProps) {
  return slot('Ostatnia aktywność', props.className, () => AktywnoscKarta(props));
}

export function OperacjeSlot(props: SlotProps) {
  return slot('Wszystkie operacje', props.className, () => OperacjeKarta(props));
}
