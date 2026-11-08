import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/analizy/sprzedaz',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
  redirect: nav.redirect,
}));

const { AnalizyHeader, ANALIZY_MODES } = await import('@/components/analizy/analizy-header');
const { analizySlot } = await import('@/components/analizy/card-slot');
const { default: AnalizyLoading } = await import('@/app/(dashboard)/analizy/loading');
const { analyticsMonthOptions, currentMonthKey } = await import('@/lib/analytics-finance/months');
const { default: AnalizyRedirect } = await import('@/app/(dashboard)/analizy/page');

/**
 * Nagłówek `/analizy/*` po poprawce Bartosza 21.10.2026 (Analizy 1:1
 * z Finory, jedna pozycja menu): tytuł według rodzaju analizy, przełącznik
 * „Sprzedaż | Koszty” jako nawigacja z `aria-current`, wybrany miesiąc
 * przechodzi na drugą analizę tylko, gdy nie jest bieżącym; `/analizy`
 * przekierowuje na sprzedaż; karty bez szkieletów (strona wchodzi w całości).
 */

/** SSR wstawia <!-- --> między sąsiednie węzły tekstowe — usuwamy je. */
function html(node: React.ReactElement): string {
  return renderToStaticMarkup(node).replace(/<!-- -->/g, '');
}

const NOW = new Date('2026-10-17T10:00:00Z');
const CURRENT = currentMonthKey(NOW);

function header(mode: 'sprzedaz' | 'koszty', month: string) {
  return html(
    <AnalizyHeader mode={mode} options={analyticsMonthOptions(NOW)} month={month} currentMonth={CURRENT} />,
  );
}

/** Znacznik `<nav aria-label="Rodzaj analizy">…</nav>`. */
function switchNav(out: string): string {
  const match = out.match(/<nav[^>]*aria-label="Rodzaj analizy"[^>]*>.*?<\/nav>/);
  expect(match, 'przełącznik „Rodzaj analizy”').not.toBeNull();
  return match![0];
}

/** Linki przełącznika: [href, etykieta, czy aria-current="page"]. */
function switchLinks(out: string): Array<[string, string, boolean]> {
  return [...switchNav(out).matchAll(/<a([^>]*)>(.*?)<\/a>/g)].map((m) => [
    m[1]!.match(/href="([^"]*)"/)![1]!,
    m[2]!,
    m[1]!.includes('aria-current="page"'),
  ]);
}

describe('AnalizyHeader — tytuł według rodzaju analizy', () => {
  it('sprzedaż: jeden <h1> „Analiza sprzedaży”, podpis, wybór miesiąca po polsku', () => {
    const out = header('sprzedaz', '2026-09');
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toContain('<h1 class="text-2xl font-semibold">Analiza sprzedaży</h1>');
    expect(out).toContain(ANALIZY_MODES.sprzedaz.description);
    expect(out).toContain('aria-label="Wybierz miesiąc"');
    expect(out).toContain('Wrzesień 2026');
  });

  it('koszty: jeden <h1> „Analiza kosztów” i własny podpis', () => {
    const out = header('koszty', CURRENT);
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out).toContain('<h1 class="text-2xl font-semibold">Analiza kosztów</h1>');
    expect(out).toContain('Śledź wydatki, VAT i stałe koszty miesiąc po miesiącu.');
    expect(out).not.toContain('Analiza sprzedaży</h1>');
  });

  it('wiersz nagłówka jak w Finorze, przełącznik przed wyborem miesiąca', () => {
    const out = header('sprzedaz', CURRENT);
    expect(out).toContain('class="flex justify-between gap-3 max-sm:flex-col sm:items-center"');
    expect(out).toContain('class="flex items-center gap-3 max-sm:justify-between"');
    expect(out.indexOf('aria-label="Rodzaj analizy"')).toBeLessThan(out.indexOf('aria-label="Wybierz miesiąc"'));
    // Wybór miesiąca bez `max-sm:self-end` Finory (sterowanie stoi w grupie).
    expect(out).not.toContain('max-sm:self-end');
  });
});

