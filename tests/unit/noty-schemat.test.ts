import { describe, expect, it } from 'vitest';

import { canWriteNotes, formatNoteNumber, noteTotal } from '@/lib/noty/model';
import { NOTE_CURRENCY_ERROR, noteDraftSchema, noteIssueDateError, parsePlAmount } from '@/lib/noty/schemat';

/**
 * Plan kompletnej aplikacji, krok 2.9, część 1: nota obciążeniowa i uznaniowa.
 * Jeden schemat dla formularza i akcji (AGENTS.md: walidacja klient + serwer),
 * kwoty tylko przez `roundToCents`, w tej części wyłącznie PLN.
 */

const KONTRAHENT = '0b8a3f4e-2c1d-4e5f-8a9b-0c1d2e3f4a5b';

const dane = {
  kind: 'debit',
  contractorId: KONTRAHENT,
  issueDate: '2026-11-11',
  title: 'Kara umowna',
  items: [{ description: 'Kara za opóźnienie dostawy', amount: '1 250,50' }],
  currency: 'PLN',
  relatedDocument: '',
  dueDate: '',
  bankAccount: '',
};

function blad(input: Record<string, unknown>): string {
  const r = noteDraftSchema.safeParse(input);
  if (r.success) throw new Error('schemat przepuścił błędne dane');
  return r.error.issues.map((i) => i.message).join(' | ');
}

describe('kwoty noty (roundToCents)', () => {
  it('0,10 + 0,20 = 0,30, a nie 0,30000000000000004', () => {
    expect(noteTotal([{ amount: 0.1 }, { amount: 0.2 }])).toBe(0.3);
  });

  it('50 pozycji po 1 gr daje 0,50', () => {
    expect(noteTotal(Array.from({ length: 50 }, () => ({ amount: 0.01 })))).toBe(0.5);
  });

  it('kwota wpisana po polsku: spacje (także twarde) i przecinek', () => {
    expect(parsePlAmount('1 250,50')).toBe(1250.5);
    expect(parsePlAmount('12 000,00')).toBe(12000);
    expect(parsePlAmount('99.99')).toBe(99.99);
    expect(parsePlAmount('-5')).toBe(-5);
    expect(parsePlAmount('12,3a')).toBeNull();
    expect(parsePlAmount('')).toBeNull();
    expect(parsePlAmount('1,2,3')).toBeNull();
  });
});

describe('schemat szkicu noty', () => {
  it('przyjmuje notę obciążeniową w PLN; kwoty z tekstu na liczby, puste pola na null', () => {
    const r = noteDraftSchema.safeParse(dane);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual({
      kind: 'debit',
      contractorId: KONTRAHENT,
      issueDate: '2026-11-11',
      title: 'Kara umowna',
      items: [{ description: 'Kara za opóźnienie dostawy', amount: 1250.5 }],
      currency: 'PLN',
      relatedDocument: null,
      dueDate: null,
      bankAccount: null,
    });
  });

  it('inna waluta niż PLN: odmowa z komunikatem, że w tej części tylko złote', () => {
    expect(blad({ ...dane, currency: 'EUR' })).toBe(NOTE_CURRENCY_ERROR);
    expect(NOTE_CURRENCY_ERROR).toMatch(/PLN/);
  });

  it.each([
    ['kwota zero', { items: [{ description: 'X', amount: '0' }] }, /większa od zera/],
    ['kwota ujemna', { items: [{ description: 'X', amount: '-5' }] }, /większa od zera/],
    ['trzy miejsca po przecinku', { items: [{ description: 'X', amount: '12,345' }] }, /dwa miejsca po przecinku/],
    ['kwota nie liczbą', { items: [{ description: 'X', amount: 'dwanaście' }] }, /Podaj kwotę/],
    ['ponad miliard', { items: [{ description: 'X', amount: '1000000000,01' }] }, /1 000 000 000/],
    ['pozycja bez opisu', { items: [{ description: '   ', amount: '10' }] }, /Opisz pozycję/],
    ['bez pozycji', { items: [] }, /co najmniej jedną pozycję/],
    ['51 pozycji', { items: Array.from({ length: 51 }, () => ({ description: 'X', amount: '1' })) }, /50 pozycji/],
    ['bez tytułu', { title: '  ' }, /tytuł/],
    ['tytuł dłuższy niż 200 znaków', { title: 'x'.repeat(201) }, /200 znaków/],
    ['kontrahent spoza bazy (nie identyfikator)', { contractorId: 'Jan Kowalski' }, /kontrahenta/],
    ['nieistniejąca data', { issueDate: '2026-02-30' }, /datę wystawienia/],
    ['termin zapłaty przed datą wystawienia', { dueDate: '2026-11-10' }, /Termin zapłaty/],
    ['zły numer rachunku', { bankAccount: 'PL00 1234' }, /rachunku/],
    ['nieznany rodzaj noty', { kind: 'interest' }, /rodzaj noty/],
    ['odniesienie dłuższe niż 120 znaków', { relatedDocument: 'x'.repeat(121) }, /120 znaków/],
  ])('odmowa: %s', (_nazwa, zmiana, komunikat) => {
    expect(blad({ ...dane, ...zmiana })).toMatch(komunikat);
  });

  it('nota uznaniowa nie ma terminu zapłaty ani rachunku: schemat je zeruje', () => {
    const r = noteDraftSchema.safeParse({
      ...dane,
      kind: 'credit',
      dueDate: '2026-11-25',
      bankAccount: 'PL61109010140000071219812874',
    });
    expect(r.success && [r.data.dueDate, r.data.bankAccount]).toEqual([null, null]);
  });

  it('rachunek: NRB bez kodu kraju dostaje PL, spacje znikają', () => {
    const r = noteDraftSchema.safeParse({ ...dane, bankAccount: '61 1090 1014 0000 0712 1981 2874', dueDate: '2026-11-25' });
    expect(r.success && [r.data.bankAccount, r.data.dueDate]).toEqual(['PL61109010140000071219812874', '2026-11-25']);
  });

  it('data wystawienia z przyszłości: odmowa; dzisiejsza i wcześniejsza przechodzą', () => {
    expect(noteIssueDateError('2026-11-12', '2026-11-11')).toMatch(/przyszł/);
    expect(noteIssueDateError('2026-11-11', '2026-11-11')).toBeNull();
    expect(noteIssueDateError('2025-12-31', '2026-11-11')).toBeNull();
  });
});

describe('numer i rola', () => {
  it('numer jak w bazie (CHECK w 00193): osobna seria na rodzaj i rok', () => {
    expect(formatNoteNumber('debit', 1, 2026)).toBe('NO/1/2026');
    expect(formatNoteNumber('credit', 12, 2027)).toBe('NU/12/2027');
  });

  it('notę zapisuje, wystawia i wysyła każdy aktywny członek firmy, jak fakturę', () => {
    for (const role of ['owner', 'admin', 'member', 'accountant']) expect(canWriteNotes(role), role).toBe(true);
    for (const role of ['viewer', '', null, undefined]) expect(canWriteNotes(role), String(role)).toBe(false);
  });
});
