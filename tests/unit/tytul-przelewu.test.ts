import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MAKS_DLUGOSC_TYTULU_PRZELEWU,
  WZORZEC_NUMERU_KSEF,
  poprawnyNumerKsef,
  tytulPrzelewu,
  tytulPrzelewuNaDokumencie,
} from '@/lib/invoices/tytul-przelewu';

/**
 * Krok 1.4 planu kompletnej aplikacji (RP-PLAT-01, RP-PLAT-03): od 1.01.2027
 * płacący za fakturę z KSeF podaje w tytule przelewu jej numer KSeF, także
 * w MPP. FaktWay podsuwa gotowy tytuł. Tu walidator numeru (wzorzec
 * `TNumerKSeF` ze schematu FA(3)) i budowa tytułu z niezmiennikami:
 *  - tytuł ma najwyżej 140 znaków (4 wiersze po 35 znaków w Elixir);
 *  - poprawny numer KSeF stoi w nim pierwszy, w całości i dokładnie raz;
 *  - numeru, który nie przechodzi walidacji, w tytule nie ma.
 * NIP fikcyjny z AGENTS.md.
 */

const ROOT = join(__dirname, '..', '..');
/** KSeF 2.0: 35 znaków, NIP-RRRRMMDD-12 znaków szesnastkowych-2 znaki kontrolne. */
const KSEF = '1234567890-20270105-0A1B2C3D4E5F-7A';
/** Zapis z kreską w środku części szesnastkowej (36 znaków), który schemat też dopuszcza. */
const KSEF_36 = '1234567890-20260315-0A1B2C-3D4E5F-6A';

const SCHEMATY = [
  'lib/xml/schemas/fa3/schemat.xsd',
  'lib/exports/schemas/jpk-v7m3/schemat.xsd',
  'lib/exports/schemas/jpk-ewp4/schemat.xsd',
  'lib/exports/schemas/jpk-pkpir3/schemat.xsd',
];

function wzorzecZeSchematu(plik: string): string {
  const xsd = readFileSync(join(ROOT, plik), 'utf8');
  const m = /<xsd:simpleType name="TNumerKSeF">[\s\S]*?<xsd:pattern value="([^"]+)"\/>/.exec(xsd);
  if (!m) throw new Error(`Brak TNumerKSeF w ${plik}`);
  return m[1]!;
}

const XSD = wzorzecZeSchematu(SCHEMATY[0]!);
/**
 * Wyrocznia: wzorzec prosto ze schematu, z regułami XSD (wzorzec obejmuje
 * cały napis, `\d` to cyfra dowolnego pisma).
 */
const WYROCZNIA = new RegExp(`^(?:${XSD.replaceAll('\\d', '\\p{Nd}')})$`, 'u');
/** `xsd:token`: tabulatory i końce wierszy na spacje, serie spacji w jedną, bez spacji z brzegów. */
const zwinXsd = (s: string) => s.replace(/[\t\n\r]/g, ' ').replace(/ {2,}/g, ' ').replace(/^ /, '').replace(/ $/, '');
const wedlugSchematu = (s: string) => (WYROCZNIA.test(zwinXsd(s)) ? zwinXsd(s) : null);

