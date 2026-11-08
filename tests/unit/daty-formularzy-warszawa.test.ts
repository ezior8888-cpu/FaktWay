import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { addDaysToIsoDate, dueDateFrom, todayInWarsaw } from '@/lib/format/warsaw-date';

/**
 * F-013 (audyt bloku 1): formularze faktur liczyły daty w UTC.
 *  - „Dziś” = `new Date().toISOString().slice(0, 10)` — po polskiej północy
 *    (do 1:00/2:00) domyślna data wystawienia była wczorajsza.
 *  - Przyciski „7/14/30 dni” tworzyły LOKALNĄ północ i brały z niej datę UTC:
 *    w Polsce termin wypadał dzień wcześniej (14 dni → 13 dni).
 */

describe('todayInWarsaw', () => {
  it('po polskiej północy to już nowy dzień, choć w UTC jeszcze poprzedni', () => {
    expect(todayInWarsaw(new Date('2026-10-31T23:30:00Z'))).toBe('2026-11-01'); // CET, UTC+1
    expect(todayInWarsaw(new Date('2026-06-30T22:30:00Z'))).toBe('2026-07-01'); // CEST, UTC+2
    expect(todayInWarsaw(new Date('2026-12-31T23:15:00Z'))).toBe('2027-01-01'); // przełom roku
  });

  it('w ciągu dnia zgadza się z datą UTC', () => {
    expect(todayInWarsaw(new Date('2026-10-02T12:00:00Z'))).toBe('2026-10-02');
  });
});

describe('addDaysToIsoDate', () => {
  it.each([
    ['2026-10-02', 14, '2026-10-16'],
    ['2026-10-02', 7, '2026-10-09'],
    ['2026-12-20', 30, '2027-01-19'],
    ['2026-03-20', 14, '2026-04-03'], // przez zmianę czasu na letni
    ['2026-10-20', 14, '2026-11-03'], // przez zmianę czasu na zimowy
    ['2028-02-15', 14, '2028-02-29'], // rok przestępny
    ['2026-10-02', 0, '2026-10-02'],
  ])('%s + %i dni = %s', (base, days, expected) => {
    expect(addDaysToIsoDate(base, days)).toBe(expected);
  });

  it('odrzuca wartości, które nie są datą', () => {
    expect(addDaysToIsoDate('', 14)).toBeNull();
    expect(addDaysToIsoDate('2026-02-31', 1)).toBeNull();
    expect(addDaysToIsoDate('02.10.2026', 1)).toBeNull();
  });
});

describe('dueDateFrom', () => {
  it('liczy od daty wystawienia z formularza', () => {
    expect(dueDateFrom('2026-10-02', 14)).toBe('2026-10-16');
  });

  it('bez daty wystawienia — od dziś w Polsce', () => {
    expect(dueDateFrom('', 14, new Date('2026-10-31T23:30:00Z'))).toBe('2026-11-15');
  });
});

describe('formularze faktur nie biorą daty z UTC', () => {
  // A1 (W5): zaliczka była tu pominięta i liczyła „dziś” w UTC.
  const pliki = [
    'components/invoices/invoice-form.tsx',
    // Pigułki terminu (7/14/30 dni) od 3.7c żyją w części formularza.
    'components/invoices/invoice-form-parts/document-header-fields.tsx',
    'components/invoices/correction-form.tsx',
    'components/invoices/final-form.tsx',
    'components/invoices/advance-form.tsx',
  ];

  it.each(pliki)('%s nie używa toISOString().slice(0, 10) do dat faktury', (plik) => {
    const zrodlo = readFileSync(path.join(process.cwd(), plik), 'utf8');
    expect(zrodlo).not.toMatch(/toISOString\(\)\s*\.slice\(0,\s*10\)/);
  });
});
