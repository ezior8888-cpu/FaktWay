import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KODY_JPK_V7M, sprawdzJpkV7m, type KodJpkV7m } from '@/lib/bezpieczniki/jpk-v7m';
import type { ExportExpense } from '@/lib/exports/data-fetcher';
import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { generateJpkV7m } from '@/lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';
import { vatMiesiaca } from '@/lib/ksiegowosc/vat';

/**
 * Strażnik JPK_V7M(3) (żelazny filtr F13 część 2, plan B4.10; D-F7: w module
 * księgowości blokada od razu). Sumy kontrolne i deklaracja gotowego pliku
 * według opisów pól w schemacie MF, po XSD, przed pobraniem i wysyłką.
 *
 * 1. Złoty plik (`tests/filtr/zlote-pliki/jpk-v7m3.xml`) przechodzi, a jego
 *    kopia z jedną zmianą daje alarm z właściwym kodem.
 * 2. Straż przed fałszywą odmową: pliki z generatora na losowych danych
 *    (wzorem `tests/filtr/xsd/jpk-v7m.test.ts`, do tego „np”, „np II”,
 *    korekta deklaracji i osoba fizyczna) przechodzą bez alarmu, a ta sama
 *    zmiana o grosz albo złoty w losowym pliku daje alarm.
 * 3. Wpięcie: XML zgodny z XSD z rozjechaną sumą (podmieniony wynik
 *    generatora) nie trafia do klienta ani do bramki MF; zwykła ścieżka bez
 *    zmian. Atrapy jak w `ksiegowosc-vat-akcje.test.ts`, generator, XSD
 *    i strażnik prawdziwe.
 */

const { wiersze: JPK01, nalezny: JPK02, naliczony: JPK03, deklaracja: JPK04, zEwidencja: JPK05 } = KODY_JPK_V7M;
const ODMOWA = (kod: string) =>
  `Plik JPK_V7M wstrzymany: kontrola spójności wykryła błąd po naszej stronie (${kod}). Zgłosiliśmy go. ` +
  'Termin złożenia się nie przesuwa, więc w razie potrzeby złóż plik z księgową.';

const ZLOTY = readFileSync(join(__dirname, '..', 'filtr', 'zlote-pliki', 'jpk-v7m3.xml'), 'utf8');
const ID = '00170170-0000-4000-8000-000000000001';
const NUMER = 'b7a0810e02818670000000b92c9f5343';

const mocks = vi.hoisted(() => ({
  requireOrgRole: vi.fn(),
  audit: vi.fn(),
  sentryWyjatek: vi.fn(),
  sentryKomunikat: vi.fn(),
  wyslij: vi.fn(),
  dane: null as unknown,
  /** Atrapa błędu w generatorze: podmienia gotowy XML; domyślnie bez zmian. */
  podmiana: (xml: string) => xml,
  /** Ostatni XML z generatora (po podmianie). */
  ostatni: '',
  zapisy: [] as string[],
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.sentryWyjatek, captureMessage: mocks.sentryKomunikat }));
vi.mock('@/lib/format/warsaw-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/format/warsaw-date')>()),
  todayInWarsaw: () => '2026-11-07',
}));
vi.mock('@/lib/supabase/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/auth-context')>()),
  requireOrgRole: mocks.requireOrgRole,
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({ czyKsiegowoscWlaczona: async () => ({ wlaczony: true }) }));
vi.mock('@/lib/ksiegowosc/vat-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/vat-dane')>()),
  czytajVat: async () => mocks.dane,
}));
vi.mock('@/lib/exports/tax-office', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/tax-office')>()),
  readTenantTaxOffice: async () => '1433',
}));
vi.mock('@/lib/storage/r2', () => ({ uploadToR2IfAbsent: vi.fn(), downloadFromR2: vi.fn() }));
vi.mock('@/lib/ksiegowosc/wysylka-jpk/wyslij', () => ({ wyslijJpk: mocks.wyslij }));
vi.mock('@/lib/exports/jpk-v7m-generator', async (orig) => {
  const m = await orig<typeof import('@/lib/exports/jpk-v7m-generator')>();
  return {
    ...m,
    generateJpkV7m: (dane: Parameters<typeof m.generateJpkV7m>[0]) => {
      mocks.ostatni = mocks.podmiana(m.generateJpkV7m(dane));
      return mocks.ostatni;
    },
  };
});

