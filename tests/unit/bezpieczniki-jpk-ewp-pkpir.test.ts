import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KODY_JPK_EWP, sprawdzJpkEwp } from '@/lib/bezpieczniki/jpk-ewp';
import { KODY_JPK_PKPIR, sprawdzJpkPkpir } from '@/lib/bezpieczniki/jpk-pkpir';
import { STAWKI_JPK_EWP_PB, zbudujEwidencje, type FakturaEwidencji, type WierszEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { generujJpkEwp } from '@/lib/ksiegowosc/jpk-ewp';
import { validateJpkEwp, validateJpkPkpir } from '@/lib/ksiegowosc/jpk-ewp-walidator';
import { generujJpkPkpir } from '@/lib/ksiegowosc/jpk-pkpir';
import { KOLUMNY_KPIR, wierszeKpirOkresu, zbudujKpir, type KosztKpir, type WierszKpir } from '@/lib/ksiegowosc/kpir';
import { spisyPliku, type SpisyPliku } from '@/lib/ksiegowosc/spis-z-natury';

import { dzien, nip, profil } from '../filtr/generatory/ksiegowosc';

/**
 * Strażnicy JPK_EWP(4) i JPK_PKPIR(3) (żelazny filtr F13 część 3, plan
 * B4.10; D-F7: w module księgowości blokada od razu). Sumy kontrolne gotowego
 * pliku według opisów pól w schematach MF, po XSD, przed pobraniem.
 *
 * 1. Złote pliki (`tests/filtr/zlote-pliki/jpk-ewp4.xml`, `jpk-pkpir3.xml`)
 *    przechodzą, a ich kopie z jedną zmianą (liczba wierszy, kwota w wierszu
 *    bez zmiany sumy, suma kontrolna) dają alarm z właściwym kodem.
 * 2. Straż przed fałszywą odmową: pliki z generatorów na losowych danych
 *    (wzorem `tests/filtr/xsd/jpk-pit.test.ts`, do tego kwoty ujemne, wiersze
 *    KPiR z kwotami w kilku kolumnach naraz, B+R, spis z natury, wpisy
 *    ręczne i okres do dowolnego miesiąca) przechodzą bez alarmu, a zmiana
 *    o grosz albo o jeden w losowym pliku daje alarm z właściwym kodem.
 * 3. Wpięcie: XML zgodny z XSD z rozjechaną sumą (podmieniony wynik
 *    generatora) nie trafia do klienta i nie ma audytu pobrania; zwykła
 *    ścieżka bez zmian. Atrapy jak w `ksiegowosc-ewidencja-akcje.test.ts`
 *    i `ksiegowosc-kpir-akcje.test.ts`; generatory, XSD i strażnicy prawdziwi.
 */

const { wiersze: EWP01, przychody: EWP02 } = KODY_JPK_EWP;
const { wiersze: PKPIR01, przychody: PKPIR02, razemPrzychod: PKPIR03, razemWydatki: PKPIR04 } = KODY_JPK_PKPIR;
const ODMOWA = (plik: 'JPK_EWP' | 'JPK_PKPIR', kod: string) =>
  `Plik ${plik} wstrzymany: kontrola spójności wykryła błąd po naszej stronie (${kod}). Zgłosiliśmy go. ` +
  'Jeśli urząd wyznaczył termin, przygotuj plik z księgową.';

const ZLOTE = join(__dirname, '..', 'filtr', 'zlote-pliki');
const ZLOTY_EWP = readFileSync(join(ZLOTE, 'jpk-ewp4.xml'), 'utf8');
const ZLOTY_PKPIR = readFileSync(join(ZLOTE, 'jpk-pkpir3.xml'), 'utf8');

const mocks = vi.hoisted(() => ({
  requireOrgRole: vi.fn(),
  audit: vi.fn(),
  sentryWyjatek: vi.fn(),
  sentryKomunikat: vi.fn(),
  ewidencja: null as unknown,
  kpir: null as unknown,
  /** Atrapa błędu w generatorze: podmienia gotowy XML; domyślnie bez zmian. */
  podmiana: (xml: string) => xml,
  /** Ostatni XML z generatora (po podmianie). */
  ostatni: '',
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.sentryWyjatek, captureMessage: mocks.sentryKomunikat }));
vi.mock('@/lib/format/warsaw-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/format/warsaw-date')>()),
  todayInWarsaw: () => '2027-01-15',
}));
vi.mock('@/lib/supabase/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/auth-context')>()),
  requireOrgRole: mocks.requireOrgRole,
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({
  czyKsiegowoscWlaczona: async () => ({ wlaczony: true }),
  statusObszaru: () => ({ wlaczony: true }),
}));
vi.mock('@/lib/ksiegowosc/ewidencja-dane', () => ({ czytajEwidencje: async () => mocks.ewidencja }));
vi.mock('@/lib/ksiegowosc/kpir-dane', () => ({ czytajKpir: async () => mocks.kpir }));
vi.mock('@/lib/exports/tax-office', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/tax-office')>()),
  readTenantTaxOffice: async () => '1433',
}));
vi.mock('@/lib/ksiegowosc/jpk-ewp', async (orig) => {
  const m = await orig<typeof import('@/lib/ksiegowosc/jpk-ewp')>();
  return {
    ...m,
    generujJpkEwp: (dane: Parameters<typeof m.generujJpkEwp>[0]) => {
      mocks.ostatni = mocks.podmiana(m.generujJpkEwp(dane));
      return mocks.ostatni;
    },
  };
});
vi.mock('@/lib/ksiegowosc/jpk-pkpir', async (orig) => {
  const m = await orig<typeof import('@/lib/ksiegowosc/jpk-pkpir')>();
  return {
    ...m,
    generujJpkPkpir: (dane: Parameters<typeof m.generujJpkPkpir>[0]) => {
      mocks.ostatni = mocks.podmiana(m.generujJpkPkpir(dane));
      return mocks.ostatni;
    },
  };
});

