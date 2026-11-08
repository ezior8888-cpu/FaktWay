/**
 * Decyzja klienta przy nierozstrzygniętym duplikacie 440 (D-A4-1b-3 PR B, plan
 * „zero zgubionych faktur”; decyzje Bartosza 04.10 i 07.10.2026). KSeF ma już
 * fakturę tej firmy o numerze naszego dokumentu (K), a automat nie rozstrzygnął,
 * czy to ta sama sprzedaż. Właściciel albo administrator firmy (albo operator
 * na jego prośbę) zapisuje: „ta sama sprzedaż” albo „inna sprzedaż”. Obie
 * decyzje wycofują nasz dokument: zostaje szkicem, którego nie wyślesz do KSeF
 * (wyzwalacze 00148), a zwykłej faktury i zaliczki nie usuniesz (decyzja 9).
 *
 * Tu: czysta polityka (lustro `ksef_duplicate_check_allows`
 * i `ksef_duplicate_decision_blocker` z 00148), widok panelu, baner szkicu
 * wycofanego każdego rodzaju i wszystkie teksty klienta. RPC sprawdza to samo
 * po stronie bazy — ta polityka jest pierwszą linią, nie jedyną.
 *
 * Teksty: przegląd prawnika przed KSeF PROD — decyzje Bartosza 07.10.2026 (A)
 * i (8); TEST bez blokady; obejmuje teksty RPC i wyzwalaczy 00148
 * (DUPLICATE_DECISION_SQL_TEXTS). Migawka do przeglądu:
 * `tests/unit/__snapshots__/ksef-duplikat-decyzja-teksty.txt`.
 *
 * D-A4-1b-3 PR C (00156, spec v3 5.5): powód `faktflow-original` — oferta
 * (`duplicateOriginalOffer`, lustro `ksef_duplicate_original_offer`), lustra
 * `ksef_duplicate_check_allows` (4.2), `ksef_duplicate_own_history` (4.3)
 * i kroku 11c blokady, widok operatora `review`, banery szkicu po zapisie
 * oryginału, warianty powiadomień, teksty `DUPLICATE_DECISION_TEXTS.FAKTFLOW`
 * i nowe klucze SQL. Kody `known-now`, `cross-tenant` i wiersze `payments`
 * TS bierze z blokady SQL (`facts.sqlBlocker`) — sam ich nie liczy (INV-15).
 *
 * CZYSTY moduł (importowany w komponentach klienckich i w workerze): bez bazy,
 * KSeF i Node. Nie importuje `duplicate-verdict.ts` (`node:crypto`).
 */

import { formatWarsawDateTime, todayInWarsaw } from '@/lib/format/warsaw-date';
import {
  KSEF_SEND_MESSAGES,
  KSEF_SPECIAL_SEND_MESSAGES,
  SPECIAL_KIND_LABEL,
  specialKindOf,
} from '@/lib/invoices/ksef-send-policy';
import { SUPPORT_EMAIL } from '@/lib/site';
import type { KsefEnvironment } from '@/types/ksef';

import {
  DUPLICATE_DECISION_MODES,
  DUPLICATE_ORIGINAL_IMPORT_OFFERS,
  DUPLICATE_ORIGINAL_NOTES,
  DUPLICATE_ORIGINAL_OFFERS,
  ORIGINAL_CORRECTABLE_BUYER_ID_KINDS,
  ORIGINAL_IMPORT_SOURCE,
  ORIGINAL_RECHECK_KINDS,
  originalAssignedDay,
  originalGateOk,
  originalHasUncorrectableLine,
  type DuplicateDecisionChoice,
  type DuplicateDecisionMode,
  type DuplicateDecisionVia,
  type DuplicateOriginalImportOffer,
  type DuplicateOriginalOffer,
  type OriginalGateProblem,
  type OriginalPreview,
  type OriginalRecheckKind,
} from './duplicate-check';
import { isCorrectionHeldForEnv } from './kind-holds';

// PR C (5.5): lustro `ksef_duplicate_gate_ok` i dzień nadania numeru mieszkają
// w `duplicate-check.ts` (bez cyklu importów: `parseImportGate` używa tego
// samego sprawdzenia); polityka eksportuje je razem z resztą kontraktu.
export { originalAssignedDay, originalGateOk } from './duplicate-check';
export type { DuplicateDecisionMode, DuplicateOriginalImportOffer, DuplicateOriginalOffer } from './duplicate-check';

/**
 * `<SystemInfo>` plików FaktWay — ta sama wartość co `FAKTFLOW_SYSTEM_INFO`
 * w `duplicate-verdict.ts` (tamten moduł ciągnie `node:crypto`, więc nie do
 * komponentu); generatory przypina `ksef-duplikat-werdykt.test.ts`.
 */
const FAKTFLOW_SYSTEM_INFO = 'KSeF SaaS v1.0';

export type DuplicateChoice = DuplicateDecisionChoice;
export type DuplicateVia = DuplicateDecisionVia;
/** Powody, dla których klient decyduje: PR B (`no-own-file`, `known-number`) i PR C (`faktflow-original`, 00156). */
export type DuplicateDecisionReason = 'no-own-file' | 'known-number' | 'faktflow-original';

/**
 * Kody `ksef_duplicate_decision_blocker` w kolejności sprawdzeń 00156 (4.5):
 * 00148 + `known-now`, `cross-tenant`, `recheck-needed` (tylko
 * `faktflow-original`, przed `own-history`) i `provenance-review` (ostatni).
 * Dla powodów PR B kody i kolejność jak w 00148 (INV-14).
 */
export const DUPLICATE_DECISION_BLOCKER_CODES = [
  'not-found',
  'not-pending',
  'in-ksef',
  'kind',
  'billing',
  'offline',
  'no-marker',
  'conflicting-originals',
  'no-check',
  'reason',
  'known-stale',
  'known-now',
  'cross-tenant',
  'recheck-needed',
  'own-history',
  'payments',
  'provenance-review',
] as const;
export type DuplicateDecisionBlockerCode = (typeof DUPLICATE_DECISION_BLOCKER_CODES)[number];

/**
 * Kody odmowy widoku: blokada SQL (`DUPLICATE_DECISION_BLOCKER_CODES`) i odmowy
 * aplikacji — środowisko, rola, a od PR C: `state-unknown` (odczyt blokady
 * nieudany), `recheck` (odmowa w chwili zapisu z tekstem `FAKTFLOW.RECHECK`
 * i znacznikiem `recheckNeeded`), `not-buildable` (operator w przeglądzie —
 * pliku nie da się zapisać).
 */
export type DuplicateDecisionRefusal =
  | DuplicateDecisionBlockerCode
  | 'env-unknown'
  | 'env'
  | 'role'
  | 'state-unknown'
  | 'recheck'
  | 'not-buildable';

// ─── Fakty (kształt wierszy ładowarki `loadDuplicateDecisionFacts`) ──────────

/** Wiersz faktury — kolumny `DUPLICATE_DECISION_INVOICE_COLUMNS` (`duplicate-decision-facts.ts`). */
export interface DuplicateDecisionInvoiceRow {
  id: string;
  tenant_id: string;
  internal_number: string | null;
  direction: string | null;
  ksef_status: string | null;
  last_error_code: string | null;
  ksef_number: string | null;
  invoice_kind: string | null;
  stripe_invoice_id: string | null;
  offline_idempotency_key: string | null;
  offline_qr_offline: string | null;
  offline_qr_certyfikat: string | null;
  /** `numeric` — PostgREST zwraca liczbę, ale napis też przyjmujemy. */
  paid_amount: number | string | null;
  issue_date: string | null;
  buyer_nip: string | null;
  buyer_data: unknown;
  gross_total: number | string | null;
  currency: string | null;
  /** PR C (5.4, 5.5): wiersz „Data sprzedaży” przy `faktflow-original` (`NULL` = jak data wystawienia). */
  sale_date: string | null;
}

/** Wpis `ksef_submissions` (wszystkie stany) z surowym `original_check` (jsonb). */
export interface DuplicateDecisionSubmissionRow {
  id: string;
  status: string;
  session_reference_number: string | null;
  request_payload_hash: string | null;
  response_ksef_number: string | null;
  original_ksef_number: string | null;
  original_session_reference_number: string | null;
  original_check: unknown;
  attempted_at: string | null;
  completed_at: string | null;
}

/** Faktura Y (`known-number`) odczytana przez ładowarkę. */
export interface DuplicateDecisionKnownInvoice {
  id: string;
  internalNumber: string | null;
  /** Y wychodząca, przyjęta w KSeF, z numerem KSeF oryginału i inna niż X (2.1.2 #11, uwaga 1 sprawdzenia). */
  holdsOriginal: boolean;
}

export interface DuplicateDecisionFacts {
  /** `null` — faktury nie ma w tej firmie (`not-found`). */
  invoice: DuplicateDecisionInvoiceRow | null;
  submissions: DuplicateDecisionSubmissionRow[];
  knownInvoice: DuplicateDecisionKnownInvoice | null;
  /**
   * PR C (5.4): kod `ksef_duplicate_decision_blocker` odczytany przy znaczniku
   * `faktflow-original` (sesja: `ksef_duplicate_decision_blocker_for_session`,
   * operator i worker: klucz serwisowy) — `null` = faktura czeka na decyzję;
   * `undefined` = nie odczytano (polityka odmawia `state-unknown` dla
   * `faktflow-original`; powody PR B go nie potrzebują).
   */
  sqlBlocker?: string | null;
}

// ─── Widoki ──────────────────────────────────────────────────────────────

export interface ComparisonRow {
  label: string;
  /** Wartość z faktury w KSeF (`original_check.summary`). */
  ksef: string | null;
  /** Wartość z tego dokumentu w FaktWay. */
  ours: string | null;
  /**
   * `false` — „różni się” w tabeli (przy kwocie także inna znana waluta);
   * `null` — bez porównania (wartość albo waluta nieznana, program).
   */
  same: boolean | null;
}

/**
 * Dane do tekstu operatora przy odmowie (2.11.D: `paid_amount {x}`, środowiska,
 * `{Y}`/`{K}` przy known-stale, `{r}` przy powodzie). Tylko w widoku operatora
 * (`actor: 'operator'`) — widok klienta ich nie niesie.
 */
export interface DuplicateRefusalDetail {
  /** K ze znacznika (`null` bez znacznika). */
  originalKsefNumber: string | null;
  /** Surowy `original_check.reason` znacznika. */
  reason: string | null;
  /** `original_check.env` znacznika. */
  checkEnv: string | null;
  /** `KSEF_ENV` aplikacji. */
  environment: KsefEnvironment | null;
  paidAmount: number | null;
  /** `{Y}` — numer dokumentu, który ma K w FaktWay (`bez numeru`, gdy nieznany); `null` poza known-number. */
  knownInvoiceNumber: string | null;
  /** PR C: `original_check.recheckNeeded.kind` przy blokadzie `recheck-needed` (tekst operatora `recheckPending`); opcjonalne dla PR B. */
  recheckKind?: OriginalRecheckKind | null;
  /** PR C: `original_check.recheckNeeded.at` (ISO); opcjonalne dla PR B. */
  recheckAt?: string | null;
}

/** Oferta w widoku `decidable` (5.5); `null` = powód PR B. */
export type DuplicateDecidableOffer = Extract<DuplicateOriginalOffer, 'pair' | 'record' | 'released'>;
/** Oferta w widoku operatora `review` (przegląd pliku, I5R). */
export type DuplicateReviewOffer = Extract<DuplicateOriginalOffer, 'review-pair' | 'review-record'>;

/**
 * Wstęp panelu przy ofercie `record` (5.5, `intro`): `'own'` — własna historia (JSON `ownHistory` albo
 * baza: sesja / skrót), przed `'same'` — tylko `sameContentExceptHeader`. Panel nie widzi `ownHistoryDb`,
 * więc `sameContent` samo nie odróżnia „własna historia + ta sama treść” od „sama ta sama treść”.
 */
export type DuplicateRecordIntro = 'own' | 'same';

/** Dane oryginału `faktflow-original` w widoku — z `importGate.preview`, bez archiwum i klucza serwisowego. */
export interface DuplicateOriginalViewData {
  preview: OriginalPreview | null;
  /** `originalAssignedDay(check, K)` — `{dzien}` w `FAKTFLOW.INTRO_RECORD_*`; `null` nieznany. */
  assignedDay: string | null;
  /** `preview.period` wcześniejszy niż bieżący miesiąc (Europe/Warsaw, `input.now`) — zdanie `PAST_PERIOD`. */
  pastPeriod: boolean;
}

/**
 * Widok operatora w przeglądzie pliku (`provenance-review`, 5.5): zapis
 * oryginału („Zapisz fakturę z KSeF w FaktWay”) i — tylko przy `review-pair` —
 * oddanie decyzji klientowi. Zapisywalność (`recordable`) dokłada strona
 * operatora z suchego przebiegu `prepareOriginalImport`; polityka jest czysta.
 * Klient tego widoku nie dostaje (odmowa `provenance-review`).
 */
export interface DuplicateDecisionReviewView {
  kind: 'review';
  offer: DuplicateReviewOffer;
  problems: OriginalGateProblem[];
  invoiceNumber: string | null;
  originalKsefNumber: string;
  originalSha256: string;
  comparison: ComparisonRow[];
  original: DuplicateOriginalViewData | null;
  /** `review-record` → `['same_sale']`. */
  choices: readonly DuplicateChoice[];
  needsConfirmation: Record<DuplicateChoice, boolean>;
  sameContent: boolean | null;
  markedDifference: boolean;
  heldCorrections: boolean;
  program: 'FaktWay';
  /** `offer === 'review-pair'` — „Oddaj decyzję klientowi” (INV-19, N4). */
  releasable: boolean;
  /** `preview.buyerIdKind ∉ ORIGINAL_CORRECTABLE_BUYER_ID_KINDS` — zdanie `FAKTFLOW.CORRECTION_PERSON`. */
  correctionForPerson: boolean;
  /** Pozycja zw, stawka spoza FaktWay albo brak ceny netto w pliku (`originalHasUncorrectableLine`) — zdanie `FAKTFLOW.CORRECTION_RATE`. */
  correctionForRate: boolean;
  /** Wstęp przy `review-record` — jak w widoku `decidable` (patrz tam). */
  recordIntro?: DuplicateRecordIntro;
}

