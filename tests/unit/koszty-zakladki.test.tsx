import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Poprawka Bartosza 21.10.2026 („dawaj koszty teraz”): menu ma jedną pozycję
 * „Koszty”, a ekran ma zakładki Wydatki / Skrzynka KSeF — ten sam rząd zakładek
 * „line” Finory co Faktury (`SectionTabs`), pierwszy w karcie z tabelą. Karta
 * sięga do stopki pustym arkuszem (`ff-page-fill`), paginacja stoi na dole
 * karty, a pusty stan na środku pustego arkusza.
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
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
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
const { InboxTable } = await import('@/app/(dashboard)/inbox/_components/inbox-table');
const { default: ExpensesPage } = await import('@/app/(dashboard)/expenses/page');
const { default: InboxPage } = await import('@/app/(dashboard)/inbox/page');
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

describe('Wydatki (/expenses) — zakładka „Wydatki”', () => {
  it('pełny arkusz, tytuł tylko dla czytników, zakładki w karcie z tabelą', async () => {
    const tree = await ExpensesPage({ searchParams: Promise.resolve({}) });
    expect(props(tree).className).toContain('ff-page-fill');
    // Karta sięga stopki na obu zakładkach — korzeń bez dolnego odstępu (pływający
    // „+ Dodaj wydatek” ma miejsce nad stopką), tak samo jak w Skrzynce KSeF.
    expect(props(tree).className).toBe('ff-page-fill flex flex-col gap-6');
    expect(activeCostsTabs(tree)).toEqual(['wydatki']);
    const headings = elements(tree).filter((el) => el.type === 'h1');
    expect(headings.map((el) => [props(el).className, props(el).children])).toEqual([['sr-only', 'Wydatki']]);

    const card = elements(tree).find(
      (el) => el.type === Card && elements(props(el).children as ReactNode).some((c) => c.type === ExpensesTable),
    );
    expect(props(card!).className).toBe('flex-1 pt-0');
    expect(elements(props(card!).children as ReactNode)[0]!.type).toBe(CostsTabs);
  });

  it('przełącznik „Miesiąc / Do opisania” i wybór miesiąca zostają — w rzędzie nad kaflami, do prawej', async () => {
    const tree = await ExpensesPage({ searchParams: Promise.resolve({ miesiac: '2026-09' }) });
    const all = elements(tree);
    const switcher = all.find((el) => el.type === 'nav' && props(el)['aria-label'] === 'Widok listy wydatków');
    expect(switcher).toBeDefined();
    const selector = all.find((el) => el.type === MonthSelector);
    expect(props(selector!)).toMatchObject({ month: '2026-09', basePath: '/expenses' });
    const row = all.find((el) => elements(props(el).children as ReactNode).includes(switcher!) && el !== tree);
    expect(String(props(row!).className).split(' ')).toContain('justify-end');
    // Przełącznik i miesiąc sterują kaflami i tabelą, więc stoją przed kaflami.
    expect(all.indexOf(selector!)).toBeLessThan(all.findIndex((el) => el.type === ExpenseStatsCards));

    const unreviewed = elements(await ExpensesPage({ searchParams: Promise.resolve({ filter: 'unreviewed' }) }));
    expect(unreviewed.some((el) => el.type === 'nav' && props(el)['aria-label'] === 'Widok listy wydatków')).toBe(true);
    expect(unreviewed.some((el) => el.type === MonthSelector)).toBe(false);
  });

  it('błąd odczytu: komunikat w karcie z zakładkami, „+ Dodaj wydatek” przy nim od lg', async () => {
    ctx.supabase = failingClient();
    const tree = await ExpensesPage({ searchParams: Promise.resolve({}) });
    expect(activeCostsTabs(tree)).toEqual(['wydatki']);
    const html = renderToStaticMarkup(tree);
    // Ostatnia karta to karta listy: zakładki, potem komunikat.
    const listCard = html.slice(html.lastIndexOf('data-slot="card"'));
    expect(listCard.indexOf('Rodzaje kosztów')).toBeGreaterThan(-1);
    expect(listCard.indexOf('Rodzaje kosztów')).toBeLessThan(listCard.indexOf('Nie udało się pobrać wydatków'));
    expect(html.match(/\+ Dodaj wydatek/g)).toHaveLength(2);
  });
});

describe('Skrzynka KSeF (/inbox) — zakładka „Skrzynka KSeF”', () => {
  it('pełny arkusz, tytuł tylko dla czytników, bez stałego podtytułu, zakładki w karcie', async () => {
    ctx.supabase = memoryClient({ invoices: incoming(3), expenses: [] });
    const tree = await InboxPage();
    expect(props(tree).className).toContain('ff-page-fill');
    expect(activeCostsTabs(tree)).toEqual(['skrzynka']);

    const html = renderToStaticMarkup(tree);
    expect(html).toContain('<h1 class="sr-only">Skrzynka KSeF</h1>');
    expect(html).not.toContain('aktualizowane co 15 minut');
    expect(html).not.toContain('maks. 200');
    expect(tabs(html)).toEqual([
      ['/expenses', false],
      ['/inbox', true],
    ]);
    expect(html).toMatch(/data-slot="card"[^>]*class="[^"]*\bflex-1\b[^"]*\bpt-0\b[^"]*"><nav aria-label="Rodzaje kosztów"/);
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
    // Nota w karcie listy, pod paginacją — nie nad kaflami.
    expect(at.indexOf('najnowszych faktur')).toBeGreaterThan(at.indexOf('Następna strona'));
  });

  it('nieudany odczyt statusu: komunikat w karcie, pod zakładkami', async () => {
    const client = memoryClient({ invoices: incoming(1) });
    ctx.supabase = {
      from: (table: string) => (table === 'expenses' ? failingClient().from() : client.from(table)),
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const html = renderToStaticMarkup(await InboxPage());
    error.mockRestore();
    const listCard = html.slice(html.lastIndexOf('data-slot="card"'));
    expect(listCard.indexOf('Rodzaje kosztów')).toBeGreaterThan(-1);
    expect(listCard.indexOf('Rodzaje kosztów')).toBeLessThan(listCard.indexOf('Nie udało się sprawdzić statusu faktur'));
  });

  it('błąd odczytu faktur: komunikat w karcie z zakładkami (da się przejść do Wydatków)', async () => {
    ctx.supabase = failingClient();
    const tree = await InboxPage();
    expect(activeCostsTabs(tree)).toEqual(['skrzynka']);
    const listCard = renderToStaticMarkup(tree).split('data-slot="card"').at(-1)!;
    expect(listCard).toContain('href="/expenses"');
    expect(listCard).toContain('Nie udało się pobrać faktur: connection reset');
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
