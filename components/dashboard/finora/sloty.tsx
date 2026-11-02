import { cache, type ReactNode } from 'react';
import {
  RiBuilding2Line,
  RiFileList3Line,
  RiGroupLine,
  RiMoneyDollarCircleLine,
  RiShoppingBag3Line,
} from '@remixicon/react';

import { PulpitCardError } from '@/components/dashboard/pulpit/card-states';
import { PULPIT_GENERIC_ERROR, pulpitErrorMessage } from '@/components/dashboard/pulpit/pulpit-grid';
import { SectionErrorBoundary } from '@/components/dashboard/section-error-boundary';
import { shiftMonthKey } from '@/lib/analytics-finance/months';
import { salesMonthStats } from '@/lib/analytics-finance/sales';
import { getCostsWithKsefPurchases, sumCostsByMonth } from '@/lib/dashboard/costs';
import { warsawMonthWindow } from '@/lib/dashboard/rankings';
import { inflowTerms } from '@/lib/dashboard/inflow-terms';
import { getInflows } from '@/lib/dashboard/inflows';
import {
  pulpitMonthlyFigures,
  pulpitRankings,
  pulpitSalesInvoices,
  pulpitSalesSeries,
  pulpitVatLimit,
} from '@/lib/dashboard/sales-history';
import type { TrybDanych } from '@/lib/demo/tryb-danych';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { isSubjectiveVatExemption, readTenantVatExemption } from '@/lib/invoices/vat-exemption';
import type { PageContext } from '@/lib/supabase/page-context';

import {
  ODSWIEZ,
  finanseProps,
  kafelFaktur,
  kafelSredniej,
  limitVatProps,
  naleznosciProps,
  przychodProps,
  rankingiProps,
  vatNaleznyProps,
} from './adaptery';
import FinanceCard from './chart-finance';
import TotalVisitorsCard from './chart-total-visitors';
import StatisticsCard from './statistics-card-03';
import StatisticsImpressionCard from './statistics-impression-card';
import StatisticsTotalRevenueCard from './statistics-total-revenue-card';
import TopProductsCard from './widget-top-products';

/**
 * Sloty Pulpitu (PLAN-PRAWDZIWE-DANE §5.6, E5): każda karta Finory to osobny
 * asynchroniczny loader z własną kartą błędu i `SectionErrorBoundary`.
 * Strażnik, który rzuci (faktura w EUR, przyjęta faktura bez środowiska),
 * zabiera JEDNĄ kartę z treścią wyjątku (`pulpitErrorMessage`), reszta
 * Pulpitu działa. Wzorzec: `components/analizy/card-slot.tsx`.
 *
 * Ładowanie jak przed E5 (poprawka Bartosza 23.10.2026: „przejścia nie są już
 * takie clean”): bez `Suspense` i szkieletu w każdej karcie. Strona pobiera
 * dane wszystkich kart RÓWNOLEGLE (`Promise.all` na slotach, które nigdy nie
 * odrzucają — błąd to karta błędu) i renderuje się raz, w całości; wejście
 * treści animuje `ff-route-content`, a trasa ma własny, pusty `loading.tsx`
 * zamiast obcego szkieletu segmentu.
 *
 * Oba tryby idą tymi samymi slotami: w trybie `przyklad` `supabase` to
 * atrapa bazy z danymi przykładowymi (`kontekstDanych`), w pozostałych —
 * sesja klienta (RLS). Sloty nie wiedzą, skąd są dane; tryb decyduje tylko
 * o tekście pustego stanu („Pobieramy faktury z KSeF…” w stanie B).
 *
 * Karty sprzedaży czytają faktury RAZ na wejście (`lib/dashboard/sales-history.ts`,
 * sesja 19 planu skalowania): każda bierze swoje okna ze wspólnego zbioru,
 * a strażniki liczą się na oknie karty — błąd dalej zabiera jedną kartę.
 */

export interface PulpitSlotProps {
  supabase: PageContext['supabase'];
  tenantId: string;
  /** Chwila żądania jako ISO — jeden „teraz” dla wszystkich kart. */
  nowIso: string;
  tryb: TrybDanych;
  /** Od kiedy koszty z KSeF są pełne (`trybDanych().kosztyKsefOd`, Z9/E10: „KSeF od DD.MM”); `null` — bez zastrzeżenia. */
  kosztyKsefOd: string | null;
}

type SlotProps = PulpitSlotProps & { className?: string };

/** Okno wykresu „Finanse” (Z7). */
const FINANSE_MIESIACE = 7;
/** Okno serii sprzedaży czytanej raz dla Finansów i VAT (12 miesięcy, bez roku wcześniej). */
const SERIA_MIESIACE = 12;
/** Okno karty „Przychód netto” (5 słupków jak w Finorze) z rokiem wcześniej. */
const PRZYCHOD_MIESIACE = 5;

