import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import manifest from '@/app/manifest';
import sitemap from '@/app/sitemap';
import { metadata as homeMetadata } from '@/app/(home)/page';
import PricingPage, { metadata as pricingMetadata } from '@/app/(marketing)/pricing/page';
import VsIfirma from '@/app/(marketing)/vs/ifirma/page';
import VsInfakt from '@/app/(marketing)/vs/infakt/page';
import VsInni from '@/app/(marketing)/vs/inni/page';
import VsWfirma from '@/app/(marketing)/vs/wfirma/page';
import { PRICE_GROSS, TRIAL_DAYS } from '@/lib/billing/pricing';
import { getAllHelpArticles, HELP_CATEGORIES } from '@/lib/help/articles';
import { METODA_PLATNOSCI, OFERTA, OFERTA_NAGLOWEK, OFERTA_TEKST, PROBA } from '@/lib/marketing/oferta';

import { tekstBezZnacznikow } from './helpers/tekst-html';

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
      ['content/help/eksport-kpir-dla-ksiegowego.mdx', 'kolumna „Waluta” w uniwersalnym CSV ma stałą wartość PLN (csv-generators.ts)'],
    ],
  },
  { wzor: /po angielsku|dwujęzyczn/i, co: 'faktury po angielsku' },
  { wzor: /proform/i, co: 'proforma' },
  { wzor: /faktur\w* do paragonu/i, co: 'faktura do paragonu' },
  {
    wzor: /App Store|Google Play|aplikacj\w* w sklepach/i,
    co: 'aplikacje w sklepach',
    wyjatki: [['app/(marketing)/vs/', 'opis konkurencji („brak app store”), nie FaktWay']],
  },
  {
    wzor: /BLIK/,
    co: 'BLIK zależy od przełącznika',
    wyjatki: [['lib/marketing/oferta.ts', 'jedyne miejsce z metodą płatności, dopisze go gałąź zbiorcza']],
  },
  { wzor: /magiczn\w*\s+import/i, co: 'Magiczny Import (decyzja 22.10.2026: znika)' },
  { wzor: /Frankfurt/, co: 'serwery stoją w Norymberdze, nie we Frankfurcie' },
];

/** Stare hasła, które konkurowały ze zdaniem oferty. */
const STARE_HASLA: Regula[] = [
  { wzor: /bez stresu/i, co: 'stare hasło „bez stresu”' },
  { wzor: /której nie ma u konkurencji/i, co: 'hasło bez pokrycia w OG' },
  { wzor: /Faktury KSeF dla mikrofirm/i, co: 'stary opis meta' },
  // Opis meta z ceną to druga oferta: cena w opisie jest tylko w zdaniu oferty.
  { wzor: /description:.*PRICE_/, co: 'opis meta z ceną obok zdania oferty' },
];

/**
 * Obietnice, które kod spełnia inaczej albo wcale (recenzja PR #355). Każda
 * reguła ma podstawę w kodzie, a prawdziwy opis idzie do pomocy i na stronę.
 * Funkcji nie dobudowujemy: dopóki kod się nie zmieni, strona o tym milczy.
 */