export type DuplicateDecisionView =
  | {
      kind: 'decidable';
      reason: DuplicateDecisionReason;
      invoiceNumber: string | null;
      originalKsefNumber: string;
      originalSha256: string;
      comparison: ComparisonRow[];
      /**
       * Któryś wiersz `comparison` ma „różni się” (`same === false`). Wybiera
       * etykietę „Rozumiem skutki” przy „ta sama sprzedaż”: `true` — „mimo
       * różnic zaznaczonych w tabeli” (`DIALOG_SAME.CHECKBOX`), `false` — „choć
       * części danych w tabeli nie da się porównać” (`CHECKBOX_UNCOMPARABLE`;
       * np. B2C bez NIP nabywcy, waluta nieznana). Klient i operator.
       */
      markedDifference: boolean;
      /** Treść pozycji zgodna z oryginałem poza nagłówkiem; `null` — nie porównano (brak naszego pliku). */
      sameContent: boolean | null;
      /** Wybór wymaga pola „Rozumiem skutki” (decyzje 7 i 12; sprawdza też serwer). */
      needsConfirmation: Record<DuplicateChoice, boolean>;
      /** `FaktWay`, nazwa programu z `SystemInfo` albo `null` (nieznany). */
      program: string | null;
      knownInvoice: { id: string; internalNumber: string | null } | null;
      /** Korekty do KSeF wstrzymane w tym środowisku (zdanie w dialogu „inna sprzedaż”). */
      heldCorrections: boolean;
      // ── PR C (5.5) — opcjonalne w kontrakcie, żeby widoki i fikstury PR B
      // kompilowały się bez zmian; `duplicateDecisionOptions` ustawia je zawsze
      // (powody PR B: `offer` i `mode` null, oba wybory, `original` null).
      /** `pair` / `record` / `released`; `null` = powód PR B. */
      offer?: DuplicateDecidableOffer | null;
      /** `pair`/`record` → `import`, `released` → `no-import`; `null` = PR B (9-argumentowe RPC). */
      mode?: DuplicateDecisionMode | null;
      /** Wybory do pokazania: `record` → `['same_sale']`, inaczej oba. */
      choices?: readonly DuplicateChoice[];
      original?: DuplicateOriginalViewData | null;
      /** `preview.buyerIdKind ∉ ORIGINAL_CORRECTABLE_BUYER_ID_KINDS` — zdanie `FAKTFLOW.CORRECTION_PERSON`. */
      correctionForPerson?: boolean;
      /**
       * Plik K ma pozycję, której FaktWay jeszcze nie skoryguje (zw do czasu C3, stawka FA(3) spoza FaktWay,
       * brak ceny netto; `originalHasUncorrectableLine` z `importGate`) — zdanie `FAKTFLOW.CORRECTION_RATE`.
       * Niezależne od `correctionForPerson`: gdy dotyczą obie, panel pokazuje oba zdania po jednym razie.
       */
      correctionForRate?: boolean;
      /**
       * Który wstęp pokazuje panel przy ofercie `record`: `'own'` — `FAKTFLOW.INTRO_RECORD_OWN`, gdy
       * `ownHistory` z JSON albo z bazy (sesja / skrót); ma PIERWSZEŃSTWO przed `'same'` —
       * `FAKTFLOW.INTRO_RECORD_SAME`, gdy tylko `sameContentExceptHeader`. `undefined` przy ofercie
       * `pair` i `released` oraz przy powodach PR B.
       */
      recordIntro?: DuplicateRecordIntro;
    }
  | {
      kind: 'refused';
      refusal: DuplicateDecisionRefusal;
      /** Tekst 2.11.A dla dokumentu; `null` (powód `reason`) = notatka PR A z karty. */
      message: string | null;
      detail?: DuplicateRefusalDetail;
    }
  | {
      kind: 'decided';
      choice: DuplicateChoice;
      via: DuplicateVia;
      at: string;
      originalKsefNumber: string | null;
      // ── PR C (5.5) — z `decision` znacznika; brak przy decyzjach PR B.
      mode?: DuplicateDecisionMode | null;
      offer?: DuplicateOriginalOffer | null;
      /** Faktura K zapisana z KSeF (`mode = 'import'`). */
      importedInvoiceId?: string | null;
      /** Numer, który przeszedł z X na K (`mode = 'import'`). */
      retiredInternalNumber?: string | null;
    }
  | DuplicateDecisionReviewView;

/** Wariant powiadomienia klienta (e-mail, push, przypomnienie operatora) — z tej samej oferty co panel (INV-24). */
export type DuplicateNoticeVariant = 'pair' | 'record' | 'released' | 'review';

/** Etykieta decyzji na karcie K, w `ALREADY_IMPORTED` i toastach (`FAKTFLOW.IMPORTED_CARD_CHOICE`). */
export type DuplicateDecisionLabel = DuplicateChoice | 'record';

/** Pochodzenie faktury K zapisanej decyzją (`fa3_data.import`, 6.5) — tylko to trafia do komponentu karty K. */
export interface ImportedOriginalProvenance {
  /** `fa3_data.import.decision.at`. */
  decidedAt: string;
  choice: DuplicateChoice;
  offer: DuplicateOriginalImportOffer;
  via: DuplicateVia;
  retiredInvoiceId: string;
  retiredInternalNumber: string;
}

export interface RetiredDraftView {
  title: string;
  body: string;
  /** Jedyny przycisk banera; `null` — zwykła „ta sama sprzedaż”, korekta, faktura rozliczeniowa. */
  cta: { href: string; label: string } | null;
  /** Dokument Y przy decyzji „ta sama sprzedaż” z powodem known-number. */
  knownInvoice: { id: string; internalNumber: string | null } | null;
  /** Odmowa wysyłki — ten sam tekst co wyzwalacz `c_guard_ksef_retired_draft`. */
  sendRefusal: string | null;
  /** Korekta i faktura rozliczeniowa (decyzja 9) — jak `WHEN` wyzwalacza usuwania. */
  deletable: boolean;
  /** Odmowa usunięcia (zwykła, zaliczka) — tekst wyzwalacza `c_guard_ksef_retired_draft_delete`. */
  deleteRefusal: string | null;
  /**
   * PR C (5.5, 6.4): faktura K z KSeF, na którą przeszedł numer dokumentu
   * (decyzja z `importedInvoiceId`); `internalNumber` = dawny numer X.
   * Opcjonalne w kontrakcie — banery PR B go nie ustawiają.
   */
  imported?: { id: string; internalNumber: string } | null;
}

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

const sqlText = (key: DuplicateDecisionSqlTextKey, ...args: string[]): string =>
  fillSqlText(DUPLICATE_DECISION_SQL_TEXTS[key].template, ...args);

/** `v_num` w SQL: numer dokumentu albo „(bez numeru)”. */
const documentNumber = (invoiceNumber: string | null | undefined): string => invoiceNumber ?? '(bez numeru)';

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

// ─── Teksty klienta (2.11.B–C) ───────────────────────────────────────────────

/** `{program}` w bierniku (2.11): FaktWay, inny znany program albo nieznany (każdy plik FaktWay ma SystemInfo). */
export function programAccusative(program: string | null): string {
  if (program === 'FaktWay') return DUPLICATE_DECISION_TEXTS.PROGRAM_ACCUSATIVE.FAKTFLOW;
  return program ? DUPLICATE_DECISION_TEXTS.PROGRAM_ACCUSATIVE.OTHER(program) : DUPLICATE_DECISION_TEXTS.PROGRAM_ACCUSATIVE.UNKNOWN;
}

/** `{programN}` w mianowniku. */
export function programNominative(program: string | null): string {
  if (program === 'FaktWay') return DUPLICATE_DECISION_TEXTS.PROGRAM_NOMINATIVE.FAKTFLOW;
  return program ? DUPLICATE_DECISION_TEXTS.PROGRAM_NOMINATIVE.OTHER(program) : DUPLICATE_DECISION_TEXTS.PROGRAM_NOMINATIVE.UNKNOWN;
}

/** ` (numer KSeF {K})` — pomijane, gdy wpisy nie niosą numeru oryginału. */
const ksefNumberPart = (k: string | null): string => (k ? ` (numer KSeF ${k})` : '');

const S = KSEF_SPECIAL_SEND_MESSAGES;

/**
 * Wszystkie teksty klienta decyzji przy 440 i szkicu wycofanego (2.11.B–C).
 * Argumenty pozycyjne (napisy), żeby migawka dla prawnika pokazała całe zdania
 * ze znacznikami: `{nr}` numer dokumentu, `{K}` numer KSeF oryginału, `{nrK}`
 * numer faktury z KSeF (`summary.number ?? {nr}`), `{Y}` numer dokumentu, który
 * ma K w FaktWay, `{X}` program. Odmowy z bazy (P0001) są w
 * `DUPLICATE_DECISION_SQL_TEXTS`. Teksty operatora (2.11.D) — poza przeglądem,
 * w `lib/admin/ksef-operator-policy.ts`.
 */
