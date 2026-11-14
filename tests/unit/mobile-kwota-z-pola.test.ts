import { describe, expect, it } from 'vitest';

import { roundToCents } from '@/lib/xml/invoice-calculator';

import { doPola, groszeZPola } from '../../mobile/src/lib/format';

/**
 * Kwota wpisana w pole na telefonie (formularz faktury, Koszty) w groszach.
 * Drugi czytelnik mapy filtra dla telefonu (14.11.2026): „1,005” dawało 100
 * groszy, bo `Math.round(1.005 * 100)` na liczbie zmiennoprzecinkowej to
 * 100,49999…, a serwer (`roundToCents`) zaokrągla do 1,01.
 */
describe('groszeZPola: kwota z pola w groszach jak serwer', () => {
  it('zaokrągla połowę grosza w górę jak roundToCents serwera', () => {
    expect(groszeZPola('1,005')).toBe(101);
    expect(groszeZPola('-1,005')).toBe(-101);
    expect(groszeZPola('12,345')).toBe(1235);
    expect(groszeZPola('12,344')).toBe(1234);
    expect(groszeZPola('0,0049')).toBe(0);
    expect(groszeZPola('0,005')).toBe(1);
  });

  it('zaokrągla dokładnie jak arytmetyka dziesiętna dla każdej kwoty do 3 miejsc (0 do 100 zł)', () => {
    // Wyrocznia na liczbach całkowitych, nie roundToCents: ten na liczbach
    // zmiennoprzecinkowych daje 2,13 dla 2,135 (osobne ustalenie po stronie serwera).
    for (let tysiaczne = 0; tysiaczne <= 100_000; tysiaczne += 1) {
      const tekst = `${Math.floor(tysiaczne / 1000)},${String(tysiaczne % 1000).padStart(3, '0')}`;
      const oczekiwane = Math.floor(tysiaczne / 10) + (tysiaczne % 10 >= 5 ? 1 : 0);
      expect(groszeZPola(tekst), tekst).toBe(oczekiwane);
    }
  });

  it('zgadza się z roundToCents serwera tam, gdzie ten nie ma błędu liczby zmiennoprzecinkowej', () => {
    for (const [tekst, zl] of [['1,005', 1.005], ['12,345', 12.345], ['0,125', 0.125], ['99,995', 99.995]] as const) {
      expect(groszeZPola(tekst), tekst).toBe(Math.round(roundToCents(zl) * 100));
    }
  });

  it('czyta zapis z pola: spacje, przecinek albo kropka, bez części ułamkowej', () => {
    expect(groszeZPola('1 500,50')).toBe(150050);
    expect(groszeZPola('1 500,5')).toBe(150050);
    expect(groszeZPola('1500.5')).toBe(150050);
    expect(groszeZPola('1500')).toBe(150000);
    expect(groszeZPola('1500,')).toBe(150000);
    expect(groszeZPola(',5')).toBe(50);
    expect(groszeZPola('+7')).toBe(700);
    expect(Object.is(groszeZPola('-0,00'), 0)).toBe(true);
  });

  it('puste albo błędne pole to NaN', () => {
    for (const zle of ['', '   ', 'abc', '1,2,3', '1.500,50', '1e3', '-', ',', '12a']) {
      expect(groszeZPola(zle), zle).toBeNaN();
    }
  });
});

describe('doPola: grosze do pola formularza', () => {
  it('pisze złote z przecinkiem i dwoma miejscami, bez spacji i waluty', () => {
    expect(doPola(150050)).toBe('1500,50');
    expect(doPola(5)).toBe('0,05');
    expect(doPola(0)).toBe('0,00');
    expect(doPola(-101)).toBe('-1,01');
    expect(doPola(123456789)).toBe('1234567,89');
  });

  it('wraca do tych samych groszy przez groszeZPola', () => {
    for (const g of [0, 1, 99, 100, 101, 150050, -101, 999999]) expect(groszeZPola(doPola(g))).toBe(g);
  });
});

describe('groszeZPola: duże kwoty', () => {
  it('zaokrągla połowę grosza w górę także od 8192 zł', () => {
    // roundToCents serwera daje tu 8192,00 (EPSILON za mały przy tej wielkości); poprawny wynik to 8192,01.
    expect(groszeZPola('8192,005')).toBe(819201);
    expect(groszeZPola('1 000 000,995')).toBe(100000100);
  });
});
