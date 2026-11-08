/**
 * „Sprawdź ponownie” klienta przy nierozstrzygniętym duplikacie 440, gdy
 * brakuje danych oryginału (D-A4-1b-3 PR D, plan „zero zgubionych faktur”).
 * Faktura w `failed / KSEF_DUPLICATE_RECONCILE` z otwartym wpisem
 * ze znacznikiem oryginału: dopóki FaktWay nie ma treści faktury z KSeF,
 * klient nie może zdecydować (panel decyzji wymaga danych), a do PR D czekał
 * na cron I5 (48 h) albo na „Tylko uzgodnij” operatora. Teraz właściciel
 * albo administrator uruchamia uzgodnienie sam: `requeue_ksef_send` z
 * `p_reconcile_only = true` i zdarzenie z `reconcileOnly: true` — runner
 * w tym trybie NIGDY nie wysyła, tylko pobiera oryginał jeszcze raz i wydaje
 * nowy werdykt.
 *
 * Kiedy wolno (D2): znacznik bez zapisu sprawdzenia (`no-check`), powód
 * pobrania/magazynu/archiwum (`download-refused`, `download-pending`,
 * `storage-pending`, `archive-pending`) albo środowisko sprawdzenia inne niż
 * `KSEF_ENV` aplikacji (`env-mismatch`, ma pierwszeństwo). NIE dla powodów
 * z panelem decyzji (`no-own-file`, `known-number`, `faktflow-original`) ani
 * deterministycznych (`same-content-other-program`, `archive-conflict`).
 * Fakty odmowy jak „Tylko uzgodnij” operatora: `reconcileOnlyBlocker` jest
 * wspólnym rdzeniem (operator mapuje jego kod na swój tekst).
 *
 * CZYSTY moduł (importowany w komponencie klienckim i w akcji): bez bazy,
 * KSeF i Node. Wynik liczy serwer (strona karty i akcja tym samym kodem).
 */

import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import type { KsefEnvironment } from '@/types/ksef';

import { originalAssignedDay, parseDuplicateCheck, type DuplicateCheckReason, type KsefDuplicateCheck } from './duplicate-check';
import { DUPLICATE_DECISION_TEXTS, duplicateMarker, type DuplicateDecisionFacts } from './duplicate-decision';

/**
 * Wpisy `ksef_submissions`, które uzgodnienie ma czym uzgodnić: wysyłka
 * z numerem referencyjnym (`sent`) albo zamiar z numerem sesji (`intent`, A2
 * — runner zamyka sesję i pyta KSeF o jej faktury). Ta sama lista dla akcji
 * klienta, operatora i karty faktury.
 */
export const OPEN_SUBMISSION_STATUSES = ['sent', 'intent'] as const;

/** Odstęp między ponownymi sprawdzeniami tej samej faktury przez klienta (D3). */
export const DUPLICATE_RECHECK_COOLDOWN_MS = 10 * 60 * 1000;

/** Akcja audytu ponownego sprawdzenia klienta — z niej liczymy cooldown. */
export const DUPLICATE_RECHECK_AUDIT_ACTION = 'invoice.duplicate_recheck' as const;

/** Powody znacznika, przy których kolejne sprawdzenie może dać inny werdykt (nie pobrano oryginału). */
const FETCH_FAILED_REASONS: readonly DuplicateCheckReason[] = [
  'download-refused',
  'download-pending',
  'storage-pending',
  'archive-pending',
];

export const DUPLICATE_RECHECK_REASONS = [
  'no-check',
  'download-refused',
  'download-pending',
  'storage-pending',
  'archive-pending',
  'env-mismatch',
] as const;
export type DuplicateRecheckReason = (typeof DUPLICATE_RECHECK_REASONS)[number];

// ─── Wspólny rdzeń z „Tylko uzgodnij” operatora ──────────────────────────────

export type ReconcileOnlyBlocker =
  | 'incoming'
  | 'status'
  | 'env-unknown'
  | 'send-data-missing'
  | 'kind-held'
  | 'no-open-submission';

