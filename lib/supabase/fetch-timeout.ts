/**
 * Limity czasu wywołań Supabase (plan skalowania 3000, sesja 5: REQ-V01,
 * QRY-V1, LIM-05).
 *
 * Bez limitu zawieszony GoTrue albo PostgREST trzymał żądanie do 300 s
 * (domyślny limit undici) w jedynym procesie Node na app-1, a proxy brało
 * błąd po czasie za brak sesji i kierowało na logowanie. Tu są dwa narzędzia:
 *
 *  - `createSupabaseFetch`: `fetch` klienta z limitem na jedno wywołanie,
 *    razem z czytaniem treści odpowiedzi. Odczyt (GET, HEAD) ma krótszy
 *    limit, zapis dłuższy, bo przerwany zapis mógł się w bazie wykonać
 *    (LIM-05: limit klienta nie wycofuje transakcji). Worker pg-boss ma oba
 *    dłuższe (`enableWorkerSupabaseTimeouts`).
 *  - `createSupabaseDeadline`: jeden termin na całą bramkę w proxy. Po nim
 *    decyzja to 503 „spróbuj ponownie”, nigdy wylogowanie.
 *
 * Przekroczenie to `SupabaseTimeoutError` (`name` 'TimeoutError', `code`
 * 'ABORT_ERR'). PostgREST go nie ponawia i oddaje jako `error`, auth-js jako
 * `AuthRetryableFetchError` (błąd przejściowy, a nie odmowa sesji, więc bez
 * kasowania ciasteczek). W jobie to zwykły błąd, więc pg-boss ponawia handler.
 */

import { cache } from 'react';

/** Cała bramka w proxy: sesja, przerwa techniczna, 2FA i wybór firmy razem. */
export const PROXY_GATE_TIMEOUT_MS = 5_000;
/** Odczyt w żądaniu (RSC, akcja, trasa API). `authenticated` ma w bazie ok. 8 s. */
export const REQUEST_READ_TIMEOUT_MS = 10_000;
/** Zapis w żądaniu (POST, PATCH, PUT, DELETE, także RPC). */
export const REQUEST_WRITE_TIMEOUT_MS = 30_000;
/** Odczyt w workerze pg-boss. `service_role` nie ma limitu w bazie. */
export const WORKER_READ_TIMEOUT_MS = 60_000;
/** Zapis w workerze pg-boss. */
export const WORKER_WRITE_TIMEOUT_MS = 120_000;

export class SupabaseTimeoutError extends Error {
  readonly code = 'ABORT_ERR';

  constructor(readonly limitMs: number, operation: string) {
    super(`Supabase nie odpowiedział w ${limitMs} ms (${operation})`);
    this.name = 'TimeoutError';
  }
}

type Limits = { readonly read: number; readonly write: number };

const REQUEST_LIMITS: Limits = { read: REQUEST_READ_TIMEOUT_MS, write: REQUEST_WRITE_TIMEOUT_MS };
const WORKER_LIMITS: Limits = { read: WORKER_READ_TIMEOUT_MS, write: WORKER_WRITE_TIMEOUT_MS };

let processLimits: Limits = REQUEST_LIMITS;

/**
 * Proces workera pg-boss: dłuższe limity dla każdego klienta w procesie.
 * `fetch` czyta je przy każdym wywołaniu, więc obejmują też klientów
 * utworzonych przy imporcie modułów, przed `main()` workera.
 */
export function enableWorkerSupabaseTimeouts(): void {
  processLimits = WORKER_LIMITS;
}

/**
 * `fetch` dla klienta Supabase (`global.fetch`). Limit liczy się od wysłania
 * żądania do przeczytania całej treści odpowiedzi. Sygnał wywołującego (np.
 * `.abortSignal()` w PostgREST) i `deadline` dalej działają.
 *
 * Wyjątek dla sklejania w Next: w renderze RSC Next 16 wysyła identyczne GET
 * i HEAD do sieci raz na render (`dedupe-fetch`), ale tylko bez `signal`.
 * Na tym stoi sesja 9 planu: powtórzone `getUser()` w layoutach i na stronie
 * to jedno wywołanie GoTrue. Taki odczyt (w renderze, bez sygnału wołającego)
 * idzie więc bez sygnału: limit zwalnia wołającego tak samo, a odpowiedź, która
 * przyjdzie po limicie, jest zamykana. Poza renderem (proxy, akcje, trasy API,
 * worker) Next niczego nie skleja i sygnał przerywa też samo połączenie.
 */