/** Powtarzalne liczby losowe (mulberry32), żeby wynik testu nie zależał od przebiegu. */
function losowe(ziarno: number): () => number {
  let a = ziarno >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function losowyNumerKsef(r: () => number): string {
  const z = (znaki: string) => znaki[Math.floor(r() * znaki.length)]!;
  const cyfry = (n: number) => Array.from({ length: n }, () => z('0123456789')).join('');
  const typ = r();
  let id: string;
  if (typ < 0.6) {
    const druga = z('0123456789');
    const trzecia = druga === '0' ? z('123456789') : z('0123456789');
    id = z('123456789') + druga + trzecia + cyfry(7);
  } else if (typ < 0.8) {
    id = 'M' + cyfry(9);
  } else {
    id = z('ABCDEFGHIJKLMNOPQRSTUVWXYZ') + z('ABCDEFGHIJKLMNOPQRSTUVWXYZ') + z('ABCDEFGHIJKLMNOPQRSTUVWXYZ') + cyfry(7);
  }
  const rok = String(2020 + Math.floor(r() * 80));
  const miesiac = String(1 + Math.floor(r() * 12)).padStart(2, '0');
  const dzien = String(1 + Math.floor(r() * 31)).padStart(2, '0');
  const hex = (n: number) => Array.from({ length: n }, () => z('0123456789ABCDEF')).join('');
  return `${id}-${rok}${miesiac}${dzien}-${hex(6)}${r() < 0.2 ? '-' : ''}${hex(6)}-${hex(2)}`;
}

/** Prawie-numer: od jednej do trzech zmian znaku (podmiana, usunięcie, wstawienie). */
function zmienionyNumer(r: () => number): string {
  const znaki = '0123456789ABCDEFabcdefMIZ- \t';
  let s = losowyNumerKsef(r);
  const zmian = 1 + Math.floor(r() * 3);
  for (let k = 0; k < zmian; k += 1) {
    const i = Math.floor(r() * (s.length + 1));
    const c = znaki[Math.floor(r() * znaki.length)]!;
    const rodzaj = r();
    if (rodzaj < 0.4) s = s.slice(0, i) + c + s.slice(i + 1);
    else if (rodzaj < 0.7) s = s.slice(0, i) + s.slice(i + 1);
    else s = s.slice(0, i) + c + s.slice(i);
  }
  return s;
}

/** Numer faktury z liter (także polskich), cyfr, ukośników, kropek, kresek i spacji. */
function losowyNumerFaktury(r: () => number, maks: number): string {
  const znaki = 'FVKORZALabcxyząęłóśżź0123456789/.- ';
  const dlugosc = Math.floor(r() * (maks + 1));
  return Array.from({ length: dlugosc }, () => znaki[Math.floor(r() * znaki.length)]!).join('');
}

const ileRazy = (tekst: string, fraza: string) => tekst.split(fraza).length - 1;

describe('numer KSeF: wzorzec TNumerKSeF ze schematu', () => {
  it('wzorzec modułu to wzorzec ze schematu FA(3), tylko z cyframi ASCII zamiast \\d', () => {
    expect(WZORZEC_NUMERU_KSEF).toBe(XSD.replaceAll('\\d', '[0-9]'));
  });

  it.each(SCHEMATY)('ten sam wzorzec jest w %s', (plik) => {
    expect(wzorzecZeSchematu(plik)).toBe(XSD);
  });

  it.each([
    KSEF,
    KSEF_36,
    'M123456789-20270105-0A1B2C3D4E5F-7A',
    'ABC1234567-20270105-0A1B2C3D4E5F-7A',
    '1034567890-20271231-FFFFFFFFFFFF-00',
    '1204567890-20270229-000000000000-FF',
  ])('przyjmuje %s', (numer) => {
    expect(WYROCZNIA.test(numer)).toBe(true);
    expect(poprawnyNumerKsef(numer)).toBe(numer);
  });

  it('zdejmuje białe znaki z brzegów jak XSD (xsd:token), a w środku odrzuca', () => {
    expect(poprawnyNumerKsef(` ${KSEF}\n`)).toBe(KSEF);
    expect(poprawnyNumerKsef(`\t${KSEF} `)).toBe(KSEF);
    expect(poprawnyNumerKsef(KSEF.replace('-7A', ' -7A'))).toBeNull();
  });

  it.each([
    ['zastępczy napis z testów', 'KSEF-1'],
    ['małe litery szesnastkowe', KSEF.toLowerCase()],
    ['NIP od zera', '0234567890-20270105-0A1B2C3D4E5F-7A'],
    ['NIP z dwoma zerami po pierwszej cyfrze', '1004567890-20270105-0A1B2C3D4E5F-7A'],
    ['rok sprzed 2020', '1234567890-20190105-0A1B2C3D4E5F-7A'],
    ['miesiąc 13', '1234567890-20271305-0A1B2C3D4E5F-7A'],
    ['dzień 32', '1234567890-20270132-0A1B2C3D4E5F-7A'],
    ['bez znaków kontrolnych', '1234567890-20270105-0A1B2C3D4E5F'],
    ['znak za dużo', `${KSEF}B`],
    ['identyfikator zbiorczy (osobny PR)', '1234567890-IZ202701-0A1B2C3D4E5F-7A'],
    ['pusty', ''],
    ['same spacje', '   '],
  ])('odrzuca: %s', (_opis, numer) => {
    expect(WYROCZNIA.test(zwinXsd(numer))).toBe(false);
    expect(poprawnyNumerKsef(numer)).toBeNull();
  });

  it.each([null, undefined, 1234567890, {}, ['x']])('odrzuca wartość, która nie jest napisem: %s', (wartosc) => {
    expect(poprawnyNumerKsef(wartosc)).toBeNull();
  });

  it('cyfry innych pism: schemat je przepuszcza, moduł nie (ostrzej niż schemat)', () => {
    const arabskie = '1٢3٤٥٦٧٨٩٠-20270105-0A1B2C3D4E5F-7A';
    expect(WYROCZNIA.test(arabskie)).toBe(true);
    expect(poprawnyNumerKsef(arabskie)).toBeNull();
  });

  it('zgadza się z wyrocznią ze schematu na 5000 losowych numerach i prawie-numerach', () => {
    const r = losowe(20270101);
    let poprawnych = 0;
    for (let i = 0; i < 5000; i += 1) {
      const s = i % 2 === 0 ? losowyNumerKsef(r) : zmienionyNumer(r);
      const oczekiwane = wedlugSchematu(s);
      expect(poprawnyNumerKsef(s), JSON.stringify(s)).toBe(oczekiwane);
      if (oczekiwane) poprawnych += 1;
    }
    // Obie grupy są liczne: test sprawdza i przyjęcia, i odrzucenia.
    expect(poprawnych).toBeGreaterThanOrEqual(2500);
    expect(poprawnych).toBeLessThan(4500);
  });
});

describe('tytuł przelewu', () => {
  it('numer KSeF pierwszy, potem numer faktury po spacji', () => {
    expect(tytulPrzelewu('FV/1/01/2027', KSEF)).toBe(`${KSEF} FV/1/01/2027`);
  });

  it.each([null, undefined, '', '   '])('bez numeru KSeF (%s): sam numer faktury, jak dotąd', (brak) => {
    expect(tytulPrzelewu('FV/1/01/2027', brak)).toBe('FV/1/01/2027');
  });

  it.each(['KSEF-1', KSEF.toLowerCase(), '1234567890-20271305-0A1B2C3D4E5F-7A'])(
    'numer spoza wzorca (%s): sam numer faktury, złego numeru w tytule nie ma',
    (zly) => {
      const tytul = tytulPrzelewu('FV/1/01/2027', zly);
      expect(tytul).toBe('FV/1/01/2027');
      expect(tytul).not.toContain(zly);
    },
  );

  it('numer faktury dochodzi, gdy całość ma najwyżej 140 znaków; dłuższy zostaje poza tytułem', () => {
    expect(MAKS_DLUGOSC_TYTULU_PRZELEWU).toBe(140);
    const miesciSie = 'X'.repeat(140 - KSEF.length - 1);
    expect(tytulPrzelewu(miesciSie, KSEF)).toBe(`${KSEF} ${miesciSie}`);
    expect(tytulPrzelewu(miesciSie, KSEF)).toHaveLength(140);
    expect(tytulPrzelewu(`${miesciSie}Y`, KSEF)).toBe(KSEF);
  });

  it('numer faktury, w którym już jest numer KSeF, nie dubluje go', () => {
    // Przypomnienie bierze numer KSeF jako numer faktury, gdy faktura nie ma własnego numeru.
    expect(tytulPrzelewu(KSEF, KSEF)).toBe(KSEF);
    expect(tytulPrzelewu(`FV ${KSEF}`, KSEF)).toBe(KSEF);
    // Inny numer KSeF w numerze faktury też nie wchodzi: tytuł ma jeden numer KSeF.
    expect(tytulPrzelewu(`FV ${KSEF_36}`, KSEF)).toBe(KSEF);
  });

  it('faktura z MPP: sam numer KSeF, bo w komunikacie MPP pole numeru faktury ma 35 znaków', () => {
    expect(tytulPrzelewu('FV/1/01/2027', KSEF, { mpp: true })).toBe(KSEF);
    expect(tytulPrzelewu('FV/1/01/2027', KSEF, { mpp: false })).toBe(`${KSEF} FV/1/01/2027`);
    // Bez numeru KSeF MPP niczego nie zmienia: sam numer faktury, jak dotąd.
    expect(tytulPrzelewu('FV/1/01/2027', null, { mpp: true })).toBe('FV/1/01/2027');
  });

  it('pusty numer faktury: sam numer KSeF', () => {
    expect(tytulPrzelewu('', KSEF)).toBe(KSEF);
    expect(tytulPrzelewu('  ', KSEF)).toBe(KSEF);
  });

  it('bez białych znaków z brzegów numeru KSeF i numeru faktury', () => {
    expect(tytulPrzelewu('  FV/1  ', ` ${KSEF}\n`)).toBe(`${KSEF} FV/1`);
  });

  it('bez numeru KSeF numer faktury zostaje bez zmian, także dłuższy (w bazie ma najwyżej 100 znaków)', () => {
    const dlugi = 'F'.repeat(150);
    expect(tytulPrzelewu(dlugi, null)).toBe(dlugi);
  });
});

describe('niezmienniki tytułu na losowych danych', () => {
  it('poprawny numer KSeF: najwyżej 140 znaków, numer pierwszy, w całości i dokładnie raz', () => {
    const r = losowe(140);
    for (let i = 0; i < 3000; i += 1) {
      const ksef = losowyNumerKsef(r);
      const numer = losowyNumerFaktury(r, 160);
      const mpp = r() < 0.2;
      const tytul = tytulPrzelewu(numer, ksef, { mpp });
      const opis = JSON.stringify({ ksef, numer, mpp, tytul });
      expect(tytul.length, opis).toBeLessThanOrEqual(140);
      expect(tytul.startsWith(ksef), opis).toBe(true);
      expect(ileRazy(tytul, ksef), opis).toBe(1);
      const czysty = numer.trim();
      const oczekiwany = !mpp && czysty && ksef.length + 1 + czysty.length <= 140 ? `${ksef} ${czysty}` : ksef;
      expect(tytul, opis).toBe(oczekiwany);
    }
  });

  it('numer spoza wzorca: tytuł to numer faktury, złego numeru w nim nie ma', () => {
    const r = losowe(404);
    let sprawdzonych = 0;
    for (let i = 0; i < 3000; i += 1) {
      const zly = zmienionyNumer(r);
      if (wedlugSchematu(zly)) continue;
      // Numer faktury z bazy ma najwyżej 100 znaków (VARCHAR(100)).
      const numer = losowyNumerFaktury(r, 100);
      const tytul = tytulPrzelewu(numer, zly);
      expect(tytul).toBe(numer);
      expect(tytul.length).toBeLessThanOrEqual(140);
      if (zly.trim() && !numer.includes(zly.trim())) expect(tytul.includes(zly.trim())).toBe(false);
      sprawdzonych += 1;
    }
    expect(sprawdzonych).toBeGreaterThan(1000);
  });
});

describe('tytuł na dokumencie (PDF faktury, mail z fakturą, ekran faktury)', () => {
  const przelew = { metoda: 'transfer', doZaplaty: 123 };

  it('przelew z kwotą do zapłaty i poprawnym numerem KSeF: tytuł', () => {
    expect(tytulPrzelewuNaDokumencie('FV/1/01/2027', KSEF, przelew)).toBe(`${KSEF} FV/1/01/2027`);
  });

  it('faktura z MPP: w wierszu sam numer KSeF', () => {
    expect(tytulPrzelewuNaDokumencie('FV/1/01/2027', KSEF, { ...przelew, mpp: true })).toBe(KSEF);
  });

  it.each([null, undefined, '', 'KSEF-1'])('bez poprawnego numeru KSeF (%s): bez wiersza, dokument jak dotąd', (brak) => {
    expect(tytulPrzelewuNaDokumencie('FV/1/01/2027', brak, przelew)).toBeNull();
  });

  it.each(['cash', 'card', 'mobile', 'other', 'compensation', null, undefined])('zapłata inna niż przelew (%s): bez wiersza', (metoda) => {
    expect(tytulPrzelewuNaDokumencie('FV/1/01/2027', KSEF, { metoda, doZaplaty: 123 })).toBeNull();
  });

  it.each([0, -100, Number.NaN, Number.POSITIVE_INFINITY])('nic do zapłaty albo kwota niepewna (%s): bez wiersza', (doZaplaty) => {
    expect(tytulPrzelewuNaDokumencie('FV/1/01/2027', KSEF, { metoda: 'transfer', doZaplaty })).toBeNull();
  });
});