describe('przełącznik „Sprzedaż | Koszty”', () => {
  it('nawigacja z dwoma linkami, aktywny ma aria-current="page" i wygląd segmentu', () => {
    const out = header('koszty', CURRENT);
    expect(switchLinks(out)).toEqual([
      ['/analizy/sprzedaz', 'Sprzedaż', false],
      ['/analizy/koszty', 'Koszty', true],
    ]);
    const navTag = switchNav(out);
    // Tor `dark:bg-card`, nie `dark:bg-background`: przełącznik stoi na stronie
    // (`bg-background`), nie na karcie — tor w kolorze strony znikał w ciemnym
    // motywie (poprawka z przeglądu 21.10.2026, warstwy jak w Finorze: jaśniejszy
    // tor na stronie, jeszcze jaśniejsza pigułka).
    expect(navTag).toContain('bg-muted text-muted-foreground inline-flex h-8 w-fit items-center gap-0 p-1 dark:bg-card');
    expect(navTag).not.toContain('dark:bg-background');
    expect(navTag).toMatch(/<a[^>]*aria-current="page"[^>]*class="[^"]*bg-card text-foreground dark:bg-input/);
    expect(header('sprzedaz', CURRENT).match(/aria-current="page"/g)).toHaveLength(1);
    expect(switchLinks(header('sprzedaz', CURRENT)).map(([, , active]) => active)).toEqual([true, false]);
  });

  it('bieżący miesiąc: adresy bez ?miesiac=', () => {
    for (const [href] of switchLinks(header('sprzedaz', CURRENT))) {
      expect(href).not.toContain('miesiac');
    }
  });

  it('wcześniejszy miesiąc przechodzi na drugą analizę (?miesiac=RRRR-MM)', () => {
    expect(switchLinks(header('sprzedaz', '2026-09')).map(([href]) => href)).toEqual([
      '/analizy/sprzedaz?miesiac=2026-09',
      '/analizy/koszty?miesiac=2026-09',
    ]);
  });
});

describe('strony /analizy/*', () => {
  const source = (page: string) =>
    readFileSync(join(process.cwd(), 'app', '(dashboard)', 'analizy', page, 'page.tsx'), 'utf8');

  it('korzeń strony nadpisuje --muted w ciemnym motywie i podaje rodzaj analizy', () => {
    for (const page of ['sprzedaz', 'koszty']) {
      const src = source(page);
      // `ff-route-content` (poprawka 23.10.2026): strona wchodzi w całości z animacją, jak Pulpit.
      expect(src, page).toContain('className="ff-route-content space-y-6 dark:[--muted:var(--background)]"');
      expect(src, page).toContain(`mode="${page}"`);
      expect(src, page).toContain('currentMonth={currentMonthKey(now)}');
    }
  });

  it('/analizy przekierowuje na analizę sprzedaży, miesiąc RRRR-MM idzie dalej', async () => {
    const run = async (params: Record<string, string | string[] | undefined>) => {
      nav.redirect.mockClear();
      await expect(AnalizyRedirect({ searchParams: Promise.resolve(params) })).rejects.toThrow('NEXT_REDIRECT');
      return nav.redirect.mock.calls[0]?.[0];
    };
    expect(await run({})).toBe('/analizy/sprzedaz');
    expect(await run({ miesiac: '2026-09' })).toBe('/analizy/sprzedaz?miesiac=2026-09');
    expect(await run({ miesiac: ['2026-08', '2026-07'] })).toBe('/analizy/sprzedaz?miesiac=2026-08');
    // Śmieci w adresie nie przechodzą dalej.
    expect(await run({ miesiac: '2026-13' })).toBe('/analizy/sprzedaz');
    expect(await run({ miesiac: '2026-09&x=1' })).toBe('/analizy/sprzedaz');
  });
});

// Poprawka Bartosza 23.10.2026 („przejścia pomiędzy zakładkami nie są już
// takie clean”): Analizy ładują się jak Pulpit i Przepływy — wszystkie karty
// naraz, bez `Suspense` i szkieletu w każdej karcie, a trasa ma pusty
// `loading.tsx` zamiast ogólnego szkieletu segmentu. Dawne testy wariantów
// szkieletu `AnalizySlot` (stats, bar, pie, list, feed, rows, heatmap)
// odpadły razem ze szkieletami.
describe('ładowanie Analiz: bez szkieletów kart', () => {
  it('slot karty: treść karty w granicy błędu, bez szkieletu i `aria-busy`', async () => {
    const out = html(<>{await analizySlot('Karta', 'md:col-span-2', async () => <div className="md:col-span-2">Treść karty</div>)}</>);
    expect(out).toBe('<div class="md:col-span-2">Treść karty</div>');
  });

  it('`loading.tsx` Analiz: puste miejsce bez szkieletu (dawny ogólny szkielet segmentu migał przed siatką Finory)', () => {
    const out = html(<AnalizyLoading />);
    expect(out).not.toContain('data-slot="skeleton"');
    expect(out).not.toContain('animate-pulse');
    expect(out).toContain('aria-label="Ładowanie"');
  });

  it('strony Analiz wchodzą w całości z animacją `ff-route-content`', () => {
    for (const page of ['sprzedaz', 'koszty']) {
      const src = readFileSync(join(process.cwd(), 'app', '(dashboard)', 'analizy', page, 'page.tsx'), 'utf8');
      expect(src, page).toContain('className="ff-route-content space-y-6');
    }
    const slot = readFileSync(join(process.cwd(), 'components', 'analizy', 'card-slot.tsx'), 'utf8');
    expect(slot).not.toMatch(/<Suspense|from '@\/components\/ui\/skeleton'/);
  });
});
