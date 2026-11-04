import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Poprawka Bartosza 21.10.2026 („dawaj koszty teraz”): menu ma jedną pozycję
 * „Koszty”, a ekran ma zakładki Wydatki / Skrzynka KSeF — ten sam rząd zakładek
 * „line” Finory co Faktury (`SectionTabs`), pierwszy w karcie z tabelą. Karta
 * sięga do stopki pustym arkuszem (`ff-page-fill`), paginacja stoi na dole
 * karty, a pusty stan na środku pustego arkusza.
 *
 * Poprawka Bartosza 25.10.2026: jedna strona, nie dwie podstrony. Kafle (jedne
 * dla sekcji), karta i rząd zakładek stoją w `(koszty)/layout.tsx`, a strona
 * zakładki to sama zawartość karty.
 */

const ctx = vi.hoisted(() => ({ supabase: null as unknown, tenantId: 'firma-a' }));

vi.mock('@/lib/supabase/page-context', () => ({ getPageContext: async () => ctx }));
// Kafle mają własne testy (`wydatki-skrzynka-ekran.test.tsx`); tu tylko układ strony.
vi.mock('@/lib/dashboard/expense-stats', () => ({
  getExpenseMonthTotals: vi.fn(async () => ({ month: '2026-10', gross: 0, vatDeductible: 0 })),
  getRecurringExpenseStats: vi.fn(async () => ({ recurring: [], recurringTotal: 0 })),
  getInboxMonthCosts: vi.fn(async () => ({ month: '2026-10', gross: 0, count: 0 })),
  countExpensesToReview: vi.fn(async () => 0),
  getLastInboxFetchAt: vi.fn(async () => null),
  getInboxScheduleSummary: vi.fn(async () => null),
}));
// Strona zleca przyspieszenie terminu po odpowiedzi; poza żądaniem `after` by rzucił.
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/ksef/inbox-activity', () => ({ requestInboxPollOnVisit: vi.fn() }));
vi.mock('@/lib/demo/tryb-danych', () => ({ trybDanych: vi.fn(async () => ({ tryb: 'prawdziwe', stan: 'C', verifiedAt: null })) }));
const nav = vi.hoisted(() => ({ pathname: '/expenses' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => nav.pathname,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/expenses', () => ({
  deleteExpenseAction: vi.fn(),
  reviewExpenseAction: vi.fn(),
  uploadExpensePhotoAction: vi.fn(),
  getOcrJobStatusAction: vi.fn(),
}));

const { memoryClient } = await import('./helpers/baza-w-pamieci');
const { Card } = await import('@/components/ui/card');
const { COSTS_TABS, CostsTabs } = await import('@/components/expenses/costs-tabs');
const { SectionTabs } = await import('@/components/lists/section-tabs');
const { INVOICES_TABS, InvoicesTabs } = await import('@/components/invoices/invoices-tabs');
const { ExpensesTable } = await import('@/components/expenses/finora/expenses-table');
const { ExpenseStatsCards } = await import('@/components/expenses/finora/expense-stat-cells');
const { default: MonthSelector } = await import('@/components/expenses/finora/month-selector');
const { InboxTable } = await import('@/app/(dashboard)/(koszty)/inbox/_components/inbox-table');
const { default: ExpensesPage } = await import('@/app/(dashboard)/(koszty)/expenses/page');
const { default: InboxPage } = await import('@/app/(dashboard)/(koszty)/inbox/page');
const { default: KosztyLayout } = await import('@/app/(dashboard)/(koszty)/layout');
const { SectionTabsNav, activeSectionTab } = await import('@/components/lists/section-tabs-nav');
const { StatsCardsFrame } = await import('@/components/expenses/finora/stats-cards');
const { StatSlot } = await import('@/components/expenses/finora/stat-slot');
const { dashboardNavItems, isActiveNavPath } = await import('@/lib/dashboard-nav-config');
const { buildPaletteNavEntries } = await import('@/lib/command-palette');

