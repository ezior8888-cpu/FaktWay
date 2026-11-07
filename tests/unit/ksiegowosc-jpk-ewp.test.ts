import { describe, expect, it } from 'vitest';

import { TAX_OFFICES } from '@/lib/exports/tax-offices';
import type { WierszEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { celZlozenia, generujJpkEwp, kwotaJpk, nazwaPlikuJpkEwp, stawkaJpk, type DaneJpkEwp } from '@/lib/ksiegowosc/jpk-ewp';
import { validateJpkEwp } from '@/lib/ksiegowosc/jpk-ewp-walidator';

/**
 * JPK_EWP(4) na oficjalnym XSD MF (plan księgowości JDG, K3). NIP fikcyjny
 * z AGENTS.md; numer KSeF zbudowany według wzorca TNumerKSeF ze schematu.
 */

const KSEF = '1234567890-20260315-0A1B2C-3D4E5F-6A';

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

function dane(z: Partial<DaneJpkEwp> = {}): DaneJpkEwp {
  return {
    od: '2026-01-01',
    do: '2026-12-31',
    celZlozenia: 1,
    kodUrzedu: TAX_OFFICES[0][0],
    podatnik: { nip: '1234567890', imie: 'Jan', nazwisko: 'Kowalski-Nowak', dataUrodzenia: '1985-04-12' },
    wiersze: [
      wiersz(),
      wiersz({ lp: 2, dowod: 'KOR/1/04/2026', dataPrzychodu: '2026-04-02', dataWpisu: '2026-04-02', kwotaGr: -200_00, uwagi: 'Korekta (różnica)' }),
      wiersz({
        lp: 3,
        dowod: 'Raport kasy 04/2026 & <zwroty>',
        numerKsef: null,
        krajKontrahenta: null,
        idKontrahenta: null,
        dataPrzychodu: '2026-04-30',
        dataWpisu: '2026-05-04',
        kwotaGr: 5_000_00,
        stawkaPb: 850,
        uwagi: 'Sprzedaż z kasy',
        zrodlo: { typ: 'wpis', id: 'w1' },
      }),
      wiersz({ lp: 4, dowod: 'FV/9/05/2026', krajKontrahenta: 'DE', idKontrahenta: '123456789', kwotaGr: 99, stawkaPb: 1250 }),
    ],
    wytworzono: new Date('2027-02-10T09:30:47.123Z'),
    ...z,
  };
}

describe('JPK_EWP(4): plik zgodny ze schematem MF', () => {
  it('pełny rok z korektą, wpisem z kasy, kontrahentem z UE i 12,5 % przechodzi XSD', async () => {
    const xml = generujJpkEwp(dane());
    const wynik = await validateJpkEwp(xml);
    expect(wynik.errors).toEqual([]);
    expect(wynik.valid).toBe(true);
  });

  it('nagłówek, podmiot i sumy kontrolne mają wartości ze struktury', () => {
    const xml = generujJpkEwp(dane());
    expect(xml).toContain('<KodFormularza kodSystemowy="JPK_EWP (4)" wersjaSchemy="1-0">JPK_EWP</KodFormularza>');
    expect(xml).toContain('<WariantFormularza>4</WariantFormularza>');
    expect(xml).toContain('<CelZlozenia>1</CelZlozenia>');
    expect(xml).toContain('<DataWytworzeniaJPK>2027-02-10T09:30:47Z</DataWytworzeniaJPK>');
    expect(xml).toContain('<etd:ImiePierwsze>Jan</etd:ImiePierwsze>');
    expect(xml).toContain('<LiczbaWierszy>4</LiczbaWierszy>');
    // 1234,56 - 200,00 + 5000,00 + 0,99
    expect(xml).toContain('<SumaPrzychodow>6035.55</SumaPrzychodow>');
    expect(xml).toContain('<K_8>-200.00</K_8>');
    expect(xml).toContain('<K_9>12.5</K_9>');
    expect(xml).toContain('Raport kasy 04/2026 &amp; &lt;zwroty&gt;');
  });

  it('wiersz bez KSeF i kontrahenta pomija K_5, K_6 i K_7', () => {
    const xml = generujJpkEwp(dane({ wiersze: [wiersz({ numerKsef: null, krajKontrahenta: null, idKontrahenta: null })] }));
    expect(xml).not.toMatch(/<K_5>|<K_6>|<K_7>/);
  });

  it('zła stawka albo zły numer KSeF nie przechodzą XSD', async () => {
    expect((await validateJpkEwp(generujJpkEwp(dane({ wiersze: [wiersz({ stawkaPb: 2300 })] })))).valid).toBe(false);
    expect((await validateJpkEwp(generujJpkEwp(dane({ wiersze: [wiersz({ numerKsef: 'FV-1' })] })))).valid).toBe(false);
  });

  it('plik bez wierszy nie powstaje (LiczbaWierszy musi być większa od zera)', () => {
    expect(() => generujJpkEwp(dane({ wiersze: [] }))).toThrow('brak wierszy');
  });
});

describe('JPK_EWP(4): wartości pól', () => {
  it('kwoty z groszy bez float i bez separatorów', () => {
    expect(kwotaJpk(123456)).toBe('1234.56');
    expect(kwotaJpk(-5)).toBe('-0.05');
    expect(kwotaJpk(100_000_000_00)).toBe('100000000.00');
  });

  it('stawki ze słownika K_9', () => {
    expect([1700, 1250, 1200, 850, 550, 300].map(stawkaJpk)).toEqual(['17', '12.5', '12', '8.5', '5.5', '3']);
  });

  it('cel złożenia: 1 tylko dla całego zamkniętego roku, inaczej plik na żądanie', () => {
    expect(celZlozenia('2026-01-01', '2026-12-31', '2027-01-05')).toBe(1);
    expect(celZlozenia('2026-01-01', '2026-12-31', '2026-12-31')).toBe(0);
    expect(celZlozenia('2026-01-01', '2026-06-30', '2027-01-05')).toBe(0);
  });

  it('nazwa pliku z NIP i okresem', () => {
    expect(nazwaPlikuJpkEwp('1234567890', '2026-01-01', '2026-12-31')).toBe('JPK_EWP_1234567890_2026-01-01_2026-12-31.xml');
  });
});
