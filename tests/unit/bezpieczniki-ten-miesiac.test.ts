import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sprawdzTenMiesiac } from '@/lib/bezpieczniki/ten-miesiac';
import { zbudujEwidencje, type Ewidencja, type FakturaEwidencji, type WierszEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { zbudujKpir, type Kpir, type WpisKpir } from '@/lib/ksiegowosc/kpir';
import { ileOdlozyc } from '@/lib/ksiegowosc/odlozyc';
import { parametryRoku } from '@/lib/ksiegowosc/parametry';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { tenMiesiac, type Platnosc, type PozycjaMiesiaca, type RodzajRozliczenia, type WejscieMiesiaca, type WynikMiesiaca } from '@/lib/ksiegowosc/ten-miesiac';
import { czytajTenMiesiac, doZatwierdzenia } from '@/lib/ksiegowosc/ten-miesiac-dane';
import type { WynikVat } from '@/lib/ksiegowosc/vat';

/**
 * Strażnik „Ten miesiąc” (żelazny filtr F13, plan B4.10, D-F7: w module
 * księgowości blokada od razu). Ostatnia linia obrony: zła kwota nie dochodzi
 * do klienta nawet przy błędzie w silniku.
 *
 * 1. Każdy niezmiennik osobno: wynik z prawdziwego liczenia z jedną zepsutą
 *    liczbą daje brak z komunikatem i alarm z kodem, a pozostałe pozycje
 *    zostają te same.
 * 2. Straż przed fałszywym alarmem: scenariusze z testów „Ten miesiąc”
 *    (`ksiegowosc-ten-miesiac*.test.ts`) liczone prawdziwym silnikiem
 *    przechodzą bez zmian i bez alarmu.
 * 3. Wpięcie: `czytajTenMiesiac` (strona, zatwierdzenie, crony, „Odłóż na
 *    podatek”) zwraca brak zamiast kwoty z groszami w pozycji zaokrąglanej
 *    do złotych, a Sentry dostaje alarm bez kwot.
 */

const TEKST = 'Tej kwoty nie pokazujemy, bo kontrola spójności wykryła błąd po naszej stronie. Zgłosiliśmy go.';

const mocks = vi.hoisted(() => ({
  captureMessage: vi.fn(),
  /** false: sekcje parametrów potwierdzone (`brakujace` bez braków); true: prawdziwa bramka D7. */
  d7: false,
  ewidencja: null as unknown,
  vat: null as unknown,
}));

vi.mock('@sentry/nextjs', () => ({ captureMessage: mocks.captureMessage, captureException: vi.fn() }));
vi.mock('@/lib/ksiegowosc/parametry', async (orig) => {
  const prawdziwe = await orig<typeof import('@/lib/ksiegowosc/parametry')>();
  return {
    ...prawdziwe,
    brakujace: (...a: Parameters<typeof prawdziwe.brakujace>) => (mocks.d7 ? prawdziwe.brakujace(...a) : []),
  };
});
vi.mock('@/lib/ksiegowosc/ewidencja-dane', () => ({ czytajEwidencje: async () => mocks.ewidencja }));
vi.mock('@/lib/ksiegowosc/profil', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/profil')>()),
  czytajWersjeProfilu: async () => (mocks.ewidencja as { wersje?: unknown[] } | null)?.wersje ?? [],
}));
// Odczyt VAT ma własne testy (`ksiegowosc-vat-dane`); tu tylko kwoty, które z niego wychodzą.
vi.mock('@/lib/ksiegowosc/vat-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/vat-dane')>()),
  czytajVat: async () => mocks.vat ?? { ok: false, komunikat: 'Firma korzysta ze zwolnienia z VAT (art. 113), więc nie składa JPK_V7M.', zwolniona: true },
}));

// ---------------------------------------------------------------------------
// Dane wejściowe jak w `ksiegowosc-ten-miesiac.test.ts` i `ksiegowosc-ten-miesiac-dane.test.ts`

