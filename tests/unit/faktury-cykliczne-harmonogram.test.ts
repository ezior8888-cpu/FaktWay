import { describe, expect, it } from 'vitest';

import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { previewNextRun } from '@/lib/invoices/recurring/preview';
import {
  catchUpRunDate,
  coveredThroughDate,
  editedRunDate,
  firstRunDate,
  firstRunDateAfter,
  nextRunDate,
  periodLastMonthDate,
  previousRunDate,
  recurringPeriodKey,
  recurringPeriodLabel,
  rescheduleRunDate,
  statusOf,
} from '@/lib/invoices/recurring/schedule';

/**
 * Plan Finora N1: harmonogram faktur cyklicznych. Daty kalendarzowe bez
 * strefy; „dziś” zawsze z `todayInWarsaw`.
 */

describe('nextRunDate', () => {
  it('co miesiąc: ten sam dzień w następnym miesiącu', () => {
    expect(nextRunDate('2026-10-10', 'monthly', 10)).toBe('2026-11-10');
  });

  it('co miesiąc: przełom roku', () => {
    expect(nextRunDate('2026-12-28', 'monthly', 28)).toBe('2027-01-28');
  });

  it('co kwartał: trzy miesiące, także przez przełom roku', () => {
    expect(nextRunDate('2026-10-05', 'quarterly', 5)).toBe('2027-01-05');
    expect(nextRunDate('2026-11-15', 'quarterly', 15)).toBe('2027-02-15');
  });

  it('co rok: ten sam miesiąc rok później', () => {
    expect(nextRunDate('2026-02-28', 'yearly', 28)).toBe('2027-02-28');
  });

  it('dzień pozycji, nie dzień daty wyjściowej (data po zmianie dnia)', () => {
    expect(nextRunDate('2026-10-20', 'monthly', 5)).toBe('2026-11-05');
  });

  it('luty ma każdy dzień 1–28', () => {
    expect(nextRunDate('2027-01-28', 'monthly', 28)).toBe('2027-02-28');
  });

  it.each([0, 29, 31, 1.5])('odrzuca dzień %s', (dzien) => {
    expect(() => nextRunDate('2026-10-10', 'monthly', dzien)).toThrow('Dzień miesiąca musi być liczbą od 1 do 28');
  });

  it('odrzuca nieprawidłową datę', () => {
    expect(() => nextRunDate('2026-02-30', 'monthly', 1)).toThrow('Nieprawidłowa data');
    expect(() => nextRunDate('20.10.2026', 'monthly', 1)).toThrow('Nieprawidłowa data');
  });
});

describe('firstRunDate — najbliższy dzień ≥ dziś (Europe/Warsaw)', () => {
  it('dzień jeszcze przed nami w tym miesiącu', () => {
    expect(firstRunDate('2026-10-20', 25)).toBe('2026-10-25');
  });

  it('dzień dziś — od razu dziś („Do wystawienia”)', () => {
    expect(firstRunDate('2026-10-20', 20)).toBe('2026-10-20');
  });

  it('dzień już minął — następny miesiąc, także przez przełom roku', () => {
    expect(firstRunDate('2026-10-20', 5)).toBe('2026-11-05');
    expect(firstRunDate('2026-12-29', 1)).toBe('2027-01-01');
  });

  it('dziś liczone w Polsce: 31.10 o 00:30 czasu polskiego to jeszcze 30.10 w UTC', () => {
    // 2026-10-30T23:30Z = 31.10 00:30 w Warszawie (CET po zmianie czasu 25.10).
    const dzis = todayInWarsaw(new Date('2026-10-30T23:30:00Z'));
    expect(dzis).toBe('2026-10-31');
    expect(firstRunDate(dzis, 28)).toBe('2026-11-28');
  });
});

