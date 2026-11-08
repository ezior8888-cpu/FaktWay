import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import {
  RiArrowDownLine,
  RiArrowUpDownLine,
  RiArrowUpLine,
  RiBankLine,
  RiCarLine,
  RiComputerLine,
  RiFileList3Line,
  RiMoreLine,
  RiPriceTag3Line,
  RiReceiptLine,
  RiRepeatLine,
  RiRestaurantLine,
  RiShoppingBagLine,
  RiTeamLine,
  RiUser3Line,
} from '@remixicon/react';
import { describe, expect, it, vi } from 'vitest';

import { tekstBezZnacznikow } from './helpers/tekst-html';

vi.mock('next/navigation', () => ({
  usePathname: () => '/analizy/koszty',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
}));

const { default: CategoryBreakdownChart } = await import('@/components/analizy/finora-1do1/category-breakdown-chart');
const { default: CategoryRankedList } = await import('@/components/analizy/finora-1do1/category-ranked-list');
const { costCategoryIcon } = await import('@/components/analizy/finora-1do1/expense-category-icons');
const { default: FinoraEmpty } = await import('@/components/analizy/finora-1do1/finora-empty');
const { formatAxisMoney, formatZl, legendLabel, legendLabels, PIE_LEGEND_MAX_CHARS } = await import(
  '@/components/analizy/finora-1do1/format'
);
const { default: IncomeExpenseSummary } = await import('@/components/analizy/finora-1do1/income-expense-summary');
const { default: MonthlyStatsCards } = await import('@/components/analizy/finora-1do1/monthly-stats-cards');
const { default: RecentExpensesFeed } = await import('@/components/analizy/finora-1do1/recent-expenses-feed');
const { default: SpendHeatmap } = await import('@/components/analizy/finora-1do1/spend-heatmap');
const { default: SpendTrendChart } = await import('@/components/analizy/finora-1do1/spend-trend-chart');
const { default: SpendingStreaksCard } = await import('@/components/analizy/finora-1do1/spending-streaks-card');
const { default: SubscriptionsCard } = await import('@/components/analizy/finora-1do1/subscriptions-card');
const { ANALIZY_EMPTY } = await import('@/components/analizy/finora/empty');
const { formatPlCompactMoney } = await import('@/lib/format/pl');

import type {
  CategorySlice,
  FeedItem,
  MonthlyStatsLabels,
  RankedItem,
  SubscriptionItem,
  TrendDatum,
} from '@/components/analizy/finora-1do1/types';

/**
 * Analizy 1:1 z Finory (decyzja Bartosza 21.10.2026: „na razie wszystko 1:1
 * z Finory … wykresy mają być z Finory, nie zmieniaj rozmiarów”). Kopie
 * w `components/analizy/finora-1do1/` mają klasy i propsy wykresów Finory
 * dosłownie; ten plik pilnuje, żeby tak zostało, i sprawdza jedyne
 * dopuszczone odstępstwa: złote po polsku, minus typograficzny, puste stany
 * z §7.3, dostępność kalendarza i link „Zrób fakturę cykliczną” w linii.
 */

/** SSR wstawia <!-- --> między sąsiednie węzły tekstowe — usuwamy je. */
function html(node: React.ReactElement): string {
  return renderToStaticMarkup(node).replace(/<!-- -->/g, '');
}

function noFinoraLeftovers(out: string) {
  expect(out).not.toMatch(/\$\s?\d/);
  expect(out).not.toContain('images/avatars');
  expect(out).not.toContain('backdrop-blur');
  expect(out).not.toContain('ff-glass-pane');
}

/** Ścieżka SVG ikony Remix — po niej poznajemy, która strzałka się wyrenderowała. */
function iconPath(Icon: React.ComponentType): string {
  const d = renderToStaticMarkup(<Icon />).match(/ d="([^"]+)"/)?.[1];
  expect(d).toBeTruthy();
  return d!;
}

const NBSP = ' ';
const MINUS = '−';

const source = (file: string) =>
  readFileSync(join(process.cwd(), 'components/analizy/finora-1do1', file), 'utf8');

/** Sam kod, bez komentarzy `//` — nagłówek kopii opisuje odstępstwa i wymienia np. `w-30`. */
const code = (file: string) =>
  source(file)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

const costLabels: MonthlyStatsLabels = {
  totalSpend: 'Wydano (brutto)',
  avgDailySpend: 'Średnio dziennie',
  vsLastMonth: 'vs poprzedni miesiąc',
  topCategory: 'Największa kategoria',
  noPreviousMonth: 'Brak wydatków w poprzednim miesiącu',
};

const slices: CategorySlice[] = [
  { category: 's0', label: 'Paliwo', amount: 600, percentage: 60, color: 'var(--chart-1)' },
  { category: 'other', label: 'Pozostałe', amount: 400, percentage: 40, color: 'var(--muted-foreground)' },
];

const ranked: RankedItem[] = [
  { ...slices[0]!, icon: RiCarLine },
  { ...slices[1]!, icon: RiMoreLine },
];

