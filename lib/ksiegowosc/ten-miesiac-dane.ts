/**
 * Odczyt „Ten miesiąc” (plan księgowości JDG, K4): parametry sprawdzone przez
 * księgową (D7), ewidencja roku (K3), zatwierdzone rozliczenia i zapłaty
 * (`tax_settlements`, 00168), potem `tenMiesiac`. Każde policzone rozliczenie
 * dostaje skrót kwoty i jej bezpośrednich wejść: zatwierdzenie zapisuje go,
 * a inny skrót po zmianie danych oznacza nową wersję (D6).
 */

import { createHash } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import { monthRange } from '@/lib/expenses/month';
import { czytajEwidencje } from '@/lib/ksiegowosc/ewidencja-dane';
import { czytajKpir } from '@/lib/ksiegowosc/kpir-dane';
import { czytajWersjeProfilu, type WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { brakujace, parametryRoku, rokSkladkowyZdrowotnej, type Liczba, type NazwaSekcji } from '@/lib/ksiegowosc/parametry';
import {
  tenMiesiac,
  wersjaMiesiaca,
  type BrakPozycji,
  type Platnosc,
  type PozycjaDoZaplaty,
  type PozycjaMiesiaca,
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

export type PozycjaPoliczona = { ok: true; wejsciaHash: string } & PozycjaDoZaplaty;
export type PozycjaZeSkrotem = PozycjaPoliczona | ({ ok: false } & BrakPozycji);

export type DaneMiesiaca =
  | {
      ok: true;
      wynik: WynikMiesiaca;
      pozycje: PozycjaZeSkrotem[];
      /** Skrót wartości parametrów (bez opisów), do audytu i kolumny `parametry_wersja`. */
      parametryWersja: string;
      /** Wszystkie wersje rozliczeń tego miesiąca, rosnąco. */
      rozliczenia: Rozliczenie[];
    }
  | { ok: false; braki: string[]; rozliczenia: Rozliczenie[] };

export const KOLUMNY_ROZLICZENIA =
  'id, okres, rodzaj, wersja, kwota_gr, termin, status, wejscia_hash, zatwierdzone_o, zaplacone_o, spoleczne_bez_fp:migawka->spoleczneBezFpGr';

interface WierszRozliczenia {
  id: string;
  okres: string;
  rodzaj: RodzajRozliczenia;
  wersja: number;
  kwota_gr: number | string;
  termin: string;
  status: 'zatwierdzone' | 'zaplacone';
  wejscia_hash: string;
  zatwierdzone_o: string;
  zaplacone_o: string | null;
  spoleczne_bez_fp: number | string | null;
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
    spoleczneBezFpGr: Number(w.spoleczne_bez_fp ?? 0),
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

/**
 * Skrót rozliczenia (D6): kwota i jej bezpośrednie wejścia. Parametry roku nie
 * wchodzą wprost: zmiana liczby, która zmienia kwotę, zmienia skrót przez
 * kwotę, a poprawka opisu albo liczby, której pozycja nie używa, nie tworzy
 * nowej wersji.
 */
export function skrotPozycji(miesiac: string, p: Pick<PozycjaDoZaplaty, 'rodzaj' | 'kwotaGr' | 'wejscia'>): string {
  return skrot(stabilnyJson({ miesiac, rodzaj: p.rodzaj, kwotaGr: p.kwotaGr, wejscia: p.wejscia }));
}

const wartosci = (sekcja?: { liczby: Readonly<Record<string, Liczba>> }) =>
  sekcja ? Object.fromEntries(Object.entries(sekcja.liczby).map(([klucz, l]) => [klucz, l.wartosc])) : null;

function czyBrakTabeli(kod: string | undefined): boolean {
  // Przed wgraniem 00168: Postgres 42P01, PostgREST PGRST205.
  return kod === '42P01' || kod === 'PGRST205';
}

/**
 * Wersje rozliczeń miesiąca i wszystkie zapłacone wersje do tego miesiąca:
 * odliczenia liczą się po dniu zapłaty, więc liczy się też zaległa zapłata
 * za wcześniejszy okres (np. składki za listopad zapłacone w styczniu).
 */
export async function czytajRozliczenia(client: SupabaseClient, tenantId: string, miesiac: string): Promise<Rozliczenie[]> {
  const okres = `${miesiac}-01`;
  const wiersze = await readCompletePages<WierszRozliczenia>('ten miesiąc: rozliczenia', async (from, to) => {
    const wynik = await client
      .from('tax_settlements')
      .select(KOLUMNY_ROZLICZENIA, { count: 'exact' })
      .eq('tenant_id', tenantId)
      .lte('okres', okres)
      .or(`okres.eq.${okres},status.eq.zaplacone`)
      .order('id', { ascending: true })
      .range(from, to);
    if (wynik.error && czyBrakTabeli(wynik.error.code)) return { data: [], count: 0, error: null };
    return { data: wynik.data as WierszRozliczenia[] | null, count: wynik.count, error: wynik.error };
  });
  return wiersze.map(zWierszaRozliczenia).sort((a, b) => a.miesiac.localeCompare(b.miesiac) || a.rodzaj.localeCompare(b.rodzaj) || a.wersja - b.wersja);
}

/** Rozliczeń nie udało się odczytać: wołający nie może uznać, że nic nie jest zapłacone. */
export const BLAD_ODCZYTU_ROZLICZEN = 'Nie udało się odczytać rozliczeń, więc nie pokazujemy kwot. Strona spróbuje ponownie przy następnym otwarciu.';

export async function czytajTenMiesiac(client: SupabaseClient, tenantId: string, miesiac: string): Promise<DaneMiesiaca> {
  const rok = Number(miesiac.slice(0, 4));
  const rokSkladkowy = rokSkladkowyZdrowotnej(miesiac);

  const [odczyt, wersjeOdczyt] = await Promise.all([
    czytajRozliczenia(client, tenantId, miesiac).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
    czytajWersjeProfilu(client, tenantId).then(
      (w) => ({ ok: true as const, w }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
  ]);
  if (!odczyt.ok) {
    console.error('[ten-miesiac] rozliczenia', odczyt.e instanceof Error ? odczyt.e.message : odczyt.e);
    return { ok: false, braki: [BLAD_ODCZYTU_ROZLICZEN], rozliczenia: [] };
  }
  const tegoMiesiaca = odczyt.r.filter((r) => r.miesiac === miesiac);
  if (!wersjeOdczyt.ok) {
    console.error('[ten-miesiac] profil', wersjeOdczyt.e instanceof Error ? wersjeOdczyt.e.message : wersjeOdczyt.e);
    return { ok: false, braki: [BLAD_ODCZYTU_ROZLICZEN], rozliczenia: tegoMiesiaca };
  }
  const forma = wersjaMiesiaca(wersjeOdczyt.w, miesiac)?.forma ?? 'ryczalt';

  // D7: bez sekcji potwierdzonej przez księgową nie ma kwoty tej pozycji. Liczbę
  // bez wartości (np. stopa wypadkowa ogłaszana w kwietniu) sprawdza silnik,
  // który jej używa, więc nie zabiera ona miesięcy, które jej nie potrzebują.
  // Podatek to ryczałt albo zaliczka PIT (skala, liniowy) według formy.
  const sekcje: [RodzajRozliczenia, number, NazwaSekcji][] = [
    forma === 'ryczalt' ? ['ryczalt', rok, 'ryczalt'] : ['pit', rok, forma],
    ['zus_spoleczne', rok, 'zus'],
    ['zdrowotna', rokSkladkowy, 'zdrowotna'],
  ];
  const d7 = new Map<RodzajRozliczenia, string>();
  for (const [rodzaj, r, sekcja] of sekcje) {
    const brak = brakujace(r, [sekcja]).find((b) => b.powod !== 'brak_liczby');
    if (brak) d7.set(rodzaj, brak.komunikat);
  }
  if (d7.size === sekcje.length) return { ok: false, braki: [...new Set(d7.values())], rozliczenia: tegoMiesiaca };

  const ksiegi = await czytajKsiegi(client, tenantId, miesiac, forma);
  if (!ksiegi.ok) return { ok: false, braki: [ksiegi.komunikat], rozliczenia: tegoMiesiaca };

  const platnosci: Platnosc[] = odczyt.r
    .filter((r) => r.status === 'zaplacone' && r.zaplaconeO)
    .map((r) => ({
      miesiac: r.miesiac,
      rodzaj: r.rodzaj,
      wersja: r.wersja,
      kwotaGr: r.kwotaGr,
      spoleczneBezFpGr: r.spoleczneBezFpGr,
      zaplaconeO: r.zaplaconeO as string,
    }));

  const wynik = tenMiesiac({ miesiac, ...ksiegi.wejscie, wersje: wersjeOdczyt.w, platnosci, parametry: parametryRoku });
  if (!wynik.ok) return { ok: false, braki: wynik.braki, rozliczenia: tegoMiesiaca };

  const maskowane: PozycjaMiesiaca[] = wynik.wynik.pozycje.map((poz) => {
    const brak = d7.get(poz.rodzaj);
    return brak ? { ok: false, rodzaj: poz.rodzaj, termin: poz.termin, brak } : poz;
  });
  const pozycje: PozycjaZeSkrotem[] = maskowane.map((poz) => (poz.ok ? { ...poz, wejsciaHash: skrotPozycji(miesiac, poz) } : poz));
  // Kwoty z sekcji niepotwierdzonej nie idą dalej, także do opisu odliczeń.
  const w = wynik.wynik;
  const bezD7: WynikMiesiaca = {
    ...w,
    ryczalt: d7.has('ryczalt') ? null : w.ryczalt,
    pit: d7.has('pit') ? null : w.pit,
    skladki: d7.has('zus_spoleczne') ? null : w.skladki,
    zdrowotna: d7.has('zdrowotna') ? null : w.zdrowotna,
    zdrowotnaOdDochodu: d7.has('zdrowotna') ? null : w.zdrowotnaOdDochodu,
    pozycje: maskowane,
  };

  const p = parametryRoku(rok);
  const pz = parametryRoku(rokSkladkowy);
  const podatek = forma === 'ryczalt' ? { ryczalt: wartosci(p?.ryczalt) } : { [forma]: wartosci(p?.[forma]) };
  const parametryWersja = skrot(stabilnyJson({ ...podatek, zus: wartosci(p?.zus), zdrowotna: wartosci(pz?.zdrowotna) })).slice(0, 16);

  return { ok: true, wynik: bezD7, pozycje, parametryWersja, rozliczenia: tegoMiesiaca };
}

/**
 * Księga miesiąca według formy: ewidencja przychodów przy ryczałcie (K3), KPiR
 * przy skali i liniowym (K7); za styczeń także KPiR roku poprzedniego, bo
 * składka zdrowotna liczy się od dochodu z grudnia.
 */
async function czytajKsiegi(
  client: SupabaseClient,
  tenantId: string,
  miesiac: string,
  forma: WersjaProfilu['forma'],
): Promise<{ ok: true; wejscie: Pick<Parameters<typeof tenMiesiac>[0], 'ewidencja' | 'kpir'> } | { ok: false; komunikat: string }> {
  const rok = Number(miesiac.slice(0, 4));
  if (forma === 'ryczalt') {
    const e = await czytajEwidencje(client, tenantId, rok);
    return e.ok ? { ok: true, wejscie: { ewidencja: e.ewidencja } } : e;
  }
  const [biezacy, poprzedni] = await Promise.all([
    czytajKpir(client, tenantId, rok),
    miesiac.endsWith('-01') ? czytajKpir(client, tenantId, rok - 1) : null,
  ]);
  if (!biezacy.ok) return biezacy;
  return { ok: true, wejscie: { kpir: { rok: biezacy.kpir, poprzedni: poprzedni?.ok ? poprzedni.kpir : null } } };
}

/** Najnowsza wersja każdego rodzaju (aktualne rozliczenie). */
export function aktualne(rozliczenia: readonly Rozliczenie[]): Map<RodzajRozliczenia, Rozliczenie> {
  const mapa = new Map<RodzajRozliczenia, Rozliczenie>();
  for (const r of rozliczenia) {
    const obecne = mapa.get(r.rodzaj);
    if (!obecne || r.wersja > obecne.wersja) mapa.set(r.rodzaj, r);
  }
  return mapa;
}

export const PO_KONCU_MIESIACA = 'Miesiąc zatwierdza się po jego zakończeniu, gdy są już wszystkie przychody.';

/** Czy miesiąc już się skończył (zatwierdza się dopiero wtedy). */
export const miesiacZakonczony = (miesiac: string, dzis: string) => monthRange(miesiac).to < dzis;

/** Rozliczenia do zatwierdzenia: policzone pozycje ze skrótem innym niż ostatnia wersja. */
export function doZatwierdzenia(dane: Extract<DaneMiesiaca, { ok: true }>): PozycjaPoliczona[] {
  const ostatnie = aktualne(dane.rozliczenia);
  return dane.pozycje.filter((p): p is PozycjaPoliczona => p.ok && ostatnie.get(p.rodzaj)?.wejsciaHash !== p.wejsciaHash);
}

/**
 * Ile z rozliczenia jest już zapłacone: najwyższa zapłacona wersja, tak jak
 * liczy dopłaty `przyrostyZaplat`; do dopłaty zostaje kwota ponad nią.
 */
export function zaplacono(rozliczenia: readonly Rozliczenie[], rodzaj: RodzajRozliczenia): number {
  return rozliczenia.filter((r) => r.rodzaj === rodzaj && r.status === 'zaplacone').reduce((m, r) => Math.max(m, r.kwotaGr), 0);
}
