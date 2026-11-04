/**
 * D-A4-1b-3 PR B: wspólne dane testów decyzji klienta przy nierozstrzygniętym
 * duplikacie 440.
 *
 * 1. `DUPLICATE_CHECK_CASES` (PR B: `PR_B_DUPLICATE_CHECK_CASES`) — tabela zgodności
 *    polityki jsonb: SQL `ksef_duplicate_check_allows(p_check, p_choice)` (00148, test bazy R6)
 *    i TypeScript `duplicateCheckAllows(raw, choice)` (test U1h) mają dać
 *    dla każdego wiersza ten sam wynik — `allows`, spisany ręcznie z sekcji
 *    2.1.1 specyfikacji. Każdy `check` przechodzi przez JSON (supabase-js), więc
 *    „brak klucza” to brak klucza, nie `undefined`. Bez wiersza `v: 1.0`
 *    (C14): supabase-js wysyła `1.0` jako `1` — ten przypadek sprawdza R6b
 *    literałem SQL.
 * 2. Budowniczowie faktów i wpisów `ksef_submissions` dla czystej polityki
 *    (`duplicateDecisionOptions`, `retiredDraftView`, `retiredDraftSendRefusal`)
 *    w kształcie wierszy, które czyta ładowarka (`loadDuplicateDecisionFacts`,
 *    sekcja 2.3): faktura z kolumnami `DUPLICATE_DECISION_INVOICE_COLUMNS`,
 *    WSZYSTKIE wpisy faktury z surowym `original_check` (jsonb) i odczyt
 *    faktury Y (`holdsOriginal`) przy powodzie `known-number`.
 *
 * Typy fakt i wpisów są tu strukturalne (bez importu modułu polityki) — importuje
 * ten plik także test bazy (R6). NIP fikcyjny (1234567890).
 *
 * D-A4-1b-3 PR C (`faktflow-original`, spec v3 7.1–7.4): tabele wspólne grup B
 * (polityka TS), A (testy bazy R-C6, R-C15) i C (projekcja) — wiersze
 * `FAKTFLOW_CHECK_CASES` w `DUPLICATE_CHECK_CASES` (R-C15 `allows`),
 * `faktflowOfferCases()` (oferta i `originalGateOk`), `originalImportMismatchCases()`
 * (lustro 4.8) oraz budowniczowie `faktflowCheck`/`faktflowGate`/`faktflowFacts`/
 * `numberTakenFaktflowRow`. Wszystkie oczekiwania są spisane RĘCZNIE ze
 * specyfikacji (4.2, 4.4, 4.4a, 4.8) — nigdy liczone kodem pod testem. Tabele
 * z fabryk powstają LENIWIE (wywołanie fabryki), nigdy przy imporcie modułu.
 */

import { createHash } from 'node:crypto';

import { parseFa3Xml } from '@/lib/import/fa3-parser';
import { importedInvoiceContent } from '@/lib/import/imported-invoice-row';
import { buildInvoiceAnnotations } from '@/lib/invoices/annotations';
import type {
  DuplicateOriginalImportOffer,
  DuplicateOriginalOffer,
  KsefDuplicateCheck,
} from '@/lib/ksef/duplicate-check';
import { buildOriginalImportProjection } from '@/lib/ksef/duplicate-original-projection';
import type {
  OriginalImportProblem,
  OriginalImportProblemContext,
} from '@/lib/ksef/duplicate-original-projection';
import { summarizeInvoiceXml } from '@/lib/ksef/duplicate-verdict';
import { FA3_ONLY_VAT_RATES, VAT_RATES } from '@/lib/xml/fa3-p12';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import type { Invoice } from '@/types/invoice';

/** Wybór klienta — to samo co `DuplicateChoice` z `lib/ksef/duplicate-decision.ts`. */
export type DuplicateCaseChoice = 'same_sale' | 'other_sale';

export interface DuplicateCheckCase {
  name: string;
  /** Surowa wartość `ksef_submissions.original_check` (jsonb) — także nieobiektowa. */
  check: unknown;
  /** `null` = „dowolny wybór” (blokada, I5D). */
  choice: DuplicateCaseChoice | null;
  allows: boolean;
}

export const DUP_TENANT_ID = '13131313-1313-4313-8313-131313131313';
export const DUP_INVOICE_ID = '7a7a7a7a-0000-4000-8000-000000000001';
/** Faktura Y — w FaktWay ma już numer KSeF oryginału (`known-number`). */
export const DUP_KNOWN_ID = '7a7a7a7a-0000-4000-8000-000000000002';
export const DUP_KNOWN_NUMBER = 'FV/INNA/1';
/** Numer naszego dokumentu (P_2), zajęty w KSeF. */
export const DUP_NR = 'FV/2026/10/7';
/** Numer KSeF oryginału (K). */
export const DUP_K = '1234567890-20261001-0100A0B0C0D0-1A';
/** Drugi numer KSeF — inny oryginał. */
export const DUP_K2 = '1234567890-20261002-0200A0B0C0D0-2B';
/** SHA-256 (hex) bajtów oryginału. */
export const DUP_SHA = 'bb'.repeat(32);
/** Program oryginału spoza FaktWay. */
export const DUP_PROGRAM = 'Inny Program 1.0';
/** Moment decyzji zapisany w `original_check.decision.at`. */
export const DUP_DECIDED_AT = '2026-10-05T10:00:00.000Z';

const KNOWN_INVOICE = { id: DUP_KNOWN_ID, internalNumber: DUP_KNOWN_NUMBER };

/** Zapis runnera po udanym sprawdzeniu oryginału (`no-own-file`, dane kompletne). */
export function validCheck(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    env: 'test',
    checkedAt: '2026-10-02T08:00:00.000Z',
    reason: 'no-own-file',
    sha256: DUP_SHA,
    archivePath: `${DUP_TENANT_ID}/ksef-import/${DUP_K}.xml`,
    sizeBytes: 2048,
    summary: {
      systemInfo: DUP_PROGRAM,
      number: DUP_NR,
      issueDate: '2026-10-01',
      buyerNip: '1234567890',
      buyerName: 'Nabywca Testowy Sp. z o.o.',
      gross: '1230.00',
      currency: 'PLN',
    },
    sameContentExceptHeader: null,
    ownHistory: false,
    acquiredAt: '2026-10-01T09:00:00.000Z',
    httpStatus: null,
    knownInvoice: null,
    recheck: null,
    ...over,
  };
}

/** Zapis `known-number` z danymi oryginału (od PR B runner pobiera K także wtedy). */
export function knownNumberCheck(over: Record<string, unknown> = {}): Record<string, unknown> {
  return validCheck({ reason: 'known-number', knownInvoice: { ...KNOWN_INVOICE }, sameContentExceptHeader: false, ...over });
}

/** Kopia bez wskazanego klucza (jsonb bez klucza ≠ klucz z `null`). */
export function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

const ALL_CHOICES: ReadonlyArray<DuplicateCaseChoice | null> = [null, 'same_sale', 'other_sale'];

/**
 * Powody bez decyzji klienta (każdy wybór odmawia). PR C (spec 7.4):
 * `faktflow-original` zostaje w tej liście — `validCheck` ma SystemInfo
 * `Inny Program 1.0`, czyli „faktflow-original bez SystemInfo FaktFlow”, które
 * `ksef_duplicate_check_allows` (00149, 4.2) nadal odrzuca; dopuszczone
 * `faktflow-original` (SystemInfo FaktFlow, `archivePath`, `sizeBytes`) opisuje
 * `FAKTFLOW_CHECK_CASES` niżej.
 */
const OTHER_REASONS = [
  'download-refused',
  'download-pending',
  'storage-pending',
  'archive-pending',
  'faktflow-original',
  'same-content-other-program',
  'archive-conflict',
] as const;

const DECISION = { choice: 'other_sale', via: 'client', at: DUP_DECIDED_AT, reason: 'no-own-file', env: 'test' };

// ─── PR C: budowniczowie `faktflow-original` ───────────────────────────────────
// Funkcje (nie stałe), żeby wiersze tabel niżej mogły ich używać już przy ładowaniu modułu.

/** `<SystemInfo>` plików FaktFlow (SQL 00149 przyjmuje też przyszłe `FaktFlow <wersja>`, D-A4-1b-3-SYS). */
export const DUP_FAKTFLOW_SYSTEM_INFO = 'KSeF SaaS v1.0';
/** Faktura K zapisana z KSeF (`decision.importedInvoiceId`). */
export const DUP_IMPORTED_ID = '7a7a7a7a-0000-4000-8000-000000000003';
/** Identyfikator operatora (`actorUserId` oddania i decyzji). */
export const DUP_OPERATOR_ID = '7a7a7a7a-0000-4000-8000-0000000000a1';
/** Identyfikator użytkownika klienta (`actorUserId` decyzji klienta). */
export const DUP_CLIENT_USER_ID = '7a7a7a7a-0000-4000-8000-0000000000c1';
/** Moment oddania decyzji przez operatora (`importGate.release.at`). */
export const DUP_RELEASED_AT = '2026-10-09T08:00:00.000Z';
/** Notatka oddania / zapisu operatora (≥ 10 znaków). */
export const DUP_OPERATOR_NOTE = 'Plik z oznaczeniem FaktFlow sprawdzony ręcznie, klient poinformowany.';

type Json = Record<string, unknown>;

/** Podgląd oryginału (`importGate.preview`): data sprzedaży `null` = jak data wystawienia, nabywca z NIP, 2 pozycje. */
export function faktflowPreview(over: Json = {}): Json {
  return {
    issueDate: '2026-10-01',
    saleDate: null,
    period: '10.2026',
    buyerIdKind: 'nip',
    annotations: [],
    exemptionBasis: null,
    lineCount: 2,
    lines: [
      { ordinal: 1, name: 'Usługa wdrożeniowa', quantity: '1', unit: 'usł.', unitPriceNet: '600.00', vatRate: '23', gross: '738.00' },
      { ordinal: 2, name: 'Szkolenie', quantity: '2', unit: 'godz.', unitPriceNet: '200.00', vatRate: '23', gross: '492.00' },
    ],
    totals: { net: '1000.00', vat: '230.00', gross: '1230.00' },
    ...over,
  };
}

/** Brama `importable` (plik wygląda na plik z generatora FaktFlow). */
export function faktflowGate(over: Json = {}): Json {
  return { v: 1, rules: 1, kind: 'importable', problems: [], preview: faktflowPreview(), ...over };
}

/** Brama `review` (poprawny kształt: `kind = review` ⇔ `problems` niepuste). */
export function faktflowReviewGate(problems: string[] = ['rates'], over: Json = {}): Json {
  return { v: 1, rules: 1, kind: 'review', problems, preview: faktflowPreview(), ...over };
}

/** `importGate.release` — oddanie decyzji klientowi przez operatora (4.7). */
export function faktflowRelease(over: Json = {}): Json {
  return { at: DUP_RELEASED_AT, via: 'operator', actorUserId: DUP_OPERATOR_ID, note: DUP_OPERATOR_NOTE, ...over };
}

/**
 * `original_check` powodu `faktflow-original` z oceną pliku: SystemInfo FaktFlow,
 * `archivePath` i `sizeBytes` z `validCheck`, `ownHistory = false`,
 * `sameContentExceptHeader = false`, brama `importable` (oferta `pair`).
 */
export function faktflowCheck(over: Json = {}): Json {
  return validCheck({
    reason: 'faktflow-original',
    summary: { ...(validCheck().summary as Json), systemInfo: DUP_FAKTFLOW_SYSTEM_INFO },
    sameContentExceptHeader: false,
    ownHistory: false,
    importGate: faktflowGate(),
    ...over,
  });
}