const months = ['Maj', 'Cze', 'Lip', 'Sie', 'Wrz', 'Paź'];

describe('format', () => {
  it('formatZl: grosze, spacja przed „zł”, minus typograficzny, bez „−0,00”', () => {
    expect(formatZl(46)).toBe('46,00 zł');
    expect(formatZl(-1230)).toBe(`${MINUS}1230,00 zł`);
    expect(formatZl(12345.67)).toBe(`12${NBSP}345,67 zł`);
    expect(formatZl(-0.001)).toBe('0,00 zł');
    expect(formatZl(-0)).toBe('0,00 zł');
  });

  it('formatAxisMoney: skrót pl-PL bez „zł” (oś Finory ma width={48})', () => {
    expect(formatAxisMoney(0)).toBe('0');
    expect(formatAxisMoney(999)).toBe('999');
    expect(formatAxisMoney(300)).toBe('300');
    expect(formatAxisMoney(1200)).toBe(`1,2${NBSP}tys.`);
    expect(formatAxisMoney(-1200)).toBe(`${MINUS}1,2${NBSP}tys.`);
    expect(formatAxisMoney(120000)).toBe(`120${NBSP}tys.`);
    expect(formatAxisMoney(1200000)).toBe(`1,2${NBSP}mln`);
    expect(formatAxisMoney(-300)).toBe(`${MINUS}300`);
    for (const v of [0, 999, 1200, -1200, 120000, 1200000]) expect(formatAxisMoney(v)).not.toContain('zł');
  });

  // Świadoma zmiana: Analizy 1:1 z Finory (21.10.2026) — sztywne 12 znaków ucinało
  // nasze kanoniczne kategorie („Usługi fina…”), a nazwy produktów z jednostką
  // i tak zawijały legendę do 3 rzędów i zmniejszały koło. Teraz legenda bez
  // jednostki, szerokość pilnuje CSS (patrz test koła), a limit znaków to tylko
  // górna granica dla skrajnie długiego wolnego tekstu.
  it('legendLabel: bez jednostki „(…)” z końca, kanoniczne nazwy całe, skrajnie długie ucięte', () => {
    expect(PIE_LEGEND_MAX_CHARS).toBe(24);
    expect(legendLabel('Paliwo')).toBe('Paliwo');
    for (const name of ['Usługi finansowe', 'Materiały biurowe', 'Podróże służbowe', 'Telekomunikacja']) {
      expect(legendLabel(name)).toBe(name);
    }
    expect(legendLabel('Abonament serwisowy (mies.)')).toBe('Abonament serwisowy');
    expect(legendLabel('Konsultacje (godz.)  ')).toBe('Konsultacje');
    // Nawias w środku nazwy to nie jednostka — zostaje.
    expect(legendLabel('Licencja (roczna) Pro')).toBe('Licencja (roczna) Pro');
    // Sama jednostka bez nazwy — nie zostawiamy pustej legendy.
    expect(legendLabel('(szt.)')).toBe('(szt.)');
    const long = 'Bardzo długa nazwa usługi wdrożeniowej';
    expect(legendLabel(long)).toBe(`${Array.from(long).slice(0, 23).join('')}…`);
    expect(Array.from(legendLabel(long))).toHaveLength(24);
    expect(legendLabel('Telekomunikacja', 5)).toBe('Tele…');
  });

  it('legendLabels: jednostka zostaje tylko tam, gdzie bez niej dwie pozycje miałyby tę samą nazwę', () => {
    expect(legendLabels(['Konsultacje (godz.)', 'Konsultacje (szt.)', 'Abonament serwisowy (mies.)', 'Pozostałe'])).toEqual([
      'Konsultacje (godz.)',
      'Konsultacje (szt.)',
      'Abonament serwisowy',
      'Pozostałe',
    ]);
    expect(legendLabels(['Paliwo', 'Media'])).toEqual(['Paliwo', 'Media']);
    expect(legendLabels([])).toEqual([]);
  });
});

describe('costCategoryIcon (expense-category-icons Finory)', () => {
  it('nazwa kategorii → ikona Finory, bez wielkości liter i spacji na brzegach', () => {
    expect(costCategoryIcon('Reprezentacja')).toBe(RiRestaurantLine);
    expect(costCategoryIcon('materiały BIUROWE')).toBe(RiShoppingBagLine);
    expect(costCategoryIcon('  Paliwo  ')).toBe(RiCarLine);
    expect(costCategoryIcon('Podróże służbowe')).toBe(RiCarLine);
    for (const bills of ['Telekomunikacja', 'Media', 'Energia', 'Czynsz']) expect(costCategoryIcon(bills)).toBe(RiFileList3Line);
    expect(costCategoryIcon('Oprogramowanie')).toBe(RiComputerLine);
    expect(costCategoryIcon('Usługi finansowe')).toBe(RiBankLine);
    expect(costCategoryIcon('Wynagrodzenia')).toBe(RiTeamLine);
  });

  it('pozostałe i brak kategorii → „Miscellaneous” (RiMoreLine); nieznana → metka', () => {
    for (const misc of ['Pozostałe', 'Pozostałe wydatki', 'Bez kategorii']) expect(costCategoryIcon(misc)).toBe(RiMoreLine);
    expect(costCategoryIcon(null)).toBe(RiMoreLine);
    expect(costCategoryIcon('Coś zupełnie innego')).toBe(RiPriceTag3Line);
    // Wolny tekst nie może trafić w prototyp obiektu.
    expect(costCategoryIcon('constructor')).toBe(RiPriceTag3Line);
    expect(costCategoryIcon('toString')).toBe(RiPriceTag3Line);
  });
});