export interface ReconcileOnlyInput {
  direction: string | null;
  status: string | null;
  environmentKnown: boolean;
  facts: Pick<KsefResendFacts, 'sendData' | 'kindHeld'>;
  /** Jest otwarty wpis `sent`/`intent` (`OPEN_SUBMISSION_STATUSES`). */
  openSent: boolean;
}

/**
 * Czy uzgodnienie („tylko uzgodnij”) w ogóle da się zlecić: kierunek, status,
 * znane środowisko, kopia danych zdarzenia, rodzaj niewstrzymany, otwarty
 * wpis — w tej kolejności. Nie sprawdza klasy błędu ani daty wystawienia
 * (uzgodnienie nie wysyła). Jedna definicja dla przycisku klienta i operatora.
 */
export function reconcileOnlyBlocker(input: ReconcileOnlyInput): ReconcileOnlyBlocker | null {
  if (input.direction !== 'outgoing') return 'incoming';
  if (input.status !== 'failed' && input.status !== 'rejected') return 'status';
  if (!input.environmentKnown) return 'env-unknown';
  if (input.facts.sendData === 'missing') return 'send-data-missing';
  if (input.facts.kindHeld) return 'kind-held';
  if (!input.openSent) return 'no-open-submission';
  return null;
}

// ─── Widok ─────────────────────────────────────────────────────────────────

export type DuplicateRecheckRefusalCode = 'role' | 'env-unknown' | 'cannot-reconcile' | 'cooldown';

export interface DuplicateRecheckRefusal {
  code: DuplicateRecheckRefusalCode;
  /** Zdanie dla klienta: nazywa dokument i mówi, co zrobić. */
  message: string;
}

/**
 * Serializowalny widok dla karty faktury (strona liczy go na serwerze).
 * `refusal === null` — przycisk aktywny; `role` — dane tylko do odczytu;
 * `cooldown` — przycisk nieaktywny z zdaniem o minutach; pozostałe — samo zdanie.
 */
export interface DuplicateRecheckView {
  kind: 'recheck';
  reason: DuplicateRecheckReason;
  invoiceNumber: string | null;
  originalKsefNumber: string;
  /** Dzień nadania numeru K w KSeF (RRRR-MM-DD, Europe/Warsaw); `null`, gdy nieznany. */
  assignedDay: string | null;
  /** Odmowa pobrania 403 w tym środowisku: wskazówka o uprawnieniu InvoiceRead. */
  grantInvoiceRead: boolean;
  /**
   * Milisekundy do końca cooldownu w chwili liczenia widoku (`refusal.code === 'cooldown'`), inaczej `null`.
   * Czas względny, nie znacznik: zegar przeglądarki może się rozjeżdżać z serwerowym, a karta po tym czasie
   * odświeża się sama (bez ręcznego F5 przycisk zostałby nieaktywny).
   */
  cooldownMsLeft: number | null;
  refusal: DuplicateRecheckRefusal | null;
}

export interface DuplicateRecheckInput {
  /** Fakty ładowarki (`loadDuplicateDecisionFacts`): wiersz faktury i WSZYSTKIE wpisy `ksef_submissions`. */
  facts: DuplicateDecisionFacts;
  /** `ksefResendFacts(row, env)` — kopia danych zdarzenia i rodzaj wstrzymany. */
  sendFacts: Pick<KsefResendFacts, 'sendData' | 'kindHeld'>;
  /** Właściciel albo administrator (`canManageKsefSend`). */
  canManage: boolean;
  /** `configuredKsefEnvironment()` serwera; `null` — nieznane. */
  environment: KsefEnvironment | null;
  /** Czas ostatniego wpisu audytu `invoice.duplicate_recheck` tej faktury; `null` — brak. */
  lastRecheckAt: string | null;
  now: Date;
}

/** `(bez numeru)` jak `v_num` w tekstach SQL decyzji. */
const documentNumber = (invoiceNumber: string | null | undefined): string => invoiceNumber ?? '(bez numeru)';

