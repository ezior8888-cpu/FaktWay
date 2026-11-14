import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { czyMikrorachunekZNip, czyRachunekNrb, formatujRachunek, mikrorachunekZNip } from '@/lib/ksiegowosc/mikrorachunek';

import { opcje } from '../generatory/ustawienia';
import * as wyrocznia from '../wyrocznia/mikrorachunek';

/**
 * Mikrorachunek podatkowy z NIP kontra wyrocznia z czystego pokoju
 * (żelazny filtr F6, plan B9; RP-MIKRO-01, NZ-MIKRO-01, NZ-MIKRO-02).
 * Wyrocznię napisała osobna sesja tylko ze `tests/filtr/wyrocznia/SPEC-mikrorachunek.md`.
 * Porównanie na NIP w postaci kanonicznej (10 cyfr): wpis ze spacjami, kreskami
 * i prefiksem „PL” normalizuje program, a test sprawdza to osobno.
 */

const WAGI = [6, 5, 7, 2, 3, 4, 5, 6, 7];

/** Dziewięć cyfr i cyfra kontrolna: poprawny NIP albo `null`, gdy reszta wynosi 10. */
function nipZ(dziewiec: string): string | null {
  const r = WAGI.reduce((s, w, i) => s + w * Number(dziewiec[i]), 0) % 11;
  return r === 10 ? null : `${dziewiec}${r}`;
}

const dziesiecCyfr = fc.stringMatching(/^[0-9]{10}$/);
const poprawnyNip = fc.stringMatching(/^[0-9]{9}$/).map(nipZ).filter((n): n is string => n !== null);
const dwadziesciaSzescCyfr = fc.stringMatching(/^[0-9]{26}$/);

describe('mikrorachunek z NIP kontra wyrocznia (RP-MIKRO-01)', () => {
  it('wektor z oficjalnego generatora MF: NIP 1234563218', () => {
    expect(mikrorachunekZNip('1234563218')).toBe('88101000712222123456321800');
    expect(wyrocznia.mikrorachunekZNip('1234563218')).toBe('88101000712222123456321800');
    expect(formatujRachunek('88101000712222123456321800')).toBe('88 1010 0071 2222 1234 5632 1800');
    expect(wyrocznia.zapisRachunku('88101000712222123456321800')).toBe('88 1010 0071 2222 1234 5632 1800');
  });

  it('każde 10 cyfr: ten sam numer albo brak w obu (NZ-MIKRO-01, NZ-MIKRO-02)', () => {
    fc.assert(
      fc.property(dziesiecCyfr, (nip) => {
        expect(mikrorachunekZNip(nip)).toBe(wyrocznia.mikrorachunekZNip(nip));
        if (!wyrocznia.nipPoprawny(nip)) expect(mikrorachunekZNip(nip)).toBeNull();
      }),
      opcje(),
    );
  });

  it('poprawny NIP: numer, sprawdzenie i zapis jak w wyroczni', () => {
    fc.assert(
      fc.property(poprawnyNip, (nip) => {
        const numer = mikrorachunekZNip(nip);
        expect(numer).toBe(wyrocznia.mikrorachunekZNip(nip));
        expect(numer).not.toBeNull();
        if (numer === null) return;
        expect(czyMikrorachunekZNip(numer)).toBe(true);
        expect(wyrocznia.czyMikrorachunekZNip(numer)).toBe(true);
        expect(czyRachunekNrb(numer)).toBe(true);
        expect(formatujRachunek(numer)).toBe(wyrocznia.zapisRachunku(numer));
      }),
      opcje(),
    );
  });

  it('jedna cyfra zmieniona: oba odrzucają numer', () => {
    fc.assert(
      fc.property(poprawnyNip, fc.integer({ min: 0, max: 25 }), fc.integer({ min: 1, max: 9 }), (nip, pozycja, przesuniecie) => {
        const numer = mikrorachunekZNip(nip);
        if (numer === null) return;
        const zly = `${numer.slice(0, pozycja)}${(Number(numer[pozycja]) + przesuniecie) % 10}${numer.slice(pozycja + 1)}`;
        expect(czyMikrorachunekZNip(zly)).toBe(wyrocznia.czyMikrorachunekZNip(zly));
        expect(czyMikrorachunekZNip(zly)).toBe(false);
        expect(czyRachunekNrb(zly)).toBe(wyrocznia.nrbPoprawny(zly));
      }),
      opcje(),
    );
  });

  it('dowolne 26 cyfr: NRB i mikrorachunek z NIP oceniane tak samo', () => {
    fc.assert(
      fc.property(dwadziesciaSzescCyfr, (numer) => {
        expect(czyRachunekNrb(numer)).toBe(wyrocznia.nrbPoprawny(numer));
        expect(czyMikrorachunekZNip(numer)).toBe(wyrocznia.czyMikrorachunekZNip(numer));
      }),
      opcje(),
    );
  });

  it('wpis ze spacjami, kreskami i prefiksem „PL” daje ten sam numer co NIP kanoniczny', () => {
    fc.assert(
      fc.property(poprawnyNip, (nip) => {
        const wpis = `PL ${nip.slice(0, 3)}-${nip.slice(3, 6)}-${nip.slice(6, 8)}-${nip.slice(8)}`;
        expect(mikrorachunekZNip(wpis)).toBe(wyrocznia.mikrorachunekZNip(nip));
      }),
      opcje(),
    );
  });
});
