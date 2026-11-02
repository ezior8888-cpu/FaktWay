import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { prerenderToNodeStream } from 'react-dom/static';
import { RiArrowDownSLine, RiArrowUpSLine, RiFileList3Line } from '@remixicon/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Read } from '@/lib/demo/fake-postgrest';

import { memoryClient, type MemoryTables } from './helpers/baza-w-pamieci';

/**
 * Pulpit = strona Finance Finory 1:1 (decyzja Bartosza 19.10.2026), od E5
 * PLAN-PRAWDZIWE-DANE na prawdziwych danych: te same karty, siatka, klasy
 * i animacje, zmienione tylko napisy i źródło liczb (polecenie Bartosza
 * 23.10.2026: „wszystko IDENTYCZNE rozmiarowo i designowo”). Przed
 * weryfikacją KSeF karty czytają atrapę bazy tymi samymi loaderami.
 */

type Proof = { verifiedAt: string | null; verifiedEnvironment: string | null };

const state = vi.hoisted(() => ({
  ctx: null as unknown as { supabase: unknown; tenantId: string; user: { id: string; email: string | null }; role: 'owner' },
  proof: null as Proof | null,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => { throw new Error(`redirect ${to}`); },
}));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: async () => state.ctx }));
vi.mock('@/lib/dashboard-shell-data', () => ({ getTenantKsefProof: async () => state.proof }));

const { ZNACZNIKI_PRZYKLADU } = await import('@/lib/demo/znaczniki');
const { default: DashboardHomePage } = await import('@/app/(dashboard)/dashboard/page');
const { default: StatisticsCard } = await import('@/components/dashboard/finora/statistics-card-03');
const { default: StatisticsImpressionCard } = await import('@/components/dashboard/finora/statistics-impression-card');
const { default: TopProductsCard } = await import('@/components/dashboard/finora/widget-top-products');
const { financeChartConfig, financeYAxis } = await import('@/components/dashboard/finora/chart-finance');
const adaptery = await import('@/components/dashboard/finora/adaptery');
const { default: TotalVisitorsCard } = await import('@/components/dashboard/finora/chart-total-visitors');
const { Button } = await import('@/components/ui/button');
const { danePrzykladowe, DEMO_TENANT } = await import('@/lib/demo/dane-przykladowe');
const { fakePostgrest } = await import('@/lib/demo/fake-postgrest');

/** Klasy dzisiejszego (sprzed E5) Pulpitu Finory — zrzut z renderu 23.10.2026. */
const KLASY_FINORY: string[] = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/pulpit-finora-klasy.json'), 'utf8'),
);

/** Klasy, które musiały zniknąć: wysokość kolumn należności liczona z danych (`style`), nie wpisana. */
const KLASY_USUNIETE = ['h-[17%]', 'h-[18%]', 'h-[65%]'];
/**
 * Klasy dodane z konieczności danych: przycięcie długiej nazwy (prawdziwe
 * pozycje i firmy są dłuższe niż „Dell XPS 13”). Kolorów nie dodajemy
 * (zasada Bartosza 23.10.2026) — spadek VAT niesie minus, nie czerwień.
 */
const KLASY_DODANE = [
  'truncate',
  'min-w-0',
  // E12 (D-P): klasy plakietki „Dane przykładowe” (components/dashboard/demo-badge.tsx), jedyny nowy element.
  '[a]:hover:bg-secondary/80',
  'bg-amber-500/15',
  'font-normal',
  'text-amber-800',
  'dark:bg-amber-400/15',
  'dark:text-amber-300',
  // Recenzja 2: plakietka obok tytułu zwęża się na wąskim ekranie (`DemoBadge skracana`: `shrink`
  // zamiast `shrink-0`, napis z `truncate`), żeby tytuł karty nie łamał się w drugą linię przy 320–360 px.
  'shrink',
  // Poprawka Bartosza 23.10.2026 („przejścia nie są już takie clean”): strona wchodzi raz, w całości,
  // z animacją szablonu trasy (`app/globals.css`) — opakowanie bez wpływu na układ siatki.
  'ff-route-content',
];

