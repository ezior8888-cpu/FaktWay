import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  dashboardMobileTabs,
  dashboardNavItems,
  dashboardNavSections,
  getDashboardMoreSections,
  getDashboardPrefetchHrefs,
  isActiveNavPath,
} from '@/lib/dashboard-nav-config';

describe('isActiveNavPath (plan Finora §4)', () => {
  it('/invoices nie jest aktywne dla kreatora /invoices/new', () => {
    for (const p of ['/invoices/new', '/invoices/new/regular']) {
      expect(isActiveNavPath(p, '/invoices'), p).toBe(false);
    }
  });

  it('/invoices jest aktywne dla listy i podglądu faktury', () => {
    expect(isActiveNavPath('/invoices', '/invoices')).toBe(true);
    expect(isActiveNavPath('/invoices/abc-uuid', '/invoices')).toBe(true);
  });

  it('/invoices/new jest aktywne dla siebie i kroków kreatora', () => {
    expect(isActiveNavPath('/invoices/new', '/invoices/new')).toBe(true);
    expect(isActiveNavPath('/invoices/new/regular', '/invoices/new')).toBe(
      true,
    );
    expect(isActiveNavPath('/invoices', '/invoices/new')).toBe(false);
  });

  it('/bank jest aktywne tylko dla dokładnie /bank', () => {
    expect(isActiveNavPath('/bank', '/bank')).toBe(true);
    expect(isActiveNavPath('/bank/operacje', '/bank')).toBe(false);
  });

  it('/dashboard i /przeplywy tylko dokładnie', () => {
    expect(isActiveNavPath('/dashboard', '/dashboard')).toBe(true);
    expect(isActiveNavPath('/dashboard/x', '/dashboard')).toBe(false);
    expect(isActiveNavPath('/przeplywy', '/przeplywy')).toBe(true);
    expect(isActiveNavPath('/przeplywy/x', '/przeplywy')).toBe(false);
  });

  it('/reports/kpir, /settings, /expenses i domyślne reguły po prefiksie', () => {
    expect(isActiveNavPath('/reports/kpir', '/reports/kpir')).toBe(true);
    expect(isActiveNavPath('/reports/kpir/2026', '/reports/kpir')).toBe(true);
    expect(isActiveNavPath('/reports/kpirx', '/reports/kpir')).toBe(false);
    // Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): Eksport to
    // zakładka ekranu „Księgowość” (pozycja /reports/kpir) — świadomie true.
    expect(isActiveNavPath('/reports/exports', '/reports/kpir')).toBe(true);
    expect(isActiveNavPath('/settings/ksef', '/settings')).toBe(true);
    expect(isActiveNavPath('/settingsx', '/settings')).toBe(false);
    expect(isActiveNavPath('/expenses/abc', '/expenses')).toBe(true);
    expect(isActiveNavPath('/expensesx', '/expenses')).toBe(false);
    expect(isActiveNavPath('/inbox/abc', '/inbox')).toBe(true);
    expect(isActiveNavPath('/inboxx', '/inbox')).toBe(false);
    expect(isActiveNavPath('/contractors', '/contractors')).toBe(true);
  });
});

describe('zakładki ekranu Kosztów (poprawka 21.10.2026)', () => {
  // Wydatki i Skrzynka KSeF to zakładki ekranu „Koszty” (pozycja /expenses) —
  // w menu świeci „Koszty” na obu zakładkach i na szczegółach wydatku.
  it('„Koszty” są aktywne dla /expenses* i /inbox*, ale nie dla /inboxx ani analizy kosztów', () => {
    for (const p of ['/expenses', '/expenses/abc', '/inbox', '/inbox/abc']) {
      expect(isActiveNavPath(p, '/expenses'), p).toBe(true);
    }
    for (const p of ['/inboxx', '/expensesx', '/analizy/koszty']) {
      expect(isActiveNavPath(p, '/expenses'), p).toBe(false);
    }
  });

  it('w menu nie ma osobnej pozycji Skrzynki KSeF, a zakładka ma prefetch', () => {
    expect(dashboardNavItems.map((i) => i.href)).not.toContain('/inbox');
    expect(getDashboardPrefetchHrefs()).toEqual(expect.arrayContaining(['/expenses', '/inbox']));
  });
});

