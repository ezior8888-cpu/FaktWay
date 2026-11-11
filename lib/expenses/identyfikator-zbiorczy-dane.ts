/**
 * Zapisane identyfikatory zbiorcze (00191) do listy „Do zapłaty” (krok 1.4,
 * część 2), kluczem sesji (RLS: tylko firma z `x-active-org`). Tabela dojdzie
 * do `types/database.ts` po wgraniu migracji (typy z produkcji, AGENTS.md),
 * do tego czasu klient bez typów, jak `do-zaplaty-dane.ts`.
 *
 * Błąd odczytu, także brak tabeli przed wgraniem 00191, to pusta lista: lista
 * „Do zapłaty” działa dalej, a przycisk przy grupie i tak nie utworzy drugiego
 * identyfikatora, bo rezerwacja w bazie oddaje zapisany (RPC z 00191).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { KsefEnvironment } from '@/types/ksef';

import type { ZapisanyIdentyfikator } from './identyfikator-zbiorczy';

/** Wierszy jest tyle, ile zestawów faktur u dostawców z listy; 200 to zapas na długą historię. */
const LIMIT_ZAPISANYCH = 200;

/** Brak tabeli: PostgREST (schema cache) albo Postgres. */
const BRAK_TABELI = new Set(['PGRST205', '42P01']);

export async function wczytajZapisaneIdentyfikatory(
  supabase: unknown,
  tenantId: string,
  srodowisko: KsefEnvironment,
  nipy: readonly string[],
): Promise<ZapisanyIdentyfikator[]> {
  if (nipy.length === 0) return [];
  const { data, error } = await (supabase as SupabaseClient)
    .from('ksef_collective_identifiers')
    .select('ksef_numbers, identifier')
    .eq('tenant_id', tenantId)
    .eq('ksef_environment', srodowisko)
    .eq('status', 'ready')
    .in('seller_nip', [...nipy])
    .order('completed_at', { ascending: false })
    .limit(LIMIT_ZAPISANYCH);
  if (error) {
    if (!BRAK_TABELI.has(String((error as { code?: unknown }).code))) {
      console.error('[identyfikator-zbiorczy] odczyt zapisanych', (error as { code?: unknown }).code);
    }
    return [];
  }
  const wynik: ZapisanyIdentyfikator[] = [];
  for (const w of (data ?? []) as Array<{ ksef_numbers?: unknown; identifier?: unknown }>) {
    if (!Array.isArray(w.ksef_numbers) || !w.ksef_numbers.every((n) => typeof n === 'string')) continue;
    if (typeof w.identifier !== 'string') continue;
    wynik.push({ numeryKsef: w.ksef_numbers as string[], identyfikator: w.identifier });
  }
  return wynik;
}
