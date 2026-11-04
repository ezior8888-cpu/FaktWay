import {
  RiAddLine,
  RiBarChart2Line,
  RiBook2Line,
  RiContactsBook3Line,
  RiDashboardLine,
  RiExchangeFundsLine,
  RiFileAddLine,
  RiFileList3Line,
  RiMoreLine,
  RiReceiptLine,
  RiSettings3Line,
  RiUpload2Line,
  RiWallet3Line,
  type RemixiconComponentType,
} from "@remixicon/react";

export interface DashboardNavItem {
  href: string;
  label: string;
  /** Ikona Remix (komponent) — sidebar, ⌘K, arkusz „Więcej". */
  icon: RemixiconComponentType;
  /** `false` = nie prefetchuj trasy (ciężkie strony). Domyślnie prefetch. */
  prefetch?: false;
}

export interface DashboardNavSection {
  /** Wielkość liter jak w planie Finora §4; UI zapisuje wersalikami. */
  title: string;
  items: DashboardNavItem[];
}

/**
 * Sekcje menu wg planu Finora §4 — tylko trasy, które istnieją. Trasy
 * z kolejnych etapów (bank) dochodzą razem ze stronami; analizy doszły
 * w E7 (od 21.10.2026 jedna pozycja „Analizy” z przełącznikiem „Sprzedaż |
 * Koszty”). Faktury cykliczne (E9) i przypomnienia są od 21.10.2026 zakładkami
 * ekranu „Faktury” (`INVOICES_TABS`), Wydatki i Skrzynka KSeF — zakładkami
 * ekranu „Koszty” (`COSTS_TABS`), a KPiR i Eksport — zakładkami ekranu
 * „Księgowość” (`KSIEGOWOSC_TABS`), nie osobnymi pozycjami. ⌘K znajduje je
 * przez `PALETTE_EXTRA_NAV` w `lib/command-palette.ts` (tam też obie analizy).
 */
export const dashboardNavSections: DashboardNavSection[] = [
  // Układ menu z planu Finora (poprawka Bartosza 22.10.2026): trzy sekcje,
  // Ustawienia w stopce paska. Pozycje z zakładkami lub przełącznikiem:
  // Analizy (Sprzedaż / Koszty), Faktury (Wystawione / Cykliczne / Po
  // terminie), Koszty (Wydatki / Skrzynka KSeF), Księgowość (KPiR / Eksport).
  {
    title: "Pulpit",
    items: [
      // Dashboard JEST ekranem agenta od 30.08.2026 — osobnej pozycji „Flo”
      // nie ma (prowadziłaby tu przez przekierowanie).
      { href: "/dashboard", label: "Pulpit", icon: RiDashboardLine },
      { href: "/przeplywy", label: "Przepływy", icon: RiExchangeFundsLine },
      // Plan Finora E7 (P10, P11): ciężkie agregaty — bez prefetchu (§4).
      {
        href: "/analizy/sprzedaz",
        label: "Analizy",
        icon: RiBarChart2Line,
        prefetch: false,
      },
    ],
  },
  {
    title: "Sprzedaż",
    items: [
      { href: "/invoices", label: "Faktury", icon: RiFileList3Line },
      { href: "/invoices/new", label: "Wystaw fakturę", icon: RiFileAddLine },
      { href: "/contractors", label: "Kontrahenci", icon: RiContactsBook3Line },
    ],
  },
  {
    title: "Koszty i księgowość",
    items: [
      { href: "/expenses", label: "Koszty", icon: RiReceiptLine },
      { href: "/reports/kpir", label: "Księgowość", icon: RiBook2Line },
      { href: "/import-danych", label: "Import danych", icon: RiUpload2Line },
    ],
  },
];

/** Ustawienia — stopka sidebara, arkusz „Więcej" i ⌘K (poza sekcjami). */
export const dashboardSettingsNavItem: DashboardNavItem = {
  href: "/settings",
  label: "Ustawienia",
  icon: RiSettings3Line,
};

/** Płaska lista — prefetch i inne narzędzia. */
export const dashboardNavItems: DashboardNavItem[] =
  dashboardNavSections.flatMap((section) => section.items);

/**
 * Dolna nawigacja telefonu — pięć slotów z sierpniowej makiety:
 * Pulpit · Faktury · Nowa · Miesiąc · Więcej.
 *
 * DLACZEGO OSOBNA LISTA, A NIE WYCINEK Z `dashboardNavSections`.
 * Sidebar jest spisem miejsc; dolny pasek to CZTERY najczęstsze czynności plus
 * furtka do reszty. „Nowa" nie jest pozycją menu (to przycisk akcji, dlatego
 * w sidebarze stoi nad listą), a „Więcej" nie jest trasą. Wycinanie tego
 * z sekcji wymagałoby wyjątków w obie strony.
 *
 * Etykiety są krótsze niż w sidebarze — „Faktury" zamiast „Faktury wystawione",
 * „Miesiąc" zamiast „Przepływy" — bo na 375 px slot ma około 70 px i dłuższy
 * napis albo się łamie, albo zostaje przycięty. To nie jest zmiana nazwy
 * strony, tylko podpis ikony.
 */
