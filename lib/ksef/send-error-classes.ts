/**
 * Katalog kodów błędu wysyłki do KSeF (`invoices.last_error_code`) — lustro
 * tabeli `ksef_error_codes` z migracji 00131. CZYSTY moduł: bez klienta KSeF,
 * walidatora XML i Node — można go importować w komponentach klienckich
 * (przyciski wg stanu faktury). Klasyfikacja wyjątków jest w
 * `send-error-codes.ts`, który re-eksportuje wszystko stąd.
 *
 * Klasa kodu decyduje o stanie faktury po wyczerpaniu prób i o wyjściach:
 *   - terminal   — ta wysyłka nie dojdzie do skutku bez decyzji o dokumencie
 *                  (błąd treści: XSD, odrzucenie przez KSeF, strażnik
 *                  dokumentu; numer zajęty; inne środowisko KSeF): tylko
 *                  powrót do szkicu;
 *   - transient  — awaria, której zniknięcie nie wymaga zmiany dokumentu
 *                  (KSeF leży, limit, sesja, nasza baza): ponowienie,
 *                  część automatycznie (cron, PR 4);
 *   - hold       — hamulec operatora albo blokada rodzaju dokumentu:
 *                  ponowienie po zdjęciu hamulca;
 *   - reconcile  — nie wiadomo, czy KSeF ma fakturę: tylko operator;
 *   - setup      — brak/niezweryfikowany certyfikat: klient uzupełnia
 *                  ustawienia i wysyła ponownie.
 */

export const SEND_ERROR_CODES = {
  XSD_INVALID: 'XSD_INVALID',
  KSEF_REJECTED: 'KSEF_REJECTED',
  INVALID_DOCUMENT: 'INVALID_DOCUMENT',
  KSEF_NUMBER_TAKEN: 'KSEF_NUMBER_TAKEN',
  KSEF_UNAVAILABLE: 'KSEF_UNAVAILABLE',
  KSEF_RATE_LIMIT: 'KSEF_RATE_LIMIT',
  KSEF_SESSION: 'KSEF_SESSION',
  INFRA: 'INFRA',
  CREDENTIALS_UNAVAILABLE: 'CREDENTIALS_UNAVAILABLE',
  TRANSIENT_EXHAUSTED: 'TRANSIENT_EXHAUSTED',
  NOT_IN_KSEF: 'NOT_IN_KSEF',
  KSEF_PAUSED: 'KSEF_PAUSED',
  KOR_HOLD: 'KOR_HOLD',
  ROZ_HOLD_RECONCILE: 'ROZ_HOLD_RECONCILE',
  KSEF_DUPLICATE_RECONCILE: 'KSEF_DUPLICATE_RECONCILE',
  RESULT_UNCERTAIN: 'RESULT_UNCERTAIN',
  ENV_MISMATCH: 'ENV_MISMATCH',
  ISSUE_DATE_PASSED: 'ISSUE_DATE_PASSED',
  INVALID_EVENT: 'INVALID_EVENT',
  ENQUEUE_LOST: 'ENQUEUE_LOST',
  NO_CERTIFICATE: 'NO_CERTIFICATE',
  NOT_VERIFIED: 'NOT_VERIFIED',
} as const;

export type SendErrorCode = (typeof SEND_ERROR_CODES)[keyof typeof SEND_ERROR_CODES];
export type SendErrorClass = 'terminal' | 'transient' | 'hold' | 'reconcile' | 'setup';

/**
 * Kod odmowy wysyłki PRZED kolejką (`ksef-submit-enqueue.ts`, akcje operatora
 * `/admin/ksef`) — wiersz `refused` w dzienniku prób (`ksef_send_attempts`,
 * 00150). Kody z katalogu, gdy znaczą to samo (hamulce, certyfikat, KSeF
 * niedostępny; odmowa operatora z powodu klasy błędu faktury — jej kod), plus
 * własne odmowy bez odpowiednika w katalogu (klasa `null`).
 */
