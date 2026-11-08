/**
 * Lustro komunikatów SQL decyzji przy 440 (00148, 00151, 00156) i ich
 * wypełnianie jak `RAISE EXCEPTION`.
 *
 * Część barelu `./duplicate-decision` (plan usprawnień 3.7b). Spoza
 * `lib/ksef/duplicate-decision*.ts` importuj tylko z barelu `@/lib/ksef/duplicate-decision`.
 * CZYSTY moduł (komponenty klienckie i worker): bez bazy, KSeF, Node i `duplicate-verdict.ts`.
 */

// ─── Teksty SQL (00148, 2.11.A) ──────────────────────────────────────────────

export type DuplicateDecisionSqlTextKey =
  | 'NOTE'
  | 'ROLE'
  | 'ALREADY'
  | 'IN_FLIGHT'
  | 'not-pending'
  | 'in-ksef'
  | 'kind'
  | 'billing'
  | 'offline'
  | 'no-marker'
  | 'conflicting-originals'
  | 'no-check'
  | 'reason'
  | 'known-stale'
  | 'own-history'
  | 'payments'
  | 'STALE'
  | 'ENV'
  | 'EVIDENCE'
  | 'TRIGGER_SAME'
  | 'TRIGGER_OTHER'
  | 'TRIGGER_AUTO'
  | 'TRIGGER_DELETE'
  | 'TRIGGER_RENUMBER'
  | 'TRIGGER_DIRECTION'
  | 'CATALOG_NUMBER_TAKEN'
  // PR C (00156, spec v3 6.3; marka FaktWay) — lista prawnika.
  | 'known-now'
  | 'cross-tenant'
  | 'recheck-needed'
  | 'provenance-review'
  | 'CHOICE'
  | 'IMPORT_MISMATCH'
  | 'ALREADY_IMPORTED'
  | 'TRIGGER_SAME_IMPORTED'
  | 'TRIGGER_OTHER_IMPORTED'
  | 'TRIGGER_DELETE_IMPORTED'
  | 'TRIGGER_RENUMBER_IMPORTED'
  | 'TRIGGER_DIRECTION_IMPORTED';

export interface DuplicateDecisionSqlText {
  /** Wzorzec `RAISE EXCEPTION '<wzorzec>', args…` — `%` to znacznik RAISE (C1). */
  template: string;
  /** Liczba `%` = liczba argumentów RAISE. */
  arity: number;
}

/**
 * Lustro komunikatów 00148 (od 00151 w marce FaktWay) słowo w słowo (`RAISE EXCEPTION '<template>', … USING
 * ERRCODE`; CATALOG to literał UPDATE katalogu `ksef_error_codes`). Żaden wzorzec
 * nie ma dosłownego `%` ani apostrofu. Kolejność argumentów — sekcja 2.11.A
 * specyfikacji: known-stale i own-history (K, nr); ENV (K, etykieta środowiska
 * sprawdzenia, etykieta środowiska aplikacji, nr); ALREADY (nr, zapisany wybór);
 * TRIGGER_AUTO (nr, „fakturę {K}” / „inną fakturę Twojej firmy”); TRIGGER_DELETE,
 * TRIGGER_RENUMBER i TRIGGER_DIRECTION (nr, „faktura {K}” / „inna faktura Twojej firmy”).
 * Test U16e sprawdza, że każdy wzorzec stoi zaraz po `RAISE EXCEPTION '` w ciele
 * funkcji obowiązującym po wszystkich migracjach (00148, decyzja i wyzwalacz z 00151);
 * klucze PR C — U16e-00156 w 00156 (core decyzji i wyzwalacz), a tryb retire core
 * w 00156 ma teksty PR B dosłownie z 00151.
 *
 * Testy RLS porównują `error.message` z bazy z tym lustrem słowo w słowo, więc zmiana
 * tekstu = nowa migracja (kolejny numer z rejestru) z `CREATE OR REPLACE` funkcji,
 * a w tym samym PR aktualizacja tego lustra — tak zrobiła to 00151 przy zmianie marki
 * na FaktWay (strażnik U16h: w ciałach zmieniły się tylko literały z marką).
 */
