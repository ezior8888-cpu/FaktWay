import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * Plan Finora E9 (P6), przegląd C11 i C12 — kontrast WCAG AA (4,5:1, tekst
 * 12 px) liczony z wartości oklch z `app/globals.css` i `tailwindcss/theme.css`,
 * także na tle, na którym tekst NAPRAWDĘ leży: wiersz tabeli w stanie hover /
 * z otwartym menu (`bg-muted/50`), zaznaczony (`bg-muted`) i przycisk strony
 * pod kursorem (`hover:bg-primary/20`). Klasy czytamy z renderowanego znacznika,
 * więc test pilnuje tego, co widzi klient, a nie stałej obok.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/actions/recurring-invoices', () => ({
  createRecurringInvoiceAction: vi.fn(),
  updateRecurringInvoiceAction: vi.fn(),
  pauseRecurringInvoiceAction: vi.fn(),
  resumeRecurringInvoiceAction: vi.fn(),
  deleteRecurringInvoiceAction: vi.fn(),
}));
vi.mock('@/app/actions/recurring-invoice-templates', () => ({ searchRecurringTemplatesAction: vi.fn() }));

import { RecurringInvoicesView } from '@/app/(dashboard)/(faktury)/invoices/recurring/_components/recurring-invoices-view';
import { RECURRING_STATUS_STYLES } from '@/app/(dashboard)/(faktury)/invoices/recurring/_components/recurring-status-badge';
import type { RecurringInvoiceListItem } from '@/lib/invoices/recurring/queries';

import { color, contrast, oklch, over, rowBackgrounds, themes } from './helpers/kontrast';

const RECORD = (n: number): RecurringInvoiceListItem => ({
  id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  tenant_id: 'firma-a',
  template_invoice_id: '7f1c2d3e-4b5a-4c6d-8e7f-901234567890',
  name: `Szablon ${n}`,
  frequency: 'monthly',
  day_of_month: 10,
  next_run_date: '2026-11-10',
  active: true,
  created_by: null,
  created_at: '2026-10-01T08:00:00Z',
  updated_at: '2026-10-01T08:00:00Z',
  status: 'active',
  period: '2026-11',
  contractorName: `Kontrahent ${n}`,
  templateNumber: `FV/${n}/10/2026`,
  templateGrossTotal: 100,
});

describe('C11 — plakietki statusu: kontrast także na tle wiersza (hover, menu „⋯”, zaznaczenie)', () => {
  const parse = (style: string, prefix: '' | 'dark:') => {
    const re = new RegExp(`(?:^|\\s)${prefix.replace(':', '\\:')}(text|bg)-([a-z]+-\\d+)(?:/(\\d+))?(?=\\s|$)`, 'g');
    const found: Record<string, { token: string; alpha: number }> = {};
    for (const m of style.matchAll(re)) found[m[1]] = { token: m[2], alpha: m[3] ? Number(m[3]) / 100 : 1 };
    return found;
  };

  for (const status of ['active', 'paused'] as const) {
    it.each(Object.keys(themes))(`${status}: motyw %s ≥ 4,5:1 na karcie, wierszu hover i zaznaczonym`, (name) => {
      const theme = themes[name as keyof typeof themes];
      const dark = name === 'ciemny';
      // Ciemny motyw: `dark:*` nadpisuje jasne klasy; brakujące wartości biorą się z jasnych.
      const light = parse(RECURRING_STATUS_STYLES[status], '');
      const over_ = dark ? parse(RECURRING_STATUS_STYLES[status], 'dark:') : {};
      const text = over_.text ?? light.text;
      const bg = over_.bg ?? light.bg;
      for (const [rowName, row] of Object.entries(rowBackgrounds(theme))) {
        const badge = over(color(bg.token, theme), bg.alpha, row);
        const ratio = contrast(color(text.token, theme), badge);
        expect(ratio, `${status}, ${name}, ${rowName}: ${text.token} na ${bg.token}/${bg.alpha * 100} = ${ratio.toFixed(2)}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe('C12 — nieaktywny numer strony w paginacji: kontrast w obu motywach', () => {
  const html = renderToStaticMarkup(
    <RecurringInvoicesView
      items={Array.from({ length: 25 }, (_, i) => RECORD(i + 1))}
      today="2026-10-20"
      candidates={[]}
    />,
  );
  // Przycisk „Strona 2” jest nieaktywny (aktywna jest strona 1).
  const classes = /aria-label="Strona 2" class="([^"]*)"/.exec(html)?.[1] ?? '';
  const textToken = /(?:^|\s)text-(primary|accent-foreground|chart-\d)(?=\s|$)/.exec(classes)?.[1] ?? '';

  it('znaleziono klasę koloru tekstu nieaktywnego numeru strony', () => {
    expect(classes).toContain('bg-primary/10');
    expect(textToken).not.toBe('');
  });

  it.each(Object.keys(themes))('motyw %s: tekst na `primary/10` i pod kursorem (`primary/20`) ≥ 4,5:1', (name) => {
    const theme = themes[name as keyof typeof themes];
    const card = oklch(theme['--card']);
    const text = color(textToken, theme);
    for (const [state, alpha] of [['spoczynek', 0.1], ['hover', 0.2]] as const) {
      const ratio = contrast(text, over(oklch(theme['--primary']), alpha, card));
      expect(ratio, `${name}, ${state}, text-${textToken}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