export const DUPLICATE_DECISION_TEXTS = {
  // Panel decyzji na karcie faktury.
  INTRO: (nr: string, k: string, program: string | null) =>
    `KSeF nie przyjął dokumentu ${nr}, bo ma już fakturę Twojej firmy o tym numerze (numer KSeF ${k}), ${programAccusative(program)}. Faktura w KSeF jest wiążąca — nie da się jej usunąć ani zastąpić. Porównaj dane i zdecyduj, czym jest ten dokument.`,
  PROGRAM_ACCUSATIVE: {
    FAKTFLOW: 'wystawioną w FaktWay',
    OTHER: (x: string) => `wystawioną w programie „${x}”`,
    UNKNOWN: 'wystawioną poza FaktWay',
  },
  PROGRAM_NOMINATIVE: {
    FAKTFLOW: 'wystawiona w FaktWay',
    OTHER: (x: string) => `wystawiona w programie „${x}”`,
    UNKNOWN: 'wystawiona poza FaktWay',
  },
  /** Linia treści: `sameContent` null / true / false. */
  NO_OWN_FILE: 'Treści pozycji nie porównaliśmy — FaktWay nie ma pliku tej próby wysyłki.',
  CONTENT_SAME: 'Treść pozycji jest taka sama jak w fakturze w KSeF — różni się tylko nagłówek pliku.',
  CONTENT_DIFFERENT: 'Treść pozycji różni się od faktury w KSeF.',
  KNOWN_NUMBER_LINE: (k: string, y: string, nr: string) =>
    `W FaktWay numer KSeF ${k} ma już dokument ${y}. Twoja decyzja dotyczy tylko dokumentu ${nr}; jeśli dane dokumentu ${y} nie zgadzają się z fakturą w KSeF, napisz do nas: ${SUPPORT_EMAIL}, podając oba numery.`,
  /** Odnośnik do dokumentu Y (`/invoices/{Y.id}`) — panel, baner, notatka. */
  KNOWN_LINK: DUPLICATE_ORIGINAL_NOTES.KNOWN_LINK,
  COLUMN_KSEF: 'W KSeF',
  COLUMN_OURS: 'Ten dokument',
  DIFFERS: 'różni się',
  ROW_LABELS: {
    number: 'Numer faktury',
    issueDate: 'Data wystawienia',
    buyer: 'Nabywca',
    buyerNip: 'NIP nabywcy',
    gross: 'Kwota brutto',
    program: 'Program',
  },
  BUTTON_SAME: 'To ta sama sprzedaż',
  BUTTON_OTHER: 'To inna sprzedaż',
  SUPPORT: (nr: string) =>
    `Nie wiesz, co wybrać? Napisz do nas: ${SUPPORT_EMAIL}, podając numer ${nr}. Do tego czasu nie wystawiaj tej faktury ponownie.`,

  DIALOG_SAME: {
    TITLE: 'To ta sama sprzedaż?',
    LINE_1: (nrK: string, k: string, program: string | null) =>
      `Fakturą tej sprzedaży zostaje faktura ${nrK} z KSeF (numer KSeF ${k}), ${programNominative(program)} — tam ją rozliczasz i korygujesz.`,
    LINE_1_KNOWN: (nrK: string, k: string, y: string) =>
      `Fakturą tej sprzedaży zostaje faktura ${nrK} z KSeF (numer KSeF ${k}) — w FaktWay ma ją dokument ${y}.`,
    LINE_2: (nr: string) =>
      `Dokument ${nr} w FaktWay zostanie wycofany: zostanie jako szkic, którego nie wyślesz do KSeF ani nie usuniesz.`,
    LINE_3: (k: string) =>
      `FaktWay nie ujmie faktury ${k} w JPK ani w KPiR — jeśli składasz je z FaktWay, uwzględnij ją osobno.`,
    LINE_3_KNOWN: (nr: string, k: string, y: string) =>
      `Dokument ${nr} nie trafi do JPK ani do KPiR w FaktWay. Fakturę ${k} FaktWay zna jako dokument ${y} — sprawdź, czy jego dane zgadzają się z danymi z KSeF w tabeli; jeśli nie, napisz do nas: ${SUPPORT_EMAIL}, podając oba numery.`,
    LINE_4: 'Jeśli to jednak inna sprzedaż, zostanie bez faktury — wystaw ją wtedy jako nową fakturę z nowym numerem.',
    /** Etykieta pola „Rozumiem skutki” (wymaganego, gdy `needsConfirmation.same_sale`, C5), gdy tabela zaznacza różnicę (`markedDifference`). */
    CHECKBOX: (k: string, nr: string) =>
      `Rozumiem skutki: faktura ${k} w KSeF dokumentuje tę samą sprzedaż co dokument ${nr}, mimo różnic zaznaczonych w tabeli.`,
    /** Etykieta tego samego pola bez różnic zaznaczonych w tabeli; pole nadal wymagane — tarcie z danych nieznanych (NIP, kwota, waluta). */
    CHECKBOX_UNCOMPARABLE: (k: string, nr: string) =>
      `Rozumiem skutki: faktura ${k} w KSeF dokumentuje tę samą sprzedaż co dokument ${nr}, choć części danych w tabeli nie da się porównać.`,
    CONFIRM_BUTTON: 'Zapisz: ta sama sprzedaż',
  },
  DIALOG_OTHER: {
    TITLE: 'To inna sprzedaż?',
    LINE_1: (nr: string, k: string) =>
      `Numer ${nr} jest zajęty w KSeF przez fakturę ${k}. Dokument ${nr} w FaktWay zostanie wycofany: zostanie jako szkic, którego nie wyślesz do KSeF ani nie usuniesz.`,
    LINE_2: 'Tę sprzedaż wystawisz jako nową fakturę — z nowym numerem i dzisiejszą datą.',
    LINE_3: 'Jeśli to jednak ta sama sprzedaż, powstaną dwie faktury, a VAT z obu trzeba będzie wykazać, dopóki jednej z nich nie skorygujesz do zera.',
    /** Dopisek do LINE_3 tylko przy `heldCorrections` (KSeF produkcyjny). */
    LINE_3_HELD: ' Korekty do produkcyjnego KSeF są teraz wstrzymane przez FaktWay.',
    /** Program znany (`{X}`). */
    LINE_4: (k: string, x: string) => `FaktWay nie ujmuje faktury ${k} w JPK ani w KPiR — rozliczasz ją w programie „${x}”.`,
    /** Program nieznany (`program` null). */
    LINE_4_UNKNOWN_PROGRAM: (k: string) =>
      `FaktWay nie ujmuje faktury ${k} w JPK ani w KPiR — rozliczasz ją tam, gdzie ją wystawiono.`,
    LINE_4_KNOWN: (k: string, y: string) =>
      `Fakturę ${k} FaktWay zna jako dokument ${y} — sprawdź, czy jego dane zgadzają się z danymi z KSeF w tabeli; jeśli nie, napisz do nas: ${SUPPORT_EMAIL}, podając oba numery.`,
    /** Pole wymagane, gdy `needsConfirmation.other_sale` (C5). */
    CHECKBOX: (k: string, nr: string) => `Rozumiem skutki: faktura ${k} w KSeF dokumentuje inną sprzedaż niż dokument ${nr}.`,
    CONFIRM_BUTTON: 'Zapisz: inna sprzedaż',
  },

  TOAST_SAME: (nr: string) => `Zapisano: ta sama sprzedaż. Dokument ${nr} jest wycofany.`,
  TOAST_OTHER: 'Zapisano: inna sprzedaż. Wystaw ją jako nową fakturę z nowym numerem.',

  // Odmowy w panelu i w akcji klienta (pozostałe — teksty SQL wypełnione numerem).
  ROLE: 'Decyzję, czym jest ten dokument, zapisuje właściciel lub administrator firmy — poproś go o to. Nie wystawiaj tej faktury ponownie.',
  ENV_UNKNOWN: KSEF_SEND_MESSAGES.envUnknown,
  STALE: 'Dane faktury w KSeF zmieniły się od otwarcia strony — odśwież stronę i zdecyduj jeszcze raz.',
  CONFIRM: 'Zaznacz „Rozumiem skutki” i zapisz decyzję jeszcze raz.',
  GENERIC: `Nie udało się zapisać decyzji. Spróbuj ponownie za chwilę; jeśli błąd się powtarza, napisz do nas: ${SUPPORT_EMAIL}.`,

  /** Notatki karty (`describeDuplicateOriginal`, `duplicate-check.ts`). */
  NOTES: DUPLICATE_ORIGINAL_NOTES,

  /** Pasek pod kartą przy `KSEF_DUPLICATE_RECONCILE` (`ksef-send-policy.ts`). */
  BAR_DUPLICATE_PANEL: KSEF_SEND_MESSAGES.duplicatePanel,
  BAR_DUPLICATE: KSEF_SEND_MESSAGES.duplicate,

  /** „Numer zajęty” (`KSEF_NUMBER_TAKEN`): pasek i toasty po „Wróć do szkicu” (`ksef-send-policy.ts`, C4). */
  NUMBER_TAKEN: {
    BAR: KSEF_SEND_MESSAGES.numberTaken,
    RESET_DONE_REGULAR: KSEF_SEND_MESSAGES.numberTakenResetDone,
    RESET_DONE_ADVANCE: S.numberTakenResetDone('advance'),
    RESET_DONE_CORRECTION: S.numberTakenResetDoneDeletable('correction'),
    RESET_DONE_CORRECTION_HELD: S.numberTakenResetDoneDeletableHeld('correction'),
    RESET_DONE_FINAL: S.numberTakenResetDoneDeletable('final'),
    RESET_DONE_FINAL_HELD: S.numberTakenResetDoneDeletableHeld('final'),
  },
  /** `last_error` „numer zajęty” (`numberTakenMessage`); `{opis}` — numer KSeF, data, nabywca, kwota oryginału. */
  NUMBER_TAKEN_LAST_ERROR: (nr: string, opis: string, x: string) =>
    `W KSeF jest już faktura Twojej firmy o numerze ${nr} (${opis}), wystawiona w programie „${x}”. Tego dokumentu nie wyślesz do KSeF. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie (zmiany: korekta tamtej faktury). Jeśli to inna sprzedaż — wystaw ją jako nową fakturę z nowym numerem.`,
  NUMBER_TAKEN_LAST_ERROR_UNKNOWN_PROGRAM: (nr: string, opis: string) =>
    `W KSeF jest już faktura Twojej firmy o numerze ${nr} (${opis}), wystawiona poza FaktWay. Tego dokumentu nie wyślesz do KSeF. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie (zmiany: korekta tamtej faktury). Jeśli to inna sprzedaż — wystaw ją jako nową fakturę z nowym numerem.`,
  /** `last_error` werdyktu `known-number` (`knownNumberVerdictMessage`, C16): oryginał nie może być naszą wysyłką. */
  KNOWN_NUMBER_LAST_ERROR: (k: string, y: string) =>
    `KSeF ma już fakturę o tym numerze (numer KSeF ${k}), a w FaktWay ten numer KSeF ma dokument ${y} — do rozstrzygnięcia na karcie faktury (ta sama czy inna sprzedaż); nie wystawiaj jej ponownie.`,
  /** To samo, gdy oryginał może być wcześniejszą wysyłką tego dokumentu (`ownHistory`) — klient nie decyduje. */
  KNOWN_NUMBER_LAST_ERROR_OWN: (k: string, y: string) =>
    `KSeF ma już fakturę o tym numerze (numer KSeF ${k}), a w FaktWay ten numer KSeF ma dokument ${y}; faktura w KSeF może być wcześniejszą wysyłką tego dokumentu z FaktWay — wyjaśnia to pomoc FaktWay; nie wystawiaj jej ponownie.`,

  // Baner szkicu wycofanego — każdy rodzaj (decyzja 9). `{data}` = formatWarsawDateTime(decision.at).
  BANNER_TITLE: (nr: string) => `Dokument wycofany — numer ${nr} jest zajęty w KSeF`,
  /** `{via}` przy decyzji zapisanej przez operatora. */
  BANNER_VIA_OPERATOR: ' (zapisała pomoc FaktWay na Twoją prośbę)',
  BANNER_SAME: (data: string, via: string, nrK: string, k: string, program: string | null) =>
    `Zapisano ${data}${via}: to ta sama sprzedaż co faktura ${nrK} w KSeF (numer KSeF ${k}), ${programNominative(program)}. Tam ją rozliczasz i korygujesz; FaktWay nie ujmuje jej w JPK ani w KPiR. Tego dokumentu nie wyślesz do KSeF. Jeśli to jednak inna sprzedaż, wystaw ją jako nową fakturę z nowym numerem.`,
  BANNER_SAME_KNOWN: (data: string, via: string, nrK: string, k: string, y: string) =>
    `Zapisano ${data}${via}: to ta sama sprzedaż co faktura ${nrK} w KSeF (numer KSeF ${k}), którą w FaktWay ma dokument ${y}. Tego dokumentu nie wyślesz do KSeF. Jeśli to jednak inna sprzedaż, wystaw ją jako nową fakturę z nowym numerem.`,
  BANNER_OTHER: (data: string, via: string, k: string, nr: string) =>
    `Zapisano ${data}${via}: to inna sprzedaż niż faktura ${k} w KSeF. Wystaw ją jako nową fakturę — z nowym numerem i dzisiejszą datą. Tego dokumentu nie wyślesz do KSeF ani nie usuniesz; numer ${nr} zostaje przy nim, żeby FaktWay nie podpowiedział go ponownie.`,
  /** Automatyczny „numer zajęty”, zwykła faktura; `k` null — bez „(numer KSeF …)”. */
  BANNER_AUTO: (nr: string, k: string | null) =>
    `KSeF ma już fakturę Twojej firmy o numerze ${nr}${ksefNumberPart(k)}, wystawioną poza FaktWay — tego dokumentu nie wyślesz do KSeF ani nie usuniesz; numer zostaje przy nim, żeby FaktWay nie podpowiedział go ponownie. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie (zmiany: korekta tamtej faktury w programie, w którym ją wystawiono). Jeśli inna — wystaw ją jako nową fakturę z nowym numerem.`,
  BANNER_AUTO_ADVANCE: (nr: string, k: string | null) =>
    `KSeF ma już dokument Twojej firmy o numerze ${nr}${ksefNumberPart(k)}, wystawiony poza FaktWay — tej faktury zaliczkowej nie wyślesz do KSeF ani nie usuniesz; numer zostaje przy niej, żeby FaktWay nie podpowiedział go ponownie. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie. Jeśli inna — wystaw nową fakturę zaliczkową z nowym numerem.`,
  /** Korekta i faktura rozliczeniowa: `{G}`/`{A}` — dopełniacz i biernik z `SPECIAL_KIND_LABEL`. */
  BANNER_AUTO_DELETABLE: (nr: string, k: string | null, g: string, a: string) =>
    `KSeF ma już dokument Twojej firmy o numerze ${nr}${ksefNumberPart(k)}, wystawiony poza FaktWay — tego szkicu ${g} nie wyślesz do KSeF. Jeśli w KSeF jest ten sam dokument — nie wystawiaj go ponownie. Jeśli inny — usuń ten szkic („Usuń szkic”) i wystaw ${a} od nowa z nowym numerem.`,
  BANNER_AUTO_DELETABLE_HELD: (nr: string, k: string | null, g: string, a: string) =>
    `KSeF ma już dokument Twojej firmy o numerze ${nr}${ksefNumberPart(k)}, wystawiony poza FaktWay — tego szkicu ${g} nie wyślesz do KSeF. Jeśli w KSeF jest ten sam dokument — nie wystawiaj go ponownie. Jeśli inny — usuń ten szkic („Usuń szkic”), a po zdjęciu blokady wysyłki wystaw ${a} od nowa z nowym numerem.`,
  CTA_REGULAR: { href: '/invoices/new/regular', label: 'Wystaw nową fakturę' },
  CTA_ADVANCE: { href: '/invoices/new/advance', label: 'Wystaw nową fakturę zaliczkową' },

  /** `window.confirm` przy „Usuń szkic” wycofanej korekty albo faktury rozliczeniowej. */
  RETIRED_DELETE_CONFIRM: 'Usunąć wycofany szkic? Numer tego dokumentu jest zajęty w KSeF — nowy dokument wystaw z nowym numerem.',
  /** Odmowa e-maila do nabywcy (decyzja 10). */
  RETIRED_EMAIL_REFUSAL: (nr: string) =>
    `Dokumentu ${nr} nie wyślesz e-mailem: jest wycofany, bo jego numer jest zajęty w KSeF przez inną fakturę, więc nie jest fakturą dla nabywcy. Jeśli to inna sprzedaż, wystaw nową fakturę z nowym numerem i wyślij ją.`,
  /** Odczyt wpisów `number_taken` nieudany (wysyłka, usunięcie, e-mail — fail-closed). */
  HISTORY_READ_FAILED: 'Nie udało się sprawdzić historii wysyłki tej faktury — spróbuj ponownie za chwilę.',

  // Powiadomienie „czeka na Twoją decyzję” (2.11.C): e-mail raz na (faktura, K) i przypomnienie operatora.
  NOTICE: {
    SUBJECT: (nr: string) => `Faktura ${nr} czeka na Twoją decyzję`,
    REMINDER_SUBJECT: (nr: string) => `Przypomnienie: faktura ${nr} czeka na Twoją decyzję`,
    BODY: (nr: string, k: string) =>
      `KSeF nie przyjął faktury ${nr}, bo ma już fakturę Twojej firmy o tym numerze (numer KSeF ${k}). Otwórz fakturę w FaktWay, porównaj dane i zdecyduj, czy to ta sama sprzedaż, czy inna. Do tego czasu nie wystawiaj jej ponownie. Pytania: ${SUPPORT_EMAIL}.`,
    BUTTON: 'Otwórz fakturę',
    PUSH_TITLE: (nr: string) => `Faktura ${nr} czeka na Twoją decyzję`,
    PUSH_BODY: 'KSeF ma już fakturę o tym numerze — porównaj dane i zdecyduj.',
  },

  // ── PR C (00156): oryginał z oznaczeniem FaktWay (`faktflow-original`) — spec v3 6.2, słowo w słowo;
  // lista prawnika przed KSeF PROD (6.7). Znaczniki: `{nr}` dokument, `{k}` numer KSeF oryginału,
  // `{nrK}` numer faktury z KSeF (`summary.number ?? nr`), `{nrOld}` dawny numer wycofanego dokumentu,
  // `{okres}` = `preview.period`, `{dzien}` = `originalAssignedDay`, `{data}` = formatWarsawDateTime(decision.at),
  // `{via}` = `BANNER_VIA_OPERATOR` przy operatorze. Teksty PR B używane bez zmian — 6.2, akapit końcowy.
  FAKTFLOW: {
    // Panel — para
    INTRO_PAIR: (nr: string, k: string) =>
      `KSeF nie przyjął dokumentu ${nr}, bo ma już fakturę Twojej firmy o tym numerze (numer KSeF ${k}) z oznaczeniem FaktWay. Faktura w KSeF jest wiążąca — nie da się jej usunąć ani zastąpić. Porównaj dane i zdecyduj, czym jest ten dokument.`,
    NOT_RECORDED: 'W FaktWay nie ma zapisu tej faktury — najpewniej jej dokument usunięto, zanim FaktWay zapisał potwierdzenie z KSeF.',
    LEDGER: (k: string, okres: string) =>
      `Do czasu decyzji FaktWay nie ujmuje faktury ${k} w JPK ani w KPiR — nie składaj z FaktWay JPK_V7 za ${okres}, dopóki jej nie zapiszesz. Po decyzji zapiszemy ją w FaktWay z danymi z KSeF i trafi do JPK i KPiR za ${okres}.`,
    // Panel — jeden przycisk
    INTRO_RECORD_OWN: (nr: string, k: string, dzien: string | null, nrK: string) =>
      `W KSeF jest wcześniejsza wersja dokumentu ${nr}, wysłana z FaktWay (numer KSeF ${k}${dzien ? `, numer nadany ${dzien}` : ''}). To ona jest wystawioną fakturą i obowiązują jej dane — faktury w KSeF nie da się usunąć ani zastąpić. Zapiszemy ją w FaktWay jako fakturę ${nrK}, a ten dokument wycofamy bez numeru; zmiany wprowadzisz korektą faktury ${nrK}.`,
    INTRO_RECORD_SAME: (nr: string, k: string, dzien: string | null) =>
      `W KSeF jest już faktura ${nr} z oznaczeniem FaktWay (numer KSeF ${k}${dzien ? `, numer nadany ${dzien}` : ''}) o tej samej treści co ten dokument — różni się tylko nagłówek pliku. Najpewniej to wcześniejsza wysyłka, której wyniku FaktWay nie zapisał.`,
    ROW_SALE_DATE: 'Data sprzedaży',
    ANNOTATIONS: (lista: string) => `Oznaczenia faktury w KSeF: ${lista}.`,
    ANNOTATION_LABELS: {
      cashMethod: 'metoda kasowa',
      splitPayment: 'mechanizm podzielonej płatności',
      reverseCharge: 'odwrotne obciążenie',
      exemption: (podstawa: string) => `zwolnienie z VAT (${podstawa})`,
    },
    LINES_TOGGLE: (n: number) => `Pozycje faktury w KSeF (${n})`,
    LINES_MORE: (m: number) => `…i jeszcze ${m} — pełną treść ma plik faktury w KSeF.`,
    LINES_COLUMNS: { name: 'Nazwa', quantity: 'Ilość', unitPriceNet: 'Cena netto', vatRate: 'Stawka VAT', gross: 'Brutto' },
    BUTTON_RECORD: 'Zapisz fakturę z KSeF w FaktWay',
    // Dialogi
    DIALOG_SAME: {
      LINE_1: (nrK: string, k: string, okres: string) =>
        `Fakturą tej sprzedaży jest faktura ${nrK} z KSeF (numer KSeF ${k}). Zapiszemy ją w FaktWay z danymi z KSeF — trafi do JPK i KPiR za ${okres}; w FaktWay ją rozliczasz i korygujesz.`,
      LINE_2: (nr: string) =>
        `Dokument ${nr} wycofamy: zostanie w FaktWay jako szkic bez numeru, którego nie wyślesz do KSeF ani nie usuniesz. Numer ${nr} przejdzie na fakturę z KSeF.`,
    },
    DIALOG_OTHER: {
      LINE_1: (nrK: string, k: string, okres: string) =>
        `Faktura ${nrK} z KSeF (numer KSeF ${k}) dokumentuje inną sprzedaż i jest wystawiona — obowiązuje, bo jest w KSeF. Zapiszemy ją w FaktWay z danymi z KSeF — trafi do JPK i KPiR za ${okres}.`,
      LINE_2: (nr: string) =>
        `Dokument ${nr} wycofamy: zostanie w FaktWay jako szkic bez numeru, którego nie wyślesz do KSeF ani nie usuniesz. Sprzedaż z tego dokumentu wystawisz jako nową fakturę — z nowym numerem i dzisiejszą datą.`,
      ALREADY_REISSUED: 'Jeśli sprzedaż z tego dokumentu jest już wystawiona ponownie pod innym numerem, nie wystawiaj kolejnej faktury.',
      ZERO: (nrK: string) => `Jeśli sprzedaż z faktury ${nrK} nie doszła do skutku, fakturę ${nrK} trzeba skorygować do zera.`,
    },
    DIALOG_RECORD: {
      TITLE: (nrK: string) => `Zapisać fakturę ${nrK} z KSeF w FaktWay?`,
      LINE_1: (nrK: string, okres: string) =>
        `Zapiszemy w FaktWay fakturę ${nrK} z danymi z KSeF — trafi do JPK i KPiR za ${okres}. To ona jest fakturą tej sprzedaży.`,
      LINE_2: (nr: string) =>
        `Dokument ${nr} wycofamy: zostanie w FaktWay jako szkic bez numeru, którego nie wyślesz do KSeF ani nie usuniesz. Numer ${nr} przejdzie na fakturę z KSeF.`,
      LINE_DIFF: (nrK: string) => `Dane z KSeF różnią się od tego dokumentu. Obowiązują dane z KSeF — zmienisz je tylko korektą faktury ${nrK}.`,
      CHECKBOX: (k: string, nr: string) => `Rozumiem skutki: obowiązują dane faktury ${k} z KSeF, nie dane dokumentu ${nr}.`,
      CONFIRM_BUTTON: 'Zapisz fakturę z KSeF',
    },
    REISSUED: 'Jeśli sprzedaż z tego dokumentu jest już wystawiona ponownie pod innym numerem, są teraz dwie faktury tej samej sprzedaży — fakturę wystawioną ponownie trzeba skorygować do zera.',
    CORRECTION_PERSON: ` Korekty faktury dla nabywcy bez NIP i bez numeru VAT-UE FaktWay jeszcze nie wystawia — jeśli trzeba ją skorygować, napisz do nas: ${SUPPORT_EMAIL}.`,
    // D-A4-1b-3-KORZW: pozycja zw (do C3), stawka FA(3) spoza FaktWay albo pozycja bez ceny netto. Krótko, bez długiego myślnika.
    CORRECTION_RATE: (nrK: string) =>
      ` Korekt faktury ${nrK} z pozycją o stawce zwolnionej, o stawce spoza FaktWay albo bez ceny netto jeszcze nie wystawiamy. Jeśli trzeba coś w niej zmienić, napisz do nas: ${SUPPORT_EMAIL}.`,
    SALE_DATE_AS_ISSUE: 'jak data wystawienia',
    DATA_FROM_KSEF: (nrK: string) => `Obowiązują dane z KSeF. Jeśli trzeba je zmienić, wystaw korektę faktury ${nrK}.`,
    HELD_CORRECTIONS: ` Korekty do produkcyjnego KSeF są teraz wstrzymane przez FaktWay — napisz do nas: ${SUPPORT_EMAIL}.`,
    BUYER_DIFFERS: (nrK: string) =>
      `Nabywca w KSeF jest inny niż w tym dokumencie. Jeśli tę sprzedaż dostał inny nabywca, fakturę ${nrK} trzeba skorygować do zera, a sprzedaż wystawić jako nową fakturę z nowym numerem.`,
    PAST_PERIOD: (okres: string) =>
      `Jeśli JPK_V7 za ${okres} jest już złożony albo KPiR za ten miesiąc zamknięta bez tej faktury, sprawdź z księgową, czy trzeba je skorygować.`,
    TOAST_SAME: (nrK: string) => `Zapisano: ta sama sprzedaż. Faktura ${nrK} z KSeF jest w FaktWay.`,
    TOAST_OTHER: (nrK: string) => `Zapisano: inna sprzedaż. Faktura ${nrK} z KSeF jest w FaktWay — sprzedaż z wycofanego dokumentu wystaw jako nową fakturę z nowym numerem, jeśli nie jest już wystawiona.`,
    TOAST_RECORD: (nrK: string) => `Zapisano fakturę ${nrK} z KSeF w FaktWay.`,
    // Po oddaniu przez operatora (FO-ODDANA)
    RELEASED_NOTE: 'Plik tej faktury w KSeF ma oznaczenie FaktWay, ale sprawdziliśmy go: nie powstał w FaktWay. Rozstrzygnij ją jak fakturę z innego programu — FaktWay jej nie zapisze.',
    PROGRAM_RELEASED: 'oznaczenie FaktWay — plik nie powstał w FaktWay',
    // Odmowy w akcji i na stronie
    // Odmowa w chwili zapisu (archiwum, inna ocena pliku, niezgodność projekcji) — zawsze ze znacznikiem recheckNeeded (INV-25)
    RECHECK: (nr: string) =>
      `Fakturę z KSeF dla dokumentu ${nr} musimy sprawdzić jeszcze raz — tej decyzji nie zapiszesz teraz. Sprawdzimy ją automatycznie, zwykle w ciągu 2 dni; potem decyzję zapiszesz na karcie dokumentu. Nie wystawiaj go ponownie; jeśli ten komunikat zostanie dłużej, napisz do nas: ${SUPPORT_EMAIL}.`,
    READ_FAILED: (nr: string) =>
      `Nie udało się teraz sprawdzić faktury z KSeF dla dokumentu ${nr} — odśwież stronę za chwilę. Nie wystawiaj go ponownie.`,
    // Szkic wycofany po zapisie (karta X)
    BANNER_TITLE: (nrOld: string) => `Dokument wycofany — numer ${nrOld} ma teraz faktura z KSeF`,
    BANNER_SAME: (data: string, via: string, nrK: string, k: string) =>
      `Zapisano ${data}${via}: to ta sama sprzedaż co faktura ${nrK} z KSeF (numer KSeF ${k}). Zapisaliśmy ją w FaktWay — przy niej zapisujesz wpłaty i wystawiasz korekty. Tego dokumentu nie wyślesz do KSeF ani nie usuniesz. Jeśli sprzedaż z tego dokumentu jest jednak inna, wystaw ją jako nową fakturę z nowym numerem — chyba że jest już wystawiona.`,
    BANNER_OTHER: (data: string, via: string, nrK: string, k: string) =>
      `Zapisano ${data}${via}: to inna sprzedaż niż faktura ${nrK} z KSeF (numer KSeF ${k}) — zapisaliśmy ją w FaktWay jako osobną fakturę. Sprzedaż z tego dokumentu wystaw jako nową fakturę — z nowym numerem i dzisiejszą datą; jeśli jest już wystawiona ponownie pod innym numerem, nie wystawiaj kolejnej. Tego dokumentu nie wyślesz do KSeF ani nie usuniesz. Jeśli to jednak ta sama sprzedaż: nie wystawiaj nowej faktury — fakturą tej sprzedaży jest faktura ${nrK}; jeśli nową już wystawiono, trzeba ją skorygować do zera.`,
    BANNER_RECORD: (data: string, via: string, nrK: string, k: string) =>
      `Zapisano ${data}${via}: fakturą tej sprzedaży jest faktura ${nrK} z KSeF (numer KSeF ${k}), zapisana w FaktWay — przy niej zapisujesz wpłaty i wystawiasz korekty. Tego dokumentu nie wyślesz do KSeF ani nie usuniesz. Jeśli sprzedaż z tego dokumentu jest jednak inna, wystaw ją jako nową fakturę z nowym numerem — chyba że jest już wystawiona.`,
    IMPORTED_LINK: (nrK: string) => `Zobacz fakturę ${nrK}`,
    RETIRED_DOCUMENT_REFUSAL: (nrOld: string) =>
      `Wycofany dokument (dawniej ${nrOld}) nie jest fakturą — numer ${nrOld} ma teraz faktura z KSeF zapisana w FaktWay. Nie pobierzesz PDF tego dokumentu ani nie wyślesz go e-mailem; pobierz PDF faktury ${nrOld}.`,
    RETIRED_PDF_LINK: (nrOld: string) => `Pobierz PDF faktury ${nrOld}`,
    // Karta faktury z KSeF (K)
    IMPORTED_CARD: (data: string, via: string, nrOld: string, wybor: string) =>
      `Faktura zapisana z KSeF ${data}${via}: KSeF nie przyjął dokumentu ${nrOld} z FaktWay, bo miał już fakturę o tym numerze (${wybor}).`,
    IMPORTED_CARD_CHOICE: { same_sale: 'ta sama sprzedaż', other_sale: 'inna sprzedaż', record: 'zapis faktury z KSeF' },
    IMPORTED_CARD_RETIRED_LINK: 'Zobacz wycofany dokument',
    IMPORTED_CARD_REMINDERS: 'Przypomnienia o płatności nie obejmują faktur zapisanych z KSeF.',
    IMPORTED_CARD_PAYMENTS: 'Jeśli nabywca już zapłacił za tę fakturę, zapisz wpłatę przy niej.',
    // Powiadomienia
    NOTICE_BODY_RECORD: (nr: string, k: string) =>
      `KSeF nie przyjął faktury ${nr}, bo ma już jej wersję z oznaczeniem FaktWay (numer KSeF ${k}). Otwórz fakturę w FaktWay i zapisz fakturę z KSeF — do tego czasu nie trafi ona do JPK ani KPiR. Nie wystawiaj jej ponownie. Pytania: ${SUPPORT_EMAIL}.`,
    NOTICE_PUSH_BODY_RECORD: 'KSeF ma już tę fakturę z oznaczeniem FaktWay — zapisz ją w FaktWay.',
    NOTICE_BODY_RELEASED: (nr: string, k: string) =>
      `Sprawdziliśmy fakturę z KSeF (numer KSeF ${k}), przez którą KSeF nie przyjął dokumentu ${nr}: ma oznaczenie FaktWay, ale nie powstała w FaktWay. Otwórz dokument w FaktWay, porównaj dane i zdecyduj, czy to ta sama sprzedaż, czy inna — FaktWay tej faktury nie zapisze. Do tego czasu nie wystawiaj dokumentu ponownie. Pytania: ${SUPPORT_EMAIL}.`,
    NOTICE_REVIEW_SUBJECT: (nr: string) => `Faktura ${nr}: sprawdzamy fakturę z KSeF`,
    NOTICE_BODY_REVIEW: (nr: string, k: string) =>
      `KSeF nie przyjął faktury ${nr}, bo ma już fakturę Twojej firmy o tym numerze (numer KSeF ${k}). Sprawdzamy fakturę z KSeF — nie wystawiaj jej ponownie, damy znać. Pytania: ${SUPPORT_EMAIL}.`,
    NOTICE_PUSH_TITLE_REVIEW: (nr: string) => `Faktura ${nr}: sprawdzamy fakturę z KSeF`,
    NOTICE_PUSH_BODY_REVIEW: 'Nie wystawiaj jej ponownie — damy znać.',
    // last_error werdyktu (runner, 5.1)
    LAST_ERROR: (k: string) =>
      `KSeF ma już fakturę o tym numerze z oznaczeniem FaktWay (numer KSeF ${k}) — szczegóły są na karcie faktury; nie wystawiaj jej ponownie.`,
    LAST_ERROR_REVIEW: (k: string) =>
      `KSeF ma już fakturę o tym numerze z oznaczeniem FaktWay (numer KSeF ${k}). Sprawdzamy fakturę z KSeF — nie wystawiaj jej ponownie, damy znać.`,
  },

  /**
   * D-A4-1b-3 PR D: „Sprawdź ponownie” przy braku danych oryginału (pobranie, magazyn, archiwum, brak zapisu
   * sprawdzenia, inne środowisko KSeF). Lista prawnika (plan zero zgubionych faktur, sekcja 8). Nowe teksty
   * bez długich myślników; adres pomocy tylko przez `SUPPORT_EMAIL`. `{nr}` numer dokumentu, `{k}` numer KSeF
   * oryginału, `{dzien}` dzień nadania numeru (RRRR-MM-DD, może brakować), `{minuty}` minuty do końca cooldownu.
   */
  RECHECK: {
    BUTTON: 'Sprawdź ponownie',
    NO_REISSUE: 'Nie wystawiaj tej faktury ponownie.',
    INTRO: (nr: string, k: string, dzien: string | null) =>
      `KSeF ma już fakturę Twojej firmy o numerze dokumentu ${nr} (numer KSeF ${k}${dzien ? `, numer nadany ${dzien}` : ''}). Nie mamy jeszcze jej treści, więc nie możesz teraz zdecydować, czym jest ten dokument.`,
    /** Co robi przycisk; tylko tam, gdzie przycisk jest. */
    WHAT_NEXT:
      'Wybierz „Sprawdź ponownie”: pobierzemy tę fakturę z KSeF jeszcze raz, a wynik zobaczysz na tej karcie. Robimy to także automatycznie, zwykle w ciągu 2 dni.',
    /**
     * Odmowa pobrania 403: dane logowania KSeF w FaktWay bez uprawnienia do odczytu faktur. Klient łączy FaktWay
     * z KSeF certyfikatem (tokenu nie ma gdzie nadać), więc rada jak w nocie PR B (`describeDuplicateOriginal`).
     */
    HINT_403:
      'Dane logowania KSeF w FaktWay nie mają uprawnienia do odczytu faktur (InvoiceRead). Sprawdź uprawnienia w Aplikacji Podatnika KSeF albo podłącz KSeF ponownie w Ustawieniach → KSeF, a potem wybierz „Sprawdź ponownie”.',
    /** Inne środowisko niż obecne: dane oryginału sprawdziliśmy gdzie indziej. */
    ENV_MISMATCH:
      'Dane oryginału pochodzą z innego środowiska KSeF niż to, w którym FaktWay pracuje teraz. Sprawdź ponownie, żeby pobrać fakturę z obecnego środowiska.',
    ROLE:
      'Ponowne sprawdzenie w KSeF uruchamia właściciel lub administrator firmy. Poproś właściciela lub administratora firmy o kliknięcie „Sprawdź ponownie”. Nie wystawiaj tej faktury ponownie.',
    IN_FLIGHT: (nr: string) => `Sprawdzamy ponownie w KSeF dokument ${nr}. Odśwież stronę za kilka minut.`,
    COOLDOWN: (nr: string, minuty: number) =>
      `Dokument ${nr} sprawdziliśmy w KSeF przed chwilą. Kolejne sprawdzenie możesz uruchomić za ${minuty} min. Nie wystawiaj go ponownie.`,
    QUEUED: (nr: string) => `Sprawdzamy dokument ${nr} ponownie w KSeF. Odśwież stronę za kilka minut.`,
    NOT_AVAILABLE: (nr: string) =>
      `Dokumentu ${nr} nie sprawdzimy ponownie z tego miejsca. Odśwież stronę; jeśli komunikat wraca, napisz do nas: ${SUPPORT_EMAIL}, podając numer dokumentu. Nie wystawiaj go ponownie.`,
    CANNOT: (nr: string) =>
      `Dokumentu ${nr} nie możemy teraz sprawdzić ponownie z tego miejsca. Napisz do nas: ${SUPPORT_EMAIL}, podając numer dokumentu. Nie wystawiaj go ponownie.`,
    PAUSED: (nr: string) =>
      `Wysyłka do KSeF jest chwilowo wstrzymana przez FaktWay, więc dokumentu ${nr} nie sprawdziliśmy ponownie. Spróbuj ponownie, gdy wysyłka zostanie przywrócona. Nie wystawiaj go ponownie.`,
    PAUSE_UNKNOWN: (nr: string) =>
      `Nie możemy sprawdzić, czy KSeF jest teraz dostępny, więc dokumentu ${nr} nie sprawdziliśmy ponownie. Spróbuj ponownie za chwilę. Nie wystawiaj go ponownie.`,
    /** `KSEF_ENV` nieustawione albo niepoprawne: o sprawdzaniu (nie o wysyłce), z numerem dokumentu (D4). */
    ENV_UNKNOWN: (nr: string) =>
      `Nie możemy teraz potwierdzić środowiska KSeF po stronie FaktWay, więc dokumentu ${nr} nie sprawdziliśmy ponownie. Odśwież stronę za kilka minut; jeśli komunikat się powtarza, napisz do nas: ${SUPPORT_EMAIL}, podając numer dokumentu. Nie wystawiaj go ponownie.`,
    NO_CERTIFICATE: (nr: string) =>
      `Brak certyfikatu KSeF: dokumentu ${nr} nie sprawdziliśmy ponownie. Wgraj certyfikat w Ustawieniach KSeF i spróbuj jeszcze raz. Nie wystawiaj go ponownie.`,
    /** Odmowa kolejki, której tekst nie nazywa dokumentu: numer z przodu. */
    REFUSED: (nr: string, powod: string) => `Dokumentu ${nr} nie sprawdziliśmy ponownie. ${powod}`,
    GENERIC: `Nie udało się uruchomić ponownego sprawdzenia. Spróbuj ponownie za chwilę; jeśli błąd się powtarza, napisz do nas: ${SUPPORT_EMAIL}.`,
  },
} as const;

