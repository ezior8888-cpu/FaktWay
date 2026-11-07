import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Ewidencja, WierszEwidencji } from '@/lib/ksiegowosc/ewidencja';
import type { Brak } from '@/lib/ksiegowosc/parametry';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * Odczyt „Ten miesiąc” (plan księgowości JDG, K4): które rozliczenia czyta
 * baza, bramka D7 dla każdej pozycji osobno i skrót wersji (D6). Atrapy dla
 * bazy i ewidencji, silnik i parametry 2026/2027 są prawdziwe.
 */

const mocks = vi.hoisted(() => ({
  brakujace: null as null | ((rok: number, sekcje: readonly string[]) => Brak[]),
  zmienOpisy: false,
  wiersze: [] as Record<string, unknown>[],
  filtry: [] as string[],
  ewidencja: null as unknown,
}));

vi.mock('@/lib/ksiegowosc/parametry', async (orig) => {
  const prawdziwe = await orig<typeof import('@/lib/ksiegowosc/parametry')>();
  return {
    ...prawdziwe,
    brakujace: (rok: number, sekcje: readonly import('@/lib/ksiegowosc/parametry').NazwaSekcji[]) =>
      mocks.brakujace ? mocks.brakujace(rok, sekcje) : [],
    parametryRoku: (rok: number) => {
      const p = prawdziwe.parametryRoku(rok);
      if (!p || !mocks.zmienOpisy) return p;
      const kopia = structuredClone(p);
      kopia.ryczalt.liczby.stawka12.uwagi = 'inny opis';
      kopia.zus.sprawdzila = { kto: 'ktoś inny', data: '2027-01-01' };
      return kopia;
    },
  };
});
vi.mock('@/lib/ksiegowosc/ewidencja-dane', () => ({ czytajEwidencje: async () => mocks.ewidencja }));
// Od K7 odczyt bierze wersje profilu osobno (forma decyduje: ewidencja czy KPiR); te same co w atrapie ewidencji.
vi.mock('@/lib/ksiegowosc/profil', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/profil')>()),
  czytajWersjeProfilu: async () => (mocks.ewidencja as { wersje?: unknown[] } | null)?.wersje ?? [],
}));

const { czytajRozliczenia, czytajTenMiesiac } = await import('@/lib/ksiegowosc/ten-miesiac-dane');

// Preferencyjny ZUS: jego liczby na 2027 r. są znane (pełny czeka na prognozowane przeciętne wynagrodzenie).
const PROFIL: WersjaProfilu = {
  id: 'p1',
  validFrom: '2026-01-01',
  forma: 'ryczalt',
  stawkaDomyslna: 1200,
  zusEtap: 'preferencyjny',
  zusOd: '2026-01-01',
  chorobowe: true,
  nrsZus: null,
  najem: false,
};

function wiersz(dzien: string, gr: number): WierszEwidencji {
  return {
    lp: 0,
    dataWpisu: dzien,
    dataPrzychodu: dzien,
    dowod: `D/${dzien}`,
    numerKsef: null,
    krajKontrahenta: null,
    idKontrahenta: null,
    kwotaGr: gr,
    stawkaPb: 1200,
    uwagi: null,
    zrodlo: { typ: 'wpis', id: `w-${dzien}` },
  };
}

const ewidencja = (rok: number, wiersze: WierszEwidencji[]): Ewidencja => ({ rok, wiersze, braki: [], pominiete: [], ryczaltWRoku: true });

const rozliczenie = (okres: string, rodzaj: string, kwota: number, zaplaconeO: string | null, bezFp = 0, wersja = 1) => ({
  id: `00168168-0000-4000-8000-${okres.replace(/-/g, '')}${String(wersja).padStart(2, '0')}${rodzaj.length}`,
  okres,
  rodzaj,
  wersja,
  kwota_gr: kwota,
  termin: '2027-01-20',
  status: zaplaconeO ? 'zaplacone' : 'zatwierdzone',
  wejscia_hash: 'a'.repeat(64),
  zatwierdzone_o: '2026-12-01T10:00:00Z',
  zaplacone_o: zaplaconeO,
  spoleczne_bez_fp: bezFp,
});

const client = {
  from: (tabela: string) => {
    if (tabela !== 'tax_settlements') throw new Error(tabela);
    const l: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'lte', 'gte', 'or', 'order']) {
      l[m] = (...a: unknown[]) => {
        mocks.filtry.push(`${m}:${a.filter((x) => typeof x === 'string').join(',')}`);
        return l;
      };
    }
    l.range = async () => {
      const posortowane = [...mocks.wiersze].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return { data: posortowane, count: posortowane.length, error: null };
    };
    return l;
  },
} as unknown as import('@supabase/supabase-js').SupabaseClient;

