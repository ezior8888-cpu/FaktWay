import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Poprawka Bartosza 21.10.2026: ekran „Faktury” ma zakładki Wystawione /
 * Cykliczne / Po terminie (wygląd zakładek „line” Finory, pierwszy rząd karty
 * z tabelą), a karta sięga do stopki PUSTYM arkuszem — bez dorysowanych pustych
 * wierszy. Stopka (Regulamin, Polityka, Pomoc) stoi na samym dole strony.
 *
 * Poprawka Bartosza 25.10.2026: jedna strona, nie trzy podstrony. Baner, kafle,
 * karta i rząd zakładek stoją w `(faktury)/layout.tsx` (nie renderuje się
 * ponownie przy zmianie zakładki), a strona zakładki to sama zawartość karty.
 */

const nav = vi.hoisted(() => ({ pathname: '/invoices' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => nav.pathname,
  redirect: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/recurring-invoices', () => ({
  createRecurringInvoiceAction: vi.fn(),
  updateRecurringInvoiceAction: vi.fn(),
  pauseRecurringInvoiceAction: vi.fn(),
  resumeRecurringInvoiceAction: vi.fn(),
  deleteRecurringInvoiceAction: vi.fn(),
}));
vi.mock('@/app/actions/recurring-invoice-templates', () => ({ searchRecurringTemplatesAction: vi.fn() }));
vi.mock('@/components/reminders/reminder-consent-dialog', () => ({ ReminderConsentDialog: () => null }));
vi.mock('@/app/actions/reminders', () => ({ toggleInvoiceRemindersAction: vi.fn() }));
vi.mock('@/lib/supabase/page-context', () => ({
  getPageContext: async () => ({ supabase: memoryClient({ invoices: [] }), tenantId: 'firma-a' }),
}));

const { memoryClient } = await import('./helpers/baza-w-pamieci');
const { INVOICES_TABS, InvoicesTabs } = await import('@/components/invoices/invoices-tabs');
const { RecurringInvoicesView } = await import('@/app/(dashboard)/(faktury)/invoices/recurring/_components/recurring-invoices-view');
const { OverdueDashboard, OverdueDashboardError } = await import('@/components/reminders/overdue-dashboard');
const { default: InvoicesPage } = await import('@/app/(dashboard)/(faktury)/invoices/page');
const { default: RecurringInvoicesPage } = await import('@/app/(dashboard)/(faktury)/invoices/recurring/page');
const { InvoicesTable } = await import('@/app/(dashboard)/invoices/_components/invoices-table');
const { default: FakturyLayout } = await import('@/app/(dashboard)/(faktury)/layout');
const { SectionTabsNav, activeSectionTab } = await import('@/components/lists/section-tabs-nav');
const { SectionTabs } = await import('@/components/lists/section-tabs');

const ROOT = join(__dirname, '..', '..');

/** Linki zakładek w kolejności: [href, aktywna?]. */
function tabs(html: string): Array<[string, boolean]> {
  const nav = /<nav aria-label="Rodzaje faktur"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
  expect(nav, 'brak paska zakładek Faktur').not.toBeNull();
  return [...nav![1]!.matchAll(/<a([^>]*)>/g)].map(([, attrs]) => [
    /href="([^"]*)"/.exec(attrs!)![1]!,
    attrs!.includes('aria-current="page"'),
  ]);
}

function activeTab(html: string): string[] {
  return tabs(html).filter(([, active]) => active).map(([href]) => href);
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

const recurringItem = {
  id: '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d',
  tenant_id: 'firma-a',
  template_invoice_id: '7f1c2d3e-4b5a-4c6d-8e7f-901234567890',
  name: 'Abonament Acme',
  frequency: 'monthly' as const,
  day_of_month: 10,
  next_run_date: '2026-11-10',
  active: true,
  created_by: null,
  created_at: '2026-10-01T08:00:00Z',
  updated_at: '2026-10-01T08:00:00Z',
  status: 'active' as const,
  period: '2026-11',
  contractorName: 'Acme sp. z o.o.',
  templateNumber: 'FV/7/10/2026',
  templateGrossTotal: 1230,
};

const overdueInvoice = {
  id: 'o-1',
  internal_number: 'FV/9/2026',
  payment_due_date: '2026-09-24',
  gross_total: 1230,
  amount_due: 1230,
  days_overdue: 27,
  buyer_name: 'Acme sp. z o.o.',
  buyer_nip: '1234567890',
  buyer_email: null,
  reminders_paused: false,
  reminders_sent_count: 0,
  reminder_status: 'none' as const,
  latest_reminder: null,
};
const overdueStats = { totalCount: 1, totalAmount: 1230, avgDaysOverdue: 27, pausedCount: 0, sentThisMonth: 0 };

describe('InvoicesTabs — zakładki Faktur', () => {
  it('trzy zakładki w kolejności, każda ze swoim adresem (stare adresy zostają)', () => {
    expect(INVOICES_TABS.map((t) => [t.label, t.href])).toEqual([
      ['Wystawione', '/invoices'],
      ['Cykliczne', '/invoices/recurring'],
      ['Po terminie', '/payments/overdue'],
    ]);
    const html = renderToStaticMarkup(<InvoicesTabs active="cykliczne" />);
    expect(tabs(html)).toEqual([
      ['/invoices', false],
      ['/invoices/recurring', true],
      ['/payments/overdue', false],
    ]);
  });

  it('nawigacja, nie tablist bez paneli; aktywna podkreślona jak zakładka „line” Finory', () => {
    const html = renderToStaticMarkup(<InvoicesTabs active="wystawione" />);
    expect(html).not.toContain('role="tablist"');
    expect(html).toMatch(/<nav aria-label="Rodzaje faktur" class="[^"]*\bh-11\b[^"]*\bborder-b\b/);
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*class="[^"]*after:opacity-100/);
    expect(html.match(/after:opacity-100/g)).toHaveLength(1);
  });
});