/**
 * Fakty decydowalnej faktury `faktflow-original`: znacznik z `faktflowCheck`,
 * `sqlBlocker` domyślnie `null` (czeka na decyzję); `sqlBlocker: undefined` =
 * blokady nie odczytano (`state-unknown`). `history` dopisuje do wpisów faktury
 * własną historię w bazie (T3, INV-19): `session` — sesja oryginału, `hash` —
 * skrót oryginału w `request_payload_hash` jednej z prób.
 */
export function faktflowFacts(over: {
  check?: Json;
  invoice?: Partial<DuplicateFactsInvoice>;
  sqlBlocker?: string | null;
  history?: 'session' | 'hash';
  marker?: Partial<DuplicateFactsSubmission>;
  extra?: DuplicateFactsSubmission[];
} = {}): DuplicateFactsShape {
  const history: DuplicateFactsSubmission[] = [];
  if (over.history === 'session') {
    history.push(olderSentRow({ id: 'sub-0-sesja-oryginalu', status: 'abandoned', session_reference_number: 'SES-ORIG-1' }));
  }
  if (over.history === 'hash') {
    history.push(olderSentRow({ id: 'sub-0-plik-oryginalu', status: 'abandoned', request_payload_hash: DUP_SHA.toUpperCase() }));
  }
  const facts = decisionFacts({
    check: faktflowCheck(over.check),
    invoice: over.invoice,
    marker: over.marker,
    extra: [...history, ...(over.extra ?? [])],
  });
  return { ...facts, sqlBlocker: 'sqlBlocker' in over ? over.sqlBlocker : null };
}

/**
 * Wpis `number_taken` szkicu wycofanego po decyzji `faktflow-original` (4.6 krok 7):
 *  - `import` — zapis oryginału K (`importedInvoiceId`, `retiredInternalNumber`; oferta `pair` / `record` /
 *    `review-pair` / `review-record`), `decision.original.buyerIdKind` = `buyerIdKind`;
 *  - `no-import` — po oddaniu (oferta `released`), `decision.release` w całości, bez K.
 */
export function numberTakenFaktflowRow(
  mode: 'import' | 'no-import',
  over: {
    id?: string;
    k?: string;
    choice?: DuplicateCaseChoice;
    via?: 'client' | 'operator';
    offer?: DuplicateOriginalOffer;
    at?: string;
    completedAt?: string | null;
    importedInvoiceId?: string | null;
    retiredInternalNumber?: string | null;
    buyerIdKind?: string | null;
    summaryNumber?: string | null;
    check?: Json;
  } = {},
): DuplicateFactsSubmission {
  const k = over.k ?? DUP_K;
  const via = over.via ?? 'client';
  const offer = over.offer ?? (mode === 'import' ? 'pair' : 'released');
  const check = faktflowCheck({
    ...(over.summaryNumber === undefined ? {} : { summary: { ...(validCheck().summary as Json), systemInfo: DUP_FAKTFLOW_SYSTEM_INFO, number: over.summaryNumber } }),
    ...(over.check ?? {}),
  });
  const decision: Json = {
    choice: over.choice ?? 'same_sale',
    via,
    at: over.at ?? DUP_DECIDED_AT,
    reason: 'faktflow-original',
    env: 'test',
    mode,
    offer,
    actorUserId: via === 'operator' ? DUP_OPERATOR_ID : DUP_CLIENT_USER_ID,
    note: via === 'operator' ? DUP_OPERATOR_NOTE : null,
    original: {
      sha256: DUP_SHA,
      archivePath: check.archivePath,
      sizeBytes: 2048,
      acquiredAt: '2026-10-01T09:00:00.000Z',
      session: 'SES-ORIG-1',
      gateRules: 1,
      gateProblems: [],
      buyerIdKind: over.buyerIdKind === undefined ? 'nip' : over.buyerIdKind,
    },
    retired: {
      internalNumber: DUP_NR,
      issueDate: '2026-10-01',
      saleDate: null,
      buyerNip: '1234567890',
      buyerName: 'Nabywca Testowy Sp. z o.o.',
      netTotal: 1000,
      vatTotal: 230,
      grossTotal: 1230,
      currency: 'PLN',
      lineCount: 1,
      lines: [{ ordinal: 1, name: 'Usługa wdrożeniowa', unit: 'usł.', quantity: 1, unitPriceNet: 1000, netAmount: 1000, vatRate: '23', vatAmount: 230, grossAmount: 1230 }],
    },
  };
  if (mode === 'import') {
    decision.importedInvoiceId = over.importedInvoiceId === undefined ? DUP_IMPORTED_ID : over.importedInvoiceId;
    decision.retiredInternalNumber = over.retiredInternalNumber === undefined ? DUP_NR : over.retiredInternalNumber;
  } else {
    decision.release = faktflowRelease();
  }
  for (const key of Object.keys(decision)) {
    if (decision[key] === null && (key === 'importedInvoiceId' || key === 'retiredInternalNumber')) delete decision[key];
  }
  return {
    id: over.id ?? 'nt-decyzja-faktflow',
    status: 'number_taken',
    session_reference_number: 'SES-nt-decyzja-faktflow',
    request_payload_hash: 'aa'.repeat(32),
    response_ksef_number: null,
    original_ksef_number: k,
    original_session_reference_number: 'SES-ORIG-1',
    original_check: { ...check, decision },
    attempted_at: '2026-10-01T10:00:00.000Z',
    completed_at: over.completedAt === undefined ? DUP_DECIDED_AT : over.completedAt,
  };
}

// ─── PR C: wiersze `faktflow-original` (spec 4.2) ──────────────────────────────

const FF_SUMMARY = { ...(validCheck().summary as Record<string, unknown>), systemInfo: 'KSeF SaaS v1.0' };
const FF_ARCHIVE_DIR = `${DUP_TENANT_ID}/ksef-import`;

interface ChoiceExpectation {
  /** Wybór `null` = „dowolny” (blokada, I5D). */
  any: boolean;
  same: boolean;
  other: boolean;
}

/** Trzy wiersze (wybór dowolny / ta sama / inna) jednego zapisu. */
function ffRows(name: string, check: unknown, expected: ChoiceExpectation): DuplicateCheckCase[] {
  return [
    { name: `${name}, wybór dowolny`, check, choice: null, allows: expected.any },
    { name: `${name}, wybór same_sale`, check, choice: 'same_sale', allows: expected.same },
    { name: `${name}, wybór other_sale`, check, choice: 'other_sale', allows: expected.other },
  ];
}

const ALL_ALLOWED: ChoiceExpectation = { any: true, same: true, other: true };
/** `other_sale` odmawia: oryginał może być nasz albo ma tę samą treść (część JSON reguły „tylko zapis”, 4.2). */
const RECORD_ONLY: ChoiceExpectation = { any: true, same: true, other: false };
const NONE_ALLOWED: ChoiceExpectation = { any: false, same: false, other: false };

/**
 * Oczekiwania z 4.2 dla powodu `faktflow-original` (SQL `ksef_duplicate_check_allows`
 * 00149 = `duplicateCheckAllows`): SystemInfo `KSeF SaaS v1.0` albo `FaktFlow <cyfra>…`,
 * `archivePath` `<36 znaków [0-9a-f-]>/ksef-import/<1–64 znaków [A-Za-z0-9-]>.xml`,
 * `sizeBytes` liczba całkowita 1…2147483647, `ownHistory` boolean, `sameContentExceptHeader`
 * boolean / null / brak klucza; `other_sale` tylko przy `ownHistory = false` i
 * `sameContentExceptHeader` ≠ true. `importGate` NIE wchodzi do `allows` (blokada
 * `recheck-needed` i oferta rozstrzygają stan bramy) — znacznik bez bramy albo z bramą
 * w złym kształcie przechodzi. Bez wiersza `v: 1.0` (jak wyżej).
 */