/** Łańcuch PostgREST: filtry zwracają łańcuch, wynik na końcu. */
function lancuch(wynik: () => unknown) {
  const l: Record<string, unknown> = {};
  for (const m of ['eq', 'in', 'lt', 'order', 'limit', 'select']) l[m] = () => l;
  l.single = async () => wynik();
  l.maybeSingle = async () => wynik();
  l.then = (ok: (v: unknown) => unknown, nie?: (e: unknown) => unknown) => Promise.resolve(wynik()).then(ok, nie);
  return l;
}

const supabase = {
  from: (tabela: string) => {
    if (tabela === 'tenants') return lancuch(() => ({ data: { nip: '1234567890', name: 'Jan Testowy' }, error: null }));
    if (tabela !== 'jpk_submissions') throw new Error(`nieoczekiwana tabela ${tabela}`);
    return {
      insert: () => {
        mocks.zapisy.push('insert');
        return lancuch(() => ({ data: { id: ID }, error: null }));
      },
      update: () => {
        mocks.zapisy.push('update');
        return lancuch(() => ({ data: [{ id: ID }], error: null }));
      },
    };
  },
};

const { pobierzJpkV7mAction, wyslijJpkV7mAction } = await import('@/app/actions/ksiegowosc-vat');

const kody = (xml: string) => sprawdzJpkV7m(xml, '2026-08').map((a) => a.kod);

/** Jedna zmiana: tekst musi wystąpić w pliku dokładnie raz. */
function podmien(xml: string, z: string, na: string): string {
  expect(xml.split(z), z).toHaveLength(2);
  return xml.replace(z, na);
}