/**
 * Seria sprzedaży raz na żądanie dla kart, które jej potrzebują (Finanse
 * i VAT liczą to samo 12-miesięczne okno). „Przychód netto” bierze osobne
 * okno 5 miesięcy z rokiem wcześniej, żeby stara faktura sprzed roku nie
 * zabierała strażnikiem waluty kart bieżących. Wiersze obu serii pochodzą
 * ze wspólnego odczytu sprzedaży (`sales-history.ts`).
 */
const serieSprzedazy = cache(
  (supabase: PageContext['supabase'], tenantId: string, nowIso: string, months: number, withPrevYear: boolean) =>
    pulpitSalesSeries(supabase, tenantId, nowIso, months, withPrevYear),
);

/** Dane karty albo karta błędu z treścią wyjątku dla klienta. */
async function zaladujKarte(title: string, className: string | undefined, render: () => Promise<ReactNode>) {
  try {
    return await render();
  } catch (error) {
    const message = pulpitErrorMessage(error);
    if (message === PULPIT_GENERIC_ERROR) console.error(`[pulpit] karta „${title}”:`, error);
    return <PulpitCardError title={title} message={message} className={className} />;
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
      fallback={<PulpitCardError title={title} message="Nie udało się wyświetlić karty." className={className} />}
    >
      {tresc}
    </SectionErrorBoundary>
  );
}

// ─── Karty ────────────────────────────────────────────────────────────────

async function FinanseKarta({ supabase, tenantId, nowIso, tryb, kosztyKsefOd, className }: SlotProps) {
  return zaladujKarte('Finanse', className, async () => {
    const series = await serieSprzedazy(supabase, tenantId, nowIso, SERIA_MIESIACE, false);
    const months = series.months.slice(-FINANSE_MIESIACE);
    // E10 (D-K): koszty = faktury zakupu z KSeF + wydatki spoza KSeF (KPiR bez zmian).
    const costs = sumCostsByMonth(
      await getCostsWithKsefPurchases(supabase, tenantId, warsawMonthWindow(new Date(nowIso), FINANSE_MIESIACE)),
      months.map((m) => m.key),
    );
    const dane = finanseProps({
      months,
      net: series.netSeries.slice(-FINANSE_MIESIACE),
      vat: series.vatSeries.slice(-FINANSE_MIESIACE),
      costs,
      tryb,
      kosztyKsefOd,
    });
    return (
      <FinanceCard
        {...dane}
        financeMenu={[ODSWIEZ, { label: 'Analiza sprzedaży', href: '/analizy/sprzedaz' }]}
        reportMenu={[ODSWIEZ, { label: 'Księga KPiR', href: '/reports/kpir' }]}
        demo={tryb === 'przyklad'}
        className={className}
      />
    );
  });
}

async function KafelFakturKarta({ supabase, tenantId, nowIso, tryb, className }: SlotProps) {
  return zaladujKarte('Faktury w KSeF', className, async () => {
    const dane = kafelFaktur(await pulpitMonthlyFigures(supabase, tenantId, nowIso), tryb);
    return (
      <StatisticsCard
        icon={<RiFileList3Line />}
        title="Faktury w KSeF"
        value={dane.value}
        changePct={dane.changePct}
        badgeContent={dane.badge}
        iconClassName="bg-chart-3/20 text-chart-3"
        className={className}
      />
    );
  });
}

async function KafelSredniejKarta({ supabase, tenantId, nowIso, tryb, className }: SlotProps) {
  return zaladujKarte('Średnia faktura', className, async () => {
    const now = new Date(nowIso);
    const month = todayInWarsaw(now).slice(0, 7);
    const prev = shiftMonthKey(month, -1);
    const invoices = await pulpitSalesInvoices(supabase, tenantId, nowIso, warsawMonthWindow(now, 2));
    const dane = kafelSredniej(
      salesMonthStats(invoices, month, prev).avgPerInvoice,
      salesMonthStats(invoices, prev, shiftMonthKey(prev, -1)).avgPerInvoice,
      tryb,
    );
    return (
      <StatisticsCard
        icon={<RiMoneyDollarCircleLine />}
        title="Średnia faktura"
        value={dane.value}
        valueTitle={dane.valueTitle}
        changePct={dane.changePct}
        badgeContent={dane.badge}
        iconClassName="bg-chart-3/20 text-chart-3"
        className={className}
      />
    );
  });
}

async function PrzychodKarta({ supabase, tenantId, nowIso, tryb, className }: SlotProps) {
  return zaladujKarte('Przychód netto', className, async () => {
    const series = await serieSprzedazy(supabase, tenantId, nowIso, PRZYCHOD_MIESIACE, true);
    return <StatisticsTotalRevenueCard {...przychodProps(series, tryb)} className={className} />;
  });
}