const PROFIL: WersjaProfilu = {
  id: 'p1',
  validFrom: '2026-01-01',
  forma: 'ryczalt',
  stawkaDomyslna: 1200,
  zusEtap: 'pelny',
  zusOd: null,
  chorobowe: true,
  nrsZus: null,
  najem: false,
};
// Preferencyjny ZUS: jego liczby na 2027 r. są znane (pełny czeka na prognozowane przeciętne wynagrodzenie).
const PREFERENCYJNY: WersjaProfilu = { ...PROFIL, zusEtap: 'preferencyjny', zusOd: '2026-01-01' };
const SKALA: WersjaProfilu = { ...PREFERENCYJNY, forma: 'skala', stawkaDomyslna: null };
const LINIOWY: WersjaProfilu = { ...PREFERENCYJNY, forma: 'liniowy', stawkaDomyslna: null };

function faktura(dzien: string, gr: number): FakturaEwidencji {
  return {
    id: `f-${dzien}-${gr}`,
    numer: `FV/${dzien}`,
    dataWystawienia: dzien,
    dataSprzedazy: dzien,
    rodzaj: 'zwykla',
    nettoGr: gr,
    waluta: 'PLN',
    numerKsef: null,
    fp: false,
    kontrahent: { kraj: null, identyfikator: null },
    rozliczoneZaliczkiGr: 0,
    pozycje: null,
  };
}

function wiersz(dzien: string, gr: number, stawkaPb = 1200): WierszEwidencji {
  return {
    lp: 0,
    dataWpisu: dzien,
    dataPrzychodu: dzien,
    dowod: `D/${dzien}/${gr}`,
    numerKsef: null,
    krajKontrahenta: null,
    idKontrahenta: null,
    kwotaGr: gr,
    stawkaPb,
    uwagi: null,
    zrodlo: { typ: 'wpis', id: `w-${dzien}-${gr}` },
  };
}

const ewidencjaZ = (rok: number, wiersze: WierszEwidencji[]): Ewidencja => ({ rok, wiersze, braki: [], pominiete: [], ryczaltWRoku: true });

function wejscie(z: Partial<WejscieMiesiaca> & { faktury?: FakturaEwidencji[] } = {}): WejscieMiesiaca {
  const wersje = z.wersje ?? [PROFIL];
  const ewidencja =
    z.ewidencja ??
    zbudujEwidencje({ rok: 2026, faktury: z.faktury ?? [faktura('2026-01-31', 1_500_000), faktura('2026-02-28', 1_500_000)], wpisy: [], wersje, kursy: new Map() });
  return { miesiac: '2026-02', ewidencja, wersje, platnosci: [], parametry: parametryRoku, ...z };
}

const zaplata = (miesiac: string, rodzaj: Platnosc['rodzaj'], kwotaGr: number, zaplaconeO: string, spoleczneBezFpGr = 0): Platnosc => ({
  miesiac,
  rodzaj,
  wersja: 1,
  kwotaGr,
  spoleczneBezFpGr,
  zaplaconeO,
});

/** Przychód 10 000 zł 15. dnia każdego miesiąca roku (wpis ręczny w kolumnie 7 KPiR). */
function kpirRoku(rok: number, wersje: WersjaProfilu[]): Kpir {
  const wpisy: WpisKpir[] = Array.from({ length: 12 }, (_, i) => ({
    id: `w-${rok}-${i + 1}`,
    data: `${rok}-${String(i + 1).padStart(2, '0')}-15`,
    dokument: `RK/${i + 1}`,
    kolumna: 'k7',
    kwotaGr: 1_000_000,
    opis: null,
  }));
  return zbudujKpir({ rok, faktury: [], koszty: [], wpisy, wersje, kursy: new Map() });
}

function wejscieKpir(miesiac: string, profil: WersjaProfilu, z: Partial<WejscieMiesiaca> = {}): WejscieMiesiaca {
  const rok = Number(miesiac.slice(0, 4));
  return {
    miesiac,
    kpir: { rok: kpirRoku(rok, [profil]), poprzedni: kpirRoku(rok - 1, [profil]) },
    wersje: [profil],
    platnosci: [],
    parametry: parametryRoku,
    ...z,
  };
}

