import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ReactElement, ReactNode } from 'react';
import { prerenderToNodeStream } from 'react-dom/static';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Read } from '@/lib/demo/fake-postgrest';
import type { PageContext } from '@/lib/supabase/page-context';

import { memoryClient, type MemoryTables, type Row } from './helpers/baza-w-pamieci';

/**
 * Strona `/przeplywy` = Cash Flow Finory 1:1 (decyzja Bartosza 21.10.2026),
 * od E6 PLAN-PRAWDZIWE-DANE na prawdziwych danych: te same karty, siatka,
 * klasy i animacje, zmienione tylko napisy i źródło liczb (polecenie Bartosza
 * 23.10.2026: „wszystko IDENTYCZNE rozmiarowo i designowo”). Przed
 * weryfikacją KSeF karty czytają atrapę bazy tymi samymi loaderami.
 *
 * Interakcje komponentów klienckich (zakładki wykresu, menu wiersza) —
 * `przeplywy-interakcje.test.tsx` (jsdom).
 */

type Proof = { verifiedAt: string | null; verifiedEnvironment: string | null };

const state = vi.hoisted(() => ({
  ctx: null as unknown as { supabase: unknown; tenantId: string; user: { id: string; email: string | null }; role: 'owner' },
  proof: null as Proof | null,
  verified: true,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/przeplywy',
  useRouter: () => ({ prefetch: () => {}, push: () => {}, refresh: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  redirect: (to: string) => { throw new Error(`redirect ${to}`); },
}));
vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: async () => state.ctx }));
vi.mock('@/lib/dashboard-shell-data', () => ({
  getTenantKsefProof: async () => state.proof,
  // Dawna siatka (`PrzeplywyGrid`) czyta jeszcze starą bramkę.
  getDashboardActiveOrgVerified: async () => state.verified,
}));

const { ZNACZNIKI_PRZYKLADU } = await import('@/lib/demo/znaczniki');
const { default: PrzeplywyPage } = await import('@/app/(dashboard)/przeplywy/page');
const adaptery = await import('@/components/przeplywy/finora-1do1/adaptery');
const { danePrzykladowe, DEMO_TENANT } = await import('@/lib/demo/dane-przykladowe');
const { fakePostgrest } = await import('@/lib/demo/fake-postgrest');

const NOW = new Date('2026-10-23T08:00:00Z');
const ZWERYFIKOWANA: Proof = { verifiedAt: '2026-10-12T08:00:00Z', verifiedEnvironment: 'test' };
/**
 * T9 (PLAN-PRAWDZIWE-DANE §9): odczyty całych Przepływów na atrapie, zmierzone 23.10.2026.
 * E10 (D-K) świadomie +30: sześć odczytów kosztów (bez RSC `cache()` każda
 * karta czyta osobno; na produkcji trzy — okno 12 miesięcy, 5 lat i rok
 * podatku) po +5: demo ma wydatki ze Skrzynki KSeF (`getCosts` sprawdza ich
 * środowisko i walutę: +2), a pełne koszty czytają faktury zakupu z wydatkami
 * osadzonymi (+1), wydatki o tym samym NIP-ie i numerze (+1) i zwolnienie
 * z VAT (+1).
 * E11 świadomie −2: „Spodziewane wpływy” czytają wpływy (`getInflows`,
 * jeden odczyt) zamiast należności (`getReceivables`: faktury, korekty i ROZ).
 * Recenzja 2 świadomie +5: odczyt wpływów okna 12 miesięcy (pięć odczytów
 * bez RSC `cache()`, na produkcji jeden) czyta też korekty wystawione przed
 * oknem do faktur z dniem wpływu w oknie (`correctionsBefore` w
 * `inflows.ts`); okno 5 lat w demo takich faktur nie ma, więc bez odczytu.
 */
const READS_PRZEPLYWOW = 51;

/** Klasy dzisiejszych (sprzed E6) Przepływów Finory — zrzut z renderu 23.10.2026. */
const KLASY_FINORY: string[] = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/przeplywy-finora-klasy.json'), 'utf8'),
);
/**
 * Klasy dodane z konieczności danych: przycięcie długiej nazwy (prawdziwe
 * firmy są dłuższe niż „Czynsz za biuro”) — te same co na Pulpicie (E5).
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
/**
 * Klasy usunięte z konieczności danych: `capitalize` dawała wielką literę
 * w KAŻDYM słowie prawdziwych etykiet („Do Akceptacji”, „Bez Kategorii”);
 * wielką literę na początku daje adapter, więc jednowyrazowe wyglądają tak samo.
 */
