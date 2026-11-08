import { describe, expect, it } from 'vitest';

import { shortCompanyName } from '@/lib/format/company-name';
import { formatPlCompactMoney, formatPlCompactNumber, formatPlPercentChange } from '@/lib/format/pl';

const NBSP = ' ';

describe('formatPlCompactMoney (plan Finora §7.1)', () => {
  it('tysiące i miliony po polsku, z twardą spacją przed „zł”', () => {
    expect(formatPlCompactMoney(45_600)).toBe(`45,6${NBSP}tys.${NBSP}zł`);
    expect(formatPlCompactMoney(1_200_000)).toBe(`1,2${NBSP}mln${NBSP}zł`);
    expect(formatPlCompactMoney(1_000)).toBe(`1${NBSP}tys.${NBSP}zł`);
  });

  it('poniżej tysiąca bez skrótu i bez groszy, nigdy „$” ani „K”', () => {
    expect(formatPlCompactMoney(999)).toBe(`999${NBSP}zł`);
    expect(formatPlCompactMoney(0)).toBe(`0${NBSP}zł`);
    for (const n of [5, 45_600, 1_200_000, -3_400]) {
      expect(formatPlCompactMoney(n)).not.toMatch(/[$K]/);
    }
  });

  it('poniżej tysiąca zaokrąglone do złotych, bez „-0” (przegląd E4)', () => {
    expect(formatPlCompactMoney(845.67)).toBe(`846${NBSP}zł`);
    expect(formatPlCompactMoney(738.15)).toBe(`738${NBSP}zł`);
    expect(formatPlCompactMoney(5.5)).toBe(`6${NBSP}zł`);
    expect(formatPlCompactMoney(-0.4)).toBe(`0${NBSP}zł`);
    expect(formatPlCompactMoney(-3.55e-15)).toBe(`0${NBSP}zł`);
    expect(formatPlCompactMoney(999.4)).toBe(`999${NBSP}zł`);
    // 999,6 zł to po zaokrągleniu tysiąc — już skrót.
    expect(formatPlCompactMoney(999.6)).toBe(`1${NBSP}tys.${NBSP}zł`);
    // Połówki symetrycznie: kwota ujemna jak dodatnia, ze znakiem.
    expect(formatPlCompactMoney(-999.5)).toBe(`-1${NBSP}tys.${NBSP}zł`);
    expect(formatPlCompactMoney(-0.5)).toBe(`-1${NBSP}zł`);
  });

  it('kwota ujemna (korekta in minus) zostaje ujemna', () => {
    expect(formatPlCompactMoney(-45_600)).toBe(`-45,6${NBSP}tys.${NBSP}zł`);
  });
});

describe('formatPlPercentChange', () => {
  it('plus, minus typograficzny i zero', () => {
    expect(formatPlPercentChange(12.4)).toBe('+12%');
    expect(formatPlPercentChange(-8)).toBe('−8%');
    expect(formatPlPercentChange(0.3)).toBe('0%');
    expect(formatPlPercentChange(-0.4)).toBe('0%');
  });
});

describe('formatPlCompactNumber (oś Y i kolumny Pulpitu, PLAN-PRAWDZIWE-DANE E5)', () => {
  it('bez waluty, najwyżej 3 cyfry znaczące — szerokość nie rośnie z kwotą', () => {
    expect(formatPlCompactNumber(12_400)).toBe(`12,4${NBSP}tys.`);
    expect(formatPlCompactNumber(125_400)).toBe(`125${NBSP}tys.`);
    expect(formatPlCompactNumber(1_254_000)).toBe(`1,25${NBSP}mln`);
    expect(formatPlCompactNumber(999.6)).toBe(`1${NBSP}tys.`);
    expect(formatPlCompactNumber(750)).toBe('750');
    expect(formatPlCompactNumber(0)).toBe('0');
  });

  it('dwie cyfry znaczące dla ciasnych kolumn', () => {
    expect(formatPlCompactNumber(42_345, 2)).toBe(`42${NBSP}tys.`);
    expect(formatPlCompactNumber(3_812, 2)).toBe(`3,8${NBSP}tys.`);
  });
});

describe('shortCompanyName (plan Finora §7.2)', () => {
  it('skraca formy prawne z KSeF', () => {
    expect(shortCompanyName('Kowalski spółka z ograniczoną odpowiedzialnością')).toBe('Kowalski sp. z o.o.');
    expect(shortCompanyName('ACME SPÓŁKA AKCYJNA')).toBe('ACME S.A.');
    expect(shortCompanyName('Nowak i Syn Spółka Jawna')).toBe('Nowak i Syn sp.j.');
    expect(shortCompanyName('Firma spółka z ograniczoną odpowiedzialnością spółka komandytowa'))
      .toBe('Firma sp. z o.o. sp.k.');
    expect(shortCompanyName('Alfa Prosta Spółka Akcyjna')).toBe('Alfa P.S.A.');
  });

  it('nazwa bez formy prawnej bez zmian (poza nadmiarowymi spacjami)', () => {
    expect(shortCompanyName('  Jan   Kowalski  ')).toBe('Jan Kowalski');
  });
});
