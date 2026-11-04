/**
 * Znaczniki danych przykładowych (PLAN-PRAWDZIWE-DANE §5.2) — ciągi, które
 * występują WYŁĄCZNIE w danych przykładowych, nigdy w prawdziwych tekstach
 * aplikacji. Test T2 (`tests/unit/dane-przeciek.test.tsx`) szuka ich w HTML
 * stron w trybie prawdziwym: znalezienie choćby jednego to przeciek przykładu
 * do firmy na prawdziwych danych.
 *
 * - `Przykład` — każda nazwa firmy w `lib/demo/*` („Coworking Przykład…”,
 *   „Przykładowa Firma Handlowa…”, „Jan Przykładowy”);
 * - firmy-atrapy i fikcyjne NIP-y atrapy Analiz;
 * - resztki szablonu Finory z dzisiejszych stron Pulpitu i Przepływów
 *   (produkty, nazwy kart, adresy `.example`, awatary).
 *
 * Dopisując dane przykładowe, dopisz ich znacznik tutaj (albo nazwij je
 * z „Przykład”). Tylko dla testów i `lib/demo/*` — granica importów (T1).
 */
export const ZNACZNIKI_PRZYKLADU: readonly string[] = [
  // Dane przykładowe `lib/demo/*`.
  'Przykład',
  'przyklad-analizy',
  'przyklad-kpir',
  '0000000011',
  '0000002020',
  // Resztki szablonu Finory (Pulpit, Przepływy).
  'Samsung',
  'Netflix',
  'PlayStation',
  'iMac Pro',
  'Odwiedzający',
  'Zamówienia',
  'Wyświetlenia',
  'Fundusz awaryjny',
  'Rachunek oszczędnościowy',
  '.example',
  '@przyklad.pl',
  '/images/avatars/',
];
