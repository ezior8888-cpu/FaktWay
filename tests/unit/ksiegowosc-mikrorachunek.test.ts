import { describe, expect, it } from 'vitest';

import {
  czyMikrorachunekZNip,
  formatujRachunek,
  mikrorachunekZNip,
  normalizujNip,
  STALA_NBP,
} from '@/lib/ksiegowosc/mikrorachunek';

/**
 * Mikrorachunek z NIP (krok K1). Budowa z podatki.gov.pl:
 * LK 10100071 222 Y=2 NIP zera, 26 cyfr. Liczbę kontrolną sprawdzamy
 * niezależnie, na BigInt, regułą IBAN (reszta z 97 równa 1).
 *
 * NIP 1234563218 jest fikcyjny, ale ma poprawną sumę kontrolną.
 * NIP 1234567890 z AGENTS.md ma sumę kontrolną 10, więc NIP-em nie jest.
 */

const NIP = '1234563218';

function resztaIbanBigInt(numer: string): bigint {
  const przestawiony = `${numer.slice(2)}2521${numer.slice(0, 2)}`;
  return BigInt(przestawiony) % BigInt(97);
}

describe('budowa numeru', () => {
  const numer = mikrorachunekZNip(NIP)!;

  it('26 cyfr: LK, 10100071222, Y=2, NIP, dwa zera', () => {
    expect(numer).toMatch(/^\d{26}$/);
    expect(numer.slice(2, 13)).toBe(STALA_NBP);
    expect(STALA_NBP).toBe('10100071222');
    expect(numer[13]).toBe('2');
    expect(numer.slice(14, 24)).toBe(NIP);
    expect(numer.slice(24)).toBe('00');
  });

  it('liczba kontrolna spełnia regułę IBAN (sprawdzenie niezależne)', () => {
    expect(resztaIbanBigInt(numer)).toBe(BigInt(1));
  });

  it('ten sam NIP w innym zapisie daje ten sam numer', () => {
    expect(mikrorachunekZNip('PL 123-456-32-18')).toBe(numer);
    expect(normalizujNip(' 123 456 32 18 ')).toBe(NIP);
  });

  it('wektor z oficjalnego generatora MF: NIP 1234563218 → PL88 1010 0071 2222 1234 5632 1800', () => {
    // Odczyt 5.11.2026: https://podatki-arch.mf.gov.pl/generator-mikrorachunku-podatkowego/
    // (link „Przejdź do generatora mikrorachunku” z podatki.gov.pl), za zgodą Bartosza.
    expect(numer).toBe('88101000712222123456321800');
    expect(formatujRachunek(numer)).toBe('88 1010 0071 2222 1234 5632 1800');
  });
});

describe('walidacja', () => {
  it('niepoprawny NIP nie daje numeru', () => {
    expect(mikrorachunekZNip('1234567890')).toBeNull();
    expect(mikrorachunekZNip('123456321')).toBeNull();
    expect(mikrorachunekZNip('')).toBeNull();
  });

  it('rozpoznaje poprawny numer także ze spacjami', () => {
    const numer = mikrorachunekZNip(NIP)!;
    expect(czyMikrorachunekZNip(numer)).toBe(true);
    expect(czyMikrorachunekZNip(formatujRachunek(numer))).toBe(true);
  });

  it('odrzuca zmienioną cyfrę, cudzą stałą NBP i wariant PESEL', () => {
    const numer = mikrorachunekZNip(NIP)!;
    const zmieniona = `${numer.slice(0, 20)}${(Number(numer[20]) + 1) % 10}${numer.slice(21)}`;
    expect(czyMikrorachunekZNip(zmieniona)).toBe(false);
    expect(czyMikrorachunekZNip(`${numer.slice(0, 2)}10100071221${numer.slice(13)}`)).toBe(false);
    expect(czyMikrorachunekZNip(`${numer.slice(0, 13)}1${numer.slice(14)}`)).toBe(false);
  });
});

describe('zapis', () => {
  it('LK i grupy po cztery cyfry', () => {
    expect(formatujRachunek('12345678901234567890123456')).toBe('12 3456 7890 1234 5678 9012 3456');
  });
});
