import { describe, expect, it } from 'vitest';

import type { FakturaEwidencji, WierszEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { generujJpkEwp } from '@/lib/ksiegowosc/jpk-ewp';
import { generujJpkPkpir } from '@/lib/ksiegowosc/jpk-pkpir';
import { wierszeKpirOkresu, zbudujKpir, type KosztKpir } from '@/lib/ksiegowosc/kpir';

import { profil } from '../generatory/ksiegowosc';

/**
 * Złote pliki (żelazny filtr F8, plan B4.3): pełny wynik generatora dla
 * stałych danych zapisany w repozytorium. Każda zmiana pliku JPK, nawet
 * jednego znaku, jest widoczna w PR i wymaga zgoda:wiedza-prawna (pliki
 * w tests/filtr/zlote-pliki/ chroni straż). Nowy plik zapisuje
 * `pnpm exec vitest run tests/filtr/zlote-pliki -u` (tylko świadomie, z opisem
 * zmiany w karcie PR).
 */
const KSEF = '1234567890-20260315-0A1B2C-3D4E5F-6A';
const PODATNIK = { nip: '1234567890', imie: 'Jan', nazwisko: 'Kowalski-Nowak', dataUrodzenia: '1985-04-12' };

function wiersz(z: Partial<WierszEwidencji> = {}): WierszEwidencji {
  return {
    lp: 1,
    dataWpisu: '2026-03-16',
    dataPrzychodu: '2026-03-15',
    dowod: 'FV/1/03/2026',
    numerKsef: KSEF,
    krajKontrahenta: 'PL',
    idKontrahenta: '1234567890',
    kwotaGr: 1_234_56,
    stawkaPb: 1200,
    uwagi: null,
    zrodlo: { typ: 'faktura', id: 'f1' },
    ...z,
  };
}

describe('złote pliki: JPK w podatkach dochodowych', () => {
  it('JPK_EWP(4): rok z korektą, wpisem z kasy, kontrahentem z UE i 12,5 %', async () => {
    const xml = generujJpkEwp({
      od: '2026-01-01',
      do: '2026-12-31',
      celZlozenia: 1,
      kodUrzedu: '1433',
      podatnik: PODATNIK,
      wiersze: [
        wiersz(),
        wiersz({ lp: 2, dowod: 'KOR/1/04/2026', dataPrzychodu: '2026-04-02', dataWpisu: '2026-04-02', kwotaGr: -200_00, uwagi: 'Korekta (różnica)' }),
        wiersz({ lp: 3, dowod: 'Raport kasy 04/2026 & <zwroty>', numerKsef: null, krajKontrahenta: null, idKontrahenta: null, dataPrzychodu: '2026-04-30', dataWpisu: '2026-05-04', kwotaGr: 5_000_00, stawkaPb: 850, uwagi: 'Sprzedaż z kasy', zrodlo: { typ: 'wpis', id: 'w1' } }),
        wiersz({ lp: 4, dowod: 'FV/9/05/2026', krajKontrahenta: 'DE', idKontrahenta: '123456789', kwotaGr: 99, stawkaPb: 1250 }),
      ],
      wytworzono: new Date('2027-02-10T09:30:47.123Z'),
    });
    await expect(xml).toMatchFileSnapshot('./jpk-ewp4.xml');
  });

  it('JPK_PKPIR(3): skala, sprzedaż, korekta, koszty w kolumnach 10, 13 i B+R, wpis ręczny', async () => {
    const faktura = (dzien: string, gr: number, z: Partial<FakturaEwidencji> = {}): FakturaEwidencji => ({
      id: `f-${dzien}`,
      numer: `FV/${dzien}`,
      dataWystawienia: dzien,
      dataSprzedazy: dzien,
      rodzaj: 'zwykla',
      nettoGr: gr,
      waluta: 'PLN',
      numerKsef: null,
      fp: false,
      kontrahent: { kraj: 'PL', identyfikator: '5252241585', nazwa: 'Klient Sp. z o.o.', adres: 'ul. Prosta 1, 00-001 Warszawa' },
      rozliczoneZaliczkiGr: 0,
      pozycje: null,
      ...z,
    });
    const koszt = (dzien: string, gr: number, z: Partial<KosztKpir> = {}): KosztKpir => ({
      id: `k-${dzien}`,
      data: dzien,
      dowod: `FZ/${dzien}`,
      numerKsef: null,
      kontrahent: { nazwa: 'Dostawca', adres: 'ul. Krzywa 2, Kraków', kraj: 'PL', identyfikator: '5260001246' },
      opis: 'Usługi',
      kolumnaAplikacji: 'col_13',
      kwotaGr: gr,
      ...z,
    });
    const kpir = zbudujKpir({
      rok: 2026,
      faktury: [
        faktura('2026-02-10', 1_000_000, { numerKsef: '1234567890-20260210-0100001AF629-AF' }),
        faktura('2026-03-15', -10_000, { rodzaj: 'korekta', numer: 'KOR/1', kontrahent: { kraj: null, identyfikator: null, nazwa: 'Jan Kowalski', adres: null } }),
      ],
      koszty: [koszt('2026-02-11', 200_000), koszt('2026-02-12', 50_000, { kolumnaAplikacji: 'col_15', opis: 'Prace B+R' }), koszt('2026-02-13', 30_000, { kolumnaAplikacji: 'col_10' })],
      wpisy: [{ id: 'w1', data: '2026-03-31', dokument: 'NOTA/1', kolumna: 'k8', kwotaGr: 7_500, opis: 'Odsetki' }],
      wersje: [profil({ forma: 'skala', stawkaDomyslna: null })],
      kursy: new Map(),
    });
    const xml = generujJpkPkpir({
      od: '2026-01-01',
      do: '2026-12-31',
      celZlozenia: 1,
      kodUrzedu: '1433',
      podatnik: { ...PODATNIK, nazwisko: 'Testowy' },
      wiersze: wierszeKpirOkresu(kpir, '2026-01-01', '2026-12-31'),
      wytworzono: new Date('2027-01-15T10:00:00Z'),
    });
    await expect(xml).toMatchFileSnapshot('./jpk-pkpir3.xml');
  });

  // Dalej (krok F10): JPK_V7M(3), JPK_FA(4) i FA(3) zwykła, KOR, ZAL i ROZ.
});
