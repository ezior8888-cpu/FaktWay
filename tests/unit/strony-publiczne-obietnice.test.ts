import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import manifest from '@/app/manifest';
import sitemap from '@/app/sitemap';
import { metadata as homeMetadata } from '@/app/(home)/page';
import { metadata as pricingMetadata } from '@/app/(marketing)/pricing/page';
import { PRICE_GROSS, TRIAL_DAYS } from '@/lib/billing/pricing';
import { getAllHelpArticles, HELP_CATEGORIES } from '@/lib/help/articles';
import { METODA_PLATNOSCI, OFERTA, OFERTA_NAGLOWEK, PROBA } from '@/lib/marketing/oferta';

/**
 * FaktWay 1.0 (FAKTWAY-1-0, sekcja 3 pkt 8): strony przed logowaniem mówią
 * jednym zdaniem oferty i obiecują tylko to, co jest w kodzie. Bez FLO, bez
 * asystenta, agenta i AI w obietnicach (AI zostaje w środku produktu, na
 * stronie piszemy „ze zdjęcia” i „samo”), bez długich myślników.
 *
 * Strażnik czyta pliki, nie wyrenderowane strony, bo tak łapie też artykuły,
 * metadane i strony wyłączone flagą (/vs/*), które mogą wrócić.
 */

const ROOT = join(__dirname, '..', '..');

const KATALOGI_PUBLICZNE = [
  'app/(home)',
  'app/(marketing)',
  'app/(auth)',
  'components/site',
  'components/auth/finora',
  'content/help',
  'content/blog',
];

const PLIKI_PUBLICZNE = [
  'app/layout.tsx',
  'app/manifest.ts',
  'app/opengraph-image.tsx',
  'app/sitemap.ts',
  'app/robots.ts',
  'app/not-found.tsx',
  'lib/help/articles.ts',
];

/** Komponenty i treści marketingu liczymy tylko wtedy, gdy coś je naprawdę renderuje. */
const KATALOGI_MARKETINGU = ['components/marketing', 'lib/marketing'];

/** Pliki w `public/` czytane przez roboty i ludzi (np. llms.txt, gdy się pojawi). */
const TEKSTY_W_PUBLIC = /\.(txt|md|xml|json|webmanifest)$/;

const WYJATKI_CALE_PLIKI: ReadonlyArray<[prefiks: string, powod: string]> = [
  // Strony prawne zmienia prawnik. Cytaty o „asystencie AI” idą w raporcie PR.
  ['app/(marketing)/legal/', 'dokumenty prawne: osobna decyzja, nie treść marketingu'],
  // Telefon: tę stronę przepisuje równoległy PR telefonu.
  ['app/(marketing)/mobile/', 'stronę /mobile robi PR telefonu'],
];

interface Regula {
  wzor: RegExp;
  co: string;
  /** Prefiksy ścieżek, którym wolno, z powodem. */
  wyjatki?: ReadonlyArray<readonly [prefiks: string, powod: string]>;
}

/** Nazwy, których nie ma w obietnicach (decyzja 2). */
const BEZ_AI: Regula[] = [
  { wzor: /\bflo\b/i, co: 'FLO' },
  { wzor: /asystent/i, co: 'asystent' },
  { wzor: /\bagent/i, co: 'agent' },
  { wzor: /\bAI\b/, co: 'AI' },
  { wzor: /sztuczn/i, co: 'sztuczna inteligencja' },
  { wzor: /inteligentn/i, co: '„inteligentne” funkcje' },
  { wzor: /\bchat/i, co: 'chat' },
  { wzor: /\bLLM\b|\bGPT\b|Claude|Anthropic/, co: 'model albo jego dostawca' },
];

const DLUGI_MYSLNIK: Regula = { wzor: /[—–]|&[mn]dash;/, co: 'długi myślnik' };

/** Tego produkt jeszcze nie ma (decyzja 4). */
const BEZ_POKRYCIA: Regula[] = [
  { wzor: /ryczał/i, co: 'ryczałt' },
  { wzor: /JPK_EWP/, co: 'JPK_EWP' },
  {
    wzor: /\bZUS\b/,
    co: 'ZUS',
    wyjatki: [['app/(marketing)/vs/', 'opis funkcji konkurencji, nie FaktWay']],
  },
  { wzor: /\bPIT\b/, co: 'PIT' },
  { wzor: /wyciąg\w* z banku|wyciąg\w* bankow/i, co: 'import wyciągu z banku' },
  { wzor: /link\w* do płatno/i, co: 'link do płatności' },
  {
    wzor: /walut/i,
    co: 'waluty',
    wyjatki: [
      ['content/help/faktury-walutowe.mdx', 'artykuł mówi wprost, że faktur w obcej walucie jeszcze nie ma'],
      ['content/help/magic-import-z-innych-programow.mdx', 'faktur w obcej walucie nie przenosimy z historii KSeF'],
    ],
  },
  { wzor: /po angielsku|dwujęzyczn/i, co: 'faktury po angielsku' },
  { wzor: /proform/i, co: 'proforma' },
  { wzor: /faktur\w* do paragonu/i, co: 'faktura do paragonu' },
  { wzor: /App Store|Google Play|aplikacj\w* w sklepach/i, co: 'aplikacje w sklepach' },
  { wzor: /BLIK/, co: 'BLIK (dopisuje gałąź zbiorcza, w lib/marketing/oferta.ts)' },
  { wzor: /magiczn/i, co: 'Magiczny Import (decyzja 22.10.2026: znika)' },
];

