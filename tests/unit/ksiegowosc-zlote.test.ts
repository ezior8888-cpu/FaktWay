import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { zbudujEwidencje, type FakturaEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { zbudujKpir, type KosztKpir, type Kpir } from '@/lib/ksiegowosc/kpir';
import { terminDla } from '@/lib/ksiegowosc/kalendarz';
import { parametryRoku, type ParametryRoku } from '@/lib/ksiegowosc/parametry';
import type { EtapZus, WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { tenMiesiac, type Platnosc } from '@/lib/ksiegowosc/ten-miesiac';
import { vatMiesiaca } from '@/lib/ksiegowosc/vat';
import type { ExportExpense } from '@/lib/exports/data-fetcher';
import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';

/**
 * Złote przypadki (plan księgowości JDG, K4; arkusz docs/ksiegowosc/
 * ZLOTE-PRZYPADKI.md). Przypadek z podpisem księgowej (`policzyla`) liczy się
 * miesiąc po miesiącu tym samym silnikiem co strona „Ten miesiąc” i musi się
 * zgadzać co do grosza w każdym wypełnionym polu wyniku. Przypadek bez
 * podpisu czeka (zielone dopiero po B4, sekcja 11 planu).
 *
 * Przychody stają się fakturami ze stawką z przypadku, a składki za miesiące
 * z `zaplacone_skladki_za` są płacone 15. dnia miesiąca wiersza, w kwotach
 * policzonych dla tamtych miesięcy. `historia` (miesiące przed pierwszym
 * wierszem, tylko wejście) liczy się tak samo, ale bez porównania: daje
 * przychód narastająco, próg najmu i zapłacone składki z całego roku. Kwot,
 * których silnik nie liczy (składki za grudzień 2025 r., zdrowotna za
 * styczeń 2026 r. bez parametrów 2025 r.), historia nie odlicza.
 */

interface Przychod {
  data: string | null;
  netto_gr: number | null;
  stawka_ryczaltu: string | null;
  opis: string;
}

interface Wejscie {
  zus_etap: EtapZus | null;
  zaplacone_skladki_za: string[];
  przychody: Przychod[];
  /** Skala i liniowy (G8-G11): koszty w KPiR. */
  koszty?: { data: string | null; kpir_gr: number | null; opis: string }[];
}

interface Miesiac {
  miesiac: string;
  wejscie: Wejscie;
  wynik: Record<string, Record<string, unknown> | null>;
}

export interface Przypadek {
  id: string;
  tytul: string;
  policzyla: string;
  zalozenia: { forma: 'ryczalt' | 'skala' | 'liniowy' | null; start_dzialalnosci: string | null; chorobowe: boolean | null };
  /** Miesiące przed pierwszym wierszem, tylko wejście (z założeń przypadku). */
  historia?: { miesiac: string; wejscie: Wejscie }[];
  miesiace: Miesiac[];
}

const wszystkie = (p: Przypadek) => [...(p.historia ?? []), ...p.miesiace];

const KATALOG = join(__dirname, '..', 'fixtures', 'ksiegowosc', 'zlote');

function wersjeProfilu(p: Przypadek): WersjaProfilu[] {
  const najem = wszystkie(p).some((m) => m.wejscie.przychody.some((x) => x.stawka_ryczaltu === '8.5' && /najem|najmu|dzierżaw|zakwater/i.test(x.opis)));
  const wersje: WersjaProfilu[] = [];
  for (const m of wszystkie(p)) {
    const etap = m.wejscie.zus_etap;
    if (!etap || wersje.at(-1)?.zusEtap === etap) continue;
    const od = `${m.miesiac}-01`;
    wersje.push({
      id: `${p.id}-${m.miesiac}`,
      validFrom: wersje.length === 0 && p.zalozenia.start_dzialalnosci && p.zalozenia.start_dzialalnosci < od ? p.zalozenia.start_dzialalnosci : od,
      forma: p.zalozenia.forma ?? 'ryczalt',
      stawkaDomyslna: (p.zalozenia.forma ?? 'ryczalt') === 'ryczalt' ? 1200 : null,
      zusEtap: etap,
      zusOd: etap === 'ulga_na_start' || etap === 'preferencyjny' ? (wersje.length === 0 ? (p.zalozenia.start_dzialalnosci ?? od) : od) : null,
      chorobowe: p.zalozenia.chorobowe === true,
      najem,
      nrsZus: null,
    });
  }
  return wersje;
}

function faktury(p: Przypadek, rok: number): FakturaEwidencji[] {
  return wszystkie(p).flatMap((m) =>
    m.wejscie.przychody
      .filter((x) => x.data && x.netto_gr && x.data.startsWith(String(rok)))
      .map((x, i) => ({
        id: `${m.miesiac}-${i}`,
        numer: `${p.id}/${m.miesiac}/${i + 1}`,
        dataWystawienia: x.data as string,
        dataSprzedazy: x.data,
        rodzaj: 'zwykla' as const,
        nettoGr: x.netto_gr as number,
        waluta: 'PLN',
        numerKsef: null,
        fp: false,
        kontrahent: { kraj: null, identyfikator: null },
        rozliczoneZaliczkiGr: 0,
        pozycje: x.stawka_ryczaltu ? [{ nettoGr: x.netto_gr as number, stawkaRyczaltu: x.stawka_ryczaltu }] : null,
      })),
  );
}

/** Koszty w KPiR (G8-G11): jeden koszt w kolumnie 13 na każdą kwotę z tabeli. */
function koszty(p: Przypadek, rok: number): KosztKpir[] {
  return wszystkie(p).flatMap((m) =>
    (m.wejscie.koszty ?? [])
      .filter((x) => x.data && x.kpir_gr && x.data.startsWith(String(rok)))
      .map((x, i) => ({
        id: `${m.miesiac}-k${i}`,
        data: x.data as string,
        dowod: `${p.id}/K/${m.miesiac}/${i + 1}`,
        numerKsef: null,
        kontrahent: { nazwa: 'Dostawca', adres: null, kraj: null, identyfikator: null },
        opis: x.opis || 'Koszty',
        kolumnaAplikacji: 'col_13',
        kwotaGr: x.kpir_gr as number,
      })),
  );
}

/** Wynik silnika w kształcie pól arkusza, miesiąc po miesiącu. */
export function policzPrzypadek(p: Przypadek, parametry: (rok: number) => ParametryRoku | null) {
  const wersje = wersjeProfilu(p);
  const ewidencje = new Map<number, ReturnType<typeof zbudujEwidencje>>();
  const ewidencjaRoku = (rok: number) => {
    if (!ewidencje.has(rok)) {
      const l = parametry(rok)?.ryczalt.liczby;
      const najem =
        l && l.progStawki8_5.wartosc !== null && l.stawka8_5.wartosc !== null && l.stawkaPonadProg8_5.wartosc !== null
          ? { progGr: l.progStawki8_5.wartosc, stawkaNajmuPb: l.stawka8_5.wartosc, stawkaPonadProgPb: l.stawkaPonadProg8_5.wartosc }
          : { brak: `brak progu najmu na ${rok} r.` };
      ewidencje.set(rok, zbudujEwidencje({ rok, faktury: faktury(p, rok), wpisy: [], wersje, kursy: new Map(), najem }));
    }
    return ewidencje.get(rok)!;
  };
  const forma = p.zalozenia.forma ?? 'ryczalt';
  const ksiegi = new Map<number, Kpir>();
  const kpirRoku = (rok: number) => {
    if (!ksiegi.has(rok)) ksiegi.set(rok, zbudujKpir({ rok, faktury: faktury(p, rok), koszty: koszty(p, rok), wpisy: [], wersje, kursy: new Map() }));
    return ksiegi.get(rok)!;
  };
  const policzone = new Map<string, { spoleczne: number | null; bezFp: number; zdrowotna: number | null }>();
  const platnosci: Platnosc[] = [];
  const wyniki: Record<string, Record<string, unknown>> = {};
  const porownywane = new Set(p.miesiace.map((m) => m.miesiac));

  for (const m of wszystkie(p)) {
    const zHistorii = !porownywane.has(m.miesiac);
    for (const za of m.wejscie.zaplacone_skladki_za) {
      const s = policzone.get(za);
      if (!s && !zHistorii) throw new Error(`${p.id} ${m.miesiac}: składki za ${za} nie zostały policzone`);
      if (s?.spoleczne != null) {
        platnosci.push({ miesiac: za, rodzaj: 'zus_spoleczne', wersja: 1, kwotaGr: s.spoleczne, spoleczneBezFpGr: s.bezFp, zaplaconeO: `${m.miesiac}-15` });
      }
      if (s?.zdrowotna != null) {
        platnosci.push({ miesiac: za, rodzaj: 'zdrowotna', wersja: 1, kwotaGr: s.zdrowotna, spoleczneBezFpGr: 0, zaplaconeO: `${m.miesiac}-15` });
      }
    }
    const rok = Number(m.miesiac.slice(0, 4));
    const ksiega =
      forma === 'ryczalt'
        ? { ewidencja: ewidencjaRoku(rok) }
        : { kpir: { rok: kpirRoku(rok), poprzedni: m.miesiac.endsWith('-01') ? kpirRoku(rok - 1) : null } };
    const w = tenMiesiac({ miesiac: m.miesiac, ...ksiega, wersje, platnosci, parametry });
    if (!w.ok) {
      if (zHistorii) continue;
      throw new Error(`${p.id} ${m.miesiac}: ${w.braki.join(' ')}`);
    }
    const { skladki, zdrowotna, zdrowotnaOdDochodu, ryczalt, pit, pozycje } = w.wynik;
    policzone.set(m.miesiac, {
      spoleczne: skladki ? skladki.razemGr + skladki.funduszPracyGr : null,
      bezFp: skladki?.razemGr ?? 0,
      zdrowotna: zdrowotna?.skladkaGr ?? zdrowotnaOdDochodu?.skladkaGr ?? null,
    });
    if (zHistorii) continue;
    const brakiPozycji = pozycje.flatMap((x) => (x.ok ? [] : [`${x.rodzaj}: ${x.brak}`]));
    if (forma !== 'ryczalt') {
      // Grudzień 2026: tylko składki (zaliczka i zdrowotna z tabel od stycznia 2027 r.).
      if (!skladki) throw new Error(`${p.id} ${m.miesiac}: ${brakiPozycji.join(' ')}`);
      wyniki[m.miesiac] = {
        skladki_spoleczne: {
          podstawa_gr: skladki.podstawaGr,
          emerytalna_gr: skladki.emerytalnaGr,
          rentowe_gr: skladki.rentoweGr,
          chorobowa_gr: skladki.chorobowaGr,
          wypadkowa_gr: skladki.wypadkowaGr,
          razem_gr: skladki.razemGr,
          fundusz_pracy_gr: skladki.funduszPracyGr,
        },
        ...(zdrowotnaOdDochodu ? { zdrowotna: { podstawa_gr: zdrowotnaOdDochodu.podstawaGr, skladka_gr: zdrowotnaOdDochodu.skladkaGr } } : {}),
        ...(pit
          ? {
              pit: {
                przychod_narastajaco_gr: pit.przychodNarastajacoGr,
                koszty_narastajaco_gr: pit.kosztyNarastajacoGr,
                dochod_narastajaco_gr: pit.dochodNarastajacoGr,
                spoleczne_narastajaco_gr: pit.spoleczneNarastajacoGr,
                zdrowotna_narastajaco_gr: pit.zdrowotnaNarastajacoGr,
                podstawa_narastajaco_gr: pit.podstawaNarastajacoGr,
                podatek_narastajaco_gr: pit.podatekNarastajacoGr,
                zaliczka_gr: pit.zaliczkaGr,
              },
            }
          : {}),
      };
      continue;
    }
    if (brakiPozycji.length > 0 || !skladki || !zdrowotna || !ryczalt) throw new Error(`${p.id} ${m.miesiac}: ${brakiPozycji.join(' ')}`);
    const klucz = (pb: number) => String(pb / 100);
    wyniki[m.miesiac] = {
      skladki_spoleczne: {
        podstawa_gr: skladki.podstawaGr,
        emerytalna_gr: skladki.emerytalnaGr,
        rentowe_gr: skladki.rentoweGr,
        chorobowa_gr: skladki.chorobowaGr,
        wypadkowa_gr: skladki.wypadkowaGr,
        razem_gr: skladki.razemGr,
        fundusz_pracy_gr: skladki.funduszPracyGr,
      },
      zdrowotna: { przychod_narastajaco_gr: zdrowotna.przychodNarastajacoGr, prog: zdrowotna.prog, skladka_gr: zdrowotna.skladkaGr },
      ryczalt_odliczenia: {
        spoleczne_zaplacone_gr: ryczalt.odliczenia.spoleczneZaplaconeGr,
        zdrowotna_50_proc_gr: ryczalt.odliczenia.zdrowotna50ProcGr,
        nadwyzka_z_poprzednich_gr: ryczalt.odliczenia.nadwyzkaZPoprzednichGr,
        odliczono_gr: ryczalt.odliczenia.odliczonoGr,
        nadwyzka_na_kolejne_gr: ryczalt.odliczenia.nadwyzkaNaKolejneGr,
      },
      ryczalt: {
        przychod_wg_stawek_gr: Object.fromEntries([...ryczalt.przychodWgStawekGr].map(([pb, gr]) => [klucz(pb), gr])),
        podstawa_wg_stawek_gr: Object.fromEntries([...ryczalt.podstawaWgStawekGr].map(([pb, gr]) => [klucz(pb), gr])),
        ryczalt_gr: ryczalt.ryczaltGr,
      },
      terminy: {
        ryczalt_lub_pit: pozycje.find((x) => x.rodzaj === 'ryczalt')?.termin?.faktyczny ?? null,
        zus: pozycje.find((x) => x.rodzaj === 'zus_spoleczne')?.termin?.faktyczny ?? null,
        vat: terminDla({ rodzaj: 'vatJpk', rok: Number(m.miesiac.slice(0, 4)), miesiac: Number(m.miesiac.slice(5, 7)) })?.faktyczny ?? null,
      },
    };
  }
  return wyniki;
}

/**
 * Bloki i pola, których silnik danej formy nie liczy: ryczałt nie liczy zaliczki
 * PIT ani podstawy zdrowotnej (kwota z progu), skala i liniowy nie liczą ryczałtu
 * ani progu zdrowotnej; VAT i limit VAT liczy osobny harness albo nikt.
 */
const POMIJANE: Readonly<Record<'ryczalt' | 'kpir', { bloki: Set<string>; pola: Set<string> }>> = {
  ryczalt: { bloki: new Set(['pit', 'vat', 'limit_vat']), pola: new Set(['zdrowotna.podstawa_gr']) },
  kpir: {
    bloki: new Set(['ryczalt', 'ryczalt_odliczenia', 'vat', 'limit_vat']),
    pola: new Set(['zdrowotna.przychod_narastajaco_gr', 'zdrowotna.prog']),
  },
};

/** Tylko pola, które księgowa wypełniła (nie null, nie pusty obiekt). */
function wypelnione(oczekiwane: Record<string, Record<string, unknown> | null>, rodzaj: 'ryczalt' | 'kpir' = 'ryczalt') {
  const { bloki, pola: pomijanePola } = POMIJANE[rodzaj];
  const wynik: Record<string, Record<string, unknown>> = {};
  for (const [blok, pola] of Object.entries(oczekiwane)) {
    if (!pola || bloki.has(blok)) continue;
    const pusty = (v: unknown) => v === null || (typeof v === 'object' && Object.keys(v as object).length === 0);
    const zostaw = Object.entries(pola).filter(([k, v]) => !pusty(v) && !pomijanePola.has(`${blok}.${k}`));
    if (zostaw.length > 0) wynik[blok] = Object.fromEntries(zostaw);
  }
  return wynik;
}

/**
 * Przypadki VAT (G12): kwoty z `vatMiesiaca`, czyli z tego samego kodu co
 * plik JPK_V7M. Przychody stają się fakturami (korekta: faktura korygująca
 * z kwotami różnicy, jak w KSeF), koszty kosztami z VAT do odliczenia według
 * `odliczenie_vat_proc`. P_39 stycznia to nadwyżka z założeń, a każdego
 * następnego miesiąca P_62 miesiąca poprzedniego.
 */
interface PrzychodVat {
  data: string | null;
  netto_gr: number | null;
  stawka_vat: string | null;
  vat_gr: number | null;
  korekta_do: string | null;
  opis: string;
}

interface KosztVat {
  data: string | null;
  netto_gr: number | null;
  vat_gr: number | null;
  odliczenie_vat_proc: number | null;
  opis: string;
}

export interface PrzypadekVat {
  id: string;
  tytul: string;
  policzyla: string;
  zalozenia: { nadwyzka_vat_z_poprzedniego_roku_gr: number | null };
  miesiace: { miesiac: string; wejscie: { przychody: PrzychodVat[]; koszty: KosztVat[] }; wynik: Record<string, Record<string, unknown> | null> }[];
}

const PRZYPADKI_VAT = new Set(['G12.json']);

export function policzVat(p: PrzypadekVat) {
  let nadwyzkaZl = (p.zalozenia.nadwyzka_vat_z_poprzedniego_roku_gr ?? 0) / 100;
  const wyniki: Record<string, Record<string, unknown>> = {};
  for (const m of p.miesiace) {
    const sprzedaz = m.wejscie.przychody
      .filter((x) => x.data && x.netto_gr !== null && x.stawka_vat)
      .map((x, i): JpkInvoice => {
        const netto = (x.netto_gr as number) / 100;
        const vat = (x.vat_gr ?? 0) / 100;
        return {
          invoiceNumber: `${p.id}/${m.miesiac}/${i + 1}`,
          currency: 'PLN',
          invoiceType: x.korekta_do ? 'correction' : 'regular',
          issueDate: x.data as string,
          buyerName: 'Nabywca',
          netTotal: netto,
          vatTotal: vat,
          grossTotal: netto + vat,
          lines: [{ position: 1, name: x.opis, unit: 'szt.', quantity: 1, unitPriceNet: netto, netAmount: netto, vatRate: x.stawka_vat as string, vatAmount: vat }],
        } as JpkInvoice;
      });
    const koszty = m.wejscie.koszty
      .filter((x) => x.data && x.netto_gr !== null)
      .map((x, i): ExportExpense => ({
        id: `${m.miesiac}-${i}`,
        issueDate: x.data as string,
        documentNumber: `${p.id}/Z/${m.miesiac}/${i + 1}`,
        documentType: 'invoice',
        sellerName: 'Dostawca',
        sellerNip: null,
        sellerAddress: null,
        netAmount: (x.netto_gr as number) / 100,
        vatAmount: (x.vat_gr ?? 0) / 100,
        grossAmount: ((x.netto_gr as number) + (x.vat_gr ?? 0)) / 100,
        vatDeductibleAmount: Math.round(((x.vat_gr ?? 0) * (x.odliczenie_vat_proc ?? 0)) / 100) / 100,
        kpirColumn: null,
        categoryLabel: null,
        ksefNumber: null,
      }));
    const w = vatMiesiaca({ sprzedaz, koszty }, nadwyzkaZl);
    if (!w.ok) throw new Error(`${p.id} ${m.miesiac}: ${w.brak}`);
    wyniki[m.miesiac] = {
      vat: { p_38_gr: w.naleznyGr, p_39_gr: w.nadwyzkaPoprzedniaGr, p_48_gr: w.naliczonyGr, p_51_gr: w.doZaplatyGr, p_62_gr: w.nadwyzkaNaNastepnyGr },
    };
    nadwyzkaZl = w.nadwyzkaNaNastepnyGr / 100;
  }
  return wyniki;
}

const pliki = readdirSync(KATALOG).filter((f) => /^G\d+\.json$/.test(f)).sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));
const plikiRyczaltu = pliki.filter((f) => !PRZYPADKI_VAT.has(f));