export const FAKTFLOW_CHECK_CASES: ReadonlyArray<DuplicateCheckCase> = [
  // Dopuszczone: SystemInfo FaktFlow, ownHistory i treść.
  ...ffRows('faktflow-original (SystemInfo FaktFlow, ownHistory false, treść różna)', faktflowCheck(), ALL_ALLOWED),
  ...ffRows('faktflow-original, sameContentExceptHeader null', faktflowCheck({ sameContentExceptHeader: null }), ALL_ALLOWED),
  ...ffRows('faktflow-original, sameContentExceptHeader brak klucza', withoutKey(faktflowCheck(), 'sameContentExceptHeader'), ALL_ALLOWED),
  ...ffRows('faktflow-original, sameContentExceptHeader true', faktflowCheck({ sameContentExceptHeader: true }), RECORD_ONLY),
  ...ffRows('faktflow-original, ownHistory true', faktflowCheck({ ownHistory: true }), RECORD_ONLY),
  ...ffRows('faktflow-original, ownHistory true i sameContentExceptHeader true', faktflowCheck({ ownHistory: true, sameContentExceptHeader: true }), RECORD_ONLY),
  // SystemInfo: przyszła postać `FaktFlow <wersja>` (D-A4-1b-3-SYS).
  ...ffRows('faktflow-original, SystemInfo FaktFlow 2.0', faktflowCheck({ summary: { ...FF_SUMMARY, systemInfo: 'FaktFlow 2.0' } }), ALL_ALLOWED),
  ...ffRows('faktflow-original, SystemInfo FaktFlow 1', faktflowCheck({ summary: { ...FF_SUMMARY, systemInfo: 'FaktFlow 1' } }), ALL_ALLOWED),
  // importGate nie wchodzi do `allows` (INV-10 c): brak, zły kształt i ocena review przechodzą.
  ...ffRows('faktflow-original, bez importGate (sprzed 00149)', withoutKey(faktflowCheck(), 'importGate'), ALL_ALLOWED),
  ...ffRows('faktflow-original, importGate w złym kształcie (v 2)', faktflowCheck({ importGate: { v: 2, kind: 'importable' } }), ALL_ALLOWED),
  ...ffRows('faktflow-original, importGate review', faktflowCheck({ importGate: faktflowReviewGate(['rates']) }), ALL_ALLOWED),
  ...ffRows('faktflow-original, recheckNeeded na znaczniku', faktflowCheck({ recheckNeeded: { kind: 'gate-drift', at: '2026-10-09T08:00:00.000Z' } }), ALL_ALLOWED),
  // SystemInfo odrzucane.
  { name: 'faktflow-original, SystemInfo FaktFlow v2 (po spacji nie cyfra)', check: faktflowCheck({ summary: { ...FF_SUMMARY, systemInfo: 'FaktFlow v2' } }), choice: null, allows: false },
  { name: 'faktflow-original, SystemInfo samo FaktFlow', check: faktflowCheck({ summary: { ...FF_SUMMARY, systemInfo: 'FaktFlow' } }), choice: null, allows: false },
  { name: 'faktflow-original, SystemInfo faktflow 2.0 (małe litery)', check: faktflowCheck({ summary: { ...FF_SUMMARY, systemInfo: 'faktflow 2.0' } }), choice: null, allows: false },
  { name: 'faktflow-original, SystemInfo KSeF SaaS v1.1', check: faktflowCheck({ summary: { ...FF_SUMMARY, systemInfo: 'KSeF SaaS v1.1' } }), choice: null, allows: false },
  { name: 'faktflow-original, SystemInfo ze spacją na początku', check: faktflowCheck({ summary: { ...FF_SUMMARY, systemInfo: ' KSeF SaaS v1.0' } }), choice: null, allows: false },
  { name: 'faktflow-original, SystemInfo obcy program', check: faktflowCheck({ summary: { ...FF_SUMMARY, systemInfo: DUP_PROGRAM } }), choice: null, allows: false },
  { name: 'faktflow-original, SystemInfo null', check: faktflowCheck({ summary: { ...FF_SUMMARY, systemInfo: null } }), choice: null, allows: false },
  { name: 'faktflow-original, summary bez SystemInfo', check: faktflowCheck({ summary: withoutKey(FF_SUMMARY, 'systemInfo') }), choice: null, allows: false },
  { name: 'faktflow-original, summary null', check: faktflowCheck({ summary: null }), choice: null, allows: false },
  // archivePath.
  { name: 'faktflow-original, archivePath poprawny z nazwą 64 znaki', check: faktflowCheck({ archivePath: `${FF_ARCHIVE_DIR}/${'A'.repeat(64)}.xml` }), choice: 'same_sale', allows: true },
  { name: 'faktflow-original, archivePath z katalogiem 36 znaków a', check: faktflowCheck({ archivePath: `${'a'.repeat(36)}/ksef-import/${DUP_K}.xml` }), choice: null, allows: true },
  { name: 'faktflow-original, archivePath null', check: faktflowCheck({ archivePath: null }), choice: null, allows: false },
  { name: 'faktflow-original, archivePath brak klucza', check: withoutKey(faktflowCheck(), 'archivePath'), choice: null, allows: false },
  { name: 'faktflow-original, archivePath liczbą', check: faktflowCheck({ archivePath: 123 }), choice: null, allows: false },
  { name: 'faktflow-original, archivePath pusty', check: faktflowCheck({ archivePath: '' }), choice: null, allows: false },
  { name: 'faktflow-original, archivePath z katalogiem 35 znaków', check: faktflowCheck({ archivePath: `${DUP_TENANT_ID.slice(1)}/ksef-import/${DUP_K}.xml` }), choice: null, allows: false },
  { name: 'faktflow-original, archivePath z katalogiem 37 znaków', check: faktflowCheck({ archivePath: `a${DUP_TENANT_ID}/ksef-import/${DUP_K}.xml` }), choice: null, allows: false },
  { name: 'faktflow-original, archivePath z wielkimi literami w katalogu', check: faktflowCheck({ archivePath: `ABCDEF13-1313-4313-8313-131313131313/ksef-import/${DUP_K}.xml` }), choice: null, allows: false },
  { name: 'faktflow-original, archivePath z nazwą 65 znaków', check: faktflowCheck({ archivePath: `${FF_ARCHIVE_DIR}/${'A'.repeat(65)}.xml` }), choice: null, allows: false },
  { name: 'faktflow-original, archivePath z rozszerzeniem .XML', check: faktflowCheck({ archivePath: `${FF_ARCHIVE_DIR}/${DUP_K}.XML` }), choice: null, allows: false },
  { name: 'faktflow-original, archivePath z podkreśleniem w nazwie', check: faktflowCheck({ archivePath: `${FF_ARCHIVE_DIR}/NR_${DUP_K}.xml` }), choice: null, allows: false },
  { name: 'faktflow-original, archivePath z dodatkowym segmentem', check: faktflowCheck({ archivePath: `${FF_ARCHIVE_DIR}/x/${DUP_K}.xml` }), choice: null, allows: false },
  { name: 'faktflow-original, archivePath inny katalog niż ksef-import', check: faktflowCheck({ archivePath: `${DUP_TENANT_ID}/inne/${DUP_K}.xml` }), choice: null, allows: false },
  { name: 'faktflow-original, archivePath bez rozszerzenia', check: faktflowCheck({ archivePath: `${FF_ARCHIVE_DIR}/${DUP_K}` }), choice: null, allows: false },
  { name: 'faktflow-original, archivePath z pustą nazwą', check: faktflowCheck({ archivePath: `${FF_ARCHIVE_DIR}/.xml` }), choice: null, allows: false },
  // sizeBytes.
  { name: 'faktflow-original, sizeBytes 1', check: faktflowCheck({ sizeBytes: 1 }), choice: 'other_sale', allows: true },
  { name: 'faktflow-original, sizeBytes 2147483647 (granica int)', check: faktflowCheck({ sizeBytes: 2147483647 }), choice: 'same_sale', allows: true },
  { name: 'faktflow-original, sizeBytes 2147483648', check: faktflowCheck({ sizeBytes: 2147483648 }), choice: null, allows: false },
  { name: 'faktflow-original, sizeBytes 10 cyfr ponad int', check: faktflowCheck({ sizeBytes: 9999999999 }), choice: null, allows: false },
  { name: 'faktflow-original, sizeBytes 11 cyfr', check: faktflowCheck({ sizeBytes: 10000000000 }), choice: null, allows: false },
  { name: 'faktflow-original, sizeBytes 0', check: faktflowCheck({ sizeBytes: 0 }), choice: null, allows: false },
  { name: 'faktflow-original, sizeBytes ujemny', check: faktflowCheck({ sizeBytes: -1 }), choice: null, allows: false },
  { name: 'faktflow-original, sizeBytes ułamkiem', check: faktflowCheck({ sizeBytes: 1.5 }), choice: null, allows: false },
  { name: 'faktflow-original, sizeBytes napisem', check: faktflowCheck({ sizeBytes: '2048' }), choice: null, allows: false },
  { name: 'faktflow-original, sizeBytes null', check: faktflowCheck({ sizeBytes: null }), choice: null, allows: false },
  { name: 'faktflow-original, sizeBytes brak klucza', check: withoutKey(faktflowCheck(), 'sizeBytes'), choice: null, allows: false },
  { name: 'faktflow-original, sizeBytes boolean', check: faktflowCheck({ sizeBytes: true }), choice: null, allows: false },
  // ownHistory i sameContentExceptHeader: tylko boolean (ownHistory) albo boolean / null (treść).
  { name: 'faktflow-original, ownHistory null', check: faktflowCheck({ ownHistory: null }), choice: null, allows: false },
  { name: 'faktflow-original, ownHistory brak klucza', check: withoutKey(faktflowCheck(), 'ownHistory'), choice: null, allows: false },
  { name: 'faktflow-original, ownHistory napisem false', check: faktflowCheck({ ownHistory: 'false' }), choice: null, allows: false },
  { name: 'faktflow-original, ownHistory 0', check: faktflowCheck({ ownHistory: 0 }), choice: null, allows: false },
  { name: 'faktflow-original, sameContentExceptHeader napisem true', check: faktflowCheck({ sameContentExceptHeader: 'true' }), choice: null, allows: false },
  { name: 'faktflow-original, sameContentExceptHeader liczbą 1', check: faktflowCheck({ sameContentExceptHeader: 1 }), choice: null, allows: false },
  { name: 'faktflow-original, sameContentExceptHeader tablicą', check: faktflowCheck({ sameContentExceptHeader: [] }), choice: null, allows: false },
  // Wymagania wspólne z PR B także dla faktflow-original.
  { name: 'faktflow-original, sha256 null', check: faktflowCheck({ sha256: null }), choice: null, allows: false },
  { name: 'faktflow-original, sha256 wielkimi literami', check: faktflowCheck({ sha256: 'BB'.repeat(32) }), choice: null, allows: false },
  { name: 'faktflow-original, sha256 brak klucza', check: withoutKey(faktflowCheck(), 'sha256'), choice: null, allows: false },
  { name: 'faktflow-original, v: 2', check: faktflowCheck({ v: 2 }), choice: null, allows: false },
  ...ffRows('faktflow-original, decision zapisana', faktflowCheck({ decision: { ...DECISION, reason: 'faktflow-original' } }), NONE_ALLOWED),
];

/**
 * Tabela PR B (bez wierszy `faktflow-original`): oczekiwania z 2.1.1 — obiekt,
 * `v` = 1 (liczba), bez klucza `decision`, powód no-own-file albo known-number,
 * `sha256` = 64 małe znaki hex (napis), `summary` obiektem, `ownHistory` = false;
 * przy known-number `knownInvoice.id` niepustym napisem. `recheck` nie blokuje.
 * Test bazy R6 (`rls-decyzja-duplikatu`) jest strażnikiem PR B (zielony przed
 * i po PR C) i iteruje TĘ listę — wiersze `faktflow-original` sprawdza R-C15
 * w `rls-zapis-oryginalu` na pełnej `DUPLICATE_CHECK_CASES`.
 */
export const PR_B_DUPLICATE_CHECK_CASES: ReadonlyArray<DuplicateCheckCase> = [
  // Powody PR B × wybór.
  ...ALL_CHOICES.map((choice) => ({ name: `no-own-file, wybór ${choice ?? 'dowolny'}`, check: validCheck(), choice, allows: true })),
  ...ALL_CHOICES.map((choice) => ({ name: `known-number z knownInvoice, wybór ${choice ?? 'dowolny'}`, check: knownNumberCheck(), choice, allows: true })),
  // Pozostałe powody × wybór — decyzji w panelu nie ma.
  ...OTHER_REASONS.flatMap((reason) => ALL_CHOICES.map((choice) => ({
    name: `${reason}, wybór ${choice ?? 'dowolny'}`, check: validCheck({ reason }), choice, allows: false,
  }))),
  { name: 'powód nieznany', check: validCheck({ reason: 'cokolwiek' }), choice: null, allows: false },
  { name: 'powód nie jest napisem', check: validCheck({ reason: 7 }), choice: null, allows: false },
  // ownHistory: tylko false dopuszcza (true = oryginał może być nasz, null = nie wiadomo).
  { name: 'ownHistory true', check: validCheck({ ownHistory: true }), choice: null, allows: false },
  { name: 'ownHistory true, known-number', check: knownNumberCheck({ ownHistory: true }), choice: 'same_sale', allows: false },
  { name: 'ownHistory null', check: validCheck({ ownHistory: null }), choice: null, allows: false },
  { name: 'ownHistory brak klucza', check: withoutKey(validCheck(), 'ownHistory'), choice: null, allows: false },
  { name: 'ownHistory 0 (liczba)', check: validCheck({ ownHistory: 0 }), choice: null, allows: false },
  // sha256: dane oryginału są wymagane.
  { name: 'sha256 brak klucza', check: withoutKey(validCheck(), 'sha256'), choice: null, allows: false },
  { name: 'sha256 null (zapis PR A bez pobrania)', check: validCheck({ sha256: null }), choice: null, allows: false },
  { name: 'sha256 wielkimi literami', check: validCheck({ sha256: 'BB'.repeat(32) }), choice: null, allows: false },
  { name: 'sha256 liczbą', check: validCheck({ sha256: 1234 }), choice: null, allows: false },
  { name: 'sha256 za krótki', check: validCheck({ sha256: 'bb'.repeat(31) }), choice: null, allows: false },
  { name: 'sha256 z cudzym znakiem', check: validCheck({ sha256: `${'bb'.repeat(31)}bz` }), choice: null, allows: false },
  // summary: obiekt.
  { name: 'summary brak klucza', check: withoutKey(validCheck(), 'summary'), choice: null, allows: false },
  { name: 'summary null', check: validCheck({ summary: null }), choice: null, allows: false },
  { name: 'summary tablicą', check: validCheck({ summary: [] }), choice: null, allows: false },
  { name: 'summary napisem', check: validCheck({ summary: 'FV/2026/10/7' }), choice: null, allows: false },
  // decision: obecność klucza = dokument już wycofany decyzją (także wartość zniekształcona).
  { name: 'decision zapisana', check: validCheck({ decision: { ...DECISION } }), choice: null, allows: false },
  { name: 'decision zapisana, ten sam wybór', check: validCheck({ decision: { ...DECISION } }), choice: 'other_sale', allows: false },
  { name: 'decision napisem (zniekształcona)', check: validCheck({ decision: 'other_sale' }), choice: null, allows: false },
  { name: 'decision null', check: validCheck({ decision: null }), choice: null, allows: false },
  { name: 'decision pustym obiektem', check: validCheck({ decision: {} }), choice: 'same_sale', allows: false },
  // Wersja zapisu i kształt.
  { name: 'v: 2', check: validCheck({ v: 2 }), choice: null, allows: false },
  { name: 'v: "1" (napis)', check: validCheck({ v: '1' }), choice: null, allows: false },
  { name: 'v brak klucza', check: withoutKey(validCheck(), 'v'), choice: null, allows: false },
  { name: 'check null (wpis sprzed 00144)', check: null, choice: null, allows: false },
  { name: 'check napisem', check: 'no-own-file', choice: null, allows: false },
  { name: 'check tablicą', check: [validCheck()], choice: null, allows: false },
  { name: 'check pustym obiektem', check: {}, choice: 'other_sale', allows: false },
  // known-number: knownInvoice.id niepustym napisem.
  { name: 'known-number bez knownInvoice', check: withoutKey(knownNumberCheck(), 'knownInvoice'), choice: null, allows: false },
  { name: 'known-number, knownInvoice null', check: knownNumberCheck({ knownInvoice: null }), choice: 'same_sale', allows: false },
  { name: 'known-number, knownInvoice.id liczbą', check: knownNumberCheck({ knownInvoice: { id: 123, internalNumber: DUP_KNOWN_NUMBER } }), choice: null, allows: false },
  { name: 'known-number, knownInvoice.id pusty', check: knownNumberCheck({ knownInvoice: { id: '', internalNumber: DUP_KNOWN_NUMBER } }), choice: 'other_sale', allows: false },
  { name: 'known-number, knownInvoice bez id', check: knownNumberCheck({ knownInvoice: { internalNumber: DUP_KNOWN_NUMBER } }), choice: null, allows: false },
  { name: 'known-number, knownInvoice tablicą', check: knownNumberCheck({ knownInvoice: [{ ...KNOWN_INVOICE }] }), choice: null, allows: false },
  { name: 'known-number bez danych oryginału (zapis PR A)', check: knownNumberCheck({ sha256: null, summary: null, archivePath: null, ownHistory: null }), choice: null, allows: false },
  // no-own-file nie patrzy na knownInvoice (C2).
  { name: 'no-own-file z knownInvoice.id liczbą', check: validCheck({ knownInvoice: { id: 123 } }), choice: 'same_sale', allows: true },
  { name: 'no-own-file z knownInvoice', check: validCheck({ knownInvoice: { ...KNOWN_INVOICE } }), choice: 'other_sale', allows: true },
  // Nieudane ponowne sprawdzenie zostawia dane wcześniejszego udanego — nie blokuje.
  {
    name: 'recheck po nieudanym ponownym sprawdzeniu',
    check: validCheck({ recheck: { reason: 'download-pending', httpStatus: 503, checkedAt: '2026-10-06T10:00:00.000Z' } }),
    choice: 'same_sale',
    allows: true,
  },
  { name: 'oryginał z FaktWay przy known-number (decyzja 12)', check: knownNumberCheck({ summary: { ...(validCheck().summary as Record<string, unknown>), systemInfo: 'KSeF SaaS v1.0' } }), choice: 'other_sale', allows: true },
  { name: 'nieznane klucze dodatkowe', check: validCheck({ cokolwiek: true }), choice: null, allows: true },
];

