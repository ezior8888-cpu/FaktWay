/**
 * Fakty o sesji z tokenu dostępu, który GoTrue właśnie oddał serwerowi FaktWay
 * (logowanie hasłem, wymiana kodu w `/auth/callback`). Bez sprawdzania podpisu:
 * token przychodzi w odpowiedzi GoTrue na zapytanie serwera, nie od przeglądarki,
 * a służy tylko do opisu wpisu `auth.login` w audycie (`metadata.session_id`),
 * po którym lista urządzeń łączy sesję z przeglądarką (00174).
 *
 * Nigdy nie decyduj na tej podstawie o dostępie: do tego jest `getClaims()`
 * i `getVerifiedMfaState` (`lib/auth/verified-mfa.ts`).
 */

export interface AccessTokenFacts {
  sessionId: string | null;
  /** Metody z claimu `amr` (np. `password`, `oauth`, `recovery`). */
  amrMethods: string[];
}

const NOTHING: AccessTokenFacts = { sessionId: null, amrMethods: [] };
// Ten sam kształt co `isUuid` z `lib/supabase/active-org.ts`; tamten moduł ciągnie `next/headers`.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function payloadOf(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readAccessTokenFacts(token: string | null | undefined): AccessTokenFacts {
  if (typeof token !== 'string' || !token) return NOTHING;
  const payload = payloadOf(token);
  if (!payload) return NOTHING;
  const sessionId = typeof payload.session_id === 'string' && UUID.test(payload.session_id)
    ? payload.session_id.toLowerCase()
    : null;
  const amrMethods = Array.isArray(payload.amr)
    ? payload.amr.flatMap((entry: unknown) => {
      const method = entry && typeof entry === 'object' ? (entry as { method?: unknown }).method : undefined;
      return typeof method === 'string' ? [method] : [];
    })
    : [];
  return { sessionId, amrMethods };
}

/**
 * Sposób logowania w `/auth/callback`: tam trafia tylko logowanie Google (PKCE,
 * `amr` = `oauth`) i linki z e-maila (potwierdzenie konta, zmiana hasła).
 * Bez `amr` nie zgadujemy.
 */
export function loginMethodFromAmr(methods: readonly string[]): 'google' | 'email_link' | null {
  if (methods.length === 0) return null;
  return methods.includes('oauth') ? 'google' : 'email_link';
}

/** `{ session_id }` do metadanych wpisu audytu, gdy identyfikator jest znany. */
export function sessionAuditMetadata(sessionId: string | null | undefined): { session_id?: string } {
  return sessionId ? { session_id: sessionId } : {};
}