describe('złote przypadki z arkusza księgowej', () => {
  it('są szkielety G1-G12 i G14', () => {
    expect(pliki).toEqual(['G1.json', 'G2.json', 'G3.json', 'G4.json', 'G5.json', 'G6.json', 'G7.json', 'G8.json', 'G9.json', 'G10.json', 'G11.json', 'G12.json', 'G14.json']);
  });

  for (const plik of plikiRyczaltu) {
    const przypadek = JSON.parse(readFileSync(join(KATALOG, plik), 'utf8')) as Przypadek;
    const podpisany = przypadek.policzyla.trim() !== '';
    it.skipIf(!podpisany)(`${przypadek.id} co do grosza: ${przypadek.tytul}${podpisany ? '' : ' (czeka na podpis księgowej)'}`, () => {
      const policzone = policzPrzypadek(przypadek, parametryRoku);
      const rodzaj = (przypadek.zalozenia.forma ?? 'ryczalt') === 'ryczalt' ? 'ryczalt' : 'kpir';
      for (const m of przypadek.miesiace) expect(policzone[m.miesiac], m.miesiac).toMatchObject(wypelnione(m.wynik, rodzaj));
    });
  }

  for (const plik of PRZYPADKI_VAT) {
    const przypadek = JSON.parse(readFileSync(join(KATALOG, plik), 'utf8')) as PrzypadekVat;
    const podpisany = przypadek.policzyla.trim() !== '';
    it.skipIf(!podpisany)(`${przypadek.id} co do grosza: ${przypadek.tytul}${podpisany ? '' : ' (czeka na podpis księgowej)'}`, () => {
      const policzone = policzVat(przypadek);
      for (const m of przypadek.miesiace) {
        const vat = Object.fromEntries(Object.entries(m.wynik.vat ?? {}).filter(([, v]) => v !== null));
        expect(policzone[m.miesiac].vat, m.miesiac).toMatchObject(vat);
      }
    });
  }
});