const supabase = {
  from: (tabela: string) => {
    if (tabela !== 'tenants') throw new Error(`nieoczekiwana tabela ${tabela}`);
    return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { nip: '1234567890' }, error: null }) }) }) };
  },
};

const { pobierzJpkEwpAction, pobierzJpkPkpirAction } = await import('@/app/actions/ksiegowosc-ewidencja');

const ewp = (xml: string) => sprawdzJpkEwp(xml, '2026-12').map((a) => a.kod);
const pkpir = (xml: string) => sprawdzJpkPkpir(xml, '2026-12').map((a) => a.kod);

/** Jedna zmiana: tekst musi wystąpić w pliku dokładnie raz. */
function podmien(xml: string, z: string, na: string): string {
  expect(xml.split(z), z).toHaveLength(2);
  return xml.replace(z, na);
}

/** Kolejne zmiany w jednym pliku, każda jak w `podmien`. */
const zmiany = (xml: string, lista: ReadonlyArray<readonly [string, string]>) => lista.reduce((x, [z, na]) => podmien(x, z, na), xml);

const BEZ_KWOT = /(?<![_\d])\d{3,}|\d[.,]\d/;

describe('strażnik JPK_EWP(4): złoty plik i kopie z jedną zmianą', () => {
  it('złoty plik przechodzi bez alarmu', () => {
    expect(sprawdzJpkEwp(ZLOTY_EWP, '2026-12')).toEqual([]);
  });

  it.each<[string, string, string, string[]]>([
    ['LiczbaWierszy o jeden większa', '<LiczbaWierszy>4</', '<LiczbaWierszy>5</', [EWP01]],
    ['LiczbaWierszy o jeden mniejsza', '<LiczbaWierszy>4</', '<LiczbaWierszy>3</', [EWP01]],
    ['K_8 w wierszu o grosz, SumaPrzychodow bez zmiany', '<K_8>1234.56</K_8>', '<K_8>1234.57</K_8>', [EWP02]],
    ['K_8 korekty bez minusa, SumaPrzychodow bez zmiany', '<K_8>-200.00</K_8>', '<K_8>200.00</K_8>', [EWP02]],
    ['SumaPrzychodow inna niż suma K_8', '<SumaPrzychodow>6035.55</', '<SumaPrzychodow>6035.54</', [EWP02]],
  ])('%s', (_opis, z, na, oczekiwane) => {
    expect(ewp(podmien(ZLOTY_EWP, z, na))).toEqual(oczekiwane);
  });

  it('wiersz usunięty albo powtórzony: liczba wierszy i suma, oba kody po kolei', () => {
    const ostatni = [...ZLOTY_EWP.matchAll(/<EWPWiersz>[\s\S]*?<\/EWPWiersz>/g)].map((m) => m[0]).at(-1) ?? '';
    expect(ostatni).toContain('<K_8>0.99</K_8>');
    expect(ewp(podmien(ZLOTY_EWP, ostatni, ''))).toEqual([EWP01, EWP02]);
    expect(ewp(podmien(ZLOTY_EWP, ostatni, `${ostatni}${ostatni}`))).toEqual([EWP01, EWP02]);
  });

  it('brak EWPCtrl albo jego pól, pole dwa razy, pole bez kwoty i plik bez XML też dają alarm', () => {
    expect(ewp(ZLOTY_EWP.replace(/<EWPCtrl>[\s\S]*?<\/EWPCtrl>/, ''))).toEqual([EWP01, EWP02]);
    expect(ewp(podmien(ZLOTY_EWP, '<LiczbaWierszy>4</LiczbaWierszy>', ''))).toEqual([EWP01]);
    expect(ewp(podmien(ZLOTY_EWP, '<SumaPrzychodow>6035.55</SumaPrzychodow>', ''))).toEqual([EWP02]);
    expect(ewp(podmien(ZLOTY_EWP, '<SumaPrzychodow>6035.55</SumaPrzychodow>', '<SumaPrzychodow>6035.55</SumaPrzychodow>'.repeat(2)))).toEqual([EWP02]);
    expect(ewp(podmien(ZLOTY_EWP, '<SumaPrzychodow>6035.55</', '<SumaPrzychodow>abc</'))).toEqual([EWP02]);
    expect(ewp(podmien(ZLOTY_EWP, '<K_8>0.99</K_8>', '<K_8>0,99</K_8>'))).toEqual([EWP02]);
    expect(ewp(podmien(ZLOTY_EWP, '<K_8>0.99</K_8>', '<K_8>0.991</K_8>'))).toEqual([EWP02]);
    expect(ewp(podmien(ZLOTY_EWP, '<K_8>0.99</K_8>', '<K_8></K_8>'))).toEqual([EWP02]);
    expect(ewp(podmien(ZLOTY_EWP, '<LiczbaWierszy>4</', '<LiczbaWierszy>cztery</'))).toEqual([EWP01]);
    expect(ewp(podmien(ZLOTY_EWP, '<LiczbaWierszy>4</', '<LiczbaWierszy>4.0</'))).toEqual([EWP01]);
    expect(ewp('to nie jest XML')).toEqual([EWP01, EWP02]);
    expect(ewp('')).toEqual([EWP01, EWP02]);
  });
});