export type SendRefusalCode =
  | SendErrorCode
  | 'MFA_REQUIRED'
  | 'PAUSE_UNKNOWN'
  | 'OFFLINE_QUEUE_ERROR'
  | 'ENQUEUE_REFUSED'
  | 'ENQUEUE_ERROR'
  // Odmowy operatora (`lib/admin/ksef-operator-policy.ts`, `app/admin/ksef/actions.ts`).
  | 'STATUS_NOT_ALLOWED'
  | 'NO_OPEN_SUBMISSION'
  | 'ENV_UNKNOWN'
  | 'SEND_DATA_MISSING'
  | 'NO_NIP';

export const SEND_ERROR_CLASS: Record<SendErrorCode, SendErrorClass> = {
  XSD_INVALID: 'terminal',
  KSEF_REJECTED: 'terminal',
  INVALID_DOCUMENT: 'terminal',
  // D-A4-1 (00142): numer faktury jest w KSeF na fakturze tej firmy z innego
  // programu (treść sprawdzona) — klient wystawia z nowym numerem.
  KSEF_NUMBER_TAKEN: 'terminal',
  KSEF_UNAVAILABLE: 'transient',
  KSEF_RATE_LIMIT: 'transient',
  KSEF_SESSION: 'transient',
  INFRA: 'transient',
  CREDENTIALS_UNAVAILABLE: 'transient',
  TRANSIENT_EXHAUSTED: 'transient',
  // A2b (00141): „tylko uzgodnij” stwierdził, że KSeF nie ma faktury od nas
  // (zamiar porzucony, wpis STALE, brak dowodu kontaktu). Bez automatu —
  // ponowna wysyłka to decyzja klienta (data wystawienia, B1/B2).
  NOT_IN_KSEF: 'transient',
  KSEF_PAUSED: 'hold',
  KOR_HOLD: 'hold',
  ROZ_HOLD_RECONCILE: 'hold',
  KSEF_DUPLICATE_RECONCILE: 'reconcile',
  RESULT_UNCERTAIN: 'reconcile',
  // D-A4-2 (00143): zdarzenie z innego środowiska KSeF niż skonfigurowane.
  // Ponowienie wysłałoby fakturę w bieżącym (np. dokument z TEST na PROD) —
  // tylko szkic, klient decyduje, czy wysłać ją tutaj.
  ENV_MISMATCH: 'terminal',
  // 00147 (decyzja 06.10.2026): dokument specjalny z datą wystawienia sprzed
  // dzisiaj — worker nie wysyła go po północy; tylko szkic (bez automatu).
  ISSUE_DATE_PASSED: 'terminal',
  INVALID_EVENT: 'reconcile',
  ENQUEUE_LOST: 'reconcile',
  NO_CERTIFICATE: 'setup',
  NOT_VERIFIED: 'setup',
};

/** Kody, które cron cyklu życia ponawia sam (co 60 min przez 24 h — decyzja D1). */
export const AUTO_REQUEUE_CODES: readonly SendErrorCode[] = [
  SEND_ERROR_CODES.KSEF_UNAVAILABLE,
  SEND_ERROR_CODES.KSEF_RATE_LIMIT,
  SEND_ERROR_CODES.KSEF_SESSION,
  SEND_ERROR_CODES.INFRA,
];

export function isSendErrorCode(code: string | null | undefined): code is SendErrorCode {
  return typeof code === 'string' && code in SEND_ERROR_CLASS;
}

/** Klasa kodu z wiersza faktury; `null` dla braku kodu albo kodu spoza katalogu (historyczny). */
export function sendErrorClassOf(code: string | null | undefined): SendErrorClass | null {
  return isSendErrorCode(code) ? SEND_ERROR_CLASS[code] : null;
}

export function isAutoRequeueable(code: string | null | undefined): boolean {
  return AUTO_REQUEUE_CODES.includes(code as SendErrorCode);
}

/** Kody, przy których faktura kończy jako `rejected` (KSeF/XSD odrzucił treść). */
export function isContentRejection(code: SendErrorCode): boolean {
  return code === SEND_ERROR_CODES.XSD_INVALID || code === SEND_ERROR_CODES.KSEF_REJECTED;
}
