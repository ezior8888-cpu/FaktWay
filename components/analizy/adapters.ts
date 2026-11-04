import {
  RiAlarmWarningLine,
  RiCalendarLine,
  RiFileEditLine,
  RiFileList3Line,
  RiHourglassLine,
  RiMoneyDollarCircleLine,
  RiPercentLine,
  RiReceiptLine,
  RiRepeatLine,
  RiTimeLine,
} from '@remixicon/react';

import type { BreakdownSlice } from '@/lib/analytics-finance/breakdown';
import { saleBuyerName } from '@/lib/analytics-finance/clients';
import { recentCosts, type CostVatSummary, type TrendPoint } from '@/lib/analytics-finance/costs';
import { countedDays, isoDatePl } from '@/lib/analytics-finance/months';
import type { RecurringItem } from '@/lib/analytics-finance/recurring';
import { recentSales, type SaleInvoice } from '@/lib/analytics-finance/sales';
import type { CostEntry } from '@/lib/dashboard/costs';
import type { InflowTerms } from '@/lib/dashboard/inflow-terms';
import { costHref } from '@/lib/dashboard/ksef-invoice-cost';
import type { Receivables } from '@/lib/dashboard/receivables';
import { countLabel } from '@/lib/i18n/plural';
import { setAsRecurringHref } from '@/lib/invoices/recurring/visibility';
import { roundToCents } from '@/lib/xml/invoice-calculator';

import { costCategoryIcon } from './finora-1do1/expense-category-icons';
import { formatZl } from './finora-1do1/format';
import type {
  CategorySlice,
  FeedItem,
  FinoraIcon,
  IncomeExpenseNet,
  RankedItem,
  SubscriptionItem,
  SummaryRow,
  TrendDatum,
} from './finora-1do1/types';

/**
 * Adaptery: wynik naszych ładowarek → kształty kart Finory (poprawka Bartosza
 * 21.10.2026: Analizy 1:1 z Finory — „wykresy mają być z Finory, możesz
 * dopasować dane pasujące do naszych”). Karty w `finora-1do1/` dostają
 * dokładnie te pola, które Finora bierze ze swojej warstwy przykładowej
 * (`getMonthlyStats`, `getSpendTrend`…), a każda liczba pochodzi z `lib/`
 * (`loadCostsWindow`, `loadSalesWindow`, `loadProductLines`, `loadUpcomingInflows`)
 * — tu nic się nie liczy od nowa, tylko przekłada. Czyste funkcje bez
 * `server-only`, więc testuje się je wprost.
 */

/** Finora `getSpendTrend` → `{ month, amount }` (podpis miesiąca „Paź”). */
export function toTrendData(points: readonly TrendPoint[]): TrendDatum[] {
  return points.map((p) => ({ month: p.label, amount: p.amount }));
}

/**
 * Wszystkie słupki zerowe — jedyny przypadek pustego stanu trendu. Finora
 * rysuje słupki zawsze; „Wykres pojawi się po drugim miesiącu” odpada (D8).
 */
export function isAllZero(data: readonly TrendDatum[]): boolean {
  return data.every((d) => d.amount === 0);
}

/** Kolor wycinka „Pozostałe” (Finora: `miscellaneous` → `muted-foreground`). */
export const OTHER_SLICE_COLOR = 'var(--muted-foreground)';

/**
 * Finora `getCategoryBreakdown`: klucz serii bezpieczny dla CSS — miejsce
 * w rankingu ('s0'…'s5'), kolor `chart-1…5` po miejscu, „Pozostałe”
 * `muted-foreground` (jak `EXPENSE_CATEGORY_COLOR_VAR` w Finorze).
 *
 * Poprawka 21.10.2026 (Analizy 1:1 z Finory): „Pozostałe” też dostaje klucz
 * po miejscu, a nie 'other' jak w `sliceSlot`. Legenda recharts 3 sortuje
 * pozycje koła po kluczu (`itemSorter: 'value'`), a 'other' < 's0' stawiało
 * „Pozostałe” na początku legendy, choć w kole i rankingu jest ostatnie. lib
 * daje najwyżej top 5 + „Pozostałe” (zawsze na końcu), więc klucze to jedna
 * cyfra i porządek napisów = porządek rankingu.
 */