beforeEach(() => {
  mocks.brakujace = null;
  mocks.zmienOpisy = false;
  mocks.wiersze = [];
  mocks.filtry = [];
  mocks.ewidencja = { ok: true, ewidencja: ewidencja(2027, [wiersz('2027-01-20', 1_500_000)]), wersje: [PROFIL], wpisy: [] };
});

describe('odczyt rozliczeń', () => {
  it('czyta wersje miesiąca i wszystkie zapłacone wersje do tego miesiąca, nie tylko od grudnia', async () => {
    await czytajRozliczenia(client, 't1', '2027-01');
    expect(mocks.filtry).toContain('lte:okres,2027-01-01');
    expect(mocks.filtry).toContain('or:okres.eq.2027-01-01,status.eq.zaplacone');
    expect(mocks.filtry.some((f) => f.startsWith('gte:okres'))).toBe(false);
  });

  it('zaległe składki za listopad zapłacone w styczniu pomniejszają ryczałt za styczeń', async () => {
    mocks.wiersze = [rozliczenie('2026-11-01', 'zus_spoleczne', 192_676, '2027-01-08', 178_829)];
    const dane = await czytajTenMiesiac(client, 't1', '2027-01');
    if (!dane.ok) throw new Error(dane.braki.join(' '));
    expect(dane.wynik.ryczalt?.odliczenia.spoleczneZaplaconeGr).toBe(178_829);
    // Historia pokazuje tylko wersje stycznia.
    expect(dane.rozliczenia).toEqual([]);
  });
});

describe('bramka D7 dla każdej pozycji', () => {
  it('liczba bez wartości w sekcji (stopa wypadkowa od kwietnia 2027) nie zabiera stycznia', async () => {
    const dane = await czytajTenMiesiac(client, 't1', '2027-01');
    if (!dane.ok) throw new Error(dane.braki.join(' '));
    expect(dane.pozycje.map((p) => [p.rodzaj, p.ok])).toEqual([
      ['ryczalt', true],
      ['zus_spoleczne', true],
      ['zdrowotna', true],
    ]);
  });

  it('niesprawdzona sekcja zdrowotnej daje brak samej zdrowotnej, z komunikatem dla klienta', async () => {
    mocks.brakujace = (rok, sekcje) =>
      sekcje.includes('zdrowotna') ? [{ sekcja: 'zdrowotna', powod: 'niesprawdzone', komunikat: `Stawki na ${rok} r. czekają na sprawdzenie.`, operator: '' }] : [];
    const dane = await czytajTenMiesiac(client, 't1', '2027-01');
    if (!dane.ok) throw new Error(dane.braki.join(' '));
    const zdrowotna = dane.pozycje.find((p) => p.rodzaj === 'zdrowotna');
    expect(zdrowotna).toMatchObject({ ok: false, brak: 'Stawki na 2026 r. czekają na sprawdzenie.' });
    expect(dane.wynik.zdrowotna).toBeNull();
    expect(dane.pozycje.filter((p) => p.ok).map((p) => p.rodzaj)).toEqual(['ryczalt', 'zus_spoleczne']);
  });

  it('wszystkie sekcje niesprawdzone: braki zamiast kwot i bez czytania ewidencji', async () => {
    mocks.brakujace = (_rok, sekcje) => sekcje.map((s) => ({ sekcja: s as 'zus', powod: 'niesprawdzone' as const, komunikat: `czeka: ${s}`, operator: '' }));
    mocks.ewidencja = null;
    expect(await czytajTenMiesiac(client, 't1', '2027-01')).toMatchObject({ ok: false, braki: ['czeka: ryczalt', 'czeka: zus', 'czeka: zdrowotna'] });
  });
});

describe('skrót wersji (D6)', () => {
  it('poprawka opisu albo potwierdzenia w parametrach nie zmienia skrótu żadnego rozliczenia', async () => {
    const przed = await czytajTenMiesiac(client, 't1', '2027-01');
    mocks.zmienOpisy = true;
    const po = await czytajTenMiesiac(client, 't1', '2027-01');
    if (!przed.ok || !po.ok) throw new Error('brak');
    const skroty = (d: typeof przed) => d.pozycje.map((p) => (p.ok ? p.wejsciaHash : null));
    expect(skroty(po)).toEqual(skroty(przed));
    expect(skroty(przed).every((s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s))).toBe(true);
  });
});