/** Linki zakładek Kosztów w kolejności: [href, aktywna?]. */
function tabs(html: string): Array<[string, boolean]> {
  const nav = /<nav aria-label="Rodzaje kosztów"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
  expect(nav, 'brak paska zakładek Kosztów').not.toBeNull();
  return [...nav![1]!.matchAll(/<a([^>]*)>/g)].map(([, attrs]) => [
    /href="([^"]*)"/.exec(attrs!)![1]!,
    attrs!.includes('aria-current="page"'),
  ]);
}

/** Elementy drzewa Reacta (bez renderowania komponentów) — do stron serwerowych z bazą. */
function elements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((child) => elements(child, out));
  else if (isValidElement(node)) {
    out.push(node);
    elements((node.props as { children?: ReactNode }).children, out);
  }
  return out;
}

const props = (el: ReactElement) => el.props as Record<string, unknown>;
const activeCostsTabs = (tree: ReactNode) =>
  elements(tree).filter((el) => el.type === CostsTabs).map((el) => props(el).active);

/** Klient, którego każde zapytanie kończy się błędem odczytu. */
function failingClient() {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit']) chain[method] = () => chain;
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: null, error: { message: 'connection reset' } }).then(resolve);
  return { from: () => chain };
}

function incoming(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `inv-${i}`,
    tenant_id: 'firma-a',
    direction: 'incoming',
    internal_number: `FA/${i}/10/2026`,
    ksef_number: `1234567890-20261005-ABCDEF-${String(i).padStart(3, '0')}`,
    issue_date: '2026-10-05',
    seller_nip: '1234567890',
    seller_data: { name: 'Hosting S.A.', nip: '1234567890' },
    fa3_data: null,
    gross_total: '615.00',
    currency: 'PLN',
    ksef_accepted_at: `2026-10-05T10:${String(i % 60).padStart(2, '0')}:00Z`,
    created_at: '2026-10-05T10:00:00Z',
  }));
}

beforeEach(() => {
  ctx.supabase = memoryClient({ expenses: [], invoices: [] });
});

