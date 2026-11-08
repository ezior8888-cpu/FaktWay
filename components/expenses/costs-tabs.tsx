import { SectionTabs, type SectionTab } from '@/components/lists/section-tabs';

export type CostsTab = 'wydatki' | 'skrzynka';

/** Zakładki Kosztów — każda to osobna strona z własnym adresem (stare adresy zostają). */
export const COSTS_TABS: readonly SectionTab<CostsTab>[] = [
  { value: 'wydatki', label: 'Wydatki', href: '/expenses' },
  { value: 'skrzynka', label: 'Skrzynka KSeF', href: '/inbox' },
];

/**
 * Pierwszy rząd karty z tabelą na ekranach Kosztów (poprawka Bartosza
 * 21.10.2026: jedna pozycja „Koszty” w menu zamiast „Wydatki” i „Skrzynka
 * KSeF”). Ten sam rząd zakładek co na Fakturach (`SectionTabs`).
 */
export function CostsTabs({ active }: { active: CostsTab }) {
  return <SectionTabs label="Rodzaje kosztów" tabs={COSTS_TABS} active={active} />;
}