describe('strażnik JPK_PKPIR(3): złoty plik i kopie z jedną zmianą', () => {
  it('złoty plik przechodzi bez alarmu', () => {
    expect(sprawdzJpkPkpir(ZLOTY_PKPIR, '2026-12')).toEqual([]);
  });

  it.each<[string, Array<[string, string]>, string[]]>([
    ['LiczbaWierszy o jeden większa', [['<LiczbaWierszy>6</', '<LiczbaWierszy>7</']], [PKPIR01]],
    ['LiczbaWierszy o jeden mniejsza', [['<LiczbaWierszy>6</', '<LiczbaWierszy>5</']], [PKPIR01]],
    ['SumaPrzychodow inna niż suma K_9', [['<SumaPrzychodow>9975.00</', '<SumaPrzychodow>9975.01</']], [PKPIR02]],
    [
      'korekta bez minusa w K_7 i K_9 (wiersz zgodny), SumaPrzychodow bez zmiany',
      [['<K_7>-100.00</K_7>', '<K_7>100.00</K_7>'], ['<K_9>-100.00</K_9>', '<K_9>100.00</K_9>']],
      [PKPIR02],
    ],
    ['K_7 w wierszu o grosz, K_9 bez zmiany', [['<K_7>10000.00</K_7>', '<K_7>10000.01</K_7>']], [PKPIR03]],
    ['K_8 w wierszu, K_9 bez zmiany', [['<K_8>75.00</K_8>', '<K_8>75.50</K_8>']], [PKPIR03]],
    ['K_9 inne niż K_7 plus K_8: wiersz i suma kontrolna', [['<K_9>75.00</K_9>', '<K_9>75.01</K_9>']], [PKPIR02, PKPIR03]],
    ['K_9 brak przy K_7', [['<K_9>10000.00</K_9>', '']], [PKPIR02, PKPIR03]],
    ['K_13 w wierszu o grosz, K_14 bez zmiany', [['<K_13>2000.00</K_13>', '<K_13>2000.01</K_13>']], [PKPIR04]],
    ['K_14 inne niż K_12 plus K_13', [['<K_14>500.00</K_14>', '<K_14>499.99</K_14>']], [PKPIR04]],
    ['K_12 dopisane, K_14 bez zmiany', [['<K_13>2000.00</K_13>', '<K_12>100.00</K_12><K_13>2000.00</K_13>']], [PKPIR04]],
    ['K_14 brak przy K_13', [['<K_14>2000.00</K_14>', '']], [PKPIR04]],
    [
      'SumaPrzychodow2 bez kwot K_9A w wierszach',
      [['<SumaPrzychodow>9975.00</SumaPrzychodow>', '<SumaPrzychodow>9975.00</SumaPrzychodow><SumaPrzychodow2>1.00</SumaPrzychodow2>']],
      [PKPIR02],
    ],
    ['K_9A w wierszu bez SumaPrzychodow2', [['<K_9>75.00</K_9>', '<K_9>75.00</K_9><K_9A>50.00</K_9A>']], [PKPIR02]],
  ])('%s', (_opis, lista, oczekiwane) => {
    expect(pkpir(zmiany(ZLOTY_PKPIR, lista))).toEqual(oczekiwane);
  });

  it('K_9 to K_7 plus K_8, K_14 to K_12 plus K_13, także gdy w wierszu są obie kolumny (opisy pól)', () => {
    const obiePrzychodu = zmiany(ZLOTY_PKPIR, [
      ['<K_9>10000.00</K_9>', '<K_8>25.00</K_8><K_9>10025.00</K_9>'],
      ['<SumaPrzychodow>9975.00</', '<SumaPrzychodow>10000.00</'],
    ]);
    expect(pkpir(obiePrzychodu)).toEqual([]);
    expect(pkpir(podmien(obiePrzychodu, '<K_9>10025.00</K_9>', '<K_9>10000.00</K_9>'))).toEqual([PKPIR02, PKPIR03]);
    const obieWydatkow = zmiany(ZLOTY_PKPIR, [
      ['<K_13>2000.00</K_13>', '<K_12>150.00</K_12><K_13>2000.00</K_13>'],
      ['<K_14>2000.00</K_14>', '<K_14>2150.00</K_14>'],
    ]);
    expect(pkpir(obieWydatkow)).toEqual([]);
  });

  it('SumaPrzychodow2 to suma K_9A; pole nieobowiązkowe, bez niego 0 (opis pola)', () => {
    const doSumy2 = (kwota: string) => ['<SumaPrzychodow>9975.00</SumaPrzychodow>', `<SumaPrzychodow>9975.00</SumaPrzychodow><SumaPrzychodow2>${kwota}</SumaPrzychodow2>`] as const;
    const zK9A = ['<K_9>75.00</K_9>', '<K_9>75.00</K_9><K_9A>50.00</K_9A>'] as const;
    expect(pkpir(zmiany(ZLOTY_PKPIR, [zK9A, doSumy2('50.00')]))).toEqual([]);
    expect(pkpir(zmiany(ZLOTY_PKPIR, [doSumy2('0.00')]))).toEqual([]);
    expect(pkpir(zmiany(ZLOTY_PKPIR, [zK9A, doSumy2('49.99')]))).toEqual([PKPIR02]);
  });

  it('kolumny bez wzoru w opisie (K_10, K_16B) i PKPIRInfo („wg objaśnień”) poza strażnikiem: bez alarmu', () => {
    for (const [z, na] of [
      ['<K_10>300.00</K_10>', '<K_10>300.01</K_10>'],
      ['<K_16B>500.00</K_16B>', '<K_16B>400.00</K_16B>'],
      ['<P_3>2800.00</P_3>', '<P_3>2800.01</P_3>'],
      ['<P_4>7175.00</P_4>', '<P_4>7175.01</P_4>'],
    ] as const) {
      expect(pkpir(podmien(ZLOTY_PKPIR, z, na)), z).toEqual([]);
    }
  });

  it('brak PKPIRCtrl, pole dwa razy, pole bez kwoty i plik bez XML też dają alarm', () => {
    expect(pkpir(ZLOTY_PKPIR.replace(/<PKPIRCtrl>[\s\S]*?<\/PKPIRCtrl>/, ''))).toEqual([PKPIR01, PKPIR02]);
    expect(pkpir(podmien(ZLOTY_PKPIR, '<SumaPrzychodow>9975.00</', '<SumaPrzychodow>9975,00</'))).toEqual([PKPIR02]);
    expect(pkpir(podmien(ZLOTY_PKPIR, '<K_7>10000.00</K_7>', '<K_7>abc</K_7>'))).toEqual([PKPIR03]);
    expect(pkpir(podmien(ZLOTY_PKPIR, '<K_9>75.00</K_9>', '<K_9>7.5e1</K_9>'))).toEqual([PKPIR02, PKPIR03]);
    expect(pkpir(podmien(ZLOTY_PKPIR, '<K_13>2000.00</K_13>', '<K_13>2000.00</K_13>'.repeat(2)))).toEqual([PKPIR04]);
    expect(pkpir('to nie jest XML')).toEqual([PKPIR01, PKPIR02]);
  });
});

