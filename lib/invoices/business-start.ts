/**
 * Data rozpoczęcia działalności firmy — `tenants.business_started_on`
 * (migracja 00153). Potrzebna do limitu zwolnienia podmiotowego z VAT:
 * firma, która ruszyła w trakcie roku, ma limit proporcjonalny do dni
 * działalności (art. 113 ust. 9 ustawy o VAT).
 *
 * Walidacja jest jedna dla formularza i akcji serwerowej (`businessStartSchema`).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/**
 * „Nie ma takiej kolumny” — przed wgraniem 00153. Postgres zwraca 42703
 * (odczyt), a PostgREST przy PATCH z nieznaną kolumną odpowiada PGRST204.
 */
export function isMissingColumnError(code: string | undefined): boolean {
  return code === '42703' || code === 'PGRST204';
}

/** Dolna granica z CHECK w 00153. */
export const BUSINESS_START_MIN = '1900-01-01';

function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * Pole formularza: pusty tekst = „nie podaję” (NULL), inaczej RRRR-MM-DD
 * od 1900-01-01 do `today` (dziś w Europe/Warsaw, podawane z zewnątrz, żeby
 * schemat działał tak samo w przeglądarce i na serwerze).
 */
export function businessStartSchema(today: string) {
  return z
    .string()
    .trim()
    .transform((value) => (value === '' ? null : value))
    .refine((value) => value === null || isCalendarDate(value), {
      message: 'Podaj datę w formacie DD.MM.RRRR.',
    })
    .refine((value) => value === null || value >= BUSINESS_START_MIN, {
      message: 'Data rozpoczęcia działalności nie może być wcześniejsza niż 1900 rok.',
    })
    .refine((value) => value === null || value <= today, {
      message: 'Data rozpoczęcia działalności nie może być z przyszłości.',
    });
}

/**
 * Data po walidacji albo `null` („nie podano”). Rzuca `Error` z polskim
 * komunikatem pierwszego naruszenia.
 */
export function normalizeBusinessStart(input: unknown, today: string): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') throw new Error('Podaj datę w formacie DD.MM.RRRR.');
  const parsed = businessStartSchema(today).safeParse(input);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Nieprawidłowa data rozpoczęcia działalności.');
  }
  return parsed.data;
}

/**
 * Odczyt odporny na kolejność wdrożenia: przed migracją 00153 brak kolumny
 * znaczy „data nieznana”, a nie wywrócona strona. Każdy inny błąd rzuca —
 * „nie wiem” to nie „brak daty”.
 */
export async function readTenantBusinessStart(
  client: SupabaseClient,
  tenantId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from('tenants')
    .select('business_started_on')
    .eq('id', tenantId)
    .maybeSingle();
  if (error) {
    if (isMissingColumnError(error.code)) return null;
    throw new Error(`Nie można odczytać daty rozpoczęcia działalności: ${error.message}`);
  }
  const raw = (data as { business_started_on?: unknown } | null)?.business_started_on;
  return typeof raw === 'string' && isCalendarDate(raw) ? raw : null;
}
