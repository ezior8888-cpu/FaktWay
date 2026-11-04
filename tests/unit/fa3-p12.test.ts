import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  domainVatRateFromFa3P12,
  FA3_P12_BY_VAT_RATE,
  importedVatRateLabel,
  importVatRateFromFa3,
  isVatRate,
  VAT_RATES,
  type Fa3RateHeader,
} from '@/lib/xml/fa3-p12';

/**
 * W9 (C5a): odwzorowanie P_12 FA(3) → stawka FaktWay przy imporcie z KSeF.
 * Łańcuch import → JPK sprawdza `import-stawki-p12-jpk.test.ts`; tu reguły
 * i spięcie z mapami generatorów (żeby zmiana w generatorze nie rozjechała
 * importu po cichu).
 */

const header = (o: Partial<Fa3RateHeader> = {}): Fa3RateHeader => ({ nets: {}, vats: {}, exempt: false, ...o });

describe('importVatRateFromFa3 — kod P_12 obecny', () => {
  it.each([
    ['23', '23'], ['8', '8'], ['5', '5'], ['0 KR', '0'], ['zw', 'zw'], ['oo', 'oo'], ['np I', 'np'], ['np II', 'np_ii'],
  ])('„%s” → „%s”', (p12, rate) => {
    expect(importVatRateFromFa3(p12, header())).toBe(rate);
    expect(domainVatRateFromFa3P12(p12)).toBe(rate);
  });

  it.each(['0 WDT', '0 EX', '22', '7', '4', '3'])('„%s” (bez odpowiednika w FaktWay) → zapis dosłowny, nigdy stawka FaktWay', (p12) => {
    expect(importVatRateFromFa3(p12, header())).toBe(p12);
    expect(domainVatRateFromFa3P12(p12)).toBeNull();
    expect(importedVatRateLabel(p12)).toBeTruthy();
  });

  it('białe znaki zwinięte jak w xsd:token', () => {
    expect(importVatRateFromFa3('  np   II ', header())).toBe('np_ii');
    expect(importVatRateFromFa3('0\tWDT', header())).toBe('0 WDT');
  });

  it('gołe „0” / „np” (FA(2)) → wariant z jedynej niezerowej sumy rodziny; inaczej „nieznana”', () => {
    expect(importVatRateFromFa3('0', header({ nets: { P_13_6_2: 100, P_13_1: 50 } }))).toBe('0 WDT');
    expect(importVatRateFromFa3('0', header({ nets: { P_13_6_1: 100, P_13_6_3: 100 } }))).toBe('nieznana');
    expect(importVatRateFromFa3('np', header({ nets: { P_13_8: 100 } }))).toBe('np');
    expect(importVatRateFromFa3('np', header({ nets: { P_13_9: 100, P_13_1: 50 } }))).toBe('np_ii');
    expect(importVatRateFromFa3('np', header())).toBe('nieznana');
  });

  it('kod spoza FA(3) → „nieznana” (nigdy dosłownie ani 23%)', () => {
    expect(importVatRateFromFa3('zw.', header())).toBe('nieznana');
    expect(importVatRateFromFa3('23%', header())).toBe('nieznana');
  });
});

