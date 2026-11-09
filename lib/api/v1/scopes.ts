import { z } from 'zod';

/**
 * Zakresy kluczy API i formularz „Nowy klucz API” (krok 7.1, 00181). Bez
 * `node:crypto`, więc moduł może trafić do przeglądarki (formularz w Ustawieniach).
 * Generator i skrót klucza: `lib/api/v1/keys.ts` (tylko serwer).
 */

/** Ta sama lista co CHECK `api_keys_scopes_check` (00181). */
export const API_KEY_SCOPES = ['invoices:read', 'expenses:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  'invoices:read': 'Odczyt faktur',
  'expenses:read': 'Odczyt kosztów',
};

/** Ten sam limit pilnuje wyzwalacz `guard_api_key` (00181). */
export const MAX_ACTIVE_API_KEYS = 10;

/** Zakresy w stałej kolejności i bez powtórzeń (tak zapisujemy je w bazie). */
export function canonicalScopes(scopes: readonly ApiKeyScope[]): ApiKeyScope[] {
  return API_KEY_SCOPES.filter((scope) => scopes.includes(scope));
}

/** Formularz „Nowy klucz API”: ten sam schemat w przeglądarce i w akcji. */
export const apiKeyCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Podaj nazwę klucza, np. nazwę programu, który go użyje.')
    .max(80, 'Nazwa klucza może mieć najwyżej 80 znaków.'),
  scopes: z
    .array(z.enum(API_KEY_SCOPES))
    .min(1, 'Zaznacz, co program może czytać.')
    .max(API_KEY_SCOPES.length),
});

