// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  getCoreRowModel,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): wspólne
 * części ekranów KPiR i Eksport — rząd zakładek „Księgowość”, przełącznik
 * segmentowy z Finory, przełącznik miesiąca w adresie KPiR (`?month=&year=`)
 * i kolejność filtra kolumny KPiR (7 przed 10).
 */

const router = vi.hoisted(() => ({ push: vi.fn() }));
// Testy KPiR mockują tylko `push` — wspólne części nie mogą sięgać po nic więcej.
vi.mock('next/navigation', () => ({ useRouter: () => router }));

import { KSIEGOWOSC_TABS, KsiegowoscTabs } from '@/components/reports/ksiegowosc-tabs';
import { SegmentedControl, type SegmentedOption } from '@/components/reports/segmented-control';
import MonthSelector from '@/components/expenses/finora/month-selector';
import { ColumnSelectFilter, FinoraListCard } from '@/components/lists/finora-data-table';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  router.push.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
});

async function mount(node: ReactNode): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(node);
  });
  return host;
}

/** Base UI Select: otwieramy listę prawdziwym triggerem (jak w `korekta-ue-formularz`). */
async function openSelect(trigger: HTMLElement): Promise<HTMLElement[]> {
  await act(async () => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    }
  });
  return [...document.body.querySelectorAll<HTMLElement>('[role="option"]')];
}

function combobox(el: HTMLElement, label: string): HTMLElement {
  const trigger = el.querySelector<HTMLElement>(`[role="combobox"][aria-label="${label}"]`);
  expect(trigger, `brak pola „${label}”`).not.toBeNull();
  return trigger!;
}