describe('strażnik JPK_V7M(3): złoty plik i kopie z jedną zmianą', () => {
  it('złoty plik przechodzi bez alarmu', () => {
    expect(sprawdzJpkV7m(ZLOTY, '2026-08')).toEqual([]);
  });

  it.each<[string, KodJpkV7m, string, string]>([
    ['liczba wierszy sprzedaży', JPK01, '<LiczbaWierszySprzedazy>7</', '<LiczbaWierszySprzedazy>6</'],
    ['liczba wierszy zakupów', JPK01, '<LiczbaWierszyZakupow>4</', '<LiczbaWierszyZakupow>5</'],
    ['K_20 w wierszu, PodatekNalezny bez zmiany', JPK02, '<K_20>230.00</K_20>', '<K_20>230.40</K_20>'],
    ['PodatekNalezny inny niż suma wierszy', JPK02, '<PodatekNalezny>262.00</', '<PodatekNalezny>262.01</'],
    ['K_43 w wierszu, PodatekNaliczony bez zmiany', JPK03, '<K_43>46.00</K_43>', '<K_43>46.40</K_43>'],
    ['PodatekNaliczony inny niż suma wierszy', JPK03, '<PodatekNaliczony>172.50</', '<PodatekNaliczony>172.49</'],
    ['P_37 inne niż suma podstaw', JPK04, '<P_37>3900</P_37>', '<P_37>3901</P_37>'],
    ['P_38 inne niż suma P_16, P_18, P_20', JPK04, '<P_38>262</P_38>', '<P_38>263</P_38>'],
    ['P_48 inne niż P_39 plus P_43', JPK04, '<P_48>273</P_48>', '<P_48>272</P_48>'],
    ['P_51 sprzeczne z P_38 i P_48', JPK04, '<P_51>0</P_51>', '<P_51>5</P_51>'],
    ['P_53 inne niż nadwyżka P_48 nad P_38', JPK04, '<P_53>11</P_53>', '<P_53>12</P_53>'],
    ['P_62 inne niż P_53 minus P_54', JPK04, '<P_62>11</P_62>', '<P_62>10</P_62>'],
    ['P_49 przy P_38 nie większym od P_48', JPK04, '<P_48>273</P_48>', '<P_48>273</P_48><P_49>5</P_49>'],
    ['K_19 w wierszu: P_19 odbiega od ewidencji o więcej niż zaokrąglenie', JPK05, '<K_19>1000.00</K_19>', '<K_19>1001.00</K_19>'],
    ['K_42 w wierszu: P_42 odbiega od ewidencji o więcej niż zaokrąglenie', JPK05, '<K_42>1000.00</K_42>', '<K_42>1000.60</K_42>'],
  ])('%s: %s', (_opis, kod, z, na) => {
    const k = kody(podmien(ZLOTY, z, na));
    expect(k[0]).toBe(kod);
    expect([...new Set(k)]).toEqual([kod]);
  });

  // Pól P_49, P_50, P_52 i P_54 generator nie wypisuje, więc ich gałęzie wzorów sprawdzają tylko te przypadki.
  it('P_49 i P_50 w granicach: P_51 to P_38 minus P_48, P_49 i P_50 (komentarze pól)', () => {
    let x = podmien(ZLOTY, '<P_39>100</P_39>', '<P_39>0</P_39>');
    x = podmien(x, '<P_48>273</P_48>', '<P_48>173</P_48><P_49>50</P_49><P_50>20</P_50>');
    x = podmien(podmien(podmien(x, '<P_51>0</P_51>', '<P_51>19</P_51>'), '<P_53>11</P_53>', ''), '<P_62>11</P_62>', '');
    expect(kody(x)).toEqual([]);
    // P_38 - P_48 = 89: P_49 najwyżej 89, P_50 najwyżej 89 - P_49.
    expect(kody(podmien(x, '<P_49>50</P_49>', '<P_49>90</P_49>'))[0]).toBe(JPK04);
    expect(kody(podmien(x, '<P_50>20</P_50>', '<P_50>40</P_50>'))[0]).toBe(JPK04);
    expect(kody(podmien(x, '<P_51>19</P_51>', '<P_51>89</P_51>'))).toEqual([JPK04]);
  });

  it('P_50 dodatnie przy P_38 nie większym od P_48: alarm (komentarz pola)', () => {
    expect([...new Set(kody(podmien(ZLOTY, '<P_48>273</P_48>', '<P_48>273</P_48><P_50>5</P_50>')))]).toEqual([JPK04]);
  });

  it('P_52 wchodzi do P_53; P_54 odejmuje się od P_62 (komentarze pól)', () => {
    const zP52 = podmien(podmien(podmien(ZLOTY, '<P_51>0</P_51>', '<P_51>0</P_51><P_52>4</P_52>'), '<P_53>11</P_53>', '<P_53>15</P_53>'), '<P_62>11</P_62>', '<P_62>15</P_62>');
    expect(kody(zP52)).toEqual([]);
    expect(kody(podmien(zP52, '<P_53>15</P_53>', '<P_53>11</P_53>'))[0]).toBe(JPK04);
    const zP54 = podmien(podmien(ZLOTY, '<P_53>11</P_53>', '<P_53>11</P_53><P_54>11</P_54><P_55>1</P_55>'), '<P_62>11</P_62>', '');
    expect(kody(zP54)).toEqual([]);
    expect(kody(podmien(zP54, '<P_54>11</P_54>', '<P_54>4</P_54>'))).toEqual([JPK04]);
  });

  it('K_20 o złotówkę: najpierw suma kontrolna (JPK-02), potem deklaracja z ewidencją (JPK-05)', () => {
    expect(kody(podmien(ZLOTY, '<K_20>230.00</K_20>', '<K_20>231.00</K_20>'))).toEqual([JPK02, JPK05]);
  });

  it('różnica do 50 gr między P_ a sumą K_ to zaokrąglenie, nie alarm (P_43 173 przy 172,50)', () => {
    expect(kody(podmien(ZLOTY, '<K_42>1000.00</K_42>', '<K_42>1000.50</K_42>'))).toEqual([]);
  });

  it('wiersz FP: liczy się do liczby wierszy, ale nie do PodatekNalezny ani deklaracji (opis PodatekNalezny)', () => {
    const fp =
      '<SprzedazWiersz><LpSprzedazy>8</LpSprzedazy><NrKontrahenta>BRAK</NrKontrahenta><NazwaKontrahenta>Jan Nowak</NazwaKontrahenta>' +
      '<DowodSprzedazy>FS/8/08/2026</DowodSprzedazy><DataWystawienia>2026-08-05</DataWystawienia><BFK>1</BFK>' +
      '<TypDokumentu>FP</TypDokumentu><K_19>100.00</K_19><K_20>23.00</K_20></SprzedazWiersz><SprzedazCtrl>';
    const zFp = podmien(podmien(ZLOTY, '<SprzedazCtrl>', fp), '<LiczbaWierszySprzedazy>7</', '<LiczbaWierszySprzedazy>8</');
    expect(kody(zFp)).toEqual([]);
    expect(kody(podmien(zFp, '<PodatekNalezny>262.00</', '<PodatekNalezny>285.00</'))).toEqual([JPK02]);
  });

  it('brak sum kontrolnych, pole dwa razy, pole bez kwoty i plik bez XML też dają alarm', () => {
    const bezCtrl = ZLOTY.replace(/<SprzedazCtrl>[\s\S]*?<\/SprzedazCtrl>/, '');
    expect(kody(bezCtrl)).toEqual([JPK01, JPK02]);
    expect(kody(podmien(ZLOTY, '<P_38>262</P_38>', '<P_38>262</P_38><P_38>262</P_38>'))[0]).toBe(JPK04);
    expect(kody(podmien(ZLOTY, '<PodatekNalezny>262.00</', '<PodatekNalezny>abc</'))).toEqual([JPK02]);
    expect(kody(podmien(ZLOTY, '<K_20>230.00</K_20>', '<K_20>2,30</K_20>'))[0]).toBe(JPK02);
    expect(kody(ZLOTY.replace(/<Deklaracja>[\s\S]*<\/Deklaracja>/, ''))).toEqual([JPK04]);
    expect(kody(ZLOTY.replace(/<Ewidencja>[\s\S]*<\/Ewidencja>/, ''))).toEqual([JPK01]);
    expect(kody('to nie jest XML')).toEqual([JPK01, JPK04]);
  });

  it('alarm: rodzaj vat, miesiąc z wywołania, opis bez kwot', () => {
    const zle = podmien(podmien(ZLOTY, '<P_38>262</P_38>', '<P_38>263</P_38>'), '<PodatekNalezny>262.00</', '<PodatekNalezny>263.00</');
    const alarmy = sprawdzJpkV7m(zle, '2026-08');
    expect(alarmy.length).toBeGreaterThan(1);
    for (const a of alarmy) {
      expect(a).toMatchObject({ rodzaj: 'vat', miesiac: '2026-08' });
      // Bez kwot: żadnej liczby z trzema cyframi i więcej poza nazwą pola (K_360) i żadnej z groszami.
      expect(a.opis).not.toMatch(/(?<![_\d])\d{3,}|\d[.,]\d/);
    }
  });
});

