import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { generateAdvanceInvoiceXml } from '@/lib/ksef/fa3-advance-generator';
import {
  ADVANCE_DESCRIPTION_MAX,
  ADVANCE_LINE_NAME_PREFIX,
  DB_TEXT_LIMITS,
  FA3_TEXT_LIMITS,
  InvoiceXmlSchemaError as BladGranic,
  isXmlSafe,
  liczbaZnakow,
  xsdLength,
  type Fa3TextKind,
} from '@/lib/xml/fa3-limits';
import { InvoiceXmlSchemaError } from '@/lib/xml/validator';

import { OPCJE, zaliczka } from './dane';

/**
 * C1: jeden moduł granic tekstu FA(3) (`lib/xml/fa3-limits.ts`) i jego
 * zgodność ze schematem. Granice czytamy wprost z plików XSD w repo, więc
 * nowa wersja schematu z inną granicą zaczerwieni ten test, zamiast cicho
 * rozjechać formularz z XSD. Granica bazy (jednostka miary) jest osobno,
 * z migracji.
 */

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const czytaj = (p: string) => readFileSync(join(REPO, p), 'utf8');

const FA3 = czytaj('lib/xml/schemas/fa3/schemat-local.xsd');
const ETD =
  czytaj('lib/xml/schemas/fa3/ElementarneTypyDanych_v10-0E.xsd') +
  czytaj('lib/xml/schemas/fa3/StrukturyDanych_v10-0E.xsd');

// ─── Czytnik typów prostych XSD (tylko indexOf, bez wyrażeń z danych) ───────

type TypXsd = { typ: string; max: number | undefined; rodzaj: Fa3TextKind | undefined; wolnyTekst: boolean };

/** Wartość `value` pierwszego `<znacznik value="…">` we fragmencie. */
function wartosc(fragment: string, znacznik: string): string | undefined {
  const otwarcie = `<${znacznik} value="`;
  const i = fragment.indexOf(otwarcie);
  if (i < 0) return undefined;
  const s = i + otwarcie.length;
  return fragment.slice(s, fragment.indexOf('"', s));
}

/** Wartość atrybutu w znaczniku otwierającym. */
function atrybut(znacznik: string, nazwa: string): string | undefined {
  const szukane = ` ${nazwa}="`;
  const i = znacznik.indexOf(szukane);
  if (i < 0) return undefined;
  const s = i + szukane.length;
  return znacznik.slice(s, znacznik.indexOf('"', s));
}

/**
 * Typ z `<xsd:restriction>`: granica (własna albo po typie bazowym), sposób
 * liczenia białych znaków (`whiteSpace` albo typ bazowy) i czy to wolny tekst
 * (łańcuch bez wzorca i bez listy wartości).
 */
function zRestrykcji(def: string, typ: string): TypXsd | undefined {
  const r = def.indexOf('<xsd:restriction ');
  if (r < 0) return undefined;
  const baza = atrybut(def.slice(r, def.indexOf('>', r) + 1), 'base');
  if (!baza) return undefined;
  let wynik: TypXsd;
  if (baza === 'xsd:token') wynik = { typ, max: undefined, rodzaj: 'token', wolnyTekst: true };
  else if (baza === 'xsd:string') wynik = { typ, max: undefined, rodzaj: 'string', wolnyTekst: true };
  else if (baza === 'xsd:normalizedString') wynik = { typ, max: undefined, rodzaj: 'replace', wolnyTekst: true };
  else if (baza.startsWith('xsd:')) wynik = { typ, max: undefined, rodzaj: undefined, wolnyTekst: false };
  else {
    const rodzic = typProsty(baza);
    if (!rodzic) return undefined;
    wynik = { ...rodzic, typ };
  }
  const max = wartosc(def, 'xsd:maxLength');
  if (max !== undefined) wynik.max = Number(max);
  const bialeZnaki = wartosc(def, 'xsd:whiteSpace');
  if (bialeZnaki === 'collapse') wynik.rodzaj = 'token';
  if (bialeZnaki === 'replace') wynik.rodzaj = 'replace';
  if (bialeZnaki === 'preserve') wynik.rodzaj = 'string';
  if (def.includes('<xsd:pattern') || def.includes('<xsd:enumeration')) wynik.wolnyTekst = false;
  return wynik;
}