// ─── Polityka jsonb (lustro `ksef_duplicate_check_allows`, 2.1.1; 00156 4.2) ──

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasKey = (v: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(v, key);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * `->>` z SQL dla skalara jsonb: napis bez zmian (także pusty), liczba i wartość
 * logiczna jako tekst; `null`, brak klucza, obiekt i tablica — `null` (tych
 * kluczy RPC nigdy nie zapisuje jako obiektów).
 */
const jsonText = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
};

/** `archivePath` oryginału: `<firma (36 znaków)>/ksef-import/<numer KSeF>.xml` (4.2). */
const FAKTFLOW_ARCHIVE_PATH = /^[0-9a-f-]{36}\/ksef-import\/[A-Za-z0-9-]{1,64}\.xml$/;
/** Przyszła postać `<SystemInfo>` plików z naszego generatora (D-A4-1b-3-SYS) — wzorzec dosłownie jak w funkcji bazy 00156, w nazwie sprzed zmiany marki. */
const FAKTFLOW_SYSTEM_INFO_NEXT = /^FaktFlow [0-9]/;
/** `sizeBytes` jako tekst jsonb: liczba całkowita dodatnia, najwyżej 10 cyfr (potem ≤ int4). */
const SIZE_BYTES_TEXT = /^[1-9][0-9]{0,9}$/;

