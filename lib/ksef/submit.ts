import { KsefApiError, ksefFetch } from './client';
import { ksefNumericStatusCode } from './normalize-status-code';
import { generateSessionEncryption, encryptInvoiceXml } from './encryption';
import { ksefSessionCache } from './session-cache';
import { ksefRateLimiter } from './rate-limiter';
import { recordKsefPollSummary } from './poll-audit';
import type { KsefAuth } from './auth';
import type {
  OpenOnlineSessionRequest,
  OpenOnlineSessionResponse,
  SendInvoiceRequest,
  SendInvoiceResponse,
  InvoiceStatusResponse,
  KsefEnvironment,
  QueryInvoicesRequest,
  QueryInvoicesResponse,
  SessionInvoicesResponse,
} from '@/types/ksef';
import { INVOICE_STATUS } from '@/types/ksef';

export interface SubmitInvoiceResult {
  /** Numer KSeF nadany fakturze po akceptacji */
  ksefNumber: string;
  /** Numer referencyjny sesji KSeF */
  sessionReferenceNumber: string;
  /** Numer referencyjny faktury w sesji */
  invoiceReferenceNumber: string;
  /**
   * Timestamp akceptacji faktury przez KSeF (ISO 8601).
   *
   * `undefined` w rzadkim scenariuszu: status przeszedł polling jako zakończony,
   * ale odpowiedź nie zawiera `acquisitionTimestamp` (spotykane głównie w test/demo
   * KSeF przy race-condition na stronie serwera). Konsumenci muszą pominąć to pole
   * przy zapisie - Postgres `TIMESTAMPTZ` odrzuca pusty string.
   */
  acquisitionTimestamp?: string;
  /** URL do pobrania UPO (ważny ograniczony czas) */
  upoDownloadUrl?: string;
}

/** Kontekst audytu (Faza 23 sekcja 3) — opcjonalny, propaguje się do każdego
 * `ksefFetch` wewnątrz tego flow. Bez niego wywołania nie są logowane do
 * `audit_logs` (backwards-compat — testy / dev scripty). Otwarcie sesji,
 * wysyłka, zamknięcie, uzgodnienie i lista faktur sesji: wiersz przy każdym
 * wywołaniu. Odpytanie statusu po wysyłce: wiersz błędu próby i jeden wiersz
 * podsumowania na fakturę (EXT-03, `pollInvoiceStatus`).
 */
export interface SubmitAuditContext {
  tenantId: string;
  invoiceId: string;
}

/**
 * Pełny flow wysyłki JEDNEJ faktury do KSeF:
 * 1. Pobierz/utwórz sesję auth
 * 2. Wygeneruj klucze szyfrowania
 * 3. Otwórz sesję online
 * 4. Zaszyfruj XML faktury
 * 5. Wyślij fakturę
 * 6. Polling statusu aż ACCEPTED/REJECTED
 * 7. Zamknij sesję
 * 8. Zwróć numer KSeF
 */
export interface SubmitInvoiceHooks {
  /**
   * Po otwarciu sesji, PRZED wysłaniem pliku (A2): zapis zamiaru wysyłki
   * z numerem sesji. Błąd hooka PRZERYWA wysyłkę — bez śladu sesji ponowienie
   * nie umiałoby sprawdzić, czy KSeF dostał plik, i wysłałoby go drugi raz.
   */
  onSessionOpened?: (session: { sessionReferenceNumber: string }) => Promise<void>;
  /**
   * Zaraz po przyjęciu pliku przez KSeF, przed odpytywaniem statusu — moment,
   * od którego ponowna wysyłka byłaby duplikatem. Błąd hooka nie przerywa
   * wysyłki (faktura już jest w KSeF), tylko zostaje zalogowany.
   */
  onInvoiceSent?: (references: {
    sessionReferenceNumber: string;
    invoiceReferenceNumber: string;
  }) => Promise<void>;
  /**
   * KSeF odpowiedział na wysyłkę pliku błędem 4xx (poza 408 — naszym
   * timeoutem): pliku w tej sesji nie ma. Pozwala zamknąć zamiar bez pytania
   * KSeF ponownie. Błąd hooka nie zmienia wyniku wysyłki, tylko zostaje
   * zalogowany (zamiar rozstrzygnie wtedy następna próba).
   */
  onInvoiceNotAccepted?: (
    session: { sessionReferenceNumber: string },
    error: KsefApiError,
  ) => Promise<void>;
}