describe('FinoraEmpty', () => {
  it('bez akcji: dokładnie akapit Finory z podanym odstępem', () => {
    const out = html(<FinoraEmpty message="Brak wydatków w tym miesiącu" pad="py-10" />);
    expect(out).toBe('<p class="text-muted-foreground text-center text-sm py-10">Brak wydatków w tym miesiącu</p>');
  });

  it('z akcją (§7.3): ten sam odstęp i przycisk-link', () => {
    const out = html(<FinoraEmpty {...ANALIZY_EMPTY.connectKsef} pad="py-6" />);
    expect(out).toContain(ANALIZY_EMPTY.connectKsef.message);
    expect(out).toContain('href="/settings/ksef"');
    expect(out).toContain('Podłącz KSeF');
    expect(out).toMatch(/<div class="flex flex-col items-center gap-3 text-center py-6">/);
  });
});

describe('MonthlyStatsCards', () => {
  it('kwota w skrócie z pełną w title, „−8%” ze strzałką w dół, kategoria', () => {
    const out = html(
      <MonthlyStatsCards
        stats={{ totalSpend: 45600, avgDailySpend: 1520, vsLastMonthPercentage: -8.4, topCategory: 'Paliwo' }}
        labels={costLabels}
        className="md:col-span-4"
      />,
    );
    expect(out).toContain('Wydano (brutto)');
    expect(out).toContain('Średnio dziennie');
    expect(out).toContain(formatPlCompactMoney(45600));
    expect(out).toContain(`title="${formatZl(45600)}"`);
    expect(out).toContain(`title="${formatZl(1520)}"`);
    expect(out).toContain(`${MINUS}8%`);
    expect(out).toContain(iconPath(RiArrowDownLine));
    expect(out).toContain('Największa kategoria');
    expect(out).toContain('title="Paliwo"');
    expect(out).toContain('md:col-span-4');
    // Bez dopisku pod etykietą — wysokość kafla jak w Finorze.
    expect(out).not.toContain('mt-0.5 text-xs');
    // Domyślna ikona kategorii jak w Finorze.
    expect(out).toContain(iconPath(RiPriceTag3Line));
    noFinoraLeftovers(out);
  });

  it('„+12%” ze strzałką w górę; ikona czwartego kafla z propsów', () => {
    const out = html(
      <MonthlyStatsCards
        stats={{ totalSpend: 1200, avgDailySpend: 40, vsLastMonthPercentage: 12, topCategory: 'Klient A' }}
        labels={{ ...costLabels, totalSpend: 'Sprzedano (netto)', topCategory: 'Najlepszy klient' }}
        topCategoryIcon={RiUser3Line}
      />,
    );
    expect(out).toContain('+12%');
    expect(out).toContain(iconPath(RiArrowUpLine));
    expect(out).toContain(iconPath(RiUser3Line));
    expect(out).not.toContain(iconPath(RiPriceTag3Line));
  });

  it('brak poprzedniego miesiąca: „—”, ikona w obie strony i wyjaśnienie w title', () => {
    const out = html(
      <MonthlyStatsCards
        stats={{ totalSpend: 0, avgDailySpend: 0, vsLastMonthPercentage: null, topCategory: null }}
        labels={costLabels}
      />,
    );
    expect(out).toMatch(/<h4[^>]*title="Brak wydatków w poprzednim miesiącu"[^>]*>—<\/h4>/);
    expect(out).toContain(iconPath(RiArrowUpDownLine));
    expect(out).not.toContain(iconPath(RiArrowDownLine));
    expect(out).not.toContain('mt-0.5 text-xs');
  });
});

