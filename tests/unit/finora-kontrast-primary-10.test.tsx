import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RiFileList3Line, RiSmartphoneLine } from '@remixicon/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * Plan Finora §7 (WCAG 2.1 AA, axe w e2e 06) — TEKST na tle `bg-primary/10`
 * (i ciemnym `dark:bg-primary/20|25`, i pod kursorem `hover:bg-primary/20`)
 * musi mieć ≥ 4,5:1 (1.4.3). Finora pisze na tym tle `text-primary`, co daje
 * 4,44:1 w jasnym motywie i 3,76:1 w ciemnym na `primary/25`. Ikony na tym
 * samym tle (AvatarFallback, kwadraty z ikoną) podlegają 1.4.11 (3:1) i tu ich
 * nie sprawdzamy — elementy z `data-slot="avatar-fallback"` są pomijane.
 *
 * Klasy czytamy z renderowanego znacznika: każdy element z `bg-primary/10`
 * w wyniku renderu komponentu (poza ikonami) to tekst, którego kontrast
 * liczymy w obu motywach, w spoczynku i — gdy klasy zmieniają tło lub kolor
 * pod kursorem — w stanie hover.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

import { InvoicesPagination } from '@/app/(dashboard)/invoices/_components/invoices-pagination';
import StatisticsCard from '@/components/dashboard/finora/statistics-card-03';
import UserDatatable, { type Item } from '@/components/dashboard/finora/datatable-user';
import TopProductsCard from '@/components/dashboard/finora/widget-top-products';
import { StatTile } from '@/components/dashboard/pulpit/stat-tile';
import { TopListsCard } from '@/components/dashboard/pulpit/top-lists-card';
import { TransactionDatatable as ExpensesTransactionDatatable } from '@/components/expenses/finora/transaction-datatable';
import { KpirView, type KpirExpenseRow } from '@/components/expenses/kpir-view';
import TransactionDatatable from '@/components/przeplywy/finora/datatable-transaction';
import { VatStatusBadge } from '@/components/validation/vat-status-badge';
import type { CashFlowOperation } from '@/lib/dashboard/cash-movements';
import { parseInvoiceListParams } from '@/lib/invoices/list-query';

import { THEME_NAMES, color, contrast, oklch, over, rowBackgrounds, themes, type Rgb, type Theme } from './helpers/kontrast';

/** Pełne escapowanie znaków specjalnych wyrażenia regularnego (CodeQL js/incomplete-sanitization). */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type Layer = { token: string; alpha: number };
type Variant = '' | 'dark:' | 'hover:' | 'dark:hover:';

/** `text-…` / `bg-…[/NN]` z danym prefiksem wariantu; klasy, które nie są kolorem (`text-xs`), pomijamy. */
function layers(classes: string, variant: Variant, theme: Theme): { text?: Layer; bg?: Layer } {
  const re = new RegExp(`(?:^|\\s)${escapeRegExp(variant)}(text|bg)-([a-z0-9-]+?)(?:/(\\d+))?(?=\\s|$)`, 'g');
  const found: { text?: Layer; bg?: Layer } = {};
  for (const m of classes.matchAll(re)) {
    try {
      color(m[2], theme);
    } catch {
      continue;
    }
    found[m[1] as 'text' | 'bg'] = { token: m[2], alpha: m[3] ? Number(m[3]) / 100 : 1 };
  }
  return found;
}

/**
 * Kombinacje (tekst, tło) dla motywu i stanu. Ciemny motyw: `dark:*` nadpisuje
 * jasne klasy. Ciemny hover: `dark:hover:*`, a gdy go nie ma — sprawdzamy
 * KAŻDĄ z klas `hover:*` i `dark:*` (kolejność reguł w CSS nie jest tu pewna).
 */
function combos(classes: string, name: string, hover: boolean): Array<{ text: Layer; bg: Layer }> {
  const theme = themes[name as keyof typeof themes];
  const get = (v: Variant) => layers(classes, v, theme);
  const pick = (kind: 'text' | 'bg', order: Variant[][]): Layer[] => {
    for (const group of order) {
      const hits = group.map((v) => get(v)[kind]).filter((x): x is Layer => Boolean(x));
      if (hits.length) return hits;
    }
    return [];
  };
  const dark = name === 'ciemny';
  const order: Variant[][] = hover
    ? dark
      ? [['dark:hover:'], ['hover:', 'dark:'], ['']]
      : [['hover:'], ['']]
    : dark
      ? [['dark:'], ['']]
      : [['']];
  const texts = pick('text', order);
  const bgs = pick('bg', order);
  return texts.flatMap((text) => bgs.map((bg) => ({ text, bg })));
}

/** Elementy z `bg-primary/10` w znaczniku, bez ikon (AvatarFallback). */
function textElements(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<[a-z]+\b([^>]*)>/g)) {
    const attrs = m[1];
    const cls = /\sclass="([^"]*)"/.exec(attrs)?.[1];
    if (!cls || !/(?:^|\s)bg-primary\/10(?=\s|$)/.test(cls)) continue;
    if (attrs.includes('data-slot="avatar-fallback"')) continue;
    out.push(cls);
  }
  return out;
}

type Base = 'karta' | 'wiersze tabeli';

function bases(theme: Theme, base: Base): Record<string, Rgb> {
  return base === 'karta' ? { karta: oklch(theme['--card']) } : rowBackgrounds(theme);
}