/** Nazwa typu elementu: komponent albo znacznik. */
function nameOf(el: ReactElement): string {
  return typeof el.type === 'function' ? el.type.name : String(el.type);
}

describe('jedna strona sekcji Faktur (25.10.2026)', () => {
  it('layout: baner, kafle i karta z rzędem zakładek Faktur, strona zakładki w karcie', async () => {
    const tree = await FakturyLayout({ children: <p id="tabela">tabela</p> });
    expect((tree.props as { className: string }).className).toContain('ff-page-fill');
    const all = elements(tree);
    expect(all.map(nameOf)).toEqual(expect.arrayContaining(['RecurringDueBanner', 'InvoiceStatTiles']));
    const card = all.find((el) => (el.props as { className?: string }).className?.includes('flex-1 pt-0'))!;
    const inCard = elements((card.props as { children: ReactNode }).children);
    const tabsNav = inCard.find((el) => el.type === SectionTabsNav)!;
    expect((tabsNav.props as { tabs: unknown }).tabs).toBe(INVOICES_TABS);
    expect(inCard.some((el) => (el.props as { id?: string }).id === 'tabela')).toBe(true);
  });

  it('aktywna zakładka z adresu: najdłużej pasująca, spoza sekcji żadna', () => {
    expect(activeSectionTab('/invoices', INVOICES_TABS)).toBe('wystawione');
    expect(activeSectionTab('/invoices/recurring', INVOICES_TABS)).toBe('cykliczne');
    expect(activeSectionTab('/payments/overdue', INVOICES_TABS)).toBe('po-terminie');
    expect(activeSectionTab('/invoicesx', INVOICES_TABS)).toBeNull();
    for (const [pathname, href] of [
      ['/invoices', '/invoices'],
      ['/invoices/recurring', '/invoices/recurring'],
      ['/payments/overdue', '/payments/overdue'],
    ]) {
      nav.pathname = pathname!;
      const html = renderToStaticMarkup(<SectionTabsNav label="Rodzaje faktur" tabs={INVOICES_TABS} />);
      expect(activeTab(html), pathname).toEqual([href]);
    }
  });

  it('zakładki zmieniają tylko tabelę: bez przewijania (scroll=false) i ze znacznikiem dla pamięci przewinięcia', () => {
    const html = renderToStaticMarkup(<SectionTabs label="Rodzaje faktur" tabs={INVOICES_TABS} active="wystawione" />);
    const links = [...html.matchAll(/<a([^>]*)>/g)].map(([, attrs]) => attrs!);
    expect(links).toHaveLength(3);
    for (const attrs of links) expect(attrs).toContain('data-ff-keep-scroll=""');
  });

  it('Wystawione: strona to zawartość karty — bez zakładek i kafli, tytuł dla czytników', async () => {
    const tree = await InvoicesPage({ searchParams: Promise.resolve({}) });
    expect((tree.props as { className: string }).className).toContain('ff-tab-panel');
    const names = elements(tree).map(nameOf);
    expect(names).not.toContain('InvoiceStatTiles');
    expect(names).not.toContain('SectionTabs');
    expect(elements(tree).some((el) => el.type === InvoicesTabs)).toBe(false);
  });

  it('Cykliczne: lista i pusty stan bez własnej karty i zakładek', () => {
    for (const items of [[recurringItem], []]) {
      const html = renderToStaticMarkup(<RecurringInvoicesView items={items} today="2026-10-21" candidates={[]} />);
      expect(html, `pozycji: ${items.length}`).not.toContain('aria-label="Rodzaje faktur"');
      expect(html, `pozycji: ${items.length}`).not.toContain('data-slot="card"');
    }
  });

  it('Cykliczne: strona to zawartość karty, kafle stoją w layoucie', async () => {
    const tree = await RecurringInvoicesPage({ searchParams: Promise.resolve({}) });
    expect((tree.props as { className: string }).className).toContain('ff-tab-panel');
    expect(elements(tree).map(nameOf)).not.toContain('InvoiceStatTiles');
  });

  it('Po terminie: lista, pusty stan i błąd to zawartość karty, tytuł dla czytników, liczby w pasku nad tabelą', () => {
    const screens = [
      renderToStaticMarkup(<OverdueDashboard overdueInvoices={[overdueInvoice]} stats={overdueStats} />),
      renderToStaticMarkup(<OverdueDashboard overdueInvoices={[]} stats={{ ...overdueStats, totalCount: 0, totalAmount: 0 }} />),
      renderToStaticMarkup(<OverdueDashboardError message="test" />),
    ];
    for (const html of screens) {
      expect(html).toMatch(/^<div class="ff-tab-panel /);
      expect(html).not.toContain('aria-label="Rodzaje faktur"');
      expect(html).toContain('<h1 class="sr-only">Faktury po terminie</h1>');
    }
    // Kafle zakładki zastąpił pasek liczb nad tabelą (kafle sekcji są w layoucie).
    expect(screens[0]).toContain('aria-label="Podsumowanie faktur po terminie"');
    expect(screens[0]).not.toContain('role="note"');
    expect(screens[0]).toMatch(/Przypomnień wysłanych w miesiącu<\/dt><dd[^>]*>0<\/dd><dd[^>]*>Stan przypomnień jest orientacyjny<\/dd>/);
  });
});

describe('pusty arkusz zamiast pustych wierszy', () => {
  it('tabela faktur ma tylko wiersze faktur — brakujących do „Pokaż N” nie dorysowuje', () => {
    const invoice = {
      id: 'f-1', internal_number: 'FV/1/2026', ksef_status: 'accepted', ksef_number: null,
      buyer_data: { name: 'Acme', nip: '1234567890' }, gross_total: 123, issue_date: '2026-10-01',
      payment_due_date: '2026-10-15', payment_status: 'unpaid', paid_amount: 0, currency: 'PLN',
      invoice_kind: 'regular', created_at: '2026-10-01T10:00:00Z', last_error_code: null,
    };
    const html = renderToStaticMarkup(
      <InvoicesTable invoices={[invoice]} facts={{}} today="2026-10-21" selectedIds={new Set()} onToggleRow={() => {}} onToggleAll={() => {}} />,
    );
    const body = /<tbody[^>]*>([\s\S]*)<\/tbody>/.exec(html)![1]!;
    expect(body.match(/<tr\b/g)).toHaveLength(1);
    expect(body).not.toMatch(/<tr[^>]*aria-hidden/);
  });

  it('karta rośnie do stopki: obszar tabeli (`flex-1 border-b`) nad paginacją', () => {
    const html = renderToStaticMarkup(<RecurringInvoicesView items={[recurringItem]} today="2026-10-21" candidates={[]} />);
    expect(html).toContain('<div class="flex w-full flex-1 flex-col pt-2"><div class="flex-1 border-b">');
    // Samą kartę (`flex-1 pt-0`) daje layout sekcji.
    const layout = readFileSync(join(ROOT, 'app/(dashboard)/(faktury)/layout.tsx'), 'utf8');
    expect(layout).toContain('<Card className="flex-1 pt-0 shadow-none">');
  });

  it('łańcuch wysokości włącza się tylko na stronach z `ff-page-fill` (`:has`), reszta ekranów zostaje blokami', () => {
    const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
    expect(css).toContain('.ff-shell-content:has(.ff-page-fill),');
    expect(css).toContain('.ff-shell-content :is(.ff-route-template, .ff-invoices-route):has(.ff-page-fill)');
    expect(css).toContain('.ff-shell-content .ff-page-fill {\n  flex-grow: 1;');
  });
});

describe('stopka na samym dole', () => {
  it('przewijany obszar to kolumna flex, kontener treści rośnie i nie kurczy się pod treść', () => {
    const layout = readFileSync(join(ROOT, 'app/(dashboard)/layout.tsx'), 'utf8');
    expect(layout).toContain('className="ff-shell-scroll flex min-h-0 flex-1 flex-col overflow-y-auto"');
    const content = /<div className="(ff-shell-content [^"]*)"/.exec(layout)?.[1] ?? '';
    expect(content.split(' ')).toContain('grow');
    // `min-h-0` pozwoliłby skurczyć kontener poniżej treści — wjechałby na stopkę.
    expect(content.split(' ')).not.toContain('min-h-0');
    expect(layout.indexOf('<Footer />')).toBeGreaterThan(layout.indexOf('ff-shell-content'));
  });
});