/**
 * Czy odpowiedź KSeF na wysyłkę pliku oznacza, że plik NIE został przyjęty.
 * 4xx to odmowa po stronie KSeF; 408 to nasz timeout (odpowiedź nie dotarła),
 * a 5xx i błędy sieci — niepewność: KSeF mógł plik przyjąć.
 */
export function isInvoiceNotAcceptedError(e: unknown): e is KsefApiError {
  return e instanceof KsefApiError && e.status >= 400 && e.status < 500 && e.status !== 408;
}

export async function submitInvoice(
  invoiceXml: string,
  auth: KsefAuth,
  env?: KsefEnvironment,
  auditContext?: SubmitAuditContext,
  hooks?: SubmitInvoiceHooks,
): Promise<SubmitInvoiceResult> {
  return ksefRateLimiter.enqueue(auth.nip, async () => {
    // 1. Sesja auth (cache dispatcha na XAdES albo token wg auth.type).
    const authSession = await ksefSessionCache.getSession(auth, env);
    const accessToken = authSession.accessToken;

    // 2. Klucze szyfrowania sesji
    const encryption = await generateSessionEncryption();

    // 3. Otwórz sesję online
    const openSessionReq: OpenOnlineSessionRequest = {
      formCode: {
        systemCode: 'FA (3)',
        schemaVersion: '1-0E',
        value: 'FA',
      },
      encryption: {
        encryptedSymmetricKey: encryption.encryptedSymmetricKey,
        initializationVector: encryption.initializationVector,
      },
    };

    const session = await ksefFetch<OpenOnlineSessionResponse>('/sessions/online', {
      method: 'POST',
      accessToken,
      body: openSessionReq,
      env,
      audit: auditContext
        ? { ...auditContext, action: 'session.open' }
        : undefined,
    });

    try {
      // 3a. Zamiar wysyłki z numerem sesji — przed plikiem (A2). Błąd = bez wysyłki.
      if (hooks?.onSessionOpened) {
        await hooks.onSessionOpened({ sessionReferenceNumber: session.referenceNumber });
      }

      // 4. Szyfrowanie XML (zwraca komplet: hash+size niezaszyfrowanego
      //    i zaszyfrowanego body zgodnie z wymogami KSeF 2.0).
      const payload = encryptInvoiceXml(invoiceXml, encryption);

      // 5. Wyślij fakturę
      const sendReq: SendInvoiceRequest = {
        invoiceHash: payload.invoiceHash,
        invoiceSize: payload.invoiceSize,
        encryptedInvoiceHash: payload.encryptedInvoiceHash,
        encryptedInvoiceSize: payload.encryptedInvoiceSize,
        encryptedInvoiceContent: payload.encryptedInvoiceContent,
      };

      const sendResult = await ksefFetch<SendInvoiceResponse>(
        `/sessions/online/${session.referenceNumber}/invoices`,
        {
          method: 'POST',
          accessToken,
          body: sendReq,
          env,
          audit: auditContext
            ? {
                ...auditContext,
                action: 'invoice.send',
                metadata: { sessionRef: session.referenceNumber },
              }
            : undefined,
        }
      ).catch(async (e: unknown) => {
        if (hooks?.onInvoiceNotAccepted && isInvoiceNotAcceptedError(e)) {
          try {
            await hooks.onInvoiceNotAccepted({ sessionReferenceNumber: session.referenceNumber }, e);
          } catch (hookError) {
            console.error(
              '[ksef.submit] zamknięcie zamiaru wysyłki nieudane',
              hookError instanceof Error ? hookError.message : String(hookError),
            );
          }
        }
        throw sessionTemporarilyUnavailableAsRetryable(e);
      });

      if (hooks?.onInvoiceSent) {
        try {
          await hooks.onInvoiceSent({
            sessionReferenceNumber: session.referenceNumber,
            invoiceReferenceNumber: sendResult.referenceNumber,
          });
        } catch (e) {
          console.error(
            '[ksef.submit] zapis numerów referencyjnych nieudany',
            e instanceof Error ? e.message : String(e),
          );
        }
      }

      // 6. Polling statusu
      const invoiceStatus = await pollInvoiceStatus(
        session.referenceNumber,
        sendResult.referenceNumber,
        accessToken,
        env,
        undefined,
        undefined,
        auditContext,
      );

      if (!invoiceStatus.ksefNumber) {
        throw new Error(
          `KSeF: faktura przetworzona bez numeru KSeF. Status: ${invoiceStatus.status.description}`
        );
      }

      return {
        ksefNumber: invoiceStatus.ksefNumber,
        sessionReferenceNumber: session.referenceNumber,
        invoiceReferenceNumber: sendResult.referenceNumber,
        acquisitionTimestamp: invoiceStatus.acquisitionTimestamp,
        upoDownloadUrl: invoiceStatus.upoDownloadUrl,
      };
    } finally {
      // 7. Zamknij sesję (nawet jeśli był błąd)
      try {
        await ksefFetch(`/sessions/online/${session.referenceNumber}/close`, {
          method: 'POST',
          accessToken,
          env,
          audit: auditContext
            ? { ...auditContext, action: 'session.close' }
            : undefined,
        });
      } catch {
        // Zamknięcie sesji to best-effort
      }
    }
  });
}