describe('zakładki ekranu Księgowości (poprawka 21.10.2026)', () => {
  // KPiR i Eksport to zakładki ekranu „Księgowość” (pozycja /reports/kpir) —
  // w menu świeci „Księgowość” na obu zakładkach i ich podstronach.
  it('„Księgowość” jest aktywna dla /reports/kpir* i /reports/exports*, ale nie dla /reports/exportsx ani /reports', () => {
    for (const p of ['/reports/kpir', '/reports/kpir/2026', '/reports/exports', '/reports/exports/x']) {
      expect(isActiveNavPath(p, '/reports/kpir'), p).toBe(true);
    }
    for (const p of ['/reports/exportsx', '/reports/kpirx', '/reports', '/import-danych']) {
      expect(isActiveNavPath(p, '/reports/kpir'), p).toBe(false);
    }
    // Import danych nie świeci na zakładkach Księgowości.
    expect(isActiveNavPath('/reports/exports', '/import-danych')).toBe(false);
  });

  it('w menu nie ma osobnej pozycji Eksportu, a zakładka ma prefetch', () => {
    const hrefs = dashboardNavItems.map((i) => i.href);
    expect(hrefs).not.toContain('/reports/exports');
    expect(hrefs.filter((h) => h === '/reports/kpir')).toHaveLength(1);
    expect(getDashboardPrefetchHrefs()).toEqual(expect.arrayContaining(['/reports/kpir', '/reports/exports']));
  });
});

describe('zakładki ekranu Faktur (poprawka 21.10.2026)', () => {
  // Cykliczne i po terminie to zakładki „Faktur”, nie pozycje menu — w menu
  // świeci wtedy „Faktury”, a „Wystaw fakturę” nie.
  it('„Faktury” są aktywne dla /invoices/recurring* i /payments/overdue*', () => {
    for (const p of ['/invoices/recurring', '/invoices/recurring/x', '/payments/overdue', '/payments/overdue/x']) {
      expect(isActiveNavPath(p, '/invoices'), p).toBe(true);
      expect(isActiveNavPath(p, '/invoices/new'), p).toBe(false);
    }
    expect(isActiveNavPath('/payments/overduex', '/invoices')).toBe(false);
    expect(isActiveNavPath('/payments', '/invoices')).toBe(false);
  });

  it('w menu nie ma osobnych pozycji dla zakładek', () => {
    const hrefs = dashboardNavItems.map((i) => i.href);
    expect(hrefs).not.toContain('/invoices/recurring');
    expect(hrefs).not.toContain('/payments/overdue');
  });

  it('zakładki mają prefetch (przełączenie jak pozycja menu), w przeciwieństwie do /analizy/*', () => {
    expect(getDashboardPrefetchHrefs()).toEqual(
      expect.arrayContaining(['/invoices/recurring', '/payments/overdue']),
    );
  });
});