/**
 * Pełna tabela zgodności polityki jsonb: PR B plus PR C (00149, 4.2) —
 * `faktflow-original` z SystemInfo FaktFlow, `archivePath` i `sizeBytes`.
 * TS (`duplicateCheckAllows`, U1h) i SQL (R-C15) mają dać `allows` dla każdego wiersza.
 */
export const DUPLICATE_CHECK_CASES: ReadonlyArray<DuplicateCheckCase> = [
  ...PR_B_DUPLICATE_CHECK_CASES,
  ...FAKTFLOW_CHECK_CASES,
];

// ──────────────────────────────────────────────────────────────────────────
// Fakty czystej polityki — kształt wierszy ładowarki (2.3).

/** Wiersz faktury — kolumny `DUPLICATE_DECISION_INVOICE_COLUMNS` (2.3). */
export interface DuplicateFactsInvoice {
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
  paid_amount: number | null;
  issue_date: string | null;
  sale_date: string | null;
  buyer_nip: string | null;
  buyer_data: Record<string, unknown> | null;
  gross_total: number | null;
  currency: string | null;
}

/** Wpis `ksef_submissions` — kolumny czytane przez ładowarkę (2.3); `original_check` surowy. */
export interface DuplicateFactsSubmission {
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

/** Faktura Y odczytana przez ładowarkę; `holdsOriginal` = wychodząca, przyjęta, z numerem K, inna niż X. */
export interface DuplicateFactsKnownInvoice {
  id: string;
  internalNumber: string | null;
  holdsOriginal: boolean;
}

export interface DuplicateFactsShape {
  invoice: DuplicateFactsInvoice;
  submissions: DuplicateFactsSubmission[];
  knownInvoice: DuplicateFactsKnownInvoice | null;
  /**
   * PR C (5.4): kod `ksef_duplicate_decision_blocker` odczytany przy znaczniku
   * `faktflow-original`; `null` = czeka na decyzję, brak klucza / `undefined` = nie odczytano.
   */
  sqlBlocker?: string | null;
}

/** Faktura czekająca na decyzję: failed `KSEF_DUPLICATE_RECONCILE`, zwykła, bez wpłat. */
export function decisionInvoice(over: Partial<DuplicateFactsInvoice> = {}): DuplicateFactsInvoice {
  return {
    id: DUP_INVOICE_ID,
    tenant_id: DUP_TENANT_ID,
    internal_number: DUP_NR,
    direction: 'outgoing',
    ksef_status: 'failed',
    last_error_code: 'KSEF_DUPLICATE_RECONCILE',
    ksef_number: null,
    invoice_kind: 'regular',
    stripe_invoice_id: null,
    offline_idempotency_key: null,
    offline_qr_offline: null,
    offline_qr_certyfikat: null,
    paid_amount: 0,
    issue_date: '2026-10-01',
    sale_date: null,
    buyer_nip: '1234567890',
    buyer_data: { name: 'Nabywca Testowy Sp. z o.o.', nip: '1234567890' },
    gross_total: 1230,
    currency: 'PLN',
    ...over,
  };
}

/** Znacznik: najnowszy otwarty wpis `sent` z numerem oryginału i zapisem sprawdzenia. */
export function markerRow(check: unknown, over: Partial<DuplicateFactsSubmission> = {}): DuplicateFactsSubmission {
  return {
    id: 'sub-2-znacznik',
    status: 'sent',
    session_reference_number: 'SES-OWN-1',
    request_payload_hash: 'aa'.repeat(32),
    response_ksef_number: null,
    original_ksef_number: DUP_K,
    original_session_reference_number: 'SES-ORIG-1',
    original_check: check,
    attempted_at: '2026-10-01T10:00:00.000Z',
    completed_at: null,
    ...over,
  };
}

/** Starsza otwarta próba bez znacznika (decyzja zamyka i ją). */
export function olderSentRow(over: Partial<DuplicateFactsSubmission> = {}): DuplicateFactsSubmission {
  return {
    id: 'sub-1-starsza',
    status: 'sent',
    session_reference_number: 'SES-OWN-0',
    request_payload_hash: 'cc'.repeat(32),
    response_ksef_number: null,
    original_ksef_number: null,
    original_session_reference_number: null,
    original_check: null,
    attempted_at: '2026-09-30T10:00:00.000Z',
    completed_at: null,
    ...over,
  };
}

/** Fakty decydowalnej faktury `no-own-file` (domyślnie) — każde pole do nadpisania. */
export function decisionFacts(over: {
  invoice?: Partial<DuplicateFactsInvoice>;
  check?: unknown;
  marker?: Partial<DuplicateFactsSubmission>;
  /** Dodatkowe wpisy obok znacznika i starszej próby. */
  extra?: DuplicateFactsSubmission[];
  /** Pełna lista wpisów zamiast domyślnej. */
  submissions?: DuplicateFactsSubmission[];
  knownInvoice?: DuplicateFactsKnownInvoice | null;
} = {}): DuplicateFactsShape {
  const check = 'check' in over ? over.check : validCheck();
  return {
    invoice: decisionInvoice(over.invoice),
    submissions: over.submissions ?? [markerRow(check, over.marker), olderSentRow(), ...(over.extra ?? [])],
    knownInvoice: over.knownInvoice ?? null,
  };
}

/** Fakty decydowalnej faktury `known-number`: Y w FaktWay ma K i jest przyjęta (`holdsOriginal`). */
export function knownNumberFacts(holdsOriginal = true, over: { check?: Record<string, unknown>; invoice?: Partial<DuplicateFactsInvoice> } = {}): DuplicateFactsShape {
  return decisionFacts({
    invoice: over.invoice,
    check: knownNumberCheck(over.check),
    knownInvoice: { id: DUP_KNOWN_ID, internalNumber: DUP_KNOWN_NUMBER, holdsOriginal },
  });
}

/**
 * Wpis `number_taken` szkicu wycofanego (2.1.4):
 *  - `decided` — decyzja klienta (`original_check.decision`), z K;
 *  - `automatic` — automatyczny „numer zajęty” (`markKsefSubmissionsNumberTaken`), z K;
 *  - `unmarked` — zamknięty wpis bez numeru oryginału.
 */
export function numberTakenRow(
  shape: 'decided' | 'automatic' | 'unmarked',
  over: {
    id?: string;
    k?: string;
    choice?: DuplicateCaseChoice;
    via?: 'client' | 'operator';
    reason?: 'no-own-file' | 'known-number';
    completedAt?: string | null;
    at?: string;
  } = {},
): DuplicateFactsSubmission {
  const k = over.k ?? DUP_K;
  const base = (id: string): DuplicateFactsSubmission => ({
    id: over.id ?? id,
    status: 'number_taken',
    session_reference_number: `SES-${id}`,
    request_payload_hash: 'aa'.repeat(32),
    response_ksef_number: null,
    original_ksef_number: null,
    original_session_reference_number: null,
    original_check: null,
    attempted_at: '2026-10-01T10:00:00.000Z',
    completed_at: over.completedAt === undefined ? '2026-10-04T10:00:00.000Z' : over.completedAt,
  });
  if (shape === 'unmarked') return base('nt-bez-znacznika');
  if (shape === 'automatic') {
    return { ...base('nt-automatyczny'), original_ksef_number: k, original_session_reference_number: 'SES-ORIG-1' };
  }
  const reason = over.reason ?? 'no-own-file';
  const check = reason === 'known-number' ? knownNumberCheck() : validCheck();
  return {
    ...base('nt-decyzja'),
    original_ksef_number: k,
    original_session_reference_number: 'SES-ORIG-1',
    original_check: {
      ...check,
      decision: { choice: over.choice ?? 'other_sale', via: over.via ?? 'client', at: over.at ?? DUP_DECIDED_AT, reason, env: 'test' },
    },
    completed_at: over.completedAt === undefined ? DUP_DECIDED_AT : over.completedAt,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Teksty SQL 00148, marka FaktWay od 00151 (sekcja 2.11.A) — wzorce z `%` RAISE i ich argumenty.

/**
 * Lustro `DUPLICATE_DECISION_SQL_TEXTS`, przepisane ręcznie ze specyfikacji
 * (2.11.A, słowo w słowo). `%` to znacznik RAISE; żaden wzorzec nie ma
 * dosłownego `%` ani apostrofu (C1).
 */
export const EXPECTED_SQL_TEXTS: Readonly<Record<string, { template: string; arity: number }>> = {
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
  // PR C (00156): nowe wzorce przepisane ze specyfikacji v3, 6.3 (słowo w słowo; lista prawnika),
  // marka FaktWay i pomoc@faktway.pl jak w 00151.
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

/** Wypełnienie wzorca RAISE od lewej do prawej — niezależne od `fillSqlText` modułu. */
export function fillExpected(key: string, ...args: string[]): string {
  const entry = EXPECTED_SQL_TEXTS[key];
  if (!entry) throw new Error(`brak wzorca ${key}`);
  const parts = entry.template.split('%');
  if (parts.length - 1 !== args.length) throw new Error(`${key}: ${parts.length - 1} znaczników, ${args.length} argumentów`);
  return parts.reduce((out, part, i) => out + part + (i < args.length ? args[i] : ''), '');
}

// ─── PR C (faktflow-original): kształty wspólnych tabel przypadków ───────────────
// Kontrakt (commit 1): grupa B wypełnia fabryki, grupa C (test projekcji) i grupa A
// (R-C6, R-C15 na bazie) je czytają. Tabele budowane LENIWIE — wyłącznie przez
// wywołanie fabryki, nigdy przy imporcie modułu: budowa projekcji woła
// `buildOriginalImportProjection`, a import tego pliku przez testy PR B nie może
// od niej zależeć. Fabryki rzucają, dopóki grupa B ich nie wypełni (pusta tabela
// dałaby testy zielone bez żadnego przypadku).

/** Wiersz R-C15 / lustra 4.4: `ksef_duplicate_original_offer` = `duplicateOriginalOffer`, `ksef_duplicate_gate_ok` = `originalGateOk`. */
export interface FaktflowOfferCase {
  name: string;
  /** `original_check` (surowy jsonb znacznika). */
  check: unknown;
  /** Własna historia z bazy (4.3); `null` = nie policzono. */
  ownHistoryDb: boolean | null;
  /** Oczekiwana oferta (`null` = brak oferty — nie `faktflow-original` albo brama nie do użycia). */
  offer: import('@/lib/ksef/duplicate-check').DuplicateOriginalOffer | null;
  /** Oczekiwane `originalGateOk(check.importGate)`. */
  gateOk: boolean;
}

/** Wiersz R-C6 / lustra 4.8: `ksef_original_import_mismatch` = `originalImportProjectionProblem`. */
export interface OriginalImportMismatchCase {
  name: string;
  offer: import('@/lib/ksef/duplicate-check').DuplicateOriginalImportOffer;
  /** Zmienia kopię poprawnej projekcji (bazowej z macierzy rundy) w przypadek; zwraca dowolny kształt jak jsonb. */
  mutate: (projection: Record<string, unknown>) => unknown;
  /** Nadpisania kontekstu (numer X, NIP firmy, znacznik…). */
  ctx?: Partial<import('@/lib/ksef/duplicate-original-projection').OriginalImportProblemContext>;
  /** Pierwszy kod niezgodności; `null` = projekcja poprawna. */
  expected: import('@/lib/ksef/duplicate-original-projection').OriginalImportProblem | null;
}

/** Brak klucza `importGate` w znaczniku (odróżnienie od `null`). */
const NO_GATE = Symbol('brak importGate');

interface GateVariant {
  label: string;
  gate: unknown | typeof NO_GATE;
  /** Oczekiwane `originalGateOk` (4.4a). */
  ok: boolean;
  /** `kind` poprawnej bramy; `null` przy złym kształcie. */
  kind: 'importable' | 'review' | null;
  /** Czy sprawdzać też `ownHistoryDb` true i null (inaczej tylko false). */
  allDb?: boolean;
}

const gateWithout = (gate: Json, key: string): Json => withoutKey(gate, key);

/**
 * Warianty bramy z 4.4a: poprawne (`importable` ⇔ `problems` puste, `review` ⇔ niepuste;
 * `rules` dowolną liczbą; `preview` i dodatkowe klucze nie wchodzą do sprawdzenia)
 * i złe kształty (każdy `IF` z 4.4a osobno).
 */
function gateVariants(): GateVariant[] {
  return [
    { label: 'importable', gate: faktflowGate(), ok: true, kind: 'importable', allDb: true },
    { label: 'review (rates)', gate: faktflowReviewGate(['rates']), ok: true, kind: 'review', allDb: true },
    { label: 'review (dwa problemy)', gate: faktflowReviewGate(['rates', 'amounts']), ok: true, kind: 'review' },
    { label: 'review z nieznanym kodem problemu', gate: faktflowReviewGate(['cokolwiek']), ok: true, kind: 'review' },
    { label: 'importable z rules 0', gate: faktflowGate({ rules: 0 }), ok: true, kind: 'importable' },
    { label: 'importable z rules 2 (nowsza wersja reguł)', gate: faktflowGate({ rules: 2 }), ok: true, kind: 'importable' },
    { label: 'importable z preview null', gate: faktflowGate({ preview: null }), ok: true, kind: 'importable' },
    { label: 'importable z preview nie obiektem', gate: faktflowGate({ preview: 'x' }), ok: true, kind: 'importable' },
    { label: 'importable z dodatkowym kluczem', gate: faktflowGate({ dodatkowy: 1 }), ok: true, kind: 'importable' },
    { label: 'brak klucza importGate', gate: NO_GATE, ok: false, kind: null, allDb: true },
    { label: 'importGate null', gate: null, ok: false, kind: null },
    { label: 'importGate napisem', gate: 'importable', ok: false, kind: null },
    { label: 'importGate tablicą', gate: [], ok: false, kind: null },
    { label: 'importGate liczbą', gate: 1, ok: false, kind: null },
    { label: 'importGate boolean', gate: true, ok: false, kind: null },
    { label: 'importGate v 2', gate: faktflowGate({ v: 2 }), ok: false, kind: null, allDb: true },
    { label: 'importGate v napisem', gate: faktflowGate({ v: '1' }), ok: false, kind: null },
    { label: 'importGate bez v', gate: gateWithout(faktflowGate(), 'v'), ok: false, kind: null },
    { label: 'importGate bez rules', gate: gateWithout(faktflowGate(), 'rules'), ok: false, kind: null },
    { label: 'importGate rules napisem', gate: faktflowGate({ rules: '1' }), ok: false, kind: null },
    { label: 'importGate rules null', gate: faktflowGate({ rules: null }), ok: false, kind: null },
    { label: 'importGate bez kind', gate: gateWithout(faktflowGate(), 'kind'), ok: false, kind: null },
    { label: 'importGate kind null', gate: faktflowGate({ kind: null }), ok: false, kind: null },
    { label: 'importGate kind inny', gate: faktflowGate({ kind: 'cokolwiek' }), ok: false, kind: null },
    { label: 'importGate kind wielkimi literami', gate: faktflowGate({ kind: 'IMPORTABLE' }), ok: false, kind: null },
    { label: 'importGate bez problems', gate: gateWithout(faktflowGate(), 'problems'), ok: false, kind: null },
    { label: 'importGate problems null', gate: faktflowGate({ problems: null }), ok: false, kind: null },
    { label: 'importGate problems napisem', gate: faktflowReviewGate([], { problems: 'rates' }), ok: false, kind: null },
    { label: 'importGate problems obiektem', gate: faktflowReviewGate([], { problems: {} }), ok: false, kind: null },
    { label: 'importGate problems z liczbą', gate: faktflowReviewGate([], { problems: ['rates', 1] }), ok: false, kind: null },
    { label: 'importGate problems z null', gate: faktflowReviewGate([], { problems: [null] }), ok: false, kind: null },
    { label: 'importGate problems z obiektem', gate: faktflowReviewGate([], { problems: [{}] }), ok: false, kind: null },
    { label: 'importGate problems z tablicą', gate: faktflowReviewGate([], { problems: [['rates']] }), ok: false, kind: null },
    { label: 'importGate importable z problemem', gate: faktflowGate({ problems: ['rates'] }), ok: false, kind: null },
    { label: 'importGate review bez problemów', gate: faktflowReviewGate([]), ok: false, kind: null },
  ];
}

const checkWithGate = (gate: unknown): Json =>
  gate === NO_GATE ? withoutKey(faktflowCheck(), 'importGate') : faktflowCheck({ importGate: gate });

/**
 * Tabela R-C15 (grupa B): oczekiwana oferta spisana ręcznie z 4.4 —
 * `record_only` = `ownHistory = true` w JSON, `sameContentExceptHeader = true`
 * albo własna historia w bazie (`ownHistoryDb` true; `null` = nieznane = tylko zapis);
 * poprawna brama `importable` → `pair`/`record`; poprawna `review` z `release`
 * (`at` napisem, `via = 'operator'`) i bez „tylko zapis” → `released`; reszta
 * (review, brak bramy, zły kształt) → `review-pair`/`review-record`; powód inny niż
 * `faktflow-original` albo `allows` odmawia → `null`.
 */
export function faktflowOfferCases(): ReadonlyArray<FaktflowOfferCase> {
  const rows: FaktflowOfferCase[] = [];
  const add = (name: string, check: unknown, ownHistoryDb: boolean | null, offer: FaktflowOfferCase['offer'], gateOk: boolean) => {
    rows.push({ name, check, ownHistoryDb, offer, gateOk });
  };
  const dbLabel = (db: boolean | null) => (db === null ? 'ownHistoryDb NULL' : `ownHistoryDb ${db}`);

  // 1. Każdy wariant bramy (4.4a) × własna historia w bazie.
  for (const v of gateVariants()) {
    const check = checkWithGate(v.gate);
    for (const db of v.allDb ? ([false, true, null] as const) : ([false] as const)) {
      const recordOnly = db !== false;
      const offer: DuplicateOriginalOffer = v.kind === 'importable'
        ? (recordOnly ? 'record' : 'pair')
        : (recordOnly ? 'review-record' : 'review-pair');
      add(`brama: ${v.label}, ${dbLabel(db)}`, check, db, offer, v.ok);
    }
  }

  // 2. „Tylko zapis” z JSON: ownHistory i sameContentExceptHeader (true / false / null / brak klucza).
  const jsonCases: Array<[string, Json, boolean]> = [
    ['ownHistory true', { ownHistory: true }, true],
    ['sameContentExceptHeader true', { sameContentExceptHeader: true }, true],
    ['ownHistory true i sameContentExceptHeader true', { ownHistory: true, sameContentExceptHeader: true }, true],
    ['ownHistory true i sameContentExceptHeader null', { ownHistory: true, sameContentExceptHeader: null }, true],
    ['sameContentExceptHeader false', { sameContentExceptHeader: false }, false],
    ['sameContentExceptHeader null', { sameContentExceptHeader: null }, false],
  ];
  for (const [label, over, recordOnly] of jsonCases) {
    add(`JSON ${label}, brama importable`, faktflowCheck(over), false, recordOnly ? 'record' : 'pair', true);
    add(`JSON ${label}, brama review`, faktflowCheck({ ...over, importGate: faktflowReviewGate(['rates']) }), false, recordOnly ? 'review-record' : 'review-pair', true);
  }
  add('JSON sameContentExceptHeader brak klucza, brama importable', withoutKey(faktflowCheck(), 'sameContentExceptHeader'), false, 'pair', true);
  add('JSON sameContentExceptHeader brak klucza, brama review', withoutKey(faktflowCheck({ importGate: faktflowReviewGate(['rates']) }), 'sameContentExceptHeader'), false, 'review-pair', true);
  add('JSON sameContentExceptHeader null i ownHistoryDb NULL (nieznane = tylko zapis)', faktflowCheck({ sameContentExceptHeader: null }), null, 'record', true);
  add('JSON sameContentExceptHeader brak klucza i ownHistoryDb NULL', withoutKey(faktflowCheck(), 'sameContentExceptHeader'), null, 'record', true);
  add('JSON ownHistory false, sameContentExceptHeader false, ownHistoryDb true', faktflowCheck(), true, 'record', true);
  add('recheckNeeded na znaczniku nie zmienia oferty (rozstrzyga blokada)', faktflowCheck({ recheckNeeded: { kind: 'gate-drift', at: '2026-10-09T08:00:00.000Z' } }), false, 'pair', true);

  // 3. Oddanie decyzji (`release`): poprawny kształt `at` (napis) i `via = 'operator'`, bez „tylko zapis”.
  const released = (release: unknown, over: Json = {}, gate: Json = faktflowReviewGate(['rates'])) =>
    faktflowCheck({ importGate: { ...gate, release }, ...over });
  add('release pełne (at, via, actorUserId, note)', released(faktflowRelease()), false, 'released', true);
  add('release minimalne (at, via)', released({ at: DUP_RELEASED_AT, via: 'operator' }), false, 'released', true);
  add('release z dodatkowym kluczem', released(faktflowRelease({ dodatkowy: 1 })), false, 'released', true);
  add('release.at zwykłym napisem (SQL sprawdza tylko typ)', released({ at: 'nie data', via: 'operator' }), false, 'released', true);
  add('release.via client', released(faktflowRelease({ via: 'client' })), false, 'review-pair', true);
  add('release.via Operator wielką literą', released(faktflowRelease({ via: 'Operator' })), false, 'review-pair', true);
  add('release bez via', released({ at: DUP_RELEASED_AT }), false, 'review-pair', true);
  add('release bez at', released({ via: 'operator' }), false, 'review-pair', true);
  add('release.at liczbą', released({ at: 1760000000, via: 'operator' }), false, 'review-pair', true);
  add('release.at null', released({ at: null, via: 'operator' }), false, 'review-pair', true);
  add('release pustym obiektem', released({}), false, 'review-pair', true);
  add('release tablicą', released([]), false, 'review-pair', true);
  add('release napisem', released('operator'), false, 'review-pair', true);
  add('release null', released(null), false, 'review-pair', true);
  add('release i ownHistoryDb true — „tylko zapis” wyklucza oddanie', released(faktflowRelease()), true, 'review-record', true);
  add('release i ownHistoryDb NULL — nieznane wyklucza oddanie', released(faktflowRelease()), null, 'review-record', true);
  add('release i ownHistory true w JSON', released(faktflowRelease(), { ownHistory: true }), false, 'review-record', true);
  add('release i sameContentExceptHeader true', released(faktflowRelease(), { sameContentExceptHeader: true }), false, 'review-record', true);
  add('release i sameContentExceptHeader null (F50) — oddanie działa', released(faktflowRelease(), { sameContentExceptHeader: null }), false, 'released', true);
  add('release i sameContentExceptHeader brak klucza — oddanie działa', withoutKey(released(faktflowRelease()), 'sameContentExceptHeader'), false, 'released', true);
  add('release przy bramie importable (niespójne) — importable wygrywa', released(faktflowRelease(), {}, faktflowGate()), false, 'pair', true);
  add('release przy bramie importable i ownHistoryDb true', released(faktflowRelease(), {}, faktflowGate()), true, 'record', true);
  add('release przy bramie w złym kształcie (problems nie tablicą)', released(faktflowRelease(), {}, faktflowReviewGate([], { problems: 'rates' })), false, 'review-pair', false);
  add('release przy bramie v 2', released(faktflowRelease(), {}, faktflowReviewGate(['rates'], { v: 2 })), false, 'review-pair', false);

  // 4. Powód inny niż faktflow-original albo `allows` odmawia → brak oferty (brama sama jest oceniana osobno).
  add('powód no-own-file z bramą', validCheck({ importGate: faktflowGate() }), false, null, true);
  add('powód known-number z bramą', knownNumberCheck({ importGate: faktflowGate() }), false, null, true);
  add('powód same-content-other-program z bramą', faktflowCheck({ reason: 'same-content-other-program' }), false, null, true);
  add('powód download-pending z bramą', faktflowCheck({ reason: 'download-pending' }), false, null, true);
  add('powód nieznany z bramą', faktflowCheck({ reason: 'cokolwiek' }), false, null, true);
  add('SystemInfo obcego programu', faktflowCheck({ summary: { ...(validCheck().summary as Json), systemInfo: DUP_PROGRAM } }), false, null, true);
  add('SystemInfo null', faktflowCheck({ summary: { ...(validCheck().summary as Json), systemInfo: null } }), false, null, true);
  add('SystemInfo FaktFlow v2 (po spacji nie cyfra)', faktflowCheck({ summary: { ...(validCheck().summary as Json), systemInfo: 'FaktFlow v2' } }), false, null, true);
  add('SystemInfo FaktFlow 2.0 (przyszła postać)', faktflowCheck({ summary: { ...(validCheck().summary as Json), systemInfo: 'FaktFlow 2.0' } }), false, 'pair', true);
  add('SystemInfo FaktFlow 2.0 i ownHistoryDb true', faktflowCheck({ summary: { ...(validCheck().summary as Json), systemInfo: 'FaktFlow 2.0' } }), true, 'record', true);
  add('decision już zapisana', faktflowCheck({ decision: { choice: 'same_sale', via: 'client', at: DUP_DECIDED_AT, reason: 'faktflow-original', env: 'test' } }), false, null, true);
  add('archivePath w złym kształcie', faktflowCheck({ archivePath: 'cokolwiek.xml' }), false, null, true);
  add('archivePath null', faktflowCheck({ archivePath: null }), false, null, true);
  add('sizeBytes 0', faktflowCheck({ sizeBytes: 0 }), false, null, true);
  add('sizeBytes ponad int', faktflowCheck({ sizeBytes: 2147483648 }), false, null, true);
  add('ownHistory null', faktflowCheck({ ownHistory: null }), false, null, true);
  add('ownHistory brak klucza', withoutKey(faktflowCheck(), 'ownHistory'), false, null, true);
  add('sameContentExceptHeader napisem true', faktflowCheck({ sameContentExceptHeader: 'true' }), false, null, true);
  add('sameContentExceptHeader liczbą', faktflowCheck({ sameContentExceptHeader: 1 }), false, null, true);
  add('sha256 null', faktflowCheck({ sha256: null }), false, null, true);
  add('sha256 wielkimi literami', faktflowCheck({ sha256: 'BB'.repeat(32) }), false, null, true);
  add('summary null', faktflowCheck({ summary: null }), false, null, true);
  add('v 2', faktflowCheck({ v: 2 }), false, null, true);
  add('v napisem', faktflowCheck({ v: '1' }), false, null, true);
  add('znacznik null', null, false, null, false);
  add('znacznik napisem', 'faktflow-original', false, null, false);
  add('znacznik tablicą', [faktflowCheck()], false, null, false);
  add('znacznik pustym obiektem', {}, false, null, false);

  return rows;
}

// ─── R-C6: lustro 4.8 (`ksef_original_import_mismatch` = `originalImportProjectionProblem`) ────────

type P = Record<string, unknown>;

const BASE_SELLER_NIP = '5260001246';
const BASE_BUYER_NIP = '5252241585';
const BASE_PESEL = '44051401359';
/** Numer KSeF oryginału zbudowanego w fikstury (NIP sprzedawcy + data nadania). */
const BASE_K = `${BASE_SELLER_NIP}-20261001-0100A0B0C0D0-1A`;

interface BaseFixture {
  xml: string;
  check: KsefDuplicateCheck;
  parsed: ReturnType<typeof parseFa3Xml>;
}

let fixtureCache: BaseFixture | null = null;

/**
 * Plik z generatora FaktFlow: faktura zwykła VAT (jedna pozycja 2 × 50 zł netto, 23%,
 * NIP-y testowe z poprawną sumą kontrolną) → `finalizeInvoice` → `generateFA3Xml` →
 * `parseFa3Xml`; znacznik `original_check` jak zapisuje runner (skrót i rozmiar bajtów
 * pliku, `summary` z `summarizeInvoiceXml`). Bez projekcji — ta powstaje w `originalImportBase()`.
 */
function baseFixture(): BaseFixture {
  if (fixtureCache) return fixtureCache;
  const finalized = finalizeInvoice({
    internalNumber: DUP_NR,
    type: 'VAT',
    issueDate: '2026-10-01',
    saleDate: '2026-10-01',
    seller: {
      nip: BASE_SELLER_NIP,
      name: 'Firma testowa sp. z o.o.',
      email: 'biuro@example.test',
      address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
    },
    buyer: {
      nip: BASE_BUYER_NIP,
      name: 'Nabywca testowy sp. z o.o.',
      email: 'nabywca@example.test',
      address: { countryCode: 'PL', addressLine1: 'ul. Kliencka 2', addressLine2: '00-002 Warszawa' },
    },
    lines: [{ ordinal: 1, name: 'Usługa wdrożeniowa', unit: 'usł.', quantity: 2, unitPriceNet: 50, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-10-15', method: 'transfer', bankAccount: '61109010140000071219812874' },
  });
  const annotations = buildInvoiceAnnotations({ lines: finalized.lines, vatExemptionBasis: null, splitPayment: false });
  const invoice: Invoice = annotations ? { ...finalized, annotations } : finalized;
  const xml = generateFA3Xml(invoice, { generatedAt: new Date('2026-10-01T08:00:00Z') });
  const bytes = Buffer.from(xml, 'utf8');
  const check: KsefDuplicateCheck = {
    v: 1,
    env: 'test',
    checkedAt: '2026-10-02T08:00:00.000Z',
    reason: 'faktflow-original',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    archivePath: `${DUP_TENANT_ID}/ksef-import/${BASE_K}.xml`,
    sizeBytes: bytes.length,
    summary: summarizeInvoiceXml(xml),
    sameContentExceptHeader: false,
    ownHistory: false,
    acquiredAt: '2026-10-01T09:00:00.000Z',
    httpStatus: null,
    knownInvoice: null,
    recheck: null,
  };
  fixtureCache = { xml, check, parsed: parseFa3Xml(xml, { ksefNumber: BASE_K }) };
  return fixtureCache;
}

let projectionCache: P | null = null;

export interface OriginalImportBase {
  /** Poprawna projekcja K (jak jsonb po drodze przez supabase-js) — świeża kopia, wolno mutować. */
  projection: P;
  /** Kontekst pasujący do projekcji (numer X, NIP firmy, K, `original_check`); `offer: 'pair'`. */
  ctx: OriginalImportProblemContext;
  /** Bajty pliku oryginału jako tekst. */
  xml: string;
}

/**
 * Baza tabeli R-C6, budowana LENIWIE przy pierwszym wywołaniu z rundy
 * `generateFA3Xml(finalizeInvoice(…))` → `parseFa3Xml` → `importedInvoiceContent` →
 * `buildOriginalImportProjection`. Konsument stosuje przypadek tak:
 * `const base = originalImportBase(); originalImportProjectionProblem(c.mutate(base.projection),
 * { ...base.ctx, offer: c.offer, ...c.ctx })`. Test bazy (R-C1c, R-C6) składa z tego samego
 * `p_import`, `p_inv` (numer = `ctx.internalNumber`), `p_marker` (`ctx.check`), `p_tenant_nip`.
 */
export function originalImportBase(): OriginalImportBase {
  const fixture = baseFixture();
  if (!projectionCache) {
    const { content, amounts } = importedInvoiceContent(fixture.parsed);
    const projection = buildOriginalImportProjection(fixture.parsed, content, amounts, {
      tenantId: DUP_TENANT_ID,
      env: 'test',
      check: fixture.check,
      ksefNumber: BASE_K,
      now: new Date('2026-10-02T09:00:00.000Z'),
    });
    projectionCache = JSON.parse(JSON.stringify(projection)) as P;
  }
  return {
    projection: structuredClone(projectionCache),
    ctx: {
      internalNumber: DUP_NR,
      tenantNip: BASE_SELLER_NIP,
      tenantId: DUP_TENANT_ID,
      ksefNumber: BASE_K,
      check: structuredClone(fixture.check),
      offer: 'pair',
    },
    xml: fixture.xml,
  };
}

const inv = (p: P): P => p.invoice as P;
const lines = (p: P): P[] => p.lines as P[];
const xmlPart = (p: P): P => p.xml as P;
const flipNip = (nip: unknown): string => `${String(nip).slice(0, 9)}${(Number(String(nip).slice(9)) + 1) % 10}`;
const identity = (p: P): P => p;

/** Nadpisanie `original_check` w kontekście (cała reszta znacznika z fikstury). */
const ctxCheck = (over: Partial<KsefDuplicateCheck>): Partial<OriginalImportProblemContext> => ({
  check: { ...baseFixture().check, ...over },
});
const ctxSummary = (over: Record<string, string | null>): Partial<OriginalImportProblemContext> => {
  const { check } = baseFixture();
  return { check: { ...check, summary: { ...check.summary!, ...over } } };
};

/**
 * Tabela R-C6 (grupa B): oczekiwany PIERWSZY kod 4.8 (kolejność `shape` → `lines` →
 * `number` → `seller` → `kind` → `issue-date` → `gross` → `buyer` → `currency` → `xml` →
 * `totals` → `fa3`), `null` = projekcja poprawna. Fabryka nie buduje projekcji —
 * robi to `originalImportBase()` (przy pierwszym użyciu).
 */
export function originalImportMismatchCases(): ReadonlyArray<OriginalImportMismatchCase> {
  const rows: OriginalImportMismatchCase[] = [];
  const add = (
    name: string,
    expected: OriginalImportProblem | null,
    mutate: (projection: P) => unknown = identity,
    ctx?: Partial<OriginalImportProblemContext>,
    offer: DuplicateOriginalImportOffer = 'pair',
  ) => {
    rows.push({ name, offer, mutate: mutate as OriginalImportMismatchCase['mutate'], ...(ctx ? { ctx } : {}), expected });
  };

  // ── Projekcja poprawna (z macierzy rundy) ──
  for (const offer of ['pair', 'record', 'review-pair', 'review-record'] as const) {
    add(`poprawna projekcja, oferta ${offer}`, null, identity, undefined, offer);
  }
  for (const rate of VAT_RATES) {
    add(`stawka FaktFlow ${rate} przechodzi przy ofercie pair`, null, (p) => { for (const l of lines(p)) l.vat_rate = rate; return p; });
  }
  for (const rate of FA3_ONLY_VAT_RATES) {
    add(`stawka FA(3) spoza FaktFlow ${rate} przy review-pair (operator) przechodzi`, null, (p) => { for (const l of lines(p)) l.vat_rate = rate; return p; }, undefined, 'review-pair');
  }
  add('stawka 0 WDT przy review-record przechodzi', null, (p) => { for (const l of lines(p)) l.vat_rate = '0 WDT'; return p; }, undefined, 'review-record');
  add('numer z odstępami na brzegach (btrim po obu stronach)', null, (p) => { inv(p).internal_number = ` ${String(inv(p).internal_number)} `; return p; });
  add('data sprzedaży i termin płatności NULL', null, (p) => { inv(p).sale_date = null; inv(p).payment_due_date = null; return p; });
  add('data wystawienia ze strefą w pliku — porównanie po 10 znakach', null, identity, ctxSummary({ issueDate: `${baseFixture().check.summary!.issueDate}+02:00` }));
  add('kwota brutto w pliku bez miejsc po przecinku (123 = 123.00)', null, identity, ctxSummary({ gross: '123' }));
  add('NIP nabywcy w pliku z separatorami i przedrostkiem — porównanie po cyfrach', null, identity, ctxSummary({ buyerNip: 'PL 525-224-15-85' }));
  add('waluta nieobecna w pliku (NULL) przechodzi', null, identity, ctxSummary({ currency: null }));
  // Jedna reguła waluty (fix 3): problem tylko, gdy `upper(btrim(waluta))` jest niepuste i ≠ 'PLN' —
  // jak reguła 1 bramy i `assertPlnCurrency`. SQL: `NULLIF(upper(btrim(summary->>'currency')),'') <> 'PLN'`.
  add('waluta pusta w pliku (\'\') przechodzi', null, identity, ctxSummary({ currency: '' }));
  add('waluta małymi literami („pln”) przechodzi', null, identity, ctxSummary({ currency: 'pln' }));
  add('waluta z odstępami na brzegach („ PLN ”) przechodzi (btrim obcina spacje)', null, identity, ctxSummary({ currency: ' PLN ' }));
  add('waluta same odstępy („   ”) przechodzi (po btrim pusta)', null, identity, ctxSummary({ currency: '   ' }));
  add('nabywca PESEL (B2C): brak NIP po obu stronach', null, (p) => {
    Object.assign(inv(p), { buyer_nip: null, is_b2c: true, buyer_id_type: 'pesel', buyer_pesel: BASE_PESEL, buyer_id_number: null });
    return p;
  }, ctxSummary({ buyerNip: null }));
  add('nabywca bez identyfikatora (BrakID): brak NIP po obu stronach', null, (p) => {
    Object.assign(inv(p), { buyer_nip: null, is_b2c: true, buyer_id_type: 'no_id', buyer_pesel: null, buyer_id_number: null });
    return p;
  }, ctxSummary({ buyerNip: null }));

  // ── shape (program, 22023) ──
  add('shape: v 2', 'shape', (p) => { p.v = 2; return p; });
  add('shape: v napisem', 'shape', (p) => { p.v = '1'; return p; });
  add('shape: invoice tablicą', 'shape', (p) => { p.invoice = []; return p; });
  add('shape: invoice null', 'shape', (p) => { p.invoice = null; return p; });
  add('shape: invoice napisem', 'shape', (p) => { p.invoice = 'faktura'; return p; });
  add('shape: lines obiektem', 'shape', (p) => { p.lines = {}; return p; });
  add('shape: lines null', 'shape', (p) => { p.lines = null; return p; });
  add('shape: lines pusta', 'shape', (p) => { p.lines = []; return p; });
  add('shape: 1001 pozycji', 'shape', (p) => {
    const first = lines(p)[0]!;
    p.lines = Array.from({ length: 1001 }, (_, i) => ({ ...first, ordinal: i + 1 }));
    return p;
  });
  add('shape: xml null', 'shape', (p) => { p.xml = null; return p; });
  add('shape: xml tablicą', 'shape', (p) => { p.xml = []; return p; });
  add('shape: klucz id w invoice', 'shape', (p) => { inv(p).id = '7a7a7a7a-0000-4000-8000-0000000000ff'; return p; });
  add('shape: klucz tenant_id w invoice (kolumna ustawiana przez SQL)', 'shape', (p) => { inv(p).tenant_id = DUP_TENANT_ID; return p; });
  add('shape: klucz ksef_number w invoice (kolumna ustawiana przez SQL)', 'shape', (p) => { inv(p).ksef_number = BASE_K; return p; });
  add('shape: internal_number liczbą', 'shape', (p) => { inv(p).internal_number = 7; return p; });
  add('shape: internal_number pusty', 'shape', (p) => { inv(p).internal_number = ''; return p; });
  add('shape: internal_number 101 znaków', 'shape', (p) => { inv(p).internal_number = 'N'.repeat(101); return p; });
  add('shape: invoice_type liczbą', 'shape', (p) => { inv(p).invoice_type = 5; return p; });
  add('shape: issue_date nie datą', 'shape', (p) => { inv(p).issue_date = 'wczoraj'; return p; });
  add('shape: issue_date 2026-02-30 (nie istnieje)', 'shape', (p) => { inv(p).issue_date = '2026-02-30'; return p; });
  add('shape: issue_date z czasem i strefą', 'shape', (p) => { inv(p).issue_date = '2026-10-01T10:00:00Z'; return p; });
  add('shape: sale_date nie datą', 'shape', (p) => { inv(p).sale_date = '01.10.2026'; return p; });
  add('shape: payment_due_date nie istnieje (2026-13-01)', 'shape', (p) => { inv(p).payment_due_date = '2026-13-01'; return p; });
  add('shape: seller_nip 9 cyfr', 'shape', (p) => { inv(p).seller_nip = String(inv(p).seller_nip).slice(0, 9); return p; });
  add('shape: seller_nip null', 'shape', (p) => { inv(p).seller_nip = null; return p; });
  add('shape: seller_nip z literami', 'shape', (p) => { inv(p).seller_nip = 'ABCDEFGHIJ'; return p; });
  add('shape: buyer_nip 9 cyfr', 'shape', (p) => { inv(p).buyer_nip = String(inv(p).buyer_nip).slice(0, 9); return p; });
  add('shape: net_total napisem', 'shape', (p) => { inv(p).net_total = '100'; return p; });
  add('shape: net_total z 3 miejscami po przecinku', 'shape', (p) => { inv(p).net_total = 100.123; return p; });
  add('shape: vat_total null', 'shape', (p) => { inv(p).vat_total = null; return p; });
  add('shape: gross_total równe 1e10', 'shape', (p) => { inv(p).gross_total = 10000000000; return p; });
  add('shape: gross_total równe -1e10', 'shape', (p) => { inv(p).gross_total = -10000000000; return p; });
  add('shape: fa3_data napisem', 'shape', (p) => { inv(p).fa3_data = 'json'; return p; });
  add('shape: fa3_data tablicą', 'shape', (p) => { inv(p).fa3_data = []; return p; });
  add('shape: seller_data null', 'shape', (p) => { inv(p).seller_data = null; return p; });
  add('shape: buyer_data tablicą', 'shape', (p) => { inv(p).buyer_data = []; return p; });
  add('shape: payment_data napisem', 'shape', (p) => { inv(p).payment_data = 'przelew'; return p; });
  add('shape: is_b2c NULL', 'shape', (p) => { inv(p).is_b2c = null; return p; });
  add('shape: is_b2c napisem', 'shape', (p) => { inv(p).is_b2c = 'false'; return p; });
  add('shape: is_b2c true przy buyer_id_type nip (check_b2c_has_id)', 'shape', (p) => { inv(p).is_b2c = true; return p; });
  add('shape: buyer_id_type spoza enum', 'shape', (p) => { inv(p).buyer_id_type = 'inne'; return p; });
  add('shape: buyer_pesel 10 cyfr', 'shape', (p) => { inv(p).buyer_pesel = '4405140135'; return p; });
  add('shape: buyer_pesel liczbą', 'shape', (p) => { inv(p).buyer_pesel = 44051401359; return p; });
  add('shape: buyer_id_number 101 znaków', 'shape', (p) => { inv(p).buyer_id_number = 'X'.repeat(101); return p; });
  add('shape: notes 5001 znaków', 'shape', (p) => { inv(p).notes = 'u'.repeat(5001); return p; });
  add('shape: notes liczbą', 'shape', (p) => { inv(p).notes = 5; return p; });
  // R-C6 (fix 2): brak klucza i liczba w miejscu napisu to `shape` — SQL ma to wyrazić jawnie
  // (`jsonb_typeof(...) = 'string'` przed każdym wyrażeniem regularnym, `IS DISTINCT FROM`), nie samym `!~` na NULL.
  add('shape: brak klucza v', 'shape', (p) => { delete p.v; return p; });
  add('shape: seller_nip liczbą JSON', 'shape', (p) => { inv(p).seller_nip = 5260001246; return p; });
  add('shape: buyer_nip liczbą JSON', 'shape', (p) => { inv(p).buyer_nip = 5252241585; return p; });
  add('shape: brak klucza seller_nip', 'shape', (p) => { delete inv(p).seller_nip; return p; });
  add('shape: brak klucza is_b2c', 'shape', (p) => { delete inv(p).is_b2c; return p; });

  // ── lines (program, 22023) ──
  add('lines: klucz invoice_id w pozycji', 'lines', (p) => { lines(p)[0]!.invoice_id = DUP_INVOICE_ID; return p; });
  add('lines: ordinal 0', 'lines', (p) => { lines(p)[0]!.ordinal = 0; return p; });
  add('lines: ordinal ułamkiem', 'lines', (p) => { lines(p)[0]!.ordinal = 1.5; return p; });
  add('lines: ordinal 100001', 'lines', (p) => { lines(p)[0]!.ordinal = 100001; return p; });
  add('lines: ordinal powtórzony', 'lines', (p) => { p.lines = [lines(p)[0]!, { ...lines(p)[0]! }]; return p; });
  add('lines: name pusta', 'lines', (p) => { lines(p)[0]!.name = ''; return p; });
  add('lines: name 513 znaków', 'lines', (p) => { lines(p)[0]!.name = 'n'.repeat(513); return p; });
  add('lines: unit pusta', 'lines', (p) => { lines(p)[0]!.unit = ''; return p; });
  add('lines: unit 51 znaków', 'lines', (p) => { lines(p)[0]!.unit = 'u'.repeat(51); return p; });
  add('lines: quantity z 5 miejscami po przecinku', 'lines', (p) => { lines(p)[0]!.quantity = 1.23456; return p; });
  add('lines: quantity równe 1e10', 'lines', (p) => { lines(p)[0]!.quantity = 10000000000; return p; });
  add('lines: unit_price_net z 5 miejscami po przecinku', 'lines', (p) => { lines(p)[0]!.unit_price_net = 1.23456; return p; });
  add('lines: unit_price_net napisem', 'lines', (p) => { lines(p)[0]!.unit_price_net = '50'; return p; });
  add('lines: net_amount z 3 miejscami po przecinku', 'lines', (p) => { lines(p)[0]!.net_amount = 100.001; return p; });
  add('lines: vat_amount napisem', 'lines', (p) => { lines(p)[0]!.vat_amount = '23'; return p; });
  add('lines: gross_amount równe 1e10', 'lines', (p) => { lines(p)[0]!.gross_amount = 10000000000; return p; });
  add('lines: unit_price_net równe 1e10 (kolumna NUMERIC(14,4) — inaczej INSERT pada na 22003)', 'lines', (p) => { lines(p)[0]!.unit_price_net = 10000000000; return p; });
  add('lines: unit_price_net równe -1e10', 'lines', (p) => { lines(p)[0]!.unit_price_net = -10000000000; return p; });
  add('lines: pozycja liczbą (nie obiektem)', 'lines', (p) => { p.lines = [lines(p)[0]!, 5]; return p; });
  add('lines: pozycja null', 'lines', (p) => { p.lines = [lines(p)[0]!, null]; return p; });
  add('lines: pozycja tablicą', 'lines', (p) => { p.lines = [lines(p)[0]!, []]; return p; });
  for (const offer of ['pair', 'record', 'review-pair', 'review-record'] as const) {
    add(`lines: stawka nieznana nigdy nie przechodzi (${offer})`, 'lines', (p) => { lines(p)[0]!.vat_rate = 'nieznana'; return p; }, undefined, offer);
  }
  add('lines: stawka pusta', 'lines', (p) => { lines(p)[0]!.vat_rate = ''; return p; });
  add('lines: stawka spoza listy przy review-pair', 'lines', (p) => { lines(p)[0]!.vat_rate = '17'; return p; }, undefined, 'review-pair');
  for (const rate of ['0 WDT', '0 EX', '22', '7', '4', '3'] as const) {
    add(`lines: stawka ${rate} przy ofercie pair`, 'lines', (p) => { lines(p)[0]!.vat_rate = rate; return p; });
  }
  add('lines: stawka 0 WDT przy ofercie record', 'lines', (p) => { lines(p)[0]!.vat_rate = '0 WDT'; return p; }, undefined, 'record');

  // ── number, seller (klient, P0001 IMPORT_MISMATCH), kind ──
  add('number: dokument X bez numeru (NULL)', 'number', identity, { internalNumber: null });
  add('number: numer dokumentu X inny niż w projekcji i w pliku', 'number', identity, { internalNumber: 'FV/INNY/1' });
  add('number: internal_number projekcji inny niż numer dokumentu X', 'number', (p) => { inv(p).internal_number = `${String(inv(p).internal_number)}/INNY`; return p; });
  add('number: numer w pliku (summary.number) inny niż numer dokumentu X', 'number', identity, ctxSummary({ number: 'FV/2026/10/8' }));
  add('number: numer w pliku nieznany (NULL)', 'number', identity, ctxSummary({ number: null }));
  add('seller: seller_nip projekcji inny niż NIP firmy', 'seller', (p) => { inv(p).seller_nip = flipNip(inv(p).seller_nip); return p; });
  add('seller: NIP firmy inny niż w projekcji', 'seller', identity, { tenantNip: BASE_BUYER_NIP });
  for (const type of ['KOR', 'ZAL', 'ROZ'] as const) {
    add(`kind: invoice_type ${type}`, 'kind', (p) => { inv(p).invoice_type = type; return p; });
  }

  // ── issue-date, gross, buyer, currency ──
  add('issue-date: data wystawienia projekcji inna niż w pliku', 'issue-date', (p) => { inv(p).issue_date = '2026-10-02'; return p; });
  add('issue-date: data w pliku inna niż w projekcji', 'issue-date', identity, ctxSummary({ issueDate: '2026-10-02' }));
  add('issue-date: data w pliku w innym formacie', 'issue-date', identity, ctxSummary({ issueDate: '01.10.2026' }));
  // I3: brak `summary.issueDate` to niezgodność (fail-closed) — SQL ma to wyrazić np. `IS NULL OR NOT …`, nie samym
  // `!~` (NULL !~ wzorzec = NULL i warunek by nie zadziałał). TS i SQL pinuje ten sam wiersz R-C6.
  add('issue-date: data w pliku nieznana (NULL) — brak summary.issueDate to niezgodność (fail-closed)', 'issue-date', identity, ctxSummary({ issueDate: null }));
  add('gross: gross_total inny niż P_15 pliku', 'gross', (p) => { inv(p).gross_total = Number(inv(p).gross_total) + 1; return p; });
  add('gross: P_15 pliku nie jest kwotą', 'gross', identity, ctxSummary({ gross: 'abc' }));
  add('gross: P_15 pliku z 3 miejscami po przecinku', 'gross', identity, ctxSummary({ gross: '123.456' }));
  add('gross: P_15 pliku nieznane (NULL) — brak brutto w znaczniku to niezgodność (fail-closed)', 'gross', identity, ctxSummary({ gross: null }));
  add('buyer: buyer_nip projekcji inny niż NIP nabywcy w pliku', 'buyer', (p) => { inv(p).buyer_nip = flipNip(inv(p).buyer_nip); return p; });
  add('buyer: brak buyer_nip w projekcji przy NIP w pliku', 'buyer', (p) => { inv(p).buyer_nip = null; return p; });
  add('buyer: NIP nabywcy w pliku nieznany (NULL) przy buyer_nip w projekcji', 'buyer', identity, ctxSummary({ buyerNip: null }));
  add('buyer: NIP nabywcy w pliku bez cyfr przy buyer_nip w projekcji', 'buyer', identity, ctxSummary({ buyerNip: 'brak' }));
  add('currency: waluta pliku EUR', 'currency', identity, ctxSummary({ currency: 'EUR' }));
  add('currency: waluta pliku USD', 'currency', identity, ctxSummary({ currency: 'USD' }));
  add('currency: waluta pliku z tabulatorem („\\tPLN”) — btrim obcina same spacje', 'currency', identity, ctxSummary({ currency: '\tPLN' }));

  // ── xml, totals, fa3 ──
  add('xml: storage_path inna niż archivePath', 'xml', (p) => { xmlPart(p).storage_path = `${DUP_TENANT_ID}/ksef-import/INNY.xml`; return p; });
  add('xml: storage_path zgodna z archivePath, ale spoza katalogu firmy i numeru K', 'xml', (p) => {
    xmlPart(p).storage_path = `cudza-firma/ksef-import/${BASE_K}.xml`;
    return p;
  }, ctxCheck({ archivePath: `cudza-firma/ksef-import/${BASE_K}.xml` }));
  add('xml: sha256 inny niż w znaczniku', 'xml', (p) => { xmlPart(p).sha256 = 'cc'.repeat(32); return p; });
  add('xml: size_bytes inny niż w znaczniku', 'xml', (p) => { xmlPart(p).size_bytes = Number(xmlPart(p).size_bytes) + 1; return p; });
  add('xml: brak size_bytes', 'xml', (p) => { delete xmlPart(p).size_bytes; return p; });
  add('xml: size_bytes napisem', 'xml', (p) => { xmlPart(p).size_bytes = String(xmlPart(p).size_bytes); return p; });
  add('totals: suma net_amount pozycji inna niż net_total', 'totals', (p) => { lines(p)[0]!.net_amount = Number(lines(p)[0]!.net_amount) + 0.01; return p; });
  add('totals: suma vat_amount pozycji inna niż vat_total', 'totals', (p) => { lines(p)[0]!.vat_amount = Number(lines(p)[0]!.vat_amount) + 0.01; return p; });
  add('totals: suma gross_amount pozycji inna niż gross_total', 'totals', (p) => { lines(p)[0]!.gross_amount = Number(lines(p)[0]!.gross_amount) + 0.01; return p; });
  add('fa3: fa3_data ma klucz lines', 'fa3', (p) => { (inv(p).fa3_data as P).lines = []; return p; });
  add('fa3: fa3_data.import.source inne niż ksef_duplicate_decision', 'fa3', (p) => { ((inv(p).fa3_data as P).import as P).source = 'ksef_history'; return p; });
  add('fa3: fa3_data.import.originalSha256 inny niż w znaczniku', 'fa3', (p) => { ((inv(p).fa3_data as P).import as P).originalSha256 = 'dd'.repeat(32); return p; });
  add('fa3: fa3_data bez klucza import', 'fa3', (p) => { delete (inv(p).fa3_data as P).import; return p; });
  add('fa3: fa3_data.import bez originalSha256', 'fa3', (p) => { delete ((inv(p).fa3_data as P).import as P).originalSha256; return p; });

  // ── Kolejność: wygrywa PIERWSZY kod (każdy wiersz łączy dwa problemy) ──
  add('kolejność: shape przed number', 'shape', (p) => { inv(p).id = 'x'; inv(p).internal_number = 'FV/INNY/2'; return p; });
  add('kolejność: lines przed number', 'lines', (p) => { lines(p)[0]!.vat_rate = 'nieznana'; inv(p).internal_number = 'FV/INNY/2'; return p; });
  add('kolejność: number przed seller', 'number', (p) => { inv(p).seller_nip = flipNip(inv(p).seller_nip); return p; }, { internalNumber: null });
  add('kolejność: seller przed kind', 'seller', (p) => { inv(p).seller_nip = flipNip(inv(p).seller_nip); inv(p).invoice_type = 'KOR'; return p; });
  add('kolejność: kind przed issue-date', 'kind', (p) => { inv(p).invoice_type = 'KOR'; inv(p).issue_date = '2026-10-02'; return p; });
  add('kolejność: issue-date przed gross', 'issue-date', (p) => { inv(p).issue_date = '2026-10-02'; inv(p).gross_total = Number(inv(p).gross_total) + 1; return p; });
  add('kolejność: gross przed buyer', 'gross', (p) => { inv(p).gross_total = Number(inv(p).gross_total) + 1; inv(p).buyer_nip = flipNip(inv(p).buyer_nip); return p; });
  add('kolejność: buyer przed currency', 'buyer', (p) => { inv(p).buyer_nip = flipNip(inv(p).buyer_nip); return p; }, ctxSummary({ currency: 'EUR' }));
  add('kolejność: currency przed xml', 'currency', (p) => { xmlPart(p).sha256 = 'cc'.repeat(32); return p; }, ctxSummary({ currency: 'EUR' }));
  add('kolejność: xml przed totals', 'xml', (p) => { xmlPart(p).sha256 = 'cc'.repeat(32); lines(p)[0]!.net_amount = Number(lines(p)[0]!.net_amount) + 0.01; return p; });
  add('kolejność: totals przed fa3', 'totals', (p) => { lines(p)[0]!.net_amount = Number(lines(p)[0]!.net_amount) + 0.01; (inv(p).fa3_data as P).lines = []; return p; });

  return rows;
}