const WYNIK_VAT: WynikVat = {
  naleznyGr: 690_000,
  nadwyzkaPoprzedniaGr: 120_000,
  naliczonyGr: 315_500,
  doZaplatyGr: 374_500,
  nadwyzkaNaNastepnyGr: 0,
  liczbaSprzedazy: 3,
  liczbaZakupow: 2,
};
const VAT: WejscieMiesiaca['vat'] = { ok: true, wynik: WYNIK_VAT, nadwyzka: { zl: 1200, zrodlo: 'zatwierdzone' } };
const ZAPLATY_STYCZNIA = [zaplata('2026-01', 'zus_spoleczne', 192_676, '2026-02-16', 178_829), zaplata('2026-01', 'zdrowotna', 49_835, '2026-02-16')];

function policz(w: WejscieMiesiaca): WynikMiesiaca {
  const t = tenMiesiac(w);
  if (!t.ok) throw new Error(t.braki.join(' '));
  return t.wynik;
}

/** Luty 2026, ryczałt 12 %, pełny ZUS, czynny VAT: ryczałt 1 556 zł, składki 1 926,76 zł, zdrowotna 498,35 zł, VAT 3 745 zł. */
const lutyRyczalt = () => policz(wejscie({ platnosci: ZAPLATY_STYCZNIA, vat: VAT }));
/** Luty 2027 na skali: zaliczka PIT z KPiR i zdrowotna od dochodu ze stycznia. */
const lutySkala = () => policz(wejscieKpir('2027-02', SKALA));

function pozycja(w: WynikMiesiaca, rodzaj: RodzajRozliczenia): PozycjaMiesiaca {
  const p = w.pozycje.find((x) => x.rodzaj === rodzaj);
  if (!p) throw new Error(`brak pozycji ${rodzaj}`);
  return p;
}

function zKwota(w: WynikMiesiaca, rodzaj: RodzajRozliczenia) {
  const p = pozycja(w, rodzaj);
  if (!p.ok) throw new Error(`${rodzaj}: oczekiwana pozycja z kwotą`);
  return p;
}

/** Kopia wyniku z jedną zmianą: silnik zepsuty w jednym miejscu. */
function zepsuj(w: WynikMiesiaca, zmiana: (kopia: WynikMiesiaca) => void): WynikMiesiaca {
  const kopia = structuredClone(w);
  zmiana(kopia);
  return kopia;
}

/**
 * Pozycja `rodzaj` staje się brakiem z komunikatem (przy złym terminie także
 * bez terminu), alarmy mają dokładnie te kody, pozostałe pozycje to te same
 * obiekty, a wejście się nie zmienia.
 */
function oczekujBraku(w: WynikMiesiaca, rodzaj: RodzajRozliczenia, kody: string[], { bezTerminu = false } = {}) {
  const przed = structuredClone(w);
  const k = sprawdzTenMiesiac(w);
  expect(k.alarmy.map((a) => [a.kod, a.rodzaj, a.miesiac])).toEqual(kody.map((kod) => [kod, rodzaj, w.miesiac]));
  expect(k.pozycje).toHaveLength(w.pozycje.length);
  for (const [i, p] of k.pozycje.entries()) {
    if (p.rodzaj === rodzaj) expect(p).toEqual({ ok: false, rodzaj, termin: bezTerminu ? null : w.pozycje[i].termin, brak: TEKST });
    else expect(p).toBe(w.pozycje[i]);
  }
  expect(w).toEqual(przed);
  return k;
}

// ---------------------------------------------------------------------------