/** Kod statusu faktury „Duplikat faktury” (seller NIP + RodzajFaktury + P_2). */
export const KSEF_DUPLICATE_INVOICE = 440;

/** Od 500 w górę status faktury to błąd systemu KSeF (np. 550), nie odrzucenie. */
export const KSEF_SYSTEM_STATUS_MIN = 500;

/**
 * KSeF przyjął plik, ale odrzucił fakturę w statusie (kod 400–499).
 *
 * To decyzja o TREŚCI, nie awaria łącza — ponowienie wysłałoby tę samą
 * fakturę jeszcze raz, a po wyczerpaniu prób job zaparkowałby ją w Offline24
 * jak przy awarii (z kodami QR offline dla dokumentu, którego KSeF nie chce).
 *
 * Szczególny przypadek to 440: faktura o tym numerze JUŻ jest w KSeF.
 * Najczęściej to nasza wcześniejsza wysyłka, której wyniku nie doczekaliśmy
 * (polling skończył się po 60 s, a KSeF przyjął fakturę później). Wtedy
 * komunikat podaje numer KSeF oryginału — bez tego faktura wisiałaby jako
 * błąd, choć w KSeF jest przyjęta.
 */
/** Nasza odrzucona wysyłka: skrót pliku z odpowiedzi KSeF i numery tej próby (D-A4-1). */
export interface RejectedAttempt {
  /** SHA-256 naszego pliku, Base64 — z `InvoiceStatusResponse.invoiceHash`. */
  invoiceHash?: string | null;
  sessionReferenceNumber?: string | null;
  invoiceReferenceNumber?: string | null;
}

export class KsefInvoiceRejectedError extends Error {
  readonly code: number;
  readonly originalKsefNumber: string | null;
  readonly originalSessionReferenceNumber: string | null;
  readonly ourInvoiceHash: string | null;
  readonly ourSessionReferenceNumber: string | null;
  readonly ourInvoiceReferenceNumber: string | null;