describe('SpendTrendChart', () => {
  const data: TrendDatum[] = months.map((month, i) => ({ month, amount: 100 * i }));
  const zeros: TrendDatum[] = months.map((month) => ({ month, amount: 0 }));

  it('dane: kontener recharts z klasami Finory', () => {
    const out = html(<SpendTrendChart title="Trend wydatków" description="6 mies." seriesLabel="Wydatki" data={data} className="md:col-span-2 2xl:col-span-3" />);
    expect(out).toContain('data-slot="chart"');
    expect(out).toContain('max-h-70 w-full [&amp;_.recharts-surface]:overflow-visible');
    expect(out).toContain('Trend wydatków');
    expect(out).toContain('md:col-span-2 2xl:col-span-3');
    noFinoraLeftovers(out);
  });

  it('jeden miesiąc albo same zera bez propsa empty: słupki jak w Finorze, bez pustego stanu', () => {
    const one = months.map((month, i) => ({ month, amount: i === 5 ? 1234.5 : 0 }));
    expect(html(<SpendTrendChart title="t" description="d" seriesLabel="Wydatki" data={one} />)).toContain('data-slot="chart"');
    expect(html(<SpendTrendChart title="t" description="d" seriesLabel="Wydatki" data={zeros} empty={null} />)).toContain('data-slot="chart"');
  });

  it('lista dla czytnika (WCAG 1.1.1): miesiąc i pełna kwota każdego słupka, bez zmiany wyglądu', () => {
    const out = html(<SpendTrendChart title="Trend wydatków" description="d" seriesLabel="Wydatki" data={data} />);
    const list = out.match(/<ul class="sr-only">(.*?)<\/ul>/)?.[1] ?? '';
    expect(list.match(/<li>/g)).toHaveLength(6);
    expect(list).toContain('<li>Maj: 0,00 zł</li>');
    expect(list).toContain('<li>Paź: 500,00 zł</li>');
  });

  it('empty: komunikat w pudełku o rozmiarze wykresu, bez wykresu', () => {
    const out = html(<SpendTrendChart title="Trend sprzedaży" description="d" seriesLabel="Sprzedaż" data={zeros} empty={ANALIZY_EMPTY.noInvoices} />);
    expect(out).not.toContain('data-slot="chart"');
    expect(out).not.toContain('sr-only');
    expect(out).toContain('<div class="flex aspect-video max-h-70 w-full items-center justify-center">');
    expect(out).toContain(ANALIZY_EMPTY.noInvoices.message);
    expect(out).toContain('href="/invoices/new"');
  });

  it('propsy wykresu Finory dosłownie; podpowiedź bez w-30, z pełną kwotą w złotych', () => {
    const src = code('spend-trend-chart.tsx');
    expect(src).toContain("<CartesianGrid vertical={false} strokeDasharray='5' stroke='var(--border)' />");
    expect(src).toContain("<XAxis dataKey='month' tickLine={false} tickMargin={10} axisLine={false} />");
    expect(src).toMatch(/<YAxis\s+tickLine=\{false\}\s+axisLine=\{false\}\s+tickMargin=\{10\}\s+width=\{48\}/);
    expect(src).toContain('formatAxisMoney(Number(value))');
    expect(src).toContain("<Bar dataKey='amount' fill='var(--color-amount)' radius={4} />");
    expect(src).toContain("amount: { label: seriesLabel, color: 'var(--chart-1)' }");
    expect(src).toContain('<ChartTooltip');
    expect(src).toContain('cursor={false}');
    expect(src).toContain('formatZl(Number(value))');
    expect(src).not.toContain('w-30');
    expect(src).not.toContain('hideLabel');
  });
});

describe('CategoryBreakdownChart', () => {
  it('dane: kontener Finory i lista dla czytnika z kwotą i udziałem', () => {
    const out = html(<CategoryBreakdownChart title="Wydatki według kategorii" description="d" data={slices} empty={ANALIZY_EMPTY.connectKsef} className="md:max-2xl:col-span-2" />);
    expect(out).toContain('data-slot="chart"');
    expect(out).toContain('mx-auto aspect-square max-h-70');
    expect(out).toContain('md:max-2xl:col-span-2');
    expect(out).toMatch(/<ul class="sr-only">.*Paliwo: 600,00 zł \(60%\).*Pozostałe: 400,00 zł \(40%\)/);
    // Kolory serii z danych (adapter): miejsce w rankingu → chart-N, „Pozostałe” → muted-foreground.
    expect(out).toContain('--color-s0: var(--chart-1);');
    expect(out).toContain('--color-other: var(--muted-foreground);');
    noFinoraLeftovers(out);
  });

  it('pusto: akapit Finory py-10 z akcją z §7.3, bez wykresu', () => {
    const out = html(<CategoryBreakdownChart title="Wydatki według kategorii" description="d" data={[]} empty={ANALIZY_EMPTY.connectKsef} />);
    expect(out).not.toContain('data-slot="chart"');
    expect(out).toContain('py-10');
    expect(out).toContain(ANALIZY_EMPTY.connectKsef.message);
    expect(out).toContain('href="/settings/ksef"');
    const plain = html(<CategoryBreakdownChart title="t" description="d" data={[]} empty={ANALIZY_EMPTY.noCostsThisMonth} />);
    expect(plain).toContain(`<p class="text-muted-foreground text-center text-sm py-10">${ANALIZY_EMPTY.noCostsThisMonth.message}</p>`);
  });

  it('propsy wykresu Finory dosłownie; podpowiedź tylko z kwotą', () => {
    const src = code('category-breakdown-chart.tsx');
    expect(src).toContain("<Pie data={data} dataKey='amount' nameKey='category' innerRadius={60} strokeWidth={2}>");
    expect(src).toContain('fill={`var(--color-${entry.category})`}');
    // Świadoma zmiana: Analizy 1:1 z Finory (21.10.2026) — klasy Finory zostają,
    // dochodzą tylko klasy pozycji legendy: pozycja ma naturalną szerokość, ale do
    // podziału na rzędy liczy się najwyżej jako 1/3 szerokości (minus dwa odstępy
    // gap-x-4), więc 6 pozycji zawsze mieści się w 2 rzędach i koło nie maleje.
    expect(src).toContain(
      "<ChartLegendContent nameKey='category' className={cn('flex-wrap gap-x-4 gap-y-1', LEGEND_ITEM_FIT)} />",
    );
    expect(src).toContain("'*:min-w-0 *:max-w-max *:grow *:basis-[calc((100%-var(--spacing)*8)/3-1px)]'");
    expect(src).toContain('<ChartTooltipContent hideLabel formatter={value => formatZl(Number(value))} />');
    expect(src).toContain('legendLabels(data.map(slice => slice.label))');
    // Ucięta nazwa w legendzie ma pełną w `title` (wzrokowo, nie tylko dla czytnika).
    expect(src).toContain("<span className='truncate' title={slice.label}>");
  });
});