const KLASY_USUNIETE = ['capitalize'];
/**
 * Klasy zależne od danych: kolor plakietki statusu w tabeli zależy od tego,
 * jakie statusy są na pierwszej stronie (w szablonie „oczekująca” na
 * żółto). Styl statusów jest w komponencie bez zmian.
 */
const KLASY_Z_DANYCH = [
  '[a&]:hover:bg-amber-600/5', 'bg-amber-600/10', 'dark:[a&]:hover:bg-amber-400/5', 'dark:bg-amber-400/10',
  'dark:focus-visible:ring-amber-400/40', 'dark:text-amber-400', 'focus-visible:ring-amber-600/20', 'text-amber-600',
];

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

function przeplywy(supabase: unknown = memoryClient({}), tenantId = 'firma-a') {
  state.ctx = { supabase, tenantId, user: { id: 'uzytkownik-1', email: null }, role: 'owner' };
  return PrzeplywyPage().then(html);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.proof = { verifiedAt: null, verifiedEnvironment: null };
  state.verified = true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Przepływy przed weryfikacją KSeF: dane przykładowe przez te same loadery', () => {
  it('karty Finory z prawdziwymi podpisami, bez napisów szablonu', async () => {
    const markup = await przeplywy();
    // Dane przykładowe (`lib/demo` bez wpłat): miniony termin gra rolę wpłaty (`przykladoweWplywy`), więc
    // karty są pełne jak zawsze, a napisy te same co u prawdziwej firmy z oznaczonymi wpłatami.
    for (const text of [
      'Przepływy pieniężne', 'Suma wpływów', 'Suma kosztów', 'Tygodniowo', 'Miesięcznie', 'Rocznie',
      'Odłóż na podatek', 'Szacunek PIT od 1 stycznia', 'Szacunek: liniowy, bez ZUS',
      'Wpłynęło w tym miesiącu', 'Koszty w tym miesiącu (brutto)', 'wobec poprzedniego miesiąca',
      'Największe źródła przepływów', 'Spodziewane wpływy', 'Następne 30 dni', 'Termin ',
      'Ostatnia aktywność', 'Wpłata · ', 'Kontrahent', 'Kategoria', 'Status', 'Przykład',
      'Oznaczone wpłaty i koszty brutto', 'Opłacona',
    ]) {
      expect(markup).toContain(text);
    }
    for (const text of [
      'Cel oszczędnościowy', 'Fundusz awaryjny', 'z celu', 'Przychody w tym miesiącu', 'Wydatki w tym miesiącu',
      'Nadchodzące rachunki', 'Czynsz za biuro', 'Wynagrodzenia', 'Rachunek firmowy', 'Rachunek oszczędnościowy',
      'Internet i media', 'Netflix', 'Allegro', 'Jakub Adamski', 'zrealizowana', 'nieudana', 'subskrypcja',
      'Suma wydatków', 'Wpływy i wydatki w czasie', 'Udostępnij', 'Aktualizuj',
      'Termin · ', 'Suma wpłat', 'zaległ', 'nie potwierdzamy', 'Wg terminu', 'Wg wystawienia',
      'Terminy płatności', 'wg terminów', 'według terminów',
    ]) {
      expect(markup).not.toContain(text);
    }
    expect(markup).not.toContain('/images/avatars');
    expect(markup).not.toContain('.example');
  });

  it('wiersze list bez linków do dokumentów — demo nie ma prawdziwych faktur (§11 pkt 6)', async () => {
    const markup = await przeplywy();
    expect(markup).not.toMatch(/href="\/(invoices|expenses)\//);
    expect(markup).not.toContain('href="/contractors"');
  });

  it('siatka Finory bez zmian: ten sam nagłówek i kontenery col-span', async () => {
    const markup = await przeplywy();
    expect(markup).toContain('<h1 class="sr-only">Przepływy pieniężne</h1>');
    expect(markup).toContain('<div class="grid grid-cols-6 gap-6">');
    // Poprawka 23.10.2026: strona renderuje się raz, w całości — karty w kolejności siatki Finory
    // (dawniej prerender dopisywał sloty w kolejności ukończenia i porównywaliśmy zbiór).
    const spans = [...markup.matchAll(/class="[^"]*?((?:col-span-full)(?: [a-z]+:col-span-\d)?)"/g)].map((m) => m[1]);
    expect(spans).toEqual([
      'col-span-full xl:col-span-4',
      'col-span-full xl:col-span-2',
      'col-span-full sm:col-span-3',
      'col-span-full sm:col-span-3',
      'col-span-full lg:col-span-2',
      'col-span-full lg:col-span-2',
      'col-span-full lg:col-span-2',
      'col-span-full',
    ]);
  });

  it('karta nie zmienia klas układu: ten sam zbiór klas co Przepływy Finory', async () => {
    const nowe = klasy(await przeplywy());
    const stare = new Set(KLASY_FINORY);
    const brakujace = KLASY_FINORY.filter((c) => !nowe.has(c) && !KLASY_Z_DANYCH.includes(c) && !KLASY_USUNIETE.includes(c));
    const dodatkowe = [...nowe].filter((c) => !stare.has(c) && !KLASY_DODANE.includes(c));
    expect(brakujace).toEqual([]);
    expect(dodatkowe).toEqual([]);
  });

  it('strona dynamiczna, bez stałych z szablonu', () => {
    const src = readFileSync(join(process.cwd(), 'app/(dashboard)/przeplywy/page.tsx'), 'utf8');
    expect(src).toContain("export const dynamic = 'force-dynamic'");
    expect(src).toContain('kontekstDanych');
    expect(src).not.toMatch(/incomeChartData|transactionsData|upcomingBillsData|recentActivityData|cashFlowSourcesData/);
    for (const file of ['chart-cash-flow.tsx', 'statistics-savings-goal-card.tsx']) {
      const component = readFileSync(join(process.cwd(), 'components/przeplywy/finora-1do1', file), 'utf8');
      expect(component).not.toMatch(/weeklyData|monthlyData|yearlyData|savingsGoalChartData|StatisticsCardData/);
    }
  });
});

describe('Przepływy po weryfikacji KSeF: prawdziwe dane', () => {
  beforeEach(() => {
    state.proof = ZWERYFIKOWANA;
  });

  it('pusta firma: bez znaczników przykładu, pusty stan wpływów prowadzi do oznaczenia zapłaty', async () => {
    const markup = await przeplywy(memoryClient({ ksef_history_sync: [] }));
    expect(ZNACZNIKI_PRZYKLADU.filter((z) => markup.includes(z))).toEqual([]);
    expect(markup).toContain('Oznacz wpłatę przy fakturze');
    expect(markup).toContain('Przejdź do faktur');
    expect(markup).toContain('href="/invoices"');
    expect(markup).not.toContain('Pobieramy faktury z KSeF');
  });

  it('historia sprzedaży się pobiera (stan B): puste karty mówią „Pobieramy faktury z KSeF…”', async () => {
    const markup = await przeplywy(memoryClient({
      ksef_history_sync: [{
        tenant_id: 'firma-a',
        environment: 'test',
        direction: 'outgoing',
        created_at: '2026-10-23T07:00:00Z',
        backfill_completed_at: null,
        client_paused_at: null,
        last_error_code: null,
      }],
    }));
    expect(markup).toContain('Pobieramy faktury z KSeF…');
  });

  it('wiersze list i tabeli prowadzą do dokumentów i kontrahentów (E7 pkt 3)', async () => {
    const markup = await przeplywy(fakePostgrest(danePrzykladowe(NOW, 'test')), DEMO_TENANT);
    expect(markup).toMatch(/href="\/invoices\/[^"]+"/);
    expect(markup).toMatch(/href="\/expenses\/[^"]+"/);
    expect(markup).toContain('href="/contractors"');
  });

  it('T9: liczba odczytów bazy na całe Przepływy — wzrost wymaga świadomej zmiany tej liczby', async () => {
    const reads: Read[] = [];
    await przeplywy(fakePostgrest(danePrzykladowe(NOW, 'test'), reads), DEMO_TENANT);
    // Poza RSC `cache()` nie deduplikuje, więc to górna granica.
    expect(reads.length).toBe(READS_PRZEPLYWOW);
  });

  it('faktura w EUR zabiera tylko karty, które ją czytają; reszta działa', async () => {
    const tables = danePrzykladowe(NOW, 'test');
    // Demo nie ma `paid_at` — wzorem jest faktura sprzedaży; EUR z terminem w tym miesiącu.
    const wzor = tables.invoices!.find((f) => f.direction === 'outgoing')!;
    tables.invoices!.push({
      ...wzor, id: 'eur-1', currency: 'EUR', issue_date: '2026-10-05', sale_date: '2026-10-05', payment_due_date: '2026-10-19',
    });
    const markup = await przeplywy(fakePostgrest(tables), DEMO_TENANT);
    expect(markup).toContain('pomoc@faktway.pl');
    // Koszty nie czytają faktur sprzedaży.
    expect(markup).toContain('Koszty w tym miesiącu (brutto)');
  });
});

describe('Wiersze list: kwota w jednej linii, długa nazwa się przycina (ta sama wysokość wiersza)', () => {
  // Pomiar 23.10.2026 (Chromium, Outfit, 1280 px): przy prawdziwych nazwach firm kwota
  // „6396,00 zł” w „Spodziewanych wpływach” i „Ostatniej aktywności” schodziła do drugiej linii.
  it('kontener kwoty jest nieściśliwy (`shrink-0`) w obu kartach', async () => {
    state.proof = ZWERYFIKOWANA;
    const markup = await przeplywy(fakePostgrest(danePrzykladowe(NOW, 'test')), DEMO_TENANT);
    const kwotyTerminow = [...markup.matchAll(/<span class="([^"]*)">\d[\d\s\u00a0]*,\d{2}\s?zł<\/span>/g)].map((m) => m[1]!.split(' '));
    expect(kwotyTerminow.length).toBeGreaterThan(0);
    for (const cls of kwotyTerminow) expect(cls).toContain('shrink-0');
    const aktywnosc = [...markup.matchAll(/<div class="([^"]*)"><span>[+-](?:<!-- -->)?\d/g)].map((m) => m[1]!.split(' '));
    expect(aktywnosc.length).toBeGreaterThan(0);
    for (const cls of aktywnosc) expect(cls).toContain('shrink-0');
  });
});

describe('Adaptery: napisy w istniejących miejscach, liczba prawdziwa albo jej nie ma', () => {
  const bucket = (label: string, inflow: number, outflow: number, inflowCount = 1) =>
    ({ key: label, label, period: label, inflow, outflow, inflowCount });

  it('wykres: trzy zakładki z danych, podtytuł mówi o oznaczonych wpłatach', () => {
    const dane = adaptery.wykresProps(
      { week: [bucket('13.10', 1, 2)], month: [bucket('Paź', 10, 20)], year: [bucket('2026', 100, 200)] },
      'prawdziwe',
    );
    expect(dane.tabs.yearly.map((b) => b.inflow)).toEqual([100]);
    expect(dane.subTitle).toBe('Oznaczone wpłaty i koszty brutto');
    expect(dane.subTitleHint).toContain('według oznaczonych wpłat');
    const pusty = adaptery.wykresProps(
      { week: [bucket('13.10', 0, 0, 0)], month: [bucket('Paź', 0, 0, 0)], year: [bucket('2026', 0, 0, 0)] },
      'synchronizacja',
    );
    expect(pusty.subTitle).toBe('Pobieramy faktury z KSeF…');
  });

  it('kafel wpływów: bez wpływu „—” i pusty stan prowadzący do oznaczenia, nie „0 zł”', () => {
    const flow = { amount: 0, prevAmount: 500, count: 0, changePct: -100, daily: [{ date: '2026-10-01', value: 0 }] };
    const dane = adaptery.wplywyMiesiacaProps(flow, adaptery.krzywaTygodni([], '2026-10-01'), 'prawdziwe');
    expect(dane.amount).toBe('—');
    expect(dane.changePercentage).toBe('—');
    expect(dane.comparison).toBe('Oznacz wpłatę przy fakturze');
    // Krzywa nie zależy od dnia miesiąca: 1. dnia też 8 punktów (dawniej jeden punkt + dopisane zero).
    expect(dane.chartData).toHaveLength(8);

    const pelny = adaptery.wplywyMiesiacaProps(
      { amount: 1234.5, prevAmount: 1000, count: 2, changePct: 23.45, daily: [{ date: '2026-10-01', value: 0 }, { date: '2026-10-02', value: 1234.5 }] },
      [],
      'prawdziwe',
    );
    // Konwencja `lib/format/pl`: cztery cyfry bez spacji („1235”).
    expect(pelny.amount).toBe('1235 zł');
    expect(pelny.changePercentage).toBe('+23%');
    expect(pelny.comparison).toBe('wobec poprzedniego miesiąca');
  });

  /**
   * Zrzuty 24.10.2026: krzywa kafli to sumy 8 ostatnich tygodni (falista linia
   * z 8 punktów jak w Finorze), nie suma narastająca od 1. dnia miesiąca,
   * która zawsze rosła. Świadomie zastępuje dawny test „jeden punkt dostaje zero”.
   */
  it('krzywa kafli: 8 tygodni pn–nd, ostatni = bieżący, dymek z zakresem tygodnia; spoza okna się nie liczy', () => {
    // Piątek 23.10.2026: bieżący tydzień 19.10–25.10, najstarszy 31.08–06.09.
    const krzywa = adaptery.krzywaTygodni(
      [
        { date: '2026-08-30', amount: 999 }, // niedziela przed oknem
        { date: '2026-08-31', amount: 100 },
        { date: '2026-09-06', amount: 50 },
        { date: '2026-10-12', amount: 300 },
        { date: '2026-10-18', amount: 200 },
        { date: '2026-10-19', amount: 400.25 },
        { date: '2026-10-25', amount: 10 }, // dokument z datą w tym tygodniu, po dziś
        { date: '2026-10-26', amount: 777 }, // następny tydzień
      ],
      '2026-10-23',
    );
    expect(krzywa.map((p) => p.label)).toEqual([
      '31.08–06.09', '07.09–13.09', '14.09–20.09', '21.09–27.09', '28.09–04.10', '05.10–11.10', '12.10–18.10', '19.10–25.10',
    ]);
    expect(krzywa.map((p) => p.value)).toEqual([150, 0, 0, 0, 0, 0, 500, 410.25]);

    // Wpływy: same oznaczone wpłaty (`receivedInflows`), termin to jeszcze nie pieniądze; koszty według daty dokumentu, brutto.
    const wpis = (id: string, date: string, amount: number, basis: 'paid' | 'due') =>
      ({ id, date, amount, basis, dueDate: date, outstanding: basis === 'paid' ? 0 : amount }) as unknown as Parameters<typeof adaptery.krzywaWplywow>[0][number];
    const wplywy = adaptery.krzywaWplywow(
      [wpis('a', '2026-10-20', 100, 'paid'), wpis('b', '2026-10-23', 900, 'due'), wpis('c', '2026-10-21', 700, 'due')],
      '2026-10-23',
    );
    expect(wplywy.at(-1)!.value).toBe(100);
    const koszt = { issueDate: '2026-10-21', outflow: 123, cost: 100 } as unknown as Parameters<typeof adaptery.krzywaKosztow>[0][number];
    expect(adaptery.krzywaKosztow([koszt], '2026-10-23').at(-1)!.value).toBe(123);
  });

  it('źródła: kontrahenci z liczebnikiem, udział z danych, link do kontrahentów tylko w trybie prawdziwym', () => {
    const src = [
      { key: 'in:1', name: 'Alfa', direction: 'in' as const, consumers: false, nip: '1234567890', amount: 5000, count: 3, share: 100 },
      { key: 'out:2', name: 'Beta', direction: 'out' as const, consumers: false, nip: null, amount: 1200, count: 5, share: 60 },
      { key: 'in:3', name: 'Konsumenci', direction: 'in' as const, consumers: true, nip: null, amount: 100, count: 1, share: 2 },
    ];
    const prawdziwe = adaptery.zrodlaProps(src, 'prawdziwe');
    expect(prawdziwe.items.map((s) => s.sourceType)).toEqual(['Klient · 3 wpłaty', 'Dostawca · 5 dokumentów', 'B2C · 1 wpłata']);
    expect(prawdziwe.items.map((s) => s.href)).toEqual(['/contractors', '/contractors', null]);
    expect(prawdziwe.items[1]!.share).toBe(60);
    expect(adaptery.zrodlaProps(src, 'przyklad').items.every((s) => s.href === null)).toBe(true);
  });

  it('spodziewane wpływy: termin dziś / jutro / za N dni, kwota pozostała, otwarte faktury bez oznaczonej zapłaty', () => {
    const items = [0, 1, 12].map((daysLeft, i) => ({
      id: `f${i}`, name: `Klient ${i}`, internalNumber: `FV/${i}`, dueDate: '2026-10-23', daysLeft, amount: 1850,
    }));
    const dane = adaptery.wplywySpodziewaneProps(items, 'prawdziwe');
    expect(dane.items.map((b) => b.dueDate)).toEqual(['Termin dziś', 'Termin jutro', 'Termin za 12 dni']);
    expect(dane.items[0]!.amount).toBe('1850,00 zł');
    expect(dane.items[0]!.href).toBe('/invoices/f0');
    expect(dane.note).toMatch(/bez oznaczonej zapłaty/);
    expect(dane.note).not.toMatch(/nie potwierdzamy/);
  });

  it('operacje: kontrahent, rodzaj i data; korekta kosztu in minus to pieniądze na plus', () => {
    const ops = [
      { id: 'in:a', direction: 'in' as const, date: '2026-10-21', counterparty: 'Alfa', nip: '1234567890', reference: 'FV/10/2026/099', category: 'Sprzedaż', status: 'paid' as const, amount: 3200, href: '/invoices/a' },
      { id: 'out:b', direction: 'out' as const, date: '2026-10-20', counterparty: 'Beta Paliwa', nip: null, reference: 'KOR/1', category: 'Paliwo', status: 'pending' as const, amount: -50, href: '/expenses/b' },
    ];
    const lista = adaptery.aktywnoscProps(ops, 'prawdziwe');
    expect(lista.items[0]).toMatchObject({ label: 'Alfa', subLabel: 'Wpłata · 21.10.2026', direction: 'in', href: '/invoices/a' });
    expect(lista.items[1]).toMatchObject({ subLabel: 'Koszt · 20.10.2026', direction: 'in' });
    expect(lista.items[1]!.amount.replace(/\u00a0/g, ' ')).toBe('50,00 zł');

    const tabela = adaptery.tabelaProps(ops, 'prawdziwe');
    expect(tabela.rows[0]).toMatchObject({ initials: 'AL', detail: 'NIP 1234567890 · FV/10/2026/099', category: 'Sprzedaż', status: 'paid', href: '/invoices/a' });
    expect(tabela.rows[1]).toMatchObject({ initials: 'BP', detail: 'KOR/1', status: 'pending', direction: 'in', amount: 50 });
    expect(adaptery.tabelaProps([{ ...ops[1]!, category: 'paliwo i myjnia' }], 'prawdziwe').rows[0]!.category).toBe('Paliwo i myjnia');
    expect(adaptery.tabelaProps(ops, 'przyklad').rows.every((r) => r.href === null)).toBe(true);
  });

  // Zrzuty 24.10.2026: łuk = pokazany procent (19% na jasnym torze, jak 68% w Finorze), nie pełny łuk przy napisie „19%”.
  it('podatek (Z10): łuk = stawka 19%, kwota szacunku, podpis „szacunek”', () => {
    const dane = adaptery.podatekProps({ amount: 8400, label: 'Szac. podatek od 1 stycznia', subtitle: '19% liniowy', fullYear: true }, 'prawdziwe');
    expect(dane).toMatchObject({ title: 'Odłóż na podatek', subtitle: 'Szacunek PIT od 1 stycznia', pct: 19 });
    expect(dane.lines.map((l) => l.replace(/\u00a0/g, ' '))).toEqual(['19%', '8,4 tys. zł', 'do odłożenia']);
    expect(dane.caption).toBe('Szacunek: liniowy, bez ZUS');
  });

  it('limit zwolnienia z VAT: procent, kwota z limitu, prognoza', () => {
    const base = {
      year: 2026, today: '2026-10-23', months: [], cumulative: [], used: 163200, annualLimit: 240000, startedOn: '2020-01-01',
      limit: { effectiveLimit: 240000, prorated: false, activeDays: 365, daysInYear: 365, pct: 68, remaining: 76800, level: 60 as const, formula: '', crossesOn: '2026-12-12' },
      lowerBound: null,
    };
    const dane = adaptery.limitProps(base, 'prawdziwe');
    expect(dane).toMatchObject({ title: 'Limit zwolnienia z VAT', subtitle: 'Sprzedaż od 1 stycznia', pct: 68 });
    expect(dane.lines.map((l) => l.replace(/\u00a0/g, ' '))).toEqual(['68%', '163,2 tys. zł', 'z 240 tys. zł']);
    expect(dane.caption).toBe('Limit skończy się ok. 12.12.2026');
    const bezDaty = adaptery.limitProps({ ...base, startedOn: null, limit: null, lowerBound: { pct: 68, level: 60, remaining: 0 } }, 'prawdziwe');
    expect(bezDaty.lines[0]).toBe('≥68%');
  });
});

// ─── Dawna siatka `PrzeplywyGrid` (w kodzie, nieużywana przez stronę od E6) ──

const { default: VatSummaryCard } = await import('@/components/przeplywy/finora/chart-net-worth');
const { TaxSavingsGoalCard, VatLimitGoalCard } = await import('@/components/przeplywy/finora/statistics-savings-goal-card');
const { default: StatisticsAreaStatCard } = await import('@/components/przeplywy/finora/statistics-area-stat-card');
const grid = await import('@/components/przeplywy/przeplywy-grid');

const TENANT = 'firma-a';
const NOW_ISO = '2026-10-20T10:00:00.000Z';

function sale(id: string, fields: Row = {}): Row {
  return {
    id, tenant_id: TENANT, direction: 'outgoing', origin: 'app', ksef_status: 'accepted', ksef_environment: 'test',
    invoice_kind: 'regular', invoice_type: 'VAT', currency: 'PLN', advance_invoice_ids: [], parent_invoice_id: null,
    issue_date: '2026-10-05', sale_date: null, net_total: 1000, vat_total: 230, gross_total: 1230,
    paid_amount: 0, paid_at: null, payment_data: null, payment_due_date: '2026-10-25', payment_status: 'unpaid',
    buyer_nip: '1234567890', buyer_data: { name: 'Alfa sp. z o.o.' }, is_b2c: false, internal_number: `FV/${id}`,
    ...fields,
  };
}

function cost(id: string, fields: Row = {}): Row {
  return {
    id, tenant_id: TENANT, source: 'manual', ksef_invoice_id: null, is_deductible: true, is_reviewed: true,
    issue_date: '2026-10-07', seller_nip: '9999999999', seller_name: 'Dostawca', document_number: 'D/1',
    category_label: 'Paliwo', document_type: 'invoice', net_amount: 100, vat_amount: 23, gross_amount: 123,
    vat_deductible_amount: 23, ocr_extracted_data: null, kpir_column: 'col_13',
    ...fields,
  };
}

function db(tables: MemoryTables) {
  return memoryClient({ tenants: [{ id: TENANT, vat_exemption_basis: null, business_started_on: null }], ...tables }) as unknown as PageContext['supabase'];
}

const props = (supabase: PageContext['supabase']) => ({ supabase, tenantId: TENANT, nowIso: NOW_ISO });

/** Element zwrócony przez kartę (ładowarka zwraca gotowy element). */
async function card(promise: Promise<unknown>): Promise<ReactElement<Record<string, unknown>>> {
  return (await promise) as ReactElement<Record<string, unknown>>;
}

describe('dawna siatka: jedna karta = jedno źródło awarii', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date(NOW_ISO));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('każda karta w osobnej granicy błędu i Suspense', () => {
    const el = grid.PrzeplywyGrid(props(db({}))) as ReactElement<{ children: ReactElement[] }>;
    const slots = (el.props.children as ReactElement[]).flatMap((child) =>
      (child.props as { title?: string }).title !== undefined
        ? [child]
        : ((child.props as { children: ReactElement[] }).children ?? []));
    expect(slots.map((slot) => (slot.props as { title: string }).title)).toHaveLength(12);
  });

  // Wpływy to te same faktury sprzedaży co przychód, więc faktura w EUR z terminem w oknie
  // zatrzymuje też karty wpływów (jak przychód); karta kosztów dalej działa.
  it('faktura sprzedaży w EUR zatrzymuje karty sprzedaży i wpływów, a karta kosztów działa', async () => {
    const supabase = db({
      invoices: [
        sale('eur', { currency: 'EUR' }),
        sale('paid', { paid_amount: 1230, paid_at: '2026-10-10T10:00:00Z', payment_status: 'paid' }),
      ],
      expenses: [cost('e1')],
    });

    const vat = await card(grid.VatSummarySlotCard(props(supabase)));
    const kpir = await card(grid.KpirFinanceSlotCard(props(supabase)));
    const inflow = await card(grid.InflowMonthSlotCard(props(supabase)));
    const outflow = await card(grid.OutflowMonthSlotCard(props(supabase)));

    expect(vat.type).toBe(grid.PrzeplywyCardError);
    expect(String(vat.props.message)).toMatch(/PLN/);
    expect(kpir.type).toBe(grid.PrzeplywyCardError);
    expect(inflow.type).toBe(grid.PrzeplywyCardError);
    expect(String(inflow.props.message)).toMatch(/PLN/);
    expect(outflow.type).toBe(StatisticsAreaStatCard);
    expect((outflow.props.flow as { amount: number }).amount).toBe(123);
  });

  it('dane z bazy idą do kart sprzedaży i VAT', async () => {
    const supabase = db({ invoices: [sale('a'), sale('szkic', { ksef_status: 'draft', ksef_environment: null })], expenses: [] });
    const vat = await card(grid.VatSummarySlotCard(props(supabase)));
    expect(vat.type).toBe(VatSummaryCard);
    expect(vat.props).toMatchObject({ totalNet: 1000, totalVat: 230, totalGross: 1230, acceptedCount: 1, draftCount: 1 });
  });

  it('płatnik VAT: „Odłóż na podatek”; zwolniony podmiotowo: limit + dopisek podatku', async () => {
    const payer = await card(grid.GoalSlotCard(props(db({ invoices: [sale('a')], expenses: [] }))));
    expect(payer.type).toBe(TaxSavingsGoalCard);
    expect((payer.props.estimate as { amount: number }).amount).toBe(190);

    const exemptDb = memoryClient({
      tenants: [{ id: TENANT, vat_exemption_basis: 'art. 113 ust. 1', business_started_on: '2024-01-01' }],
      invoices: [sale('a')],
      expenses: [],
    }) as unknown as PageContext['supabase'];
    const exempt = await card(grid.GoalSlotCard(props(exemptDb)));
    expect(exempt.type).toBe(VatLimitGoalCard);
    expect(exempt.props.used).toBe(1000);
  });

  it('wydatki bez KSeF i bez kosztów: podpowiedź „Podłącz KSeF”', async () => {
    state.verified = false;
    const outflow = await card(grid.OutflowMonthSlotCard(props(db({ invoices: [], expenses: [] }))));
    expect(outflow.type).toBe(StatisticsAreaStatCard);
    expect(outflow.props.empty).toMatchObject({ href: '/settings/ksef' });
  });

  it('baner wydatków do akceptacji: liczebnik i link; zero — bez banera', async () => {
    const two = (await grid.PendingReviewAlert({
      supabase: db({ expenses: [cost('a', { is_reviewed: false }), cost('b', { is_reviewed: false })] }),
      tenantId: TENANT,
    })) as ReactElement;
    const { renderToStaticMarkup } = await import('react-dom/server');
    const out = renderToStaticMarkup(two);
    expect(out).toContain('2 wydatki czekają na akceptację');
    expect(await grid.PendingReviewAlert({ supabase: db({ expenses: [cost('a')] }), tenantId: TENANT })).toBeNull();
  });

  it('„Zaległości”: ten sam podpis co „Należności”, z pominiętą fakturą w walucie obcej', async () => {
    const supabase = db({
      invoices: [sale('pln', { payment_due_date: '2026-10-01' }), sale('eur', { currency: 'EUR', payment_due_date: '2026-10-01' })],
      expenses: [],
    });
    const receivables = await card(grid.ReceivablesSlotCard(props(supabase)));
    const overdue = await card(grid.OverdueSlotCard(props(supabase)));
    expect(String(receivables.props.note)).toContain('Pominięto 1 fakturę w walucie obcej');
    expect(overdue.props.note).toBe(receivables.props.note);
  });
});