export function toCategorySlices(slices: readonly BreakdownSlice[]): CategorySlice[] {
  return slices.map((slice, index) => ({
    category: `s${index}`,
    label: slice.label,
    amount: slice.amount,
    percentage: slice.percentage,
    color: slice.other ? OTHER_SLICE_COLOR : `var(--chart-${(index % 5) + 1})`,
  }));
}

/** Wycinek „Pozostałe” — po kolorze, który nadaje mu tylko `toCategorySlices`. */
export function isOtherSlice(slice: CategorySlice): boolean {
  return slice.color === OTHER_SLICE_COLOR;
}

/** Ranking Finory (`CategoryRankedList`) — te same wycinki co koło, z ikoną w kółku. */
export function toRankedItems(
  slices: readonly CategorySlice[],
  iconOf: (slice: CategorySlice) => FinoraIcon,
): RankedItem[] {
  return slices.map((slice) => ({ ...slice, icon: iconOf(slice) }));
}

/**
 * „Średnio dziennie” sprzedaży — ta sama reguła co koszty (`costMonthStats`):
 * miniony miesiąc dzielimy przez wszystkie dni, bieżący przez dni do dziś.
 * Finorowy kafel „Avg Daily” zastępuje „Średnio na fakturę” (decyzja D9).
 */
export function salesAvgDaily(total: number, month: string, today: string): number {
  return roundToCents(total / countedDays(month, today)) || 0;
}

/**
 * „Ostatnie wydatki”: Finora `getRecentExpenses` + ikona kategorii wydatku.
 * Link do dokumentu: wydatek albo faktura zakupu z KSeF bez wydatku (E10).
 */
export function recentCostItems(entries: readonly CostEntry[], month: string, linkItems = false): FeedItem[] {
  return recentCosts(entries, month).map((cost) => {
    const entry = entries.find((e) => e.id === cost.id);
    return {
      id: cost.id,
      ...(linkItems ? { href: costHref(entry ?? { id: cost.id, source: '' }) } : {}),
      merchant: cost.name,
      subtitle: isoDatePl(cost.date),
      amount: cost.amount,
      icon: costCategoryIcon(entry?.categoryLabel ?? null),
    };
  });
}

/**
 * „Ostatnie faktury”: brutto dokumentu (korekta — różnica, może być ujemna),
 * druga linia „[Korekta · ]numer · DD.MM.RRRR”.
 */
export function recentSaleItems(invoices: readonly SaleInvoice[], month: string, linkItems = false): FeedItem[] {
  return recentSales(invoices, month, saleBuyerName).map((sale) => ({
    id: sale.id,
    ...(linkItems ? { href: `/invoices/${sale.id}` } : {}),
    merchant: sale.name,
    subtitle: [sale.kind === 'correction' ? 'Korekta' : null, sale.number, isoDatePl(sale.date)]
      .filter(Boolean)
      .join(' · '),
    amount: sale.amount,
    icon: RiFileList3Line,
  }));
}

/**
 * Finora pokazuje 6 subskrypcji — tyle wierszy ma karta 1:1 (decyzja D11).
 * To argument wywołania `recurringSuppliers` / `recurringClients`; lib bez zmian.
 */
export const RECURRING_LIST_LIMIT = 6;

/**
 * Finora „Subscriptions” ← N3 (stałe koszty / stali klienci). Zamiast „Renews
 * <data>” — typowy dzień miesiąca, zamiast cyklu rozliczeń — „Średnio / mies.”.
 * „Zrób fakturę cykliczną” (N1/E9) tylko przy kliencie z fakturą-wzorem
 * (nigdy dla dostawcy ani „Konsumentów” — lib nie daje im `templateInvoiceId`)
 * i tylko na prawdziwych danych: faktura-wzór z przykładu nie istnieje, więc
 * w trybie `przyklad` (`linkAction = false`) wiersz zostaje bez linku.
 */
export function toSubscriptionItems(
  items: readonly RecurringItem[],
  kind: 'supplier' | 'client',
  linkAction = true,
): SubscriptionItem[] {
  return items.map((item) => ({
    id: item.key,
    name: item.name,
    icon: RiRepeatLine,
    amount: item.averageAmount,
    renewsLabel: `Zwykle ok. ${item.typicalDay}. dnia miesiąca`,
    billingCycle: 'Średnio / mies.',
    action:
      linkAction && kind === 'client' && item.templateInvoiceId
        ? {
            href: setAsRecurringHref(item.templateInvoiceId),
            label: 'Zrób fakturę cykliczną',
            ariaLabel: `Zrób fakturę cykliczną dla: ${item.name}`,
          }
        : null,
  }));
}