export const DUPLICATE_DECISION_SQL_TEXTS: Readonly<Record<DuplicateDecisionSqlTextKey, DuplicateDecisionSqlText>> = {
  NOTE: { template: 'Zapisując decyzję klienta, opisz w notatce kanał, datę i osobę (co najmniej 10 znaków).', arity: 0 },
  ROLE: { template: 'Decyzję w sprawie dokumentu, którego numer jest zajęty w KSeF, zapisuje właściciel albo administrator firmy.', arity: 0 },
  ALREADY: { template: 'Decyzja dla dokumentu % jest już zapisana („%”). Jeśli była błędna, napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', arity: 2 },
  IN_FLIGHT: { template: 'Sprawdzamy dokument % w KSeF — odśwież stronę za kilka minut.', arity: 1 },
  'not-pending': { template: 'Dokument % nie czeka już na Twoją decyzję — odśwież stronę.', arity: 1 },
  'in-ksef': { template: 'Dokument % ma już numer KSeF — decyzja nie jest potrzebna. Odśwież stronę; jeśli komunikat wraca, napisz do nas: pomoc@faktway.pl.', arity: 1 },
  kind: { template: 'Dokument % to korekta, faktura zaliczkowa albo rozliczeniowa — tej decyzji nie zapiszesz jeszcze w FaktWay. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', arity: 1 },
  billing: { template: 'Dokument % to faktura abonamentu FaktWay — decyzję zapisuje pomoc FaktWay.', arity: 1 },
  offline: { template: 'Dokument % był wystawiony w trybie offline i mógł już trafić do nabywcy — tej decyzji nie zapiszesz w FaktWay. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', arity: 1 },
  'no-marker': { template: 'Dla dokumentu % nie mamy zapisanej odpowiedzi KSeF o fakturze z tym numerem — tej decyzji nie zapiszesz w FaktWay. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', arity: 1 },
  'conflicting-originals': { template: 'W historii dokumentu % są odpowiedzi KSeF o dwóch różnych fakturach — tej decyzji nie zapiszesz w FaktWay. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', arity: 1 },
  'no-check': { template: 'Dla dokumentu % nie mamy jeszcze danych faktury z KSeF — sprawdzimy ją ponownie automatycznie (zwykle w ciągu 2 dni). Nie wystawiaj go ponownie.', arity: 1 },
  reason: { template: 'Dla dokumentu % ta decyzja nie jest dostępna w panelu. Nie wystawiaj go ponownie; szczegóły są na karcie faktury, a pytania: pomoc@faktway.pl.', arity: 1 },
  'known-stale': { template: 'Dokument w FaktWay, który ma albo miał numer KSeF %, nie zgadza się już z naszym zapisem — sprawdzimy fakturę w KSeF ponownie automatycznie (zwykle w ciągu 2 dni). Jeśli ten komunikat zostanie dłużej, napisz do nas: pomoc@faktway.pl. Nie wystawiaj dokumentu % ponownie.', arity: 2 },
  'own-history': { template: 'Faktura % w KSeF może być wcześniejszą wersją dokumentu % wysłaną z FaktWay — tej decyzji nie zapiszesz w panelu. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', arity: 2 },
  payments: { template: 'Na dokumencie % są zapisane wpłaty — decyzji nie zapiszemy, dopóki wpłaty są przy tym dokumencie. W FaktWay nie zmienisz ich sam: napisz do nas: pomoc@faktway.pl, podając numer dokumentu — ustalimy, przy której fakturze je zapisać. Nie wystawiaj go ponownie.', arity: 1 },
  STALE: { template: 'Dane faktury w KSeF dla dokumentu % zmieniły się od otwarcia strony — odśwież stronę i zdecyduj jeszcze raz.', arity: 1 },
  ENV: { template: 'Dane faktury % sprawdziliśmy w środowisku KSeF „%”, a FaktWay pracuje teraz w środowisku „%” — tej decyzji nie zapiszesz. Nie wystawiaj dokumentu % ponownie i napisz do nas: pomoc@faktway.pl.', arity: 4 },
  EVIDENCE: { template: 'Dokument % mógł dotrzeć do KSeF w innej próbie — decyzji nie zapiszemy. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl.', arity: 1 },
  TRIGGER_SAME: { template: 'Dokument % jest wycofany: to ta sama sprzedaż co faktura % w KSeF. Tego dokumentu nie wyślesz do KSeF.', arity: 2 },
  TRIGGER_OTHER: { template: 'Dokument % jest wycofany: numer jest zajęty w KSeF przez fakturę %. Tego dokumentu nie wyślesz do KSeF — tę sprzedaż wystaw jako nową fakturę z nowym numerem.', arity: 2 },
  TRIGGER_AUTO: { template: 'Numer % jest zajęty w KSeF przez % wystawioną poza FaktWay — tego dokumentu nie wyślesz do KSeF (KSeF odrzuciłby go jako duplikat). Jeśli to inna sprzedaż, wystaw ją jako nową fakturę z nowym numerem.', arity: 2 },
  TRIGGER_DELETE: { template: 'Wycofanego dokumentu % nie usuniesz: zajmuje numer, który w KSeF ma już %, i zostaje w FaktWay, żeby ten numer nie został podpowiedziany ponownie. Jeśli musisz go usunąć, napisz do nas: pomoc@faktway.pl.', arity: 2 },
  TRIGGER_RENUMBER: { template: 'Numeru wycofanego dokumentu % nie zmienisz: ten numer ma w KSeF już %, a dokument zostaje z nim w FaktWay, żeby numer nie został podpowiedziany ponownie. Inną sprzedaż wystaw jako nową fakturę z nowym numerem.', arity: 2 },
  TRIGGER_DIRECTION: { template: 'Wycofanego dokumentu % nie zmienisz na fakturę zakupową: zajmuje numer, który w KSeF ma już %, i zostaje w FaktWay jako faktura sprzedaży, żeby tego numeru nie dostała inna faktura sprzedaży.', arity: 2 },
  CATALOG_NUMBER_TAKEN: { template: 'W KSeF jest już faktura Twojej firmy o tym numerze, wystawiona w innym programie. Tego dokumentu nie wyślesz do KSeF. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie. Jeśli inna — wystaw ją jako nową fakturę z nowym numerem.', arity: 0 },
  // ── PR C (00156, spec v3 6.3; lista prawnika; marka FaktWay jak 00151). Argumenty: known-now (K, nr); cross-tenant (nr, nr);
  // recheck-needed, provenance-review, CHOICE (nr); IMPORT_MISMATCH (K, nr); ALREADY_IMPORTED (nr, etykieta
  // decyzji — „zapis faktury z KSeF” przy ofercie record/review-record); TRIGGER_SAME_IMPORTED (nrOld, K, nrOld);
  // TRIGGER_OTHER_IMPORTED (nrOld, nrOld, K); TRIGGER_DELETE/RENUMBER/DIRECTION_IMPORTED (nrOld, K).
  'known-now': { template: 'Faktura % z KSeF jest już zapisana w FaktWay przy innym dokumencie — sprawdzimy ją ponownie automatycznie (zwykle w ciągu 2 dni). Jeśli ten komunikat zostanie dłużej, napisz do nas: pomoc@faktway.pl. Nie wystawiaj dokumentu % ponownie.', arity: 2 },
  'cross-tenant': { template: 'Faktury z KSeF o numerze % nie możemy zapisać przy tym dokumencie — wyjaśniamy to i damy znać. Nie wystawiaj dokumentu % ponownie; pytania: pomoc@faktway.pl.', arity: 2 },
  'recheck-needed': { template: 'Fakturę z KSeF dla dokumentu % sprawdzamy jeszcze raz — automatycznie, zwykle w ciągu 2 dni; potem decyzję zapiszesz na tej karcie. Nie wystawiaj dokumentu ponownie; jeśli ten komunikat zostanie dłużej, napisz do nas: pomoc@faktway.pl.', arity: 1 },
  'provenance-review': { template: 'Sprawdzamy fakturę z KSeF dla dokumentu % — nie wystawiaj go ponownie, damy znać. Pytania: pomoc@faktway.pl.', arity: 1 },
  CHOICE: { template: 'Dla dokumentu % możliwy jest tylko zapis faktury z KSeF jako tej samej sprzedaży — odśwież stronę.', arity: 1 },
  IMPORT_MISMATCH: { template: 'Faktury % z KSeF nie zapiszemy przy dokumencie %: numer faktury albo NIP sprzedawcy w KSeF nie zgadza się z tym dokumentem albo z danymi Twojej firmy. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl, podając numer dokumentu.', arity: 2 },
  ALREADY_IMPORTED: { template: 'Decyzja dla dokumentu % jest już zapisana („%”) — co zrobić, jeśli była błędna, piszemy na karcie wycofanego dokumentu.', arity: 2 },
  TRIGGER_SAME_IMPORTED: { template: 'Wycofanego dokumentu (dawniej %) nie wyślesz do KSeF: to ta sama sprzedaż co faktura % z KSeF, zapisana w FaktWay pod numerem %.', arity: 3 },
  TRIGGER_OTHER_IMPORTED: { template: 'Wycofanego dokumentu (dawniej %) nie wyślesz do KSeF: numer % ma faktura % z KSeF, zapisana w FaktWay. Tę sprzedaż wystaw jako nową fakturę z nowym numerem.', arity: 3 },
  TRIGGER_DELETE_IMPORTED: { template: 'Wycofanego dokumentu (dawniej %) nie usuniesz: zostaje w FaktWay jako ślad decyzji o fakturze % z KSeF, która ma teraz jego numer. Jeśli musisz go usunąć, napisz do nas: pomoc@faktway.pl.', arity: 2 },
  TRIGGER_RENUMBER_IMPORTED: { template: 'Wycofanemu dokumentowi (dawniej %) nie nadasz numeru — zostaje bez numeru jako ślad decyzji o fakturze % z KSeF. Inną sprzedaż wystaw jako nową fakturę z nowym numerem.', arity: 2 },
  TRIGGER_DIRECTION_IMPORTED: { template: 'Wycofanego dokumentu (dawniej %) nie zmienisz na fakturę zakupową: zostaje w FaktWay jako ślad decyzji o fakturze % z KSeF.', arity: 2 },
};