describe('struktura menu (plan Finora §4)', () => {
  it('sekcje, etykiety i adresy w kolejności', () => {
    expect(
      dashboardNavSections.map((s) => ({
        title: s.title,
        items: s.items.map((i) => [i.label, i.href]),
      })),
    ).toEqual([
      // Poprawka Bartosza 22.10.2026: układ menu z planu Finora — trzy sekcje
      // (Pulpit · Sprzedaż · Koszty i księgowość), Ustawienia w stopce.
      {
        title: 'Pulpit',
        items: [
          ['Pulpit', '/dashboard'],
          ['Przepływy', '/przeplywy'],
          ['Analizy', '/analizy/sprzedaz'],
        ],
      },
      {
        title: 'Sprzedaż',
        items: [
          ['Faktury', '/invoices'],
          ['Wystaw fakturę', '/invoices/new'],
          ['Kontrahenci', '/contractors'],
        ],
      },
      {
        title: 'Koszty i księgowość',
        items: [
          ['Koszty', '/expenses'],
          ['Księgowość', '/reports/kpir'],
          ['Import danych', '/import-danych'],
        ],
      },
    ]);
  });

  it('każdy adres menu ma katalog trasy w app/(dashboard)', () => {
    const root = join(process.cwd(), 'app', '(dashboard)');
    const hrefs = [
      ...dashboardNavItems.map((i) => i.href),
      ...dashboardMobileTabs.flatMap((t) => (t.href ? [t.href] : [])),
    ];
    for (const href of hrefs) {
      const dir = join(root, ...href.split('/').filter(Boolean));
      expect(existsSync(dir), href).toBe(true);
    }
  });

  it('każda pozycja ma ikonę (komponent)', () => {
    for (const item of dashboardNavItems) {
      expect(item.icon, item.href).toBeTruthy();
    }
    for (const tab of dashboardMobileTabs) {
      expect(tab.icon, tab.label).toBeTruthy();
    }
  });

  it('dolny pasek: etykiety i kolejność bez zmian', () => {
    expect(dashboardMobileTabs.map((t) => [t.label, t.href])).toEqual([
      ['Pulpit', '/dashboard'],
      ['Faktury', '/invoices'],
      ['Nowa', '/invoices/new'],
      ['Miesiąc', '/przeplywy'],
      ['Więcej', null],
    ]);
    expect(dashboardMobileTabs.find((t) => t.label === 'Nowa')?.emphasis).toBe(
      true,
    );
  });

  it('getDashboardMoreSections odrzuca zakładki dolnego paska i puste sekcje', () => {
    const more = getDashboardMoreSections();
    const hrefs = more.flatMap((s) => s.items.map((i) => i.href));
    for (const tab of dashboardMobileTabs) {
      if (tab.href) expect(hrefs).not.toContain(tab.href);
    }
    expect(more.every((s) => s.items.length > 0)).toBe(true);
    // „Pulpit” traci z „Więcej” Pulpit i Przepływy (dolny pasek), zostają Analizy.
    expect(more.map((s) => s.title)).toEqual(['Pulpit', 'Sprzedaż', 'Koszty i księgowość']);
    expect(more[0].items.map((i) => i.href)).toEqual(['/analizy/sprzedaz']);
    expect(more[1].items.map((i) => i.href)).toEqual(['/contractors']);
  });

  it('getDashboardPrefetchHrefs pomija pozycje z prefetch: false', () => {
    const withoutPrefetch = dashboardNavItems.filter(
      (i) => i.prefetch === false,
    );
    const hrefs = getDashboardPrefetchHrefs();
    for (const item of withoutPrefetch) {
      expect(hrefs).not.toContain(item.href);
    }
    expect(hrefs).toContain('/invoices');
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('/analizy/* bez prefetchu (ciężkie agregaty, plan Finora §4)', () => {
    const analizy = dashboardNavItems.filter((i) => i.href.startsWith('/analizy/'));
    // Świadoma zmiana: Analizy 1:1 z Finory (21.10.2026) — w menu jedna pozycja
    // „Analizy” (/analizy/sprzedaz); /analizy/koszty jest za przełącznikiem.
    expect(analizy.map((i) => i.href)).toEqual(['/analizy/sprzedaz']);
    for (const item of analizy) expect(item.prefetch, item.href).toBe(false);
    const hrefs = getDashboardPrefetchHrefs();
    expect(hrefs.filter((h) => h.startsWith('/analizy'))).toEqual([]);
  });

  // Świadoma zmiana: Analizy 1:1 z Finory (21.10.2026) — jedna pozycja „Analizy”
  // świeci na obu analizach (przełącznik „Sprzedaż | Koszty” w nagłówku),
  // więc /analizy/koszty świadomie aktywuje /analizy/sprzedaz (wcześniej false).
  it('„Analizy” są aktywne dla /analizy/sprzedaz* i /analizy/koszty*, ale nie dla …x', () => {
    for (const p of ['/analizy/sprzedaz', '/analizy/sprzedaz/x', '/analizy/koszty', '/analizy/koszty/x']) {
      expect(isActiveNavPath(p, '/analizy/sprzedaz'), p).toBe(true);
    }
    for (const p of ['/analizy/sprzedazx', '/analizy/kosztyx', '/analizy', '/expenses']) {
      expect(isActiveNavPath(p, '/analizy/sprzedaz'), p).toBe(false);
    }
    // Analiza kosztów nie zapala pozycji „Koszty” (/expenses).
    expect(isActiveNavPath('/analizy/koszty', '/expenses')).toBe(false);
  });
});