describe('importVatRateFromFa3 — brak P_12 (stawka z nagłówka tylko, gdy jednoznaczna)', () => {
  it('jedna suma P_13_1: 23 vs 22 po proporcji podatku; niejednoznaczna proporcja → „nieznana”', () => {
    expect(importVatRateFromFa3(undefined, header({ nets: { P_13_1: 100 }, vats: { P_14_1: 23 } }))).toBe('23');
    expect(importVatRateFromFa3(undefined, header({ nets: { P_13_1: 100 }, vats: { P_14_1: 22 } }))).toBe('22');
    expect(importVatRateFromFa3(undefined, header({ nets: { P_13_1: 100 } }))).toBe('nieznana');
    expect(importVatRateFromFa3(undefined, header({ nets: { P_13_1: 0.1 }, vats: { P_14_1: 0.02 } }))).toBe('nieznana');
  });

  it('jedna suma P_13_2: 8 vs 7', () => {
    expect(importVatRateFromFa3(undefined, header({ nets: { P_13_2: 1000 }, vats: { P_14_2: 80 } }))).toBe('8');
    expect(importVatRateFromFa3(undefined, header({ nets: { P_13_2: 1000 }, vats: { P_14_2: 70 } }))).toBe('7');
  });

  it.each([
    ['P_13_3', '5'], ['P_13_6_1', '0'], ['P_13_6_2', '0 WDT'], ['P_13_6_3', '0 EX'], ['P_13_7', 'zw'],
    ['P_13_8', 'np'], ['P_13_9', 'np_ii'], ['P_13_10', 'oo'],
  ] as const)('jedna suma %s → „%s”', (field, rate) => {
    expect(importVatRateFromFa3(undefined, header({ nets: { [field]: 100 } }))).toBe(rate);
  });

  it.each(['P_13_4', 'P_13_5', 'P_13_11'] as const)('%s (taksówki, OSS, marża) → „nieznana”', (field) => {
    expect(importVatRateFromFa3(undefined, header({ nets: { [field]: 100 } }))).toBe('nieznana');
  });

  it('dwie niezerowe sumy → „nieznana”; zerowe sumy nie liczą się', () => {
    expect(importVatRateFromFa3(undefined, header({ nets: { P_13_1: 100, P_13_2: 50 }, vats: { P_14_1: 23, P_14_2: 4 } }))).toBe('nieznana');
    expect(importVatRateFromFa3(undefined, header({ nets: { P_13_1: 0, P_13_7: 100 } }))).toBe('zw');
  });

  it('brak sum: zwolnienie (P_19 = 1, art. 106e ust. 4 pkt 3) → „zw”; bez zwolnienia → „nieznana”', () => {
    expect(importVatRateFromFa3(undefined, header({ exempt: true }))).toBe('zw');
    expect(importVatRateFromFa3(undefined, header())).toBe('nieznana');
    expect(importVatRateFromFa3('', header({ exempt: true }))).toBe('zw');
  });
});

describe('stawki FaktWay i mapy generatorów FA(3)', () => {
  it('VAT_RATES = 8 stawek FaktWay; isVatRate odrzuca kody FA(3) i prototyp obiektu', () => {
    expect([...VAT_RATES].sort()).toEqual(['0', '23', '5', '8', 'np', 'np_ii', 'oo', 'zw']);
    expect(isVatRate('0 KR')).toBe(false);
    expect(isVatRate('toString')).toBe(false);
    expect(isVatRate('np_ii')).toBe(true);
  });

  const source = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
  /** Pary `stawka → p12Value` z mapy w pliku generatora (od nazwy mapy do zamknięcia). */
  function p12Pairs(file: string, mapName: string): Record<string, string> {
    const src = source(file);
    const start = src.indexOf(`const ${mapName}`);
    expect(start, `${mapName} w ${file}`).toBeGreaterThanOrEqual(0);
    const body = src.slice(start, src.indexOf('\n};', start));
    const out: Record<string, string> = {};
    for (const m of body.matchAll(/(?:'([^']+)'|(\w+)):\s*\{[^}]*?p12Value:\s*'([^']+)'/g)) {
      out[m[1] ?? m[2]!] = m[3]!;
    }
    return out;
  }

  it.each([
    ['lib/xml/fa3-generator.ts', 'VAT_RATE_MAP'],
    ['lib/ksef/fa3-correction-generator.ts', 'VAT_RATE_MAP'],
    ['lib/ksef/fa3-advance-generator.ts', 'FULL_VAT_RATE_MAP'],
  ])('%s %s emituje dokładnie te P_12, które import odwzorowuje', (file, map) => {
    expect(p12Pairs(file, map)).toEqual(FA3_P12_BY_VAT_RATE);
  });

  it('zaliczka (ADVANCE_VAT_RATE_MAP) — podzbiór tych samych par', () => {
    const pairs = p12Pairs('lib/ksef/fa3-advance-generator.ts', 'ADVANCE_VAT_RATE_MAP');
    expect(Object.keys(pairs).length).toBeGreaterThan(0);
    for (const [rate, p12] of Object.entries(pairs)) {
      expect(FA3_P12_BY_VAT_RATE[rate as keyof typeof FA3_P12_BY_VAT_RATE]).toBe(p12);
    }
  });
});
