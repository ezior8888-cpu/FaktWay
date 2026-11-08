import { describe, expect, it } from 'vitest';

import { OPERATOR_DUPLICATE_MESSAGES, operatorInvoiceButtons } from '@/lib/admin/ksef-operator-policy';
import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import { decideResend, failedInvoiceButtons } from '@/lib/invoices/ksef-send-policy';
import {
  DUPLICATE_CHECK_REASONS,
  ORIGINAL_GATE_RULES,
  type DuplicateCheckReason,
  type KsefOriginalImportGate,
} from '@/lib/ksef/duplicate-check';
import {
  DUPLICATE_DECISION_SQL_TEXTS,
  duplicateDecisionOptions,
  fillSqlText,
  type DuplicateDecisionFacts,
  type DuplicateDecisionView,
} from '@/lib/ksef/duplicate-decision';
import { isKindHeldForEnv } from '@/lib/ksef/kind-holds';
import {
  isAutoRequeueable,
  SEND_ERROR_CODES,
  sendErrorClassOf,
  type SendErrorCode,
} from '@/lib/ksef/send-error-classes';
import type { KsefEnvironment } from '@/types/ksef';

import {
  decisionFacts,
  DUP_K,
  DUP_KNOWN_ID,
  DUP_KNOWN_NUMBER,
  DUP_NR,
  knownNumberCheck,
  validCheck,
} from './helpers/ksef-duplicate-decision-cases';

/**
 * A4 z planu „zero zgubionych faktur” (definicja sukcesu nr 1): każdy stan
 * końcowy faktury wychodzącej ma WYJŚCIE — automat (cron), klient (przycisk)
 * albo operator (`/admin/ksef`). Macierz (od A4b PR2a): każdy kod katalogu
 * × rodzaj dokumentu (FA/KOR/ZAL/ROZ) × dane do ponowienia (kopia na
 * wierszu: ZAL `fa3_data.advanceEnvelope`, KOR/ROZ `special_data`, 00137)
 * × środowisko KSeF (TEST/PROD) × data wystawienia dokumentu specjalnego
 * (dziś / wcześniej) × dowód kontaktu z KSeF × otwarty wpis (`sent`/`intent`).
 * Zwykła faktura ma zawsze dane i „dzisiejszą” datę (reguła daty dotyczy
 * tylko dokumentów specjalnych, decyzja b z 06.10.2026).
 *
 * Wyjścia liczone tymi samymi czystymi modułami, z których korzystają
 * przyciski i akcje (klient i operator: fakty + `environmentKnown`; rodzaj
 * wstrzymany — prawdziwe `isKindHeldForEnv`); reguły RPC i crona odwzorowane
 * niżej (komentarz = źródło). Od A4b PR2b klient też wysyła ponownie KOR/ZAL
 * z kopii w dniu wystawienia (decyzja b), a zdanie nad jego przyciskami
 * obiecuje automat tylko tam, gdzie cron naprawdę ponowi — i nigdy nie
 * odsyła do „uzgodni operator” (takiej ścieżki w panelu nie ma; decyzja
 * z 07.10.2026: adres pomocy FaktWay). Lista ŚLEPYCH ULICZEK jest jawna:
 * każda pozycja ma sesję albo decyzję, która ją zamknie. Nowa ślepa uliczka
 * (albo zamknięta, a niewykreślona) czerwieni test.
 *
 * D-A4-1b-3 PR B: KSEF_DUPLICATE_RECONCILE z otwartym wpisem ma wymiar
 * POWODU (`original_check.reason` znacznika — 9 powodów — albo `no-check`,
 * wpis sprzed 00144). Ponowne uruchomienie deterministycznego werdyktu nie
 * jest wyjściem: I5 i „Tylko uzgodnij” liczą się tylko tam, gdzie kolejne
 * sprawdzenie może dać inny wynik (pobranie, magazyn, archiwum, brak zapisu).
 * Wyjściem zwykłej faktury przy `no-own-file` i `known-number` jest decyzja
 * klienta (panel) i operatora („Zapisz decyzję klienta”).
 */

type Kind = 'regular' | 'correction' | 'advance' | 'final';
type Env = Extract<KsefEnvironment, 'test' | 'production'>;
interface Scenario {
  code: SendErrorCode;
  kind: Kind;
  /** Czy wiersz ma kopię danych do odtworzenia zdarzenia wysyłki. */
  sendData: KsefResendFacts['sendData'];
  /** KSEF_ENV aplikacji i workera (operator zna środowisko: `environmentKnown`). */
  env: Env;
  /** Dokument specjalny z datą wystawienia sprzed dzisiaj (00147, decyzja b). */
  issueDatePassed: boolean;
  evidence: boolean;
  openSubmission: boolean;
  /** Powód znacznika przy KSEF_DUPLICATE_RECONCILE z otwartym wpisem (PR A, 00144); inaczej `null`. */
  duplicateReason: DuplicateReason | null;
  /** PR C (7.3): podprzypadek znacznika `faktflow-original`; brak — `pair` (plik z generatora, brama importable). */
  faktflow?: FaktflowCase;
  /** PR C (6.6): suchy przebieg strony operatora — plik da się zapisać (domyślnie tak); `false` przy `review-record` to runbook. */
  recordable?: boolean;
}

