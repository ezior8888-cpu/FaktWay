import { describe, expect, it } from 'vitest';

import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { doPelnychZlotych, ryczaltMiesiaca, type WejscieRyczaltu } from '@/lib/ksiegowosc/ryczalt';
import { zdrowotnaRyczaltu } from '@/lib/ksiegowosc/zdrowotna';
import { dodajMiesiace, skladkiSpoleczne, type LiczbyZus } from '@/lib/ksiegowosc/zus';

/**
 * Silniki K4 (plan księgowości JDG): składki społeczne, zdrowotna przy
 * ryczałcie i ryczałt za miesiąc. Parametry 2026 z K1 podane wprost (silniki
 * są czyste; produkcja liczy dopiero po `brakujace()`). Kwoty ZUS odtwarzają
 * tabele ZUS na 2026 r. co do grosza.
 */

const P26 = parametryRoku(2026)!;
const ZUS = P26.zus.liczby;

function profil(z: Partial<WersjaProfilu> = {}): WersjaProfilu {
  return {
    id: 'p1',
    validFrom: '2026-01-01',
    forma: 'ryczalt',
    stawkaDomyslna: 1200,
    zusEtap: 'pelny',
    zusOd: null,
    chorobowe: true,
    nrsZus: null,
    najem: false,
    ...z,
  };
}

describe('składki społeczne', () => {
  it('pełne z chorobową: 1926,76 zł jak tabela ZUS na 2026 r., FP osobno', () => {
    const w = skladkiSpoleczne('2026-03', profil(), ZUS);
    expect(w).toEqual({
      ok: true,
      skladki: {
        podstawaGr: 565200,
        emerytalnaGr: 110327,
        rentoweGr: 45216,
        chorobowaGr: 13847,
        wypadkowaGr: 9439,
        razemGr: 178829,
        funduszPracyGr: 13847,
      },
    });
  });

  it('preferencyjne z chorobową: 456,18 zł, bez FP; bez chorobowej mniej o chorobową', () => {
    const z = skladkiSpoleczne('2026-05', profil({ zusEtap: 'preferencyjny', zusOd: '2026-01-01' }), ZUS);
    expect(z.ok && [z.skladki.podstawaGr, z.skladki.razemGr, z.skladki.funduszPracyGr]).toEqual([144180, 45618, 0]);
    const bez = skladkiSpoleczne('2026-05', profil({ zusEtap: 'preferencyjny', zusOd: '2026-01-01', chorobowe: false }), ZUS);
    expect(bez.ok && bez.skladki.razemGr).toBe(45618 - 3532);
  });

  it('ulga na start: zero przez 6 miesięcy, także w miesiącu startu w trakcie miesiąca', () => {
    const ulga = profil({ zusEtap: 'ulga_na_start', zusOd: '2026-03-15' });
    for (const m of ['2026-03', '2026-04', '2026-08']) expect(skladkiSpoleczne(m, ulga, ZUS)).toMatchObject({ ok: true, skladki: { razemGr: 0, funduszPracyGr: 0 } });
    expect(skladkiSpoleczne('2026-09', ulga, ZUS)).toMatchObject({ ok: false, brak: expect.stringContaining('proporcjonalnej do dni') });
  });

  it('koniec etapu: po ulgi i po 24 miesiącach preferencyjnych brak z drogą do ustawień', () => {
    expect(skladkiSpoleczne('2026-07', profil({ zusEtap: 'ulga_na_start', zusOd: '2026-01-01' }), ZUS)).toMatchObject({
      ok: false,
      brak: expect.stringMatching(/trwał do 30\.06\.2026.*„Ustawienia podatkowe”/),
    });
    expect(skladkiSpoleczne('2028-01', profil({ zusEtap: 'preferencyjny', zusOd: '2026-01-01' }), ZUS)).toMatchObject({ ok: false });
  });

  it('etat obok: bez składek społecznych; pełne od połowy miesiąca: brak (podstawa proporcjonalna)', () => {
    expect(skladkiSpoleczne('2026-03', profil({ zusEtap: 'etat_obok' }), ZUS)).toMatchObject({ ok: true, skladki: { razemGr: 0 } });
    expect(skladkiSpoleczne('2026-03', profil({ zusOd: '2026-03-10' }), ZUS)).toMatchObject({ ok: false });
    expect(skladkiSpoleczne('2026-04', profil({ zusOd: '2026-03-10' }), ZUS)).toMatchObject({ ok: true });
  });

  it('stopa wypadkowa zmienia się od kwietnia', () => {
    const liczby: LiczbyZus = { ...ZUS, stopaWypadkowaOdKwietnia: { ...ZUS.stopaWypadkowaOdKwietnia, wartosc: 200 } };
    const marzec = skladkiSpoleczne('2026-03', profil(), liczby);
    const kwiecien = skladkiSpoleczne('2026-04', profil(), liczby);
    expect([marzec.ok && marzec.skladki.wypadkowaGr, kwiecien.ok && kwiecien.skladki.wypadkowaGr]).toEqual([9439, 11304]);
  });

  it('miesiące etapów liczą się od dnia startu', () => {
    expect(dodajMiesiace('2026-01-31', 1)).toBe('2026-02-28');
    expect(dodajMiesiace('2026-03-15', 6)).toBe('2026-09-15');
  });
});