/** Nazwany typ prosty (`tns:` ze schematu FA(3), `etd:` z typów MF); złożony albo nieznany: `undefined`. */
function typProsty(ref: string): TypXsd | undefined {
  const dwukropek = ref.indexOf(':');
  const ns = ref.slice(0, dwukropek);
  const zrodlo = ns === 'tns' ? FA3 : ns === 'etd' ? ETD : undefined;
  if (zrodlo === undefined) return undefined;
  const i = zrodlo.indexOf(`<xsd:simpleType name="${ref.slice(dwukropek + 1)}"`);
  if (i < 0) return undefined;
  return zRestrykcji(zrodlo.slice(i, zrodlo.indexOf('</xsd:simpleType>', i)), ref);
}

/** Typ każdej deklaracji elementu w schemacie FA(3); typ anonimowy nazywa się po typie bazowym. */
function typyElementu(el: string): Array<TypXsd | undefined> {
  const wynik: Array<TypXsd | undefined> = [];
  const szukane = `<xsd:element name="${el}"`;
  for (let i = FA3.indexOf(szukane); i >= 0; i = FA3.indexOf(szukane, i + 1)) {
    const otwarcie = FA3.slice(i, FA3.indexOf('>', i) + 1);
    const typ = atrybut(otwarcie, 'type');
    if (typ) {
      wynik.push(typProsty(typ));
      continue;
    }
    if (otwarcie.endsWith('/>')) {
      wynik.push(undefined);
      continue;
    }
    const cialo = FA3.slice(i, FA3.indexOf('</xsd:element>', i));
    const prosty = cialo.indexOf('<xsd:simpleType>');
    const zlozony = cialo.indexOf('<xsd:complexType');
    if (prosty < 0 || (zlozony >= 0 && zlozony < prosty)) {
      wynik.push(undefined);
      continue;
    }
    const def = cialo.slice(prosty, cialo.indexOf('</xsd:simpleType>', prosty));
    const r = def.indexOf('<xsd:restriction ');
    const baza = r < 0 ? undefined : atrybut(def.slice(r, def.indexOf('>', r) + 1), 'base');
    wynik.push(baza ? zRestrykcji(def, baza) : undefined);
  }
  return wynik;
}

// ─── Moduł a schemat ────────────────────────────────────────────────────────