/**
 * Finora `getIncomeExpenseNet`: przychód netto i koszt wybranego miesiąca —
 * wydatki jak w KPiR i faktury zakupu z KSeF bez wydatku netto (E10).
 */
export function incomeExpenseNet(income: number, expense: number): IncomeExpenseNet {
  return { income, expense, net: roundToCents(income - expense) || 0 };
}

const DOCUMENT_FORMS = ['dokument', 'dokumenty', 'dokumentów'] as const;
const INVOICE_FORMS = ['faktura', 'faktury', 'faktur'] as const;
const DAY_FORMS = ['dzień', 'dni', 'dni'] as const;

/**
 * „VAT z wydatków” w miejscu Finorowego „Spending Streaks” (plan P10, decyzja D3).
 * `reviewHref` (tylko prawdziwe dane): wiersz „Do opisania” prowadzi do listy nieopisanych.
 */
export function costVatRows(vat: CostVatSummary, reviewHref: string | null = null): SummaryRow[] {
  return [
    { icon: RiReceiptLine, iconClassName: 'text-foreground', title: 'VAT naliczony', value: formatZl(vat.vat) },
    { icon: RiPercentLine, iconClassName: 'text-primary', title: 'VAT do odliczenia', value: formatZl(vat.vatDeductible) },
    {
      icon: RiFileEditLine,
      iconClassName: vat.toReview > 0 ? 'text-destructive' : 'text-foreground',
      title: 'Do opisania',
      value: countLabel(vat.toReview, DOCUMENT_FORMS),
      href: reviewHref,
    },
  ];
}

type ReceivablesSummary = Pick<Receivables, 'total' | 'count' | 'overdue' | 'overdueCount' | 'oldestOverdueDays'>;

/**
 * „Należności” w miejscu Finorowego „Spending Streaks” (plan P11, decyzja D3):
 * ile do zapłaty, ile po terminie i najstarsza zaległość. Faktura bez wpłaty
 * z minionym terminem to należność po terminie (D-W odwołane 02.11.2026).
 */
export function receivablesRows(r: ReceivablesSummary): SummaryRow[] {
  return [
    {
      icon: RiMoneyDollarCircleLine,
      iconClassName: 'text-foreground',
      title: 'Do zapłaty',
      value: `${formatZl(r.total)} · ${countLabel(r.count, INVOICE_FORMS)}`,
    },
    {
      icon: RiAlarmWarningLine,
      iconClassName: r.overdue > 0 ? 'text-destructive' : 'text-foreground',
      title: 'Po terminie',
      value: `${formatZl(r.overdue)} · ${countLabel(r.overdueCount, INVOICE_FORMS)}`,
    },
    {
      icon: RiHourglassLine,
      iconClassName: 'text-foreground',
      title: 'Najstarsza zaległość',
      value: r.oldestOverdueDays === null ? 'Brak zaległości' : countLabel(r.oldestOverdueDays, DAY_FORMS),
    },
  ];
}

/** Wiersze należności w danych przykładowych: tytuł jak kolumna karty Pulpitu, ikona bez oceny. */
const TERM_ROWS: Record<InflowTerms['buckets'][number]['key'], { title: string; icon: FinoraIcon }> = {
  thisWeek: { title: 'Ten tydzień', icon: RiCalendarLine },
  upTo30: { title: 'Do 30 dni', icon: RiTimeLine },
  later: { title: 'Później', icon: RiHourglassLine },
};

/**
 * Tylko tryb `przyklad`: atrapa bazy nie ma wpłat, więc jej należności to te same
 * trzy przedziały przyszłych terminów co karta Pulpitu (`inflowTerms`).
 */
export function receivablesRowsPrzyklad(terms: InflowTerms): SummaryRow[] {
  return terms.buckets.map((b) => ({
    icon: TERM_ROWS[b.key].icon,
    iconClassName: 'text-foreground',
    title: TERM_ROWS[b.key].title,
    value: `${formatZl(b.amount)} · ${countLabel(b.count, INVOICE_FORMS)}`,
  }));
}