describe('CostsTabs — zakładki Kosztów', () => {
  it('dwie zakładki w kolejności, każda ze swoim adresem (stare adresy zostają)', () => {
    expect(COSTS_TABS.map((t) => [t.label, t.href])).toEqual([
      ['Wydatki', '/expenses'],
      ['Skrzynka KSeF', '/inbox'],
    ]);
    expect(tabs(renderToStaticMarkup(<CostsTabs active="wydatki" />))).toEqual([
      ['/expenses', true],
      ['/inbox', false],
    ]);
    expect(tabs(renderToStaticMarkup(<CostsTabs active="skrzynka" />))).toEqual([
      ['/expenses', false],
      ['/inbox', true],
    ]);
  });

  it('nawigacja jak na Fakturach: ten sam rząd `SectionTabs`, jedna podkreślona zakładka', () => {
    const html = renderToStaticMarkup(<CostsTabs active="skrzynka" />);
    expect(html).not.toContain('role="tablist"');
    expect(html).toMatch(/<nav aria-label="Rodzaje kosztów" class="[^"]*\bh-11\b[^"]*\bborder-b\b/);
    expect(html.match(/after:opacity-100/g)).toHaveLength(1);
    // Faktury i Koszty rysuje ten sam komponent — wygląd nie rozjedzie się między ekranami.
    expect(renderToStaticMarkup(<InvoicesTabs active="cykliczne" />)).toBe(
      renderToStaticMarkup(<SectionTabs label="Rodzaje faktur" tabs={INVOICES_TABS} active="cykliczne" />),
    );
  });
});

describe('jedna strona sekcji Kosztów (25.10.2026)', () => {
  it('layout: jedne kafle sekcji, karta z rzędem zakładek Kosztów, strona zakładki w karcie', async () => {
    ctx.supabase = memoryClient({ invoices: [], expenses: [] });
    const tree = await KosztyLayout({ children: <p id="tabela">tabela</p> });
    expect(props(tree).className).toContain('ff-page-fill');
    const all = elements(tree);
    const frame = all.find((el) => el.type === StatsCardsFrame)!;
    const labels = elements(props(frame).cells as ReactNode)
      .filter((el) => el.type === StatSlot)
      .map((el) => props(el).label);
    expect(labels).toEqual(['Wydatki w tym miesiącu', 'VAT do odliczenia', 'Do opisania', 'Ostatnie pobranie z KSeF']);
    const card = all.find((el) => el.type === Card)!;
    const inCard = elements(props(card).children as ReactNode);
    expect(props(inCard.find((el) => el.type === SectionTabsNav)!).tabs).toBe(COSTS_TABS);
    expect(inCard.some((el) => props(el).id === 'tabela')).toBe(true);
    // Kafle sekcji liczą bieżący miesiąc, niezależnie od filtra tabeli.
    expect(all.some((el) => el.type === MonthSelector)).toBe(false);
  });

  it('aktywna zakładka z adresu', () => {
    expect(activeSectionTab('/expenses', COSTS_TABS)).toBe('wydatki');
    expect(activeSectionTab('/inbox', COSTS_TABS)).toBe('skrzynka');
    for (const [pathname, active] of [['/expenses', ['/expenses', true]], ['/inbox', ['/inbox', true]]] as const) {
      nav.pathname = pathname;
      const html = renderToStaticMarkup(<SectionTabsNav label="Rodzaje kosztów" tabs={COSTS_TABS} />);
      expect(tabs(html).filter(([, on]) => on)).toEqual([active]);
    }
  });
});

describe('Wydatki (/expenses) — zakładka „Wydatki”', () => {
  it('zawartość karty sekcji: tytuł tylko dla czytników, tabela, bez kafli i zakładek', async () => {
    const tree = await ExpensesPage({ searchParams: Promise.resolve({}) });
    expect(String(props(tree).className).split(' ')).toEqual(expect.arrayContaining(['ff-tab-panel', 'flex-1', 'flex-col']));
    expect(activeCostsTabs(tree)).toEqual([]);
    const headings = elements(tree).filter((el) => el.type === 'h1');
    expect(headings.map((el) => [props(el).className, props(el).children])).toEqual([['sr-only', 'Wydatki']]);
    expect(elements(tree).some((el) => el.type === ExpensesTable)).toBe(true);
    expect(elements(tree).some((el) => el.type === ExpenseStatsCards || el.type === Card)).toBe(false);
  });

  it('„Miesiąc / Do opisania” i wybór miesiąca filtrują tabelę — w jej pasku, linki bez przewijania', async () => {
    const tree = await ExpensesPage({ searchParams: Promise.resolve({ miesiac: '2026-09' }) });
    const all = elements(tree);
    const switcher = all.find((el) => el.type === 'nav' && props(el)['aria-label'] === 'Widok listy wydatków')!;
    expect(switcher).toBeDefined();
    for (const link of elements(props(switcher).children as ReactNode).filter((el) => props(el).href)) {
      expect(props(link)).toMatchObject({ prefetch: true, scroll: false });
    }
    const selector = all.find((el) => el.type === MonthSelector);
    expect(props(selector!)).toMatchObject({ month: '2026-09', basePath: '/expenses' });
    // Pasek stoi nad tabelą, w karcie.
    expect(all.indexOf(selector!)).toBeLessThan(all.findIndex((el) => el.type === ExpensesTable));

    const unreviewed = elements(await ExpensesPage({ searchParams: Promise.resolve({ filter: 'unreviewed' }) }));
    expect(unreviewed.some((el) => el.type === 'nav' && props(el)['aria-label'] === 'Widok listy wydatków')).toBe(true);
    expect(unreviewed.some((el) => el.type === MonthSelector)).toBe(false);
  });

  it('błąd odczytu: komunikat w karcie sekcji, „+ Dodaj wydatek” przy nim od lg', async () => {
    ctx.supabase = failingClient();
    const html = renderToStaticMarkup(await ExpensesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('Nie udało się pobrać wydatków');
    // Zakładki (przejście do Skrzynki) daje layout sekcji, nad tym komunikatem.
    expect(html).not.toContain('Rodzaje kosztów');
    expect(html.match(/\+ Dodaj wydatek/g)).toHaveLength(2);
  });
});

describe('Skrzynka KSeF (/inbox) — zakładka „Skrzynka KSeF”', () => {
  it('zawartość karty sekcji: tytuł tylko dla czytników, bez stałego podtytułu, bez kafli i zakładek', async () => {
    ctx.supabase = memoryClient({ invoices: incoming(3), expenses: [] });
    const tree = await InboxPage();
    expect(props(tree).className).toContain('ff-tab-panel');
    expect(activeCostsTabs(tree)).toEqual([]);

    const html = renderToStaticMarkup(tree);
    expect(html).toContain('<h1 class="sr-only">Skrzynka KSeF</h1>');
    expect(html).not.toContain('aktualizowane co 15 minut');
    expect(html).not.toContain('maks. 200');
    expect(html).not.toContain('Rodzaje kosztów');
    expect(html).not.toContain('data-slot="card"');
  });

  it('limit 200 pozycji: krótka nota tylko wtedy, gdy lista go osiąga', async () => {
    ctx.supabase = memoryClient({ invoices: incoming(199), expenses: [] });
    const below = renderToStaticMarkup(await InboxPage());
    expect(below).toContain('z <span>199</span>');
    expect(below).not.toContain('najnowszych faktur');

    ctx.supabase = memoryClient({ invoices: incoming(205), expenses: [] });
    const at = renderToStaticMarkup(await InboxPage());
    expect(at).toContain('z <span>200</span>');
    expect(at.match(/Pokazujemy 200 najnowszych faktur według daty przyjęcia w KSeF\./g)).toHaveLength(1);
    // Nota pod paginacją, na dole karty.
    expect(at.indexOf('najnowszych faktur')).toBeGreaterThan(at.indexOf('Następna strona'));
  });

  it('nieudany odczyt statusu: komunikat nad tabelą', async () => {
    const client = memoryClient({ invoices: incoming(1) });
    ctx.supabase = {
      from: (table: string) => (table === 'expenses' ? failingClient().from() : client.from(table)),
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const html = renderToStaticMarkup(await InboxPage());
    error.mockRestore();
    expect(html.indexOf('Nie udało się sprawdzić statusu faktur')).toBeGreaterThan(-1);
    expect(html.indexOf('Nie udało się sprawdzić statusu faktur')).toBeLessThan(html.indexOf('FA/0/10/2026'));
  });

  it('błąd odczytu faktur: komunikat w karcie sekcji (zakładki z layoutu prowadzą do Wydatków)', async () => {
    ctx.supabase = failingClient();
    const html = renderToStaticMarkup(await InboxPage());
    expect(html).toContain('Nie udało się pobrać faktur: connection reset');
    expect(html).not.toContain('Rodzaje kosztów');
  });
});

describe('tabela listy rośnie do dołu karty', () => {
  it('korzeń i obszar listy to rosnące kolumny — paginacja na dole karty', () => {
    const html = renderToStaticMarkup(<InboxTable rows={[]} />);
    expect(html.startsWith('<div class="flex w-full flex-1 flex-col"><div class="flex flex-1 flex-col border-b">')).toBe(true);
  });

  it('pusty stan stoi na środku pustego arkusza (Skrzynka i Wydatki)', () => {
    const centred = /<div class="flex flex-1 flex-col justify-center border-t">(?:(?!<\/h3>)[\s\S])*<h3[^>]*>([^<]*)<\/h3>/;
    expect(centred.exec(renderToStaticMarkup(<InboxTable rows={[]} />))?.[1]).toBe('Brak faktur przychodzących');
    expect(centred.exec(renderToStaticMarkup(<ExpensesTable expenses={[]} listVariant="month" />))?.[1]).toBe(
      'Brak wydatków w tym miesiącu',
    );
  });
});

describe('menu i ⌘K', () => {
  it('jedna pozycja „Koszty” świeci na obu zakładkach; ⌘K prowadzi do każdej wprost', () => {
    const costs = dashboardNavItems.filter((i) => i.href === '/expenses' || i.href === '/inbox');
    expect(costs.map((i) => [i.label, i.href])).toEqual([['Koszty', '/expenses']]);
    for (const tab of COSTS_TABS) expect(isActiveNavPath(tab.href, '/expenses'), tab.href).toBe(true);

    const palette = buildPaletteNavEntries();
    for (const tab of COSTS_TABS) {
      const entry = palette.find((e) => e.label === tab.label);
      expect(entry?.href, tab.label).toBe(tab.href);
      expect(entry?.keywords, tab.label).toContain('Koszty');
    }
  });
});