type Stawka = '23' | '8' | '5' | '0' | 'zw' | 'np' | 'np_ii';
const STOPA: Record<Stawka, number> = { '23': 0.23, '8': 0.08, '5': 0.05, '0': 0, zw: 0, np: 0, np_ii: 0 };
const KSEF_SPRZEDAZ = '1234567890-20260805-0100001AF629-AF';
const KSEF_ZAKUP = '1234567890-20260806-0100001AF629-B0';
const zlote = (g: number) => Math.round(g) / 100;

const linia = fc.record({
  netto: fc.integer({ min: 0, max: 50_000_000 }),
  stawka: fc.constantFrom<Stawka>('23', '8', '5', '0', 'zw', 'np', 'np_ii'),
});

const faktura = fc
  .record({
    linie: fc.array(linia, { minLength: 1, maxLength: 4 }),
    korekta: fc.boolean(),
    konsument: fc.boolean(),
    ksef: fc.boolean(),
    dzien: fc.integer({ min: 1, max: 31 }),
  })
  .map(({ linie, korekta, konsument, ksef, dzien }) => {
    const znak = korekta ? -1 : 1;
    const lines = linie.map((l, i) => {
      const netAmount = zlote(znak * l.netto);
      return { position: i + 1, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: netAmount, netAmount, vatRate: l.stawka };
    });
    const netTotal = zlote(lines.reduce((a, l) => a + Math.round(l.netAmount * 100), 0));
    const vatTotal = zlote(lines.reduce((a, l) => a + Math.round(l.netAmount * STOPA[l.vatRate] * 100), 0));
    return {
      currency: 'PLN',
      invoiceType: korekta ? 'correction' : 'regular',
      issueDate: `2026-08-${String(dzien).padStart(2, '0')}`,
      buyerName: konsument ? 'Jan Kowalski' : 'Klient Sp. z o.o.',
      buyerNip: konsument ? undefined : '1234567890',
      netTotal,
      vatTotal,
      grossTotal: zlote(Math.round(netTotal * 100) + Math.round(vatTotal * 100)),
      ksefNumber: ksef ? KSEF_SPRZEDAZ : undefined,
      ...(korekta ? { correctedInvoiceNumber: 'FS/1/07' } : {}),
      lines,
    } as Omit<JpkInvoice, 'invoiceNumber'>;
  });