describe('KsiegowoscTabs', () => {
  it('dwie zakładki-linki w nawigacji „Księgowość”, aria-current na aktywnej', () => {
    expect(KSIEGOWOSC_TABS.map((t) => [t.value, t.label, t.href])).toEqual([
      ['kpir', 'KPiR', '/reports/kpir'],
      ['eksport', 'Eksport', '/reports/exports'],
    ]);
    for (const [active, current] of [
      ['kpir', '/reports/kpir'],
      ['eksport', '/reports/exports'],
    ] as const) {
      const html = renderToStaticMarkup(<KsiegowoscTabs active={active} />);
      expect(html).toContain('<nav aria-label="Księgowość"');
      const links = [...html.matchAll(/<a([^>]*)>([^<]*)<\/a>/g)].map(([, attrs, text]) => ({
        href: /href="([^"]*)"/.exec(attrs!)![1],
        current: attrs!.includes('aria-current="page"'),
        text,
      }));
      expect(links.map((l) => [l.text, l.href])).toEqual([
        ['KPiR', '/reports/kpir'],
        ['Eksport', '/reports/exports'],
      ]);
      expect(links.filter((l) => l.current).map((l) => l.href)).toEqual([current]);
    }
  });

  it('bez hooków i bez „use client” — rysują go page, loading i error', () => {
    const source = readFileSync(join(process.cwd(), 'components/reports/ksiegowosc-tabs.tsx'), 'utf8');
    // Dyrektywa to osobna linia; wzmianka w komentarzu się nie liczy.
    expect(source).not.toMatch(/^\s*['"]use client['"];?\s*$/m);
    expect(source).not.toMatch(/\buse[A-Z]\w*\(/);
  });
});

type View = 'all' | 'revenue' | 'check';
const VIEW_OPTIONS: readonly SegmentedOption<View>[] = [
  { value: 'all', label: 'Wszystko', count: 12 },
  { value: 'revenue', label: 'Przychody', count: 5 },
  { value: 'check', label: 'Do sprawdzenia', shortLabel: 'Sprawdź', count: 2 },
];

describe('SegmentedControl', () => {
  it('grupa radiowa z aria-label, licznikami i krótką etykietą na telefon', () => {
    const html = renderToStaticMarkup(
      <SegmentedControl ariaLabel="Rodzaj wpisu" value="revenue" onValueChange={() => {}} options={VIEW_OPTIONS} />,
    );
    expect(html).toMatch(/<div[^>]*role="radiogroup"[^>]*>/);
    expect(/<div([^>]*role="radiogroup"[^>]*)>/.exec(html)![1]).toContain('aria-label="Rodzaj wpisu"');
    expect(html).toContain('bg-muted text-muted-foreground inline-flex h-9 w-full items-center gap-0 p-1 sm:w-fit');
    for (const count of [12, 5, 2]) {
      expect(html).toContain(`<span class="ml-1.5 tabular-nums max-sm:hidden">${count}</span>`);
    }
    expect(html).toContain('<span class="sm:hidden">Sprawdź</span><span class="max-sm:hidden">Do sprawdzenia</span>');
    // Licznik dziedziczy kolor segmentu — bez przyciemniania (kontrast).
    expect(html).not.toMatch(/tabular-nums[^"]*opacity-/);
  });

  it('zaznaczenie widać w SSR: data-checked na elemencie „peer” przed etykietą, for → id ukrytego inputu', () => {
    const html = renderToStaticMarkup(
      <SegmentedControl ariaLabel="Rodzaj wpisu" value="revenue" onValueChange={() => {}} options={VIEW_OPTIONS} />,
    );
    const radios = [...html.matchAll(/<span([^>]*role="radio"[^>]*)>/g)].map(([, attrs]) => attrs!);
    expect(radios).toHaveLength(3);
    const checked = radios.filter((attrs) => attrs.includes('aria-checked="true"'));
    expect(checked).toHaveLength(1);
    // `peer-data-checked:` z Finory wymaga atrybutu `data-checked` na elemencie z klasą `peer`.
    expect(checked[0]).toContain('data-checked=""');
    expect(checked[0]).toMatch(/class="[^"]*\bpeer\b[^"]*"/);
    for (const attrs of radios.filter((a) => a.includes('aria-checked="false"'))) {
      expect(attrs).not.toContain('data-checked=""');
    }
    // Każda opcja: span.peer → ukryty input → etykieta (selektor `~` łapie tylko następne rodzeństwo).
    const items = [...html.matchAll(/<div class="relative h-full grow">([\s\S]*?)<\/label><\/div>/g)].map(
      ([, inner]) => inner!,
    );
    expect(items).toHaveLength(3);
    for (const inner of items) {
      expect(inner.indexOf('role="radio"')).toBeLessThan(inner.indexOf('<label'));
      const inputId = /<input[^>]*\bid="([^"]+)"/.exec(inner)![1];
      expect(/<label[^>]*\bfor="([^"]+)"/.exec(inner)![1]).toBe(inputId);
      expect(inner).toContain('peer-data-checked:bg-card peer-data-checked:text-foreground');
    }
  });

  it('ciemny motyw: tor odcina się od karty, a zaznaczona pigułka od toru', () => {
    // Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): w `.dark`
    // `--muted` == `--card`, więc `bg-muted` (tor) i `peer-data-checked:bg-card`
    // (pigułka) znikały na karcie — zaznaczenie zdradzała tylko jaśniejsza
    // czcionka. Liczymy na prawdziwych tokenach z app/globals.css, a nie na
    // nazwach klas, żeby zmiana tokenów też wyszła w teście.
    const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
    const darkBlock = /^\.dark \{([\s\S]*?)^\}/m.exec(css)?.[1];
    expect(darkBlock, 'brak bloku .dark w app/globals.css').toBeDefined();
    const tokens = Object.fromEntries(
      [...darkBlock!.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]),
    );
    /** Neutralny oklch: dla C = 0 luminancja względna to L³ (OKLab), więc kontrast WCAG liczy się wprost. */
    const lightness = (token: string) => {
      const match = /^oklch\(([\d.]+) 0 0\)$/.exec(tokens[token] ?? '');
      expect(match, `--${token} w .dark nie jest neutralnym oklch(L 0 0): ${tokens[token]}`).not.toBeNull();
      return Number(match![1]);
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [lightness(a) ** 3, lightness(b) ** 3].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    /** Tło w ciemnym motywie: nadpisanie `dark:…bg-X`, a bez niego klasa bazowa `…bg-X`. */
    const darkBg = (classes: string[], prefix: string) => {
      const pick = (p: string) =>
        classes.map((c) => (c.startsWith(p) ? c.slice(p.length) : null)).find((t) => t && /^[\w-]+$/.test(t));
      const token = pick(`dark:${prefix}bg-`) ?? pick(`${prefix}bg-`);
      expect(token, `brak tła ${prefix}bg-* w: ${classes.join(' ')}`).toBeDefined();
      return token!;
    };

    const html = renderToStaticMarkup(
      <SegmentedControl ariaLabel="Rodzaj wpisu" value="revenue" onValueChange={() => {}} options={VIEW_OPTIONS} />,
    );
    const groupClasses = /<div[^>]*role="radiogroup"[^>]*class="([^"]*)"|<div[^>]*class="([^"]*)"[^>]*role="radiogroup"/
      .exec(html)!
      .slice(1)
      .find(Boolean)!
      .split(' ');
    const labelClasses = [...html.matchAll(/<label[^>]*class="([^"]*)"/g)].map(([, cls]) => cls!.split(' '));
    expect(labelClasses).toHaveLength(3);

    const track = darkBg(groupClasses, '');
    // Tor (wnęka) jak `--ff-surface-inset` w `html.dark .ff-dashboard`: wyraźnie inny niż karta pod nim.
    expect(Math.abs(lightness(track) - lightness('card'))).toBeGreaterThanOrEqual(0.05);
    // Niezaznaczony napis na torze nadal czytelny.
    expect(contrast('muted-foreground', track)).toBeGreaterThanOrEqual(4.5);
    for (const classes of labelClasses) {
      const pill = darkBg(classes, 'peer-data-checked:');
      expect(Math.abs(lightness(pill) - lightness(track))).toBeGreaterThanOrEqual(0.05);
      expect(Math.abs(lightness(pill) - lightness('card'))).toBeGreaterThanOrEqual(0.05);
      // Zaznaczony napis na pigułce.
      expect(contrast('foreground', pill)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('dwa przełączniki na jednej stronie mają różne id', () => {
    const html = renderToStaticMarkup(
      <>
        <SegmentedControl ariaLabel="A" value="all" onValueChange={() => {}} options={VIEW_OPTIONS} />
        <SegmentedControl ariaLabel="B" value="all" onValueChange={() => {}} options={VIEW_OPTIONS} />
      </>,
    );
    const ids = [...html.matchAll(/<input[^>]*\bid="([^"]+)"/g)].map(([, id]) => id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it('kliknięcie segmentu wywołuje onValueChange z wartością opcji', async () => {
    const onValueChange = vi.fn();
    const el = await mount(
      <SegmentedControl ariaLabel="Rodzaj wpisu" value="all" onValueChange={onValueChange} options={VIEW_OPTIONS} />,
    );
    const label = [...el.querySelectorAll('label')].find((l) => l.textContent?.startsWith('Przychody'));
    expect(label).toBeDefined();
    await act(async () => {
      label!.click();
    });
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('revenue');
  });
});

describe('MonthSelector — postać adresu', () => {
  it('query="month-year": adres KPiR ?month=M&year=RRRR i własna etykieta', async () => {
    const el = await mount(
      <MonthSelector
        month="2026-10"
        currentMonth="2026-10"
        basePath="/reports/kpir"
        query="month-year"
        ariaLabel="Miesiąc KPiR"
      />,
    );
    const trigger = combobox(el, 'Miesiąc KPiR');
    // W spoczynku nic się nie ładuje.
    expect(trigger.hasAttribute('aria-busy')).toBe(false);
    const option = (await openSelect(trigger)).find((o) => o.textContent?.trim() === 'Wrzesień 2026');
    expect(option).toBeDefined();
    await act(async () => {
      option!.click();
    });
    expect(router.push).toHaveBeenCalledWith('/reports/kpir?month=9&year=2026');
  });

  it('domyślnie bez zmian: ?miesiac=RRRR-MM i „Miesiąc wydatków”', async () => {
    const el = await mount(<MonthSelector month="2026-10" currentMonth="2026-10" basePath="/expenses" />);
    const option = (await openSelect(combobox(el, 'Miesiąc wydatków'))).find(
      (o) => o.textContent?.trim() === 'Wrzesień 2026',
    );
    expect(option).toBeDefined();
    await act(async () => {
      option!.click();
    });
    expect(router.push).toHaveBeenCalledWith('/expenses?miesiac=2026-09');
  });
});

type Row = { id: string; column: string };
const COLUMNS: ColumnDef<Row>[] = [{ id: 'column', accessorKey: 'column', filterFn: 'equalsString' }];
const LABELS: Record<string, string> = {
  '7': '7 · Sprzedaż',
  '10': '10 · Towary',
  '11': '11 · Koszty uboczne',
  '13': '13 · Pozostałe',
  '15': 'B+R',
  brak: 'Bez kolumny',
  poza: 'Poza sumą',
};

function FilterHarness({ values, order }: { values: string[]; order?: readonly string[] }) {
  // eslint-disable-next-line react-hooks/incompatible-library -- tanstack zwraca funkcje, których React Compiler nie zapamiętuje (jak w KpirView)
  const table = useReactTable({
    data: values.map((column, i) => ({ id: `r${i}`, column })),
    columns: COLUMNS,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
  });
  return (
    <ColumnSelectFilter
      column={table.getColumn('column')!}
      labels={LABELS}
      order={order}
      allLabel="Wszystkie kolumny"
      label="Kolumna KPiR"
    />
  );
}

async function filterOptions(values: string[], order?: readonly string[]): Promise<string[]> {
  const el = await mount(<FilterHarness values={values} order={order} />);
  const trigger = el.querySelector<HTMLElement>('[role="combobox"]');
  expect(trigger).not.toBeNull();
  return (await openSelect(trigger!)).map((o) => o.textContent?.trim() ?? '');
}

describe('ColumnSelectFilter — kolejność opcji', () => {
  const VALUES = ['13', 'poza', '10', '7', '15', 'brak', '11', '7', 'inna'];

  it('order: znane wartości w podanej kolejności, nieznane na końcu, brakujących nie ma', async () => {
    expect(await filterOptions(VALUES, ['7', '10', '11', '12', '13', '15', 'brak', 'poza'])).toEqual([
      'Wszystkie kolumny',
      '7 · Sprzedaż',
      '10 · Towary',
      '11 · Koszty uboczne',
      '13 · Pozostałe',
      'B+R',
      'Bez kolumny',
      'Poza sumą',
      'inna',
    ]);
  });

  it('bez order: sortowanie naturalne po polsku — „7” przed „10”', async () => {
    const options = await filterOptions(VALUES);
    expect(options[0]).toBe('Wszystkie kolumny');
    expect(options.slice(1)).toEqual([
      '7 · Sprzedaż',
      '10 · Towary',
      '11 · Koszty uboczne',
      '13 · Pozostałe',
      'B+R',
      'Bez kolumny',
      'inna',
      'Poza sumą',
    ]);
  });
});

describe('FinoraListCard — krój podtytułu', () => {
  const subtitleClass = (html: string) => /<p class="([^"]*)">FV\/1<\/p>/.exec(html)?.[1] ?? '';

  it('domyślnie font-mono (Kontrahenci, Przypomnienia, Faktury bez zmian)', () => {
    const html = renderToStaticMarkup(<FinoraListCard title="ACME" subtitle="FV/1" />);
    expect(subtitleClass(html).split(' ')).toEqual(
      expect.arrayContaining(['text-muted-foreground', 'truncate', 'text-xs', 'font-mono']),
    );
  });

  it('subtitleClassName="font-sans" zastępuje font-mono', () => {
    const html = renderToStaticMarkup(<FinoraListCard title="ACME" subtitle="FV/1" subtitleClassName="font-sans" />);
    const cls = subtitleClass(html).split(' ');
    expect(cls).toContain('font-sans');
    expect(cls).not.toContain('font-mono');
    expect(cls).toEqual(expect.arrayContaining(['text-muted-foreground', 'truncate', 'text-xs']));
  });
});
