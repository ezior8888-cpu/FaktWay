import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { zbudujEwidencje, type FakturaEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { terminDla } from '@/lib/ksiegowosc/kalendarz';
import { parametryRoku, type ParametryRoku } from '@/lib/ksiegowosc/parametry';
import type { EtapZus, WersjaProfilu } from '@/lib/ksiegowosc/profil';
import { tenMiesiac, type Platnosc } from '@/lib/ksiegowosc/ten-miesiac';

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
  zalozenia: { forma: string | null; start_dzialalnosci: string | null; chorobowe: boolean | null };
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
      forma: 'ryczalt',
      stawkaDomyslna: 1200,
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
        pozycje: [{ nettoGr: x.netto_gr as number, stawkaRyczaltu: x.stawka_ryczaltu }],
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
    const w = tenMiesiac({ miesiac: m.miesiac, ewidencja: ewidencjaRoku(Number(m.miesiac.slice(0, 4))), wersje, platnosci, parametry });
    if (!w.ok) {
      if (zHistorii) continue;
      throw new Error(`${p.id} ${m.miesiac}: ${w.braki.join(' ')}`);
    }
    const { skladki, zdrowotna, ryczalt, pozycje } = w.wynik;
    policzone.set(m.miesiac, { spoleczne: skladki ? skladki.razemGr + skladki.funduszPracyGr : null, bezFp: skladki?.razemGr ?? 0, zdrowotna: zdrowotna?.skladkaGr ?? null });
    if (zHistorii) continue;
    const brakiPozycji = pozycje.flatMap((x) => (x.ok ? [] : [`${x.rodzaj}: ${x.brak}`]));
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

/** Bloki liczone dopiero w K6 i K7 oraz pola, których silnik ryczałtu nie liczy. */
const POMIJANE_BLOKI = new Set(['pit', 'vat', 'limit_vat']);
const POMIJANE_POLA = new Set(['zdrowotna.podstawa_gr']);

/** Tylko pola, które księgowa wypełniła (nie null, nie pusty obiekt). */
function wypelnione(oczekiwane: Record<string, Record<string, unknown> | null>) {
  const wynik: Record<string, Record<string, unknown>> = {};
  for (const [blok, pola] of Object.entries(oczekiwane)) {
    if (!pola || POMIJANE_BLOKI.has(blok)) continue;
    const pusty = (v: unknown) => v === null || (typeof v === 'object' && Object.keys(v as object).length === 0);
    const zostaw = Object.entries(pola).filter(([k, v]) => !pusty(v) && !POMIJANE_POLA.has(`${blok}.${k}`));
    if (zostaw.length > 0) wynik[blok] = Object.fromEntries(zostaw);
  }
  return wynik;
}

const pliki = readdirSync(KATALOG).filter((f) => /^G\d+\.json$/.test(f)).sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)));

describe('złote przypadki z arkusza księgowej', () => {
  it('są szkielety G1-G7 i G14', () => {
    expect(pliki).toEqual(['G1.json', 'G2.json', 'G3.json', 'G4.json', 'G5.json', 'G6.json', 'G7.json', 'G14.json']);
  });

  for (const plik of pliki) {
    const przypadek = JSON.parse(readFileSync(join(KATALOG, plik), 'utf8')) as Przypadek;
    const podpisany = przypadek.policzyla.trim() !== '';
    it.skipIf(!podpisany)(`${przypadek.id} co do grosza: ${przypadek.tytul}${podpisany ? '' : ' (czeka na podpis księgowej)'}`, () => {
      const policzone = policzPrzypadek(przypadek, parametryRoku);
      for (const m of przypadek.miesiace) expect(policzone[m.miesiac], m.miesiac).toMatchObject(wypelnione(m.wynik));
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

  it('szkielety G2-G7 i G14 liczą grudzień 2026 z historią roku; w G3 najem jest już ponad progiem', () => {
    const grudnie = new Map<string, Record<string, unknown>>();
    for (const plik of pliki.filter((f) => f !== 'G1.json')) {
      const przypadek = JSON.parse(readFileSync(join(KATALOG, plik), 'utf8')) as Przypadek;
      const w = policzPrzypadek({ ...przypadek, miesiace: przypadek.miesiace.filter((m) => m.miesiac === '2026-12') }, parametryRoku);
      expect(Object.keys(w), przypadek.id).toEqual(['2026-12']);
      grudnie.set(przypadek.id, w['2026-12']);
    }
    // 11 × 11 000 zł = 121 000 zł do listopada, więc cały grudzień idzie z 12,5 %.
    expect(grudnie.get('G3')?.ryczalt).toMatchObject({ przychod_wg_stawek_gr: { '12.5': 1_100_000 } });
  });

  it('porównanie bierze tylko pola wypełnione przez księgową', () => {
    expect(wypelnione({ ryczalt: { ryczalt_gr: 1, przychod_wg_stawek_gr: {} }, vat: { p_38_gr: 5 }, zdrowotna: { podstawa_gr: 7, skladka_gr: null } })).toEqual({
      ryczalt: { ryczalt_gr: 1 },
    });
  });
});
