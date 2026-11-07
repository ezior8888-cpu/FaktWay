import { SectionTabs, type SectionTab } from '@/components/lists/section-tabs';

export type KsiegowoscTab = 'kpir' | 'eksport' | 'ewidencja' | 'ustawienia';

/** Zakładki Księgowości — każda to osobna strona z własnym adresem (stare adresy zostają). */
export const KSIEGOWOSC_TABS: readonly SectionTab<KsiegowoscTab>[] = [
  { value: 'kpir', label: 'KPiR', href: '/reports/kpir' },
  { value: 'eksport', label: 'Eksport', href: '/reports/exports' },
];

/**
 * Zakładki modułu księgowości JDG (plan, K2 i K3). Widzi je tylko firma, dla
 * której wyłącznik `lib/ksiegowosc/wylacznik.ts` puszcza dany obszar; reszta
 * ma zakładki bez zmian.
 */
export const EWIDENCJA_TAB: SectionTab<KsiegowoscTab> = {
  value: 'ewidencja',
  label: 'Ewidencja',
  href: '/reports/ewidencja',
};

export const USTAWIENIA_PODATKOWE_TAB: SectionTab<KsiegowoscTab> = {
  value: 'ustawienia',
  label: 'Ustawienia podatkowe',
  href: '/reports/ustawienia-podatkowe',
};

export interface ObszaryKsiegowosci {
  ewidencja: boolean;
  ustawienia: boolean;
}

export function zakladkiKsiegowosci(obszary: ObszaryKsiegowosci): readonly SectionTab<KsiegowoscTab>[] {
  if (!obszary.ewidencja && !obszary.ustawienia) return KSIEGOWOSC_TABS;
  return [
    ...KSIEGOWOSC_TABS,
    ...(obszary.ewidencja ? [EWIDENCJA_TAB] : []),
    ...(obszary.ustawienia ? [USTAWIENIA_PODATKOWE_TAB] : []),
  ];
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