describe('alarmy obu strażników', () => {
  it('rodzaj ewidencja albo kpir, miesiąc z wywołania, opis bez kwot', () => {
    const zleEwp = [
      podmien(ZLOTY_EWP, '<SumaPrzychodow>6035.55</', '<SumaPrzychodow>6035.56</'),
      podmien(ZLOTY_EWP, '<LiczbaWierszy>4</', '<LiczbaWierszy>5</'),
      podmien(ZLOTY_EWP, '<LiczbaWierszy>4</', '<LiczbaWierszy>cztery</'),
      podmien(ZLOTY_EWP, '<K_8>0.99</K_8>', '<K_8>0,99</K_8>'),
      'to nie jest XML',
    ];
    const zlePkpir = [
      podmien(ZLOTY_PKPIR, '<LiczbaWierszy>6</', '<LiczbaWierszy>7</'),
      podmien(ZLOTY_PKPIR, '<K_9>75.00</K_9>', '<K_9>7.5e1</K_9>'),
      podmien(ZLOTY_PKPIR, '<K_14>500.00</K_14>', '<K_14>499.99</K_14>'),
      podmien(ZLOTY_PKPIR, '<K_13>2000.00</K_13>', '<K_13>abc</K_13>'),
      podmien(ZLOTY_PKPIR, '<SumaPrzychodow>9975.00</SumaPrzychodow>', '<SumaPrzychodow>9975.00</SumaPrzychodow><SumaPrzychodow2>1.00</SumaPrzychodow2>'),
      'to nie jest XML',
    ];
    const alarmy = [...zleEwp.flatMap((x) => sprawdzJpkEwp(x, '2026-06')), ...zlePkpir.flatMap((x) => sprawdzJpkPkpir(x, '2026-06'))];
    expect(alarmy.length).toBeGreaterThanOrEqual(zleEwp.length + zlePkpir.length);
    for (const a of alarmy) {
      expect(a.miesiac).toBe('2026-06');
      expect(a.rodzaj).toBe(a.kod.startsWith('FILTR-RT-EWP-') ? 'ewidencja' : 'kpir');
      // Bez kwot: żadnej liczby z trzema cyframi i więcej poza nazwą pola i żadnej z groszami.
      expect(a.opis, a.opis).not.toMatch(BEZ_KWOT);
    }
  });
});