/**
 * Płatnik VAT: „VAT należny” z 12 miesięcy. Firma zwolniona podmiotowo
 * (art. 113) nie ma VAT należnego — widzi limit zwolnienia (rozgałęzienie
 * jak `VatSlotCard` w `components/dashboard/pulpit/pulpit-grid.tsx`).
 */
async function VatKarta({ supabase, tenantId, nowIso, tryb, className }: SlotProps) {
  let exemption: string | null;
  try {
    exemption = await readTenantVatExemption(supabase, tenantId);
  } catch (error) {
    return <PulpitCardError title="VAT należny" message={pulpitErrorMessage(error)} className={className} />;
  }
  const exempt = isSubjectiveVatExemption(exemption);
  return zaladujKarte(exempt ? 'Limit VAT' : 'VAT należny', className, async () => {
    const dane = exempt
      ? limitVatProps(await pulpitVatLimit(supabase, tenantId, nowIso), tryb)
      : vatNaleznyProps(await serieSprzedazy(supabase, tenantId, nowIso, SERIA_MIESIACE, false), tryb);
    return <StatisticsImpressionCard {...dane} className={className} />;
  });
}

async function NaleznosciKarta({ supabase, tenantId, nowIso, tryb, className }: SlotProps) {
  return zaladujKarte('Należności', className, async () => {
    // E11 (D-W): przyszłe terminy faktur sprzedaży bez prawdziwej zapłaty (wpływy od dziś).
    const today = todayInWarsaw(new Date(nowIso));
    const terms = inflowTerms(await getInflows(supabase, tenantId, { from: today }), today);
    return <TotalVisitorsCard {...naleznosciProps(terms, tryb)} className={className} />;
  });
}

/** Kolory kółek ikon Finory, po kolei (5 pozycji). */
const KOLORY_IKON: (string | undefined)[] = [
  'bg-primary/10 text-primary dark:bg-primary/25',
  'bg-chart-2/10 text-chart-2',
  'bg-chart-5/10 text-chart-5',
  undefined,
  'bg-chart-3/10 text-chart-3',
];

async function RankingiKarta({ supabase, tenantId, nowIso, tryb, className }: SlotProps) {
  return zaladujKarte('Najlepiej sprzedające się', className, async () => {
    const { products, clients } = await pulpitRankings(supabase, tenantId, nowIso);
    const dane = rankingiProps(products, clients, tryb);
    return (
      <TopProductsCard
        salesTitle="Najlepiej sprzedające się"
        salesMenu={[ODSWIEZ, { label: 'Faktury', href: '/invoices' }]}
        productsBySalesData={dane.products.map((p, i) => ({
          icon: <RiShoppingBag3Line />,
          productName: p.name,
          productBrand: p.sub,
          sales: p.amount,
          salesTitle: p.amountTitle,
          iconClassName: KOLORY_IKON[i],
        }))}
        salesEmpty={dane.productsEmpty}
        volumeTitle="Najwięksi klienci"
        volumeMenu={[ODSWIEZ, { label: 'Kontrahenci', href: '/contractors' }]}
        productsByVolumeData={dane.clients.map((c, i) => ({
          icon: clients[i]?.consumers ? <RiGroupLine /> : <RiBuilding2Line />,
          productName: c.name,
          productBrand: c.sub,
          volume: c.amount,
          volumeTitle: c.amountTitle,
          changePercentage: c.changePct,
          iconClassName: KOLORY_IKON[i],
        }))}
        volumeEmpty={dane.clientsEmpty}
        className={className}
      />
    );
  });
}

// ─── Sloty (karta + granica błędu; bez Suspense — strona czeka na wszystkie) ─

export function FinanseSlot(props: SlotProps) {
  return slot('Finanse', props.className, () => FinanseKarta(props));
}

export function KafelFakturSlot(props: SlotProps) {
  return slot('Faktury w KSeF', props.className, () => KafelFakturKarta(props));
}

export function KafelSredniejSlot(props: SlotProps) {
  return slot('Średnia faktura', props.className, () => KafelSredniejKarta(props));
}

export function PrzychodSlot(props: SlotProps) {
  return slot('Przychód netto', props.className, () => PrzychodKarta(props));
}

export function VatSlot(props: SlotProps) {
  return slot('VAT należny', props.className, () => VatKarta(props));
}

export function NaleznosciSlot(props: SlotProps) {
  return slot('Należności', props.className, () => NaleznosciKarta(props));
}

export function RankingiSlot(props: SlotProps) {
  return slot('Najlepiej sprzedające się', props.className, () => RankingiKarta(props));
}