/** `SystemInfo` pliku z naszego generatora — dziś `KSeF SaaS v1.0`, w przyszłości `<nazwa> <wersja>` (wzorzec wyżej). */
const isFaktflowSystemInfo = (v: unknown): boolean =>
  typeof v === 'string' && (v === FAKTFLOW_SYSTEM_INFO || FAKTFLOW_SYSTEM_INFO_NEXT.test(v));

/**
 * Gałąź `faktflow-original` z 4.2 (00156): `ownHistory` logiczne, treść
 * logiczna / `null` / brak klucza, SystemInfo FaktWay, `archivePath`
 * i `sizeBytes` oryginału; `other_sale` tylko przy `ownHistory = false`
 * i treści różnej od `true` (część JSON reguły „tylko zapis” — część z bazy
 * rozstrzyga oferta, 4.4). `importGate` NIE wchodzi do `allows`.
 */
function faktflowCheckAllows(raw: Record<string, unknown>, summary: Record<string, unknown>, choice: DuplicateChoice | null): boolean {
  if (typeof raw.ownHistory !== 'boolean') return false;
  const content = raw.sameContentExceptHeader;
  if (content !== undefined && content !== null && typeof content !== 'boolean') return false;
  if (!isFaktflowSystemInfo(summary.systemInfo)) return false;
  if (typeof raw.archivePath !== 'string' || !FAKTFLOW_ARCHIVE_PATH.test(raw.archivePath)) return false;
  // CASE w SQL: rzut na bigint dopiero po sprawdzeniu tekstu liczby.
  if (typeof raw.sizeBytes !== 'number' || !SIZE_BYTES_TEXT.test(String(raw.sizeBytes)) || raw.sizeBytes > 2147483647) {
    return false;
  }
  return choice !== 'other_sale' || (raw.ownHistory === false && content !== true);
}

/**
 * Czy zapis sprawdzenia oryginału pozwala na decyzję klienta — na SUROWYM jsonb,
 * tak jak SQL (typy sprawdzane jawnie: `v:"1"`, liczbowe `knownInvoice.id`
 * odmawiają). `choice` null = dowolny wybór. `recheck` nie blokuje: dane
 * z wcześniejszego udanego sprawdzenia są ważne (faktura w KSeF się nie zmienia).
 * PR C (00156, 4.2): powód `faktflow-original` z własną gałęzią
 * (`faktflowCheckAllows`); gałąź powodów PR B bez zmian (INV-14).
 */
export function duplicateCheckAllows(raw: unknown, choice: DuplicateChoice | null): boolean {
  if (!isRecord(raw) || raw.v !== 1) return false;
  if (hasKey(raw, 'decision')) return false;
  if (choice !== null && choice !== 'same_sale' && choice !== 'other_sale') return false;
  if (raw.reason !== 'no-own-file' && raw.reason !== 'known-number' && raw.reason !== 'faktflow-original') return false;
  if (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(raw.sha256)) return false;
  if (!isRecord(raw.summary)) return false;
  if (raw.reason === 'faktflow-original') return faktflowCheckAllows(raw, raw.summary, choice);
  // NULL (nie wiadomo) odmawia; true = oryginał może być nasz.
  if (raw.ownHistory !== false) return false;
  if (raw.reason === 'known-number') {
    return isRecord(raw.knownInvoice) && typeof raw.knownInvoice.id === 'string' && raw.knownInvoice.id !== '';
  }
  return true;
}

// ─── PR C (00156): lustra oferty, bramy i znacznika „sprawdź ponownie” ───────

/**
 * Lustro kroku 11c blokady (`recheck-needed`, 4.5) na surowym jsonb znacznika
 * `faktflow-original`: `!originalGateOk(check.importGate) || check ? 'recheckNeeded'`.
 * Liczy się OBECNOŚĆ klucza `recheckNeeded` (M4: `recheckNeeded: null` też),
 * jak operator `?` w SQL. TS liczy go sam z JSON (R-C16 porównuje z SQL).
 */
export function originalRecheckNeeded(check: unknown): boolean {
  const gate = isRecord(check) ? check.importGate : undefined;
  return !originalGateOk(gate) || (isRecord(check) && hasKey(check, 'recheckNeeded'));
}

/**
 * Lustro `ksef_duplicate_own_history` (4.3) — predykat kroku 12 z 00148:
 * któraś próba faktury ma sesję oryginału (`marker.original_session_reference_number`)
 * albo `lower(request_payload_hash)` = SHA-256 oryginału (`marker.original_check.sha256`).
 * Brak sesji albo skrótu na znaczniku nie dopasowuje prób (NULL ≠ NULL).
 */
export function ownHistoryInSubmissions(
  submissions: ReadonlyArray<Pick<DuplicateDecisionSubmissionRow, 'session_reference_number' | 'request_payload_hash'>>,
  marker: Pick<DuplicateDecisionSubmissionRow, 'original_session_reference_number' | 'original_check'>,
): boolean {
  const session = marker.original_session_reference_number;
  const sha256 = isRecord(marker.original_check) ? jsonText(marker.original_check.sha256) : null;
  return submissions.some((s) =>
    (session != null && s.session_reference_number === session)
    || (sha256 !== null && s.request_payload_hash != null && s.request_payload_hash.toLowerCase() === sha256));
}

/**
 * Lustro `ksef_duplicate_original_offer` (4.4) — JEDNA funkcja oferty dla
 * panelu, powiadomień i operatora. `null` poza `faktflow-original` albo gdy
 * `duplicateCheckAllows(check, null)` odmawia. `ownHistoryDb` `null` =
 * nieznane = tylko zapis (fail-closed). Porównania `=== true` (NULL w
 * `sameContentExceptHeader` nie daje `record`).
 */
export function duplicateOriginalOffer(check: unknown, ownHistoryDb: boolean | null): DuplicateOriginalOffer | null {
  // 1. tylko faktflow-original, które przechodzi allows
  if (!isRecord(check) || check.reason !== 'faktflow-original' || !duplicateCheckAllows(check, null)) return null;
  // 2. „tylko zapis”: własna historia w JSON albo w bazie, ta sama treść; nieznana historia z bazy = tak
  const recordOnly = check.ownHistory === true || check.sameContentExceptHeader === true || (ownHistoryDb ?? true);
  // 3. brama
  const gate = check.importGate;
  const gateOk = originalGateOk(gate);
  const gateObj = isRecord(gate) ? gate : null;
  // 4. poprawna brama importable — zapis oryginału
  if (gateOk && gateObj?.kind === 'importable') return recordOnly ? 'record' : 'pair';
  // 5. poprawna brama review z oddaniem decyzji przez operatora i bez „tylko zapis”
  const release = gateObj && isRecord(gateObj.release) ? gateObj.release : null;
  if (gateOk && !recordOnly && release && typeof release.at === 'string' && release.via === 'operator') return 'released';
  // 6. review, brak bramy albo zły kształt — przegląd operatora
  return recordOnly ? 'review-record' : 'review-pair';
}

/**
 * Wariant e-maila, pusha i przypomnienia operatora (5.5, INV-24): `review` przy
 * blokadzie `provenance-review`; przy blokadzie NULL — `record` / `released` /
 * `pair` z `duplicateOriginalOffer` (powody PR B → `pair`); inna blokada →
 * `null`. `ownHistoryDb` bez `null` — wołający liczy historię
 * (`ownHistoryInSubmissions`) z tych samych kolumn co panel.
 */