  constructor(code: number, status: InvoiceStatusResponse['status'], attempt: RejectedAttempt = {}) {
    const details = status.details?.join('; ') ?? '';
    const original = status.extensions?.originalKsefNumber ?? null;
    const originalSession = status.extensions?.originalSessionReferenceNumber ?? null;
    super(
      code === KSEF_DUPLICATE_INVOICE
        ? `KSeF ma już fakturę o tym numerze${original ? ` — numer KSeF ${original}` : ''}` +
            `${originalSession ? ` (sesja ${originalSession})` : ''}. Najpewniej to ta sama ` +
            'faktura z wcześniejszej próby: sprawdź ją w KSeF, zanim wystawisz ją ponownie. ' +
            `Szczegóły: ${details}`
        : `KSeF odrzucił fakturę: ${status.description}. Szczegóły: ${details}`,
    );
    this.name = 'KsefInvoiceRejectedError';
    this.code = code;
    this.originalKsefNumber = original;
    this.originalSessionReferenceNumber = originalSession;
    this.ourInvoiceHash = attempt.invoiceHash ?? null;
    this.ourSessionReferenceNumber = attempt.sessionReferenceNumber ?? null;
    this.ourInvoiceReferenceNumber = attempt.invoiceReferenceNumber ?? null;
  }

  get isDuplicate(): boolean {
    return this.code === KSEF_DUPLICATE_INVOICE;
  }
}

/**
 * Rozstrzyga pojedynczy status faktury — wspólne dla pollingu i uzgadniania
 * po numerze referencyjnym, żeby obie drogi decydowały identycznie.
 * Akceptacja → status; w toku → null; odrzucenie albo awaria KSeF → wyjątek.
 */
function settleInvoiceStatus(
  status: InvoiceStatusResponse,
  references?: { sessionReferenceNumber: string; invoiceReferenceNumber: string },
): InvoiceStatusResponse | null {
  const code = ksefNumericStatusCode(status.status?.code);
  if (code === INVOICE_STATUS.ACCEPTED) {
    return status;
  }
  if (Number.isFinite(code) && code >= KSEF_SYSTEM_STATUS_MIN) {
    // 5xx w statusie to przerwanie po stronie KSeF, nie ocena treści. 550:
    // „Przetwarzanie zostało przerwane z przyczyn wewnętrznych systemu.
    // Spróbuj ponownie.” (CIRFMF/ksef-docs, RC5.7). Zwykły Error = ponowienie;
    // ponowienie najpierw uzgadnia status po numerze referencyjnym.
    throw new Error(
      `KSeF przerwał przetwarzanie faktury (status ${code}): ${status.status.description}`,
    );
  }
  if (Number.isFinite(code) && code >= INVOICE_STATUS.REJECTED) {
    throw new KsefInvoiceRejectedError(code, status.status, {
      invoiceHash: status.invoiceHash ?? null,
      sessionReferenceNumber: references?.sessionReferenceNumber ?? null,
      invoiceReferenceNumber: references?.invoiceReferenceNumber ?? status.referenceNumber ?? null,
    });
  }
  return null;
}

export type InvoiceReferenceStatus =
  | { state: 'accepted'; ksefNumber: string; acquisitionTimestamp?: string }
  | { state: 'processing' };

/**
 * Jednorazowe sprawdzenie statusu faktury wysłanej wcześniej, po numerach
 * referencyjnych z `ksef_submissions` — zamiast wysyłać ją drugi raz.
 * Odrzucenie (400–499) rzuca `KsefInvoiceRejectedError`, awaria KSeF — Error.
 */
export async function checkInvoiceStatusByReference(
  references: { sessionReferenceNumber: string; invoiceReferenceNumber: string },
  auth: KsefAuth,
  env?: KsefEnvironment,
  auditContext?: SubmitAuditContext,
): Promise<InvoiceReferenceStatus> {
  return ksefRateLimiter.enqueue(auth.nip, async () => {
    const authSession = await ksefSessionCache.getSession(auth, env);
    const status = await ksefFetch<InvoiceStatusResponse>(
      `/sessions/${encodeURIComponent(references.sessionReferenceNumber)}/invoices/${encodeURIComponent(references.invoiceReferenceNumber)}`,
      {
        accessToken: authSession.accessToken,
        env,
        audit: auditContext
          ? {
              ...auditContext,
              action: 'invoice.reconcile',
              metadata: { sessionRef: references.sessionReferenceNumber },
            }
          : undefined,
      },
    );
    const settled = settleInvoiceStatus(status, references);
    if (!settled) return { state: 'processing' };
    if (!settled.ksefNumber) {
      throw new Error('KSeF: faktura przyjęta bez numeru KSeF w statusie');
    }
    return {
      state: 'accepted',
      ksefNumber: settled.ksefNumber,
      acquisitionTimestamp: settled.acquisitionTimestamp,
    };
  });
}

