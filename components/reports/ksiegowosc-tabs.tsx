import { SectionTabs, type SectionTab } from '@/components/lists/section-tabs';

export type KsiegowoscTab = 'kpir' | 'eksport';

/** Zakładki Księgowości — każda to osobna strona z własnym adresem (stare adresy zostają). */
export const KSIEGOWOSC_TABS: readonly SectionTab<KsiegowoscTab>[] = [
  { value: 'kpir', label: 'KPiR', href: '/reports/kpir' },
  { value: 'eksport', label: 'Eksport', href: '/reports/exports' },
];

/**
 * Pierwszy rząd karty z tabelą na ekranach Księgowości (poprawka Bartosza
 * 21.10.2026: przeprojektowanie Księgowości — jedna pozycja „Księgowość”
 * w menu zamiast „KPiR” i „Eksport”). Ten sam rząd zakładek co na Fakturach
 * i Kosztach (`SectionTabs`).
 *
 * Bez hooków i bez `'use client'`, bo rysują go i strony serwerowe
 * (page, loading, error), i komponenty klienckie (KpirView).
 */
export function KsiegowoscTabs({ active }: { active: KsiegowoscTab }) {
  return <SectionTabs label="Księgowość" tabs={KSIEGOWOSC_TABS} active={active} />;
}