/** Stare hasła, które konkurowały ze zdaniem oferty. */
const STARE_HASLA: Regula[] = [
  { wzor: /bez stresu/i, co: 'stare hasło „bez stresu”' },
  { wzor: /której nie ma u konkurencji/i, co: 'hasło bez pokrycia w OG' },
  { wzor: /Faktury KSeF dla mikrofirm/i, co: 'stary opis meta' },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return [path];
  });
}

const rel = (path: string) => relative(ROOT, path).replaceAll('\\', '/');

const CZY_KOD = /\.(tsx?|mjs|js)$/;
const CZY_TRESC = /\.(tsx?|mdx?)$/;

/** Bez komentarzy: cytują usunięte frazy, a sprawdzamy to, co widzi klient. */
function bezKomentarzy(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

/** Pliki marketingu, do których prowadzi import z żywego kodu (także przez inne pliki marketingu). */
function zywyMarketing(): string[] {
  const zrodla = ['app', 'components', 'lib'].flatMap((d) => walk(join(ROOT, d))).filter((p) => CZY_KOD.test(p));
  const marketing = zrodla.filter((p) => KATALOGI_MARKETINGU.some((d) => rel(p).startsWith(`${d}/`)));
  const zywe = new Set(zrodla.filter((p) => !marketing.includes(p)));
  const importuje = (src: string, plik: string) => {
    const modul = rel(plik).replace(CZY_KOD, '');
    return src.includes(`'@/${modul}'`) || src.includes(`"@/${modul}"`);
  };
  const tresci = new Map(zrodla.map((p) => [p, readFileSync(p, 'utf8')]));
  const wynik = new Set<string>();
  let zmiana = true;
  while (zmiana) {
    zmiana = false;
    for (const plik of marketing) {
      if (wynik.has(plik)) continue;
      if ([...zywe].some((src) => importuje(tresci.get(src)!, plik))) {
        wynik.add(plik);
        zywe.add(plik);
        zmiana = true;
      }
    }
  }
  return [...wynik];
}

function plikiPubliczne(): string[] {
  const katalogi = KATALOGI_PUBLICZNE.flatMap((d) => walk(join(ROOT, d)));
  const pliki = PLIKI_PUBLICZNE.map((p) => join(ROOT, p));
  const roboty = walk(join(ROOT, 'public')).filter((p) => TEKSTY_W_PUBLIC.test(p) && !rel(p).endsWith('sw.js'));
  return [...new Set([...katalogi, ...pliki, ...zywyMarketing(), ...roboty])]
    .filter((p) => CZY_TRESC.test(p) || roboty.includes(p))
    .filter((p) => !WYJATKI_CALE_PLIKI.some(([prefiks]) => rel(p).startsWith(prefiks)));
}

function trafienia(reguly: Regula[]): string[] {
  const wynik: string[] = [];
  for (const plik of plikiPubliczne()) {
    const sciezka = rel(plik);
    const surowa = readFileSync(plik, 'utf8');
    const tresc = CZY_KOD.test(plik) ? bezKomentarzy(surowa) : surowa;
    for (const linia of tresc.split('\n')) {
      for (const { wzor, co, wyjatki } of reguly) {
        if (wyjatki?.some(([prefiks]) => sciezka.startsWith(prefiks))) continue;
        if (wzor.test(linia)) wynik.push(`${sciezka} (${co}): ${linia.trim().slice(0, 80)}`);
      }
    }
  }
  return wynik;
}

describe('strażnik: strony publiczne', () => {
  it('skanuje to, co trzeba (strona główna, cennik, pomoc, blog, stopka)', () => {
    const pliki = plikiPubliczne().map(rel);
    for (const oczekiwany of [
      'app/(home)/page.tsx',
      'app/(marketing)/pricing/page.tsx',
      'app/(marketing)/pomoc/page.tsx',
      'components/site/site-footer.tsx',
      'components/marketing/savings-calculator-preview.tsx',
      'content/help/plany-i-cennik.mdx',
      'content/blog/ksef-2-co-warto-wiedziec.mdx',
      'lib/marketing/oferta.ts',
    ]) {
      expect(pliki).toContain(oczekiwany);
    }
    // Nieimportowane resztki szablonu nie trafiają na stronę, więc nie ma ich w skanie.
    expect(pliki).not.toContain('components/marketing/landing-hero.tsx');
  });

  it('bez FLO, asystenta, agenta i AI w obietnicach', () => {
    expect(trafienia(BEZ_AI)).toEqual([]);
  });

  it('bez długich myślników', () => {
    expect(trafienia([DLUGI_MYSLNIK])).toEqual([]);
  });

  it('bez obietnic tego, czego produkt nie ma', () => {
    expect(trafienia(BEZ_POKRYCIA)).toEqual([]);
  });

  it('bez starych haseł obok zdania oferty', () => {
    expect(trafienia(STARE_HASLA)).toEqual([]);
  });
});

describe('jedno zdanie oferty', () => {
  it('brzmi tak, jak zdecydował Bartosz, z ceną z lib/billing/pricing.ts', () => {
    expect(OFERTA).toBe(
      `Faktury z KSeF, koszty i należności w jednym programie, także w telefonie, za ${PRICE_GROSS} miesięcznie.`,
    );
    expect(OFERTA).not.toContain(' ');
  });

  it('nagłówek to to samo zdanie, różnią się tylko twarde spacje', () => {
    const naglowek = `${OFERTA_NAGLOWEK.przed}${OFERTA_NAGLOWEK.wyroznienie}${OFERTA_NAGLOWEK.po}`;
    expect(naglowek.replaceAll(' ', ' ')).toBe(OFERTA);
  });

  it('opisy meta strony głównej, cennika, układu, manifestu i obrazka to to samo zdanie', () => {
    expect(homeMetadata.description).toBe(OFERTA);
    expect(pricingMetadata.description).toBe(OFERTA);
    expect(manifest().description).toBe(OFERTA);
    // app/layout.tsx ciągnie next/font, a opengraph-image next/og: tu wystarczy tekst pliku.
    expect(readFileSync(join(ROOT, 'app/layout.tsx'), 'utf8')).toContain('description: OFERTA,');
    expect(readFileSync(join(ROOT, 'app/opengraph-image.tsx'), 'utf8')).toContain('export const alt = OFERTA;');
  });

  it('nikt nie przepisał zdania ręcznie: jest tylko w lib/marketing/oferta.ts', () => {
    const kopie = plikiPubliczne()
      .filter((p) => rel(p) !== 'lib/marketing/oferta.ts')
      .filter((p) => /koszty i należności/.test(readFileSync(p, 'utf8')))
      .map(rel);
    expect(kopie).toEqual([]);
  });

  it('metoda płatności stoi w jednym miejscu, reszta bierze ją z modułu', () => {
    expect(METODA_PLATNOSCI).toBe('karta przy starcie');
    expect(PROBA).toBe(`${TRIAL_DAYS} dni za darmo, karta przy starcie`);
    const wzor = /kart[aęy]\s+(przy starcie|na starcie|podajesz)|kartę\s+podajesz/i;
    const kopie = plikiPubliczne()
      .filter((p) => rel(p) !== 'lib/marketing/oferta.ts')
      .filter((p) => wzor.test(CZY_KOD.test(p) ? bezKomentarzy(readFileSync(p, 'utf8')) : readFileSync(p, 'utf8')))
      .map(rel);
    expect(kopie).toEqual([]);
  });
});

describe('FLO znika z publicznych tras i z indeksu pomocy', () => {
  it('pomoc nie ma kategorii ani artykułów o FLO', () => {
    expect(HELP_CATEGORIES.map((c) => c.id)).not.toContain('flo');
    expect(getAllHelpArticles().filter((a) => a.slug.startsWith('flo-'))).toEqual([]);
    for (const a of getAllHelpArticles()) {
      expect(`${a.title} ${a.summary}`, a.slug).not.toMatch(/\bflo\b|asystent|\bagent/i);
    }
  });

  it('stare adresy artykułów o FLO przekierowują na stronę główną', () => {
    const config = readFileSync(join(ROOT, 'next.config.ts'), 'utf8');
    expect(config).toMatch(/source: '\/pomoc\/flo-:slug',\s*destination: '\/',\s*permanent: true/);
  });

  it('mapa strony nie prowadzi do FLO', () => {
    expect(sitemap().map((e) => e.url).filter((u) => /\/flo|\/pomoc\/flo-/.test(u))).toEqual([]);
  });

  it('nawigacja i stopka nie mają pozycji o FLO', () => {
    for (const plik of ['components/site/site-header.tsx', 'components/site/site-footer.tsx']) {
      expect(readFileSync(join(ROOT, plik), 'utf8'), plik).not.toMatch(/#flo|Agent FLO/);
    }
  });
});