const koszt = fc
  .record({
    netto: fc.integer({ min: -2_000_000, max: 20_000_000 }),
    stawka: fc.constantFrom(0.23, 0.08, 0.05),
    odliczenie: fc.constantFrom(1, 0.5, 0),
    paragon: fc.boolean(),
    ksef: fc.boolean(),
    dzien: fc.integer({ min: 1, max: 31 }),
  })
  .map(({ netto, stawka, odliczenie, paragon, ksef, dzien }) => {
    const vat = Math.round(netto * stawka);
    return {
      issueDate: `2026-08-${String(dzien).padStart(2, '0')}`,
      documentType: paragon ? 'receipt' : 'invoice',
      sellerName: 'Dostawca Sp. z o.o.',
      sellerNip: '1234567890',
      sellerAddress: null,
      netAmount: zlote(netto),
      vatAmount: zlote(vat),
      grossAmount: zlote(netto + vat),
      vatDeductibleAmount: zlote(Math.round(vat * odliczenie)),
      kpirColumn: 'col_13',
      categoryLabel: 'Usługi',
      ksefNumber: ksef ? KSEF_ZAKUP : null,
    } as Omit<ExportExpense, 'id' | 'documentNumber'>;
  });

const okres = fc.record({
  sprzedaz: fc.array(faktura, { maxLength: 15 }),
  zakupy: fc.array(koszt, { maxLength: 10 }),
  nadwyzka: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 50_000 })),
  korektaDeklaracji: fc.boolean(),
  osoba: fc.boolean(),
});

type Okres = typeof okres extends fc.Arbitrary<infer T> ? T : never;

function plik({ sprzedaz, zakupy, nadwyzka, korektaDeklaracji, osoba }: Okres): string {
  return generateJpkV7m({
    issuer: {
      nip: '1234567890',
      name: 'Moja Firma Sp. z o.o.',
      email: 'biuro@example.test',
      taxOfficeCode: '1433',
      ...(osoba ? { naturalPerson: { firstName: 'Jan', lastName: 'Kowalski', birthDate: '1985-04-12' } } : {}),
    },
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    generatedAt: new Date('2026-09-10T10:00:00Z'),
    issuedInvoices: sprzedaz.map((f, i) => ({ ...f, invoiceNumber: `FS/${i + 1}/08` }) as JpkInvoice),
    expenses: zakupy.map((k, i) => ({ ...k, id: `exp-${i + 1}`, documentNumber: `FZ/${i + 1}/08` }) as ExportExpense),
    previousSurplus: nadwyzka,
    goal: korektaDeklaracji ? '2' : '1',
  });
}