describe('FILTR-RT-TM-01: kwota to bezpieczna liczba całkowita groszy, nie mniej niż zero', () => {
  it('ułamek grosza w składce zdrowotnej (pozycja w groszach): brak i alarm TM-01', () => {
    const w = zepsuj(lutyRyczalt(), (k) => {
      if (k.zdrowotna) k.zdrowotna.skladkaGr = 49_835.5;
      zKwota(k, 'zdrowotna').kwotaGr = 49_835.5;
    });
    oczekujBraku(w, 'zdrowotna', ['FILTR-RT-TM-01']);
  });

  it('ujemny ryczałt w pełnych złotych: brak i alarm TM-01', () => {
    const w = zepsuj(lutyRyczalt(), (k) => {
      if (k.ryczalt) k.ryczalt.ryczaltGr = -100;
      zKwota(k, 'ryczalt').kwotaGr = -100;
    });
    oczekujBraku(w, 'ryczalt', ['FILTR-RT-TM-01']);
  });

  it('kwota poza bezpiecznym zakresem liczb całkowitych: brak i alarm TM-01', () => {
    const w = zepsuj(lutyRyczalt(), (k) => {
      if (k.zdrowotna) k.zdrowotna.skladkaGr = 2 ** 53;
      zKwota(k, 'zdrowotna').kwotaGr = 2 ** 53;
    });
    oczekujBraku(w, 'zdrowotna', ['FILTR-RT-TM-01']);
  });

  it('kwota, która nie jest liczbą: brak, alarm TM-01 i TM-03 (różni się od źródła)', () => {
    const w = zepsuj(lutyRyczalt(), (k) => {
      zKwota(k, 'zus_spoleczne').kwotaGr = Number.NaN;
    });
    oczekujBraku(w, 'zus_spoleczne', ['FILTR-RT-TM-01', 'FILTR-RT-TM-03']);
  });
});

describe('FILTR-RT-TM-02: ryczałt, zaliczka PIT i VAT w pełnych złotych (art. 63 § 1 Ordynacji podatkowej)', () => {
  it('ryczałt z groszami: brak i alarm TM-02', () => {
    const w = zepsuj(lutyRyczalt(), (k) => {
      if (k.ryczalt) k.ryczalt.ryczaltGr = 155_556;
      zKwota(k, 'ryczalt').kwotaGr = 155_556;
    });
    oczekujBraku(w, 'ryczalt', ['FILTR-RT-TM-02']);
  });

  it('VAT z groszami: brak i alarm TM-02', () => {
    const w = zepsuj(lutyRyczalt(), (k) => {
      if (k.vat?.wynik) k.vat.wynik.doZaplatyGr = 374_550;
      zKwota(k, 'vat').kwotaGr = 374_550;
    });
    oczekujBraku(w, 'vat', ['FILTR-RT-TM-02']);
  });

  it('zaliczka PIT z groszami: brak i alarm TM-02', () => {
    const w = zepsuj(lutySkala(), (k) => {
      if (k.pit) k.pit.zaliczkaGr += 50;
      zKwota(k, 'pit').kwotaGr += 50;
    });
    oczekujBraku(w, 'pit', ['FILTR-RT-TM-02']);
  });

  it('składki społeczne i zdrowotna są w groszach (RP-ZAOKR-02): grosze w nich to nie alarm', () => {
    const w = lutyRyczalt();
    expect(zKwota(w, 'zus_spoleczne').kwotaGr % 100).not.toBe(0);
    expect(zKwota(w, 'zdrowotna').kwotaGr % 100).not.toBe(0);
    expect(sprawdzTenMiesiac(w).alarmy).toEqual([]);
  });
});

