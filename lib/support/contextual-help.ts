/**
 * Contextual help (Faza 30 Krok 8) — mapuje bieżącą trasę panelu na
 * sugerowane artykuły KB. Widget pokazuje je w stanie powitalnym jako
 * „Pomoc do tej strony".
 *
 * Czysta funkcja (bez zależności server-side) — bezpieczna w client
 * component. Slugi muszą się zgadzać z plikami `content/help/*.mdx`.
 */

interface RouteHelp {
  /** Prefiks ścieżki (dopasowanie po `startsWith`). */
  prefix: string;
  slugs: string[];
}

/**
 * Kolejność ma znaczenie — bardziej szczegółowe prefiksy PRZED ogólnymi
 * (np. `/settings/billing` przed `/settings`). Dopasowujemy pierwszy trafiony.
 */
const ROUTE_HELP: RouteHelp[] = [
  {
    prefix: '/settings/billing',
    slugs: ['plany-i-cennik', 'okres-probny-trial', 'platnosci-i-faktury-za-faktway'],
  },
  {
    prefix: '/settings/security',
    slugs: ['haslo-i-bezpieczenstwo-konta', 'weryfikacja-dwuetapowa-2fa'],
  },
  {
    prefix: '/settings/team',
    slugs: ['zapraszanie-osob', 'role-i-uprawnienia'],
  },
  {
    prefix: '/settings/ksef',
    slugs: ['podlaczenie-ksef-krok-po-kroku', 'konfiguracja-certyfikatu-ksef', 'srodowisko-testowe-ksef'],
  },
  {
    prefix: '/settings/accountant',
    slugs: ['portal-ksiegowego', 'eksport-kpir-dla-ksiegowego'],
  },
  {
    prefix: '/settings/account',
    slugs: ['rodo-i-usuwanie-konta'],
  },
  {
    prefix: '/invoices/new',
    slugs: ['jak-wystawic-pierwsza-fakture', 'faktura-korygujaca', 'najczestsze-bledy-ksef'],
  },
  {
    prefix: '/invoices',
    slugs: ['jak-wystawic-pierwsza-fakture', 'statusy-faktury-i-upo', 'najczestsze-bledy-ksef'],
  },
  {
    prefix: '/inbox',
    slugs: ['statusy-faktury-i-upo', 'kategoryzacja-kosztow', 'czym-jest-ksef'],
  },
  {
    prefix: '/contractors',
    slugs: ['jak-wystawic-pierwsza-fakture'],
  },
  {
    prefix: '/payments/overdue',
    slugs: ['statusy-faktury-i-upo'],
  },
  {
    prefix: '/przeplywy',
    slugs: ['pierwsze-kroki-w-faktway', 'ksiega-przychodow-i-rozchodow'],
  },
  {
    prefix: '/analizy/koszty',
    slugs: ['kategoryzacja-kosztow', 'ksiega-przychodow-i-rozchodow'],
  },
  {
    prefix: '/analizy/sprzedaz',
    slugs: ['statusy-faktury-i-upo', 'pierwsze-kroki-w-faktway'],
  },
  {
    prefix: '/import-danych',
    slugs: ['magic-import-z-innych-programow'],
  },
  {
    prefix: '/expenses',
    slugs: ['skanowanie-paragonow-ocr', 'kategoryzacja-kosztow'],
  },
  {
    prefix: '/reports',
    slugs: ['ksiega-przychodow-i-rozchodow', 'eksport-kpir-dla-ksiegowego'],
  },
  {
    prefix: '/dashboard',
    slugs: ['pierwsze-kroki-w-faktway', 'czym-jest-ksef'],
  },
];

export function getContextualArticleSlugs(pathname: string): string[] {
  const match = ROUTE_HELP.find((r) => pathname.startsWith(r.prefix));
  return match ? match.slugs : [];
}
