/**
 * Odczyt „Ten miesiąc” (plan księgowości JDG, K4): parametry sprawdzone przez
 * księgową (D7), ewidencja roku (K3), zatwierdzone rozliczenia i zapłaty
 * (`tax_settlements`, 00168), potem `tenMiesiac`. Każde rozliczenie dostaje
 * skrót wejść: zatwierdzenie zapisuje go, a inny skrót po zmianie danych
 * oznacza nową wersję (D6).
 */

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { czytajEwidencje } from '@/lib/ksiegowosc/ewidencja-dane';
import { brakujace, parametryRoku, rokSkladkowyZdrowotnej } from '@/lib/ksiegowosc/parametry';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import {
  RODZAJE_ROZLICZEN,
  tenMiesiac,
  type Platnosc,
  type PozycjaDoZaplaty,
  type RodzajRozliczenia,
  type WynikMiesiaca,
} from '@/lib/ksiegowosc/ten-miesiac';

export interface Rozliczenie {
  id: string;
  /** RRRR-MM */
  miesiac: string;
  rodzaj: RodzajRozliczenia;
  wersja: number;
  kwotaGr: number;
  termin: string;
  status: 'zatwierdzone' | 'zaplacone';
  wejsciaHash: string;
  zatwierdzoneO: string;
  zaplaconeO: string | null;
  spoleczneBezFpGr: number;
}

export interface PozycjaZeSkrotem extends PozycjaDoZaplaty {
  wejsciaHash: string;
}

export type DaneMiesiaca =
  | {
      ok: true;
      wynik: WynikMiesiaca;
      pozycje: PozycjaZeSkrotem[];
      parametryWersja: string;
      /** Wszystkie wersje rozliczeń tego miesiąca, rosnąco. */
      rozliczenia: Rozliczenie[];
      wersje: WersjaProfilu[];
    }
  | { ok: false; braki: string[]; rozliczenia: Rozliczenie[] };

export const KOLUMNY_ROZLICZENIA =
  'id, okres, rodzaj, wersja, kwota_gr, termin, status, migawka, wejscia_hash, zatwierdzone_o, zaplacone_o';

interface WierszRozliczenia {
  id: string;
  okres: string;
  rodzaj: RodzajRozliczenia;
  wersja: number;
  kwota_gr: number | string;
  termin: string;
  status: 'zatwierdzone' | 'zaplacone';
  migawka: { spoleczneBezFpGr?: number } | null;
  wejscia_hash: string;
  zatwierdzone_o: string;
  zaplacone_o: string | null;
}

export function zWierszaRozliczenia(w: WierszRozliczenia): Rozliczenie {
  return {
    id: w.id,
    miesiac: w.okres.slice(0, 7),
    rodzaj: w.rodzaj,
    wersja: w.wersja,
    kwotaGr: Number(w.kwota_gr),
    termin: w.termin,
    status: w.status,
    wejsciaHash: w.wejscia_hash,
    zatwierdzoneO: w.zatwierdzone_o,
    zaplaconeO: w.zaplacone_o,
    spoleczneBezFpGr: Number(w.migawka?.spoleczneBezFpGr ?? 0),
  };
}