describe('FILTR-RT-TM-03: kwota pozycji równa jej źródłu w wyniku silnika', () => {
  const przypadki: [string, () => WynikMiesiaca, RodzajRozliczenia, (k: WynikMiesiaca) => void][] = [
    ['ryczałt inny niż ryczalt.ryczaltGr', lutyRyczalt, 'ryczalt', (k) => k.ryczalt && (k.ryczalt.ryczaltGr += 100)],
    ['zaliczka inna niż pit.zaliczkaGr', lutySkala, 'pit', (k) => k.pit && (k.pit.zaliczkaGr += 100)],
    ['składki inne niż razem z Funduszem Pracy', lutyRyczalt, 'zus_spoleczne', (k) => k.skladki && (k.skladki.funduszPracyGr += 1)],
    [
      'część składek bez FP inna niż skladki.razemGr',
      lutyRyczalt,
      'zus_spoleczne',
      (k) => {
        const p = zKwota(k, 'zus_spoleczne');
        p.spoleczneBezFpGr = (p.spoleczneBezFpGr ?? 0) + 1;
      },
    ],
    ['zdrowotna przy ryczałcie inna niż zdrowotna.skladkaGr', lutyRyczalt, 'zdrowotna', (k) => k.zdrowotna && (k.zdrowotna.skladkaGr += 1)],
    ['zdrowotna przy skali inna niż zdrowotnaOdDochodu.skladkaGr', lutySkala, 'zdrowotna', (k) => k.zdrowotnaOdDochodu && (k.zdrowotnaOdDochodu.skladkaGr += 1)],
    ['VAT inny niż vat.wynik.doZaplatyGr (P_51)', lutyRyczalt, 'vat', (k) => k.vat?.wynik && (k.vat.wynik.doZaplatyGr += 100)],
    ['pozycja z kwotą, a wynik bez źródła', lutyRyczalt, 'ryczalt', (k) => (k.ryczalt = null)],
  ];

  it.each(przypadki)('%s: brak i alarm TM-03', (_nazwa, wynik, rodzaj, zmiana) => {
    oczekujBraku(zepsuj(wynik(), zmiana), rodzaj, ['FILTR-RT-TM-03']);
  });

  it('źródło zdrowotnej zależy od formy: przy skali kwota z ryczałtu nie ma znaczenia', () => {
    const w = zepsuj(lutySkala(), (k) => {
      k.zdrowotna = { przychodNarastajacoGr: 0, prog: 'do 60 tys.', skladkaGr: 1 };
    });
    expect(sprawdzTenMiesiac(w).alarmy).toEqual([]);
  });
});

describe('FILTR-RT-TM-04: termin w dniu roboczym', () => {
  const termin = (k: WynikMiesiaca, rodzaj: RodzajRozliczenia, dzien: string) => {
    const t = pozycja(k, rodzaj).termin;
    if (!t) throw new Error('oczekiwany termin');
    t.faktyczny = dzien;
  };

  it('termin w sobotę: brak bez terminu i alarm TM-04', () => {
    oczekujBraku(zepsuj(lutyRyczalt(), (k) => termin(k, 'ryczalt', '2026-03-21')), 'ryczalt', ['FILTR-RT-TM-04'], { bezTerminu: true });
  });

  it('termin w święto (1 maja): brak bez terminu i alarm TM-04', () => {
    oczekujBraku(zepsuj(lutyRyczalt(), (k) => termin(k, 'vat', '2026-05-01')), 'vat', ['FILTR-RT-TM-04'], { bezTerminu: true });
  });

  it('termin, który nie jest datą: brak bez terminu i alarm TM-04', () => {
    oczekujBraku(zepsuj(lutyRyczalt(), (k) => termin(k, 'zus_spoleczne', '2026-02-30')), 'zus_spoleczne', ['FILTR-RT-TM-04'], { bezTerminu: true });
  });

  it('pozycja bez kwoty też: strona pokazuje jej termin, więc zły termin to brak strażnika i alarm', () => {
    const skala = policz(wejscie({ wersje: [{ ...PROFIL, forma: 'skala', stawkaDomyslna: null }] }));
    expect(pozycja(skala, 'pit').ok).toBe(false);
    oczekujBraku(zepsuj(skala, (k) => termin(k, 'pit', '2026-03-22')), 'pit', ['FILTR-RT-TM-04'], { bezTerminu: true });
  });

  it('pozycja bez terminu (kalendarz go nie zna) to nie alarm', () => {
    const w = zepsuj(lutyRyczalt(), (k) => {
      pozycja(k, 'ryczalt').termin = null;
    });
    const k = sprawdzTenMiesiac(w);
    expect(k.alarmy).toEqual([]);
    expect(k.pozycje[0]).toBe(w.pozycje[0]);
  });
});