const NOW = new Date('2026-10-23T08:00:00Z');
/**
 * T9 (PLAN-PRAWDZIWE-DANE §9): odczyty całego Pulpitu na atrapie, zmierzone 23.10.2026.
 * E10 (D-K) świadomie +5 w karcie Finanse: demo ma wydatki ze Skrzynki KSeF
 * (`getCosts` sprawdza ich środowisko i walutę: +2), a pełne koszty czytają
 * faktury zakupu z wydatkami osadzonymi (+1), wydatki o tym samym NIP-ie
 * i numerze (+1) i zwolnienie z VAT (+1).
 * E11 (D-W) świadomie −2: Należności czytają wpływy od dziś (`getInflows`,
 * jeden odczyt) zamiast `getReceivables` (faktury, korekty i ROZ).
 * Recenzja 2 świadomie +1: korekty wystawione przed dziś do faktur z terminem
 * od dziś (zmieniają kwotę spodziewaną; `correctionsBefore` w `inflows.ts`).
 * Sesja 19 planu skalowania świadomie −4: karty sprzedaży czytają wspólny
 * zbiór (`lib/dashboard/sales-history.ts`) — poza RSC każda karta czyta go
 * sama (strony + faktury bez środowiska), bez osobnych COUNT. W jednym
 * zakresie `cache()` (render RSC) cały Pulpit to 14 odczytów
 * (`tests/unit/pulpit-jeden-odczyt.test.tsx`).
 */
const READS_PULPITU = 24;
const ZWERYFIKOWANA: Proof = { verifiedAt: '2026-10-12T08:00:00Z', verifiedEnvironment: 'test' };

async function html(node: ReactNode): Promise<string> {
  const { prelude } = await prerenderToNodeStream(<>{node}</>);
  let out = '';
  for await (const chunk of prelude) out += String(chunk);
  return out;
}

function decode(text: string): string {
  return text
    .replaceAll('&#x27;', "'")
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&quot;', '"')
    // `&amp;` na końcu, inaczej „&amp;lt;” zamieniłoby się w „<” (CodeQL js/double-escaping).
    .replaceAll('&amp;', '&');
}

// Poprawka 23.10.2026: karty nie mają już `Suspense` ani szkieletów — prerender oddaje gotową
// stronę bez podmian, więc dawne wycinanie szkieletów (`bezSzkieletow`) odpadło; gdyby szkielet
// wrócił, jego klasy wyjdą w porównaniu niżej (i w `finora-wyglad-ladowanie.test.tsx`).
function klasy(markup: string): Set<string> {
  const out = new Set<string>();
  for (const m of markup.matchAll(/class="([^"]*)"/g)) {
    for (const c of decode(m[1]!).split(/\s+/)) if (c) out.add(c);
  }
  return out;
}