/**
 * Podprzypadki `faktflow-original` (spec v3 1.1): oferta (`ksef_duplicate_original_offer`)
 * albo blokada SQL, która o nich rozstrzyga.
 */
type FaktflowCase =
  | 'pair'
  | 'record'
  | 'released'
  | 'review-pair'
  | 'review-record'
  | 'no-gate'
  | 'recheck-flag'
  | 'known-now'
  | 'cross-tenant';

const FAKTFLOW_CASE_NAMES: readonly FaktflowCase[] = [
  'pair', 'record', 'released', 'review-pair', 'review-record', 'no-gate', 'recheck-flag', 'known-now', 'cross-tenant',
];

const RECHECK_AT = '2026-10-06T08:00:00.000Z';
const IMPORTABLE_GATE: KsefOriginalImportGate = { v: 1, rules: ORIGINAL_GATE_RULES, kind: 'importable', problems: [], preview: null };
const REVIEW_GATE: KsefOriginalImportGate = { v: 1, rules: ORIGINAL_GATE_RULES, kind: 'review', problems: ['rates'], preview: null };
const RELEASED_GATE: KsefOriginalImportGate = {
  ...REVIEW_GATE,
  release: { at: '2026-10-06T09:00:00.000Z', via: 'operator', actorUserId: null, note: 'Plik sprawdzony: nie powstał w FaktFlow.' },
};

/**
 * Znacznik `faktflow-original` (spec 7.3): SystemInfo `KSeF SaaS v1.0`,
 * `sameContentExceptHeader: false`, brama `importable` albo `review`
 * (`gate: null` — znacznik sprzed 00149, bez oceny pliku).
 */
function faktflowOriginalCheck(o: { env: Env; gate: KsefOriginalImportGate | null; over?: Record<string, unknown> }): Record<string, unknown> {
  const base = validCheck({
    reason: 'faktflow-original',
    env: o.env,
    sameContentExceptHeader: false,
    summary: { ...(validCheck().summary as Record<string, unknown>), systemInfo: 'KSeF SaaS v1.0' },
    ...(o.over ?? {}),
  });
  return o.gate ? { ...base, importGate: o.gate } : base;
}

/** Znacznik i kod blokady SQL (`ksef_duplicate_decision_blocker`) każdego podprzypadku — jak z bazy. */
const FAKTFLOW_CASES: Record<FaktflowCase, { gate: KsefOriginalImportGate | null; over?: Record<string, unknown>; sqlBlocker: string | null }> = {
  pair: { gate: IMPORTABLE_GATE, sqlBlocker: null },
  record: { gate: IMPORTABLE_GATE, over: { sameContentExceptHeader: true }, sqlBlocker: null },
  released: { gate: RELEASED_GATE, sqlBlocker: null },
  'review-pair': { gate: REVIEW_GATE, sqlBlocker: 'provenance-review' },
  'review-record': { gate: REVIEW_GATE, over: { ownHistory: true }, sqlBlocker: 'provenance-review' },
  'no-gate': { gate: null, sqlBlocker: 'recheck-needed' },
  'recheck-flag': { gate: IMPORTABLE_GATE, over: { recheckNeeded: { kind: 'gate-drift', at: RECHECK_AT } }, sqlBlocker: 'recheck-needed' },
  'known-now': { gate: IMPORTABLE_GATE, sqlBlocker: 'known-now' },
  'cross-tenant': { gate: IMPORTABLE_GATE, sqlBlocker: 'cross-tenant' },
};

/** Podprzypadki, w których kolejny werdykt (cron I5, „Tylko uzgodnij”) daje inną ocenę — I5 je uzgadnia. */
const RECHECK_FAKTFLOW: readonly FaktflowCase[] = ['no-gate', 'recheck-flag', 'known-now'];

/** Powód z `original_check` albo `no-check` — znacznik bez zapisu sprawdzenia (sprzed 00144). */
type DuplicateReason = DuplicateCheckReason | 'no-check';
const DUPLICATE_REASONS: readonly DuplicateReason[] = [...DUPLICATE_CHECK_REASONS, 'no-check'];

/**
 * Powody, przy których kolejne sprawdzenie (cron I5, „Tylko uzgodnij”) może
 * dać inny werdykt: oryginału nie pobrano, nie odczytano naszego pliku, nie
 * zapisano archiwum albo nie ma zapisu sprawdzenia. Pozostałe powody to
 * werdykt deterministyczny (ten sam oryginał, te same pliki) — powtórzenie
 * go nie jest wyjściem.
 */
const RECHECK_REASONS: readonly DuplicateReason[] = [
  'download-refused', 'download-pending', 'storage-pending', 'archive-pending', 'no-check',
];

/** Czy „tylko uzgodnij” (I5 albo operator) jest dla tego scenariusza wyjściem. */
function reconcileIsExit(s: Scenario): boolean {
  return s.code !== SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE
    || RECHECK_REASONS.includes(s.duplicateReason!)
    // PR C: blokada `recheck-needed` / `known-now` — I5 robi nowy werdykt (INV-25).
    || (s.faktflow !== undefined && RECHECK_FAKTFLOW.includes(s.faktflow));
}

/** Fakty ponowienia z `ksefResendFacts` — tu z wymiarów scenariusza i prawdziwego hamulca rodzaju. */
function factsOf(s: Scenario): KsefResendFacts {
  return { sendData: s.sendData, kindHeld: isKindHeldForEnv(s.kind, s.env), issueDatePassed: s.issueDatePassed };
}

