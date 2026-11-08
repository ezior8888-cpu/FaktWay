/**
 * „Ile odłożyć” (plan księgowości JDG, K5, D13): suma kwot bieżącego miesiąca
 * z danych do dziś, czyli tego, co za ten miesiąc przyjdzie zapłacić
 * w następnym (od K7.1 przy czynnym VAT także VAT). To szacunek: przychód miesiąca jeszcze rośnie, a odliczenia
 * zależą od zapłat oznaczonych do dziś. Kwoty liczy silnik „Ten miesiąc”
 * (K4), z tą samą bramką D7: bez profilu albo potwierdzonych parametrów nie
 * ma kwoty, tylko powód.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { RodzajRozliczenia } from '@/lib/ksiegowosc/ten-miesiac';
import { czytajTenMiesiac, type DaneMiesiaca } from '@/lib/ksiegowosc/ten-miesiac-dane';

export type Odlozyc =
  | {
      ok: true;
      /** RRRR-MM */
      miesiac: string;
      kwotaGr: number;
      /** Przychód miesiąca do dziś; `null`, gdy ewidencja ma w tym miesiącu braki. */
      przychodGr: number | null;
      pozycje: { rodzaj: RodzajRozliczenia; kwotaGr: number }[];
      /** Pozycje, których kwoty nie ma w sumie, z powodem. */
      braki: string[];
    }
  | { ok: false; miesiac: string; braki: string[] };

export function ileOdlozyc(miesiac: string, dane: DaneMiesiaca): Odlozyc {
  if (!dane.ok) return { ok: false, miesiac, braki: dane.braki };
  const pozycje = dane.pozycje.flatMap((p) => (p.ok ? [{ rodzaj: p.rodzaj, kwotaGr: p.kwotaGr }] : []));
  const braki = dane.pozycje.flatMap((p) => (p.ok ? [] : [p.brak]));
  if (pozycje.length === 0) return { ok: false, miesiac, braki: [...new Set(braki)] };
  return {
    ok: true,
    miesiac,
    kwotaGr: pozycje.reduce((s, p) => s + p.kwotaGr, 0),
    przychodGr: dane.wynik.przychodGr,
    pozycje,
    braki: [...new Set(braki)],
  };
}

/** Szacunek za bieżący miesiąc (dzień w strefie Europe/Warsaw, RRRR-MM-DD). */
export async function czytajOdlozyc(client: SupabaseClient, tenantId: string, dzis: string): Promise<Odlozyc> {
  const miesiac = dzis.slice(0, 7);
  return ileOdlozyc(miesiac, await czytajTenMiesiac(client, tenantId, miesiac));
}