function pulpit(tables: MemoryTables = {}) {
  state.ctx = {
    supabase: memoryClient(tables),
    tenantId: 'firma-a',
    user: { id: 'uzytkownik-1', email: null },
    role: 'owner',
  };
  return DashboardHomePage().then(html);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.proof = { verifiedAt: null, verifiedEnvironment: null };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Finanse (Z17 po zmianie Bartosza): stos Koszty + Zysk + VAT', () => {
  const props = adaptery.finanseProps({
    months: [
      { key: '2026-09', label: 'Wrz' },
      { key: '2026-10', label: 'Paź' },
    ],
    net: [30000, 8000],
    vat: [6900, 1840],
    costs: [11000, 9500.5],
    tryb: 'prawdziwe',
    kosztyKsefOd: null,
  });

  it('zysk = przychód − koszty w każdym miesiącu; słupek = sprzedaż brutto', () => {
    const [wrz, paz] = props.months;
    expect(wrz).toMatchObject({ month: 'Wrz', revenue: 30000, result: 19000, profit: 19000, costs: 11000, vat: 6900 });
    expect(wrz!.costs + wrz!.profit + wrz!.vat).toBeCloseTo(30000 + 6900, 2);
    // Strata: zysk w słupku 0, strata w dymku (wynik ujemny).
    expect(paz).toMatchObject({ profit: 0, result: -1500.5, costs: 9500.5, vat: 1840 });
  });

  // Zrzuty 24.10.2026 (świadoma zmiana): segmenty od dołu Koszty, Zysk, VAT — kolory segmentów jak w Finorze
  // (dolny chart-2, środkowy chart-3, górny chart-4), zmieniło się tylko przypisanie wartości (dawniej Zysk, VAT, Koszty).
  it('trzy serie w kolorach segmentów Finory, z prawdziwymi nazwami; od dołu Koszty, Zysk, VAT', () => {
    expect(financeChartConfig.costs).toEqual({ label: 'Koszty', color: 'var(--chart-2)' });
    expect(financeChartConfig.profit).toEqual({ label: 'Zysk', color: 'var(--chart-3)' });
    expect(financeChartConfig.vat).toEqual({ label: 'VAT należny', color: 'var(--chart-4)' });
    const src = readFileSync(join(process.cwd(), 'components/dashboard/finora/chart-finance.tsx'), 'utf8');
    const bars = [...src.matchAll(/<Bar dataKey='(\w+)' stackId='a' fill='var\(--color-(\w+)\)'/g)].map((m) => [m[1], m[2]]);
    expect(bars).toEqual([['costs', 'costs'], ['profit', 'profit'], ['vat', 'vat']]);
    // Oś Y z danych, nie wpisany zakres 0–50…
    expect(src).not.toMatch(/domain=\{\[0, 50\]\}|ticks=\{\[/);
    // …ale jak w Finorze (poprawka 23.10.2026): sześć etykiet od zera do „ładnego” maksimum.
    expect(financeYAxis(50_000)).toEqual({ max: 50_000, ticks: [0, 10_000, 20_000, 30_000, 40_000, 50_000] });
    expect(financeYAxis(0)).toEqual({ max: 50, ticks: [0, 10, 20, 30, 40, 50] });
    expect(financeYAxis(61_000).ticks).toHaveLength(6);
    // Dymek jak w Finorze: bez wiersza z nazwą miesiąca (miesiąc jest na osi X pod słupkiem).
    expect(src).toMatch(/<ChartTooltipContent\s+hideLabel/);
  });

  it('Raport: ten miesiąc, „Strata” przy stracie, średnia netto w podtytule', () => {
    expect(props.report.rows.map((r) => r.title)).toEqual(['Strata', 'Przychody netto', 'Koszty']);
    expect(props.report.rows[0]!.amount).toBe('1500,50 zł');
    expect(props.report.subTitle.replace(/\u00a0/g, ' ')).toBe('Ten miesiąc · średnio 30 tys. zł');
  });

  it('koszty z KSeF pełne dopiero od weryfikacji, dopóki historia zakupów się pobiera (Z9, E10): „od DD.MM” w Raporcie i dymku', () => {
    const wejscie = {
      months: [{ key: '2026-09', label: 'Wrz' }, { key: '2026-10', label: 'Paź' }],
      net: [1, 2], vat: [0, 0], costs: [0, 0], tryb: 'prawdziwe' as const,
    };
    const p = adaptery.finanseProps({ ...wejscie, kosztyKsefOd: '2026-10-12T08:00:00Z' });
    expect(p.costsLabel).toBe('Koszty (KSeF od 12.10)');
    expect(p.report.rows[2]!.title).toBe('Koszty (KSeF od 12.10)');
    // Historia zakupów pełna (`kosztyKsefOd = null`) — bez zastrzeżenia.
    const pelna = adaptery.finanseProps({ ...wejscie, kosztyKsefOd: null });
    expect(pelna.costsLabel).toBe('Koszty');
    expect(pelna.report.rows[2]!.title).toBe('Koszty');
  });
});

describe('Kafle: strzałka i znak liczone z danych', () => {
  const card = (changePct: number | null) =>
    renderToStaticMarkup(
      <StatisticsCard icon={<RiFileList3Line />} value="12" title="Faktury w KSeF" changePct={changePct} badgeContent="Ten miesiąc" />,
    );
  const gora = renderToStaticMarkup(<RiArrowUpSLine className="size-4" />);
  const dol = renderToStaticMarkup(<RiArrowDownSLine className="size-4" />);

  it('spadek: strzałka w dół i minus typograficzny', () => {
    const markup = card(-12.4);
    expect(markup).toContain('−12%');
    expect(markup).toContain(dol);
    expect(markup).not.toContain(gora);
  });

  it('wzrost: strzałka w górę', () => {
    const markup = card(5);
    expect(markup).toContain('+5%');
    expect(markup).toContain(gora);
  });

  it('brak poprzedniego miesiąca: „—” bez strzałki', () => {
    const markup = card(null);
    expect(markup).toContain('—');
    expect(markup).not.toContain(gora);
    expect(markup).not.toContain(dol);
  });
});

describe('Zmiana VAT należnego: kolor Finory, znak z danych', () => {
  const months = [{ label: 'Wrz' }, { label: 'Paź' }];
  const card = (vatSeries: number[]) =>
    renderToStaticMarkup(<StatisticsImpressionCard {...adaptery.vatNaleznyProps({ months, vatSeries }, 'prawdziwe')} />);

  it('spadek: minus typograficzny w tym samym `text-primary` co w Finorze — bez nowego koloru', () => {
    const markup = card([1000, 800]);
    expect(markup).toContain('<span class="text-primary text-base">−20%</span>');
    expect(markup).not.toContain('text-destructive');
  });

  it('wzrost: plus; brak podstawy: bez procentu', () => {
    expect(card([1000, 1100])).toContain('<span class="text-primary text-base">+10%</span>');
    expect(card([0, 1100])).toContain('<span class="text-primary text-base"></span>');
  });
});

describe('Limit VAT (firma zwolniona): napis po prawej mieści się jak „+24%” w Finorze', () => {
  // Pomiar 23.10.2026 (Chromium, Outfit): kafel ma przy 1280 px ok. 142 px, a „z 240 tys. zł”
  // obok procentu zawijało się do drugiej linii — kwota bez „zł”, pełna w dymku wartości.
  const overview = {
    year: 2026, today: '2026-10-23', months: [{ key: '2026-10', label: 'Paź' }], cumulative: [18_900],
    used: 18_900, annualLimit: 240_000, startedOn: '2020-01-01',
    limit: { effectiveLimit: 240_000, prorated: false, activeDays: 365, daysInYear: 365, pct: 7.875, remaining: 221_100, level: 0, formula: '' },
  } as unknown as Parameters<typeof adaptery.limitVatProps>[0];

  it('„7%” i „z 240 tys.”; pełne kwoty w złotych w dymku', () => {
    const dane = adaptery.limitVatProps(overview, 'prawdziwe');
    expect(dane.value).toBe('7%');
    expect(dane.side?.replace(/\s/g, ' ')).toBe('z 240 tys.');
    expect(dane.valueTitle?.replace(/\s/g, ' ')).toBe('Sprzedaż 18 900,00 zł z limitu 240 000,00 zł');
  });
});

describe('Rankingi: wiersz zawsze w dwóch liniach jak w Finorze', () => {
  it('długa nazwa i długa druga linia („Nabywcy bez NIP (B2C)”, „NIP …”) są przycinane, pełny tekst w dymku', () => {
    const row = { icon: <RiFileList3Line />, productName: 'Przedsiębiorstwo Handlowo-Usługowe Przykład sp. z o.o.', productBrand: 'Nabywcy bez NIP (B2C)' };
    const markup = renderToStaticMarkup(
      <TopProductsCard
        salesTitle="Najlepiej sprzedające się"
        productsBySalesData={[{ ...row, sales: '1 zł' }]}
        volumeTitle="Najwięksi klienci"
        productsByVolumeData={[{ ...row, volume: '1 zł', changePercentage: null }]}
      />,
    );
    const subs = [...markup.matchAll(/<span class="([^"]*)"[^>]*>Nabywcy bez NIP \(B2C\)<\/span>/g)].map((m) => m[1]!.split(' '));
    expect(subs).toHaveLength(2);
    for (const cls of subs) expect(cls).toEqual(expect.arrayContaining(['truncate', 'text-muted-foreground', 'text-sm']));
    expect(markup).toContain('title="Nabywcy bez NIP (B2C)"');
  });
});

describe('Pulpit przed weryfikacją KSeF: dane przykładowe przez te same loadery', () => {
  it('karty Finory z prawdziwymi podpisami, bez napisów szablonu', async () => {
    const markup = await pulpit();
    for (const text of [
      'Finanse', 'Ostatnie 7 miesięcy', 'Raport', 'Ten miesiąc', 'Zobacz przepływy',
      'Faktury w KSeF', 'Średnia faktura', 'Przychód netto', 'VAT należny', 'Ostatni rok',
      'Należności', 'Szczegóły', 'Najlepiej sprzedające się', 'Najwięksi klienci', 'Przykład',
      // E11 (D-W): Należności to przyszłe terminy płatności, nie zaległości.
      'Ten tydzień', 'Do 30 dni', 'Później', 'według terminów płatności',
    ]) {
      expect(markup).toContain(text);
    }
    for (const text of [
      'Przegląd roczny', 'Zobacz raport', 'Zamówienia', 'Zysk łącznie', 'Przychód łącznie', 'Wyświetlenia',
      'Odwiedzający', 'Najczęściej kupowane', 'Komputer', 'Tablet', 'Telefon', 'Samsung', 'Udostępnij',
      'Aktualizuj', 'Total Orders', 'View Report', 'zaległe', 'po terminie', 'oznaczonych wpłat',
    ]) {
      expect(markup).not.toContain(text);
    }
    expect(markup).not.toMatch(/\$\d/);
    expect(markup).not.toContain('/images/avatars');
    expect(markup).toContain('href="/przeplywy"');
    // E11: „Szczegóły” Należności prowadzą do Spodziewanych wpływów (Przepływy), nie do listy zaległości.
    expect(markup).not.toContain('href="/payments/overdue"');
  });

  // Zrzuty 24.10.2026: link „Szczegóły” zgubił obramowanie dawnego `<Button variant='outline' size='xs'>` —
  // sam `buttonVariants` zostawiał `border-transparent` obok `border-border` (bez `cn()`), a w arkuszu wygrywała przezroczysta.
  it('Należności: „Szczegóły” z obramowaniem i klasami dawnego przycisku outline xs', () => {
    const karta = renderToStaticMarkup(
      <TotalVisitorsCard title='Należności' total='1 zł' badge='1 faktura' detailsHref='/przeplywy' visitorData={[]} />,
    );
    const link = /<a [^>]*href="\/przeplywy"[^>]*class="([^"]*)"|<a [^>]*class="([^"]*)"[^>]*href="\/przeplywy"/.exec(karta);
    const klasyLinku = (link?.[1] ?? link?.[2] ?? '').split(' ');
    expect(klasyLinku).toContain('border-border');
    expect(klasyLinku).not.toContain('border-transparent');
    const przycisk = /class="([^"]*)"/.exec(renderToStaticMarkup(<Button variant='outline' size='xs'>Szczegóły</Button>))![1]!.split(' ');
    expect(new Set(klasyLinku)).toEqual(new Set(przycisk));
  });

  it('siatka Finory bez zmian: te same kontenery col-span', async () => {
    const markup = await pulpit();
    expect(markup).toContain('class="grid grid-cols-6 gap-6"');
    expect(markup).toContain('class="col-span-full grid grid-cols-2 gap-6 lg:col-span-3 xl:col-span-2"');
    expect(markup).toMatch(/class="[^"]*grid grid-cols-1 gap-x-2 gap-y-4 lg:grid-cols-5 col-span-full xl:col-span-4"/);
    expect(markup).toMatch(/class="[^"]*gap-4 col-span-full lg:col-span-3 xl:col-span-2"/);
    expect(markup).toMatch(/class="[^"]*gap-x-2 gap-y-6 lg:flex-row col-span-full xl:col-span-4"/);
  });

  it('karta nie zmienia klas układu: ten sam zbiór klas co Pulpit Finory', async () => {
    const nowe = klasy(await pulpit());
    const stare = new Set(KLASY_FINORY);
    const brakujace = KLASY_FINORY.filter((c) => !nowe.has(c) && !KLASY_USUNIETE.includes(c));
    const dodatkowe = [...nowe].filter((c) => !stare.has(c) && !KLASY_DODANE.includes(c));
    expect(brakujace).toEqual([]);
    expect(dodatkowe).toEqual([]);
  });
});

