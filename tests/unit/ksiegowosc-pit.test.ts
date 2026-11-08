import { describe, expect, it } from 'vitest';

import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import { doZlotych, zaliczkiPit, type MiesiacPit } from '@/lib/ksiegowosc/pit';
import { zdrowotnaOdDochodu } from '@/lib/ksiegowosc/zdrowotna';

/**
 * Zaliczki PIT (skala, liniowy) i składka zdrowotna od dochodu (plan
 * księgowości JDG, K7) na parametrach 2026, policzone ręcznie. Złote
 * przypadki G8-G11 sprawdzą to samo po podpisie księgowej.
 */

const p = parametryRoku(2026)!;
const liczby = { skala: p.skala.liczby, liniowy: p.liniowy.liczby };
const zl = (n: number) => Math.round(n * 100);

function rok(n: number, m: Partial<MiesiacPit> = {}): MiesiacPit[] {
  return Array.from({ length: n }, (_, i) => ({
    miesiac: `2026-${String(i + 1).padStart(2, '0')}`,
    przychodGr: zl(10_000),
    kosztyGr: zl(2_000),
    spoleczneZaplaconeGr: zl(1_000),
    zdrowotnaZaplaconaGr: zl(700),
    ...m,
  }));
}

describe('zaliczka PIT, skala', () => {
  it('kwota zmniejszająca 3 600 zł: zaliczka dopiero w maju, potem różnica narastająco', () => {
    const w = zaliczkiPit('skala', rok(6), liczby);
    if (!w.ok) throw new Error(w.brak);
    // Podstawa w kwietniu: 32 000 − 4 000 = 28 000 zł, podatek 3 360 − 3 600 < 0.
    expect(w.miesiace.map((m) => m.zaliczkaGr)).toEqual([0, 0, 0, 0, zl(600), zl(840)]);
    expect(w.miesiace[5]).toMatchObject({
      przychodNarastajacoGr: zl(60_000),
      kosztyNarastajacoGr: zl(12_000),
      dochodNarastajacoGr: zl(48_000),
      spoleczneNarastajacoGr: zl(6_000),
      zdrowotnaNarastajacoGr: 0,
      podstawaNarastajacoGr: zl(42_000),
      podatekNarastajacoGr: zl(1_440),
    });
  });

  it('ponad próg 120 000 zł: 10 800 zł i 32 % nadwyżki', () => {
    const w = zaliczkiPit('skala', [{ miesiac: '2026-01', przychodGr: zl(140_000), kosztyGr: zl(10_000), spoleczneZaplaconeGr: 0, zdrowotnaZaplaconaGr: 0 }], liczby);
    if (!w.ok) throw new Error(w.brak);
    expect(w.miesiace[0]).toMatchObject({ podstawaNarastajacoGr: zl(130_000), podatekNarastajacoGr: zl(14_000), zaliczkaGr: zl(14_000) });
  });

  it('strata w miesiącu: zaliczka zero, bez zwrotu; społeczne nie robią z dochodu straty', () => {
    const miesiace = rok(3);
    miesiace[1] = { ...miesiace[1], przychodGr: 0, kosztyGr: zl(30_000) };
    const w = zaliczkiPit('skala', [{ ...miesiace[0], przychodGr: zl(60_000) }, miesiace[1], miesiace[2]], liczby);
    if (!w.ok) throw new Error(w.brak);
    // Styczeń: 58 000 − 1 000 = 57 000 zł → 6 840 − 3 600 = 3 240 zł.
    expect(w.miesiace[0].zaliczkaGr).toBe(zl(3_240));
    // Luty: dochód 28 000, społeczne 2 000 → 26 000 zł → 3 120 − 3 600 < 0 → podatek 0, zaliczka 0.
    expect(w.miesiace[1]).toMatchObject({ dochodNarastajacoGr: zl(28_000), podatekNarastajacoGr: 0, zaliczkaGr: 0 });
    // Marzec: 36 000 − 3 000 = 33 000 → 3 960 − 3 600 = 360 zł podatku, ale 3 240 już zapłacone.
    expect(w.miesiace[2]).toMatchObject({ podatekNarastajacoGr: zl(360), zaliczkaGr: 0 });

    const strata = zaliczkiPit('skala', [{ miesiac: '2026-01', przychodGr: zl(1_000), kosztyGr: zl(3_000), spoleczneZaplaconeGr: zl(500), zdrowotnaZaplaconaGr: 0 }], liczby);
    if (!strata.ok) throw new Error(strata.brak);
    expect(strata.miesiace[0]).toMatchObject({ dochodNarastajacoGr: zl(-2_000), spoleczneNarastajacoGr: 0, podstawaNarastajacoGr: 0, zaliczkaGr: 0 });
  });

  it('podstawa w pełnych złotych: od 50 gr w górę', () => {
    expect(doZlotych(123_449)).toBe(123_400);
    expect(doZlotych(123_450)).toBe(123_500);
    expect(doZlotych(-123_450)).toBe(-123_500);
  });

  it('brak parametru skali to brak, a nie zero', () => {
    const bez = { ...liczby, skala: { ...liczby.skala, kwotaZmniejszajaca: { ...liczby.skala.kwotaZmniejszajaca, wartosc: null } } };
    expect(zaliczkiPit('skala', rok(1), bez)).toMatchObject({ ok: false, brak: expect.stringContaining('skali podatkowej na 2026 r.') });
  });
});