const hex = (n: number) => fc.array(fc.constantFrom(...'0123456789ABCDEF'), { minLength: n, maxLength: n }).map((z) => z.join(''));
const numerKsef = fc.tuple(nip, dzien(2026), hex(6), hex(6), hex(2)).map(([n, d, a, b, c]) => `${n}-${d.replace(/-/g, '')}-${a}-${b}-${c}`);
// Tekst z polskimi znakami i znakami specjalnymi XML (generator musi je zakodować).
const tekst = fc.stringMatching(/^[A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż &<>"'/.,-]{1,40}$/).filter((s) => s.trim().length > 0);
const kwotaZeZnakiem = fc.integer({ min: -50_000_000, max: 500_000_000 });
const kontrahent = fc.option(fc.tuple(fc.constantFrom('PL', 'DE', 'CZ'), nip), { nil: null });
const PODATNIK = { nip: '1234567890', imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01' };
const WYTWORZONO = new Date('2027-01-15T10:00:00Z');
/** Koniec okresu pliku: ostatni dzień miesiąca 2026 r. (plik zawsze od 1 stycznia). */
const koniecOkresu = fc.integer({ min: 1, max: 12 }).map((m) => new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10));
const cel = (koniec: string) => (koniec === '2026-12-31' ? 1 : 0);

const wierszEwp = fc.record({
  dataPrzychodu: dzien(2026),
  dowod: tekst,
  numerKsef: fc.option(numerKsef, { nil: null }),
  kontrahent,
  kwotaGr: kwotaZeZnakiem,
  stawkaPb: fc.constantFrom(...STAWKI_JPK_EWP_PB),
  uwagi: fc.option(tekst, { nil: null }),
});

// `size: 'max'` przy tablicach wierszy: bez tego fast-check daje najwyżej ok. 12 elementów mimo `maxLength`.
const plikEwp = fc.record({ wiersze: fc.array(wierszEwp, { minLength: 1, maxLength: 40, size: 'max' }), koniec: koniecOkresu }).map(({ wiersze, koniec }) =>
  generujJpkEwp({
    od: '2026-01-01',
    do: koniec,
    celZlozenia: cel(koniec),
    kodUrzedu: '1433',
    podatnik: PODATNIK,
    wiersze: [...wiersze]
      .sort((a, b) => a.dataPrzychodu.localeCompare(b.dataPrzychodu))
      .map(
        (w, i): WierszEwidencji => ({
          lp: i + 1,
          dataWpisu: w.dataPrzychodu,
          dataPrzychodu: w.dataPrzychodu,
          dowod: w.dowod,
          numerKsef: w.numerKsef,
          krajKontrahenta: w.kontrahent?.[0] ?? null,
          idKontrahenta: w.kontrahent?.[1] ?? null,
          kwotaGr: w.kwotaGr,
          stawkaPb: w.stawkaPb,
          uwagi: w.uwagi,
          zrodlo: { typ: 'faktura', id: `f${i}` },
        }),
      ),
    wytworzono: WYTWORZONO,
  }),
);

const kwotaKolumny = fc.oneof(fc.constant(0), kwotaZeZnakiem);
const kwotaNiezerowa = fc.tuple(fc.integer({ min: 1, max: 500_000_000 }), fc.boolean()).map(([k, minus]) => (minus ? -k : k));
const kwotyKpir = (kwota: fc.Arbitrary<number>) => fc.record({ k7: kwota, k8: kwota, k10: kwota, k11: kwota, k12: kwota, k13: kwota });

const wierszKpir = (kwoty: fc.Arbitrary<WierszKpir['kwoty']>) =>
  fc
    .record({
      data: dzien(2026),
      dowod: tekst,
      numerKsef: fc.option(numerKsef, { nil: null }),
      kontrahent,
      nazwa: tekst,
      adres: tekst,
      opis: tekst,
      kwoty,
      br: fc.option(fc.record({ opis: tekst, kwotaGr: fc.integer({ min: 1, max: 100_000_000 }) }), { nil: null }),
      uwagi: fc.option(tekst, { nil: null }),
    })
    .map(
      (w): Omit<WierszKpir, 'lp'> => ({
        data: w.data,
        dowod: w.dowod,
        numerKsef: w.numerKsef,
        krajKontrahenta: w.kontrahent?.[0] ?? null,
        idKontrahenta: w.kontrahent?.[1] ?? null,
        nazwaKontrahenta: w.nazwa,
        adresKontrahenta: w.adres,
        opis: w.opis,
        kwoty: w.kwoty,
        br: w.br,
        uwagi: w.uwagi,
        zrodlo: { typ: 'koszt', id: 'k' },
      }),
    );

const spisPliku = fc
  .record({
    poczatekGr: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 100_000_000 })),
    koniecGr: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 100_000_000 })),
    wTrakcie: fc.array(fc.record({ data: dzien(2026), kwotaGr: fc.integer({ min: 0, max: 100_000_000 }) }), { maxLength: 3 }),
  })
  .map(
    ({ poczatekGr, koniecGr, wTrakcie }): SpisyPliku => ({
      poczatekGr,
      poczatekZ: poczatekGr > 0 ? '2025-12-31' : null,
      koniecGr,
      koniecZ: koniecGr > 0 ? '2026-12-31' : null,
      wTrakcie: wTrakcie.map((s, i) => ({ id: `s${i}`, data: s.data, kwotaGr: s.kwotaGr, opis: null })),
    }),
  );

function plikPkpir(wiersze: ReadonlyArray<Omit<WierszKpir, 'lp'>>, koniec: string, spis: SpisyPliku): string {
  return generujJpkPkpir({
    od: '2026-01-01',
    do: koniec,
    celZlozenia: cel(koniec),
    kodUrzedu: '1433',
    podatnik: PODATNIK,
    wiersze: wiersze.map((w, i) => ({ ...w, lp: i + 1 })),
    spis,
    wytworzono: WYTWORZONO,
  });
}

/** JPK_PKPIR z wierszy podanych wprost: kwoty w dowolnych kolumnach naraz, ze znakiem albo zero. */
const plikPkpirZWierszy = fc
  .record({ wiersze: fc.array(wierszKpir(kwotyKpir(kwotaKolumny)), { minLength: 1, maxLength: 30, size: 'max' }), koniec: koniecOkresu, spis: spisPliku })
  .map(({ wiersze, koniec, spis }) => plikPkpir(wiersze, koniec, spis));

/** Jak wyżej, ale pierwszy wiersz ma kwotę w każdej kolumnie, więc każde pole kwoty jest w pliku. */
const plikPkpirPelny = fc
  .record({
    pierwszy: wierszKpir(kwotyKpir(kwotaNiezerowa)),
    reszta: fc.array(wierszKpir(kwotyKpir(kwotaKolumny)), { maxLength: 20, size: 'max' }),
    koniec: koniecOkresu,
    spis: spisPliku,
  })
  .map(({ pierwszy, reszta, koniec, spis }) => plikPkpir([pierwszy, ...reszta], koniec, spis));