const STORED: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: false };

/** `reset_ksef_send` (00131): odmowa przy dowodzie kontaktu i przy klasie reconcile. */
function resetAllowedByRpc(s: Scenario): boolean {
  return !s.evidence && sendErrorClassOf(s.code) !== 'reconcile';
}

/**
 * Cron `ksef-lifecycle-reconcile` (A4b PR2a): I6 (kody `AUTO_REQUEUE_CODES`)
 * i I7 (`KSEF_PAUSED`) wysyłają od nowa — dokument specjalny tylko z danymi,
 * rodzajem niewstrzymanym w tym środowisku (KOR nie na PROD, ROZ nigdy — C4)
 * i w dniu wystawienia; I5 (A3: otwarty wpis > 48 h, failed/rejected)
 * uzgadnia — z danymi i niewstrzymanym rodzajem, bez względu na datę.
 */
function automaticExit(s: Scenario): boolean {
  const special = s.kind !== 'regular';
  const { kindHeld } = factsOf(s);
  const canRebuild = s.sendData === 'stored' && !kindHeld;
  const canSend = canRebuild && !(special && s.issueDatePassed);
  return (canSend && (isAutoRequeueable(s.code) || s.code === SEND_ERROR_CODES.KSEF_PAUSED))
    || (canRebuild && s.openSubmission && reconcileIsExit(s));
}

const NOW = new Date('2026-10-07T12:00:00.000Z');

/**
 * Widok decyzji (D-A4-1b-3 PR B) z prawdziwej polityki — fakty jak z ładowarki:
 * znacznik z zapisem sprawdzenia danego powodu (dane oryginału kompletne),
 * przy known-number faktura Y z K i przyjęta. Tylko KSEF_DUPLICATE_RECONCILE
 * z otwartym wpisem; inaczej panelu nie ma.
 */
function duplicateViewOf(s: Scenario, actor: 'client' | 'operator'): DuplicateDecisionView | null {
  if (s.code !== SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE || !s.openSubmission || !s.duplicateReason) return null;
  const reason = s.duplicateReason;
  // PR C: `faktflow-original` — znacznik z plikiem FaktFlow i blokada SQL podana jak z bazy (domyślnie para, brama importable).
  const faktflow = reason === 'faktflow-original' ? FAKTFLOW_CASES[s.faktflow ?? 'pair'] : null;
  const check = reason === 'no-check'
    ? null
    : faktflow
      ? faktflowOriginalCheck({ env: s.env, gate: faktflow.gate, over: faktflow.over })
      : reason === 'known-number'
        ? knownNumberCheck({ env: s.env })
        : validCheck({ reason, env: s.env });
  const facts: DuplicateDecisionFacts = {
    ...decisionFacts({
      invoice: { invoice_kind: s.kind },
      check,
      knownInvoice: reason === 'known-number' ? { id: DUP_KNOWN_ID, internalNumber: DUP_KNOWN_NUMBER, holdsOriginal: true } : null,
    }),
    ...(faktflow ? { sqlBlocker: faktflow.sqlBlocker } : {}),
  };
  return duplicateDecisionOptions({ facts, actor, canManage: true, environment: s.env, now: NOW });
}

/** Przyciski właściciela (A4b PR2b): fakty ponowienia z kopii i znane środowisko — jak operator. */
function clientButtons(s: Scenario) {
  return failedInvoiceButtons({
    status: 'failed', errorCode: s.code, invoiceKind: s.kind, canManage: true, facts: factsOf(s), environmentKnown: true,
  });
}

function clientExit(s: Scenario): boolean {
  const b = clientButtons(s);
  if (!b) return false;
  // „Wyślij ponownie” klienta idzie przez `requeue_ksef_send` (klasa terminal odmawia — przycisk jej nie pokazuje).
  // D-A4-1b-3 PR B: panel decyzji („ta sama sprzedaż” / „inna sprzedaż”) — `decide_ksef_duplicate`.
  return b.resend || (b.reset && resetAllowedByRpc(s)) || duplicateViewOf(s, 'client')?.kind === 'decidable';
}

/**
 * Przyciski operatora z prawdziwej polityki — widok decyzji (actor operator) jak na karcie. PR C: `originalRecordable`
 * to wynik suchego przebiegu strony (zapisywalność pliku z przeglądu); domyślnie plik da się zapisać.
 */
function operatorButtonsOf(s: Scenario) {
  return operatorInvoiceButtons({
    direction: 'outgoing', status: 'failed', errorCode: s.code, invoiceKind: s.kind,
    openSent: s.openSubmission, evidence: s.evidence, facts: factsOf(s), environmentKnown: true,
    duplicateDecision: duplicateViewOf(s, 'operator'), duplicateNotice: null, now: NOW,
    originalRecordable: s.recordable === false ? { ok: false, detail: 'currency' } : { ok: true },
  });
}