describe('uruchamianie przypadku (syntetyczny, policzony ręcznie na parametrach 2026)', () => {
  const syntetyczny: Przypadek = {
    id: 'GX',
    tytul: 'Ryczałt 12 %, pełny ZUS z chorobową, 15 000 zł miesięcznie',
    policzyla: 'test',
    zalozenia: { forma: 'ryczalt', start_dzialalnosci: null, chorobowe: true },
    // Od lutego: styczeń 2026 należy do roku składkowego zdrowotnej 2025/2026, bez parametrów w K1.
    miesiace: ['2026-02', '2026-03'].map((miesiac, i) => ({
      miesiac,
      wejscie: {
        zus_etap: 'pelny',
        zaplacone_skladki_za: i === 0 ? [] : ['2026-02'],
        przychody: [{ data: `${miesiac}-${i === 0 ? 28 : 31}`, netto_gr: 1_500_000, stawka_ryczaltu: '12', opis: '' }],
      },
      wynik: {},
    })),
  };

  it('marzec: składki 1926,76 zł, zdrowotna 498,35 zł, ryczałt 1556 zł po odliczeniu składek za luty', () => {
    const w = policzPrzypadek(syntetyczny, parametryRoku);
    expect(w['2026-03']).toMatchObject({
      skladki_spoleczne: { podstawa_gr: 565_200, razem_gr: 178_829, fundusz_pracy_gr: 13_847 },
      zdrowotna: { przychod_narastajaco_gr: 2_821_171, prog: 'do 60 tys.', skladka_gr: 49_835 },
      ryczalt_odliczenia: { spoleczne_zaplacone_gr: 178_829, zdrowotna_50_proc_gr: 24_918, odliczono_gr: 203_747, nadwyzka_na_kolejne_gr: 0 },
      ryczalt: { przychod_wg_stawek_gr: { '12': 1_500_000 }, podstawa_wg_stawek_gr: { '12': 1_296_300 }, ryczalt_gr: 155_600 },
      terminy: { ryczalt_lub_pit: '2026-04-20', zus: '2026-04-20' },
    });
    expect(w['2026-02']).toMatchObject({ ryczalt: { ryczalt_gr: 180_000 }, zdrowotna: { przychod_narastajaco_gr: 1_500_000 } });
  });

  it('historia roku daje grudniowi przychód narastająco i składki zapłacone przez cały rok', () => {
    const miesiac = (m: number) => `2026-${String(m).padStart(2, '0')}`;
    const przychod = (dzien: string) => [{ data: dzien, netto_gr: 1_500_000, stawka_ryczaltu: '12', opis: '' }];
    const zHistoria: Przypadek = {
      ...syntetyczny,
      id: 'GH',
      historia: Array.from({ length: 11 }, (_, i) => ({
        miesiac: miesiac(i + 1),
        wejscie: { zus_etap: 'pelny' as const, zaplacone_skladki_za: i === 0 ? [] : [miesiac(i)], przychody: przychod(`${miesiac(i + 1)}-28`) },
      })),
      miesiace: [{ miesiac: '2026-12', wejscie: { zus_etap: 'pelny', zaplacone_skladki_za: ['2026-11'], przychody: przychod('2026-12-31') }, wynik: {} }],
    };
    const w = policzPrzypadek(zHistoria, parametryRoku);
    expect(Object.keys(w)).toEqual(['2026-12']);
    // 180 000,00 zł przychodu minus 11 × 1 788,29 zł składek zapłaconych w 2026 r. (za styczeń-listopad) = 160 328,81 zł.
    // Odliczenie w grudniu: składki za listopad 1 788,29 zł i połowa zdrowotnej 830,58 zł; ryczałt 1 536 zł.
    expect(w['2026-12']).toMatchObject({
      zdrowotna: { przychod_narastajaco_gr: 16_032_881, prog: 'do 300 tys.', skladka_gr: 83_058 },
      ryczalt_odliczenia: { spoleczne_zaplacone_gr: 178_829, zdrowotna_50_proc_gr: 41_529 },
      ryczalt: { ryczalt_gr: 153_600 },
    });
  });

  it('szkielety G2-G11 i G14 liczą grudzień 2026 z historią roku; w G3 najem jest już ponad progiem', () => {
    const grudnie = new Map<string, Record<string, unknown>>();
    for (const plik of plikiRyczaltu.filter((f) => f !== 'G1.json')) {
      const przypadek = JSON.parse(readFileSync(join(KATALOG, plik), 'utf8')) as Przypadek;
      const w = policzPrzypadek({ ...przypadek, miesiace: przypadek.miesiace.filter((m) => m.miesiac === '2026-12') }, parametryRoku);
      expect(Object.keys(w), przypadek.id).toEqual(['2026-12']);
      grudnie.set(przypadek.id, w['2026-12']);
    }
    // 11 × 11 000 zł = 121 000 zł do listopada, więc cały grudzień idzie z 12,5 %.
    expect(grudnie.get('G3')?.ryczalt).toMatchObject({ przychod_wg_stawek_gr: { '12.5': 1_100_000 } });
    // G8 (skala, preferencyjny od lipca 2026 r.): składki grudnia z podstawy 30 % płacy minimalnej 2026 r. (1 441,80 zł).
    expect(grudnie.get('G8')?.skladki_spoleczne).toMatchObject({ podstawa_gr: 144_180 });
  });

  it('szkielet G12 liczy się przez cały rok: nadwyżka z grudnia, korekta w maju, nadwyżka z czerwca w lipcu (policzone ręcznie)', () => {
    const g12 = JSON.parse(readFileSync(join(KATALOG, 'G12.json'), 'utf8')) as PrzypadekVat;
    const w = policzVat(g12);
    const vat = (m: string) => w[m].vat;
    // Styczeń: 6 900 zł należnego; naliczony 1 840 + 50 % z 230 = 1 955 zł, plus 1 200 zł nadwyżki.
    expect(vat('2027-01')).toEqual({ p_38_gr: 690_000, p_39_gr: 120_000, p_48_gr: 315_500, p_51_gr: 374_500, p_62_gr: 0 });
    expect(vat('2027-02')).toEqual({ p_38_gr: 690_000, p_39_gr: 0, p_48_gr: 195_500, p_51_gr: 494_500, p_62_gr: 0 });
    // Maj: korekta -460 zł VAT w miesiącu wystawienia.
    expect(vat('2027-05')).toMatchObject({ p_38_gr: 644_000, p_51_gr: 448_500 });
    // Czerwiec: podwykonawca 9 200 zł VAT, więc 11 155 zł naliczonego i 4 255 zł nadwyżki na lipiec.
    expect(vat('2027-06')).toEqual({ p_38_gr: 690_000, p_39_gr: 0, p_48_gr: 1_115_500, p_51_gr: 0, p_62_gr: 425_500 });
    expect(vat('2027-07')).toEqual({ p_38_gr: 690_000, p_39_gr: 425_500, p_48_gr: 621_000, p_51_gr: 69_000, p_62_gr: 0 });
    expect(vat('2027-12')).toMatchObject({ p_51_gr: 494_500 });
  });

  it('porównanie bierze tylko pola wypełnione przez księgową', () => {
    expect(wypelnione({ ryczalt: { ryczalt_gr: 1, przychod_wg_stawek_gr: {} }, vat: { p_38_gr: 5 }, zdrowotna: { podstawa_gr: 7, skladka_gr: null } })).toEqual({
      ryczalt: { ryczalt_gr: 1 },
    });
  });
});