export function createSupabaseFetch(options: { deadline?: AbortSignal } = {}): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    const limitMs = isRead ? processLimits.read : processLimits.write;
    const own = new AbortController();
    const keepNextDedupe = isRead && !init?.signal && !options.deadline && insideRenderScope();
    let signal: AbortSignal | undefined;
    if (!keepNextDedupe) {
      const signals = [own.signal];
      const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (callerSignal) signals.push(callerSignal);
      if (options.deadline) signals.push(options.deadline);
      signal = signals.length === 1 ? own.signal : AbortSignal.any(signals);
      // Termin minął wcześniej (np. ponowienie auth-js po 503 z bramki): bez sieci.
      if (signal.aborted) throw signal.reason;
    }

    const timer = setTimeout(() => own.abort(new SupabaseTimeoutError(limitMs, operationName(method, input))), limitMs);
    let response: Response;
    try {
      response = signal
        ? await fetch(input, { ...init, signal })
        : await untilAborted(fetch(input, init), own.signal);
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
    if (!response.body) {
      clearTimeout(timer);
      return response;
    }
    // Treść płynie przez ten sam limit: serwer, który wysłał nagłówki i stanął,
    // to też zawieszony serwer. Po limicie strumień pada błędem limitu, a źródło
    // jest zamykane. Zegar gaśnie, gdy treść dojdzie do końca albo padnie.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    response.body.pipeTo(writable, { signal: own.signal }).then(() => clearTimeout(timer), () => clearTimeout(timer));
    return new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * Ten sam obiekt w obrębie jednego renderu RSC, nowy poza nim (`cache()` bez
 * renderu niczego nie pamięta). Na `cache()` z Reacta stoi też sklejanie
 * `fetch` w Next, więc próbnik mówi, czy Next może tu skleić identyczne GET.
 */
const renderScopeProbe = cache((): object => ({}));

function insideRenderScope(): boolean {
  return renderScopeProbe() === renderScopeProbe();
}

/**
 * Odpowiedź albo błąd limitu, gdy `signal` przerwie czekanie wcześniej. Samego
 * żądania nie przerywa (bez sygnału Next może je skleić). Odpowiedź, która
 * przyjdzie po limicie, zamyka, żeby nieczytana treść nie trzymała połączenia.
 */
function untilAborted(pending: Promise<Response>, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason);
      pending.then((late) => late.body?.cancel(signal.reason).catch(() => {}), () => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (response) => {
        signal.removeEventListener('abort', onAbort);
        resolve(response);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Sygnał, że termin bramki minął, zanim praca się skończyła. */
export const TIMED_OUT: unique symbol = Symbol('supabase.timed-out');

export type SupabaseDeadline = {
  /** Przerywa wszystkie wywołania, które go dostały (`createSupabaseFetch`). */
  readonly signal: AbortSignal;
  /**
   * Wynik pracy albo `TIMED_OUT`, gdy termin minie wcześniej. Po terminie
   * każdy wynik to `TIMED_OUT`: błąd z przerwanego `fetch` (np. auth-js
   * zamienia go w „brak sesji”) nie może udawać odpowiedzi serwera.
   */
  within<T>(work: PromiseLike<T>): Promise<T | typeof TIMED_OUT>;
  /** Kasuje zegar. Wołaj w `finally`, także po `TIMED_OUT`. */
  dispose(): void;
};

export function createSupabaseDeadline(limitMs: number, operation: string): SupabaseDeadline {
  const controller = new AbortController();
  let expire: () => void = () => {};
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    expire = () => resolve(TIMED_OUT);
  });
  const timer = setTimeout(() => {
    expire();
    controller.abort(new SupabaseTimeoutError(limitMs, operation));
  }, limitMs);

  return {
    signal: controller.signal,
    async within<T>(work: PromiseLike<T>): Promise<T | typeof TIMED_OUT> {
      try {
        const result = await Promise.race([Promise.resolve(work), expired]);
        return controller.signal.aborted ? TIMED_OUT : result;
      } catch (error) {
        if (controller.signal.aborted) return TIMED_OUT;
        throw error;
      }
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Metoda i początek ścieżki do komunikatu błędu (np. `GET /rest/v1/invoices`).
 * Bez zapytania (filtry niosą NIP-y i adresy e-mail) i bez identyfikatorów.
 */
function operationName(method: string, input: RequestInfo | URL): string {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  let path: string;
  try {
    path = new URL(href).pathname;
  } catch {
    return method;
  }
  const segments = path.split('/').filter(Boolean).slice(0, 4).map((segment) => (UUID.test(segment) ? ':id' : segment));
  return `${method} /${segments.join('/')}`;
}