describe('Pulpit po weryfikacji KSeF: prawdziwe dane', () => {
  beforeEach(() => {
    state.proof = ZWERYFIKOWANA;
  });

  it('pusta firma: bez znaczników przykładu, puste stany zamiast wymyślonych liczb', async () => {
    const markup = await pulpit({ ksef_history_sync: [] });
    expect(ZNACZNIKI_PRZYKLADU.filter((z) => markup.includes(z))).toEqual([]);
    expect(markup).toContain('Finanse');
    expect(markup).toContain('Pokażemy to, gdy wystawisz pierwszą fakturę');
    expect(markup).not.toContain('Pobieramy faktury z KSeF');
  });

  it('historia sprzedaży się pobiera (stan B): puste karty mówią „Pobieramy faktury z KSeF…”', async () => {
    const markup = await pulpit({
      ksef_history_sync: [{
        tenant_id: 'firma-a',
        environment: 'test',
        direction: 'outgoing',
        created_at: '2026-10-23T07:00:00Z',
        backfill_completed_at: null,
        client_paused_at: null,
        last_error_code: null,
      }],
    });
    expect(markup).toContain('Pobieramy faktury z KSeF…');
    expect(markup).not.toContain('Pokażemy to, gdy wystawisz pierwszą fakturę');
  });

  it('strona dynamiczna, bez stałych z szablonu i bez FLO', () => {
    const src = readFileSync(join(process.cwd(), 'app/(dashboard)/dashboard/page.tsx'), 'utf8');
    expect(src).toContain("export const dynamic = 'force-dynamic'");
    expect(src).toContain('kontekstDanych');
    expect(src).not.toMatch(/components\/flo\/|ff-flo-legacy|listProposals/);
    expect(src).not.toMatch(/visitorData|productsBySalesData =|StatisticsCardData/);
  });
});