const operation = (n: number): CashFlowOperation => ({
  id: `in:${n}`, direction: 'in', date: '2026-10-12', counterparty: `Klient ${n}`, nip: '1', reference: `FV/${n}`,
  category: 'Sprzedaż', status: 'paid', amount: 100 + n, href: `/invoices/${n}`,
});

const user = (n: number): Item => ({
  id: `u${n}`, avatar: '', fallback: 'JK', user: `Użytkownik ${n}`, email: `u${n}@example.com`,
  role: 'admin', plan: 'basic', billing: 'auto-debit', status: 'active',
});

const koszt = {
  id: 'exp', issue_date: '2026-09-03', seller_name: 'Dostawca', seller_nip: '1234567890', document_number: 'ZAK/7',
  category_label: 'Paliwo', kpir_column: 'col_13', is_deductible: true, net_amount: 1000, vat_amount: 230,
  gross_amount: 1230, vat_deductible_amount: 230, document_type: 'receipt',
} as KpirExpenseRow;

type Row = { name: string };

const CASES: Array<{ place: string; base: Base; node: ReactElement }> = [
  {
    place: 'app/(dashboard)/invoices/_components/invoices-pagination.tsx (numer strony)',
    base: 'karta',
    node: <InvoicesPagination params={parseInvoiceListParams({ strona: '5', na_stronie: '10' })} total={100} />,
  },
  {
    place: 'components/expenses/kpir-view.tsx (plakietka „Kol. 13”)',
    base: 'wiersze tabeli',
    node: <KpirView month={9} year={2026} invoices={[]} expenses={[koszt]} />,
  },
  {
    place: 'components/expenses/finora/transaction-datatable.tsx (numer strony)',
    base: 'karta',
    node: (
      <ExpensesTransactionDatatable<Row>
        data={Array.from({ length: 12 }, (_, i) => ({ name: `Wiersz ${i}` }))}
        columns={[{ accessorKey: 'name', header: 'Nazwa' }]}
        filters={[]}
        searchId="szukaj"
        searchPlaceholder="Szukaj"
        searchText={(r) => r.name}
        pageSize={5}
      />
    ),
  },
  {
    place: 'components/dashboard/pulpit/top-lists-card.tsx (plakietka „nowy”)',
    base: 'karta',
    node: (
      <TopListsCard
        productsNote="n"
        products={[]}
        clients={[{ key: 'c', name: 'Konsumenci', nip: null, consumers: true, net: 300, changePct: null }]}
      />
    ),
  },
  {
    place: 'components/dashboard/pulpit/stat-tile.tsx (plakietka)',
    base: 'karta',
    node: <StatTile icon={RiFileList3Line} title="Faktury" value="12" badge="Ten miesiąc" change={null} />,
  },
  {
    place: 'components/dashboard/finora/widget-top-products.tsx (plakietka procentu)',
    base: 'karta',
    node: (
      <TopProductsCard
        salesTitle="Sprzedaż"
        productsBySalesData={[]}
        volumeTitle="Ilość"
        productsByVolumeData={[
          { icon: <RiSmartphoneLine />, productName: 'Produkt', productBrand: 'Marka', volume: '200', changePercentage: 5 },
        ]}
      />
    ),
  },
  {
    place: 'components/dashboard/finora/datatable-user.tsx (numer strony)',
    base: 'karta',
    node: <UserDatatable data={Array.from({ length: 12 }, (_, i) => user(i))} />,
  },
  {
    place: 'components/dashboard/finora/statistics-card-03.tsx (plakietka)',
    base: 'karta',
    node: (
      <StatisticsCard icon={<RiFileList3Line />} changePct={5} value="12" title="Faktury" badgeContent="Ten miesiąc" />
    ),
  },
  {
    place: 'components/przeplywy/finora/datatable-transaction.tsx (numer strony)',
    base: 'karta',
    node: <TransactionDatatable data={Array.from({ length: 12 }, (_, i) => operation(i))} />,
  },
  {
    place: 'components/validation/vat-status-badge.tsx (plakietka „Zwolniony VAT”)',
    base: 'wiersze tabeli',
    node: <VatStatusBadge status="exempt" />,
  },
];

describe('Tekst na `bg-primary/10` — kontrast ≥ 4,5:1 w obu motywach (WCAG 1.4.3)', () => {
  for (const { place, base, node } of CASES) {
    describe(place, () => {
      const elements = textElements(renderToStaticMarkup(node));

      it('render zawiera element z tekstem na `bg-primary/10`', () => {
        expect(elements.length).toBeGreaterThan(0);
      });

      it.each(THEME_NAMES)('motyw %s: spoczynek i hover ≥ 4,5:1', (name) => {
        const theme = themes[name];
        for (const classes of elements) {
          const hoverChanges = /(?:^|\s)(?:dark:)?hover:(?:bg|text)-/.test(classes);
          for (const [state, hover] of [['spoczynek', false], ...(hoverChanges ? [['hover', true]] : [])] as Array<[string, boolean]>) {
            for (const { text, bg } of combos(classes, name, hover)) {
              for (const [baseName, under] of Object.entries(bases(theme, base))) {
                const ratio = contrast(color(text.token, theme), over(color(bg.token, theme), bg.alpha, under));
                expect(
                  ratio,
                  `${name}, ${state}, ${baseName}: text-${text.token} na ${bg.token}/${Math.round(bg.alpha * 100)} = ${ratio.toFixed(2)}`,
                ).toBeGreaterThanOrEqual(4.5);
              }
            }
          }
        }
      });
    });
  }
});
