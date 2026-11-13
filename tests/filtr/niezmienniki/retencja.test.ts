import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  granicaArchiwizacji,
  LATA_DO_ARCHIWUM,
  LATA_PRZECHOWYWANIA_FAKTUR,
  przesunOLata,
  terminUsunieciaPoArchiwizacji,
} from '@/lib/retention/terminy';

import { opcje } from '../generatory/ustawienia';

/**
 * NZ-RET-01 (żelazny filtr F10, część 6; obszar `retencja`, R1): faktury nie
 * są usuwane przed końcem okresu przechowywania.
 * - FaktWay: 10 lat od dnia wystawienia (AGENTS.md, „Compliance”).
 * - Ustawowo: do przedawnienia zobowiązania podatkowego (art. 112 ustawy
 *   o VAT, art. 86 § 1 Ordynacji podatkowej), czyli 5 lat od końca roku,
 *   w którym upłynął termin płatności podatku (art. 70 § 1 Ordynacji).
 *   Test sprawdza tylko model memoriałowy: obowiązek podatkowy w roku
 *   wystawienia R, termin płatności najpóźniej w R+1 (VAT za grudzień i za
 *   IV kwartał, PIT za rok), bez zawieszenia i przerwania biegu
 *   przedawnienia (art. 70 Ordynacji) i bez zdarzeń po wystawieniu. Wtedy
 *   przedawnienie mija najpóźniej z końcem roku R+6.
 *   Poza modelem, więc poza tym testem: metoda kasowa VAT (art. 21 ust. 1
 *   pkt 1 ustawy o VAT: obowiązek z dniem zapłaty, choćby po latach),
 *   korekta i ulga na złe długi po latach (art. 89a, 89b), termin
 *   przesunięty z dnia wolnego (art. 12 § 5 Ordynacji), rok podatkowy CIT
 *   dłuższy niż 12 miesięcy. Przy metodzie kasowej i zapłacie po latach
 *   przedawnienie może minąć później niż 10 lat od wystawienia: to pytanie
 *   do księgowej i osobne ustalenie, nie gwarancja tego testu.
 *
 * Fakturę usuwa `cron.retention-delete`, gdy `scheduled_deletion_at` jest
 * wcześniejszy niż chwila przebiegu (`lib/jobs/runners/retention-delete.ts`),
 * a ten termin zapisuje tylko `cron.archive-old-invoices` fakturom wystawionym
 * przed granicą archiwizacji. Test bierze więc dla każdej chwili przebiegu
 * archiwizacji najpóźniej wystawioną fakturę, którą ten przebieg obejmuje,
 * i sprawdza jej termin usunięcia. Oba końce okresu liczy sam (dzień w Polsce
 * przez Intl, lata według art. 112 Kodeksu cywilnego), bez pomocników programu.
 */

/** Lata przechowywania według AGENTS.md; celowo nie stała programu. */
const LATA_FAKTWAY = 10;

const formatChwili = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Warsaw',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hourCycle: 'h23',
});

/** Chwila jako „RRRR-MM-DD GG:MM:SS.mmm” w Polsce; napisy porównują się jak chwile. */
function wPolsce(ms: number): string {
  return formatChwili.format(new Date(ms)).replace(',', '.');
}

/** Chwila, w której w Polsce jest `dzien` i `czas` (CET albo CEST). */
function chwilaZPolski(dzien: string, czas: string): number {
  const [r, m, d] = dzien.split('-').map(Number) as [number, number, number];
  const [g, min, s] = czas.split(/[:.]/).map(Number) as [number, number, number, number];
  const ms = Number(czas.split('.')[1] ?? 0);
  for (const przesuniecie of [1, 2]) {
    const proba = Date.UTC(r, m - 1, d, g - przesuniecie, min, s, ms);
    if (wPolsce(proba) === `${dzien} ${czas}`) return proba;
  }
  throw new Error(`Brak chwili ${dzien} ${czas} w Polsce`);
}

