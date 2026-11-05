import { SectionTabs, type SectionTab } from '@/components/lists/section-tabs';

export type KsiegowoscTab = 'kpir' | 'eksport' | 'ustawienia';

/** Zakładki Księgowości — każda to osobna strona z własnym adresem (stare adresy zostają). */
export const KSIEGOWOSC_TABS: readonly SectionTab<KsiegowoscTab>[] = [
  { value: 'kpir', label: 'KPiR', href: '/reports/kpir' },
  { value: 'eksport', label: 'Eksport', href: '/reports/exports' },
];

/**
 * Zakładka modułu księgowości JDG (plan, K2). Widzi ją tylko firma, dla której
 * wyłącznik `lib/ksiegowosc/wylacznik.ts` puszcza obszar `ustawienia`; reszta
 * ma zakładki bez zmian.
 */
export const USTAWIENIA_PODATKOWE_TAB: SectionTab<KsiegowoscTab> = {
  value: 'ustawienia',
  label: 'Ustawienia podatkowe',
  href: '/reports/ustawienia-podatkowe',
};

export function zakladkiKsiegowosci(zUstawieniamiPodatkowymi: boolean): readonly SectionTab<KsiegowoscTab>[] {
  return zUstawieniamiPodatkowymi ? [...KSIEGOWOSC_TABS, USTAWIENIA_PODATKOWE_TAB] : KSIEGOWOSC_TABS;
}

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