describe('składka zdrowotna przy ryczałcie (rok składkowy 2026/2027)', () => {
  const ZDR = P26.zdrowotna.liczby;
  it('progi 60 i 300 tys. zł włącznie, kwoty jak w 2026 r.', () => {
    const kwota = (gr: number) => {
      const w = zdrowotnaRyczaltu(gr, ZDR);
      return w.ok ? [w.zdrowotna.prog, w.zdrowotna.skladkaGr] : w.brak;
    };
    expect(kwota(6_000_000)).toEqual(['do 60 tys.', 49835]);
    expect(kwota(6_000_001)).toEqual(['do 300 tys.', 83058]);
    expect(kwota(30_000_000)).toEqual(['do 300 tys.', 83058]);
    expect(kwota(30_000_001)).toEqual(['ponad 300 tys.', 149504]);
  });

  it('rok składkowy bez ogłoszonych kwot: brak, nie zgadywanie', () => {
    expect(zdrowotnaRyczaltu(100, parametryRoku(2027)!.zdrowotna.liczby)).toMatchObject({ ok: false, brak: expect.stringContaining('nie są jeszcze ogłoszone') });
  });
});

describe('ryczałt za miesiąc', () => {
  const RYC = P26.ryczalt.liczby;
  const wejscie = (z: Partial<WejscieRyczaltu> = {}): WejscieRyczaltu => ({
    przychodWgStawekGr: new Map([[1200, 1_500_000]]),
    spoleczneZaplaconeGr: 0,
    zdrowotnaZaplaconaGr: 0,
    nadwyzkaZPoprzednichGr: 0,
    ...z,
  });

  it('jedna stawka bez odliczeń: 15 000 zł × 12 % = 1800 zł', () => {
    const w = ryczaltMiesiaca(wejscie(), RYC);
    expect(w.ok && w.ryczalt.ryczaltGr).toBe(180_000);
  });

  it('odliczenia: społeczne bez FP i połowa zdrowotnej; podstawa i ryczałt w pełnych złotych', () => {
    const w = ryczaltMiesiaca(wejscie({ spoleczneZaplaconeGr: 178_829, zdrowotnaZaplaconaGr: 83_058 }), RYC);
    if (!w.ok) throw new Error(w.brak);
    expect(w.ryczalt.odliczenia).toEqual({
      spoleczneZaplaconeGr: 178_829,
      zdrowotna50ProcGr: 41_529,
      nadwyzkaZPoprzednichGr: 0,
      odliczonoGr: 220_358,
      nadwyzkaNaKolejneGr: 0,
    });
    // 15 000,00 - 2 203,58 = 12 796,42 → 12 796 zł; × 12 % = 1 535,52 → 1 536 zł.
    expect([w.ryczalt.podstawaWgStawekGr.get(1200), w.ryczalt.ryczaltGr]).toEqual([1_279_600, 153_600]);
  });

  it('odliczenia większe niż przychód przechodzą na kolejny miesiąc', () => {
    const w = ryczaltMiesiaca(wejscie({ przychodWgStawekGr: new Map([[1200, 100_000]]), spoleczneZaplaconeGr: 150_000, nadwyzkaZPoprzednichGr: 50_000 }), RYC);
    expect(w.ok && [w.ryczalt.odliczenia.odliczonoGr, w.ryczalt.odliczenia.nadwyzkaNaKolejneGr, w.ryczalt.ryczaltGr]).toEqual([100_000, 100_000, 0]);
  });

  it('dwie stawki: odliczenia proporcjonalnie do przychodu, ryczałt z połówką w górę', () => {
    const w = ryczaltMiesiaca(wejscie({ przychodWgStawekGr: new Map([[1200, 1_000_000], [850, 500_000]]), spoleczneZaplaconeGr: 150_000 }), RYC);
    if (!w.ok) throw new Error(w.brak);
    expect([...w.ryczalt.podstawaWgStawekGr]).toEqual([[1200, 900_000], [850, 450_000]]);
    // 9 000 × 12 % + 4 500 × 8,5 % = 1 080 + 382,50 = 1 462,50 → 1 463 zł.
    expect(w.ryczalt.ryczaltGr).toBe(146_300);
  });

  it('podstawa do pełnych złotych, 50 gr w górę', () => {
    expect(doPelnychZlotych(1_279_650)).toBe(1_279_700);
    expect(doPelnychZlotych(1_279_649)).toBe(1_279_600);
  });

  it('12,5 % po progu najmu liczy się ze swojego klucza; stawka spoza parametrów to brak', () => {
    const najem = ryczaltMiesiaca(wejscie({ przychodWgStawekGr: new Map([[1250, 1_000_000]]) }), RYC);
    expect(najem.ok && najem.ryczalt.ryczaltGr).toBe(125_000);
    expect(ryczaltMiesiaca(wejscie({ przychodWgStawekGr: new Map([[2300, 1]]) }), RYC)).toMatchObject({ ok: false, brak: expect.stringContaining('23 %') });
  });

  it('ujemny przychód stawki przechodzi na kolejny miesiąc i zmniejsza tam przychód tej samej stawki', () => {
    const lipiec = ryczaltMiesiaca(wejscie({ przychodWgStawekGr: new Map([[1200, -50_000], [850, 1_000_000]]) }), RYC);
    if (!lipiec.ok) throw new Error(lipiec.brak);
    // 12 % ma ryczałt zero, 8,5 % liczy się normalnie: 10 000 zł × 8,5 % = 850 zł.
    expect(lipiec.ryczalt.ryczaltGr).toBe(85_000);
    expect([...lipiec.ryczalt.ujemneNaKolejneGr]).toEqual([[1200, -50_000]]);
    const sierpien = ryczaltMiesiaca(
      wejscie({ przychodWgStawekGr: new Map([[1200, 1_000_000]]), ujemneZPoprzednichGr: lipiec.ryczalt.ujemneNaKolejneGr }),
      RYC,
    );
    // (10 000 - 500) zł × 12 % = 1 140 zł.
    expect(sierpien.ok && [sierpien.ryczalt.ryczaltGr, sierpien.ryczalt.ujemneNaKolejneGr.size]).toEqual([114_000, 0]);
  });
});