describe('recurringPeriodKey — okres, za który wystawiamy', () => {
  it.each([
    ['2026-11-10', 'monthly', '2026-11'],
    ['2027-01-05', 'monthly', '2027-01'],
    ['2026-10-01', 'quarterly', '2026-Q4'],
    ['2026-03-31', 'quarterly', '2026-Q1'],
    ['2026-04-01', 'quarterly', '2026-Q2'],
    ['2026-09-15', 'quarterly', '2026-Q3'],
    ['2026-12-28', 'yearly', '2026'],
  ] as const)('%s, %s → %s', (data, czestotliwosc, klucz) => {
    expect(recurringPeriodKey(data, czestotliwosc)).toBe(klucz);
  });

  it('klucz spełnia CHECK formatu z 00154', () => {
    const check = /^[0-9]{4}(-(0[1-9]|1[0-2])|-Q[1-4])?$/;
    for (const f of ['monthly', 'quarterly', 'yearly'] as const) {
      for (let m = 1; m <= 12; m++) {
        expect(recurringPeriodKey(`2026-${String(m).padStart(2, '0')}-01`, f)).toMatch(check);
      }
    }
  });

  it('kolejne okresy pozycji są różne (unikalny indeks nie blokuje następnego okresu)', () => {
    for (const f of ['monthly', 'quarterly', 'yearly'] as const) {
      let run = '2026-11-10';
      const okresy = new Set<string>();
      for (let i = 0; i < 24; i++) {
        okresy.add(recurringPeriodKey(run, f));
        run = nextRunDate(run, f, 10);
      }
      expect(okresy.size).toBe(24);
    }
  });
});

describe('statusOf', () => {
  it('wstrzymana bez względu na datę', () => {
    expect(statusOf({ active: false, next_run_date: '2026-01-01' }, '2026-10-20')).toBe('paused');
  });

  it('„Do wystawienia”, gdy dzień minął albo jest dziś', () => {
    expect(statusOf({ active: true, next_run_date: '2026-10-20' }, '2026-10-20')).toBe('due');
    expect(statusOf({ active: true, next_run_date: '2026-09-10' }, '2026-10-20')).toBe('due');
  });

  it('aktywna, gdy dzień przed nami', () => {
    expect(statusOf({ active: true, next_run_date: '2026-10-21' }, '2026-10-20')).toBe('active');
  });
});

describe('rescheduleRunDate i catchUpRunDate', () => {
  it('zmiana dnia zostawia miesiąc następnego wystawienia', () => {
    expect(rescheduleRunDate('2026-11-10', 5)).toBe('2026-11-05');
    expect(rescheduleRunDate('2026-11-10', 28)).toBe('2026-11-28');
  });

  it('wznowienie po kilku miesiącach: zostaje ostatni okres, którego dzień nadszedł', () => {
    expect(catchUpRunDate('2026-03-10', 'monthly', 10, '2026-10-20')).toBe('2026-10-10');
    expect(catchUpRunDate('2026-03-10', 'monthly', 25, '2026-10-20')).toBe('2026-09-25');
    expect(catchUpRunDate('2025-01-10', 'quarterly', 10, '2026-10-20')).toBe('2026-10-10');
    expect(catchUpRunDate('2023-05-10', 'yearly', 10, '2026-10-20')).toBe('2026-05-10');
  });

  it('wznowienie tego samego dnia nie pomija czekającego okresu', () => {
    expect(catchUpRunDate('2026-10-17', 'monthly', 17, '2026-10-20')).toBe('2026-10-17');
  });

  it('data z przyszłości bez zmian', () => {
    expect(catchUpRunDate('2026-11-10', 'monthly', 10, '2026-10-20')).toBe('2026-11-10');
  });
});

describe('recurringPeriodLabel', () => {
  it.each([
    ['2026-11', 'listopad 2026'],
    ['2027-01', 'styczeń 2027'],
    ['2026-Q4', 'IV kwartał 2026'],
    ['2026-Q1', 'I kwartał 2026'],
    ['2026', 'rok 2026'],
    ['coś', 'coś'],
  ])('%s → %s', (okres, podpis) => {
    expect(recurringPeriodLabel(okres)).toBe(podpis);
  });
});

describe('previousRunDate — odwrotność nextRunDate (cofnięcie po usunięciu szkicu)', () => {
  it.each([
    ['2026-12-10', 'monthly', 10, '2026-11-10'],
    ['2027-01-10', 'monthly', 10, '2026-12-10'],
    ['2027-01-05', 'quarterly', 5, '2026-10-05'],
    ['2027-02-28', 'yearly', 28, '2026-02-28'],
  ] as const)('%s, %s, dzień %s → %s', (data, czestotliwosc, dzien, wynik) => {
    expect(previousRunDate(data, czestotliwosc, dzien)).toBe(wynik);
  });

  it('nextRunDate(previousRunDate(x)) = x dla każdej częstotliwości', () => {
    for (const f of ['monthly', 'quarterly', 'yearly'] as const) {
      let run = '2026-01-15';
      for (let i = 0; i < 30; i++) {
        expect(nextRunDate(previousRunDate(run, f, 15), f, 15)).toBe(run);
        run = nextRunDate(run, f, 15);
      }
    }
  });
});

