import {
  RiAddLine,
  RiBankLine,
  RiBarChart2Line,
  RiBook2Line,
  RiContactsBook3Line,
  RiDashboardLine,
  RiDraftLine,
  RiExchangeFundsLine,
  RiFileList3Line,
  RiFileTextLine,
  RiMoreLine,
  RiPriceTag3Line,
  RiReceiptLine,
  RiSafe2Line,
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
  /**
   * `false` = bez prefetchu, także po najechaniu (ciężkie strony, plan Finora §4).
   * Domyślnie trasę pobiera najechanie albo fokus na pozycji menu; po wejściu na
   * panel z góry idą tylko cele dolnego paska (`getDashboardPrefetchHrefs`).
   */
  prefetch?: false;
}

export interface DashboardNavSection {
  /** Wielkość liter jak w planie Finora §4; UI zapisuje wersalikami. */
  title: string;
  items: DashboardNavItem[];
}

/**
 * Sekcje menu wg planu Finora §4 — tylko trasy, które istnieją. Trasy
 * z kolejnych etapów dochodzą razem ze stronami (bank: krok 3.2); analizy doszły
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
      // Plan kompletnej aplikacji 3.2 (ekran P12 Finory): wyciąg z banku i wpłaty do
      // potwierdzenia. Na końcu sekcji, żeby nic w menu się nie przesunęło (decyzja D1);
      // bez prefetchu, bo strona czyta operacje i niezapłacone faktury (plan Finora §4).
      { href: "/bank", label: "Bank", icon: RiBankLine, prefetch: false },
    ],
  },
  {
    title: "Sprzedaż",
    items: [
      // Kreator nie ma tu pozycji: od 11.11.2026 prowadzi do niego przycisk
      // „Nowa faktura” pod logo (`dashboardNewInvoiceAction`).
      { href: "/invoices", label: "Faktury", icon: RiFileList3Line },
      { href: "/contractors", label: "Kontrahenci", icon: RiContactsBook3Line },
      // Plan kompletnej aplikacji, krok 2.9: noty obciążeniowe i uznaniowe. Osobna
      // pozycja na końcu sekcji, a nie zakładka „Rodzaje faktur”, bo nota nie jest
      // fakturą; pozostałe pozycje bez zmian (decyzja D1).
      { href: "/noty", label: "Noty", icon: RiFileTextLine },
      // Plan kompletnej aplikacji, krok 2.4: proforma i oferta (wycena). Osobna pozycja
      // na końcu sekcji, nie rodzaj faktury: dokumenty poza KSeF i poza przychodem;
      // pozostałe pozycje bez zmian (decyzja D1).
      { href: "/proformy", label: "Proformy i oferty", icon: RiDraftLine },
      { href: "/produkty", label: "Produkty i usługi", icon: RiPriceTag3Line }, // krok 2.6, katalog (D1)
    ],
  },
  {
    title: "Koszty i księgowość",
    items: [
      { href: "/expenses", label: "Koszty", icon: RiReceiptLine },
      { href: "/reports/kpir", label: "Księgowość", icon: RiBook2Line },
      { href: "/import-danych", label: "Import danych", icon: RiUpload2Line },
      // Plan kompletnej aplikacji, krok 3.7: Kasa (dowody KP i KW, raport kasowy).
      // Nowa pozycja na końcu sekcji; pozostałe pozycje bez zmian (decyzja D1).
      { href: "/kasa", label: "Kasa", icon: RiSafe2Line },
    ],
  },
];

/**
 * Przycisk „Nowa faktura” pod logo paska bocznego (poprawka Bartosza
 * 11.11.2026, zastąpił pozycję „Wystaw fakturę”). To akcja, nie miejsce:
 * nie świeci jak pozycja menu; na kreatorze ma tylko `aria-current`.
 */
export const dashboardNewInvoiceAction: DashboardNavItem = {
  href: "/invoices/new",
  label: "Nowa faktura",
  icon: RiAddLine,
};

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
  // (/invoices/new*) nie: tam prowadzi przycisk „Nowa faktura” w pasku
  // bocznym i plus dolnego paska, a ten świeciłby razem z „Faktury”.
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

/**
 * Trasy, które `PrefetchDashboardRoutes` pobiera z góry po wejściu na panel:
 * cele dolnego paska (Pulpit, Faktury, Nowa, Miesiąc), te same na każdej
 * szerokości. Resztę menu pobiera najechanie albo fokus na pozycji, a zakładki
 * sekcji (cykliczne, po terminie, skrzynka KSeF, eksport) pobiera ich własny
 * rząd zakładek na ekranie sekcji (`SectionTabs`).
 *
 * DLACZEGO TYLKO CELE PASKA (plan skalowania 3000, sesja 10). Każde pobranie
 * z wyprzedzeniem to żądanie RSC przez bramkę logowania (`proxy.ts` pyta
 * GoTrue) i render layoutu panelu na serwerze. Dawniej z góry szło prawie całe
 * menu z zakładkami, czyli kilkanaście takich żądań na każde wejście.
 */
export function getDashboardPrefetchHrefs(): string[] {
  const noPrefetch = new Set(
    dashboardNavItems
      .filter((item) => item.prefetch === false)
      .map((item) => item.href),
  );
  return [...MOBILE_TAB_HREFS].filter((href) => !noPrefetch.has(href));
}
