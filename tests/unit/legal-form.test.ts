import { describe, expect, it } from 'vitest';

import { companyInitials, shortenLegalForm } from '@/lib/format/legal-form';

/**
 * PLAN-FINORA §7.2: nazwy kontrahentów w listach mają jedną linię, a KSeF
 * daje pełne formy prawne — skracamy je do popularnych zapisów.
 */
describe('shortenLegalForm', () => {
  it('spółka z ograniczoną odpowiedzialnością → sp. z o.o.', () => {
    expect(shortenLegalForm('Acme spółka z ograniczoną odpowiedzialnością')).toBe('Acme sp. z o.o.');
  });

  it('spółka akcyjna → S.A.', () => {
    expect(shortenLegalForm('Beta Spółka Akcyjna')).toBe('Beta S.A.');
  });

  it('nie rusza nazw bez pełnej formy prawnej ani pustych', () => {
    expect(shortenLegalForm('Jan Kowalski')).toBe('Jan Kowalski');
    expect(shortenLegalForm('')).toBe('');
  });

  it('forma w środku nazwy też jest skracana, a spacje sprzątane', () => {
    expect(shortenLegalForm('  Gamma   spółka z ograniczoną odpowiedzialnością  sp. k. ')).toBe('Gamma sp. z o.o. sp. k.');
  });
});

describe('companyInitials', () => {
  it('dwie litery z dwóch pierwszych znaczących słów', () => {
    expect(companyInitials('Acme Trading spółka z ograniczoną odpowiedzialnością')).toBe('AT');
  });

  it('jedno słowo → jedna litera; forma prawna nie daje inicjałów', () => {
    expect(companyInitials('Acme sp. z o.o.')).toBe('A');
  });

  it('brak nazwy → znak zapytania', () => {
    expect(companyInitials('')).toBe('?');
    expect(companyInitials(null)).toBe('?');
  });

  it('polskie litery i wielkość', () => {
    expect(companyInitials('łukasz żurek')).toBe('ŁŻ');
  });
});