describe('Odporność i koszt: karty czytają osobno', () => {
  beforeEach(() => {
    state.proof = ZWERYFIKOWANA;
  });

  function zweryfikowanaZDanymi(tables: ReturnType<typeof danePrzykladowe>, reads: Read[] = []) {
    state.ctx = {
      supabase: fakePostgrest(tables, reads),
      tenantId: DEMO_TENANT,
      user: { id: 'uzytkownik-1', email: null },
      role: 'owner',
    };
    return DashboardHomePage().then(html);
  }

  it('faktura w EUR sprzed 10 miesięcy zabiera tylko karty, których okno ją obejmuje', async () => {
    const tables = danePrzykladowe(NOW, 'test');
    // Wzorem jest faktura SPRZEDAŻY (od E10 demo ma też faktury zakupu z KSeF).
    const sprzedaz = tables.invoices!.filter((f) => f.direction === 'outgoing');
    const wzor = sprzedaz.find((f) => f.issue_date === '2025-12-15') ?? sprzedaz[0]!;
    tables.invoices!.push({ ...wzor, id: 'eur-1', currency: 'EUR', issue_date: '2025-12-15', sale_date: '2025-12-15' });

    const markup = await zweryfikowanaZDanymi(tables);
    const blad = 'Raport wstrzymany: faktura sprzedaży nie ma potwierdzonej waluty PLN.';
    // Finanse i VAT (wspólne okno 12 miesięcy) oraz rankingi (12 + poprzednie 12).
    expect(markup.split(blad).length - 1).toBe(3);
    // Kafle, przychód (5 miesięcy i rok wcześniej) i należności (przyszłe terminy, E11) zostają.
    expect(markup).toContain('Faktury w KSeF');
    expect(markup).toContain('Średnia faktura');
    expect(markup).toContain('Przychód netto');
    expect(markup).toContain('Ten tydzień');
  });

  it('T9: liczba odczytów bazy na cały Pulpit — wzrost wymaga świadomej zmiany tej liczby', async () => {
    const reads: Read[] = [];
    await zweryfikowanaZDanymi(danePrzykladowe(NOW, 'test'), reads);
    // Poza RSC `cache()` nie deduplikuje, więc to górna granica; na produkcji
    // Finanse i VAT dzielą jedną serię sprzedaży (mniej odczytów).
    expect(reads.length).toBe(READS_PULPITU);
  });
});