const ROZBIEZNE_Z_KODEM: Regula[] = [
  {
    // prepareReminderAction, runSendReminder i wykonawca karty pytają o rodzaj
    // payment.chase. Bez wiersza w flo_rollout isInCanary() daje false, więc
    // przycisk nie działa nikomu, a killFloAgent wyłącza go wszystkim.
    wzor: /przypomnie\w*\s+(i|oraz)\s+(przedsądow\w*\s+)?wezwa|(wysyłasz|wyślesz|wysyłane)[^.]*przypomnie|przypomnie\w*[^.]*(wysyłasz|wyślesz|wysyłane)|FaktWay[^.]*(przypomnie|wezwa)|po terminie i przypomnienia|Ustawienia\s*→\s*Przypomnienia|przypomnie\w*\s+o\s+płatno|przypomnień\s+o\s+płatno/i,
    co: 'przypomnienia i wezwania stoją za przełącznikiem FLO (payment.chase) i nie działają nikomu',
    wyjatki: [['app/(marketing)/vs/', 'strony wyłączone flagą (404): przegląd przed włączeniem, patrz opis PR #355']],
  },
  // BankAccountInput nie jest nigdzie użyty, pole rachunku na fakturze to zwykły Input.
  { wzor: /rachunk\w*\s+na białej liście/i, co: 'sprawdzanie rachunków na białej liście' },
  {
    // Cykl ponowień trwa ok. 2,5 h, więc limit 24 ponowień nie zapala się w dobę,
    // a po pierwszej serii idzie mail „Faktura odrzucona przez KSeF”.
    wzor: /przez dobę|po dobie|o wyniku (dostajesz|dajemy)|dajemy Ci znać o wyniku|informujemy o wyniku|mniej więcej co godzinę|prosi Cię o ponowną wysyłkę/i,
    co: 'ponawianie „przez dobę” z powiadomieniem o wyniku',
  },
  {
    // load-accountant-portal: 100 najnowszych dokumentów; API: jpk_fa i kpir_excel;
    // XML tylko przy poziomie „Podgląd + pobieranie XML” (domyślny to „Tylko podgląd”).
    wzor: /w formacie jej programu|pobieranie w uniwersalnym CSV|faktury w PDF|listę faktur za wybrany okres|w wybranym formacie|Twoja księgowa pobiera dokumenty/i,
    co: 'portal księgowego: CSV, PDF, format programu i lista za okres',
  },
  {
    // process-ocr wstawia wydatek z is_reviewed=false i domyślnym is_deductible=true.
    wzor: /sprawdzasz odczytane dane|Sprawdź odczytane dane i zapisz|zanim zapiszesz koszt|wypełnia formularz kosztu|gdy KSeF przyjmie fakturę albo zapiszesz koszt/i,
    co: 'odczyt ze zdjęcia: przegląd przed wpisem do KPiR',
  },
  {
    // canManageBilling wpuszcza administratora, changeMembershipRoleAction wymaga właściciela.
    wzor: /nie rozliczeniami|z wyjątkiem rozliczeń|Właściciel i administrator zmieniają role/i,
    co: 'role: administrator bez rozliczeń, role zmieniane przez administratora',
  },
  { wzor: /sam wybierasz kolumny/i, co: 'uniwersalny CSV z wyborem kolumn' },
  {
    wzor: /danych fakturowych poza UE/i,
    co: 'dane poza UE: Anthropic (USA) i Resend (USA lub UE) dostają zdjęcia i e-maile',
  },
  { wzor: /dodatkowe firmy/i, co: 'dopłata za dodatkowe firmy jako wada konkurencji (u nas też cena za firmę)' },
  { wzor: /nie stracić dostępu do funkcji/i, co: 'utrata dostępu przy nieudanej płatności (nic nie sprawdza subskrypcji)' },
  {
    // Bez FAKTFLOW_OPERATOR_TENANT_ID runSelfInvoicePayment kończy się skipped, a usługodawca
    // formalnie jeszcze nie istnieje (lib/legal/entity.ts).
    wzor: /faktura VAT co miesiąc|faktur\w* za FaktWay|Za (samą )?subskrypcję dostajesz fakturę|własnym systemem|po każdej udanej płatności/i,
    co: 'faktura VAT za abonament',
  },
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
  const roboty = walk(join(ROOT, 'public')).filter((p) => TEKSTY_W_PUBLIC.test(p));
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

  it('bez obietnic, które kod spełnia inaczej (recenzja #355)', () => {
    expect(trafienia(ROZBIEZNE_Z_KODEM)).toEqual([]);
  });
});

describe('treści opisują to, co robi kod (recenzja #355)', () => {
  const czytaj = (sciezka: string) => readFileSync(join(ROOT, sciezka), 'utf8');
  const FAQ = czytaj('app/(home)/_components/sections.tsx');

  it('certyfikat: FAQ i pomoc mówią, jaki klucz działa przy wgrywaniu plików', () => {
    // uploadCertificateAction importuje klucz tylko jako PKCS#8 RSA, bez pola hasła.
    for (const tekst of [FAQ, czytaj('content/help/konfiguracja-certyfikatu-ksef.mdx')]) {
      expect(tekst).toContain('PKCS#8');
      expect(tekst).toContain('bez hasła');
    }
  });

  it('cena jest za jedną firmę (NIP): karta na stronie głównej i w cenniku', () => {
    expect(FAQ).toContain('za jedną firmę (NIP)');
    expect(czytaj('app/(marketing)/pricing/page.tsx')).toContain('za jedną firmę (NIP)');
  });

  it('FAQ mówi, że odczyt ze zdjęcia i e-maile idą do dostawców spoza UE, i odsyła do listy', () => {
    expect(FAQ).toContain('spoza UE');
    expect(FAQ).toContain('Podmioty przetwarzające');
  });

  it.each([
    ['content/help/portal-ksiegowego.mdx', ['100 najnowszych', 'Tylko podgląd', 'Podgląd + pobieranie XML']],
    ['content/help/role-i-uprawnienia.mdx', ['Księgowy', 'tylko właściciel']],
    ['content/help/eksport-kpir-dla-ksiegowego.mdx', ['stały układ kolumn']],
    ['content/help/skanowanie-paragonow-ocr.mdx', ['od razu', 'Do opisania']],
  ])('%s: opis zgodny z kodem', (plik, fragmenty) => {
    const tresc = czytaj(plik);
    for (const fragment of fragmenty) expect(tresc, fragment).toContain(fragment);
  });
});