describe('CategoryRankedList', () => {
  it('ikona z danych, nazwa, kwota w złotych, pasek Finory z aria-label', () => {
    const out = html(<CategoryRankedList title="Największe kategorie" description="d" data={ranked} empty={ANALIZY_EMPTY.noCostsThisMonth} className="md:col-span-2" />);
    expect(out).toContain('<div data-slot="card-content" class="px-(--card-spacing) space-y-4">');
    expect(out).toContain('class="flex items-center gap-4"');
    expect(out).toContain('bg-muted flex size-10 shrink-0 items-center justify-center rounded-full');
    expect(out).toContain('*:data-[slot=progress-track]:h-1.5');
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-label="Paliwo: 60%"');
    expect(out).toContain('600,00 zł');
    expect(out).toContain('title="Paliwo"');
    expect(out).toContain(iconPath(RiCarLine));
    expect(out).toContain(iconPath(RiMoreLine));
    noFinoraLeftovers(out);
  });

  it('pusto: akapit Finory py-6', () => {
    const out = html(<CategoryRankedList title="Najlepsze produkty i usługi" description="d" data={[]} empty={ANALIZY_EMPTY.noProducts} />);
    expect(out).toContain(`<p class="text-muted-foreground text-center text-sm py-6">${ANALIZY_EMPTY.noProducts.message}</p>`);
    expect(out).not.toContain('role="progressbar"');
  });
});