describe('firstRunDateAfter — pierwszy termin nie w okresie pokrytym już fakturą', () => {
  it('wzór z dnia wcześniejszego niż dzień pozycji, w tym samym miesiącu → następny miesiąc', () => {
    // Wzór 15.10, dzień 25, dziś 20.10: 25.10 to wciąż październik, który pokrywa wzór.
    expect(firstRunDateAfter('2026-10-20', '2026-10-15', 'monthly', 25)).toBe('2026-11-25');
  });

  it('wzór z dziś, dzień dzisiejszy → za miesiąc, nie od razu „Do wystawienia”', () => {
    expect(firstRunDateAfter('2026-10-20', '2026-10-20', 'monthly', 20)).toBe('2026-11-20');
  });

  it('wzór z poprzedniego miesiąca — bez zmian względem najbliższego dnia od dziś', () => {
    expect(firstRunDateAfter('2026-10-20', '2026-09-25', 'monthly', 25)).toBe('2026-10-25');
    expect(firstRunDateAfter('2026-10-20', '2026-09-10', 'monthly', 5)).toBe('2026-11-05');
  });

  it('co kwartał: wzór z IV kwartału → pierwszy termin w I kwartale 2027', () => {
    expect(firstRunDateAfter('2026-10-20', '2026-10-05', 'quarterly', 5)).toBe('2027-01-05');
    expect(firstRunDateAfter('2026-10-20', '2026-10-01', 'quarterly', 1)).toBe('2027-01-01');
  });

  it('co rok: wzór z tego roku → pierwszy termin w przyszłym roku', () => {
    expect(firstRunDateAfter('2026-10-20', '2026-01-15', 'yearly', 15)).toBe('2027-01-15');
    expect(firstRunDateAfter('2026-10-20', '2026-10-05', 'yearly', 5)).toBe('2027-01-05');
  });

  it('bez pokrytego okresu — jak firstRunDate', () => {
    expect(firstRunDateAfter('2026-10-20', null, 'monthly', 25)).toBe(firstRunDate('2026-10-20', 25));
  });
});

describe('coveredThroughDate — do kiedy okresy są pokryte fakturą', () => {
  it('ostatni miesiąc okresu faktury z pozycji (miesiąc, kwartał, rok)', () => {
    expect(periodLastMonthDate('2026-10')).toBe('2026-10-01');
    expect(periodLastMonthDate('2026-Q4')).toBe('2026-12-01');
    expect(periodLastMonthDate('2026-Q1')).toBe('2026-03-01');
    expect(periodLastMonthDate('2026')).toBe('2026-12-01');
    expect(periodLastMonthDate('coś')).toBeNull();
  });

  it('późniejsza z dat: wzór albo koniec okresu ostatniej faktury z pozycji', () => {
    expect(coveredThroughDate('2026-09-10', [])).toBe('2026-09-10');
    expect(coveredThroughDate('2026-09-10', [{ recurring_period: '2026-10', issue_date: '2026-10-10' }])).toBe('2026-10-01');
    // Faktura za październik wystawiona z opóźnieniem 02.11 pokrywa październik, nie listopad.
    expect(coveredThroughDate('2026-09-10', [{ recurring_period: '2026-10', issue_date: '2026-11-02' }])).toBe('2026-10-01');
    expect(coveredThroughDate(null, [{ recurring_period: '2026-Q4', issue_date: '2026-10-10' }])).toBe('2026-12-01');
    expect(coveredThroughDate(null, [])).toBeNull();
  });
});

