/**
 * Typy kontraktu decyzji przy 440: wybory, kody blokady SQL i odmów, fakty
 * ładowarki, widoki panelu, operatora i banera szkicu wycofanego.
 *
 * Część barelu `./duplicate-decision` (plan usprawnień 3.7b). Spoza
 * `lib/ksef/duplicate-decision*.ts` importuj tylko z barelu `@/lib/ksef/duplicate-decision`.
 * CZYSTY moduł (komponenty klienckie i worker): bez bazy, KSeF, Node i `duplicate-verdict.ts`.
 */

import type { KsefEnvironment } from '@/types/ksef';

import type {
  DuplicateDecisionChoice,
  DuplicateDecisionMode,
  DuplicateDecisionVia,
  DuplicateOriginalImportOffer,
  DuplicateOriginalOffer,
  OriginalGateProblem,
  OriginalPreview,
  OriginalRecheckKind,
} from './duplicate-check';

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