describe('RecentExpensesFeed', () => {
  const item = (amount: number, merchant = 'Stacja Paliw'): FeedItem => ({
    id: merchant,
    merchant,
    subtitle: '05.10.2026',
    amount,
    icon: RiReceiptLine,
  });

  it("'out', kwota dodatnia: strzałka w dół, destructive (jak w Finorze)", () => {
    const out = html(<RecentExpensesFeed title="Ostatnie wydatki" description="d" direction="out" data={[item(200)]} empty={ANALIZY_EMPTY.noCostsThisMonth} />);
    expect(out).toContain('Stacja Paliw');
    expect(out).toContain('05.10.2026');
    expect(out).toContain('200,00 zł');
    expect(out).toContain('text-destructive');
    expect(out).not.toContain('text-green-700');
    expect(out).toContain(iconPath(RiArrowDownLine));
    expect(out).not.toContain(iconPath(RiArrowUpLine));
    expect(out).toContain(iconPath(RiReceiptLine));
    noFinoraLeftovers(out);
  });

  it("'out', korekta zakupu in minus: strzałka w górę, zielony, minus typograficzny", () => {
    const out = html(<RecentExpensesFeed title="Ostatnie wydatki" description="d" direction="out" data={[item(-50, 'Dostawca')]} empty={ANALIZY_EMPTY.noCostsThisMonth} />);
    expect(out).toContain(`${MINUS}50,00 zł`);
    expect(out).not.toContain('-50,00 zł');
    expect(out).toContain('text-green-700');
    expect(out).not.toContain('text-destructive');
    expect(out).toContain(iconPath(RiArrowUpLine));
    expect(out).not.toContain(iconPath(RiArrowDownLine));
  });

  it("'in', faktura: strzałka w górę, zielony", () => {
    const out = html(<RecentExpensesFeed title="Ostatnie faktury" description="d" direction="in" data={[item(1230, 'Klient')]} empty={ANALIZY_EMPTY.noSalesThisMonth} />);
    expect(out).toContain('1230,00 zł');
    expect(out).toContain('text-green-700');
    expect(out).not.toContain('text-destructive');
    expect(out).toContain(iconPath(RiArrowUpLine));
  });

  it("'in', korekta sprzedaży in minus: strzałka w dół, destructive, minus typograficzny", () => {
    const out = html(<RecentExpensesFeed title="Ostatnie faktury" description="d" direction="in" data={[item(-1230, 'Klient')]} empty={ANALIZY_EMPTY.noSalesThisMonth} />);
    expect(out).toContain(`${MINUS}1230,00 zł`);
    expect(out).not.toContain('-1230,00 zł');
    expect(out).toContain('text-destructive');
    expect(out).not.toContain('text-green-700');
    expect(out).toContain(iconPath(RiArrowDownLine));
    expect(out).not.toContain(iconPath(RiArrowUpLine));
  });

  it('druga linia z samą datą: akapit Finory (ucięty z pełnym tekstem w title)', () => {
    const out = html(<RecentExpensesFeed title="Ostatnie wydatki" description="d" direction="out" data={[item(200)]} empty={ANALIZY_EMPTY.noCostsThisMonth} />);
    expect(out).toContain('<p class="text-muted-foreground truncate text-xs" title="05.10.2026">05.10.2026</p>');
  });

  // Na telefonie i przy dwóch kolumnach druga linia faktury („[Korekta · ]numer ·
  // data”) się nie mieści; ucina się numer, data (jedyne, co Finora tu pokazuje)
  // zostaje widoczna — w obu kolejnościach, jakie może dać adapter.
  it.each([
    ['numer · data', 'FV/2026/10/0001 · 21.10.2026', ['FV/2026/10/0001'], '21.10.2026', []],
    ['Korekta · numer · data', 'Korekta · KOR/1 · 08.10.2026', ['Korekta · KOR/1'], '08.10.2026', []],
    ['data · Korekta · numer', '08.10.2026 · Korekta · KOR/1', [], '08.10.2026', ['Korekta · KOR/1']],
  ])('faktura (%s): data w nieściśliwym fragmencie, reszta ucięta', (_case, subtitle, before, date, after) => {
    const out = html(<RecentExpensesFeed title="Ostatnie faktury" description="d" direction="in" data={[{ ...item(100, 'Klient'), subtitle }]} empty={ANALIZY_EMPTY.noSalesThisMonth} />);
    const line = out.match(/<p class="text-muted-foreground flex min-w-0 text-xs" title="([^"]*)">(.*?)<\/p>/);
    expect(line?.[1]).toBe(subtitle);
    const body = line?.[2] ?? '';
    expect(body).toContain(`<span class="shrink-0">${date}</span>`);
    for (const part of [...before, ...after]) expect(body).toContain(`<span class="truncate">${part}</span>`);
    expect(body.match(/<span class="truncate">/g) ?? []).toHaveLength(before.length + after.length);
    // Separator z zachowanymi spacjami — w flexie spacja na brzegu fragmentu by zniknęła.
    expect(body).toContain('<span class="shrink-0 whitespace-pre" aria-hidden="true"> · </span>');
    // Czytnik słyszy całość w kolejności (separatory pomija, fragmenty czyta po kolei).
    expect(tekstBezZnacznikow(body.replace(/<span class="shrink-0 whitespace-pre" aria-hidden="true"> · <\/span>/g, ' · '))).toBe(subtitle);
  });

  it('pusto: akapit py-6 z akcją z §7.3', () => {
    const out = html(<RecentExpensesFeed title="Ostatnie faktury" description="d" direction="in" data={[]} empty={ANALIZY_EMPTY.noSalesThisMonth} />);
    expect(out).toContain(ANALIZY_EMPTY.noSalesThisMonth.message);
    expect(out).toContain('href="/invoices/new"');
    expect(out).toContain('py-6');
  });
});

describe('SpendingStreaksCard i IncomeExpenseSummary', () => {
  it('wiersze Finory: space-y-2, bg-muted p-3, ikona size-6', () => {
    const out = html(<SpendingStreaksCard title="VAT z wydatków" description="d" className="md:col-span-2"
      rows={[{ icon: RiReceiptLine, iconClassName: 'text-foreground', title: 'VAT naliczony', value: '23,00 zł' }]} />);
    expect(out).toContain('<div data-slot="card-content" class="px-(--card-spacing) space-y-2">');
    expect(out).toContain('class="bg-muted flex items-center gap-3 p-3"');
    expect(out).toContain('size-6 shrink-0 text-foreground');
    expect(out).toContain('VAT naliczony');
    expect(out).toContain('23,00 zł');
    noFinoraLeftovers(out);
  });

  it('przychody a koszty: ten sam układ, kwoty w złotych, ujemny wynik z minusem typograficznym', () => {
    const out = html(<IncomeExpenseSummary data={{ income: 1000, expense: 1500.5, net: -500.5 }} />);
    expect(out).toContain('Przychody a koszty');
    // E10 (D-K): koszty z faktur z KSeF i wydatków — ta sama długość napisu co dawny „koszty jak w KPiR”.
    expect(out).toContain('Netto · z KSeF i wydatków, bez VAT do odliczenia');
    expect(out).toContain('class="bg-muted flex items-center gap-3 p-3"');
    expect(out).toContain('Przychody');
    expect(out).toContain('Koszty');
    expect(out).toContain('Wynik (netto)');
    expect(out).toContain('1000,00 zł');
    expect(out).toContain('1500,50 zł');
    expect(out).toContain(`${MINUS}500,50 zł`);
    expect(out).toContain('text-green-700');
    expect(out).not.toContain('text-green-600');
  });
});

