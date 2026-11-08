import {
  RiAddLine,
  RiAlarmWarningLine,
  RiBook2Line,
  RiDownload2Line,
  RiFileAddLine,
  RiInboxArchiveLine,
  RiLineChartLine,
  RiPieChart2Line,
  RiReceiptLine,
  RiRepeatLine,
  type RemixiconComponentType,
} from '@remixicon/react';

import { dashboardNavSections, dashboardSettingsNavItem } from '@/lib/dashboard-nav-config';

export interface PaletteEntry {
  /** Tytuł grupy w palecie („Przejdź do" albo „Akcje"). */
  group: string;
  label: string;
  /**
   * Unikalna wartość cmdk (`grupa:etykieta`). „Wystaw fakturę” jest i w menu,
   * i w akcjach — zdublowana wartość psuje nawigację strzałkami.
   */
  value: string;
  href: string;
  icon: RemixiconComponentType;
  /** Dodatkowe słowa dla dopasowania cmdk (np. nazwa sekcji menu). */
  keywords: string[];
}

export const PALETTE_NAV_GROUP = 'Przejdź do';
export const PALETTE_ACTIONS_GROUP = 'Akcje';

/**
 * Zakładki ekranów Faktur, Kosztów i Księgowości oraz dwie analizy, które do
 * 21.10.2026 były pozycjami menu — paleta dalej prowadzi do nich wprost (stare
 * nazwy jako słowa kluczowe). „KPiR” ma inną etykietę niż pozycja menu
 * „Księgowość”, a „Analiza sprzedaży” niż „Analizy” (ten sam adres), więc
 * wartości cmdk (`grupa:etykieta`) się nie powtarzają.
 */
const PALETTE_EXTRA_NAV: readonly { label: string; href: string; icon: RemixiconComponentType; keywords: string[] }[] = [
  {
    label: 'Faktury cykliczne',
    href: '/invoices/recurring',
    icon: RiRepeatLine,
    keywords: ['Faktury cykliczne', 'Faktury', 'Sprzedaż', 'abonament', 'co miesiąc', 'powtarzalne'],
  },
  {
    label: 'Faktury po terminie',
    href: '/payments/overdue',
    icon: RiAlarmWarningLine,
    keywords: ['Faktury po terminie', 'Faktury', 'Sprzedaż', 'Przypomnienia', 'zaległe', 'windykacja', 'monit'],
  },
  {
    label: 'Wydatki',
    href: '/expenses',
    icon: RiReceiptLine,
    keywords: ['Wydatki', 'Koszty', 'paragon', 'faktury kosztowe', 'do opisania'],
  },
  {
    label: 'Skrzynka KSeF',
    href: '/inbox',
    icon: RiInboxArchiveLine,
    keywords: ['Skrzynka KSeF', 'Koszty', 'KSeF', 'faktury zakupowe', 'faktury kosztowe', 'przychodzące'],
  },
  // Poprawka Bartosza 21.10.2026 (Analizy 1:1 z Finory): w menu jedna pozycja
  // „Analizy” (/analizy/sprzedaz), a koszty przełącza się w nagłówku — ⌘K
  // prowadzi do każdej analizy wprost. Etykiety różnią się od pozycji menu
  // „Analizy”, więc wartości cmdk (`grupa:etykieta`) się nie powtarzają.
  {
    label: 'Analiza sprzedaży',
    href: '/analizy/sprzedaz',
    icon: RiLineChartLine,
    keywords: ['Analiza sprzedaży', 'Analizy', 'Sprzedaż', 'przychody', 'produkty', 'należności', 'stali klienci', 'wykresy'],
  },
  {
    label: 'Analiza kosztów',
    href: '/analizy/koszty',
    icon: RiPieChart2Line,
    keywords: ['Analiza kosztów', 'Analizy', 'Koszty', 'wydatki', 'kategorie', 'VAT', 'stałe koszty', 'wykresy'],
  },
  {
    label: 'KPiR',
    href: '/reports/kpir',
    icon: RiBook2Line,
    keywords: ['KPiR', 'Księgowość', 'książka przychodów i rozchodów', 'księga', 'dochód', 'PIT'],
  },
  {
    label: 'Eksport',
    href: '/reports/exports',
    icon: RiDownload2Line,
    keywords: ['Eksport', 'Księgowość', 'JPK', 'JPK_FA', 'CSV', 'Excel', 'plik dla księgowej'],
  },
];

export const MIN_SEARCH_LENGTH = 2;
export const MAX_SEARCH_LENGTH = 80;

/** Pozycje menu + zakładki Faktur, Kosztów i Księgowości + obie analizy + ustawienia + dwie akcje. Czysta funkcja — bez dostępu do DOM. */
export function buildPaletteNavEntries(): PaletteEntry[] {
  const nav: PaletteEntry[] = dashboardNavSections.flatMap((section) =>
    section.items.map((item) => ({
      group: PALETTE_NAV_GROUP,
      label: item.label,
      value: `${PALETTE_NAV_GROUP}:${item.label}`,
      href: item.href,
      icon: item.icon,
      keywords: [item.label, section.title],
    })),
  );
  for (const item of PALETTE_EXTRA_NAV) {
    nav.push({ group: PALETTE_NAV_GROUP, value: `${PALETTE_NAV_GROUP}:${item.label}`, ...item });
  }
  nav.push({
    group: PALETTE_NAV_GROUP,
    label: dashboardSettingsNavItem.label,
    value: `${PALETTE_NAV_GROUP}:${dashboardSettingsNavItem.label}`,
    href: dashboardSettingsNavItem.href,
    icon: dashboardSettingsNavItem.icon,
    keywords: [dashboardSettingsNavItem.label, 'konfiguracja'],
  });
  const actions: PaletteEntry[] = [
    {
      group: PALETTE_ACTIONS_GROUP,
      label: 'Wystaw fakturę',
      value: `${PALETTE_ACTIONS_GROUP}:Wystaw fakturę`,
      href: '/invoices/new',
      icon: RiFileAddLine,
      keywords: ['Wystaw fakturę', 'nowa', 'faktura', 'sprzedaż'],
    },
    {
      group: PALETTE_ACTIONS_GROUP,
      label: 'Dodaj wydatek',
      value: `${PALETTE_ACTIONS_GROUP}:Dodaj wydatek`,
      href: '/expenses',
      icon: RiAddLine,
      keywords: ['Dodaj wydatek', 'koszt', 'paragon', 'zdjęcie'],
    },
  ];
  return [...nav, ...actions];
}

/** Fraza do wyszukiwania na serwerze: przycięta, do 80 znaków, `null` gdy krótsza niż 2. */
export function normalizeSearchQuery(q: string): string | null {
  const t = q.trim().slice(0, MAX_SEARCH_LENGTH).trim();
  return t.length < MIN_SEARCH_LENGTH ? null : t;
}