/** JSON z kluczami po kolei: ten sam obiekt zawsze daje ten sam skrót. */
export function stabilnyJson(wartosc: unknown): string {
  if (Array.isArray(wartosc)) return `[${wartosc.map(stabilnyJson).join(',')}]`;
  if (wartosc && typeof wartosc === 'object') {
    const wpisy = Object.entries(wartosc as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${wpisy.map(([k, v]) => `${JSON.stringify(k)}:${stabilnyJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(wartosc ?? null);
}

export const skrot = (tekst: string) => createHash('sha256').update(tekst).digest('hex');

function czyBrakTabeli(kod: string | undefined): boolean {
  // Przed wgraniem 00168: Postgres 42P01, PostgREST PGRST205.
  return kod === '42P01' || kod === 'PGRST205';
}

/** Rozliczenia od grudnia roku poprzedniego do miesiąca: zapłaty grudnia odlicza się w styczniu. */
export async function czytajRozliczenia(client: SupabaseClient, tenantId: string, od: string, doDnia: string): Promise<Rozliczenie[]> {
  const wiersze = await readCompletePages<WierszRozliczenia>('ten miesiąc: rozliczenia', async (from, to) => {
    const wynik = await client
      .from('tax_settlements')
      .select(KOLUMNY_ROZLICZENIA, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .gte('okres', od)
      .lte('okres', doDnia)
      .order('id', { ascending: true })
      .range(from, to);
    if (wynik.error && czyBrakTabeli(wynik.error.code)) return { data: [], count: 0, error: null };
    return { data: wynik.data as WierszRozliczenia[] | null, count: wynik.count, error: wynik.error };
  });
  return wiersze.map(zWierszaRozliczenia).sort((a, b) => a.miesiac.localeCompare(b.miesiac) || a.rodzaj.localeCompare(b.rodzaj) || a.wersja - b.wersja);
}

export async function czytajTenMiesiac(client: SupabaseClient, tenantId: string, miesiac: string): Promise<DaneMiesiaca> {
  const rok = Number(miesiac.slice(0, 4));
  const rokSkladkowy = rokSkladkowyZdrowotnej(miesiac);

  let rozliczenia: Rozliczenie[];
  try {
    rozliczenia = await czytajRozliczenia(client, tenantId, `${rok - 1}-12-01`, `${miesiac}-01`);
  } catch (e) {
    console.error('[ten-miesiac] rozliczenia', e instanceof Error ? e.message : e);
    return { ok: false, braki: ['Nie udało się odczytać rozliczeń, więc nie pokazujemy kwot. Strona spróbuje ponownie przy następnym otwarciu.'], rozliczenia: [] };
  }
  const tegoMiesiaca = rozliczenia.filter((r) => r.miesiac === miesiac);

  // D7: bez parametrów potwierdzonych przez księgową nie ma kwoty.
  const brakParametrow = [...brakujace(rok, ['ryczalt', 'zus']), ...brakujace(rokSkladkowy, ['zdrowotna'])];
  if (brakParametrow.length > 0) {
    return { ok: false, braki: brakParametrow.map((b) => b.komunikat), rozliczenia: tegoMiesiaca };
  }

  const ewidencja = await czytajEwidencje(client, tenantId, rok);
  if (!ewidencja.ok) return { ok: false, braki: [ewidencja.komunikat], rozliczenia: tegoMiesiaca };

  const platnosci: Platnosc[] = rozliczenia
    .filter((r) => r.status === 'zaplacone' && r.zaplaconeO)
    .map((r) => ({
      miesiac: r.miesiac,
      rodzaj: r.rodzaj,
      wersja: r.wersja,
      kwotaGr: r.kwotaGr,
      spoleczneBezFpGr: r.spoleczneBezFpGr,
      zaplaconeO: r.zaplaconeO as string,
    }));

  const wynik = tenMiesiac({ miesiac, ewidencja: ewidencja.ewidencja, wersje: ewidencja.wersje, platnosci, parametry: parametryRoku });
  if (!wynik.ok) return { ok: false, braki: wynik.braki, rozliczenia: tegoMiesiaca };

  const p = parametryRoku(rok);
  const pz = parametryRoku(rokSkladkowy);
  const parametryWersja = skrot(stabilnyJson([p?.ryczalt, p?.zus, pz?.zdrowotna])).slice(0, 16);
  const pozycje = wynik.wynik.pozycje.map((poz) => ({
    ...poz,
    wejsciaHash: skrot(stabilnyJson({ miesiac, rodzaj: poz.rodzaj, kwotaGr: poz.kwotaGr, wejscia: poz.wejscia, parametryWersja })),
  }));

  return { ok: true, wynik: wynik.wynik, pozycje, parametryWersja, rozliczenia: tegoMiesiaca, wersje: ewidencja.wersje };
}

/** Najnowsza wersja każdego rodzaju (aktualne rozliczenie). */
export function aktualne(rozliczenia: readonly Rozliczenie[]): Map<RodzajRozliczenia, Rozliczenie> {
  const mapa = new Map<RodzajRozliczenia, Rozliczenie>();
  for (const r of rozliczenia) {
    const obecne = mapa.get(r.rodzaj);
    if (!obecne || r.wersja > obecne.wersja) mapa.set(r.rodzaj, r);
  }
  return new Map(RODZAJE_ROZLICZEN.filter((r) => mapa.has(r)).map((r) => [r, mapa.get(r) as Rozliczenie]));
}
