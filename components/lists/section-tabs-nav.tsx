'use client';

import { usePathname } from 'next/navigation';

import { SectionTabs, type SectionTab } from '@/components/lists/section-tabs';

/**
 * Zakładka, której adres najdłużej pasuje do bieżącej ścieżki: `/invoices`
 * dla listy, `/invoices/recurring` dla cyklicznych (dłuższy wygrywa z
 * `/invoices`). Ścieżka spoza zakładek — `null`.
 */
export function activeSectionTab<T extends string>(
  pathname: string,
  tabs: readonly SectionTab<T>[],
): T | null {
  let best: SectionTab<T> | null = null;
  for (const tab of tabs) {
    const matches = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
    if (matches && (best === null || tab.href.length > best.href.length)) best = tab;
  }
  return best?.value ?? null;
}

/**
 * Rząd zakładek w layoucie sekcji. Layout nie renderuje się ponownie przy
 * zmianie zakładki (to właśnie trzyma kafle i kartę w miejscu), więc
 * aktywną zakładkę bierzemy z adresu po stronie klienta, a nie z propsów.
 */
export function SectionTabsNav<T extends string>({
  label,
  tabs,
  className,
}: {
  label: string;
  tabs: readonly SectionTab<T>[];
  className?: string;
}) {
  const pathname = usePathname();
  return <SectionTabs label={label} tabs={tabs} active={activeSectionTab(pathname, tabs)} className={className} />;
}