/** Milisekundy do końca cooldownu; `null`, gdy cooldown minął albo wpisu nie ma. */
function cooldownMsLeft(lastRecheckAt: string | null, now: Date): number | null {
  if (lastRecheckAt === null) return null;
  const last = Date.parse(lastRecheckAt);
  if (Number.isNaN(last)) return null;
  // Data z przyszłości (rozjazd zegarów) liczy się jak świeże sprawdzenie: cooldownu nie da się nią ominąć.
  const elapsed = Math.max(0, now.getTime() - last);
  if (elapsed >= DUPLICATE_RECHECK_COOLDOWN_MS) return null;
  return DUPLICATE_RECHECK_COOLDOWN_MS - elapsed;
}

/**
 * Powód, dla którego faktura kwalifikuje się do „Sprawdź ponownie”; `null` — nie kwalifikuje się
 * (inny stan faktury, brak znacznika oryginału, powód z panelem decyzji albo deterministyczny).
 */
function recheckReasonOf(
  input: DuplicateRecheckInput,
): { reason: DuplicateRecheckReason; check: KsefDuplicateCheck | null; k: string } | null {
  const { facts, environment } = input;
  const inv = facts.invoice;
  if (!inv || inv.direction !== 'outgoing') return null;
  if (inv.ksef_status !== 'failed' || inv.last_error_code !== 'KSEF_DUPLICATE_RECONCILE') return null;
  const marker = duplicateMarker(facts.submissions);
  if (!marker || marker.original_ksef_number == null) return null;
  const k = marker.original_ksef_number;
  const raw = marker.original_check;
  // Znacznik sprzed 00144 albo bez zapisu sprawdzenia: nie wiadomo, czym jest oryginał.
  if (raw === null || raw === undefined) return { reason: 'no-check', check: null, k };
  const check = parseDuplicateCheck(raw);
  if (!check) return null;
  if (environment !== null && check.env !== environment) return { reason: 'env-mismatch', check, k };
  if (FETCH_FAILED_REASONS.includes(check.reason)) return { reason: check.reason as DuplicateRecheckReason, check, k };
  return null;
}

/**
 * Widok „Sprawdź ponownie” albo `null`, gdy faktura się nie kwalifikuje (karta pokazuje wtedy swój
 * panel decyzji albo notę). Kolejność odmów: rola, fakty uzgodnienia (`reconcileOnlyBlocker`), cooldown.
 */
export function duplicateRecheckView(input: DuplicateRecheckInput): DuplicateRecheckView | null {
  const found = recheckReasonOf(input);
  if (!found) return null;
  const { reason, check, k } = found;
  const inv = input.facts.invoice!;
  const T = DUPLICATE_DECISION_TEXTS.RECHECK;
  const nr = documentNumber(inv.internal_number);

  const base: Omit<DuplicateRecheckView, 'refusal' | 'cooldownMsLeft'> = {
    kind: 'recheck',
    reason,
    invoiceNumber: inv.internal_number,
    originalKsefNumber: k,
    assignedDay: originalAssignedDay(check, k),
    grantInvoiceRead: reason === 'download-refused' && check?.httpStatus === 403,
  };
  const refuse = (code: DuplicateRecheckRefusalCode, message: string, cooldownMs: number | null = null): DuplicateRecheckView => ({
    ...base,
    cooldownMsLeft: cooldownMs,
    refusal: { code, message },
  });

  if (!input.canManage) return refuse('role', T.ROLE);

  const blocker = reconcileOnlyBlocker({
    direction: inv.direction,
    status: inv.ksef_status,
    environmentKnown: input.environment !== null,
    facts: input.sendFacts,
    openSent: input.facts.submissions.some((s) => (OPEN_SUBMISSION_STATUSES as readonly string[]).includes(s.status)),
  });
  if (blocker === 'env-unknown') return refuse('env-unknown', T.ENV_UNKNOWN(nr));
  if (blocker !== null) return refuse('cannot-reconcile', T.CANNOT(nr));

  const cooldownMs = cooldownMsLeft(input.lastRecheckAt, input.now);
  if (cooldownMs !== null) return refuse('cooldown', T.COOLDOWN(nr, Math.ceil(cooldownMs / 60_000)), cooldownMs);

  return { ...base, cooldownMsLeft: null, refusal: null };
}