describe('jedno zdanie oferty', () => {
  it('brzmi tak, jak zdecydował Bartosz, z ceną z lib/billing/pricing.ts', () => {
    expect(OFERTA).toBe(
      `Faktury z KSeF, koszty i należności w jednym programie, także w telefonie, za ${PRICE_GROSS} miesięcznie.`,
    );
    expect(OFERTA).not.toContain('\u00a0');
  });

  it('nagłówek to to samo zdanie, różnią się tylko twarde spacje', () => {
    const naglowek = `${OFERTA_NAGLOWEK.przed}${OFERTA_NAGLOWEK.wyroznienie}${OFERTA_NAGLOWEK.po}`;
    expect(naglowek).toBe(OFERTA_TEKST);
    expect(naglowek.replaceAll('\u00a0', ' ')).toBe(OFERTA);
    expect(OFERTA_TEKST).toContain(PRICE_GROSS.replace(' ', '\u00a0'));
  });

  it('opisy meta strony głównej, cennika, układu, manifestu i obrazka to to samo zdanie', () => {
    expect(homeMetadata.description).toBe(OFERTA);
    expect(pricingMetadata.description).toBe(OFERTA);
    expect(manifest().description).toBe(OFERTA);
    // app/layout.tsx ciągnie next/font, a opengraph-image next/og: tu wystarczy tekst pliku.
    expect(readFileSync(join(ROOT, 'app/layout.tsx'), 'utf8')).toContain('description: OFERTA,');
    expect(readFileSync(join(ROOT, 'app/opengraph-image.tsx'), 'utf8')).toContain('export const alt = OFERTA;');
  });

  it('cennik pokazuje to samo zdanie pod nagłówkiem', () => {
    expect(renderToStaticMarkup(createElement(PricingPage))).toContain(OFERTA_TEKST);
  });

  it('nikt nie przepisał zdania ręcznie: jest tylko w lib/marketing/oferta.ts', () => {
    const kopie = plikiPubliczne()
      .filter((p) => rel(p) !== 'lib/marketing/oferta.ts')
      .filter((p) => /koszty i należności/.test(readFileSync(p, 'utf8')))
      .map(rel);
    expect(kopie).toEqual([]);
  });

  it('metoda płatności stoi w jednym miejscu, reszta bierze ją z modułu', () => {
    expect(METODA_PLATNOSCI).toContain('karta');
    expect(PROBA).toBe(`${TRIAL_DAYS} dni za darmo, ${METODA_PLATNOSCI}`);
    const wzor = /kart[aęy]\s+(przy starcie|na starcie|podajesz)|kartę\s+podajesz/i;
    const kopie = plikiPubliczne()
      .filter((p) => rel(p) !== 'lib/marketing/oferta.ts')
      .filter((p) => wzor.test(CZY_KOD.test(p) ? bezKomentarzy(readFileSync(p, 'utf8')) : readFileSync(p, 'utf8')))
      .map(rel);
    expect(kopie).toEqual([]);
  });
});

describe('porównania /vs/*: kolumna FaktWay zgodna z kodem', () => {
  // Strony są wyłączone flagą (app/(marketing)/vs/layout.tsx), więc tylko test
  // pokazuje, że się renderują i że nie wrócą z funkcjami, których nie ma.
  it.each([
    ['inFakt', VsInfakt],
    ['wFirma', VsWfirma],
    ['iFirma', VsIfirma],
    ['Inni', VsInni],
  ])('%s: renderuje się bez AI jako wyróżnika', (nazwa, Strona) => {
    const html = renderToStaticMarkup(createElement(Strona));
    expect(html).toContain(nazwa);
    const tekst = tekstBezZnacznikow(html);
    expect(tekst).not.toMatch(/\bAI\b|\bflo\b|asystent|\bagent|Claude|Frankfurt|[—–]/i);
  });

  it('funkcje wstrzymane w kodzie nie mają „tak” w kolumnie FaktWay', () => {
    const wstrzymane = /feature: '(Tryb Offline24[^']*|Korekta jednym klikiem|Offline mode|Offline queue dokumentów|Webhooks[^']*|Import gross z zagranicy[^']*)',\s*ksefSaas: \{ status: '(\w+)'/g;
    for (const strona of ['infakt', 'wfirma', 'ifirma', 'inni']) {
      const zrodlo = readFileSync(join(ROOT, `app/(marketing)/vs/${strona}/page.tsx`), 'utf8');
      for (const [, funkcja, status] of zrodlo.matchAll(wstrzymane)) {
        expect(status, `${strona}: ${funkcja}`).toBe('no');
      }
    }
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