describe('C1: moduł granic zgadza się ze schematem FA(3)', () => {
  it('czytnik XSD widzi typy, na których stoi reszta testu', () => {
    expect(typProsty('tns:TZnakowy512')).toEqual({ typ: 'tns:TZnakowy512', max: 512, rodzaj: 'token', wolnyTekst: true });
    expect(typProsty('etd:TTekstowy')).toEqual({ typ: 'etd:TTekstowy', max: 3500, rodzaj: 'string', wolnyTekst: true });
    expect(typyElementu('NrID')).toEqual([
      { typ: 'etd:TNrIdentyfikacjiPodatkowej', max: 50, rodzaj: 'replace', wolnyTekst: true },
      { typ: 'etd:TNrIdentyfikacjiPodatkowej', max: 50, rodzaj: 'replace', wolnyTekst: true },
    ]);
    expect(typyElementu('NIP')[0]?.wolnyTekst).toBe(false);
  });

  const wpisy = Object.entries(FA3_TEXT_LIMITS).flatMap(([klucz, g]) =>
    g.elements.map((el) => ({ klucz, el, xsdType: g.xsdType, max: g.max, kind: g.kind })),
  );

  it.each(wpisy)('$klucz: <$el> ma w XSD typ $xsdType, granicę $max i liczenie „$kind”', ({ el, xsdType, max, kind }) => {
    const typy = typyElementu(el);
    expect(typy.length).toBeGreaterThan(0);
    for (const t of typy) {
      expect(t && { typ: t.typ, max: t.max, rodzaj: t.rodzaj }).toEqual({ typ: xsdType, max, rodzaj: kind });
    }
  });

  /** Elementy z wolnym tekstem w XSD, których moduł świadomie nie pilnuje, i dlaczego. */
  const BEZ_GRANICY: Record<string, string> = {
    SystemInfo: 'stała nazwa systemu z generatora',
    Klucz: 'stałe klucze DodatkowyOpis z generatora',
    Wartosc:
      'kwoty i daty z generatora; dane paragonu sprawdza receiptInvoiceIssues (numer najwyżej 100 znaków, numer kasy wzorem)',
    OpisPlatnosci: 'stałe słowa z generatora (inna, kompensata)',
    P_8AZ: 'stała jednostka „szt.” w zamówieniu na fakturze zaliczkowej',
    NrRB: 'format rachunku sprawdza validateIban (zwykła, przelew) albo formularz (26 cyfr: KOR, ZAL, ROZ)',
    GLN: 'nic w aplikacji nie ustawia address.gln (pole jest tylko w typie)',
    Telefon: 'nic w aplikacji nie ustawia seller.phone (import daje undefined)',
  };
  const GENERATORY = ['lib/xml/fa3-generator.ts', 'lib/ksef/fa3-correction-generator.ts', 'lib/ksef/fa3-advance-generator.ts'];

  it('każdy element z wolnym tekstem z generatorów ma granicę w module albo powód w BEZ_GRANICY', () => {
    const pilnowane = new Set<string>(Object.values(FA3_TEXT_LIMITS).flatMap((g) => [...g.elements]));
    const emitowane = new Set<string>();
    for (const p of GENERATORY) {
      for (const m of czytaj(p).matchAll(/\.ele\('([A-Za-z0-9_]+)'\)/g)) emitowane.add(m[1]!);
    }
    expect(emitowane.size).toBeGreaterThan(50);
    const bezGranicy = [...emitowane].filter(
      (el) => typyElementu(el).some((t) => t?.wolnyTekst) && !pilnowane.has(el) && !(el in BEZ_GRANICY),
    );
    expect(bezGranicy).toEqual([]);
    expect(Object.keys(BEZ_GRANICY).filter((el) => !emitowane.has(el) || pilnowane.has(el))).toEqual([]);
  });
});

// ─── Liczenie znaków jak XSD ────────────────────────────────────────────────

describe('C1: xsdLength liczy jak walidator XSD (sprawdzone na xmllint)', () => {
  const a = (n: number) => 'a'.repeat(n);
  it.each<[string, string, Fa3TextKind, number]>([
    ['512 liter', a(512), 'token', 512],
    ['podwójna spacja zwija się do jednej', `${a(256)}  ${a(255)}`, 'token', 512],
    ['spacja na początku znika', ` ${a(512)}`, 'token', 512],
    ['tabulator i nowa linia to spacje', 'a\tb\nc', 'token', 5],
    ['twarda spacja (NBSP) zostaje', ' a', 'token', 2],
    ['emoji to jeden znak', `${a(511)}\u{1F600}`, 'token', 512],
    ['same spacje to zero', '   ', 'token', 0],
    ['CR w środku to spacja', `${a(256)}\r${a(256)}`, 'token', 513],
    ['CRLF to jeden znak (parser XML)', 'a\r\nb', 'string', 3],
    ['samo CR to jeden znak', 'a\rb', 'string', 3],
    ['same spacje w string liczą się', '   ', 'string', 3],
    ['replace: tabulator to spacja', 'a\tb', 'replace', 3],
    ['replace nie obcina brzegów', '  a  ', 'replace', 5],
  ])('%s', (_opis, wartoscPola, rodzaj, dlugosc) => {
    expect(xsdLength(wartoscPola, rodzaj)).toBe(dlugosc);
  });
});

describe('C1: isXmlSafe odrzuca znaki, których XML 1.0 nie przyjmie', () => {
  it.each(['Zażółć gęślą jaźń\t\n\r', 'Emoji \u{1F600}', 'DEL\u007F'])('przyjmuje %j', (v) => {
    expect(isXmlSafe(v)).toBe(true);
  });
  it.each(['\u000B', '\u0000', '\u001F', '￾', '￿', 'a\uD800', '\uDC00b'])('odrzuca %j', (v) => {
    expect(isXmlSafe(v)).toBe(false);
  });
});