/** JPK_PKPIR z księgi jak w aplikacji (wzorem testu filtra): faktury i korekty, koszty, wpisy ręczne, spis z natury. */
const fakturaKpir = fc.record({
  data: dzien(2026),
  nettoGr: fc.integer({ min: 1, max: 300_000_000 }),
  korekta: fc.boolean(),
  numerKsef: fc.option(numerKsef, { nil: null }),
  nazwa: tekst,
  adres: fc.option(tekst, { nil: null }),
  identyfikator: fc.option(nip, { nil: null }),
});
const kosztKpir = fc.record({
  data: dzien(2026),
  kwotaGr: fc.integer({ min: -2_000_000, max: 100_000_000 }),
  kolumna: fc.constantFrom('col_10', 'col_11', 'col_12', 'col_13', 'col_15', 'col_16'),
  opis: tekst,
});
const wpisKpir = fc.record({
  data: dzien(2026),
  kolumna: fc.constantFrom(...KOLUMNY_KPIR),
  kwotaGr: fc.integer({ min: -5_000_000, max: 50_000_000 }).filter((k) => k !== 0),
  opis: fc.option(tekst, { nil: null }),
});
const spisy = fc.uniqueArray(
  fc.record({ data: fc.oneof(fc.constant('2025-12-31'), fc.constant('2026-12-31'), dzien(2026)), kwotaGr: fc.integer({ min: 0, max: 100_000_000 }) }),
  { maxLength: 4, selector: (s) => s.data },
);

const plikPkpirZKsiegi = fc
  .record({
    faktury: fc.array(fakturaKpir, { minLength: 1, maxLength: 15, size: 'max' }),
    koszty: fc.array(kosztKpir, { maxLength: 15, size: 'max' }),
    wpisy: fc.array(wpisKpir, { maxLength: 6 }),
    spisy,
    koniec: koniecOkresu,
  })
  .map(({ faktury, koszty, wpisy, spisy: spisyRoku, koniec }) => {
    const kpir = zbudujKpir({
      rok: 2026,
      // Pierwsza faktura w styczniu: każdy okres pliku ma co najmniej jeden wiersz.
      faktury: faktury.map(
        (f, i): FakturaEwidencji => ({
          id: `f${i}`,
          numer: `FV/${i + 1}/2026`,
          dataWystawienia: i === 0 ? '2026-01-15' : f.data,
          dataSprzedazy: i === 0 ? '2026-01-15' : f.data,
          rodzaj: f.korekta ? 'korekta' : 'zwykla',
          nettoGr: f.korekta ? -f.nettoGr : f.nettoGr,
          waluta: 'PLN',
          numerKsef: f.numerKsef,
          fp: false,
          kontrahent: { kraj: 'PL', identyfikator: f.identyfikator, nazwa: f.nazwa, adres: f.adres },
          rozliczoneZaliczkiGr: 0,
          pozycje: null,
        }),
      ),
      koszty: koszty.map(
        (k, i): KosztKpir => ({
          id: `k${i}`,
          data: k.data,
          dowod: `FZ/${i + 1}`,
          numerKsef: null,
          kontrahent: { nazwa: 'Dostawca', adres: 'ul. Krzywa 2, Kraków', kraj: 'PL', identyfikator: '5260001246' },
          opis: k.opis,
          kolumnaAplikacji: k.kolumna,
          kwotaGr: k.kwotaGr,
        }),
      ),
      wpisy: wpisy.map((w, i) => ({ id: `w${i}`, data: w.data, dokument: `NOTA/${i + 1}`, kolumna: w.kolumna, kwotaGr: w.kwotaGr, opis: w.opis })),
      wersje: [profil({ forma: 'skala', stawkaDomyslna: null })],
      kursy: new Map(),
    });
    const spis = spisyPliku(
      spisyRoku.map((s, i) => ({ id: `s${i}`, data: s.data, kwotaGr: s.kwotaGr, opis: null })),
      '2026-01-01',
      koniec,
    );
    return generujJpkPkpir({
      od: '2026-01-01',
      do: koniec,
      celZlozenia: cel(koniec),
      kodUrzedu: '1433',
      podatnik: PODATNIK,
      wiersze: wierszeKpirOkresu(kpir, '2026-01-01', koniec),
      spis,
      wytworzono: WYTWORZONO,
    });
  });

/** Pierwsze wystąpienie pola przesunięte o grosz (kwoty) albo o jeden (liczba wierszy). */
function przesun(xml: string, pole: string): string {
  const wzor = new RegExp(`<${pole}>(-?)(\\d+)(?:\\.(\\d{2}))?</${pole}>`);
  const m = wzor.exec(xml);
  if (!m) throw new Error(`brak pola ${pole}`);
  const [, znak, calosc, grosze] = m;
  if (grosze === undefined) return xml.replace(wzor, `<${pole}>${(znak ? -1 : 1) * Number(calosc) + 1}</${pole}>`);
  const gr = (znak ? -1 : 1) * (Number(calosc) * 100 + Number(grosze)) + 1;
  const tekstKwoty = `${gr < 0 ? '-' : ''}${Math.floor(Math.abs(gr) / 100)}.${String(Math.abs(gr) % 100).padStart(2, '0')}`;
  return xml.replace(wzor, `<${pole}>${tekstKwoty}</${pole}>`);
}