/** Kody KSeF przy `GET /invoices/ksef/{ksefNumber}` (open-api.json, HTTP 400). */
export const KSEF_INVOICE_NOT_FOUND = 21164;
/** „Faktura … została przetworzona, ale nie jest jeszcze dostępna do pobrania. Spróbuj ponownie później.” */
export const KSEF_INVOICE_NOT_YET_AVAILABLE = 21165;

/**
 * Faktura z KSeF po numerze KSeF — dokładne bajty pliku (D-A4-1: porównanie
 * skrótu z naszą wysyłką przy cudzym 440). Wymaga uprawnienia `InvoiceRead`.
 */
export async function downloadKsefInvoice(
  ksefNumber: string,
  auth: KsefAuth,
  env?: KsefEnvironment,
  auditContext?: SubmitAuditContext,
): Promise<Buffer> {
  return ksefRateLimiter.enqueue(auth.nip, async () => {
    const authSession = await ksefSessionCache.getSession(auth, env);
    const body = await ksefFetch<Buffer>(`/invoices/ksef/${encodeURIComponent(ksefNumber)}`, {
      accessToken: authSession.accessToken,
      headers: { Accept: 'application/xml' },
      env,
      responseType: 'bytes',
      audit: auditContext ? { ...auditContext, action: 'invoice.download-original', metadata: { ksefNumber } } : undefined,
    });
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new Error('KSeF zwrócił pusty XML faktury');
    }
    return body;
  });
}

/**
 * Data nadania numeru KSeF fakturze (`acquisitionDate` z
 * `POST /invoices/query/metadata`, filtr `ksefNumber`) — przy przyjęciu
 * numeru z duplikatu to data oryginału wyznacza wystawienie i otrzymanie
 * (art. 106na). Zakres dat jest wymagany: bierzemy dzień z numeru KSeF
 * (`NIP-RRRRMMDD-…`) z zapasem ±3 dni. `null`, gdy KSeF nie zwrócił daty.
 */
export async function fetchKsefAcquisitionDate(
  ksefNumber: string,
  auth: KsefAuth,
  env?: KsefEnvironment,
  auditContext?: SubmitAuditContext,
): Promise<string | null> {
  const day = /^\d{10}-(\d{4})(\d{2})(\d{2})-/.exec(ksefNumber);
  if (!day) return null;
  const base = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  const dayMs = 24 * 60 * 60 * 1000;
  const req: QueryInvoicesRequest = {
    subjectType: 'subject1',
    dateRange: {
      dateType: 'Invoicing',
      from: new Date(base - 3 * dayMs).toISOString(),
      to: new Date(base + 4 * dayMs - 1).toISOString(),
    },
    ksefNumber,
  };
  return ksefRateLimiter.enqueue(auth.nip, async () => {
    const authSession = await ksefSessionCache.getSession(auth, env);
    const response = await ksefFetch<QueryInvoicesResponse>('/invoices/query/metadata?pageOffset=0&pageSize=10', {
      method: 'POST',
      accessToken: authSession.accessToken,
      body: req,
      env,
      audit: auditContext ? { ...auditContext, action: 'invoice.original-metadata', metadata: { ksefNumber } } : undefined,
    });
    const hit = (response.invoices ?? []).find((i) => i.ksefNumber === ksefNumber);
    return hit?.acquisitionDate ?? null;
  });
}