/** Pole, które generator wypisuje zawsze, przesunięte o grosz (kwoty ewidencji) albo o jeden (liczby i złote). */
const PRZESUNIECIA: Array<[string, KodJpkV7m]> = [
  ['LiczbaWierszySprzedazy', JPK01],
  ['LiczbaWierszyZakupow', JPK01],
  ['PodatekNalezny', JPK02],
  ['PodatekNaliczony', JPK03],
  ['P_37', JPK04],
  ['P_38', JPK04],
  ['P_48', JPK04],
  ['P_51', JPK04],
];

function przesun(xml: string, pole: string): string {
  const wzor = new RegExp(`<${pole}>(-?)(\\d+)(?:\\.(\\d{2}))?</${pole}>`);
  const m = wzor.exec(xml);
  if (!m) throw new Error(`brak pola ${pole}`);
  const [, znak, calosc, grosze] = m;
  if (grosze === undefined) return xml.replace(wzor, `<${pole}>${(znak ? -1 : 1) * Number(calosc) + 1}</${pole}>`);
  const gr = (znak ? -1 : 1) * (Number(calosc) * 100 + Number(grosze)) + 1;
  const tekst = `${gr < 0 ? '-' : ''}${Math.floor(Math.abs(gr) / 100)}.${String(Math.abs(gr) % 100).padStart(2, '0')}`;
  return xml.replace(wzor, `<${pole}>${tekst}</${pole}>`);
}

describe('strażnik JPK_V7M(3): pliki z generatora na losowych danych', () => {
  const ILE = 500;

  it(`${ILE} losowych okresów bez alarmu (bez fałszywej odmowy)`, () => {
    let sprawdzone = 0;
    fc.assert(
      fc.property(okres, (o) => {
        expect(sprawdzJpkV7m(plik(o), '2026-08')).toEqual([]);
        sprawdzone += 1;
      }),
      { numRuns: ILE },
    );
    expect(sprawdzone).toBe(ILE);
  });

  it('zmiana o grosz albo o jeden w losowym pliku daje alarm z właściwym kodem', () => {
    fc.assert(
      fc.property(okres, fc.constantFrom(...PRZESUNIECIA), (o, [pole, kod]) => {
        expect([...new Set(kody(przesun(plik(o), pole)))]).toEqual([kod]);
      }),
      { numRuns: 200 },
    );
  });
});

const faktura10 = {
  invoiceNumber: 'FS/1/10',
  currency: 'PLN',
  invoiceType: 'regular',
  issueDate: '2026-10-05',
  buyerName: 'Klient',
  netTotal: 1000,
  vatTotal: 230,
  grossTotal: 1230,
  lines: [{ position: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 1000, netAmount: 1000, vatRate: '23' }],
} as JpkInvoice;