const PRZESUNIECIA_EWP: Array<[string, string[]]> = [
  ['LiczbaWierszy', [EWP01]],
  ['SumaPrzychodow', [EWP02]],
  ['K_8', [EWP02]],
];

const PRZESUNIECIA_PKPIR: Array<[string, string[]]> = [
  ['LiczbaWierszy', [PKPIR01]],
  ['SumaPrzychodow', [PKPIR02]],
  ['K_7', [PKPIR03]],
  ['K_8', [PKPIR03]],
  ['K_9', [PKPIR02, PKPIR03]],
  ['K_12', [PKPIR04]],
  ['K_13', [PKPIR04]],
  ['K_14', [PKPIR04]],
];

describe('strażnicy na plikach z generatorów na losowych danych', () => {
  const ILE = 500;

  it.each<[string, fc.Arbitrary<string>, (xml: string) => string[]]>([
    ['JPK_EWP', plikEwp, ewp],
    ['JPK_PKPIR z wierszy (kwoty w kilku kolumnach, B+R, spis)', plikPkpirZWierszy, pkpir],
    ['JPK_PKPIR z księgi (faktury, korekty, koszty w kolumnach, wpisy ręczne, spis z natury)', plikPkpirZKsiegi, pkpir],
  ])(`%s: ${ILE} losowych plików bez alarmu (bez fałszywej odmowy)`, (_opis, plik, kodyPliku) => {
    let sprawdzone = 0;
    fc.assert(
      fc.property(plik, (xml) => {
        expect(kodyPliku(xml)).toEqual([]);
        sprawdzone += 1;
      }),
      { numRuns: ILE },
    );
    expect(sprawdzone).toBe(ILE);
  });

  it('próbka tych plików przechodzi oficjalny XSD (pliki jak z aplikacji, nie tylko dla strażnika)', async () => {
    for (const [plik, walidator] of [
      [plikEwp, validateJpkEwp],
      [plikPkpirZWierszy, validateJpkPkpir],
      [plikPkpirZKsiegi, validateJpkPkpir],
    ] as const) {
      await fc.assert(
        fc.asyncProperty(plik, async (xml) => {
          expect((await walidator(xml)).errors).toEqual([]);
        }),
        { numRuns: 15 },
      );
    }
  }, 120_000);

  it('zmiana o grosz albo o jeden w losowym pliku daje alarm z właściwym kodem', () => {
    fc.assert(
      fc.property(plikEwp, fc.constantFrom(...PRZESUNIECIA_EWP), (xml, [pole, kody]) => {
        expect(ewp(przesun(xml, pole))).toEqual(kody);
      }),
      { numRuns: 200 },
    );
    fc.assert(
      fc.property(plikPkpirPelny, fc.constantFrom(...PRZESUNIECIA_PKPIR), (xml, [pole, kody]) => {
        expect(pkpir(przesun(xml, pole))).toEqual(kody);
      }),
      { numRuns: 300 },
    );
  });
});

const FAKTURA: FakturaEwidencji = {
  id: 'f1',
  numer: 'FV/1/2026',
  dataWystawienia: '2026-03-10',
  dataSprzedazy: '2026-03-10',
  rodzaj: 'zwykla',
  nettoGr: 1_000_000,
  waluta: 'PLN',
  numerKsef: null,
  fp: false,
  kontrahent: { kraj: 'PL', identyfikator: '5252241585', nazwa: 'Klient', adres: 'Warszawa' },
  rozliczoneZaliczkiGr: 0,
  pozycje: null,
};

const KOSZT: KosztKpir = {
  id: 'k1',
  data: '2026-03-11',
  dowod: 'FZ/1',
  numerKsef: null,
  kontrahent: { nazwa: 'Dostawca', adres: 'Kraków', kraj: 'PL', identyfikator: '5260001246' },
  opis: 'Usługi',
  kolumnaAplikacji: 'col_13',
  kwotaGr: 200_000,
};

