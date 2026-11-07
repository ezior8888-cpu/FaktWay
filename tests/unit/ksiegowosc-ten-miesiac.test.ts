import { describe, expect, it } from 'vitest';

import { zbudujEwidencje, type FakturaEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { przyrostyZaplat, tenMiesiac, type Platnosc, type WejscieMiesiaca } from '@/lib/ksiegowosc/ten-miesiac';

/**
 * „Ten miesiąc” (plan księgowości JDG, K4): składki, zdrowotna i ryczałt
 * razem, na parametrach 2026 z K1 podanych wprost. Kwoty policzone ręcznie
 * w komentarzach.
 */

const PROFIL: WersjaProfilu = {
  id: 'p1',
  validFrom: '2026-01-01',
  forma: 'ryczalt',
  stawkaDomyslna: 1200,
  zusEtap: 'pelny',
  zusOd: null,
  chorobowe: true,
  nrsZus: null,
  najem: false,
};

function faktura(dzien: string, gr: number): FakturaEwidencji {
  return {
    id: `f-${dzien}-${gr}`,
    numer: `FV/${dzien}`,
    dataWystawienia: dzien,
    dataSprzedazy: dzien,
    rodzaj: 'zwykla',
    nettoGr: gr,
    waluta: 'PLN',
    numerKsef: null,
    fp: false,
    kontrahent: { kraj: null, identyfikator: null },
    rozliczoneZaliczkiGr: 0,
    pozycje: null,
  };
}

function wejscie(z: Partial<WejscieMiesiaca> & { faktury?: FakturaEwidencji[]; wersje?: WersjaProfilu[] } = {}): WejscieMiesiaca {
  const wersje = z.wersje ?? [PROFIL];
  const ewidencja =
    z.ewidencja ??
    zbudujEwidencje({ rok: 2026, faktury: z.faktury ?? [faktura('2026-01-31', 1_500_000), faktura('2026-02-28', 1_500_000)], wpisy: [], wersje, kursy: new Map() });
  return { miesiac: '2026-02', ewidencja, wersje, platnosci: [], parametry: parametryRoku, ...z };
}

const zaplata = (miesiac: string, rodzaj: Platnosc['rodzaj'], kwotaGr: number, zaplaconeO: string, spoleczneBezFpGr = 0, wersja = 1): Platnosc => ({
  miesiac,
  rodzaj,
  wersja,
  kwotaGr,
  spoleczneBezFpGr,
  zaplaconeO,
});

describe('ten miesiąc przy ryczałcie', () => {
  it('luty: odliczenia ze składek za styczeń zapłaconych w lutym, kwoty i terminy do przelewów', () => {
    const w = tenMiesiac(
      wejscie({
        platnosci: [zaplata('2026-01', 'zus_spoleczne', 192_676, '2026-02-16', 178_829), zaplata('2026-01', 'zdrowotna', 49_835, '2026-02-16')],
      }),
    );
    if (!w.ok) throw new Error(w.braki.join(' '));
    // 15 000,00 - 1 788,29 - 249,18 = 12 962,53 → 12 963 zł × 12 % = 1 555,56 → 1 556 zł.
    expect(w.wynik.ryczalt.odliczenia).toMatchObject({ spoleczneZaplaconeGr: 178_829, zdrowotna50ProcGr: 24_918, odliczonoGr: 203_747 });
    expect(w.wynik.pozycje.map((p) => [p.rodzaj, p.kwotaGr, p.termin?.faktyczny])).toEqual([
      ['ryczalt', 155_600, '2026-03-20'],
      ['zus_spoleczne', 192_676, '2026-03-20'],
      ['zdrowotna', 49_835, '2026-03-20'],
    ]);
    // Próg zdrowotnej: 30 000,00 - 1 788,29 zapłaconych społecznych = 28 211,71 zł.
    expect(w.wynik.zdrowotna).toEqual({ przychodNarastajacoGr: 2_821_171, prog: 'do 60 tys.', skladkaGr: 49_835 });
  });

  it('nadwyżka odliczeń ze stycznia przechodzi na luty', () => {
    const w = tenMiesiac(
      wejscie({
        faktury: [faktura('2026-01-31', 100_000), faktura('2026-02-28', 1_500_000)],
        platnosci: [zaplata('2025-12', 'zus_spoleczne', 192_676, '2026-01-15', 178_829)],
      }),
    );
    if (!w.ok) throw new Error(w.braki.join(' '));
    expect(w.wynik.ryczalt.odliczenia).toMatchObject({ nadwyzkaZPoprzednichGr: 78_829, odliczonoGr: 78_829, nadwyzkaNaKolejneGr: 0 });
  });

  it('kolejna zapłacona wersja liczy się tylko dopłatą w miesiącu jej zapłaty', () => {
    const przyrosty = przyrostyZaplat([
      zaplata('2026-01', 'zdrowotna', 49_835, '2026-02-10', 0, 1),
      zaplata('2026-01', 'zdrowotna', 83_058, '2026-03-05', 0, 2),
    ]);
    expect(przyrosty.map((z) => [z.miesiacZaplaty, z.kwotaGr])).toEqual([['2026-02', 49_835], ['2026-03', 33_223]]);
  });

  it('próg zdrowotnej: wyższa składka od miesiąca przekroczenia 60 tys. zł', () => {
    const w = tenMiesiac(wejscie({ faktury: [faktura('2026-01-31', 4_000_000), faktura('2026-02-28', 3_000_000)] }));
    expect(w.ok && [w.wynik.zdrowotna.prog, w.wynik.zdrowotna.skladkaGr]).toEqual(['do 300 tys.', 83_058]);
  });

  it('braki: bez profilu, skala, braki ewidencji wcześniej w roku, zmiana ZUS w trakcie miesiąca, koniec ulgi', () => {
    expect(tenMiesiac(wejscie({ wersje: [{ ...PROFIL, validFrom: '2026-03-01' }] }))).toMatchObject({ ok: false, braki: [expect.stringContaining('nie ma ustawień podatkowych')] });
    expect(tenMiesiac(wejscie({ wersje: [{ ...PROFIL, forma: 'skala', stawkaDomyslna: null }] }))).toMatchObject({ ok: false, braki: [expect.stringContaining('kolejnej wersji modułu')] });
    const zBrakiem = zbudujEwidencje({ rok: 2026, faktury: [faktura('2026-01-10', 100)], wpisy: [], wersje: [{ ...PROFIL, validFrom: '2026-01-15' }], kursy: new Map() });
    expect(tenMiesiac(wejscie({ ewidencja: zBrakiem }))).toMatchObject({ ok: false, braki: [expect.stringContaining('braki w miesiącach: 2026-01')] });
    expect(tenMiesiac(wejscie({ wersje: [PROFIL, { ...PROFIL, id: 'p2', validFrom: '2026-02-10', chorobowe: false }] }))).toMatchObject({ ok: false, braki: [expect.stringContaining('w trakcie miesiąca')] });
    expect(tenMiesiac(wejscie({ miesiac: '2026-08', wersje: [{ ...PROFIL, zusEtap: 'ulga_na_start', zusOd: '2026-01-01' }] }))).toMatchObject({ ok: false, braki: [expect.stringContaining('trwał do 30.06.2026')] });
  });

  it('wejścia do migawki zmieniają się, gdy zmienia się przychód albo zapłata (nowa wersja po zatwierdzeniu)', () => {
    const a = tenMiesiac(wejscie());
    const b = tenMiesiac(wejscie({ faktury: [faktura('2026-01-31', 1_500_000), faktura('2026-02-28', 1_600_000)] }));
    if (!a.ok || !b.ok) throw new Error('brak');
    expect(JSON.stringify(a.wynik.pozycje[0].wejscia)).not.toBe(JSON.stringify(b.wynik.pozycje[0].wejscia));
    expect(JSON.stringify(a.wynik.pozycje[1].wejscia)).toBe(JSON.stringify(b.wynik.pozycje[1].wejscia));
  });
});

describe('rok składkowy zdrowotnej', () => {
  it('styczeń 2026 należy do roku składkowego 2025/2026: bez jego parametrów to brak, z nazwą roku', () => {
    expect(tenMiesiac(wejscie({ miesiac: '2026-01' }))).toMatchObject({
      ok: false,
      braki: [expect.stringContaining('od lutego 2025 r. do stycznia 2026 r.')],
    });
  });
});
