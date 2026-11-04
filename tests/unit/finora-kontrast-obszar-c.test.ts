import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Kontrast tekstu statusów skopiowanych z Finory (WCAG 1.4.3, PLAN-FINORA
 * §10.2 / E1): w jasnym motywie `text-green-600` (3,2:1 na białym)
 * i `text-amber-600` (3,2:1) są za jasne dla małego tekstu. Zostają odcienie
 * -700 (ok. 4,9:1 i 5,0:1); warianty `dark:` i tła `bg-*-600/10` bez zmian.
 */

const FILES = [
  'components/reminders/overdue-dashboard.tsx',
  'components/validation/vat-status-badge.tsx',
  'components/expenses/kpir-view.tsx',
  'components/accountant/invoice-list.tsx',
  'components/exports/exports-center.tsx',
  'components/exports/co-pilot-settings-form.tsx',
  'app/(dashboard)/import-danych/page.tsx',
  // Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): nowe pliki
  // ekranów KPiR i Eksport (plakietki przychodu i ostrzeżeń, notka „poza sumą”).
  'components/reports/ksiegowosc-tabs.tsx',
  'components/reports/segmented-control.tsx',
  'components/reports/kpir/kpir-toolbar.tsx',
  'components/reports/kpir/kpir-result-card.tsx',
  'components/reports/kpir/kpir-cost-structure-card.tsx',
  'components/reports/kpir/kpir-blocked.tsx',
  'app/(dashboard)/reports/kpir/error.tsx',
  'components/exports/new-export-form.tsx',
  'components/exports/export-history.tsx',
  // Poprawka Bartosza 22.10.2026 (import danych w stylu Finory): Centrum
  // importu — plakietki „Gotowy” / „Wymaga certyfikatu”, statusy historii
  // i licznik ostrzeżeń.
  'components/import-danych/import-center.tsx',
  'components/import-danych/import-source-grid.tsx',
  'components/import-danych/import-history.tsx',
];

const LIGHT_TOO_PALE = /(?<![\w:-])text-(green|amber)-600\b/g;

describe('kontrast statusów Finory w jasnym motywie (obszar C)', () => {
  it.each(FILES)('%s: bez text-green-600 / text-amber-600 poza dark:', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source.match(LIGHT_TOO_PALE) ?? []).toEqual([]);
  });
});