const RYCZALT = profil();
const SKALA = profil({ forma: 'skala', stawkaDomyslna: null });
const POBRANIE = { rok: 2026, doMiesiaca: 12, imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01' };

const ewpSuma = (xml: string) => podmien(xml, '<SumaPrzychodow>10000.00</SumaPrzychodow>', '<SumaPrzychodow>10000.01</SumaPrzychodow>');
const ewpLiczba = (xml: string) => podmien(xml, '<LiczbaWierszy>1</LiczbaWierszy>', '<LiczbaWierszy>2</LiczbaWierszy>');
const pkpirLiczba = (xml: string) => podmien(xml, '<LiczbaWierszy>2</LiczbaWierszy>', '<LiczbaWierszy>3</LiczbaWierszy>');
const pkpirSuma = (xml: string) => podmien(xml, '<SumaPrzychodow>10000.00</SumaPrzychodow>', '<SumaPrzychodow>10000.01</SumaPrzychodow>');
const pkpirK7 = (xml: string) => podmien(xml, '<K_7>10000.00</K_7>', '<K_7>10000.01</K_7>');
const pkpirK14 = (xml: string) => podmien(xml, '<K_14>2000.00</K_14>', '<K_14>2000.01</K_14>');

beforeEach(() => {
  mocks.requireOrgRole.mockReset().mockResolvedValue({ supabase, user: { id: 'u-1' }, tenantId: 'firma-1', role: 'owner' });
  for (const f of [mocks.audit, mocks.sentryWyjatek, mocks.sentryKomunikat]) f.mockReset();
  mocks.ewidencja = {
    ok: true,
    ewidencja: zbudujEwidencje({ rok: 2026, faktury: [FAKTURA], wpisy: [], wersje: [RYCZALT], kursy: new Map() }),
    wpisy: [],
    wersje: [RYCZALT],
  };
  mocks.kpir = {
    ok: true,
    kpir: zbudujKpir({ rok: 2026, faktury: [FAKTURA], koszty: [KOSZT], wpisy: [], wersje: [SKALA], kursy: new Map() }),
    wpisy: [],
    wersje: [SKALA],
    spisy: [],
  };
  mocks.podmiana = (xml) => xml;
  mocks.ostatni = '';
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('wpięcie w pobranie JPK_EWP i JPK_PKPIR: plik z błędem nie trafia do klienta', () => {
  it('atrapy dają XML zgodny z XSD, który strażnik zatrzymuje', async () => {
    for (const podmiana of [ewpSuma, ewpLiczba]) {
      mocks.podmiana = podmiana;
      await pobierzJpkEwpAction(POBRANIE);
      expect((await validateJpkEwp(mocks.ostatni)).errors).toEqual([]);
      expect(sprawdzJpkEwp(mocks.ostatni, '2026-12')).not.toEqual([]);
    }
    for (const podmiana of [pkpirLiczba, pkpirSuma, pkpirK7, pkpirK14]) {
      mocks.podmiana = podmiana;
      await pobierzJpkPkpirAction(POBRANIE);
      expect((await validateJpkPkpir(mocks.ostatni)).errors).toEqual([]);
      expect(sprawdzJpkPkpir(mocks.ostatni, '2026-12')).not.toEqual([]);
    }
  });

  it.each([
    ['SumaPrzychodow inna niż suma K_8', ewpSuma, EWP02],
    ['LiczbaWierszy inna niż liczba wierszy', ewpLiczba, EWP01],
  ])('JPK_EWP: %s daje odmowę z kodem i alarm, bez pliku i bez audytu pobrania', async (_opis, podmiana, kod) => {
    mocks.podmiana = podmiana;
    expect(await pobierzJpkEwpAction(POBRANIE)).toEqual({ success: false, error: ODMOWA('JPK_EWP', kod) });
    expect(mocks.sentryKomunikat).toHaveBeenCalledWith(
      expect.stringContaining(kod),
      expect.objectContaining({
        level: 'error',
        tags: { area: 'filtr.bezpieczniki', straznik: 'jpk-ewp', kod, rodzaj: 'ewidencja', miesiac: '2026-12', tenantId: 'firma-1' },
        fingerprint: [kod, 'ewidencja', '2026-12'],
      }),
    );
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    ['LiczbaWierszy inna niż liczba wierszy', pkpirLiczba, PKPIR01],
    ['SumaPrzychodow inna niż suma K_9', pkpirSuma, PKPIR02],
    ['K_9 inne niż K_7 plus K_8', pkpirK7, PKPIR03],
    ['K_14 inne niż K_12 plus K_13', pkpirK14, PKPIR04],
  ])('JPK_PKPIR: %s daje odmowę z kodem i alarm, bez pliku i bez audytu pobrania', async (_opis, podmiana, kod) => {
    mocks.podmiana = podmiana;
    expect(await pobierzJpkPkpirAction(POBRANIE)).toEqual({ success: false, error: ODMOWA('JPK_PKPIR', kod) });
    expect(mocks.sentryKomunikat).toHaveBeenCalledWith(
      expect.stringContaining(kod),
      expect.objectContaining({
        level: 'error',
        tags: { area: 'filtr.bezpieczniki', straznik: 'jpk-pkpir', kod, rodzaj: 'kpir', miesiac: '2026-12', tenantId: 'firma-1' },
        fingerprint: [kod, 'kpir', '2026-12'],
      }),
    );
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('plik za część roku: w alarmie miesiąc końca okresu pliku', async () => {
    mocks.podmiana = ewpSuma;
    expect(await pobierzJpkEwpAction({ ...POBRANIE, doMiesiaca: 6 })).toEqual({ success: false, error: ODMOWA('JPK_EWP', EWP02) });
    expect(mocks.sentryKomunikat).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ fingerprint: [EWP02, 'ewidencja', '2026-06'] }));
    mocks.podmiana = pkpirK14;
    expect(await pobierzJpkPkpirAction({ ...POBRANIE, doMiesiaca: 3 })).toEqual({ success: false, error: ODMOWA('JPK_PKPIR', PKPIR04) });
    expect(mocks.sentryKomunikat).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ fingerprint: [PKPIR04, 'kpir', '2026-03'] }));
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('zwykła ścieżka bez zmian: oba pliki pobrane z audytem, bez alarmu', async () => {
    const plikEwpWynik = await pobierzJpkEwpAction(POBRANIE);
    expect(plikEwpWynik).toMatchObject({ success: true, nazwa: 'JPK_EWP_1234567890_2026-01-01_2026-12-31.xml' });
    expect(plikEwpWynik.success && plikEwpWynik.xml).toBe(mocks.ostatni);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'jpk_ewp.downloaded' }));

    const plikPkpirWynik = await pobierzJpkPkpirAction(POBRANIE);
    expect(plikPkpirWynik).toMatchObject({ success: true, nazwa: 'JPK_PKPIR_1234567890_2026-01-01_2026-12-31.xml' });
    expect(plikPkpirWynik.success && plikPkpirWynik.xml).toBe(mocks.ostatni);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'jpk_pkpir.downloaded' }));
    expect(mocks.sentryKomunikat).not.toHaveBeenCalled();
  });
});