/**
 * Wypełnia wzorzec RAISE jak Postgres: każdy `%` po kolei, od lewej. Rzuca, gdy
 * liczba `%` różni się od liczby argumentów — straż przed rozjazdem z 00148 (C1).
 * Znaki `%` w argumentach nie są podstawiane.
 */
export function fillSqlText(template: string, ...args: string[]): string {
  const parts = template.split('%');
  if (parts.length - 1 !== args.length) {
    throw new Error(`fillSqlText: wzorzec ma ${parts.length - 1} znaczników %, podano ${args.length} argumentów`);
  }
  return parts.reduce((out, part, i) => out + part + (i < args.length ? args[i] : ''), '');
}

export const sqlText = (key: DuplicateDecisionSqlTextKey, ...args: string[]): string =>
  fillSqlText(DUPLICATE_DECISION_SQL_TEXTS[key].template, ...args);

/** `v_num` w SQL: numer dokumentu albo „(bez numeru)”. */
export const documentNumber = (invoiceNumber: string | null | undefined): string => invoiceNumber ?? '(bez numeru)';

/** Etykieta środowiska w tekście ENV (jak w RPC). */
export function duplicateEnvLabel(env: unknown): string {
  switch (env) {
    case 'test':
      return 'testowe';
    case 'production':
      return 'produkcyjne';
    case 'demo':
      return 'demo';
    default:
      return 'nieznane';
  }
}