/** Kod KSeF „Brak sesji o wskazanym numerze referencyjnym” (open-api.json, HTTP 400). */
export const KSEF_SESSION_NOT_FOUND = 21173;

export interface SessionInvoiceSummary {
  referenceNumber: string;
  invoiceNumber: string | null;
  /** SHA-256 niezaszyfrowanego XML, Base64. */
  invoiceHash: string;
  statusCode: number;
}

/**
 * Faktury, które KSeF ma w danej sesji online — do rozstrzygnięcia zamiaru
 * wysyłki bez numeru referencyjnego faktury (A2). Najpierw zamyka sesję:
 * po zamknięciu nic już do niej nie dotrze, więc pusta lista znaczy, że plik
 * z tamtej próby NIE trafił do KSeF. Zamknięcie odrzucone przez KSeF (4xx:
 * sesja już zamknięta albo wygasła) nie przeszkadza; chwilowa awaria (5xx,
 * 429, timeout, sieć) przerywa — bez pewnego zamknięcia nie ma pewnej listy.
 *
 * Każda nasza sesja niesie jedną fakturę, więc pierwsza strona wystarcza.
 */
export async function listSessionInvoicesAfterClose(
  sessionReferenceNumber: string,
  auth: KsefAuth,
  env?: KsefEnvironment,
  auditContext?: SubmitAuditContext,
): Promise<SessionInvoiceSummary[]> {
  return ksefRateLimiter.enqueue(auth.nip, async () => {
    const authSession = await ksefSessionCache.getSession(auth, env);
    const audit = (action: string) =>
      auditContext
        ? { ...auditContext, action, metadata: { sessionRef: sessionReferenceNumber } }
        : undefined;
    try {
      await ksefFetch(`/sessions/online/${encodeURIComponent(sessionReferenceNumber)}/close`, {
        method: 'POST',
        accessToken: authSession.accessToken,
        env,
        audit: audit('session.close'),
      });
    } catch (e) {
      if (!(e instanceof KsefApiError) || e.isRetryable || e.isAuthError) throw e;
    }
    const list = await ksefFetch<SessionInvoicesResponse>(
      `/sessions/${encodeURIComponent(sessionReferenceNumber)}/invoices?pageSize=100`,
      { accessToken: authSession.accessToken, env, audit: audit('session.invoices') },
    );
    return (list.invoices ?? []).map((inv) => ({
      referenceNumber: inv.referenceNumber,
      invoiceNumber: inv.invoiceNumber ?? null,
      invoiceHash: inv.invoiceHash,
      statusCode: ksefNumericStatusCode(inv.status?.code),
    }));
  });
}

/** Wynik odpytania statusu w wierszu podsumowania audytu (`metadata.outcome`). */
type InvoicePollOutcome = 'accepted' | 'rejected' | 'ksef-error' | 'request-error' | 'timeout';

/**
 * Polling statusu faktury co 2 sekundy aż do akceptacji / odrzucenia.
 *
 * Audyt (EXT-03, sesja 26 planu skalowania): próba trafia do `audit_logs`
 * tylko przy błędzie żądania (spoza 2xx, timeout, sieć). Po rozstrzygnięciu —
 * akceptacja, odrzucenie, błąd, koniec prób — jeden wiersz podsumowania:
 * liczba prób, czas, wynik i ostatni kod statusu KSeF. Wcześniej każda próba
 * „w kolejce” była osobnym wierszem bez kodu statusu.
 */
