/**
 * `fetch` dla klienta Supabase w proxy: jedno `GET /auth/v1/user` na token
 * w obrębie jednego żądania (plan skalowania, sesja 8).
 *
 * Bramka pyta GoTrue o ten sam token trzy razy: `getClaims()` w `updateSession`,
 * a potem `getUser(token)` i `getClaims(token)` w kontroli MFA. Przy kluczu
 * HS256 każde `getClaims` to też `getUser` wewnątrz biblioteki, więc wywołań nie
 * da się skleić wyżej. Kolejne pytania dostają kopię pierwszej odpowiedzi, a kod
 * kontroli MFA i jej kolejność zostają bez zmian.
 *
 * Twórz nowy `fetch` na każde żądanie i nie przenoś go dalej: pamięć wyniku
 * trwa tylko tyle, co jedna decyzja bramki. Sesja cofnięta w GoTrue jest
 * odrzucona już przy następnym żądaniu. Odmowy i błędy nie zostają w pamięci.
 *
 * `baseFetch` to `fetch`, który naprawdę idzie do sieci (w proxy: z terminem
 * bramki, sesja 5). Bez niego globalny `fetch` z chwili wywołania.
 */
export function createAuthUserFetch(baseFetch?: typeof fetch): typeof fetch {
  const accepted = new Map<string, Response>();
  const send: typeof fetch = (input, init) => (baseFetch ?? fetch)(input, init);

  return async (input, init) => {
    const authorization = isAuthUserRead(input, init) ? requestHeaders(input, init).get('authorization') : null;
    if (!authorization) return send(input, init);

    const known = accepted.get(authorization);
    if (known) return known.clone();

    const response = await send(input, init);
    if (!response.ok) return response;
    accepted.set(authorization, response);
    return response.clone();
  };
}

function isAuthUserRead(input: RequestInfo | URL, init?: RequestInit): boolean {
  const isRequest = typeof input !== 'string' && !(input instanceof URL);
  const method = init?.method ?? (isRequest ? input.method : 'GET');
  const url = isRequest ? input.url : input;
  return method.toUpperCase() === 'GET' && new URL(url).pathname === '/auth/v1/user';
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  if (init?.headers) return new Headers(init.headers);
  return typeof input !== 'string' && !(input instanceof URL) ? input.headers : new Headers();
}