describe('SubscriptionsCard', () => {
  const base: SubscriptionItem = {
    id: 'k1',
    name: 'Hosting sp. z o.o.',
    icon: RiRepeatLine,
    amount: 123,
    renewsLabel: 'Zwykle ok. 11. dnia miesiąca',
    billingCycle: 'Średnio / mies.',
  };

  it('wiersz Finory bez logo: ikona, nazwa, typowy dzień, średnia', () => {
    const out = html(<SubscriptionsCard title="Stałe koszty" description="d" data={[base]} empty={ANALIZY_EMPTY.noRecurringSuppliers} />);
    expect(out).toContain('bg-muted flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full');
    expect(out).toContain('Hosting sp. z o.o.');
    expect(out).toContain('Zwykle ok. 11. dnia miesiąca');
    expect(out).toContain('123,00 zł');
    expect(out).toContain('Średnio / mies.');
    expect(out).not.toContain('capitalize');
    expect(out).not.toContain('Zrób fakturę cykliczną');
    expect(out).not.toContain('<img');
    expect(out).toContain(iconPath(RiRepeatLine));
    // Bez akcji druga linia to dokładnie akapit Finory.
    expect(out).toContain('<p class="text-muted-foreground text-xs">Zwykle ok. 11. dnia miesiąca</p>');
    expect(out).toContain('title="Hosting sp. z o.o."');
    noFinoraLeftovers(out);
  });

  it('akcja w tej samej linii: href, aria-label, dokładnie jeden link na wiersz', () => {
    const out = html(<SubscriptionsCard title="Stali klienci" description="d" empty={ANALIZY_EMPTY.noRecurringClients}
      data={[
        { ...base, id: 'c1', name: 'Klient A', action: { href: '/invoices/recurring?wzor=inv-1', label: 'Zrób fakturę cykliczną', ariaLabel: 'Zrób fakturę cykliczną dla: Klient A' } },
        { ...base, id: 'c2', name: 'Konsumenci', action: null },
      ]} />);
    expect(out).toContain('href="/invoices/recurring?wzor=inv-1"');
    expect(out).toContain('aria-label="Zrób fakturę cykliczną dla: Klient A"');
    expect(out.match(/Zrób fakturę cykliczną</g)).toHaveLength(1);
    // Świadoma zmiana: Analizy 1:1 z Finory (21.10.2026) — „Zwykle ok. N. dnia
    // miesiąca · Zrób fakturę cykliczną” (~273 px) zawijało się do trzeciej linii
    // na telefonie i przy dwóch kolumnach (karta 448,8 px zamiast 367,2 px).
    // Druga linia jest teraz jednym rzędem flex: link nieściśliwy, typowy dzień
    // ucina się, a w wąskiej kolumnie (<15rem, zapytanie kontenera) znika
    // z widoku (zostaje dla czytnika i w title nazwy) — wiersz ma zawsze 2 linie.
    expect(out).toMatch(/<div class="@container min-w-0 flex-1">/);
    expect(out).toContain('<p class="text-muted-foreground flex min-w-0 text-xs">');
    expect(out).toContain('<span class="truncate @max-[15rem]:sr-only">Zwykle ok. 11. dnia miesiąca</span>');
    expect(out).toContain('<span class="shrink-0 whitespace-pre @max-[15rem]:hidden" aria-hidden="true"> · </span>');
    expect(out).toMatch(/<p class="text-muted-foreground flex min-w-0 text-xs"><span[^>]*>Zwykle ok\. 11\. dnia miesiąca<\/span><span[^>]*> · <\/span><a [^>]*>Zrób fakturę cykliczną<\/a><\/p>/);
    expect(out).toContain('title="Klient A · Zwykle ok. 11. dnia miesiąca"');
    // Wiersz bez akcji w tej samej karcie — akapit Finory.
    expect(out).toContain('title="Konsumenci"');
    expect(out).toContain('<p class="text-muted-foreground text-xs">Zwykle ok. 11. dnia miesiąca</p>');
  });

  // WCAG 1.4.1: link w szarym zdaniu różni się od niego tylko odcieniem (kontrast
  // luminancji ~1,05:1), a podkreślenie tylko pod myszą nie działa na dotyku.
  it('link akcji zawsze podkreślony i nieściśliwy, bez dodatkowej wysokości', () => {
    const out = html(<SubscriptionsCard title="Stali klienci" description="d" empty={ANALIZY_EMPTY.noRecurringClients}
      data={[{ ...base, id: 'c1', name: 'Klient A', action: { href: '/invoices/recurring?wzor=inv-1', label: 'Zrób fakturę cykliczną', ariaLabel: 'Zrób fakturę cykliczną dla: Klient A' } }]} />);
    const cls = out.match(/<a [^>]*class="([^"]*)"[^>]*>Zrób fakturę cykliczną<\/a>/)?.[1] ?? '';
    expect(cls.split(' ')).toEqual(expect.arrayContaining(['underline', 'decoration-primary/50', 'hover:decoration-primary', 'shrink-0', 'whitespace-nowrap']));
    expect(cls.split(' ')).not.toContain('hover:underline');
    expect(cls).not.toMatch(/(^|\s)(min-h|py|h)-/);
  });

  it('pusto: komunikat N3 w akapicie py-6', () => {
    const out = html(<SubscriptionsCard title="Stali klienci" description="d" data={[]} empty={ANALIZY_EMPTY.noRecurringClients} />);
    expect(out).toContain(`<p class="text-muted-foreground text-center text-sm py-6">${ANALIZY_EMPTY.noRecurringClients.message}</p>`);
  });
});

