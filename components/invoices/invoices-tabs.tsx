import { SectionTabs, type SectionTab } from '@/components/lists/section-tabs';

export type InvoicesTab = 'wystawione' | 'cykliczne' | 'po-terminie';

/** Zakładki Faktur — każda to osobna strona z własnym adresem (stare adresy zostają). */
export const INVOICES_TABS: readonly SectionTab<InvoicesTab>[] = [
  { value: 'wystawione', label: 'Wystawione', href: '/invoices' },
  { value: 'cykliczne', label: 'Cykliczne', href: '/invoices/recurring' },
  { value: 'po-terminie', label: 'Po terminie', href: '/payments/overdue' },
];

/**
 * Pierwszy rząd karty z tabelą na ekranach Faktur (poprawka Bartosza 21.10.2026:
 * jedna pozycja „Faktury” w menu zamiast trzech). Wygląd i semantykę (`<nav>`
 * z linkami, zakładki „line” Finory) daje wspólny `SectionTabs` — ten sam rząd
 * mają zakładki Kosztów (`components/expenses/costs-tabs.tsx`).
 */
export function InvoicesTabs({ active }: { active: InvoicesTab }) {
  return <SectionTabs label="Rodzaje faktur" tabs={INVOICES_TABS} active={active} />;
}