export interface DashboardMobileTab {
  /** `null` = slot bez trasy (otwiera arkusz „Więcej"). */
  href: string | null;
  label: string;
  icon: RemixiconComponentType;
  /** Wyróżniony środkowy przycisk akcji (niebieskie koło). */
  emphasis?: boolean;
}

export const dashboardMobileTabs: DashboardMobileTab[] = [
  // 19.10.2026: Pulpit bez FLO (miejsce FLO przyjdzie z projektu Claude Design).
  { href: "/dashboard", label: "Pulpit", icon: RiDashboardLine },
  { href: "/invoices", label: "Faktury", icon: RiFileList3Line },
  // „Nowa” prowadzi do wyboru dokumentu: rodzaje faktur i, od 25.10.2026,
  // „Wydatek” ze zdjęcia (na telefonie ludzie głównie wrzucają koszty).
  { href: "/invoices/new", label: "Nowa", icon: RiAddLine, emphasis: true },
  { href: "/przeplywy", label: "Miesiąc", icon: RiWallet3Line },
  { href: null, label: "Więcej", icon: RiMoreLine },
];

/** Trasy, które mają własny slot na dole — w arkuszu „Więcej" byłyby dublem. */
const MOBILE_TAB_HREFS = new Set(
  dashboardMobileTabs
    .map((tab) => tab.href)
    .filter((href): href is string => href !== null),
);

/**
 * Sekcje do arkusza „Więcej”: to samo menu, bez pozycji, które stoją już
 * na dolnym pasku. Puste sekcje odpadają, żeby nie został sam nagłówek.
 */
export function getDashboardMoreSections(): DashboardNavSection[] {
  return dashboardNavSections
    .map((section) => ({
      title: section.title,
      items: section.items.filter((item) => !MOBILE_TAB_HREFS.has(item.href)),
    }))
    .filter((section) => section.items.length > 0);
}

/**
 * Czy `pathname` uznajemy za aktywną pozycję menu dla danego `href`
 * (sidebar, stan „pending” po kliknięciu).
 */
export function isActiveNavPath(pathname: string, href: string): boolean {
  // Dokładne dopasowanie: ekrany, pod którymi nie ma podstron menu.
  if (href === "/dashboard" || href === "/przeplywy" || href === "/bank") {
    return pathname === href;
  }
  // „Faktury" to lista, podgląd faktury i zakładki ekranu Faktur: cykliczne
  // (/invoices/recurring*) i po terminie (/payments/overdue*). Kreator
  // (/invoices/new*) ma własną pozycję „Wystaw fakturę”.
  if (href === "/invoices") {
    if (pathname === "/invoices/new" || pathname.startsWith("/invoices/new/")) {
      return false;
    }
    return (
      pathname === "/invoices" ||
      pathname.startsWith("/invoices/") ||
      pathname === "/payments/overdue" ||
      pathname.startsWith("/payments/overdue/")
    );
  }
  // „Koszty" to zakładki Wydatki (/expenses*, także szczegóły wydatku)
  // i Skrzynka KSeF (/inbox*).
  if (href === "/expenses") {
    return (
      pathname === "/expenses" ||
      pathname.startsWith("/expenses/") ||
      pathname === "/inbox" ||
      pathname.startsWith("/inbox/")
    );
  }
  // „Analizy” to dwie strony przełączane w nagłówku: sprzedaż (/analizy/sprzedaz*)
  // i koszty (/analizy/koszty*). /analizy/sprzedazx i /analizy/kosztyx — nie.
  if (href === "/analizy/sprzedaz") {
    return (
      pathname === "/analizy/sprzedaz" ||
      pathname.startsWith("/analizy/sprzedaz/") ||
      pathname === "/analizy/koszty" ||
      pathname.startsWith("/analizy/koszty/")
    );
  }
  // „Księgowość" to zakładki KPiR (/reports/kpir*) i Eksport (/reports/exports*).
  // Sam /reports (przekierowanie na Pulpit) i /reports/exportsx — nie.
  if (href === "/reports/kpir") {
    return (
      pathname === "/reports/kpir" ||
      pathname.startsWith("/reports/kpir/") ||
      pathname === "/reports/exports" ||
      pathname.startsWith("/reports/exports/")
    );
  }
  // /invoices/new, /settings i reszta: sam adres albo podstrona.
  return pathname === href || pathname.startsWith(`${href}/`);
}

const EXTRA_PREFETCH_HREFS = [
  "/settings",
  "/invoices/new",
  // Zakładki ekranów Faktur, Kosztów i Księgowości — przełączenie ma być tak
  // szybkie jak pozycja menu.
  "/invoices/recurring",
  "/payments/overdue",
  "/inbox",
  "/reports/exports",
] as const;

/** Trasy do `router.prefetch` — pozycje menu + CTA + ustawienia + zakładki Faktur, Kosztów i Księgowości. */
export function getDashboardPrefetchHrefs(): string[] {
  const set = new Set<string>(
    dashboardNavItems
      .filter((item) => item.prefetch !== false)
      .map((item) => item.href),
  );
  for (const href of EXTRA_PREFETCH_HREFS) {
    set.add(href);
  }
  return [...set];
}