describe('editedRunDate i podgląd w arkuszu — ta sama funkcja', () => {
  const pozycja = { next_run_date: '2026-11-10', frequency: 'monthly' as const, day_of_month: 10 };

  it('zmiana co miesiąc → co kwartał po fakturze za październik: pierwszy kwartał bez faktury', () => {
    const covered = coveredThroughDate('2026-09-10', [{ recurring_period: '2026-10', issue_date: '2026-10-10' }]);
    const wejscie = { current: pozycja, frequency: 'quarterly' as const, dayOfMonth: 10, today: '2026-10-20', coveredThrough: covered };
    expect(editedRunDate(wejscie)).toBe('2027-01-10');
    expect(previewNextRun({ today: '2026-10-20', frequency: 'quarterly', dayOfMonth: 10, editing: { ...pozycja, coveredThrough: covered } }))
      .toEqual({ date: '2027-01-10', periodLabel: 'I kwartał 2027' });
  });

  it('zmiana co miesiąc → co rok po fakturze za październik: rok 2027', () => {
    const covered = coveredThroughDate('2026-09-10', [{ recurring_period: '2026-10', issue_date: '2026-10-10' }]);
    expect(editedRunDate({ current: pozycja, frequency: 'yearly', dayOfMonth: 10, today: '2026-10-20', coveredThrough: covered }))
      .toBe('2027-01-10');
  });

  it('zmiana co kwartał → co miesiąc po fakturze za IV kwartał: styczeń, nie listopad', () => {
    const covered = coveredThroughDate('2026-09-10', [{ recurring_period: '2026-Q4', issue_date: '2026-10-10' }]);
    expect(editedRunDate({
      current: { next_run_date: '2027-01-10', frequency: 'quarterly', day_of_month: 10 },
      frequency: 'monthly', dayOfMonth: 10, today: '2026-10-20', coveredThrough: covered,
    })).toBe('2027-01-10');
  });

  it('zmiana samego dnia: ten sam miesiąc, ale nie w okresie już pokrytym', () => {
    expect(editedRunDate({ current: pozycja, frequency: 'monthly', dayOfMonth: 5, today: '2026-10-20', coveredThrough: '2026-10-01' }))
      .toBe('2026-11-05');
    // Pozycja sprzed poprawki wskazywała okres wzoru — zmiana dnia już go nie zostawi.
    expect(editedRunDate({
      current: { next_run_date: '2026-10-25', frequency: 'monthly', day_of_month: 25 },
      frequency: 'monthly', dayOfMonth: 28, today: '2026-10-20', coveredThrough: '2026-10-15',
    })).toBe('2026-11-28');
  });

  it('zmiana na drobniejszą częstotliwość nie gubi zaległego, niewystawionego okresu (weryfikacja K1)', () => {
    // Co kwartał, termin 05.10 minął i faktury za IV kwartał nie ma (ostatnia za III kwartał).
    // Przejście na co miesiąc 20.10: październik nadal „Do wystawienia”, nie dopiero listopad.
    const covered = coveredThroughDate('2026-04-05', [{ recurring_period: '2026-Q3', issue_date: '2026-07-05' }]);
    expect(editedRunDate({
      current: { next_run_date: '2026-10-05', frequency: 'quarterly', day_of_month: 5 },
      frequency: 'monthly', dayOfMonth: 5, today: '2026-10-20', coveredThrough: covered,
    })).toBe('2026-10-05');
    // Co rok, termin 15.01 minął (rok 2026 bez faktury): co miesiąc → styczeń zostaje.
    expect(editedRunDate({
      current: { next_run_date: '2026-01-15', frequency: 'yearly', day_of_month: 15 },
      frequency: 'monthly', dayOfMonth: 15, today: '2026-01-20', coveredThrough: '2025-12-01',
    })).toBe('2026-01-15');
    // Termin w przyszłości: liczymy od wcześniejszej z dat, ale nie w okresie pokrytym.
    expect(editedRunDate({
      current: { next_run_date: '2027-01-15', frequency: 'yearly', day_of_month: 15 },
      frequency: 'monthly', dayOfMonth: 15, today: '2026-10-20', coveredThrough: '2026-12-01',
    })).toBe('2027-01-15');
  });

  it('bez zmian dnia i częstotliwości data zostaje', () => {
    expect(editedRunDate({ current: pozycja, frequency: 'monthly', dayOfMonth: 10, today: '2026-10-20', coveredThrough: '2026-12-01' }))
      .toBe('2026-11-10');
  });

  it('nowa pozycja w podglądzie: data wzoru przesuwa pierwszy termin jak akcja', () => {
    expect(previewNextRun({ today: '2026-10-20', frequency: 'monthly', dayOfMonth: 20, templateIssueDate: '2026-10-20' }))
      .toEqual({ date: '2026-11-20', periodLabel: 'listopad 2026' });
    expect(previewNextRun({ today: '2026-10-20', frequency: 'quarterly', dayOfMonth: 5, templateIssueDate: '2026-10-05' }))
      .toEqual({ date: '2027-01-05', periodLabel: 'I kwartał 2027' });
  });
});
