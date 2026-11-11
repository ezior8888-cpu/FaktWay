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
 *
 * Podział (plan usprawnień 3.7b, 08.11.2026): ten plik jest barelem i jedynym
 * wejściem (`@/lib/ksef/duplicate-decision`); kod leży w częściach obok:
 * `-types` (kontrakt), `-sql-texts` (lustro RAISE 00148/00151/00156),
 * `-texts` (teksty klienta), `-jsonb` (polityka na surowym jsonb, oferta),
 * `-rows` (wybór wpisów), `-policy` (`duplicateDecisionOptions`),
 * `-retired` (szkic wycofany). Lista eksportów pilnowana w
 * `tests/unit/ksef-decyzja-duplikatu-eksporty.test.ts`.
 */

// PR C (5.5): lustro `ksef_duplicate_gate_ok` i dzień nadania numeru mieszkają
// w `duplicate-check.ts` (bez cyklu importów: `parseImportGate` używa tego
// samego sprawdzenia); polityka eksportuje je razem z resztą kontraktu.
export { originalAssignedDay, originalGateOk } from './duplicate-check';
export type { DuplicateDecisionMode, DuplicateOriginalImportOffer, DuplicateOriginalOffer } from './duplicate-check';

export {
  decisionLabel,
  duplicateCheckAllows,
  duplicateNoticeVariant,
  duplicateOriginalOffer,
  importedOriginalProvenance,
  originalRecheckNeeded,
  ownHistoryInSubmissions,
} from './duplicate-decision-jsonb';
export { duplicateDecisionOptions, type DuplicateDecisionOptionsInput } from './duplicate-decision-policy';
export { retiredDraftSendRefusal, retiredDraftView, type RetiredDraftViewInput } from './duplicate-decision-retired';
export { duplicateMarker } from './duplicate-decision-rows';
export {
  DUPLICATE_DECISION_SQL_TEXTS,
  duplicateEnvLabel,
  fillSqlText,
  type DuplicateDecisionSqlText,
  type DuplicateDecisionSqlTextKey,
} from './duplicate-decision-sql-texts';
export { DUPLICATE_DECISION_TEXTS, programAccusative, programNominative } from './duplicate-decision-texts';
export {
  DUPLICATE_DECISION_BLOCKER_CODES,
  type ComparisonRow,
  type DuplicateChoice,
  type DuplicateDecidableOffer,
  type DuplicateDecisionBlockerCode,
  type DuplicateDecisionFacts,
  type DuplicateDecisionInvoiceRow,
  type DuplicateDecisionKnownInvoice,
  type DuplicateDecisionLabel,
  type DuplicateDecisionReason,
  type DuplicateDecisionRefusal,
  type DuplicateDecisionReviewView,
  type DuplicateDecisionSubmissionRow,
  type DuplicateDecisionView,
  type DuplicateNoticeVariant,
  type DuplicateOriginalViewData,
  type DuplicateRecordIntro,
  type DuplicateRefusalDetail,
  type DuplicateReviewOffer,
  type DuplicateVia,
  type ImportedOriginalProvenance,
  type RetiredDraftView,
} from './duplicate-decision-types';