const OSOBA = { imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01', email: 'jan@example.test' };
const POBRANIE = { miesiac: '2026-10', nadwyzka: 0, ...OSOBA };
const WYSYLKA = { ...POBRANIE, kwotaGr: 5_432_198 };

const sumaRozjechana = (xml: string) => podmien(xml, '<PodatekNalezny>230.00</PodatekNalezny>', '<PodatekNalezny>231.00</PodatekNalezny>');
const p51Rozjechane = (xml: string) => podmien(xml, '<P_51>230</P_51>', '<P_51>229</P_51>');

beforeEach(() => {
  vi.stubEnv('JPK_MF_ENV', 'test');
  mocks.requireOrgRole.mockReset().mockResolvedValue({ supabase, user: { id: 'u-1', email: 'jan@example.test' }, tenantId: 'firma-1', role: 'owner' });
  for (const f of [mocks.audit, mocks.sentryWyjatek, mocks.sentryKomunikat, mocks.wyslij]) f.mockReset();
  mocks.wyslij.mockResolvedValue({ numerReferencyjny: NUMER, skrotPliku: 'x', duplikat: false });
  mocks.dane = {
    ok: true,
    miesiac: '2026-10',
    dane: { issuer: { nip: '1234567890', name: 'Jan Testowy' }, issuedInvoices: [faktura10], receivedInvoices: [], expenses: [] },
    nadwyzka: { zl: 0, zrodlo: 'klient' },
    wynik: vatMiesiaca({ sprzedaz: [faktura10], koszty: [] }, 0),
    wysylki: [],
  };
  mocks.podmiana = (xml) => xml;
  mocks.ostatni = '';
  mocks.zapisy = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('wpięcie w akcje VAT: plik z błędem nie trafia do klienta ani do MF', () => {
  it('atrapa daje XML zgodny z XSD, który strażnik zatrzymuje', async () => {
    for (const podmiana of [sumaRozjechana, p51Rozjechane]) {
      mocks.podmiana = podmiana;
      await pobierzJpkV7mAction(POBRANIE);
      expect((await validateJpkV7m(mocks.ostatni)).errors).toEqual([]);
      expect(sprawdzJpkV7m(mocks.ostatni, '2026-10')).not.toEqual([]);
    }
  });

  it.each([
    ['PodatekNalezny inny niż suma K_20', sumaRozjechana, JPK02],
    ['P_51 sprzeczne z P_38 i P_48', p51Rozjechane, JPK04],
  ])('pobranie: %s daje odmowę z kodem i alarm, bez pliku i bez audytu pobrania', async (_opis, podmiana, kod) => {
    mocks.podmiana = podmiana;
    expect(await pobierzJpkV7mAction(POBRANIE)).toEqual({ success: false, error: ODMOWA(kod) });
    expect(mocks.sentryKomunikat).toHaveBeenCalledWith(
      expect.stringContaining(kod),
      expect.objectContaining({
        level: 'error',
        tags: { area: 'filtr.bezpieczniki', straznik: 'jpk-v7m', kod, rodzaj: 'vat', miesiac: '2026-10', tenantId: 'firma-1' },
        fingerprint: [kod, 'vat', '2026-10'],
      }),
    );
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    ['PodatekNalezny inny niż suma K_20', sumaRozjechana, JPK02],
    ['P_51 sprzeczne z P_38 i P_48', p51Rozjechane, JPK04],
  ])('wysyłka: %s daje tę samą odmowę, bez wiersza w bazie i bez bramki MF', async (_opis, podmiana, kod) => {
    mocks.podmiana = podmiana;
    expect(await wyslijJpkV7mAction(WYSYLKA)).toEqual({ success: false, error: ODMOWA(kod) });
    expect(mocks.wyslij).not.toHaveBeenCalled();
    expect(mocks.zapisy).toEqual([]);
    expect(mocks.sentryKomunikat).toHaveBeenCalledWith(expect.stringContaining(kod), expect.objectContaining({ tags: expect.objectContaining({ straznik: 'jpk-v7m', kod }) }));
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('zwykła ścieżka bez zmian: plik pobrany i wysłany, bez alarmu', async () => {
    const pobrany = await pobierzJpkV7mAction(POBRANIE);
    expect(pobrany).toMatchObject({ success: true, nazwa: 'JPK_V7M_1234567890_2026-10.xml' });
    expect(pobrany.success && pobrany.xml).toBe(mocks.ostatni);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'jpk_v7m.downloaded' }));

    expect(await wyslijJpkV7mAction(WYSYLKA)).toEqual({ success: true, numer: NUMER, duplikat: false });
    expect(mocks.wyslij).toHaveBeenCalledTimes(1);
    expect(mocks.zapisy).toContain('insert');
    expect(mocks.sentryKomunikat).not.toHaveBeenCalled();
  });
});
