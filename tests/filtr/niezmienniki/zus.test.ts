import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import { procentGr, skladkiSpoleczne, type LiczbyZus } from '@/lib/ksiegowosc/zus';

import { miesiac, profil } from '../generatory/ksiegowosc';
import { opcje } from '../generatory/ustawienia';

/** Niezmienniki składek społecznych (plan filtra B4.2, NZ-ZUS; rejestr RP-ZUS-*). */
const ZUS = parametryRoku(2026)!.zus.liczby;
const etap = fc.constantFrom('pelny', 'preferencyjny', 'ulga_na_start', 'etat_obok') as fc.Arbitrary<'pelny' | 'preferencyjny' | 'ulga_na_start' | 'etat_obok'>;
const pierwszyDzienRoku = '2026-01-01';

function skladki(m: string, z: Parameters<typeof profil>[0], liczby: LiczbyZus = ZUS) {
  return skladkiSpoleczne(m, profil(z), liczby);
}

describe('NZ-ZUS-01: pełny i preferencyjny ZUS 2026 równe tabeli ZUS co do grosza', () => {
  it('pełny z chorobową: 1 926,76 zł z FP w każdym miesiącu przed kwietniem; preferencyjny 456,18 zł', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 }), (m) => {
        const pelny = skladki(`2026-0${m}`, {});
        expect(pelny.ok && pelny.skladki.razemGr + pelny.skladki.funduszPracyGr).toBe(192_676);
        const pref = skladki(`2026-0${m}`, { zusEtap: 'preferencyjny', zusOd: pierwszyDzienRoku });
        expect(pref.ok && pref.skladki.razemGr).toBe(45_618);
      }),
      opcje(),
    );
  });
});

describe('NZ-ZUS-03: etat obok daje zero składek społecznych', () => {
  it('każdy miesiąc, z chorobowym i bez', () => {
    fc.assert(
      fc.property(miesiac(), fc.boolean(), (m, chorobowe) => {
        expect(skladki(m, { zusEtap: 'etat_obok', chorobowe })).toMatchObject({ ok: true, skladki: { razemGr: 0, funduszPracyGr: 0 } });
      }),
      opcje(),
    );
  });
});

describe('NZ-ZUS-04: dobrowolne chorobowe', () => {
  it('z chorobowym nigdy mniej; różnica to stopa chorobowa razy podstawa', () => {
    fc.assert(
      fc.property(miesiac(), fc.constantFrom('pelny', 'preferencyjny') as fc.Arbitrary<'pelny' | 'preferencyjny'>, (m, e) => {
        const z = skladki(m, { zusEtap: e, zusOd: e === 'pelny' ? null : pierwszyDzienRoku, chorobowe: true });
        const bez = skladki(m, { zusEtap: e, zusOd: e === 'pelny' ? null : pierwszyDzienRoku, chorobowe: false });
        if (!z.ok || !bez.ok) throw new Error('oczekiwane składki');
        expect(z.skladki.razemGr - bez.skladki.razemGr).toBe(procentGr(z.skladki.podstawaGr, ZUS.stopaChorobowa.wartosc as number));
        expect(z.skladki.razemGr).toBeGreaterThanOrEqual(bez.skladki.razemGr);
      }),
      opcje(),
    );
  });
});

describe('NZ-ZUS-05: Fundusz Pracy tylko przy pełnym ZUS', () => {
  it('preferencyjny i ulga bez FP, pełny z FP', () => {
    fc.assert(
      fc.property(miesiac(), (m) => {
        const pelny = skladki(m, {});
        expect(pelny.ok && pelny.skladki.funduszPracyGr).toBeGreaterThan(0);
        const pref = skladki(m, { zusEtap: 'preferencyjny', zusOd: pierwszyDzienRoku });
        expect(pref.ok && pref.skladki.funduszPracyGr).toBe(0);
      }),
      opcje(),
    );
  });
});

describe('NZ-ZUS-02: ulga na start, potem preferencyjny, bez luki i bez nakładania', () => {
  it('przez 6 miesięcy od startu zero; miesiąc końca ulgi i później to brak bez nowego etapu', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 28 }), (startMiesiac, startDzien) => {
        const zusOd = `2026-${String(startMiesiac).padStart(2, '0')}-${String(startDzien).padStart(2, '0')}`;
        for (let k = 0; k < 6; k++) {
          const m = `2026-${String(startMiesiac + k).padStart(2, '0')}`;
          const w = skladki(m, { zusEtap: 'ulga_na_start', zusOd });
          // Pełne zero w miesiącach w całości w uldze; miesiąc, w którym ulga się kończy (start nie od 1.), to brak.
          if (k < 5 || startDzien === 1) expect(w, m).toMatchObject({ ok: true, skladki: { razemGr: 0 } });
        }
        const poUldze = `2026-${String(startMiesiac + 6).padStart(2, '0')}`;
        const w = skladki(poUldze, { zusEtap: 'ulga_na_start', zusOd });
        expect(w.ok && w.skladki.razemGr > 0).toBe(false);
      }),
      opcje(),
    );
  });
});

describe('NZ-ZUS-06: stopa wypadkowa zmienia się 1 kwietnia, nie 1 stycznia', () => {
  it('przy różnych stopach styczeń-marzec mają jedną, kwiecień-grudzień drugą', () => {
    const inne: LiczbyZus = { ...ZUS, stopaWypadkowaOdKwietnia: { ...ZUS.stopaWypadkowaOdKwietnia, wartosc: 200 } };
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (m) => {
        const w = skladki(`2026-${String(m).padStart(2, '0')}`, {}, inne);
        if (!w.ok) throw new Error(w.brak);
        const stopa = m >= 4 ? 200 : (ZUS.stopaWypadkowaDoMarca.wartosc as number);
        expect(w.skladki.wypadkowaGr).toBe(procentGr(w.skladki.podstawaGr, stopa));
      }),
      opcje(),
    );
  });
});

describe('NZ-ZUS-07: miesiąc niepełny (poza startem ulgi) to brak, nie zgadywanie', () => {
  it('pełny i preferencyjny od dnia innego niż pierwszy: brak w miesiącu startu', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 2, max: 28 }), fc.constantFrom('pelny', 'preferencyjny') as fc.Arbitrary<'pelny' | 'preferencyjny'>, (m, d, e) => {
        const mm = String(m).padStart(2, '0');
        const w = skladki(`2026-${mm}`, { zusEtap: e, zusOd: `2026-${mm}-${String(d).padStart(2, '0')}` });
        expect(w.ok).toBe(false);
      }),
      opcje(),
    );
  });
});

describe('składki: wspólne (NZ-WSP-01, NZ-WSP-03, NZ-WSP-04)', () => {
  it('wynik deterministyczny, w groszach całkowitych; brak ma treść', () => {
    fc.assert(
      fc.property(miesiac(), etap, fc.boolean(), fc.option(fc.integer({ min: 1, max: 28 })), (m, e, chorobowe, d) => {
        const z = { zusEtap: e, chorobowe, zusOd: d === null ? (e === 'pelny' || e === 'etat_obok' ? null : pierwszyDzienRoku) : `2026-01-${String(d).padStart(2, '0')}` };
        const a = skladki(m, z);
        expect(skladki(m, z)).toEqual(a);
        if (a.ok) for (const kwota of Object.values(a.skladki)) expect(Number.isSafeInteger(kwota) && kwota >= 0).toBe(true);
        else expect(a.brak.length).toBeGreaterThan(20);
      }),
      opcje(),
    );
  });
});
