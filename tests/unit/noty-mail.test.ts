import { describe, expect, it } from 'vitest';

import {
  normalizeNoteRecipient,
  noteEmailHtml,
  noteEmailIdempotencyKey,
  noteEmailSubject,
  type NoteEmailContent,
} from '@/lib/noty/mail';
import { NOTE_NOT_INVOICE_NOTICE } from '@/lib/noty/teksty';

/**
 * Mail z notą do kontrahenta (krok 2.9, część 1). Klucz idempotencji zależy
 * od zdarzenia (nota, adres, liczba zapisanych wcześniej wysyłek na ten
 * adres), nie od próby: ponowienie po wysyłce bez zapisu historii daje ten sam
 * klucz, a świadome „Wyślij ponownie” po zapisanej wysyłce nowy.
 */

const ID = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';
const INNA = '6e1f9b9d-8b4c-4a72-8e3f-2d5c6b7a8f91';

function tresc(zmiany: Partial<NoteEmailContent> = {}): NoteEmailContent {
  return {
    kind: 'debit',
    number: 'NO/1/2026',
    title: 'Kara umowna',
    total: 12_099.99,
    dueDate: '2026-11-25',
    issuerName: 'Moja Firma <b>sp. z o.o.</b>',
    ...zmiany,
  };
}

describe('adres odbiorcy', () => {
  it('małe litery i bez spacji na brzegach; zły adres to null', () => {
    expect(normalizeNoteRecipient('  Jan.Kowalski@Firma.PL ')).toBe('jan.kowalski@firma.pl');
    expect(normalizeNoteRecipient('jan@firma')).toBeNull();
    expect(normalizeNoteRecipient('jan kowalski@firma.pl')).toBeNull();
    expect(normalizeNoteRecipient('')).toBeNull();
    expect(normalizeNoteRecipient(`${'a'.repeat(250)}@firma.pl`)).toBeNull();
  });
});

describe('klucz idempotencji maila z notą', () => {
  it('stały dla tej samej noty, adresu i liczby wcześniejszych wysyłek; bez adresu w kluczu', () => {
    const key = noteEmailIdempotencyKey(ID, 'jan@firma.pl', 0);
    expect(noteEmailIdempotencyKey(ID, 'jan@firma.pl', 0)).toBe(key);
    expect(key.startsWith(`nota/${ID}/`)).toBe(true);
    expect(key).not.toMatch(/jan|firma/);
    expect(key.length).toBeLessThanOrEqual(200);
  });

  it('inny dla kolejnej świadomej wysyłki, innego adresu i innej noty', () => {
    const key = noteEmailIdempotencyKey(ID, 'jan@firma.pl', 0);
    expect(noteEmailIdempotencyKey(ID, 'jan@firma.pl', 1)).not.toBe(key);
    expect(noteEmailIdempotencyKey(ID, 'anna@firma.pl', 0)).not.toBe(key);
    expect(noteEmailIdempotencyKey(INNA, 'jan@firma.pl', 0)).not.toBe(key);
  });
});

describe('treść maila', () => {
  it('temat: rodzaj, numer i wystawca', () => {
    expect(noteEmailSubject(tresc({ issuerName: 'Moja Firma' }))).toBe('Nota obciążeniowa NO/1/2026 od Moja Firma');
    expect(noteEmailSubject(tresc({ kind: 'credit', number: 'NU/2/2026', issuerName: 'Moja Firma' }))).toBe(
      'Nota uznaniowa NU/2/2026 od Moja Firma',
    );
  });

  it('numer, tytuł, kwota, termin, adnotacja o KSeF i stopka nadawcy', () => {
    const html = noteEmailHtml(tresc()).replace(/ /g, ' ');
    expect(html).toContain('NO/1/2026');
    expect(html).toContain('Kara umowna');
    expect(html).toContain('12 099,99 PLN');
    expect(html).toContain('25.11.2026');
    expect(html).toContain(NOTE_NOT_INVOICE_NOTICE);
    expect(html).toMatch(/za pośrednictwem serwisu FaktWay/);
  });

  it('dane wystawcy w HTML są escapowane', () => {
    const html = noteEmailHtml(tresc());
    expect(html).not.toContain('<b>sp. z o.o.</b>');
    expect(html).toContain('&lt;b&gt;sp. z o.o.&lt;/b&gt;');
  });

  it('nota uznaniowa bez terminu: bez wiersza o terminie', () => {
    expect(noteEmailHtml(tresc({ kind: 'credit', number: 'NU/2/2026', dueDate: null }))).not.toMatch(/Termin zapłaty/);
  });

  it('bez długich myślników w temacie i treści', () => {
    expect(`${noteEmailSubject(tresc())}\n${noteEmailHtml(tresc())}`).not.toMatch(/[—–]/);
  });
});