/** Dzień `n` dni po `dzien` (ujemne: przed). */
function dzienPo(dzien: string, n: number): string {
  const [r, m, d] = dzien.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(r, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Ten sam dzień `lata` lat później; dnia brak w miesiącu (29 lutego): ostatni dzień miesiąca (art. 112 KC). */
function poLatach(dzien: string, lata: number): string {
  const [r, m, d] = dzien.split('-').map(Number) as [number, number, number];
  const proba = new Date(Date.UTC(r + lata, m - 1, d));
  const wynik = proba.getUTCMonth() === m - 1 ? proba : new Date(Date.UTC(r + lata, m, 0));
  return wynik.toISOString().slice(0, 10);
}

/** Błędy niezmiennika dla przebiegu archiwizacji w chwili `teraz` (pusta lista: w porządku). */
function bledyPrzebiegu(teraz: number): string[] {
  const granica = granicaArchiwizacji(new Date(teraz));
  const najpozniejWystawiona = dzienPo(granica, -1);
  const termin = Date.parse(terminUsunieciaPoArchiwizacji(new Date(teraz)));
  const usuniecie = wPolsce(termin);
  const bledy: string[] = [];
  const koniecFaktWay = `${poLatach(najpozniejWystawiona, LATA_FAKTWAY)} 23:59:59.999`;
  if (!(usuniecie > koniecFaktWay)) {
    bledy.push(`przebieg ${wPolsce(teraz)}: faktura z ${najpozniejWystawiona} usunięta ${usuniecie}, przed końcem ${koniecFaktWay}`);
  }
  const koniecUstawowy = `${Number(najpozniejWystawiona.slice(0, 4)) + 6}-12-31 23:59:59.999`;
  if (!(usuniecie > koniecUstawowy)) {
    bledy.push(`przebieg ${wPolsce(teraz)}: faktura z ${najpozniejWystawiona} usunięta ${usuniecie}, przed przedawnieniem w modelu memoriałowym ${koniecUstawowy}`);
  }
  return bledy;
}

describe('NZ-RET-01: faktura nie jest usuwana przed końcem okresu przechowywania', () => {
  it('okres przechowywania programu to 10 lat, archiwum wcześniej niż koniec okresu', () => {
    expect(LATA_PRZECHOWYWANIA_FAKTUR).toBe(LATA_FAKTWAY);
    expect(LATA_DO_ARCHIWUM).toBeGreaterThan(0);
    expect(LATA_DO_ARCHIWUM).toBeLessThan(LATA_PRZECHOWYWANIA_FAKTUR);
  });

  it('każdy dzień 2026-2060 (początek dnia, 3:00 przebiegu, koniec dnia w Polsce): usunięcie po 10 latach od wystawienia i po przedawnieniu w modelu memoriałowym', () => {
    const bledy: string[] = [];
    for (let dzien = '2026-01-01'; dzien <= '2060-12-31' && bledy.length < 10; dzien = dzienPo(dzien, 1)) {
      for (const czas of ['00:00:00.000', '03:00:00.000', '23:59:59.999']) {
        bledy.push(...bledyPrzebiegu(chwilaZPolski(dzien, czas)));
      }
    }
    expect(bledy).toEqual([]);
  });

  it('losowe chwile przebiegu 2026-2060', () => {
    const od = Date.parse('2026-01-01T00:00:00Z');
    const doChwili = Date.parse('2060-12-31T23:59:59Z');
    fc.assert(
      fc.property(fc.integer({ min: od, max: doChwili }), (teraz) => {
        expect(bledyPrzebiegu(teraz)).toEqual([]);
      }),
      opcje(),
    );
  });
});

describe('NZ-RET-01: lata liczone jak termin w latach (art. 112 KC)', () => {
  it.each([
    ['2028-02-29', 10, '2038-02-28'],
    ['2028-02-29', -2, '2026-02-28'],
    ['2028-02-29', 8, '2036-02-29'],
    ['2092-02-29', 8, '2100-02-28'],
    ['2026-12-31', 10, '2036-12-31'],
    ['2026-01-01', -2, '2024-01-01'],
  ])('%s przesunięte o %i lat daje %s', (dzien, lata, wynik) => {
    expect(przesunOLata(dzien, lata)).toBe(wynik);
  });

  it('każdy dzień 2020-2070 przesunięty o -2, 8 i 10 lat: tak samo jak w teście', () => {
    const rozne: string[] = [];
    for (let dzien = '2020-01-01'; dzien <= '2070-12-31' && rozne.length < 10; dzien = dzienPo(dzien, 1)) {
      for (const lata of [-LATA_DO_ARCHIWUM, LATA_PRZECHOWYWANIA_FAKTUR - LATA_DO_ARCHIWUM, LATA_FAKTWAY]) {
        if (przesunOLata(dzien, lata) !== poLatach(dzien, lata)) rozne.push(`${dzien} ${lata}`);
      }
    }
    expect(rozne).toEqual([]);
  });

  it.each(['2026-02-30', '2026-13-01', '2026-1-01', ''])('odrzuca niepoprawną datę „%s”', (dzien) => {
    expect(() => przesunOLata(dzien, 1)).toThrow(/nieprawidłowa data/);
  });
});
