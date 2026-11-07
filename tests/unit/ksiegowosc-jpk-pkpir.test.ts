import { describe, expect, it } from 'vitest';

import type { FakturaEwidencji } from '@/lib/ksiegowosc/ewidencja';
import { generujJpkPkpir, nazwaPlikuJpkPkpir } from '@/lib/ksiegowosc/jpk-pkpir';
import { validateJpkPkpir } from '@/lib/ksiegowosc/jpk-ewp-walidator';
import { wierszeKpirOkresu, zbudujKpir, type KosztKpir } from '@/lib/ksiegowosc/kpir';
import type { WersjaProfilu } from '@/lib/ksiegowosc/profil';

/**
 * JPK_PKPIR(3) na OFICJALNYM schemacie MF (lib/exports/schemas/jpk-pkpir3,
 * pobrany 7.11.2026 z gov.pl): plik z KPiR K7 przechodzi XSD, sumy kontrolne
 * i PKPIRInfo zgadzają się z wierszami.
 */

const SKALA: WersjaProfilu = {
  id: 'p1',
  validFrom: '2026-01-01',
  forma: 'skala',
  stawkaDomyslna: null,
  zusEtap: 'pelny',
  zusOd: null,
  chorobowe: true,
  nrsZus: null,
  najem: false,
};

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

function plik() {
  const kpir = zbudujKpir({
    rok: 2026,
    faktury: [
      faktura('2026-02-10', 1_000_000, { numerKsef: '1234567890-20260210-0100001AF629-AF' }),
      faktura('2026-03-15', -10_000, { rodzaj: 'korekta', numer: 'KOR/1', kontrahent: { kraj: null, identyfikator: null, nazwa: 'Jan Kowalski', adres: null } }),
    ],
    koszty: [koszt('2026-02-11', 200_000), koszt('2026-02-12', 50_000, { kolumnaAplikacji: 'col_15', opis: 'Prace B+R' }), koszt('2026-02-13', 30_000, { kolumnaAplikacji: 'col_10' })],
    wpisy: [{ id: 'w1', data: '2026-03-31', dokument: 'NOTA/1', kolumna: 'k8', kwotaGr: 7_500, opis: 'Odsetki' }],
    wersje: [SKALA],
    kursy: new Map(),
  });
  const wiersze = wierszeKpirOkresu(kpir, '2026-01-01', '2026-12-31');
  return generujJpkPkpir({
    od: '2026-01-01',
    do: '2026-12-31',
    celZlozenia: 1,
    kodUrzedu: '1433',
    podatnik: { nip: '1234567890', imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01' },
    wiersze,
    wytworzono: new Date('2027-01-15T10:00:00Z'),
  });
}

describe('JPK_PKPIR(3), oficjalny schemat MF', () => {
  it('plik z KPiR przechodzi XSD', async () => {
    const wynik = await validateJpkPkpir(plik());
    expect(wynik.errors).toEqual([]);
    expect(wynik.valid).toBe(true);
  });

  it('nagłówek, osoba fizyczna, PKPIRInfo i sumy kontrolne z wierszy', () => {
    const xml = plik();
    expect(xml).toContain('<KodFormularza kodSystemowy="JPK_PKPIR (3)" wersjaSchemy="1-0">JPK_PKPIR</KodFormularza>');
    expect(xml).toMatch(/<OsobaFizyczna>\s*<etd:NIP>1234567890<\/etd:NIP>/);
    // Przychód 10 000 − 100 + 75 = 9 975 zł; koszty 2 000 + 500 + 300 = 2 800 zł.
    expect(xml).toMatch(/<P_1>0\.00<\/P_1>\s*<P_2>0\.00<\/P_2>\s*<P_3>2800\.00<\/P_3>\s*<P_4>7175\.00<\/P_4>/);
    expect(xml).toMatch(/<LiczbaWierszy>6<\/LiczbaWierszy>\s*<SumaPrzychodow>9975\.00<\/SumaPrzychodow>/);
    // Sprzedaż: K_3B, K_4A/K_4B, K_7 i K_9; B+R: K_13, K_14 i K_16A/K_16B; zakup towarów: K_10 bez K_14.
    expect(xml).toMatch(/<K_3B>1234567890-20260210-0100001AF629-AF<\/K_3B>\s*<K_4A>PL<\/K_4A>\s*<K_4B>5252241585<\/K_4B>/);
    expect(xml).toMatch(/<K_13>500\.00<\/K_13>\s*<K_14>500\.00<\/K_14>\s*<K_16A>Prace B\+R<\/K_16A>\s*<K_16B>500\.00<\/K_16B>/);
    expect(xml).toMatch(/<K_10>300\.00<\/K_10>\s*<\/PKPIRWiersz>/);
    // Korekta bez identyfikatora i adresu: K_5B „BRAK”, kwota ujemna.
    expect(xml).toMatch(/<K_5A>Jan Kowalski<\/K_5A>\s*<K_5B>BRAK<\/K_5B>\s*<K_6>Korekta sprzedaży<\/K_6>\s*<K_7>-100\.00<\/K_7>/);
    expect(nazwaPlikuJpkPkpir('1234567890', '2026-01-01', '2026-12-31')).toBe('JPK_PKPIR_1234567890_2026-01-01_2026-12-31.xml');
  });

  it('bez wierszy nie ma pliku; numer KSeF spoza wzoru zatrzymuje XSD', async () => {
    expect(() =>
      generujJpkPkpir({ od: '2026-01-01', do: '2026-12-31', celZlozenia: 1, kodUrzedu: '1433', podatnik: { nip: '1234567890', imie: 'J', nazwisko: 'T', dataUrodzenia: '1980-01-01' }, wiersze: [] }),
    ).toThrow(/brak wierszy/);
    const zly = plik().replace('1234567890-20260210-0100001AF629-AF', 'NIE-KSEF');
    expect((await validateJpkPkpir(zly)).valid).toBe(false);
  });
});
