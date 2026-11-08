import { describe, expect, it } from 'vitest';

import { zbudujEwidencje, type Ewidencja, type FakturaEwidencji, type WierszEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { przyrostyZaplat, tenMiesiac, type Platnosc, type TenMiesiac, type WejscieMiesiaca } from '@/lib/ksiegowosc/ten-miesiac';

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

function wiersz(dzien: string, gr: number, stawkaPb = 1200): WierszEwidencji {
  return {
    lp: 0,
    dataWpisu: dzien,
    dataPrzychodu: dzien,
    dowod: `D/${dzien}/${gr}`,
    numerKsef: null,
    krajKontrahenta: null,
    idKontrahenta: null,
    kwotaGr: gr,
    stawkaPb,
    uwagi: null,
    zrodlo: { typ: 'wpis', id: `w-${dzien}-${gr}` },
  };
}

const ewidencjaZ = (wiersze: WierszEwidencji[]): Ewidencja => ({ rok: 2026, wiersze, braki: [], pominiete: [], ryczaltWRoku: true });

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

/** [rodzaj, kwota albo „brak”] każdej pozycji. */
function kwoty(w: TenMiesiac): [string, number | string][] {
  if (!w.ok) throw new Error(w.braki.join(' '));
  return w.wynik.pozycje.map((p) => [p.rodzaj, p.ok ? p.kwotaGr : 'brak']);
}

function brakPozycji(w: TenMiesiac, rodzaj: string): string {
  if (!w.ok) throw new Error(w.braki.join(' '));
  const p = w.wynik.pozycje.find((x) => x.rodzaj === rodzaj);
  if (!p || p.ok) throw new Error(`${rodzaj}: brak oczekiwany`);
  return p.brak;
}

describe('ten miesiąc przy ryczałcie', () => {
  it('luty: odliczenia ze składek za styczeń zapłaconych w lutym, kwoty i terminy do przelewów', () => {
    const w = tenMiesiac(
      wejscie({
        platnosci: [zaplata('2026-01', 'zus_spoleczne', 192_676, '2026-02-16', 178_829), zaplata('2026-01', 'zdrowotna', 49_835, '2026-02-16')],
      }),
    );
    if (!w.ok) throw new Error(w.braki.join(' '));
    // 15 000,00 - 1 788,29 - 249,18 = 12 962,53 → 12 963 zł × 12 % = 1 555,56 → 1 556 zł.
    expect(w.wynik.ryczalt?.odliczenia).toMatchObject({ spoleczneZaplaconeGr: 178_829, zdrowotna50ProcGr: 24_918, odliczonoGr: 203_747 });
    expect(w.wynik.pozycje.map((p) => [p.rodzaj, p.ok ? p.kwotaGr : null, p.termin?.faktyczny])).toEqual([
      ['ryczalt', 155_600, '2026-03-20'],
      ['zus_spoleczne', 192_676, '2026-03-20'],
      ['zdrowotna', 49_835, '2026-03-20'],
    ]);
    expect(w.wynik.przychodGr).toBe(1_500_000);
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
    expect(w.wynik.ryczalt?.odliczenia).toMatchObject({ nadwyzkaZPoprzednichGr: 78_829, odliczonoGr: 78_829, nadwyzkaNaKolejneGr: 0 });
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
    expect(w.ok && [w.wynik.zdrowotna?.prog, w.wynik.zdrowotna?.skladkaGr]).toEqual(['do 300 tys.', 83_058]);
  });

  it('braki całego miesiąca bez ustawień; skala bez KPiR (K7): brak zaliczki i zdrowotnej, składki się liczą', () => {
    expect(tenMiesiac(wejscie({ wersje: [{ ...PROFIL, validFrom: '2026-03-01' }] }))).toMatchObject({
      ok: false,
      braki: [expect.stringContaining('Na luty 2026 nie ma ustawień podatkowych')],
    });
    const skala = tenMiesiac(wejscie({ wersje: [{ ...PROFIL, forma: 'skala', stawkaDomyslna: null }] }));
    expect(kwoty(skala)).toEqual([['pit', 'brak'], ['zus_spoleczne', 192_676], ['zdrowotna', 'brak']]);
    expect(brakPozycji(skala, 'pit')).toContain('Nie udało się odczytać KPiR');
  });

  it('braki ewidencji wcześniej w roku zatrzymują ryczałt i zdrowotną, a składki społeczne się liczą', () => {
    const zBrakiem = zbudujEwidencje({ rok: 2026, faktury: [faktura('2026-01-10', 100)], wpisy: [], wersje: [{ ...PROFIL, validFrom: '2026-01-15' }], kursy: new Map() });
    const w = tenMiesiac(wejscie({ ewidencja: zBrakiem }));
    expect(kwoty(w)).toEqual([['ryczalt', 'brak'], ['zus_spoleczne', 192_676], ['zdrowotna', 'brak']]);
    expect(brakPozycji(w, 'ryczalt')).toContain('braki w miesiącach: styczeń 2026');
  });

  it('zmiana ustawień ZUS w trakcie miesiąca to brak samych składek społecznych', () => {
    const w = tenMiesiac(wejscie({ wersje: [PROFIL, { ...PROFIL, id: 'p2', validFrom: '2026-02-10', chorobowe: false }] }));
    // Bez zapłat nie ma odliczeń: 15 000 zł × 12 % = 1 800 zł.
    expect(kwoty(w)).toEqual([['ryczalt', 180_000], ['zus_spoleczne', 'brak'], ['zdrowotna', 49_835]]);
    expect(brakPozycji(w, 'zus_spoleczne')).toContain('w trakcie miesiąca');
  });

  it('po końcu ulgi bez nowego etapu w ustawieniach: brak składek z datą końca ulgi', () => {
    const w = tenMiesiac(wejscie({ miesiac: '2026-08', wersje: [{ ...PROFIL, zusEtap: 'ulga_na_start', zusOd: '2026-01-01' }] }));
    expect(brakPozycji(w, 'zus_spoleczne')).toContain('trwał do 30.06.2026');
  });

  it('wejścia do skrótu zmieniają się, gdy zmienia się przychód miesiąca, a nie przy zmianie bez wpływu na kwotę', () => {
    const a = tenMiesiac(wejscie());
    const b = tenMiesiac(wejscie({ faktury: [faktura('2026-01-31', 1_500_000), faktura('2026-02-28', 1_600_000)] }));
    if (!a.ok || !b.ok) throw new Error('brak');
    const [ra, za] = [a.wynik.pozycje[0], a.wynik.pozycje[1]];
    const [rb, zb] = [b.wynik.pozycje[0], b.wynik.pozycje[1]];
    if (!ra.ok || !rb.ok || !za.ok || !zb.ok) throw new Error('brak');
    expect(JSON.stringify(ra.wejscia)).not.toBe(JSON.stringify(rb.wejscia));
    expect(JSON.stringify(za.wejscia)).toBe(JSON.stringify(zb.wejscia));
  });
});

describe('pierwszy miesiąc firmy, która zaczęła w trakcie miesiąca', () => {
  const START = { ...PROFIL, validFrom: '2026-03-15' };
  const faktury = [faktura('2026-03-20', 1_000_000)];

  it('ulga na start od 15.03: marzec liczy ryczałt i zdrowotną, składki społeczne to zero', () => {
    const w = tenMiesiac(wejscie({ miesiac: '2026-03', faktury, wersje: [{ ...START, zusEtap: 'ulga_na_start', zusOd: '2026-03-15' }] }));
    // 10 000 zł × 12 % = 1 200 zł; zdrowotna „do 60 tys.” w pełnej kwocie (bez proporcji za niepełny miesiąc).
    expect(kwoty(w)).toEqual([['ryczalt', 120_000], ['zus_spoleczne', 0], ['zdrowotna', 49_835]]);
  });

  it('pełny ZUS od 15.03: składki za niepełny miesiąc to brak, ryczałt i zdrowotna się liczą', () => {
    const w = tenMiesiac(wejscie({ miesiac: '2026-03', faktury, wersje: [START] }));
    expect(kwoty(w)).toEqual([['ryczalt', 120_000], ['zus_spoleczne', 'brak'], ['zdrowotna', 49_835]]);
    expect(brakPozycji(w, 'zus_spoleczne')).toContain('15.03.2026');
  });
});

describe('brak jednej pozycji nie zabiera pozostałych', () => {
  it('ulga od 15.03 kończy się 14.09: wrzesień to brak składek społecznych, ryczałt i zdrowotna się liczą', () => {
    const w = tenMiesiac(
      wejscie({
        miesiac: '2026-09',
        faktury: [faktura('2026-09-10', 1_000_000)],
        wersje: [{ ...PROFIL, validFrom: '2026-03-15', zusEtap: 'ulga_na_start', zusOd: '2026-03-15' }],
      }),
    );
    expect(kwoty(w)).toEqual([['ryczalt', 120_000], ['zus_spoleczne', 'brak'], ['zdrowotna', 49_835]]);
    expect(brakPozycji(w, 'zus_spoleczne')).toContain('w trakcie miesiąca');
  });

  it('styczeń 2026: bez parametrów roku składkowego 2025/2026 brak samej zdrowotnej, z nazwą roku', () => {
    const w = tenMiesiac(wejscie({ miesiac: '2026-01' }));
    expect(kwoty(w)).toEqual([['ryczalt', 180_000], ['zus_spoleczne', 192_676], ['zdrowotna', 'brak']]);
    expect(brakPozycji(w, 'zdrowotna')).toContain('od lutego 2025 r. do stycznia 2026 r.');
  });
});

describe('korekta większa niż przychód ze stawką w miesiącu', () => {
  it('ujemny przychód 12 % w lipcu przechodzi na sierpień tej stawki, a lipiec ma ryczałt zero', () => {
    const ewidencja = ewidencjaZ([wiersz('2026-06-10', 1_000_000), wiersz('2026-07-10', -50_000), wiersz('2026-08-10', 1_000_000)]);
    const lipiec = tenMiesiac(wejscie({ miesiac: '2026-07', ewidencja }));
    expect(kwoty(lipiec)[0]).toEqual(['ryczalt', 0]);
    const sierpien = tenMiesiac(wejscie({ miesiac: '2026-08', ewidencja }));
    if (!sierpien.ok) throw new Error(sierpien.braki.join(' '));
    // 10 000 - 500 = 9 500 zł × 12 % = 1 140 zł.
    expect([...(sierpien.wynik.ryczalt?.przychodWgStawekGr ?? [])]).toEqual([[1200, 950_000]]);
    expect(kwoty(sierpien)[0]).toEqual(['ryczalt', 114_000]);
  });
});
