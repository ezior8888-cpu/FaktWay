import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateJpkFa } from '@/lib/exports/jpk-fa-validator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';
import { validateJpkEwp, validateJpkPkpir } from '@/lib/ksiegowosc/jpk-ewp-walidator';
import { validateFA3 } from '@/lib/xml/validator';

/**
 * Walidatory schematów naprawdę odrzucają zepsute pliki (żelazny filtr F9,
 * plan B4.6). Wszystkie testy XSD filtra zakładają, że walidator mówi „nie”
 * na plik niezgodny ze schematem; walidator, który po cichu przepuszcza
 * wszystko (np. gdy schemat się nie wczyta), unieważniłby je bez śladu.
 *
 * Bazą są złote pliki (poprawne, sprawdzane w `zlote-pliki`). Każde z pięciu
 * zepsuć musi dać `valid = false` i co najmniej jeden komunikat.
 */
const KATALOG = join(process.cwd(), 'tests/filtr/zlote-pliki');

type Walidator = (xml: string) => Promise<{ valid: boolean; errors: readonly unknown[] }>;

const PLIKI: Array<{ plik: string; walidator: Walidator; wymagany: string }> = [
  { plik: 'fa3-zwykla.xml', walidator: validateFA3, wymagany: 'P_2' },
  { plik: 'jpk-v7m3.xml', walidator: validateJpkV7m, wymagany: 'KodUrzedu' },
  { plik: 'jpk-fa4.xml', walidator: validateJpkFa, wymagany: 'KodUrzedu' },
  { plik: 'jpk-ewp4.xml', walidator: validateJpkEwp, wymagany: 'KodUrzedu' },
  { plik: 'jpk-pkpir3.xml', walidator: validateJpkPkpir, wymagany: 'KodUrzedu' },
];

const ZEPSUCIA: Array<{ opis: string; zepsuj: (xml: string, wymagany: string) => string }> = [
  {
    opis: 'brak elementu wymaganego',
    zepsuj: (xml, wymagany) => xml.replace(new RegExp(`<(\\w+:)?${wymagany}>[^<]*</(\\w+:)?${wymagany}>`), ''),
  },
  { opis: 'kwota z przecinkiem zamiast kropki', zepsuj: (xml) => xml.replace(/>(\d+)\.(\d{2})</, '>$1,$2<') },
  { opis: 'nieznany element w nagłówku', zepsuj: (xml) => xml.replace(/<Naglowek>/, '<Naglowek><Nieznany>1</Nieznany>') },
  { opis: 'zła przestrzeń nazw dokumentu', zepsuj: (xml) => xml.replace(/xmlns="[^"]+"/, 'xmlns="http://example.test/nie-ten-wzor/"') },
  { opis: 'plik ucięty w połowie', zepsuj: (xml) => xml.slice(0, Math.floor(xml.length / 2)) },
];

describe('walidatory schematów odrzucają zepsute pliki (F9)', () => {
  for (const { plik, walidator, wymagany } of PLIKI) {
    it(`${plik}: złoty plik przechodzi, a każde z pięciu zepsuć jest odrzucone`, async () => {
      const xml = readFileSync(join(KATALOG, plik), 'utf8');
      const poprawny = await walidator(xml);
      expect(poprawny.errors, `${plik} poprawny`).toEqual([]);
      expect(poprawny.valid).toBe(true);

      for (const { opis, zepsuj } of ZEPSUCIA) {
        const zly = zepsuj(xml, wymagany);
        expect(zly, `${plik}: zepsucie „${opis}” nie zmieniło pliku`).not.toBe(xml);
        const wynik = await walidator(zly);
        expect(wynik.valid, `${plik}: ${opis}`).toBe(false);
        expect(wynik.errors.length, `${plik}: ${opis}`).toBeGreaterThan(0);
      }
    }, 120_000);
  }
});