export function duplicateNoticeVariant(check: unknown, ownHistoryDb: boolean, blocker: string | null): DuplicateNoticeVariant | null {
  if (blocker === 'provenance-review') return 'review';
  if (blocker !== null) return null;
  const offer = duplicateOriginalOffer(check, ownHistoryDb);
  if (offer === 'record' || offer === 'released' || offer === 'pair') return offer;
  // Przegląd przy blokadzie NULL (wyścig odczytów) — nigdy „czeka na Twoją decyzję”.
  if (offer !== null) return 'review';
  // Powody PR B (no-own-file, known-number) — powiadomienie PR B.
  return duplicateCheckAllows(check, null) ? 'pair' : null;
}

/** Etykieta decyzji (karta K, `ALREADY_IMPORTED`, toasty): oferta `record`/`review-record` → `record`, inaczej wybór. */
export function decisionLabel(offer: DuplicateOriginalOffer | null | undefined, choice: DuplicateChoice): DuplicateDecisionLabel {
  return offer === 'record' || offer === 'review-record' ? 'record' : choice;
}

/**
 * Pochodzenie faktury K (`fa3_data.import`, 6.5): tylko `source =
 * 'ksef_duplicate_decision'` (`ORIGINAL_IMPORT_SOURCE`) i poprawne `decision`
 * (wybór, oferta trybu import, `via`, data, X); inaczej `null`.
 */
export function importedOriginalProvenance(fa3Data: unknown): ImportedOriginalProvenance | null {
  if (!isRecord(fa3Data) || !isRecord(fa3Data.import)) return null;
  const imported = fa3Data.import;
  if (imported.source !== ORIGINAL_IMPORT_SOURCE || !isRecord(imported.decision)) return null;
  const { choice, offer, via, at, retiredInvoiceId, retiredInternalNumber } = imported.decision;
  if (choice !== 'same_sale' && choice !== 'other_sale') return null;
  if (typeof offer !== 'string' || !(DUPLICATE_ORIGINAL_IMPORT_OFFERS as readonly string[]).includes(offer)) return null;
  if (via !== 'client' && via !== 'operator') return null;
  if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
  const retiredId = str(retiredInvoiceId);
  const retiredNumber = str(retiredInternalNumber);
  if (retiredId === null || retiredNumber === null) return null;
  return {
    decidedAt: at,
    choice,
    offer: offer as DuplicateOriginalImportOffer,
    via,
    retiredInvoiceId: retiredId,
    retiredInternalNumber: retiredNumber,
  };
}

// ─── Wybór wpisów (te same porządki co SQL) ──────────────────────────────────

/** Znacznik czasu do sortowania; `null` dla braku albo wartości nie do odczytu. */
function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Mikrosekundy ponad milisekundy (`timestamptz` z PostgREST ma 6 cyfr ułamka; `Date` czyta 3). */
function microsOf(value: string | null | undefined): number {
  const m = value ? /:\d{2}\.\d{3}(\d{1,3})/.exec(value) : null;
  return m ? Number(m[1]!.padEnd(3, '0')) : 0;
}

