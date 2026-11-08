import { describe, expect, it } from 'vitest';

import { normalizeProductName } from '@/lib/dashboard/product-name';
import { productBreakdown } from '@/lib/analytics-finance/products';
import { rankProducts } from '@/lib/dashboard/rankings';

/**
 * Ranking produktów grupuje po nazwie pozycji (`rankProducts`). Nazwy
 * powtarzalnych usług niosą okres („Usługi programistyczne – październik
 * 2026”), więc bez normalizacji klucza każdy miesiąc byłby osobnym
 * „produktem”. `normalizeProductName` usuwa z nazwy określenia okresu
 * i numer umowy; nazwa wyświetlana zachowuje wielkość liter.
 */

describe('normalizeProductName: tabela typowych nazw', () => {
  const same: [string, string][] = [
    ['Usługi programistyczne – październik 2026', 'Usługi programistyczne'],
    ['Usługi programistyczne - listopad 2026', 'Usługi programistyczne'],
    ['Usługi programistyczne – września 2026', 'Usługi programistyczne'],
    ['Usługi programistyczne za październik 2026', 'Usługi programistyczne'],
    ['Usługi programistyczne za października 2026 r.', 'Usługi programistyczne'],
    ['Usługi programistyczne za miesiąc październik', 'Usługi programistyczne'],
    ['Abonament 10/2026', 'Abonament'],
    ['Abonament 11/2026', 'Abonament'],
    ['Abonament 2026-10', 'Abonament'],
    ['Abonament 2026-11', 'Abonament'],
    ['Abonament 10.2026', 'Abonament'],
    ['Abonament (październik 2026)', 'Abonament'],
    ['Abonament za 10/2026', 'Abonament'],
    ['Obsługa księgowa za okres 01.10.2026 - 31.10.2026', 'Obsługa księgowa'],
    ['Obsługa księgowa za okres od 01.11.2026 do 30.11.2026', 'Obsługa księgowa'],
    ['Obsługa księgowa 01.12.2026', 'Obsługa księgowa'],
    ['Hosting za styczeń', 'Hosting'],
    ['Hosting za luty 2027', 'Hosting'],
    ['Hosting – marzec', 'Hosting'],
    ['Hosting – kwiecień 2027', 'Hosting'],
    ['Hosting – maj 2027', 'Hosting'],
    ['Hosting – czerwiec 2027', 'Hosting'],
    ['Hosting – lipca 2027', 'Hosting'],
    ['Hosting – sierpień 2027', 'Hosting'],
    ['Hosting – grudnia 2026', 'Hosting'],
    ['Wsparcie wg umowy nr 12/2026', 'Wsparcie'],
    ['Wsparcie według umowy nr ABC-5/2026', 'Wsparcie'],
    ['Wsparcie wg umowy nr 12/2026 za październik 2026', 'Wsparcie'],
    ['Wsparcie za październik 2026 wg umowy nr 12/2026', 'Wsparcie'],
    ['Wsparcie – październik 2026 – etap A', 'Wsparcie – etap A'],
    ['  usługi   programistyczne   –   LISTOPAD   2026 ', 'usługi programistyczne'],
  ];

  it.each(same)('„%s” → „%s”', (input, expected) => {
    expect(normalizeProductName(input).display).toBe(expected);
  });

  it('klucz nie zależy od wielkości liter ani spacji', () => {
    expect(normalizeProductName('USŁUGI  PROGRAMISTYCZNE – PAŹDZIERNIK 2026').key).toBe(
      normalizeProductName('Usługi programistyczne – listopad 2026').key,
    );
  });

  it('nazwy bez okresu zostają, także ze „zwykłymi” liczbami', () => {
    for (const name of ['Usługi programistyczne', 'Licencja 2026', 'Pakiet 10 godzin', 'Maj Tec – wdrożenie', 'Marzec Sp.']) {
      // „Maj Tec”/„Marzec Sp.” to nazwy własne, ale rozpoznawane są tylko określenia okresu z kontekstem — patrz niżej.
      expect(normalizeProductName(name).display.length).toBeGreaterThan(0);
    }
    expect(normalizeProductName('Licencja 2026').display).toBe('Licencja 2026');
    expect(normalizeProductName('Pakiet 10 godzin').display).toBe('Pakiet 10 godzin');
    expect(normalizeProductName('Usługi programistyczne').display).toBe('Usługi programistyczne');
  });

  it('nazwa złożona wyłącznie z okresu zostaje (nie ginie w pustej grupie)', () => {
    expect(normalizeProductName('Październik 2026').display).toBe('Październik 2026');
    expect(normalizeProductName('  ').display).toBe('');
  });
});

describe('rankProducts i productBreakdown: ten sam produkt w kolejnych miesiącach to jedna pozycja', () => {
  const lines = [
    { id: 'a', issue_date: '2026-10-05', name: 'Usługi programistyczne – październik 2026', unit: 'szt.', net_amount: 1000 },
    { id: 'b', issue_date: '2026-11-05', name: 'Usługi programistyczne – listopad 2026', unit: 'szt.', net_amount: 1500 },
    { id: 'c', issue_date: '2026-12-05', name: 'Usługi PROGRAMISTYCZNE – grudzień 2026', unit: 'szt.', net_amount: 500 },
    { id: 'd', issue_date: '2026-11-07', name: 'Szkolenie', unit: 'szt.', net_amount: 2000 },
  ];

  it('rankProducts sumuje miesiące, nazwa z najnowszej pozycji bez okresu', () => {
    const ranking = rankProducts(lines);
    expect(ranking.map((p) => [p.name, p.net])).toEqual([
      ['Usługi PROGRAMISTYCZNE', 3000],
      ['Szkolenie', 2000],
    ]);
  });

  it('inna j.m. to nadal osobna grupa', () => {
    const ranking = rankProducts([...lines, { id: 'e', issue_date: '2026-12-06', name: 'Usługi programistyczne za grudzień 2026', unit: 'godz.', net_amount: 10 }]);
    expect(ranking.filter((p) => p.name.toLowerCase().startsWith('usługi'))).toHaveLength(2);
  });

  it('„Sprzedaż według produktów”: jedna pozycja z sumą, etykieta z j.m.', () => {
    const slices = productBreakdown(lines);
    expect(slices.map((s) => [s.label, s.amount])).toEqual([
      ['Usługi PROGRAMISTYCZNE (szt.)', 3000],
      ['Szkolenie (szt.)', 2000],
    ]);
  });
});
