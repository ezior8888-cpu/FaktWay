import type { Breadcrumb } from '@sentry/nextjs';

const REDACTED = '[REDACTED]';
const PRIVATE_KEY = /password|passwd|secret|token|authorization|cookie|api.?key|credential|private.?key|^email$|^nip$|^iban$|bank.?account|^address$|^phone$|^ip_address$|^query_string$|^query$|^search$|^hash$|^db\.statement$|^db\.query\.text$|(?:request|response)[._]body|^payload$/i;
const URL_KEY = /^(url|uri|from|to|referrer|referer)$|[._](url|uri)$/i;

/** Redact access links even inside exception messages and span descriptions. */
export function scrubTelemetryText(value: string): string {
  return value
    .replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/gi, '$1' + REDACTED + '@')
    // Tokeny w ścieżce: portal księgowej, zaproszenie, strona faktury dla nabywcy (krok 2.10).
    .replace(/\/(accountant|invite|faktura)\/[^/?#\s"'<>]+/gi, '/$1/' + REDACTED)
    // URLs can carry OAuth, GDPR and object-store signatures. Drop ALL parameters.
    .replace(/([?#])[^\s"'<>]*/g, '$1' + REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ' + REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED);
}

/**
 * Defensive copy for every Sentry transport, not only error events.
 * Request bodies/headers and structured credentials are deliberately omitted.
 * This is not a classifier for arbitrary personal data: never attach invoice
 * contents or free user input to telemetry in the first place.
 */
export function scrubTelemetry<T>(input: T): T {
  const seen = new WeakSet<object>();
  function visit(value: unknown, key = '', depth = 0): unknown {
    if (PRIVATE_KEY.test(key)) return REDACTED;
    if (typeof value === 'string') {
      if (URL_KEY.test(key) && /^(data|blob):/i.test(value)) return REDACTED;
      return scrubTelemetryText(value);
    }
    if (value === null || typeof value !== 'object') return value;
    if (depth > 20 || seen.has(value)) return REDACTED;
    seen.add(value);
    try {
      if (value instanceof Error) {
        return { name: value.name, message: scrubTelemetryText(value.message) };
      }
      if (Array.isArray(value)) {
        return value.map((item) => visit(item, '', depth + 1));
      }
      const source = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(source)) {
        if (childKey === '__proto__' || childKey === 'constructor') continue;
        if (key === 'request' && ['data', 'body', 'headers', 'cookies', 'env'].includes(childKey)) continue;
        if (childKey === 'user' && childValue && typeof childValue === 'object') {
          const id = (childValue as Record<string, unknown>).id;
          result.user = typeof id === 'string' || typeof id === 'number' ? { id } : {};
          continue;
        }
        result[childKey] = visit(childValue, childKey, depth + 1);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }
  return visit(input) as T;
}

/** Console arguments and DOM selectors can contain unstructured invoice data. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === 'console' || breadcrumb.category?.startsWith('ui.')) return null;
  return scrubTelemetry(breadcrumb);
}

/** Kept common across browser, Node and Edge so no transport misses the policy. */
export const sentryPrivacyOptions = {
  sendDefaultPii: false,
  // consoleLoggingIntegration bypasses beforeSend. Keep automatic log export off.
  enableLogs: false,
  beforeSend: scrubTelemetry,
  beforeSendTransaction: scrubTelemetry,
  beforeSendSpan: scrubTelemetry,
  beforeSendLog: () => null,
  beforeBreadcrumb: scrubBreadcrumb,
} as const;