describe('C1: liczbaZnakow odmienia po polsku', () => {
  it.each<[number, string]>([
    [1, '1 znak'],
    [2, '2 znaki'],
    [5, '5 znaków'],
    [12, '12 znaków'],
    [0, '0 znaków'],
    [112, '112 znaków'],
    [114, '114 znaków'],
    [22, '22 znaki'],
    [124, '124 znaki'],
    [502, '502 znaki'],
    [512, '512 znaków'],
    [3500, '3500 znaków'],
  ])('%i', (n, tekstLiczby) => {
    expect(liczbaZnakow(n)).toBe(tekstLiczby);
  });
});

// ─── Granice spoza XSD ──────────────────────────────────────────────────────

describe('C1: granice bazy i przedrostek zaliczki', () => {
  it('jednostka miary: formularz pilnuje kolumny invoice_line_items.unit, a XSD (P_8A) ma 256', () => {
    const sql = czytaj('supabase/migrations/00001_initial_schema.sql');
    const start = sql.indexOf('CREATE TABLE public.invoice_line_items (');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(sql.slice(start, sql.indexOf(');', start))).toContain(`unit VARCHAR(${DB_TEXT_LIMITS.lineUnit})`);
    expect(DB_TEXT_LIMITS.lineUnit).toBe(50);
    expect(FA3_TEXT_LIMITS.p8a.max).toBe(256);
  });

  it('ZAL: P_7 to przedrostek i opis, więc opis ma 512 minus przedrostek', () => {
    expect(ADVANCE_LINE_NAME_PREFIX).toBe('Zaliczka: ');
    expect(ADVANCE_DESCRIPTION_MAX).toBe(FA3_TEXT_LIMITS.p7.max - ADVANCE_LINE_NAME_PREFIX.length);
    expect(ADVANCE_DESCRIPTION_MAX).toBe(502);
    const xml = generateAdvanceInvoiceXml(zaliczka({ description: 'Projekt strony' }), OPCJE);
    expect(xml).toContain(`<P_7>${ADVANCE_LINE_NAME_PREFIX}Projekt strony</P_7>`);
  });
});

// ─── Jedno źródło ───────────────────────────────────────────────────────────

const plikiKodu = (katalog: string) =>
  (readdirSync(join(REPO, katalog), { recursive: true, encoding: 'utf8' }) as string[])
    .map((p) => `${katalog}/${p.replaceAll('\\', '/')}`)
    .filter((p) => /\.(ts|tsx|mjs)$/.test(p));

describe('C1: granice mają jedno źródło', () => {
  it('wyrażenie na znaki sterujące jest tylko w module granic', () => {
    const kopie = ['lib', 'components', 'app']
      .flatMap(plikiKodu)
      .filter((p) => /u000e-\\u001f/i.test(czytaj(p)));
    expect(kopie).toEqual(['lib/xml/fa3-limits.ts']);
  });

  it.each([
    'lib/validators/invoice-validators.ts',
    'lib/schemas/invoice-form.ts',
    'lib/schemas/company-profile.ts',
    'lib/contractors/edit.ts',
    'lib/invoices/receipt-invoice.ts',
    'lib/xml/fa3-generator.ts',
    'lib/ksef/fa3-correction-generator.ts',
    'lib/ksef/fa3-advance-generator.ts',
  ])('%s bierze granice z modułu', (p) => {
    expect(czytaj(p)).toContain("from '@/lib/xml/fa3-limits'");
  });

  it('moduł nie importuje kodu ani node:, bo trafia też do paczki przeglądarki (formularze)', () => {
    const zrodlo = czytaj('lib/xml/fa3-limits.ts');
    expect(zrodlo).not.toMatch(/^import (?!type )/m);
    expect(zrodlo).not.toContain("'node:");
  });

  it('validator.ts oddaje tę samą klasę błędu, więc kod XSD_INVALID i stan rejected się nie zmieniają', () => {
    expect(InvoiceXmlSchemaError).toBe(BladGranic);
    const e = new BladGranic(['Uwagi: za długie']);
    expect(e.name).toBe('InvoiceXmlSchemaError');
    expect(e.message).toMatch(/schematem XSD/);
    expect(e.errors).toEqual(['Uwagi: za długie']);
  });
});
