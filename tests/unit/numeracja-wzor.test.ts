import { describe, expect, it } from 'vitest';

import {
  patternPeriod,
  patternProblem,
  patternProblemMessage,
  patternReset,
  patternSkeleton,
  renderInvoiceNumber,
  type PatternProblem,
} from '@/lib/numeracja/wzor';

/**
 * Krok 2.5 (numeracja): wzór numeru faktury z elementami rok, miesiąc, licznik
 * i przedrostek. Art. 106e ust. 1 pkt 2 ustawy o VAT: kolejny numer w ramach
 * serii, który jednoznacznie identyfikuje fakturę. Wzór bez licznika albo
 * z elementami, które dają dwa takie same numery dla różnych faktur, jest
 * odrzucany. Te same reguły ma baza (`invoice_number_pattern_problem`,
 * 00199); zgodność obu sprawdza tests/rls-numeracja.test.ts.
 */

describe('walidacja wzoru numeru', () => {
  it.each([
    'FV/{NNN}/{MM}/{RRRR}',
    'FV/{N}/{RRRR}',
    'KOR/{RRRR}/{NNNN}',
    'FV{RRRR}{NNNN}',
    '{N}/{M}/{RRRR}',
    'S1-{RRRR}-{MM}-{NN}',
    'F {N}',
    '{N}',
  ])('przyjmuje %s', (pattern) => {
    expect(patternProblem(pattern)).toBeNull();
  });

  it.each<[string, PatternProblem]>([
    ['', 'empty'],
    ['   ', 'empty'],
    ['FV/{RRRR}/{MM}', 'no_counter'],
    ['FAKTURA', 'no_counter'],
    ['FV/{N}/{N}', 'duplicate_token'],
    ['FV/{N}/{RRRR}/{RRRR}', 'duplicate_token'],
    ['FV/{N}/{MM}/{M}/{RRRR}', 'duplicate_token'],
    ['FV/{N}/{MM}', 'month_without_year'],
    ['FV/{N}/{M}', 'month_without_year'],
    ['{N}{M}/{RRRR}', 'ambiguous'],
    ['{M}{N}/{RRRR}', 'ambiguous'],
    ['{N}1{M}/{RRRR}', 'ambiguous'],
    ['{N}{RRRR}{M}', 'ambiguous'],
    ['FV/{X}', 'unknown_token'],
    ['FV/{n}/{RRRR}', 'unknown_token'],
    ['FV/{NNNNNNN}', 'unknown_token'],
    ['FV/{N', 'unknown_token'],
    ['FV}{N}', 'unknown_token'],
    ['FV#{N}', 'bad_char'],
    ['FAŁ/{N}', 'bad_char'],
    [' FV/{N}', 'bad_char'],
    ['FV/{N} ', 'bad_char'],
    // 31 znaków (30 to jeszcze dopuszczalna długość).
    ['FV/{N}/{RRRR}/ABCDEFGHIJKLMNOPQ', 'too_long'],
  ])('odrzuca %j: %s', (pattern, problem) => {
    expect(patternProblem(pattern)).toBe(problem);
  });

  it('miesiąc z zerem i licznik obok siebie są jednoznaczne (stała szerokość miesiąca)', () => {
    expect(patternProblem('{N}{MM}/{RRRR}')).toBeNull();
  });

  it('każdy problem ma komunikat po polsku bez długich myślników', () => {
    const problems: PatternProblem[] = [
      'empty', 'too_long', 'bad_char', 'unknown_token', 'no_counter', 'duplicate_token', 'month_without_year', 'ambiguous',
    ];
    for (const p of problems) {
      const message = patternProblemMessage(p);
      expect(message.length).toBeGreaterThan(10);
      expect(message).not.toContain('—');
    }
    expect(patternProblemMessage('no_counter')).toMatch(/licznik/);
  });
});

describe('okres licznika i numer', () => {
  it('okres wynika z elementów wzoru: miesiąc, rok albo numeracja ciągła', () => {
    expect(patternPeriod('FV/{NNN}/{MM}/{RRRR}', '2026-11-05')).toBe('2026-11');
    expect(patternPeriod('FV/{N}/{M}/{RRRR}', '2026-03-31')).toBe('2026-03');
    expect(patternPeriod('FV/{N}/{RRRR}', '2026-11-05')).toBe('2026');
    expect(patternPeriod('FV/{N}', '2026-11-05')).toBe('');
    expect(patternReset('FV/{N}/{MM}/{RRRR}')).toBe('monthly');
    expect(patternReset('FV/{N}/{RRRR}')).toBe('yearly');
    expect(patternReset('FV/{N}')).toBe('never');
  });

  it('licznik z zerami do liczby N, bez obcinania dłuższego licznika', () => {
    expect(renderInvoiceNumber('FV/{NNN}/{MM}/{RRRR}', '2026-11', 7)).toBe('FV/007/11/2026');
    expect(renderInvoiceNumber('FV/{NNN}/{MM}/{RRRR}', '2026-11', 1234)).toBe('FV/1234/11/2026');
    expect(renderInvoiceNumber('FV/{N}/{M}/{RRRR}', '2026-03', 15)).toBe('FV/15/3/2026');
    expect(renderInvoiceNumber('KOR/{RRRR}/{NN}', '2026', 3)).toBe('KOR/2026/03');
    expect(renderInvoiceNumber('INV-{NNNN}', '', 42)).toBe('INV-0042');
  });

  it('bez numeru, gdy okres nie pasuje do wzoru albo licznik jest zły', () => {
    expect(renderInvoiceNumber('FV/{N}/{MM}/{RRRR}', '2026', 1)).toBeNull();
    expect(renderInvoiceNumber('FV/{N}/{RRRR}', '', 1)).toBeNull();
    expect(renderInvoiceNumber('FV/{N}', '', 0)).toBeNull();
    expect(renderInvoiceNumber('FV/{RRRR}', '2026', 1)).toBeNull();
  });

  it('dwa różne liczniki albo okresy dają dwa różne numery (jednoznaczność)', () => {
    const pattern = '{N}/{M}/{RRRR}';
    const seen = new Map<string, string>();
    for (const period of ['2026-01', '2026-11', '2027-01']) {
      for (let counter = 1; counter <= 120; counter++) {
        const number = renderInvoiceNumber(pattern, period, counter)!;
        const key = `${period}#${counter}`;
        expect(seen.get(number) ?? key).toBe(key);
        seen.set(number, key);
      }
    }
  });
});

describe('układ numeru (szkielet) dla serii firmy', () => {
  it('to znaki poza cyframi w kolejności, bez rozróżniania wielkości liter', () => {
    expect(patternSkeleton('FV/{NNN}/{MM}/{RRRR}')).toBe('FV///');
    expect(patternSkeleton('fv/{N}/{M}/{RRRR}')).toBe('FV///');
    expect(patternSkeleton('S1-{RRRR}-{N}')).toBe('S--');
    expect(patternSkeleton('FW/{N}/{RRRR}')).not.toBe(patternSkeleton('FV/{N}/{RRRR}'));
  });
});
