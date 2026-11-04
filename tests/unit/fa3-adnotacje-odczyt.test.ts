import { describe, expect, it } from 'vitest';

import {
  annotationsJpkCannotExpress,
  exemptionMismatch,
  invoiceAnnotationsFromFa3,
  jpkAnnotationsFromJson,
  readFa3Annotations,
  readTDataT,
  readTWybor1_2,
} from '@/lib/xml/fa3-annotations';

/**
 * C5b: odczyt Adnotacji i dat FA(3) z pliku innego programu. Wartości przychodzą
 * jako tekst (`parseTagValue: false` w parserze), a FaktWay trzyma liczby 1|2.
 * Nic nieczytelnego nie zamienia się na domyślne „nie” — idzie do problemów.
 */

const DEFAULT_BLOCK = {
  P_16: '2', P_17: '2', P_18: '2', P_18A: '2',
  Zwolnienie: { P_19N: '1' },
  NoweSrodkiTransportu: { P_22N: '1' },
  P_23: '2',
  PMarzy: { P_PMarzyN: '1' },
};

describe('TWybor1_2 (1 = tak, 2 = nie; xsd:byte)', () => {
  it.each([['1', 1], [' 2 ', 2], ['01', 1], ['+1', 1], ['2', 2]])('„%s” → %s', (raw, value) => {
    expect(readTWybor1_2(raw)).toBe(value);
  });
  it.each([['1.0'], ['true'], ['tak'], [''], ['3'], [['1', '1']], [{ x: 1 }], [undefined]])('%j → null (problem, nie „nie”)', (raw) => {
    expect(readTWybor1_2(raw)).toBeNull();
  });
});

describe('TDataT (data jak w XSD FA(3): RRRR-MM-DD, 2006-01-01..2050-01-01)', () => {
  it.each([['2026-09-10', '2026-09-10'], [' 2026-09-10 ', '2026-09-10'], ['2050-01-01', '2050-01-01']])('„%s” → %s', (raw, value) => {
    expect(readTDataT(raw)).toBe(value);
  });
  it.each([['2026-02-30'], ['2026-09-10Z'], ['2026-09-10+02:00'], ['2005-12-31'], ['2050-01-02'], ['10.09.2026'], [['2026-09-10']], [undefined]])('%j → null', (raw) => {
    expect(readTDataT(raw)).toBeNull();
  });
});

describe('readFa3Annotations', () => {
  it('blok domyślny generatora → wszystkie flagi 2, bez zwolnienia, bez procedur, bez problemów', () => {
    expect(readFa3Annotations(DEFAULT_BLOCK)).toEqual({
      annotations: { p16: 2, p17: 2, p18: 2, p18a: 2, p23: 2, exemption: null, newMeansOfTransport: false, marginScheme: null },
      problems: [],
    });
  });

  it.each([
    ['P_19 + P_19A', { P_19: '1', P_19A: 'art. 113 ust. 1' }, { kind: 'P_19A', basis: 'art. 113 ust. 1' }],
    ['P_19 + P_19B', { P_19: '1', P_19B: 'art. 132 dyrektywy' }, { kind: 'P_19B', basis: 'art. 132 dyrektywy' }],
    ['P_19 + P_19C', { P_19: '1', P_19C: 'inna podstawa' }, { kind: 'P_19C', basis: 'inna podstawa' }],
  ])('zwolnienie %s → rodzaj i podstawa', (_n, zwolnienie, exemption) => {
    expect(readFa3Annotations({ ...DEFAULT_BLOCK, Zwolnienie: zwolnienie }).annotations.exemption).toEqual(exemption);
  });

  it.each([
    ['brak zwolnienia', {}],
    ['P_19 i P_19N naraz', { P_19: '1', P_19A: 'x', P_19N: '1' }],
    ['P_19 bez podstawy', { P_19: '1' }],
    ['dwie podstawy', { P_19: '1', P_19A: 'x', P_19B: 'y' }],
    ['pusta podstawa', { P_19: '1', P_19A: '   ' }],
  ])('zwolnienie: %s → problem, bez zgadywania', (_n, zwolnienie) => {
    const { annotations, problems } = readFa3Annotations({ ...DEFAULT_BLOCK, Zwolnienie: zwolnienie });
    expect(annotations).not.toHaveProperty('exemption');
    expect(problems).toEqual([expect.stringContaining('P_19')]);
  });

  it.each([
    ['P_PMarzy_2', { P_PMarzy: '1', P_PMarzy_2: '1' }],
    ['P_PMarzy_3_1', { P_PMarzy: '1', P_PMarzy_3_1: '1' }],
    ['P_PMarzy_3_2', { P_PMarzy: '1', P_PMarzy_3_2: '1' }],
    ['P_PMarzy_3_3', { P_PMarzy: '1', P_PMarzy_3_3: '1' }],
  ])('marża %s → oznaczenie procedury', (marker, pmarzy) => {
    expect(readFa3Annotations({ ...DEFAULT_BLOCK, PMarzy: pmarzy }).annotations.marginScheme).toBe(marker);
  });

  it.each([
    ['bez oznaczenia', { P_PMarzy: '1' }],
    ['dwa oznaczenia', { P_PMarzy: '1', P_PMarzy_2: '1', P_PMarzy_3_1: '1' }],
    ['brak bloku', undefined],
  ])('PMarzy %s → problem', (_n, pmarzy) => {
    const { annotations, problems } = readFa3Annotations({ ...DEFAULT_BLOCK, PMarzy: pmarzy });
    expect(annotations).not.toHaveProperty('marginScheme');
    expect(problems).toEqual([expect.stringContaining('PMarzy')]);
  });

  it('nowe środki transportu P_22 = 1 → true; P_22N → false; nic → problem', () => {
    expect(readFa3Annotations({ ...DEFAULT_BLOCK, NoweSrodkiTransportu: { P_22: '1', P_42_5: '2' } }).annotations.newMeansOfTransport).toBe(true);
    const missing = readFa3Annotations({ ...DEFAULT_BLOCK, NoweSrodkiTransportu: {} });
    expect(missing.annotations).not.toHaveProperty('newMeansOfTransport');
    expect(missing.problems).toEqual([expect.stringContaining('P_22')]);
  });

  it('jedna nieczytelna flaga nie kasuje pozostałych (P_16 „tak”, P_18A = 1)', () => {
    const { annotations, problems } = readFa3Annotations({ ...DEFAULT_BLOCK, P_16: 'tak', P_18A: '1' });
    expect(annotations).not.toHaveProperty('p16');
    expect(annotations.p18a).toBe(1);
    expect(problems).toEqual([expect.stringContaining('P_16')]);
  });

  it('brak Adnotacji (element obowiązkowy) → problem', () => {
    expect(readFa3Annotations(undefined)).toEqual({ annotations: {}, problems: [expect.stringContaining('Adnotacje')] });
  });
});

