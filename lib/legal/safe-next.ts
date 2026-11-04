/**
 * Dokąd wrócić po akceptacji dokumentów. Tylko ścieżka w obrębie serwisu —
 * `//evil.example` albo `https://…` w parametrze to otwarte przekierowanie.
 */
export function safeNextPath(value: unknown, fallback = '/dashboard'): string {
  if (typeof value !== 'string') return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (value.startsWith('/onboarding/zgody')) return fallback;
  return value;
}
