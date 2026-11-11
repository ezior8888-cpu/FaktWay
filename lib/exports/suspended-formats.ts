/**
 * Formaty eksportu chwilowo wyłączone — z powodem, który widzi człowiek.
 *
 * JPK_V7M: generator tworzy strukturę JPK_V7M(2), a od rozliczenia za luty
 * 2026 obowiązuje JPK_V7M(3) (wzór CRWDE 2025/12/19/14090) z numerem KSeF
 * albo oznaczeniem OFF/BFK/DI w każdym wierszu ewidencji. Plik (2) nie
 * przejdzie przez bramkę MF, a brakuje w nim też sprzedaży zwolnionej (K_10)
 * i 0% (K_13). Decyzja Igora 27.09.2026: wyłączyć do czasu przebudowy.
 *
 * Comarch Optima: generator tworzył własny, zmyślony układ (`<Faktury>`,
 * `<Naglowek>`, `<Pozycje>`, przestrzeń `…/cdn/optima/faktury`). Optima
 * importuje rejestry VAT w formacie „Praca rozproszona”: `<ROOT
 * xmlns="http://www.comarch.pl/cdn/optima/offline">` z sekcjami
 * `REJESTRY_SPRZEDAZY_VAT` i `KONTRAHENCI`. Decyzja Igora 29.09.2026:
 * wyłączyć teraz, przebudować, odblokować po próbnym imporcie w Optimie.
 *
 * Bez importów — czyta to także komponent kliencki.
 */
export const SUSPENDED_EXPORT_FORMATS: Readonly<Record<string, string>> = {
  jpk_v7m:
    'JPK_V7M jest chwilowo wyłączony: przechodzimy na wersję JPK_V7M(3), obowiązującą od rozliczenia za luty 2026. Dotychczasowy plik nie przeszedłby przez bramkę Ministerstwa Finansów.',
  comarch_optima:
    'Eksport do Comarch Optima jest chwilowo wyłączony: dotychczasowy plik nie miał układu, który Optima importuje. Do czasu poprawki księgowa dostaje uniwersalny CSV.',
  // 29.09.2026 (decyzja Igora): „Symfonia”, „Wapro”, „Insert Subiekt” to były
  // zwykłe CSV z wymyślonymi kolumnami — żaden z tych programów ich wprost
  // nie przyjmuje. Symfonia FK i WAPRO Kaper importują JPK_FA(4), Subiekt
  // i Rewizor GT — EDI++ (.epp). Generator EDI++ jest w
  // `edi-plus-plus-generator.ts` (plan kompletnej aplikacji, krok 6.1); odwieszenie
  // = usunięcie `insert_subiekt` stąd po próbnym imporcie.
  symfonia:
    'Eksport „Symfonia” jest wyłączony: plik nie był w formacie, który Symfonia importuje. Symfonia FK wczytuje faktury z JPK_FA(4) — wybierz JPK_FA.',
  wapro:
    'Eksport „Wapro” jest wyłączony: plik nie był w formacie, który WAPRO importuje. WAPRO Kaper wczytuje faktury z JPK_FA — wybierz JPK_FA.',
  insert_subiekt:
    'Eksport „Insert Subiekt” jest wyłączony: Subiekt i Rewizor GT wczytują faktury w formacie EDI++ (.epp), a nie z dawnego pliku CSV. Plik EDI++ jest już przygotowany i czeka na próbny import w Subiekcie albo Rewizorze; do tego czasu wybierz uniwersalny CSV.',
};

/**
 * Czym zastąpić wstrzymany format w paczce dla księgowej — tym, co jej
 * program naprawdę importuje. JPK_FA przechodzi potem przez bramki
 * gotowości (urząd, korekty, adres z GUS) i w razie odmowy też staje się CSV.
 */
export const SUSPENDED_FORMAT_REPLACEMENT: Readonly<Record<string, 'jpk_fa' | 'csv_universal'>> = {
  jpk_v7m: 'csv_universal',
  comarch_optima: 'csv_universal', // Optima natywnie importuje JPK_VAT, nie JPK_FA
  symfonia: 'jpk_fa',
  wapro: 'jpk_fa',
  insert_subiekt: 'csv_universal', // Subiekt/Rewizor: EDI++, nie JPK_FA
};

export function isExportFormatSuspended(format: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUSPENDED_EXPORT_FORMATS, format);
}

/** Format do paczki: wstrzymany → jego zastępstwo, pozostałe bez zmian. */
export function replacementForFormat<F extends string>(format: F): F | 'jpk_fa' | 'csv_universal' {
  return isExportFormatSuspended(format) ? (SUSPENDED_FORMAT_REPLACEMENT[format] ?? 'csv_universal') : format;
}