describe('invoiceAnnotationsFromFa3 → klucze FaktWay (liczby 1|2)', () => {
  it('flagi i zwolnienie z rodzajem; procedury jako nowe klucze', () => {
    expect(invoiceAnnotationsFromFa3({
      p16: 1, p17: 2, p18: 1, p18a: 1, p23: 2,
      exemption: { kind: 'P_19B', basis: 'art. 132' }, newMeansOfTransport: false, marginScheme: 'P_PMarzy_3_1',
    })).toEqual({
      cashMethod: 1, selfInvoicing: 2, reverseCharge: 1, splitPayment: 1, simplifiedProcedure: 2,
      vatExemptionBasis: 'art. 132', vatExemptionBasisKind: 'P_19B', newMeansOfTransport: 2, marginScheme: 'P_PMarzy_3_1',
    });
  });
  it('nieodczytane pola → brak klucza (nie 2)', () => {
    expect(invoiceAnnotationsFromFa3({ p18a: 1 })).toEqual({ splitPayment: 1 });
  });
});

describe('annotationsJpkCannotExpress', () => {
  it.each([
    [{ simplifiedProcedure: 1 }, ['procedura trójstronna (P_23)']],
    [{ newMeansOfTransport: 1 }, ['dostawa nowych środków transportu (P_22)']],
    [{ marginScheme: 'P_PMarzy_2' }, ['procedura marży dla biur podróży (P_PMarzy_2)']],
    [{ marginScheme: 'P_PMarzy_3_1' }, ['procedura marży — towary używane (P_PMarzy_3_1)']],
    [{ simplifiedProcedure: 2, newMeansOfTransport: 2 }, []],
    [undefined, []],
  ])('%j → %j', (a, labels) => {
    expect(annotationsJpkCannotExpress(a as never)).toEqual(labels);
  });
});

describe('exemptionMismatch (P_19 a stawki pozycji)', () => {
  it.each([
    ['podstawa przy stawce zw', { vatExemptionBasis: 'x' }, ['zw'], false],
    ['podstawa bez pozycji zw', { vatExemptionBasis: 'x' }, ['23'], true],
    ['pozycja zw bez podstawy', {}, ['zw', '23'], true],
    ['bez zwolnienia', {}, ['23', '8'], false],
    ['stawka spoza FaktWay — rozstrzyga odmowa stawki, nie zwolnienia', { vatExemptionBasis: 'x' }, ['23', 'nieznana'], false],
  ])('%s', (_n, annotations, rates, mismatch) => {
    expect(exemptionMismatch(annotations, rates)).toBe(mismatch);
  });
});

describe('jpkAnnotationsFromJson', () => {
  it('jawne 2 to false (P_18 z pliku), brak klucza to undefined (P_18 z pozycji)', () => {
    expect(jpkAnnotationsFromJson({ reverseCharge: 2, selfInvoicing: 1 })).toEqual({ reverseCharge: false, selfInvoicing: true });
    expect(jpkAnnotationsFromJson({ splitPayment: 2, cashMethod: 2 })).toBeUndefined();
  });
  it('rodzaj podstawy zwolnienia tylko A/B/C', () => {
    expect(jpkAnnotationsFromJson({ vatExemptionBasis: ' art. 132 ', vatExemptionBasisKind: 'P_19B' }))
      .toEqual({ vatExemptionBasis: 'art. 132', vatExemptionBasisKind: 'P_19B' });
    expect(jpkAnnotationsFromJson({ vatExemptionBasis: 'x', vatExemptionBasisKind: 'P_19Z' })).toEqual({ vatExemptionBasis: 'x' });
  });
});
