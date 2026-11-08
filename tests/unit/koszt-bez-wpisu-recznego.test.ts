import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import PricingPage from '@/app/(marketing)/pricing/page';
import { readSpend } from '@/lib/flo/budget';
import type { FloDbClient } from '@/lib/flo/db-types';

import { tekstBezZnacznikow } from './helpers/tekst-html';

/**
 * Plan kompletnej aplikacji, sekcja 2.6 (spis kodu z 8.11.2026): cennik, pomoc,
 * komunikaty limitu odczytu, karta „Nie odczytałem tego zdjęcia” i jej przycisk
 * obiecywały, że po nieudanym odczycie albo wyczerpanym limicie klient „wpisze
 * dane ręcznie”. Takiej drogi nie ma: nieudany odczyt kończy zadanie jako
 * `failed` i nie tworzy kosztu (lib/jobs/runners/process-ocr.ts), a aplikacja
 * nie ma formularza nowego kosztu (app/actions/expenses.ts: wgranie zdjęcia,
 * status odczytu, przegląd istniejącego kosztu, usunięcie). Przycisk „Wpisz
 * ręcznie” prowadził tylko na listę wydatków.
 *
 * Prawdziwa droga to ponowne wgranie dokumentu, gdy limit się odnowi. Teksty
 * mówią to wprost, a poniższe testy sprawdzają w kodzie obie rzeczy, które
 * teksty twierdzą: dzienny limit liczy odczyty z ostatnich 24 godzin
 * (tests/unit/ai-limit-firmy.test.ts), miesięczny odnawia się z początkiem miesiąca (niżej).
 *
 * Formularz kosztu bez zdjęcia to krok 3.8 planu
 * (docs/koordynacja/PLAN-KOMPLETNA-APLIKACJA.md). Gdy powstanie, ten plik traci
 * rację bytu: usuń go razem z przywróceniem tekstów o wpisie ręcznym.
 */

const ROOT = join(__dirname, '..', '..');

/** Strony, treści i interfejs kosztów oraz kod, który składa komunikaty odczytu: teksty, które czyta klient. */
const KATALOGI = [
  'app/(home)',
  'app/(marketing)',
  'content',
  'components/expenses',
  'components/flo',
  'lib/ai',
  'lib/ocr',
  'lib/jobs/runners',
  'lib/flo/functions',
];

/** Pojedyncze pliki z tekstami karty agenta. */
const PLIKI = ['lib/flo/copy.ts'];

/**
 * „Wpisz ręcznie”, „Wpisz kwotę ręcznie”, „wprowadź dane ręcznie”, „dane wpisujesz ręcznie”,
 * „uzupełnij koszt ręcznie”, „dodaj samodzielnie”.
 */
const OBIETNICA_WPISU =
  /(wpisz\w*|wpisuj\w*|wpisać|wprowadź|wprowadzasz|wprowadzić|uzupełni\w*|dodaj|dodasz|dodać)\s+(\S+\s+){0,2}(ręcznie|samodzielnie)/i;

const CZY_TRESC = /\.(tsx?|mdx?)$/;
const CZY_KOD = /\.tsx?$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return [path];
  });
}

/** Bez komentarzy: cytują usunięte frazy, a sprawdzamy to, co widzi klient. */
function bezKomentarzy(zrodlo: string): string {
  return zrodlo
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((linia) => !/^\s*\/\//.test(linia))
    .join('\n');
}

function obietnice(): string[] {
  const pliki = [...KATALOGI.flatMap((d) => walk(join(ROOT, d))), ...PLIKI.map((p) => join(ROOT, p))].filter((p) =>
    CZY_TRESC.test(p),
  );
  const wynik: string[] = [];
  for (const plik of pliki) {
    const surowa = readFileSync(plik, 'utf8');
    const tresc = CZY_KOD.test(plik) ? bezKomentarzy(surowa) : surowa;
    for (const linia of tresc.split('\n')) {
      if (OBIETNICA_WPISU.test(linia)) wynik.push(`${relative(ROOT, plik)}: ${linia.trim().slice(0, 100)}`);
    }
  }
  return wynik;
}

const bezSpacji = (tekst: string) => tekst.replace(/\s+/g, ' ');

describe('po wyczerpaniu limitu odczytu zdjęć nikt nie obiecuje wpisu ręcznego', () => {
  it('skaner rozpoznaje znane sformułowania obietnicy', () => {
    for (const zdanie of [
      'Wpisz ręcznie',
      'Wpisz kwotę ręcznie albo zrób nowe ujęcie',
      'Wprowadź dane ręcznie albo spróbuj w przyszłym miesiącu',
      'Po jego wyczerpaniu dane wpisujesz ręcznie.',
      'Uzupełnij koszt ręcznie',
      'Dodaj go samodzielnie',
    ]) {
      expect(zdanie, zdanie).toMatch(OBIETNICA_WPISU);
    }
    expect('Koszt wpisany ręcznie w KPiR').not.toMatch(OBIETNICA_WPISU);
  });

  it('strony, pomoc, treści agenta i komunikaty odczytu milczą o wpisie ręcznym kosztu', () => {
    expect(
      obietnice(),
      'Formularza kosztu bez zdjęcia nie ma (krok 3.8 planu kompletnej aplikacji). Napisz, że dokument wgrywa się ponownie po odnowieniu limitu.',
    ).toEqual([]);
  });

  it('cennik mówi, kiedy limit odczytu wraca, i że dokument wgrywa się ponownie', () => {
    const tekst = bezSpacji(tekstBezZnacznikow(renderToStaticMarkup(createElement(PricingPage))));

    expect(tekst).toContain('ma limit dzienny i miesięczny na firmę');
    expect(tekst).toMatch(/dzienny liczy odczyty z ostatnich 24 godzin, miesięczny odnawia się z początkiem miesiąca/i);
    expect(tekst).toMatch(/nie zostanie odczytany, więc wgrywasz go ponownie, gdy limit się odnowi/);
  });

  it('pomoc o skanowaniu paragonów mówi to samo co cennik', () => {
    const tresc = bezSpacji(readFileSync(join(ROOT, 'content/help/skanowanie-paragonow-ocr.mdx'), 'utf8'));

    expect(tresc).toMatch(/dzienny liczy odczyty z ostatnich 24 godzin, miesięczny odnawia się z początkiem miesiąca/i);
    expect(tresc).toMatch(/nie powstanie z niego koszt/);
    expect(tresc).toMatch(/wgraj dokument ponownie/i);
  });

  it('limit miesięczny liczy od 1. dnia miesiąca, więc wraca z początkiem następnego', async () => {
    const odDnia: string[] = [];
    const db = {
      from: () => ({
        select: () => ({
          eq: () => ({
            gte: async (_kolumna: string, dzien: string) => {
              odDnia.push(dzien);
              return { data: [], error: null };
            },
          }),
        }),
      }),
    } as unknown as FloDbClient;

    await readSpend('t-miesiac', new Date('2026-10-31T22:00:00Z'), db);
    await readSpend('t-miesiac', new Date('2026-11-01T00:30:00Z'), db);

    expect(odDnia).toEqual(['2026-10-01', '2026-11-01']);
  });
});
