import { describe, expect, it } from 'vitest';

import {
  czyDzienRoboczy,
  czySwieto,
  dniWolne,
  najblizszyDzienRoboczy,
  ostatniMiesiacKwartalu,
  terminDla,
  wielkanoc,
  type RodzajTerminu,
} from '@/lib/ksiegowosc/kalendarz';

/**
 * Kalendarz modułu księgowości (krok K1). Terminy 2027 to tabela z sekcji 5
 * planu („Kalendarz 2027”), w tym grudzień 2027 z terminami w styczniu 2028.
 */

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

function faktyczny(rodzaj: RodzajTerminu, rok: number, miesiac: number): string | undefined {
  return terminDla({ rodzaj, rok, miesiac })?.faktyczny;
}

describe('dni wolne', () => {
  it('Wigilia jest dniem wolnym od 2025 r., wcześniej nie', () => {
    expect(czySwieto(d('2025-12-24'))).toBe(true);
    expect(czySwieto(d('2027-12-24'))).toBe(true);
    expect(czySwieto(d('2024-12-24'))).toBe(false);
  });

  it('liczba dni wolnych: 13 do 2024 r., 14 od 2025 r.', () => {
    expect(dniWolne(2024).size).toBe(13);
    expect(dniWolne(2025).size).toBe(14);
    expect(dniWolne(2027).size).toBe(14);
  });

  it('Wielkanoc i święta ruchome 2027', () => {
    expect(iso(wielkanoc(2027))).toBe('2027-03-28');
    const wolne = dniWolne(2027);
    expect(wolne.has('2027-03-29')).toBe(true); // poniedziałek wielkanocny
    expect(wolne.has('2027-05-16')).toBe(true); // Zielone Świątki
    expect(wolne.has('2027-05-27')).toBe(true); // Boże Ciało
  });

  it('przesunięcie zawsze do przodu, przez Wigilię i święta', () => {
    expect(iso(najblizszyDzienRoboczy(d('2027-12-24')))).toBe('2027-12-27');
    expect(iso(najblizszyDzienRoboczy(d('2024-12-24')))).toBe('2024-12-24');
    expect(czyDzienRoboczy(d('2027-12-27'))).toBe(true);
  });
});

describe('terminy 2027 (sekcja 5 planu)', () => {
  // Okres → termin ryczałtu, zaliczki PIT i ZUS (20. z przesunięciem).
  const DWUDZIESTY: [number, number, string][] = [
    [2026, 12, '2027-01-20'],
    [2027, 1, '2027-02-22'],
    [2027, 2, '2027-03-22'],
    [2027, 3, '2027-04-20'],
    [2027, 4, '2027-05-20'],
    [2027, 5, '2027-06-21'],
    [2027, 6, '2027-07-20'],
    [2027, 7, '2027-08-20'],
    [2027, 8, '2027-09-20'],
    [2027, 9, '2027-10-20'],
    [2027, 10, '2027-11-22'],
    [2027, 11, '2027-12-20'],
    [2027, 12, '2028-01-20'],
  ];

  // Okres → termin JPK_V7M i VAT (25. z przesunięciem).
  const DWUDZIESTY_PIATY: [number, number, string][] = [
    [2026, 12, '2027-01-25'],
    [2027, 1, '2027-02-25'],
    [2027, 2, '2027-03-25'],
    [2027, 3, '2027-04-26'],
    [2027, 4, '2027-05-25'],
    [2027, 5, '2027-06-25'],
    [2027, 6, '2027-07-26'],
    [2027, 7, '2027-08-25'],
    [2027, 8, '2027-09-27'],
    [2027, 9, '2027-10-25'],
    [2027, 10, '2027-11-25'],
    [2027, 11, '2027-12-27'],
    [2027, 12, '2028-01-25'],
  ];

  it.each(DWUDZIESTY)('ryczałt, zaliczka i ZUS za %i-%i: %s', (rok, miesiac, termin) => {
    expect(faktyczny('ryczalt', rok, miesiac)).toBe(termin);
    expect(faktyczny('zaliczkaPit', rok, miesiac)).toBe(termin);
    expect(faktyczny('zus', rok, miesiac)).toBe(termin);
  });

  it.each(DWUDZIESTY_PIATY)('JPK_V7M i VAT za %i-%i: %s', (rok, miesiac, termin) => {
    expect(faktyczny('vatJpk', rok, miesiac)).toBe(termin);
  });

  it('termin nominalny zostaje obok faktycznego', () => {
    expect(terminDla({ rodzaj: 'vatJpk', rok: 2027, miesiac: 11 })).toEqual({
      rodzaj: 'vatJpk',
      nominalny: '2027-12-25',
      faktyczny: '2027-12-27',
      przesuniety: true,
    });
  });

  it('bez znanych terminów nie zgaduje', () => {
    expect(terminDla({ rodzaj: 'zus', rok: 2025, miesiac: 11 })).toBeNull();
  });
});

describe('kwartały', () => {
  it('ostatni miesiąc kwartału', () => {
    expect([1, 4, 8, 12].map(ostatniMiesiacKwartalu)).toEqual([3, 6, 9, 12]);
  });
});