describe('SpendHeatmap', () => {
  const days = [
    { date: '2026-10-19', amount: 0 },
    { date: '2026-10-20', amount: 50 },
    { date: '2026-10-21', amount: 120 },
  ];

  it('komórki Finory size-3.75 rounded-sm, tydzień od poniedziałku, dostępność', () => {
    const out = html(<SpendHeatmap title="Kalendarz wydatków" description="d" data={days} className="md:col-span-2" />);
    expect(out).toContain('size-3.75 rounded-sm bg-muted');
    expect(out).toContain('size-3.75 rounded-sm bg-chart-1');
    expect(out).toContain('class="flex flex-col gap-3.5"');
    expect(out).toContain('text-muted-foreground flex size-3.75 items-center justify-center text-xs leading-none');
    expect(out).toContain('title="poniedziałek"');
    expect(out).toContain('aria-hidden="true"');
    // Przewijany w bok kontener osiągalny klawiaturą (WCAG 2.1.1, axe `scrollable-region-focusable`).
    expect(out).toMatch(/<div(?=[^>]*role="region")(?=[^>]*aria-label="Kalendarz wydatków")(?=[^>]*tabindex="0")[^>]*overflow-x-auto/);
    expect(out).toContain('focus-visible:ring-[3px]');
    expect(out).toMatch(/role="img" aria-label="20\.10\.2026 — 50,00 zł"/);
    expect(out).toContain('aria-label="19.10.2026 — 0,00 zł"');
    noFinoraLeftovers(out);
  });

  it('same zera bez propsa empty: siatka i tak się rysuje (jak w Finorze)', () => {
    const zeros = days.map((d) => ({ ...d, amount: 0 }));
    const out = html(<SpendHeatmap title="Kalendarz sprzedaży" description="d" data={zeros} empty={null} />);
    expect(out).toContain('role="region"');
    expect(out).toContain('aria-label="21.10.2026 — 0,00 zł"');
    expect(out).not.toContain('bg-chart-1');
  });

  it('empty: akapit py-10 zamiast siatki', () => {
    const out = html(<SpendHeatmap title="Kalendarz wydatków" description="d" data={days} empty={ANALIZY_EMPTY.connectKsef} />);
    expect(out).toContain(ANALIZY_EMPTY.connectKsef.message);
    expect(out).toContain('href="/settings/ksef"');
    expect(out).toContain('py-10');
    expect(out).not.toContain('role="region"');
    expect(out).not.toContain('aria-label="20.10.2026');
  });
});

describe('kopie 1:1', () => {
  const files = [
    'monthly-stats-cards.tsx',
    'spend-trend-chart.tsx',
    'category-breakdown-chart.tsx',
    'category-ranked-list.tsx',
    'recent-expenses-feed.tsx',
    'spending-streaks-card.tsx',
    'income-expense-summary.tsx',
    'subscriptions-card.tsx',
    'spend-heatmap.tsx',
    'expense-category-icons.tsx',
  ];

  it.each(files)('%s: nagłówek kopii z Finory i bez nowych zależności', (file) => {
    const src = source(file);
    expect(src).toContain(`// Kopia 1:1 z finora-src/src/views/pages/money-management/monthly-analytics/${file}`);
    expect(src).toContain('Odstępstwa:');
    expect(src).not.toMatch(/from 'date-fns'|from 'nuqs'|from 'next\/image'/);
    expect(src).not.toContain('@/components/analizy/finora/');
  });

  it("'use client' tylko w kartach z wykresem albo podpowiedzią (trend, koło, kalendarz)", () => {
    const client = new Set(['spend-trend-chart.tsx', 'category-breakdown-chart.tsx', 'spend-heatmap.tsx']);
    for (const file of files) {
      const isClient = source(file).startsWith("'use client'");
      expect([file, isClient]).toEqual([file, client.has(file)]);
    }
  });
});