describe('zaliczka PIT, liniowy', () => {
  it('19 % od dochodu po społecznych i zapłaconej zdrowotnej', () => {
    const w = zaliczkiPit('liniowy', rok(2), liczby);
    if (!w.ok) throw new Error(w.brak);
    // 8 000 − 1 000 − 700 = 6 300 zł → 1 197 zł; luty narastająco 12 600 → 2 394, zaliczka 1 197.
    expect(w.miesiace.map((m) => m.zaliczkaGr)).toEqual([zl(1_197), zl(1_197)]);
    expect(w.miesiace[1]).toMatchObject({ zdrowotnaNarastajacoGr: zl(1_400), podstawaNarastajacoGr: zl(12_600) });
  });

  it('zdrowotna odliczana do limitu rocznego 14 100 zł', () => {
    const w = zaliczkiPit('liniowy', rok(8, { zdrowotnaZaplaconaGr: zl(2_000) }), liczby);
    if (!w.ok) throw new Error(w.brak);
    expect(w.miesiace[6].zdrowotnaNarastajacoGr).toBe(zl(14_000));
    expect(w.miesiace[7].zdrowotnaNarastajacoGr).toBe(zl(14_100));
    // Sierpień: 64 000 − 8 000 − 14 100 = 41 900 zł → 7 961 zł narastająco.
    expect(w.miesiace[7].podatekNarastajacoGr).toBe(zl(7_961));
  });
});

describe('składka zdrowotna od dochodu (skala, liniowy)', () => {
  const z = p.zdrowotna.liczby;

  it('skala 9 % dochodu z poprzedniego miesiąca, nie mniej niż 432,54 zł z podstawą płacy minimalnej', () => {
    expect(zdrowotnaOdDochodu('skala', zl(6_000), z)).toEqual({ ok: true, zdrowotna: { dochodGr: zl(6_000), podstawaGr: zl(6_000), skladkaGr: zl(540), minimalna: false } });
    expect(zdrowotnaOdDochodu('skala', zl(4_000), z)).toEqual({ ok: true, zdrowotna: { dochodGr: zl(4_000), podstawaGr: zl(4_806), skladkaGr: 43_254, minimalna: true } });
    expect(zdrowotnaOdDochodu('skala', zl(-1_500), z)).toMatchObject({ ok: true, zdrowotna: { podstawaGr: zl(4_806), skladkaGr: 43_254, minimalna: true } });
  });

  it('liniowy 4,9 % dochodu, z tą samą minimalną', () => {
    expect(zdrowotnaOdDochodu('liniowy', zl(10_000), z)).toMatchObject({ ok: true, zdrowotna: { skladkaGr: zl(490), minimalna: false } });
    expect(zdrowotnaOdDochodu('liniowy', zl(8_000), z)).toMatchObject({ ok: true, zdrowotna: { podstawaGr: zl(8_000), skladkaGr: 43_254, minimalna: true } });
    // Do grosza: 4,9 % z 12 345,67 zł = 604,93783 → 604,94 zł.
    expect(zdrowotnaOdDochodu('liniowy', 1_234_567, z)).toMatchObject({ ok: true, zdrowotna: { skladkaGr: 60_494 } });
  });

  it('bez minimalnej na rok składkowy: brak', () => {
    expect(zdrowotnaOdDochodu('skala', zl(6_000), { ...z, minimalna: { ...z.minimalna, wartosc: null } })).toMatchObject({ ok: false });
  });
});
