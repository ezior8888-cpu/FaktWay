/**
 * Spis z natury (plan księgowości JDG, K7.4, decyzja D19). Klient zapisuje
 * spis (data, wartość) w module, a plik JPK_PKPIR(3) bierze z niego:
 * - P_1, spis na początek roku: z 31 grudnia poprzedniego roku albo z 1 stycznia;
 * - P_2, spis na koniec roku: z 31 grudnia, tylko w pliku za cały rok;
 * - PKPIRSpis: pozostałe spisy z okresu pliku (np. przy zmianie formy).
 * Koszty uzyskania w PKPIRInfo (P_3) to wydatki plus spis na początek minus
 * spis na koniec, jak w objaśnieniach do KPiR (`jpk-pkpir.ts`).
 *
 * Tabela `ledger_inventory_counts` (00173): bez UPDATE, poprawka to usunięcie
 * i nowy spis, oba z audytem. Ten sam schemat Zod sprawdza formularz i akcję.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { readCompletePagesByKey } from '@/lib/accounting/read-complete-pages';
import { kwotaNaGrosze } from '@/lib/ksiegowosc/wpisy-reczne';

/** Najwcześniejszy spis: na koniec 2025 r., czyli na początek pierwszego roku modułu. */
export const SPIS_OD = '2025-12-31';

export interface Spis {
  id: string;
  /** RRRR-MM-DD */
  data: string;
  kwotaGr: number;
  opis: string | null;
}

export const spisSchema = z.object({
  data: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Brak daty spisu.')
    .refine((v) => v >= SPIS_OD, { message: 'Spis z natury zapisuje się od 31 grudnia 2025 r. (spis na początek 2026 r.).' }),
  kwota: z.string().transform((v, ctx) => {
    const gr = kwotaNaGrosze(v);
    if (gr === null || gr < 0) {
      ctx.addIssue({ code: 'custom', message: 'Wartość spisu to kwota nie mniejsza niż zero, z najwyżej dwoma miejscami po przecinku.' });
      return z.NEVER;
    }
    return gr;
  }),
  opis: z
    .string()
    .trim()
    .max(256, 'Opis ma najwyżej 256 znaków.')
    .nullable()
    .transform((v) => (v ? v : null)),
});

export type SpisWejscie = z.input<typeof spisSchema>;

export interface SpisyPliku {
  /** P_1 */
  poczatekGr: number;
  /** Data spisu użytego jako P_1 albo null (0 zł). */
  poczatekZ: string | null;
  /** P_2 (tylko w pliku za cały rok) */
  koniecGr: number;
  koniecZ: string | null;
  /** PKPIRSpis: pozostałe spisy z okresu pliku. */
  wTrakcie: Spis[];
}

/** Pola spisu z natury dla pliku za okres [od, do]; `od` to 1 stycznia roku pliku. */
export function spisyPliku(spisy: readonly Spis[], od: string, doDnia: string): SpisyPliku {
  const rok = Number(od.slice(0, 4));
  const naDzien = (dzien: string) => spisy.find((s) => s.data === dzien) ?? null;
  const poczatek = naDzien(`${rok - 1}-12-31`) ?? naDzien(`${rok}-01-01`);
  const koniec = doDnia === `${rok}-12-31` ? naDzien(`${rok}-12-31`) : null;
  const wTrakcie = spisy
    .filter((s) => s.data >= od && s.data <= doDnia && s.id !== poczatek?.id && s.id !== koniec?.id)
    .sort((a, b) => a.data.localeCompare(b.data));
  return {
    poczatekGr: poczatek?.kwotaGr ?? 0,
    poczatekZ: poczatek?.data ?? null,
    koniecGr: koniec?.kwotaGr ?? 0,
    koniecZ: koniec?.data ?? null,
    wTrakcie,
  };
}

interface WierszSpisu {
  id: string;
  data: string;
  kwota_gr: number | string;
  opis: string | null;
}

export const KOLUMNY_SPISU = 'id, data, kwota_gr, opis';

export function zWierszaSpisu(w: WierszSpisu): Spis {
  return { id: w.id, data: w.data, kwotaGr: Number(w.kwota_gr), opis: w.opis };
}

/**
 * Spisy roku z natury: od 31 grudnia poprzedniego roku do 31 grudnia. Przed
 * wgraniem 00173 tabeli nie ma: to brak spisów, nie awaria.
 */
export async function czytajSpisy(client: SupabaseClient, tenantId: string, rok: number): Promise<Spis[]> {
  const wiersze = await readCompletePagesByKey<WierszSpisu>('kpir: spisy z natury', async ({ afterId, limit, count, head }) => {
    let q = client
      .from('ledger_inventory_counts')
      .select(KOLUMNY_SPISU, count ? { count: 'exact', head } : undefined)
      .eq('tenant_id', tenantId)
      .gte('data', `${rok - 1}-12-31`)
      .lte('data', `${rok}-12-31`);
    if (afterId !== null) q = q.gt('id', afterId);
    const wynik = await q.order('id', { ascending: true }).limit(limit);
    // Przed wgraniem 00173: Postgres 42P01, PostgREST PGRST205.
    if (wynik.error && (wynik.error.code === '42P01' || wynik.error.code === 'PGRST205')) return { data: [], count: 0, error: null };
    return { data: wynik.data as WierszSpisu[] | null, count: wynik.count, error: wynik.error };
  });
  return wiersze.map(zWierszaSpisu).sort((a, b) => a.data.localeCompare(b.data));
}