/** `ORDER BY <czas> DESC NULLS LAST, id` — jak w 00148 (z dokładnością do mikrosekundy). */
function compareDescNullsLastThenId(
  a: { id: string },
  rawA: string | null | undefined,
  b: { id: string },
  rawB: string | null | undefined,
): number {
  const ta = timeOf(rawA);
  const tb = timeOf(rawB);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  }
  if (ta !== null) {
    const micro = microsOf(rawB) - microsOf(rawA);
    if (micro !== 0) return micro;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Znacznik 440: najnowszy wpis `intent`/`sent` z numerem oryginału
 * (`ORDER BY attempted_at DESC NULLS LAST, id`, 2.1.2 #7). Tego samego wyboru
 * używa ładowarka faktów.
 */
export function duplicateMarker<T extends Pick<DuplicateDecisionSubmissionRow, 'id' | 'status' | 'original_ksef_number' | 'attempted_at'>>(
  submissions: readonly T[],
): T | null {
  return [...submissions]
    .filter((s) => (s.status === 'intent' || s.status === 'sent') && s.original_ksef_number != null)
    .sort((a, b) => compareDescNullsLastThenId(a, a.attempted_at, b, b.attempted_at))[0] ?? null;
}

type TakenRowFields = Pick<DuplicateDecisionSubmissionRow, 'id' | 'status' | 'original_ksef_number' | 'original_check' | 'completed_at'>;

const hasDecisionKey = (row: Pick<DuplicateDecisionSubmissionRow, 'original_check'>): boolean =>
  isRecord(row.original_check) && hasKey(row.original_check, 'decision');

/**
 * Wpis `number_taken`, który opisuje szkic wycofany — porządek wyzwalacza
 * (2.1.4 krok 2): najpierw z decyzją, potem z numerem oryginału, potem
 * `completed_at` malejąco (brak na końcu), potem `id`.
 */
function retiredRow<T extends TakenRowFields>(submissions: readonly T[]): T | null {
  return [...submissions]
    .filter((s) => s.status === 'number_taken')
    .sort((a, b) => {
      const decided = Number(hasDecisionKey(b)) - Number(hasDecisionKey(a));
      if (decided !== 0) return decided;
      const withK = Number(b.original_ksef_number != null) - Number(a.original_ksef_number != null);
      if (withK !== 0) return withK;
      return compareDescNullsLastThenId(a, a.completed_at, b, b.completed_at);
    })[0] ?? null;
}

/** Napis z listy (`mode`, `offer`, rodzaj znacznika); inaczej `null`. */
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;

/** Decyzja zapisana na wpisie `number_taken` — pola, które czyta aplikacja. */
interface RowDecision {
  choice: DuplicateChoice;
  via: DuplicateVia;
  at: string;
  /** PR C (00156): tryb decyzji `faktflow-original`; `null` — decyzja PR B (bez klucza `mode`). */
  mode: DuplicateDecisionMode | null;
  /** PR C: oferta pokazana przy decyzji; `null` — decyzja PR B. */
  offer: DuplicateOriginalOffer | null;
  /** PR C, tryb `import`: faktura K zapisana z KSeF. */
  importedInvoiceId: string | null;
  /** PR C, tryb `import`: numer, który przeszedł z dokumentu na K. */
  retiredInternalNumber: string | null;
}

/**
 * `original_check->'decision'` z poprawnym wyborem (jak `->>'choice'` w wyzwalaczu); inaczej `null`.
 * PR C (5.5): także tryb, oferta, faktura K i dawny numer (decyzje `faktflow-original`).
 */
function decisionOf(row: Pick<DuplicateDecisionSubmissionRow, 'original_check'>): RowDecision | null {
  if (!isRecord(row.original_check)) return null;
  const d = row.original_check.decision;
  if (!isRecord(d) || (d.choice !== 'same_sale' && d.choice !== 'other_sale')) return null;
  return {
    choice: d.choice,
    via: d.via === 'operator' ? 'operator' : 'client',
    at: typeof d.at === 'string' ? d.at : '',
    mode: oneOf(d.mode, DUPLICATE_DECISION_MODES),
    offer: oneOf(d.offer, DUPLICATE_ORIGINAL_OFFERS),
    importedInvoiceId: str(d.importedInvoiceId),
    retiredInternalNumber: str(d.retiredInternalNumber),
  };
}

/** Korekta faktury K istnieje w FaktWay tylko dla nabywcy z NIP albo numerem VAT-UE (F44). */
const isCorrectableBuyer = (kind: unknown): boolean =>
  typeof kind === 'string' && (ORIGINAL_CORRECTABLE_BUYER_ID_KINDS as readonly string[]).includes(kind);

/** Decyzja z zapisem oryginału K na wpisie `number_taken` (lustro kroku 2 wyzwalacza 00156, 4.11). */
interface ImportedDecision {
  importedInvoiceId: string;
  /** `COALESCE(retiredInternalNumber, numer dokumentu, 'bez numeru')` — numer, który przeszedł na K. */
  nrOld: string;
  /** `->>'choice' = 'other_sale'`; każdy inny wybór to „ta sama sprzedaż” (jak wyzwalacz). */
  other: boolean;
  offer: DuplicateOriginalOffer | null;
  via: DuplicateVia;
  at: string;
  /** `decision.original.buyerIdKind ∉ ('nip','vat-ue')` — zdanie `FAKTFLOW.CORRECTION_PERSON` (6.4). */
  correctionForPerson: boolean;
  /** `originalHasUncorrectableLine(original_check.importGate)` — zdanie `FAKTFLOW.CORRECTION_RATE` (D-A4-1b-3-KORZW); bez bramy `false`. */
  correctionForRate: boolean;
}

/**
 * Lustro 4.11: `->>'importedInvoiceId'` nie NULL i wpis z K — tekst `*_IMPORTED`
 * (poprawność wyboru nie jest warunkiem, jak w wyzwalaczu). Bez K albo bez
 * `importedInvoiceId` (decyzja PR B, `no-import`) — `null`, teksty 00148.
 */
function importedDecisionOf(row: TakenRowFields, invoiceNumber: string | null): ImportedDecision | null {
  if (row.original_ksef_number == null || !isRecord(row.original_check)) return null;
  const d = row.original_check.decision;
  if (!isRecord(d)) return null;
  const importedInvoiceId = jsonText(d.importedInvoiceId);
  if (importedInvoiceId === null) return null;
  const original = isRecord(d.original) ? d.original : null;
  return {
    importedInvoiceId,
    nrOld: jsonText(d.retiredInternalNumber) ?? invoiceNumber ?? 'bez numeru',
    other: jsonText(d.choice) === 'other_sale',
    offer: oneOf(d.offer, DUPLICATE_ORIGINAL_OFFERS),
    via: d.via === 'operator' ? 'operator' : 'client',
    at: typeof d.at === 'string' ? d.at : '',
    correctionForPerson: !isCorrectableBuyer(original?.buyerIdKind),
    // Podgląd pliku zostaje na znaczniku po decyzji (`importGate` nie jest ruszany) — baner liczy z niego jak panel.
    correctionForRate: originalHasUncorrectableLine(row.original_check.importGate),
  };
}

// ─── Polityka decyzji (lustro `ksef_duplicate_decision_blocker`, 2.1.2) ──────

export interface DuplicateDecisionOptionsInput {
  facts: DuplicateDecisionFacts;
  /** Klient w panelu albo operator (`/admin/ksef`, decyzja przekazana przez klienta). */
  actor: 'client' | 'operator';
  /** Rola zalogowanej osoby: właściciel albo administrator (`canManageKsefSend`). Operator jej nie potrzebuje. */
  canManage: boolean;
  /** `configuredKsefEnvironment()` serwera; `null` — nieznane. */
  environment: KsefEnvironment | null;
  /** Chwila odczytu: PR C liczy z niej `pastPeriod` (okres oryginału wcześniejszy niż bieżący miesiąc w Polsce). */
  now: Date;
}

const toNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const digitsOf = (v: string | null): string | null => {
  const d = v ? v.replace(/\D/g, '') : '';
  return d.length > 0 ? d : null;
};

const trimmed = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length > 0 ? s : null;
};

const sameText = (a: string | null, b: string | null): boolean | null => (a !== null && b !== null ? a === b : null);

/** `FaktWay` dla pliku FaktWay, inaczej nazwa z `SystemInfo`; `null` — nieznany. */
function programOf(summary: Record<string, unknown>): string | null {
  const systemInfo = str(summary.systemInfo);
  return systemInfo === FAKTFLOW_SYSTEM_INFO ? 'FaktWay' : systemInfo;
}

/** Tabela porównania (2.2.2) i dwa porównania, od których zależy „Rozumiem skutki”. */
interface Comparison {
  rows: ComparisonRow[];
  /** NIP nabywcy po samych cyfrach; `null` — nieznany po którejś stronie. */
  nipSame: boolean | null;
  /** Kwota brutto w tej samej znanej walucie; `null` — kwota albo waluta nieznana. */
  grossSame: boolean | null;
}

/**
 * Sześć wierszy PR B: numer, data wystawienia, nabywca, NIP nabywcy, kwota
 * brutto, program (`programKsef` — kolumna „W KSeF” wiersza „Program”).
 */
function comparisonOf(inv: DuplicateDecisionInvoiceRow, summary: Record<string, unknown>, programKsef: string | null): Comparison {
  const L = DUPLICATE_DECISION_TEXTS.ROW_LABELS;
  const buyerData = isRecord(inv.buyer_data) ? inv.buyer_data : null;

  const ksefNumberText = trimmed(summary.number);
  const oursNumber = trimmed(inv.internal_number);
  const ksefDate = trimmed(summary.issueDate);
  const oursDate = trimmed(inv.issue_date);
  const ksefBuyer = trimmed(summary.buyerName);
  const oursBuyer = trimmed(buyerData?.name);
  const ksefNip = trimmed(summary.buyerNip);
  const oursNip = trimmed(inv.buyer_nip);
  const nipK = digitsOf(ksefNip);
  const nipO = digitsOf(oursNip);
  const nipSame = sameText(nipK, nipO);

  const ksefGross = toNumber(summary.gross);
  const oursGross = toNumber(inv.gross_total);
  const ksefCurrency = trimmed(summary.currency);
  const oursCurrency = trimmed(inv.currency);
  // Obie kwoty i obie waluty znane: inna waluta — „różni się” (decyzja 12: to „kwota się różni”), ta sama — porównanie
  // kwot. Kwota albo waluta nieznana — „bez porównania” (null); „Rozumiem skutki” i tak wymagane (`grossSame !== true`).
  const grossSame = ksefGross === null || oursGross === null || ksefCurrency === null || oursCurrency === null
    ? null
    : ksefCurrency === oursCurrency && ksefGross.toFixed(2) === oursGross.toFixed(2);
  const money = (value: number | null, currency: string | null): string | null =>
    value === null ? null : currency ? `${value.toFixed(2)} ${currency}` : value.toFixed(2);

  const rows: ComparisonRow[] = [
    { label: L.number, ksef: ksefNumberText, ours: oursNumber, same: sameText(ksefNumberText, oursNumber) },
    { label: L.issueDate, ksef: ksefDate, ours: oursDate, same: sameText(ksefDate, oursDate) },
    { label: L.buyer, ksef: ksefBuyer, ours: oursBuyer, same: sameText(ksefBuyer, oursBuyer) },
    { label: L.buyerNip, ksef: ksefNip, ours: oursNip, same: nipSame },
    { label: L.gross, ksef: money(ksefGross, ksefCurrency), ours: money(oursGross, oursCurrency), same: grossSame },
    { label: L.program, ksef: programKsef, ours: 'FaktWay', same: null },
  ];
  return { rows, nipSame, grossSame };
}

/** „Rozumiem skutki” PR B (decyzje 7 i 12) — także oferty `pair`, `released` i `review-pair`. */
const prBConfirmation = (c: Comparison): Record<DuplicateChoice, boolean> => ({
  // „Inna sprzedaż” przy tym samym albo nieznanym NIP nabywcy.
  other_sale: c.nipSame !== false,
  // „Ta sama sprzedaż” przy innym albo nieznanym NIP albo kwocie, która się różni (także waluta, wartość nieznana).
  same_sale: c.nipSame !== true || c.grossSame !== true,
});

type RecheckDetail = Pick<DuplicateRefusalDetail, 'recheckKind' | 'recheckAt'>;
type Refuse = (refusal: DuplicateDecisionRefusal, message: string | null, extra?: RecheckDetail) => DuplicateDecisionView;

/** Odmowa środowiska — nieznane środowisko aplikacji albo inne środowisko sprawdzenia oryginału (jak RPC). */
function environmentRefusal(
  environment: KsefEnvironment | null,
  checkEnv: unknown,
  k: string,
  nr: string,
  refused: Refuse,
): DuplicateDecisionView | null {
  if (environment === null) return refused('env-unknown', KSEF_SEND_MESSAGES.envUnknown);
  if (checkEnv !== environment) {
    return refused('env', sqlText('ENV', k, duplicateEnvLabel(checkEnv), duplicateEnvLabel(environment), nr));
  }
  return null;
}

/**
 * Kod blokady SQL, którego TS nie obsłużył wcześniej (wyścig — baza ma ostatnie
 * słowo): odmowa z tekstem kodu; kod spoza listy 00156 → `state-unknown`.
 */
function blockerRefusal(code: string, k: string, nr: string, refused: Refuse): DuplicateDecisionView {
  if (!(DUPLICATE_DECISION_BLOCKER_CODES as readonly string[]).includes(code)) {
    return refused('state-unknown', DUPLICATE_DECISION_TEXTS.FAKTFLOW.READ_FAILED(nr));
  }
  const blocker = code as DuplicateDecisionBlockerCode;
  switch (blocker) {
    case 'not-found':
      return refused(blocker, KSEF_SEND_MESSAGES.notFound);
    case 'reason':
      // Jak odmowa `reason` w TS: notatka PR A z karty.
      return refused(blocker, null);
    case 'known-stale':
    case 'own-history':
    case 'known-now':
      return refused(blocker, sqlText(blocker, k, nr));
    case 'cross-tenant':
      return refused(blocker, sqlText(blocker, nr, nr));
    default:
      return refused(blocker, sqlText(blocker, nr));
  }
}

/** `recheckNeeded` znacznika dla tekstu operatora (`recheckPending`) — rodzaj z listy 4.7b i czas; inaczej `null`. */
function recheckDetailOf(check: Record<string, unknown>): RecheckDetail {
  const flag = isRecord(check.recheckNeeded) ? check.recheckNeeded : null;
  return {
    recheckKind: flag ? oneOf(flag.kind, ORIGINAL_RECHECK_KINDS) : null,
    recheckAt: flag ? str(flag.at) : null,
  };
}

/** `MM.RRRR` wcześniejszy niż bieżący miesiąc w Polsce (Europe/Warsaw) w chwili `now`; zły zapis okresu → `false`. */
function isPastPeriod(period: unknown, now: Date): boolean {
  const p = typeof period === 'string' ? /^(\d{2})\.(\d{4})$/.exec(period) : null;
  const today = /^(\d{4})-(\d{2})-\d{2}$/.exec(todayInWarsaw(now));
  if (!p || !today) return false;
  return Number(p[2]) * 12 + Number(p[1]) < Number(today[1]) * 12 + Number(today[2]);
}

/** Wiersz „Data sprzedaży” (`NULL` = jak data wystawienia — nie „—”); bez porównania. */
function saleDateRow(preview: OriginalPreview, inv: DuplicateDecisionInvoiceRow): ComparisonRow {
  const FF = DUPLICATE_DECISION_TEXTS.FAKTFLOW;
  return {
    label: FF.ROW_SALE_DATE,
    ksef: trimmed(preview.saleDate) ?? FF.SALE_DATE_AS_ISSUE,
    ours: trimmed(inv.sale_date) ?? FF.SALE_DATE_AS_ISSUE,
    same: null,
  };
}

interface FaktflowContext {
  input: DuplicateDecisionOptionsInput;
  inv: DuplicateDecisionInvoiceRow;
  subs: readonly DuplicateDecisionSubmissionRow[];
  marker: DuplicateDecisionSubmissionRow;
  /** Surowy `original_check` znacznika (przeszedł `duplicateCheckAllows`). */
  check: Record<string, unknown>;
  k: string;
  nr: string;
  sha256: string;
  refused: Refuse;
}

/** Część widoku wspólna dla `decidable` i `review` przy `faktflow-original` (5.5). */
function faktflowViewParts(ctx: FaktflowContext, offer: DuplicateOriginalOffer, ownHistoryDb: boolean) {
  const { inv, check, k, input } = ctx;
  const FF = DUPLICATE_DECISION_TEXTS.FAKTFLOW;
  const summary = check.summary as Record<string, unknown>;
  const gate = isRecord(check.importGate) ? check.importGate : null;
  // Podgląd z `importGate.preview` — strona nie czyta archiwum (INV-13).
  const preview = gate && isRecord(gate.preview) ? (gate.preview as unknown as OriginalPreview) : null;
  const comparison = comparisonOf(inv, summary, offer === 'released' ? FF.PROGRAM_RELEASED : 'FaktWay');
  if (preview) comparison.rows.splice(2, 0, saleDateRow(preview, inv));
  const sameContent = typeof check.sameContentExceptHeader === 'boolean' ? check.sameContentExceptHeader : null;
  const recordOnly = offer === 'record' || offer === 'review-record';
  // Wstęp „tylko zapis”: własna historia (JSON albo baza) ma pierwszeństwo przed tą samą treścią (I1).
  const recordIntro: DuplicateRecordIntro | undefined = recordOnly
    ? (check.ownHistory === true || ownHistoryDb ? 'own' : 'same')
    : undefined;
  const choices: readonly DuplicateChoice[] = recordOnly ? ['same_sale'] : ['same_sale', 'other_sale'];
  const needsConfirmation: Record<DuplicateChoice, boolean> = recordOnly
    ? { other_sale: false, same_sale: sameContent !== true }
    : prBConfirmation(comparison);
  const original: DuplicateOriginalViewData = {
    preview,
    assignedDay: originalAssignedDay({ acquiredAt: str(check.acquiredAt) }, k),
    pastPeriod: preview ? isPastPeriod(preview.period, input.now) : false,
  };
  return {
    comparison: comparison.rows,
    markedDifference: comparison.rows.some((row) => row.same === false),
    sameContent,
    needsConfirmation,
    choices,
    original,
    // `buyerIdKind` nieznany (brak podglądu) — korekty nie obiecujemy (∉ nip, vat-ue).
    correctionForPerson: !isCorrectableBuyer(preview?.buyerIdKind),
    // Pozycja zw / stawka spoza FaktWay / brak ceny netto: korekty K nie obiecujemy (D-A4-1b-3-KORZW).
    correctionForRate: originalHasUncorrectableLine(gate),
    // Środowisko jest tu znane (odmowa `env-unknown` stoi wcześniej).
    heldCorrections: input.environment !== null && isCorrectionHeldForEnv(input.environment),
    ...(recordIntro ? { recordIntro } : {}),
  };
}

/**
 * `faktflow-original` po kroku 10 (5.5, kody w kolejności 4.5): blokady SQL nie
 * odczytano → `state-unknown`; `known-now`, `cross-tenant` z blokady SQL;
 * `recheck-needed` z JSON (lustro 11c) albo z blokady; krok 12 pominięty —
 * własna historia z bazy wybiera ofertę „tylko zapis”; `payments` z wiersza
 * albo z blokady; oferta `review-*`: klient — `provenance-review`, operator —
 * środowisko (M9), potem widok `review`; dalej środowisko i rola jak PR B; kod
 * blokady SQL nieobsłużony wyżej odmawia (wyścig — baza ma ostatnie słowo).
 */
function faktflowOriginalOptions(ctx: FaktflowContext): DuplicateDecisionView {
  const { input, inv, subs, marker, check, k, nr, sha256, refused } = ctx;
  const { actor, environment } = input;
  const blocker = input.facts.sqlBlocker;
  const FF = DUPLICATE_DECISION_TEXTS.FAKTFLOW;

  // 1. Blokady nie odczytano — fail-closed, także dla operatora.
  if (blocker === undefined) return refused('state-unknown', FF.READ_FAILED(nr));
  // 2. 11a known-now i 11b cross-tenant — tylko z blokady SQL (TS ich nie liczy, INV-9, INV-15).
  if (blocker === 'known-now') return refused('known-now', sqlText('known-now', k, nr));
  if (blocker === 'cross-tenant') return refused('cross-tenant', sqlText('cross-tenant', nr, nr));
  //    11c recheck-needed — lustro z JSON (brak albo zły kształt bramy, znacznik `recheckNeeded`) albo słowo bazy.
  if (originalRecheckNeeded(check) || blocker === 'recheck-needed') {
    return refused('recheck-needed', sqlText('recheck-needed', nr), recheckDetailOf(check));
  }
  // 3. Krok 12 (own-history) pominięty: własna historia w bazie daje ofertę „tylko zapis” (T3, INV-19).
  const ownHistoryDb = ownHistoryInSubmissions(subs, marker);
  // 4. Krok 13 payments: `paid_amount` faktury albo wiersze `payments` z blokady SQL (INV-17) — przed przeglądem.
  const paid = toNumber(inv.paid_amount);
  if ((inv.paid_amount != null && paid !== 0) || blocker === 'payments') return refused('payments', sqlText('payments', nr));
  // 5. Oferta — lustro `ksef_duplicate_original_offer` (ta sama dla powiadomień i operatora).
  const offer = duplicateOriginalOffer(check, ownHistoryDb);
  // `allows` przeszło, powód faktflow-original — oferta zawsze jest; brak = niespójne dane, notatka PR A.
  if (offer === null) return refused('reason', null);
  if (offer === 'review-pair' || offer === 'review-record') {
    // Klient: przegląd pliku — blokada SQL `provenance-review` stoi przed odmowami aplikacji.
    if (actor !== 'operator') return refused('provenance-review', sqlText('provenance-review', nr));
    // M9: środowisko PRZED widokiem przeglądu (RPC i tak odmówiłoby ENV).
    const env = environmentRefusal(environment, check.env, k, nr, refused);
    if (env) return env;
    // Baza ma ostatnie słowo: inny kod niż provenance-review (wyścig) odmawia.
    if (blocker !== null && blocker !== 'provenance-review') return blockerRefusal(blocker, k, nr, refused);
    const parts = faktflowViewParts(ctx, offer, ownHistoryDb);
    const gate = isRecord(check.importGate) ? check.importGate : null;
    return {
      kind: 'review',
      offer,
      // Brama jest tu poprawna (inaczej recheck-needed wyżej): `problems` to tablica napisów.
      problems: Array.isArray(gate?.problems) ? [...(gate.problems as OriginalGateProblem[])] : [],
      invoiceNumber: inv.internal_number,
      originalKsefNumber: k,
      originalSha256: sha256,
      comparison: parts.comparison,
      original: parts.original,
      choices: parts.choices,
      needsConfirmation: parts.needsConfirmation,
      sameContent: parts.sameContent,
      markedDifference: parts.markedDifference,
      heldCorrections: parts.heldCorrections,
      program: 'FaktWay',
      releasable: offer === 'review-pair',
      correctionForPerson: parts.correctionForPerson,
      correctionForRate: parts.correctionForRate,
      ...(parts.recordIntro ? { recordIntro: parts.recordIntro } : {}),
    };
  }
  // 6. Środowisko aplikacji, środowisko sprawdzenia oryginału, rola klienta — jak PR B.
  const env = environmentRefusal(environment, check.env, k, nr, refused);
  if (env) return env;
  if (actor === 'client' && !input.canManage) return refused('role', DUPLICATE_DECISION_TEXTS.ROLE);
  // 7. Kod blokady SQL nieobsłużony wyżej (wyścig) — baza ma ostatnie słowo.
  if (blocker !== null) return blockerRefusal(blocker, k, nr, refused);

  const parts = faktflowViewParts(ctx, offer, ownHistoryDb);
  return {
    kind: 'decidable',
    reason: 'faktflow-original',
    invoiceNumber: inv.internal_number,
    originalKsefNumber: k,
    originalSha256: sha256,
    comparison: parts.comparison,
    markedDifference: parts.markedDifference,
    sameContent: parts.sameContent,
    needsConfirmation: parts.needsConfirmation,
    // Po oddaniu plik „nie powstał w FaktWay” — program nieznany (dialogi PR B z `program = null`).
    program: offer === 'released' ? null : 'FaktWay',
    knownInvoice: null,
    heldCorrections: parts.heldCorrections,
    offer,
    mode: offer === 'released' ? 'no-import' : 'import',
    choices: parts.choices,
    original: parts.original,
    correctionForPerson: parts.correctionForPerson,
    correctionForRate: parts.correctionForRate,
    ...(parts.recordIntro ? { recordIntro: parts.recordIntro } : {}),
  };
}

/**
 * Co klient (albo operator) może zrobić z fakturą przy nierozstrzygniętym 440.
 * Kolejność odmów = blokada SQL (2.1.2), potem nieznane środowisko, inne
 * środowisko sprawdzenia oryginału i — na końcu, tylko klient — rola: członek
 * firmy widzi prawdziwą blokadę. Szkic z zapisaną decyzją daje widok `decided`
 * (ponowienie po zgubionej odpowiedzi; RPC odpowiada wtedy `already_decided`).
 * PR C: `faktflow-original` — `faktflowOriginalOptions` (kody 00156, 4.5).
 */
export function duplicateDecisionOptions(input: DuplicateDecisionOptionsInput): DuplicateDecisionView {
  const { facts, actor, environment } = input;
  const inv = facts.invoice;
  const subs = facts.submissions;
  const marker = duplicateMarker(subs);
  const markerCheck = marker && isRecord(marker.original_check) ? marker.original_check : null;
  const knownFromCheck = markerCheck && isRecord(markerCheck.knownInvoice) ? markerCheck.knownInvoice : null;

  const refused: Refuse = (refusal, message, extra) => {
    if (actor !== 'operator') return { kind: 'refused', refusal, message };
    const knownNumber = markerCheck?.reason === 'known-number'
      ? facts.knownInvoice?.internalNumber ?? str(knownFromCheck?.internalNumber) ?? 'bez numeru'
      : null;
    return {
      kind: 'refused',
      refusal,
      message,
      detail: {
        originalKsefNumber: marker?.original_ksef_number ?? null,
        reason: typeof markerCheck?.reason === 'string' ? markerCheck.reason : null,
        checkEnv: typeof markerCheck?.env === 'string' ? markerCheck.env : null,
        environment,
        paidAmount: inv ? toNumber(inv.paid_amount) : null,
        knownInvoiceNumber: knownNumber,
        ...(extra ?? {}),
      },
    };
  };

  // 1. not-found (RPC: P0002 przed wszystkim innym).
  if (!inv || inv.direction !== 'outgoing') return refused('not-found', KSEF_SEND_MESSAGES.notFound);

  // Idempotencja (RPC krok 2): zapisana decyzja — nie odmowa, tylko jej widok.
  const taken = retiredRow(subs);
  const decided = taken ? decisionOf(taken) : null;
  if (taken && decided) {
    return {
      kind: 'decided',
      choice: decided.choice,
      via: decided.via,
      at: decided.at,
      originalKsefNumber: taken.original_ksef_number,
      // PR C: decyzja `faktflow-original` niesie tryb, ofertę i fakturę K; decyzja PR B — bez tych kluczy.
      ...(decided.mode !== null || decided.offer !== null
        ? {
            mode: decided.mode,
            offer: decided.offer,
            importedInvoiceId: decided.importedInvoiceId,
            retiredInternalNumber: decided.retiredInternalNumber,
          }
        : {}),
    };
  }

  const nr = documentNumber(inv.internal_number);
  // 2. not-pending
  if (inv.ksef_status !== 'failed' || inv.last_error_code !== 'KSEF_DUPLICATE_RECONCILE') {
    return refused('not-pending', sqlText('not-pending', nr));
  }
  // 3. in-ksef
  if (inv.ksef_number != null || subs.some((s) => s.status === 'accepted' || s.response_ksef_number != null)) {
    return refused('in-ksef', sqlText('in-ksef', nr));
  }
  // 4. kind
  if ((inv.invoice_kind ?? 'regular') !== 'regular') return refused('kind', sqlText('kind', nr));
  // 5. billing
  if (inv.stripe_invoice_id != null) return refused('billing', sqlText('billing', nr));
  // 6. offline (reset ich nie czyści, 00132 je mrozi)
  if (inv.offline_idempotency_key != null || inv.offline_qr_offline != null || inv.offline_qr_certyfikat != null) {
    return refused('offline', sqlText('offline', nr));
  }
  // 7. no-marker
  if (!marker || marker.original_ksef_number == null) return refused('no-marker', sqlText('no-marker', nr));
  const k = marker.original_ksef_number;
  // 8. conflicting-originals: wpis w dowolnym stanie z innym numerem oryginału.
  if (subs.some((s) => s.original_ksef_number != null && s.original_ksef_number !== k)) {
    return refused('conflicting-originals', sqlText('conflicting-originals', nr));
  }
  // 9. no-check (znacznik sprzed 00144)
  if (marker.original_check === null || marker.original_check === undefined) return refused('no-check', sqlText('no-check', nr));
  // 10. reason: dane oryginału, powód i własna historia w JSON — zostaje notatka PR A.
  if (!markerCheck || !duplicateCheckAllows(markerCheck, null)) return refused('reason', null);
  const check = markerCheck;
  const reason = check.reason as DuplicateDecisionReason;
  // 11. known-stale — tylko przy powodzie known-number (C2): Y musi nadal mieć K i być przyjęta.
  if (reason === 'known-number') {
    const known = facts.knownInvoice;
    const expectedId = knownFromCheck ? knownFromCheck.id : null;
    if (!known || !known.holdsOriginal || known.id !== expectedId) {
      return refused('known-stale', sqlText('known-stale', k, nr));
    }
  }
  const sha256 = check.sha256 as string;
  // PR C (00156): faktflow-original — known-now, cross-tenant, recheck-needed, oferta, przegląd.
  if (reason === 'faktflow-original') {
    return faktflowOriginalOptions({ input, inv, subs, marker, check, k, nr, sha256, refused });
  }
  // 12. own-history — sprawdzane na wpisach faktury, nie z JSON (lustro `ksef_duplicate_own_history`, 4.3).
  if (ownHistoryInSubmissions(subs, marker)) return refused('own-history', sqlText('own-history', k, nr));
  // 13. payments — sesja klienta widzi tylko `paid_amount`; wiersze `payments` sprawdza RPC.
  const paid = toNumber(inv.paid_amount);
  if (inv.paid_amount != null && paid !== 0) return refused('payments', sqlText('payments', nr));
  // Środowisko aplikacji, potem środowisko sprawdzenia oryginału, potem rola klienta.
  const env = environmentRefusal(environment, check.env, k, nr, refused);
  if (env) return env;
  if (actor === 'client' && !input.canManage) return refused('role', DUPLICATE_DECISION_TEXTS.ROLE);

  const summary = check.summary as Record<string, unknown>;
  const program = programOf(summary);
  const comparison = comparisonOf(inv, summary, program);

  const known = reason === 'known-number' && facts.knownInvoice
    ? { id: facts.knownInvoice.id, internalNumber: facts.knownInvoice.internalNumber }
    : null;
  return {
    kind: 'decidable',
    reason,
    invoiceNumber: inv.internal_number,
    originalKsefNumber: k,
    originalSha256: sha256,
    comparison: comparison.rows,
    markedDifference: comparison.rows.some((row) => row.same === false),
    // no-own-file: FaktWay nie ma pliku próby — treści nie porównano.
    sameContent: reason === 'known-number' && typeof check.sameContentExceptHeader === 'boolean' ? check.sameContentExceptHeader : null,
    needsConfirmation: prBConfirmation(comparison),
    program,
    knownInvoice: known,
    // Środowisko jest tu znane (odmowa `env-unknown` wyżej).
    heldCorrections: environment !== null && isCorrectionHeldForEnv(environment),
    // PR C (5.5): pola oferty ustawione zawsze — powód PR B: bez oferty (9-argumentowe RPC), oba wybory, bez danych oryginału.
    offer: null,
    mode: null,
    choices: ['same_sale', 'other_sale'],
    original: null,
    correctionForPerson: false,
    correctionForRate: false,
  };
}

// ─── Szkic wycofany (wpis `number_taken`, decyzje 2, 3, 9, 11) ───────────────

/**
 * Odmowa wysyłki szkicu z wpisem `number_taken` — dowolny rodzaj, decyzja
 * albo automatyczny „numer zajęty”. Ten sam tekst co wyzwalacz
 * `c_guard_ksef_retired_draft` (2.1.4 krok 7). `null` — brak wpisu.
 * PR C (4.11): decyzja z zapisem oryginału (`importedInvoiceId`) —
 * `TRIGGER_SAME_IMPORTED` / `TRIGGER_OTHER_IMPORTED` z dawnym numerem.
 */
export function retiredDraftSendRefusal(invoiceNumber: string | null, submissions: readonly TakenRowFields[]): string | null {
  const row = retiredRow(submissions);
  if (!row) return null;
  const nr = documentNumber(invoiceNumber);
  const k = row.original_ksef_number;
  const imported = importedDecisionOf(row, invoiceNumber);
  if (imported && k != null) {
    return imported.other
      ? sqlText('TRIGGER_OTHER_IMPORTED', imported.nrOld, imported.nrOld, k)
      : sqlText('TRIGGER_SAME_IMPORTED', imported.nrOld, k, imported.nrOld);
  }
  const decision = decisionOf(row);
  if (decision && k != null) {
    return sqlText(decision.choice === 'same_sale' ? 'TRIGGER_SAME' : 'TRIGGER_OTHER', nr, k);
  }
  return sqlText('TRIGGER_AUTO', nr, k != null ? `fakturę ${k}` : 'inną fakturę Twojej firmy');
}

export interface RetiredDraftViewInput {
  invoiceNumber: string | null;
  /** `invoices.invoice_kind`: regular | correction | advance | final. */
  invoiceKind: string | null;
  /** Wszystkie wpisy faktury (filtr `number_taken` jest tutaj). */
  submissions: readonly TakenRowFields[];
  /** Rodzaj wstrzymany w środowisku (`ksef_resend_facts.kindHeld`). */
  kindHeld: boolean;
}

/**
 * Baner szkicu wycofanego — każdy rodzaj (decyzja 9); `null` bez wpisu
 * `number_taken`. Zwykła faktura: decyzja „ta sama” / „ta sama” przy
 * known-number / „inna” albo automatyczny „numer zajęty”; zaliczka
 * i dokumenty usuwalne (korekta, faktura rozliczeniowa) — tylko automat
 * (decyzja jest wyłącznie dla zwykłej faktury; wpis z decyzją przy innym
 * rodzaju to uszkodzone dane — tekst automatyczny rodzaju).
 * PR C (6.4): decyzja z zapisem oryginału — banery `FAKTFLOW.BANNER_*` z dawnym
 * numerem, odnośnik do K (`imported`), zdanie o korekcie dla nabywcy bez NIP
 * i VAT-UE; decyzja po oddaniu (`no-import`) — teksty PR B z programem „nieznanym”.
 */
export function retiredDraftView(input: RetiredDraftViewInput): RetiredDraftView | null {
  const row = retiredRow(input.submissions);
  if (!row) return null;
  const T = DUPLICATE_DECISION_TEXTS;
  const FF = T.FAKTFLOW;
  const nr = documentNumber(input.invoiceNumber);
  const k = row.original_ksef_number;
  const special = specialKindOf(input.invoiceKind);
  // Jak `WHEN` wyzwalacza usuwania: zwykła i zaliczka — nie; korekta i faktura rozliczeniowa — tak.
  const deletable = special === 'correction' || special === 'final';
  const imported = importedDecisionOf(row, input.invoiceNumber);
  const base = {
    title: T.BANNER_TITLE(nr),
    sendRefusal: retiredDraftSendRefusal(input.invoiceNumber, input.submissions),
    deletable,
    deleteRefusal: deletable
      ? null
      : imported && k != null
        ? sqlText('TRIGGER_DELETE_IMPORTED', imported.nrOld, k)
        : sqlText('TRIGGER_DELETE', nr, k != null ? `faktura ${k}` : 'inna faktura Twojej firmy'),
  };

  if (special === 'advance') {
    return { ...base, body: T.BANNER_AUTO_ADVANCE(nr, k), cta: { ...T.CTA_ADVANCE }, knownInvoice: null };
  }
  if (special === 'correction' || special === 'final') {
    const label = SPECIAL_KIND_LABEL[special];
    const body = input.kindHeld
      ? T.BANNER_AUTO_DELETABLE_HELD(nr, k, label.G, label.A)
      : T.BANNER_AUTO_DELETABLE(nr, k, label.G, label.A);
    return { ...base, body, cta: null, knownInvoice: null };
  }

  // PR C: zapis oryginału — numer dokumentu przeszedł na fakturę K z KSeF.
  if (imported && k != null) {
    const check = row.original_check as Record<string, unknown>;
    const summary = isRecord(check.summary) ? check.summary : {};
    const nrK = trimmed(summary.number) ?? imported.nrOld;
    const data = imported.at ? formatWarsawDateTime(imported.at) : '';
    const via = imported.via === 'operator' ? T.BANNER_VIA_OPERATOR : '';
    const label = decisionLabel(imported.offer, imported.other ? 'other_sale' : 'same_sale');
    const banner = label === 'record' ? FF.BANNER_RECORD : label === 'other_sale' ? FF.BANNER_OTHER : FF.BANNER_SAME;
    return {
      ...base,
      title: FF.BANNER_TITLE(imported.nrOld),
      body: banner(data, via, nrK, k)
        + (imported.correctionForPerson ? FF.CORRECTION_PERSON : '')
        + (imported.correctionForRate ? FF.CORRECTION_RATE(nrK) : ''),
      // Jedyny przycisk tylko przy „inna sprzedaż” (C2).
      cta: label === 'other_sale' ? { ...T.CTA_REGULAR } : null,
      knownInvoice: null,
      imported: { id: imported.importedInvoiceId, internalNumber: imported.nrOld },
    };
  }

  const decision = k != null ? decisionOf(row) : null;
  if (decision && k != null) {
    const check = row.original_check as Record<string, unknown>;
    const data = decision.at ? formatWarsawDateTime(decision.at) : '';
    const via = decision.via === 'operator' ? T.BANNER_VIA_OPERATOR : '';
    const summary = isRecord(check.summary) ? check.summary : {};
    const nrK = trimmed(summary.number) ?? nr;
    // PR C: decyzja po oddaniu (`no-import`) — plik nie powstał w FaktWay: teksty PR B z programem „nieznanym”, bez K.
    const faktflow = check.reason === 'faktflow-original' || decision.mode !== null;
    const extra = faktflow ? { imported: null } : {};
    if (decision.choice === 'other_sale') {
      return { ...base, body: T.BANNER_OTHER(data, via, k, nr), cta: { ...T.CTA_REGULAR }, knownInvoice: null, ...extra };
    }
    const knownRaw = check.reason === 'known-number' && isRecord(check.knownInvoice) ? check.knownInvoice : null;
    const knownId = knownRaw ? str(knownRaw.id) : null;
    if (knownRaw && knownId) {
      const internalNumber = str(knownRaw.internalNumber);
      return {
        ...base,
        body: T.BANNER_SAME_KNOWN(data, via, nrK, k, internalNumber ?? 'bez numeru'),
        cta: null,
        knownInvoice: { id: knownId, internalNumber },
      };
    }
    const program = faktflow ? null : programOf(summary);
    return { ...base, body: T.BANNER_SAME(data, via, nrK, k, program), cta: null, knownInvoice: null, ...extra };
  }
  return { ...base, body: T.BANNER_AUTO(nr, k), cta: { ...T.CTA_REGULAR }, knownInvoice: null };
}