describe('straż przed fałszywym alarmem: scenariusze z testów „Ten miesiąc” na prawdziwym liczeniu', () => {
  const START = { ...PROFIL, validFrom: '2026-03-15' };
  const scenariusze: Record<string, () => WejscieMiesiaca> = {
    'luty: odliczenia ze składek za styczeń zapłaconych w lutym': () => wejscie({ platnosci: ZAPLATY_STYCZNIA }),
    'nadwyżka odliczeń ze stycznia przechodzi na luty': () =>
      wejscie({
        faktury: [faktura('2026-01-31', 100_000), faktura('2026-02-28', 1_500_000)],
        platnosci: [zaplata('2025-12', 'zus_spoleczne', 192_676, '2026-01-15', 178_829)],
      }),
    'próg zdrowotnej: wyższa składka od miesiąca przekroczenia 60 tys. zł': () => wejscie({ faktury: [faktura('2026-01-31', 4_000_000), faktura('2026-02-28', 3_000_000)] }),
    'skala bez KPiR: brak zaliczki i zdrowotnej, składki się liczą': () => wejscie({ wersje: [{ ...PROFIL, forma: 'skala', stawkaDomyslna: null }] }),
    'braki ewidencji wcześniej w roku': () =>
      wejscie({
        ewidencja: zbudujEwidencje({ rok: 2026, faktury: [faktura('2026-01-10', 100)], wpisy: [], wersje: [{ ...PROFIL, validFrom: '2026-01-15' }], kursy: new Map() }),
      }),
    'zmiana ustawień ZUS w trakcie miesiąca': () => wejscie({ wersje: [PROFIL, { ...PROFIL, id: 'p2', validFrom: '2026-02-10', chorobowe: false }] }),
    'po końcu ulgi bez nowego etapu': () => wejscie({ miesiac: '2026-08', wersje: [{ ...PROFIL, zusEtap: 'ulga_na_start', zusOd: '2026-01-01' }] }),
    'ulga na start od 15.03: składki społeczne to zero': () =>
      wejscie({ miesiac: '2026-03', faktury: [faktura('2026-03-20', 1_000_000)], wersje: [{ ...START, zusEtap: 'ulga_na_start', zusOd: '2026-03-15' }] }),
    'pełny ZUS od 15.03: składki za niepełny miesiąc to brak': () => wejscie({ miesiac: '2026-03', faktury: [faktura('2026-03-20', 1_000_000)], wersje: [START] }),
    'ulga kończy się 14.09: brak składek we wrześniu': () =>
      wejscie({
        miesiac: '2026-09',
        faktury: [faktura('2026-09-10', 1_000_000)],
        wersje: [{ ...PROFIL, validFrom: '2026-03-15', zusEtap: 'ulga_na_start', zusOd: '2026-03-15' }],
      }),
    'styczeń 2026 bez parametrów roku składkowego zdrowotnej': () => wejscie({ miesiac: '2026-01' }),
    'korekta większa niż przychód: lipiec z ryczałtem zero': () =>
      wejscie({ miesiac: '2026-07', ewidencja: ewidencjaZ(2026, [wiersz('2026-06-10', 1_000_000), wiersz('2026-07-10', -50_000), wiersz('2026-08-10', 1_000_000)]) }),
    'korekta większa niż przychód: sierpień, termin z niedzieli 20.09 na poniedziałek': () =>
      wejscie({ miesiac: '2026-08', ewidencja: ewidencjaZ(2026, [wiersz('2026-06-10', 1_000_000), wiersz('2026-07-10', -50_000), wiersz('2026-08-10', 1_000_000)]) }),
    'czynny VAT: pozycja z P_51 i terminem 25.': () => wejscie({ platnosci: ZAPLATY_STYCZNIA, vat: VAT }),
    'nieznana nadwyżka VAT: brak pozycji VAT': () => wejscie({ vat: { ok: false, brak: 'Do wyliczenia VAT potrzebna jest nadwyżka.', nadwyzkaNieznana: true } }),
    'skala z VAT z MF': () => wejscie({ wersje: [{ ...PROFIL, forma: 'skala', stawkaDomyslna: null }], vat: { ok: true, wynik: WYNIK_VAT, nadwyzka: { zl: 1200, zrodlo: 'mf' } } }),
    'skala, styczeń 2027: zaliczka z KPiR i zdrowotna od dochodu z grudnia': () => wejscieKpir('2027-01', SKALA),
    'skala, luty 2027: zaliczka narastająco i zdrowotna od dochodu ze stycznia': () => wejscieKpir('2027-02', SKALA),
    'liniowy, marzec 2026, ze składkami zapłaconymi w lutym': () =>
      wejscieKpir('2026-03', LINIOWY, { platnosci: [zaplata('2026-02', 'zus_spoleczne', 45_618, '2026-03-10', 45_618), zaplata('2026-02', 'zdrowotna', 90_000, '2026-03-10')] }),
  };

  const wyniki = Object.entries(scenariusze).map(([nazwa, w]) => [nazwa, policz(w())] as const);

  it.each(wyniki)('%s: pozycje bez zmian, bez alarmu', (_nazwa, wynik) => {
    const k = sprawdzTenMiesiac(wynik);
    expect(k.alarmy).toEqual([]);
    expect(k.pozycje).toHaveLength(wynik.pozycje.length);
    for (const [i, p] of k.pozycje.entries()) expect(p).toBe(wynik.pozycje[i]);
  });

  it('scenariusze obejmują każdy rodzaj z kwotą, oba źródła zdrowotnej, kwotę zero, termin przesunięty i brak z terminem', () => {
    const pozycje = wyniki.flatMap(([, w]) => w.pozycje.map((p) => ({ p, forma: w.profil.forma })));
    const zKwota = pozycje.filter(({ p }) => p.ok);
    expect(new Set(zKwota.map(({ p }) => p.rodzaj))).toEqual(new Set(['ryczalt', 'pit', 'zus_spoleczne', 'zdrowotna', 'vat']));
    expect(new Set(zKwota.filter(({ p }) => p.rodzaj === 'zdrowotna').map(({ forma }) => forma))).toEqual(new Set(['ryczalt', 'skala', 'liniowy']));
    expect(zKwota.some(({ p }) => p.ok && p.kwotaGr === 0)).toBe(true);
    expect(pozycje.some(({ p }) => p.termin?.przesuniety)).toBe(true);
    expect(pozycje.some(({ p }) => !p.ok && p.termin)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('wpięcie: `czytajTenMiesiac` zwraca sprawdzone pozycje', () => {
  const client = {
    from: (tabela: string) => {
      if (tabela !== 'tax_settlements') throw new Error(`nieoczekiwana tabela ${tabela}`);
      const l: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'lte', 'or', 'order']) l[m] = () => l;
      l.range = async () => ({ data: [], count: 0, error: null });
      return l;
    },
  } as unknown as SupabaseClient;

  const odczytVat = (doZaplatyGr: number) => ({
    ok: true,
    miesiac: '2027-01',
    nadwyzka: { zl: 0, zrodlo: 'klient' },
    wynik: { ok: true, naleznyGr: 690_000, nadwyzkaPoprzedniaGr: 0, naliczonyGr: 195_500, doZaplatyGr, nadwyzkaNaNastepnyGr: 0, liczbaSprzedazy: 1, liczbaZakupow: 1 },
    wysylki: [],
  });

  beforeEach(() => {
    mocks.captureMessage.mockReset();
    mocks.d7 = false;
    mocks.ewidencja = { ok: true, ewidencja: ewidencjaZ(2027, [wiersz('2027-01-20', 1_500_000)]), wersje: [PREFERENCYJNY], wpisy: [] };
    mocks.vat = odczytVat(494_500);
  });

  async function odczyt() {
    const dane = await czytajTenMiesiac(client, 't1', '2027-01', { nadwyzkaVat: 0 });
    if (!dane.ok) throw new Error(dane.braki.join(' '));
    return dane;
  }

  it('poprawne kwoty: wszystkie pozycje z kwotą, bez alarmu', async () => {
    const dane = await odczyt();
    expect(dane.pozycje.map((p) => [p.rodzaj, p.ok])).toEqual([
      ['ryczalt', true],
      ['zus_spoleczne', true],
      ['zdrowotna', true],
      ['vat', true],
    ]);
    expect(mocks.captureMessage).not.toHaveBeenCalled();
  });

  it('VAT z groszami w P_51: brak z komunikatem, alarm FILTR-RT-TM-02 w Sentry bez kwot; reszta, zatwierdzenie i „Odłóż na podatek” bez VAT', async () => {
    const dobre = await odczyt();
    mocks.vat = odczytVat(494_550);
    const dane = await odczyt();

    const vat = dobre.pozycje[3];
    expect(dane.pozycje[3]).toEqual({ ok: false, rodzaj: 'vat', termin: vat.termin, brak: TEKST });
    expect(vat.termin?.faktyczny).toBe('2027-02-25');
    expect(dane.pozycje.slice(0, 3)).toEqual(dobre.pozycje.slice(0, 3));
    expect(dane.wynik.pozycje[3]).toEqual(dane.pozycje[3]);
    // Kwoty deklaracji nie idą też do opisu pod kaflami ani do pola nadwyżki.
    expect(dane.wynik.vat).toEqual({ wynik: null, nadwyzka: null, nadwyzkaNieznana: false });
    expect(doZatwierdzenia(dane).map((p) => p.rodzaj)).toEqual(['ryczalt', 'zus_spoleczne', 'zdrowotna']);
    const odlozyc = ileOdlozyc('2027-01', dane);
    expect(odlozyc).toMatchObject({ ok: true, pozycje: dobre.pozycje.slice(0, 3).map((p) => ({ rodzaj: p.rodzaj, kwotaGr: p.ok ? p.kwotaGr : null })), braki: [TEKST] });

    expect(mocks.captureMessage).toHaveBeenCalledTimes(1);
    const [tresc, opcje] = mocks.captureMessage.mock.calls[0];
    expect(opcje).toEqual({
      level: 'error',
      tags: { area: 'filtr.bezpieczniki', straznik: 'ten-miesiac', kod: 'FILTR-RT-TM-02', rodzaj: 'vat', miesiac: '2027-01', tenantId: 't1' },
      fingerprint: ['FILTR-RT-TM-02', 'vat', '2027-01'],
    });
    expect(tresc).toMatch(/^FILTR-RT-TM-02\b/);
    // Bez kwot w treści: żadnej liczby z trzema cyframi i więcej (miesiąc i firma są w tagach).
    expect(tresc).not.toMatch(/\d{3,}/);
  });

  it('bramka D7 jak na produkcji (parametry bez podpisu): braki D7 bez zmian, VAT z groszami zatrzymany', async () => {
    mocks.d7 = true;
    const dobre = await odczyt();
    expect(dobre.pozycje.map((p) => [p.rodzaj, p.ok])).toEqual([
      ['ryczalt', false],
      ['zus_spoleczne', false],
      ['zdrowotna', false],
      ['vat', true],
    ]);
    mocks.vat = odczytVat(494_550);
    const dane = await odczyt();
    expect(dane.pozycje.slice(0, 3)).toEqual(dobre.pozycje.slice(0, 3));
    expect(dane.pozycje[3]).toMatchObject({ ok: false, rodzaj: 'vat', brak: TEKST });
    expect(mocks.captureMessage.mock.calls.map(([, o]) => (o as { tags: { kod: string } }).tags.kod)).toEqual(['FILTR-RT-TM-02']);
    expect(ileOdlozyc('2027-01', dane)).toMatchObject({ ok: false });
  });
});