/**
 * PR C: widok `review` (przegląd pliku, I5R; spec 5.5 i 6.6) — wyjście operatora to „Oddaj decyzję klientowi”
 * (`review-pair`) albo „Zapisz fakturę z KSeF w FaktWay”, gdy plik da się zapisać (suchy przebieg strony,
 * `recordable`). Liczone z PRAWDZIWYCH przycisków przeglądu (`operatorReviewButtons`), nie z `view.releasable`
 * i flagi scenariusza (kontrakt I5) — `review-record` bez zapisywalnego pliku nie ma wyjścia w panelu: runbook (Bartosz).
 */
function reviewExit(s: Scenario): boolean {
  const b = operatorButtonsOf(s);
  return b.record.enabled || b.release.enabled;
}

function operatorExit(s: Scenario): boolean {
  const b = operatorButtonsOf(s);
  return b.requeue.enabled || (b.reconcile.enabled && reconcileIsExit(s)) || (b.reset.enabled && resetAllowedByRpc(s))
    || b.decide.enabled || reviewExit(s);
}

const KINDS: readonly Kind[] = ['regular', 'correction', 'advance', 'final'];
const ENVS: readonly Env[] = ['test', 'production'];

function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const code of Object.values(SEND_ERROR_CODES)) {
    for (const kind of KINDS) {
      const special = kind !== 'regular';
      for (const env of ENVS) {
        for (const sendData of special ? (['stored', 'missing'] as const) : (['stored'] as const)) {
          for (const issueDatePassed of special ? [false, true] : [false]) {
            // Otwarty wpis jest dowodem kontaktu (00131/00136), więc open ⇒ evidence.
            for (const [evidence, openSubmission] of [[false, false], [true, false], [true, true]] as const) {
              const reasons = code === SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE && openSubmission ? DUPLICATE_REASONS : [null];
              for (const duplicateReason of reasons) {
                out.push({ code, kind, sendData, env, issueDatePassed, evidence, openSubmission, duplicateReason });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

/** Zdanie klienta nie zależy od dowodu kontaktu ani otwartego wpisu — jeden scenariusz na kombinację. */
const clientScenarios = () => scenarios().filter((s) => !s.evidence && !s.openSubmission);

/** Zdanie obiecuje automat — po odjęciu jawnej odmowy „nie ponowimy automatycznie”. */
const promisesAutomat = (info: string) => /automatycznie/.test(info.replace(/nie ponowimy automatycznie/g, ''));

/**
 * Czy cron I6/I7 naprawdę wyśle fakturę od nowa (`automaticExit` bez I5 —
 * I5 tylko uzgadnia otwarty wpis, niczego nie wysyła).
 */
function automaticResend(s: Scenario): boolean {
  const special = s.kind !== 'regular';
  const { kindHeld } = factsOf(s);
  return s.sendData === 'stored' && !kindHeld && !(special && s.issueDatePassed)
    && (isAutoRequeueable(s.code) || s.code === SEND_ERROR_CODES.KSEF_PAUSED);
}

const label = (s: Scenario) =>
  `${s.code} ${s.kind} ${s.env}${s.sendData === 'missing' ? ' bez-danych' : ''}${s.issueDatePassed ? ' po-dacie' : ''}`
  + `${s.evidence ? ' +dowód' : ''}${s.openSubmission ? ' +otwarty' : ''}${s.duplicateReason ? ` ${s.duplicateReason}` : ''}`;

/**
 * Powody zwykłej faktury bez decyzji w panelu po PR C — każdy z sesją, która go zamknie.
 * PR C (7.3): `faktflow-original` zniknął z listy — ma wyjście w każdym podprzypadku.
 */
const LATER_DUPLICATE_REASONS: readonly DuplicateReason[] = [
  'same-content-other-program', // D-A4-1b-2
  'archive-conflict', // runbook (porównanie plików)
];

/**
 * Znane ślepe uliczki — każda z sesją albo decyzją, która ją zamknie.
 * `noReset`: szkic odmówiony (dowód kontaktu albo klasa reconcile, 00131).
 *  - dokument specjalny bez danych do ponowienia albo rodzaju wstrzymanego
 *    w tym środowisku, bez szkicu: KOR — runbook „Stary dokument specjalny”,
 *    potem TEST, na PROD C4 (KOR_HOLD); ROZ — runbook, potem C4 (hamulec ROZ
 *    wszędzie); ZAL bez koperty po przejęciu — brak wyjścia (00132), decyzja
 *    Bartosza per faktura; wstrzymany rodzaj — C4;
 *  - otwarty wpis przy danych i niewstrzymanym rodzaju: „Tylko uzgodnij”
 *    operatora i I5 — poza KSEF_DUPLICATE_RECONCILE z werdyktem
 *    deterministycznym (niżej);
 *  - dokument specjalny po dacie wystawienia bez otwartego wpisu, bez szkicu:
 *    pełnej wysyłki nie zlecamy (decyzja b) — B2;
 *  - KSEF_DUPLICATE_RECONCILE (D-A4-1b-3 PR B):
 *    - bez otwartego wpisu (stary 440 sprzed znacznika) — D-A4-1b;
 *    - z otwartym wpisem: pobranie/magazyn/archiwum nieudane i brak zapisu
 *      (`no-check`) — I5 i „Tylko uzgodnij” (PR D: „Sprawdź ponownie”);
 *      zwykła faktura `no-own-file`, `known-number` i `faktflow-original`
 *      (PR C) — decyzja klienta i operatora, oddanie albo zapis w przeglądzie,
 *      automat (`recheck-needed`, `known-now`), NIE ślepa uliczka; wyjątki
 *      z runbookiem: `faktflow-original` `cross-tenant` („Oryginał w innej
 *      firmie”, Bartosz) i `review-record` z plikiem, którego nie da się zapisać
 *      („Zapis oryginału odmówiony”, Bartosz); `same-content-other-program` —
 *      D-A4-1b-2; `archive-conflict` — runbook; KOR/ZAL/ROZ z werdyktem
 *      deterministycznym — D-A4-1b-3-S (blokada `kind` w decyzji);
 *  - kod treści (terminal) przy dowodzie kontaktu bez otwartego wpisu — w
 *    praktyce zamknięty wpis `duplicate` po nierozstrzygniętym 440 w historii
 *    (rozstrzygnięty „numer zajęty” przenosi wpisy na `number_taken`, które
 *    nie są dowodem); wyjście: ręczny werdykt D-A4-1b.
 */
function knownDeadEnd(s: Scenario): boolean {
  const errorClass = sendErrorClassOf(s.code);
  const special = s.kind !== 'regular';
  const { kindHeld } = factsOf(s);
  const noReset = s.evidence || errorClass === 'reconcile';
  if (special && (s.sendData === 'missing' || kindHeld)) return noReset; // runbook / C4 / decyzja Bartosza (ZAL, 00132)
  if (s.code === SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE) {
    if (!s.openSubmission) return true; // D-A4-1b
    if (RECHECK_REASONS.includes(s.duplicateReason!)) return false; // I5 i „Tylko uzgodnij” (PR D)
    if (special) return true; // D-A4-1b-3-S
    if (s.faktflow === 'cross-tenant') return true; // PR C: runbook „Oryginał w innej firmie” (Bartosz)
    if (s.faktflow === 'review-record' && s.recordable === false) return true; // PR C: runbook „Zapis oryginału odmówiony” (Bartosz)
    return LATER_DUPLICATE_REASONS.includes(s.duplicateReason!); // D-A4-1b-2 / runbook
  }
  if (s.openSubmission) return false;
  if (special && s.issueDatePassed) return noReset; // B2
  return s.evidence && errorClass === 'terminal'; // D-A4-1b
}

describe('A4: każdy kod katalogu ma wyjście (automat, klient albo operator)', () => {
  it('ślepe uliczki to dokładnie znana lista z sesją albo decyzją', () => {
    // Wymiary: FA 2 środowiska × 3 (dowód, wpis) + KOR/ZAL/ROZ × 2 dane × 2 środowiska × 2 daty × 3 = 78 na kod.
    // PR B: KSEF_DUPLICATE_RECONCILE z otwartym wpisem (FA 2 + KOR/ZAL/ROZ 24 = 26) × 10 powodów zamiast 1.
    expect(scenarios()).toHaveLength(Object.values(SEND_ERROR_CODES).length * 78 + 26 * 9);
    const deadEnds = scenarios()
      .filter((s) => !automaticExit(s) && !clientExit(s) && !operatorExit(s))
      .map(label)
      .sort();
    const expected = scenarios().filter(knownDeadEnd).map(label).sort();
    expect(deadEnds).toEqual(expected);
  });

  it.each([
    SEND_ERROR_CODES.ENQUEUE_LOST,
    SEND_ERROR_CODES.INVALID_EVENT,
    SEND_ERROR_CODES.RESULT_UNCERTAIN,
  ])('%s (zwykła faktura, bez otwartego wpisu): operator może „Wyślij ponownie”', (code) => {
    for (const evidence of [false, true]) {
      const b = operatorInvoiceButtons({
        direction: 'outgoing', status: 'failed', errorCode: code, invoiceKind: 'regular', openSent: false, evidence,
        facts: STORED, environmentKnown: true,
      });
      expect(b.requeue, `${code} evidence=${evidence}`).toEqual({ enabled: true, reason: null });
    }
  });

  it.each([SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE, SEND_ERROR_CODES.ENV_MISMATCH])(
    '%s: ponowienie nadal zablokowane (decyzja D-A4), z powodem dla operatora',
    (code) => {
      const b = operatorInvoiceButtons({
        direction: 'outgoing', status: 'failed', errorCode: code, invoiceKind: 'regular', openSent: false, evidence: true,
        facts: STORED, environmentKnown: true,
      });
      expect(b.requeue.enabled).toBe(false);
      expect(b.requeue.reason).toBeTruthy();
    },
  );

  it('U15b: KSEF_DUPLICATE_RECONCILE z otwartym wpisem — ponowne sprawdzenie liczy się tylko przy powodach, które mogą dać inny werdykt', () => {
    const open = (kind: Kind, duplicateReason: DuplicateReason): Scenario => ({
      code: SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE, kind, sendData: 'stored', env: 'test',
      issueDatePassed: false, evidence: true, openSubmission: true, duplicateReason,
    });
    for (const reason of RECHECK_REASONS) {
      expect(automaticExit(open('regular', reason)), reason).toBe(true);
      expect(operatorExit(open('regular', reason)), reason).toBe(true);
    }
    for (const reason of ['no-own-file', 'known-number', 'faktflow-original', 'same-content-other-program', 'archive-conflict'] as const) {
      expect(automaticExit(open('regular', reason)), reason).toBe(false);
    }
  });

  it('U15c: cel PR B — zwykła faktura no-own-file i known-number z otwartym wpisem NIE jest ślepą uliczką; reszta ma właściciela', () => {
    const regularOpen = (duplicateReason: DuplicateReason, env: Env = 'test'): Scenario => ({
      code: SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE, kind: 'regular', sendData: 'stored', env,
      issueDatePassed: false, evidence: true, openSubmission: true, duplicateReason,
    });
    for (const env of ENVS) {
      expect(knownDeadEnd(regularOpen('no-own-file', env))).toBe(false);
      expect(knownDeadEnd(regularOpen('known-number', env))).toBe(false);
      for (const reason of LATER_DUPLICATE_REASONS) expect(knownDeadEnd(regularOpen(reason, env)), reason).toBe(true);
    }
    // KOR na TEST z kopią: decyzji dla dokumentów specjalnych nie ma (D-A4-1b-3-S).
    expect(knownDeadEnd({ ...regularOpen('no-own-file'), kind: 'correction' })).toBe(true);
    expect(knownDeadEnd({ ...regularOpen('download-pending'), kind: 'correction' })).toBe(false);
  });

  it('U15c (PR C, 7.3): faktflow-original regularna z otwartym wpisem NIE jest martwym końcem — ma realne wyjście klienta i operatora, KOR nadal czeka na D-A4-1b-3-S', () => {
    const regularOpen = (env: Env): Scenario => ({
      code: SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE, kind: 'regular', sendData: 'stored', env,
      issueDatePassed: false, evidence: true, openSubmission: true, duplicateReason: 'faktflow-original',
    });
    for (const env of ENVS) {
      expect(knownDeadEnd(regularOpen(env)), `faktflow-original ${env}`).toBe(false);
      expect(clientExit(regularOpen(env)), `faktflow-original ${env}: klient`).toBe(true);
      expect(operatorExit(regularOpen(env)), `faktflow-original ${env}: operator`).toBe(true);
    }
    expect(knownDeadEnd({ ...regularOpen('test'), kind: 'correction' })).toBe(true);
  });

  it('U15d: wyjście PR B — zwykła no-own-file i known-number: panel klienta i „Zapisz decyzję klienta” operatora', () => {
    for (const env of ENVS) {
      for (const duplicateReason of ['no-own-file', 'known-number'] as const) {
        const s: Scenario = {
          code: SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE, kind: 'regular', sendData: 'stored', env,
          issueDatePassed: false, evidence: true, openSubmission: true, duplicateReason,
        };
        expect(clientExit(s), `${env} ${duplicateReason}`).toBe(true);
        expect(operatorExit(s), `${env} ${duplicateReason}`).toBe(true);
        expect(automaticExit(s), `${env} ${duplicateReason}`).toBe(false);
      }
    }
  });

  it('U15e: żaden tekst klienta przy KSEF_DUPLICATE_RECONCILE nie odsyła do operatora (reguła 07.10)', () => {
    const texts = new Set<string>();
    for (const s of scenarios().filter((x) => x.code === SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE)) {
      for (const canManage of [true, false]) {
        for (const duplicatePanel of [true, false]) {
          const b = failedInvoiceButtons({
            status: 'failed', errorCode: s.code, invoiceKind: s.kind, canManage, facts: factsOf(s), environmentKnown: true, duplicatePanel,
          });
          if (b) texts.add(b.info);
        }
      }
      const d = decideResend({
        direction: 'outgoing', status: 'failed', errorCode: s.code, invoiceKind: s.kind, facts: factsOf(s), environmentKnown: true,
      });
      if (!d.allowed) texts.add(d.message);
    }
    expect([...texts].filter((t) => /operator/i.test(t))).toEqual([]);
  });

  it('A4b PR2a: ZAL z danymi w dniu wystawienia, RESULT_UNCERTAIN z dowodem bez otwartego wpisu — operator „Wyślij ponownie” (A4), nie ślepa uliczka', () => {
    const s: Scenario = {
      code: SEND_ERROR_CODES.RESULT_UNCERTAIN, kind: 'advance', sendData: 'stored', env: 'production',
      issueDatePassed: false, evidence: true, openSubmission: false, duplicateReason: null,
    };
    expect(operatorExit(s)).toBe(true);
    expect(knownDeadEnd(s)).toBe(false);
  });
});

/**
 * D-A4-1b-3 PR C (spec v3 7.3, „U15e” z listy zmian — w pliku nazwa U15e jest już
 * zajęta przez test tekstów klienta, stąd U15g): `faktflow-original` × podprzypadek.
 * Wyjścia liczone prawdziwą polityką klienta i operatora; blokada SQL podana jak
 * z bazy (`FAKTFLOW_CASES`). Na HEAD polityka odmawia `faktflow-original` powodem
 * `reason` w każdym podprzypadku (brak gałęzi PR C).
 */
describe('U15g (PR C, 7.3): faktflow-original — każdy podprzypadek ma wyjście', () => {
  const open = (faktflow: FaktflowCase, env: Env = 'test', extra: Partial<Scenario> = {}): Scenario => ({
    code: SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE, kind: 'regular', sendData: 'stored', env,
    issueDatePassed: false, evidence: true, openSubmission: true, duplicateReason: 'faktflow-original', faktflow, ...extra,
  });
  const clientViewOf = (s: Scenario) => duplicateViewOf(s, 'client');

  it.each(ENVS)('%s: pair, record i released — klient i operator mają decyzję, automat nie', (env) => {
    for (const faktflow of ['pair', 'record', 'released'] as const) {
      const s = open(faktflow, env);
      const client = clientViewOf(s);
      const operator = duplicateViewOf(s, 'operator');
      expect(client?.kind, `${faktflow}: widok klienta`).toBe('decidable');
      expect(operator?.kind, `${faktflow}: widok operatora`).toBe('decidable');
      expect(clientExit(s), `${faktflow}: klient`).toBe(true);
      expect(operatorExit(s), `${faktflow}: operator`).toBe(true);
      expect(operatorButtonsOf(s).decide.enabled, `${faktflow}: „Zapisz decyzję klienta”`).toBe(true);
      expect(automaticExit(s), `${faktflow}: automat`).toBe(false);
      expect(knownDeadEnd(s), `${faktflow}: martwy koniec`).toBe(false);
    }
  });

  it.each(ENVS)('%s: review-pair — klient bez wyjścia (sprawdzamy, damy znać), operator: oddanie albo zapis; wyjście nie zależy od zapisywalności pliku', (env) => {
    const s = open('review-pair', env);

    const client = clientViewOf(s);
    expect(client).toEqual({
      kind: 'refused',
      refusal: 'provenance-review',
      message: fillSqlText(DUPLICATE_DECISION_SQL_TEXTS['provenance-review'].template, DUP_NR),
    });
    expect(clientExit(s)).toBe(false);

    const operator = duplicateViewOf(s, 'operator');
    expect(operator).toMatchObject({ kind: 'review', offer: 'review-pair', releasable: true, choices: ['same_sale', 'other_sale'] });
    expect(automaticExit(s)).toBe(false); // I5R: cron I5 przeglądu nie uzgadnia (bez pętli), alarm po 72 h
    for (const recordable of [true, false]) {
      const variant = open('review-pair', env, { recordable });
      expect(operatorExit(variant), `zapisywalny: ${recordable}`).toBe(true);
      expect(knownDeadEnd(variant), `zapisywalny: ${recordable}`).toBe(false);
    }
  });

  it.each(ENVS)('%s: review-record — tylko zapis (bez oddania); plik, którego nie da się zapisać, to runbook (Bartosz)', (env) => {
    const s = open('review-record', env);

    expect(clientViewOf(s)).toMatchObject({ kind: 'refused', refusal: 'provenance-review' });
    expect(clientExit(s)).toBe(false);
    expect(duplicateViewOf(s, 'operator')).toMatchObject({
      kind: 'review', offer: 'review-record', releasable: false, choices: ['same_sale'],
    });

    expect(operatorExit(open('review-record', env, { recordable: true }))).toBe(true);
    expect(knownDeadEnd(open('review-record', env, { recordable: true }))).toBe(false);

    const notBuildable = open('review-record', env, { recordable: false });
    expect(operatorExit(notBuildable)).toBe(false);
    expect(automaticExit(notBuildable)).toBe(false);
    expect(knownDeadEnd(notBuildable)).toBe(true);
  });

  it.each(ENVS)('%s: recheck-needed (brak bramy, znacznik recheckNeeded) i known-now — automat (cron I5) i „Tylko uzgodnij”; klient bez przycisku, operator z tekstem powodu', (env) => {
    const texts: Record<'no-gate' | 'recheck-flag' | 'known-now', string> = {
      'no-gate': OPERATOR_DUPLICATE_MESSAGES.recheckPending(null, null),
      'recheck-flag': OPERATOR_DUPLICATE_MESSAGES.recheckPending('gate-drift', RECHECK_AT),
      'known-now': OPERATOR_DUPLICATE_MESSAGES.knownNow(DUP_K),
    };
    for (const faktflow of ['no-gate', 'recheck-flag', 'known-now'] as const) {
      const s = open(faktflow, env);
      expect(clientViewOf(s), faktflow).toMatchObject({ kind: 'refused', refusal: faktflow === 'known-now' ? 'known-now' : 'recheck-needed' });
      expect(clientExit(s), `${faktflow}: klient`).toBe(false);
      expect(automaticExit(s), `${faktflow}: automat`).toBe(true);
      expect(operatorButtonsOf(s).reconcile.enabled, `${faktflow}: „Tylko uzgodnij”`).toBe(true);
      const b = operatorButtonsOf(s);
      expect(b.decide, `${faktflow}: „Zapisz decyzję klienta”`).toEqual({ enabled: false, reason: texts[faktflow] });
      expect(b.remind.enabled, `${faktflow}: „Przypomnij klientowi”`).toBe(false);
      expect(knownDeadEnd(s), `${faktflow}: martwy koniec`).toBe(false);
    }
  });

  it.each(ENVS)('%s: cross-tenant — runbook (Bartosz): ani klient, ani operator, ani automat; operator widzi tekst z numerem K', (env) => {
    const s = open('cross-tenant', env);

    expect(clientViewOf(s)).toMatchObject({ kind: 'refused', refusal: 'cross-tenant' });
    expect(clientExit(s)).toBe(false);
    expect(automaticExit(s)).toBe(false);
    expect(operatorExit(s)).toBe(false);
    expect(operatorButtonsOf(s).decide).toEqual({ enabled: false, reason: OPERATOR_DUPLICATE_MESSAGES.crossTenant(DUP_K) });
    expect(knownDeadEnd(s)).toBe(true);
  });

  it('INV-25: żaden podprzypadek nie kończy się w I5D (blokada NULL) bez akcji klienta; pozostałe stoją w I5 albo I5R', () => {
    for (const faktflow of FAKTFLOW_CASE_NAMES) {
      const s = open(faktflow);
      const { sqlBlocker } = FAKTFLOW_CASES[faktflow];
      if (sqlBlocker === null) {
        expect(clientViewOf(s)?.kind, `${faktflow}: I5D wymaga widoku do decyzji klienta`).toBe('decidable');
      } else {
        // 4.10: I5 = blokada NOT NULL poza `provenance-review`; `provenance-review` to I5R.
        expect(clientViewOf(s)?.kind, `${faktflow}: blokada ${sqlBlocker}`).toBe('refused');
      }
    }
  });

  it('INV-12: każda odmowa klienta nazywa dokument i mówi, co zrobić (numer dokumentu w tekście, bez odsyłania do operatora)', () => {
    for (const faktflow of ['review-pair', 'review-record', 'no-gate', 'recheck-flag', 'known-now', 'cross-tenant'] as const) {
      const view = clientViewOf(open(faktflow));
      expect(view?.kind, faktflow).toBe('refused');
      const message = view?.kind === 'refused' ? view.message : null;
      // M1: odmowa PR B ma `message: null` — bez tej asercji pada chai ('null and string'), co wygląda na błąd testu.
      expect(typeof message, `${faktflow}: odmowa klienta ma mieć tekst (nie null)`).toBe('string');
      expect(message ?? '', faktflow).toContain(DUP_NR);
      expect(message ?? '', faktflow).toMatch(/nie wystawiaj/i);
      expect(message ?? '', faktflow).not.toMatch(/operator/i);
    }
  });
});

describe('A4b PR2b: klient — „Wyślij ponownie” z kopii i prawdziwe zdanie o automacie', () => {
  it.each([
    ['ZAL z kopią, PROD, w dniu wystawienia, KSEF_UNAVAILABLE', SEND_ERROR_CODES.KSEF_UNAVAILABLE, 'advance', 'production'],
    ['KOR z kopią, TEST, w dniu wystawienia, INFRA', SEND_ERROR_CODES.INFRA, 'correction', 'test'],
  ] as const)('(a) %s → klient ma „Wyślij ponownie”', (_label, code, kind, env) => {
    const s: Scenario = { code, kind, sendData: 'stored', env, issueDatePassed: false, evidence: false, openSubmission: false, duplicateReason: null };
    expect(clientButtons(s)?.resend).toBe(true);
  });

  it('(b) zdanie klienta nie obiecuje automatu tam, gdzie cron I6/I7 nie wyśle faktury od nowa', () => {
    const falsePromises = clientScenarios()
      .filter((s) => promisesAutomat(clientButtons(s)?.info ?? '') && !automaticResend(s))
      .map(label)
      .sort();
    expect(falsePromises).toEqual([]);
  });

  it('(c) dokument specjalny: każda obietnica automatu ma granicę dnia wystawienia', () => {
    const unbounded = clientScenarios()
      .filter((s) => s.kind !== 'regular')
      .filter((s) => {
        const info = clientButtons(s)?.info ?? '';
        return promisesAutomat(info) && !/północ|dniu wystawienia|dziś/.test(info);
      })
      .map(label)
      .sort();
    expect(unbounded).toEqual([]);
  });

  it('(d) żadne zdanie klienta nie odsyła do „uzgodni operator” (w panelu nie ma takiej ścieżki)', () => {
    const deadPromises = clientScenarios()
      .filter((s) => /uzgodni (ją|go) operator/.test(clientButtons(s)?.info ?? ''))
      .map(label)
      .sort();
    expect(deadPromises).toEqual([]);
  });

  it('(f) rodzaj wstrzymany (KOR na PROD, ROZ): żadne zdanie nie każe wystawić dokumentu od nowa przed zdjęciem blokady', () => {
    // Kolejkowanie odmówiłoby nowej korekcie na PROD i nowemu ROZ (ksef-submit-enqueue) — „od nowa” tylko „po zdjęciu blokady”.
    const premature = clientScenarios()
      .filter((s) => s.kind !== 'regular' && isKindHeldForEnv(s.kind, s.env))
      .filter((s) => {
        const info = clientButtons(s)?.info ?? '';
        return /od nowa/.test(info) && !/po zdjęciu blokady/.test(info);
      })
      .map(label)
      .sort();
    expect(premature).toEqual([]);
  });

  it('(e) strażnik: „Wyślij ponownie” klienta ⇒ „Wyślij ponownie” operatora (klient nie zleca więcej niż operator)', () => {
    const beyondOperator = scenarios()
      .filter((s) => clientButtons(s)?.resend === true)
      .filter((s) => !operatorInvoiceButtons({
        direction: 'outgoing', status: 'failed', errorCode: s.code, invoiceKind: s.kind,
        openSent: s.openSubmission, evidence: s.evidence, facts: factsOf(s), environmentKnown: true,
      }).requeue.enabled)
      .map(label);
    expect(beyondOperator).toEqual([]);
  });
});
