import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { STAWKI_JPK_EWP_PB, type FakturaEwidencji, type WierszEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { generujJpkEwp } from '@/lib/ksiegowosc/jpk-ewp';
import { validateJpkEwp, validateJpkPkpir } from '@/lib/ksiegowosc/jpk-ewp-walidator';
import { generujJpkPkpir } from '@/lib/ksiegowosc/jpk-pkpir';
import { wierszeKpirOkresu, zbudujKpir, type KosztKpir } from '@/lib/ksiegowosc/kpir';

import { dzien, nip, profil } from '../generatory/ksiegowosc';
import { PRZYPADKI, ZIARNO } from '../generatory/ustawienia';

/**
 * XSD na losowych danych (żelazny filtr F9, plan B4.6; NZ-FA-10 dla JPK
 * w podatkach dochodowych): każdy plik JPK_EWP(4) i JPK_PKPIR(3) z losowych
 * wierszy przechodzi oficjalny schemat MF (xmllint). Walidacja to osobny
 * proces, więc w PR 30 przypadków, w nocy 400.
 */
const ILE = PRZYPADKI > 1_000 ? 400 : 30;
const opcjeXsd = ZIARNO === undefined ? { numRuns: ILE } : { numRuns: ILE, seed: ZIARNO };

const hex = (n: number) => fc.array(fc.constantFrom(...'0123456789ABCDEF'), { minLength: n, maxLength: n }).map((z) => z.join(''));
const numerKsef = fc.tuple(nip, dzien(2026), hex(6), hex(6), hex(2)).map(([n, d, a, b, c]) => `${n}-${d.replace(/-/g, '')}-${a}-${b}-${c}`);
// Tekst z polskimi znakami i znakami specjalnymi XML (generator musi je zakodować).
const tekst = fc.stringMatching(/^[A-Za-z0-9ĄĆĘŁŃÓŚŹŻąćęłńóśźż &<>"'/.,-]{1,40}$/).filter((s) => s.trim().length > 0);

const wierszEwp = fc.record({
  dataPrzychodu: dzien(2026),
  dowod: tekst,
  numerKsef: fc.option(numerKsef, { nil: null }),
  kontrahent: fc.option(fc.tuple(fc.constantFrom('PL', 'DE', 'CZ'), nip), { nil: null }),
  kwotaGr: fc.integer({ min: -50_000_000, max: 500_000_000 }).filter((k) => k !== 0),
  stawkaPb: fc.constantFrom(...STAWKI_JPK_EWP_PB),
  uwagi: fc.option(tekst, { nil: null }),
});

describe('JPK_EWP(4): losowe wiersze przechodzą oficjalny XSD', () => {
  it('każdy plik jest poprawny', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(wierszEwp, { minLength: 1, maxLength: 25 }), async (wiersze) => {
        const posortowane = [...wiersze].sort((a, b) => a.dataPrzychodu.localeCompare(b.dataPrzychodu));
        const xml = generujJpkEwp({
          od: '2026-01-01',
          do: '2026-12-31',
          celZlozenia: 1,
          kodUrzedu: '1433',
          podatnik: { nip: '1234567890', imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01' },
          wiersze: posortowane.map(
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
          wytworzono: new Date('2027-02-10T09:30:47Z'),
        });
        const wynik = await validateJpkEwp(xml);
        expect(wynik.errors).toEqual([]);
      }),
      opcjeXsd,
    );
  }, 600_000);
});

const fakturaKpir = fc.record({
  data: dzien(2026),
  nettoGr: fc.integer({ min: 1, max: 300_000_000 }),
  numerKsef: fc.option(numerKsef, { nil: null }),
  nazwa: tekst,
  adres: fc.option(tekst, { nil: null }),
  identyfikator: fc.option(nip, { nil: null }),
});
const kosztKpir = fc.record({
  data: dzien(2026),
  kwotaGr: fc.integer({ min: 1, max: 100_000_000 }),
  kolumna: fc.constantFrom('col_10', 'col_11', 'col_12', 'col_13', 'col_15'),
  opis: tekst,
});

describe('JPK_PKPIR(3): losowa KPiR przechodzi oficjalny XSD', () => {
  it('każdy plik jest poprawny', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fakturaKpir, { minLength: 1, maxLength: 15 }), fc.array(kosztKpir, { maxLength: 15 }), async (faktury, koszty) => {
        const kpir = zbudujKpir({
          rok: 2026,
          faktury: faktury.map(
            (f, i): FakturaEwidencji => ({
              id: `f${i}`,
              numer: `FV/${i + 1}/2026`,
              dataWystawienia: f.data,
              dataSprzedazy: f.data,
              rodzaj: 'zwykla',
              nettoGr: f.nettoGr,
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
          wpisy: [],
          wersje: [profil({ forma: 'skala', stawkaDomyslna: null })],
          kursy: new Map(),
        });
        const wiersze = wierszeKpirOkresu(kpir, '2026-01-01', '2026-12-31');
        if (wiersze.length === 0) return;
        const xml = generujJpkPkpir({
          od: '2026-01-01',
          do: '2026-12-31',
          celZlozenia: 1,
          kodUrzedu: '1433',
          podatnik: { nip: '1234567890', imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01' },
          wiersze,
          wytworzono: new Date('2027-01-15T10:00:00Z'),
        });
        const wynik = await validateJpkPkpir(xml);
        expect(wynik.errors).toEqual([]);
      }),
      opcjeXsd,
    );
  }, 600_000);
});