async function pollInvoiceStatus(
  sessionRef: string,
  invoiceRef: string,
  accessToken: string,
  env?: KsefEnvironment,
  maxAttempts = 30,
  intervalMs = 2000,
  auditContext?: SubmitAuditContext,
): Promise<InvoiceStatusResponse> {
  const startedAt = Date.now();
  let attempts = 0;
  let statusCode: number | null = null;
  let ksefNumber: string | undefined;
  // Błąd żądania (KsefApiError, sieć) wychodzi z `ksefFetch` bez zmiany wyniku.
  let outcome: InvoicePollOutcome = 'request-error';
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      attempts = attempt + 1;
      const status = await ksefFetch<InvoiceStatusResponse>(
        `/sessions/${sessionRef}/invoices/${invoiceRef}`,
        {
          accessToken,
          env,
          audit: auditContext
            ? {
                ...auditContext,
                action: 'invoice.poll',
                when: 'error',
                metadata: { sessionRef, attempt },
              }
            : undefined,
        }
      );
      statusCode = ksefNumericStatusCode(status.status?.code);

      let settled: InvoiceStatusResponse | null;
      try {
        settled = settleInvoiceStatus(status, { sessionReferenceNumber: sessionRef, invoiceReferenceNumber: invoiceRef });
      } catch (e) {
        outcome = e instanceof KsefInvoiceRejectedError ? 'rejected' : 'ksef-error';
        throw e;
      }
      if (settled) {
        outcome = 'accepted';
        ksefNumber = settled.ksefNumber;
        return settled;
      }

      // Status 150 (QUEUED) lub nieznany kod < 400 — czekamy
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    outcome = 'timeout';
    throw new Error(
      `KSeF invoice polling timed out. Session: ${sessionRef}, invoice: ${invoiceRef}`
    );
  } finally {
    if (auditContext) {
      void recordKsefPollSummary({
        tenantId: auditContext.tenantId,
        action: 'invoice.poll',
        invoiceId: auditContext.invoiceId,
        metadata: {
          sessionRef,
          attempts,
          durationMs: Date.now() - startedAt,
          outcome,
          statusCode: Number.isFinite(statusCode) ? statusCode : null,
          ...(ksefNumber ? { ksefNumber } : {}),
        },
      });
    }
  }
}

/** Kod KSeF „Sesja tymczasowo niedostępna” (API 2.8.0, produkcja od 23.09.2026). */
export const KSEF_SESSION_TEMPORARILY_UNAVAILABLE = 21184;

/**
 * Kody błędów z odpowiedzi KSeF. API zwraca je w dwóch kształtach:
 * `application/problem+json` (`errors[].code`) albo starszym
 * `exception.exceptionDetailList[].exceptionCode` (oba w `open-api.json` MF);
 * atrapy w repo mają jeszcze `exceptionDetailList` na wierzchu.
 */
export function ksefErrorCodes(body: unknown): number[] {
  // `application/problem+json` ksefFetch zostawia jako tekst (parsuje tylko `application/json`).
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return [];
    }
  }
  if (!body || typeof body !== 'object') return [];
  const b = body as {
    errors?: Array<{ code?: unknown }>;
    exception?: { exceptionDetailList?: Array<{ exceptionCode?: unknown }> };
    exceptionDetailList?: Array<{ exceptionCode?: unknown }>;
  };
  const codes = [
    ...(b.errors ?? []).map((e) => e.code),
    ...(b.exception?.exceptionDetailList ?? []).map((e) => e.exceptionCode),
    ...(b.exceptionDetailList ?? []).map((e) => e.exceptionCode),
  ];
  return codes.map(Number).filter((c) => Number.isInteger(c));
}

/**
 * 21184 przychodzi z HTTP 400, więc wyglądał jak ostateczne odrzucenie
 * faktury. MF zaleca otworzyć nową sesję i kontynuować wysyłkę — robimy to
 * kolejną próbą joba (każda próba otwiera własną sesję online), dlatego błąd
 * dostaje status ponawialny (F-050).
 */
function sessionTemporarilyUnavailableAsRetryable(e: unknown): unknown {
  if (
    e instanceof KsefApiError &&
    e.status === 400 &&
    ksefErrorCodes(e.body).includes(KSEF_SESSION_TEMPORARILY_UNAVAILABLE)
  ) {
    return new KsefApiError(
      503,
      e.body,
      `KSeF: sesja tymczasowo niedostępna (${KSEF_SESSION_TEMPORARILY_UNAVAILABLE}) — ponowimy wysyłkę w nowej sesji`,
    );
  }
  return e;
}
