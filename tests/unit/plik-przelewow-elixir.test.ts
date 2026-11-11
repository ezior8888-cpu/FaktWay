import { describe, expect, it } from 'vitest';

import { validateIban } from '@/lib/xml/invoice-calculator';

/**
 * Krok 3.4 planu kompletnej aplikacji, część 2: plik przelewów Elixir-0
 * („PLI”) z listy „Do zapłaty”.
 *
 * Wzorzec: publiczne specyfikacje importu banków (odczyt 10.11.2026):
 *  - ING Bank Śląski, „Opis formatów plików importu i eksportu wykorzystywanych
 *    w ING Business”, wersja 1.51C obowiązująca od 8.07.2026, rozdział II
 *    „Format importu Multicash PLI (Elixir 0)”, tabele 1 i 2
 *    (https://www.ing.pl/_fileserver/item/1122382);
 *  - mBank, „Import do koszyka” (https://www.mbank.pl/pdf/koszyk_przelewow_-_instrukcja_importu_przelewow.pdf).
 * Rekord: bez nagłówka, pola po przecinku, teksty w cudzysłowie, po rekordzie
 * CR LF; 110, data RRRRMMDD, kwota w groszach bez przecinka, numer
 * rozliczeniowy banku zleceniodawcy, 0, rachunek zleceniodawcy, rachunek
 * kontrahenta, nazwa i adres zleceniodawcy (4 x 35), nazwa i adres
 * kontrahenta (4 x 35), 0, numer rozliczeniowy banku kontrahenta, tytuł
 * (4 x 35, linie po „|”), "", "", klasyfikacja "51" (MPP: "53").
 * MPP: tytuł /VAT/kwota z przecinkiem/IDC/NIP/INV/numer/TXT/tekst, a „|”
 * dokładnie co 35 znaków, także wewnątrz słów kodowych (mBank).
 *
 * Prawdziwe: generator, kodowanie Windows-1250 (`iconv-lite`). Wyrocznie:
 * `TextDecoder('windows-1250')` (ICU, niezależne od `iconv-lite`), przykłady
 * z dokumentacji banków znak po znaku, `validateIban` dla rachunków.
 */

/** Liczba kontrolna NRB dla 24 cyfr numeru (BBAN), jak w każdym polskim rachunku. */
function nrbZ(bban: string): string {
  let r = 0;
  for (const c of `${bban}252100`) r = (r * 10 + Number(c)) % 97;
  return `${String(98 - r).padStart(2, '0')}${bban}`;
}

const ING = nrbZ('105010380000000000001234');
const PKO = nrbZ('102010260000000000005678');
const ODBIORCA = nrbZ('109010140000000000004321');
const NIP = '1234567890';
const KSEF = `${NIP}-20261105-0A1B2C3D4E01-7A`;

const dekoduj = (b: Uint8Array) => new TextDecoder('windows-1250').decode(b);

describe('rachunki testowe', () => {
  it('mają poprawne liczby kontrolne (wyrocznia: validateIban)', () => {
    for (const r of [ING, PKO, ODBIORCA]) expect(validateIban(`PL${r}`)).toBe(true);
  });
});

describe('Elixir-0: pola i rekord', () => {
  it('rekord 110 zgodny z układem z tabeli 1 ING (15 pól, kwota w groszach, numery rozliczeniowe z rachunków)', async () => {
    const { rekordElixir } = await import('@/lib/expenses/elixir0');
    const rekord = rekordElixir({
      dataWykonania: '2026-11-20',
      kwotaGrosze: 123000,
      rachunekNadawcy: ING,
      rachunekOdbiorcy: ODBIORCA,
      nadawca: 'Testowa Firma sp. z o.o.|ul. Prosta 1|00-001 Warszawa',
      odbiorca: 'Dostawca 1 sp. z o.o.',
      tytul: `${KSEF}| FV/1/11/2026`,
      mpp: false,
    });
    expect(rekord).toBe(
      `110,20261120,123000,10501038,0,"${ING}","${ODBIORCA}","Testowa Firma sp. z o.o.|ul. Prosta 1|00-001 Warszawa",` +
        `"Dostawca 1 sp. z o.o.",0,10901014,"${KSEF}| FV/1/11/2026","","","51"`,
    );
  });

  it('kwota w groszach bez przecinka i zer wiodących, grosze jak na fakturze (roundToCents)', async () => {
    const { kwotaWGroszach } = await import('@/lib/expenses/elixir0');
    expect(kwotaWGroszach(1230)).toBe(123000);
    expect(kwotaWGroszach(0.1)).toBe(10);
    expect(kwotaWGroszach(15000.01)).toBe(1500001);
    expect(kwotaWGroszach(1.005)).toBe(101);
    expect(kwotaWGroszach(200.1)).toBe(20010);
    expect(kwotaWGroszach(1234567.89)).toBe(123456789);
    expect(kwotaWGroszach(0)).toBeNull();
    expect(kwotaWGroszach(-5)).toBeNull();
    expect(kwotaWGroszach(Number.NaN)).toBeNull();
  });

  it('tytuł 4 x 35: „|” na 36., 72. i 108. znaku, nic nie ginie; ponad 140 znaków to brak tytułu', async () => {
    const { liniePo35 } = await import('@/lib/expenses/elixir0');
    const tytul140 = 'A'.repeat(35) + 'B'.repeat(35) + 'C'.repeat(35) + 'D'.repeat(35);
    expect(liniePo35(tytul140)).toBe(`${'A'.repeat(35)}|${'B'.repeat(35)}|${'C'.repeat(35)}|${'D'.repeat(35)}`);
    expect(liniePo35(`${KSEF} FV/1/11/2026`)).toBe(`${KSEF}| FV/1/11/2026`);
    expect(liniePo35('krótki tytuł')).toBe('krótki tytuł');
    expect(liniePo35(`${tytul140}E`)).toBeNull();
    expect(liniePo35('')).toBeNull();
  });

  it('MPP: podział co 35 znaków wewnątrz słów kodowych jak w przykładzie mBanku', async () => {
    const { liniePo35 } = await import('@/lib/expenses/elixir0');
    expect(liniePo35('/VAT/23,01/IDC/1234567890/INV/F-RA/10034/34/2/TXT/Tytuł o maksym. długości 33 znaki')).toBe(
      '/VAT/23,01/IDC/1234567890/INV/F-RA/|10034/34/2/TXT/Tytuł o maksym. dług|ości 33 znaki',
    );
    // Przykład tytułu z tabeli 2 ING.
    expect(liniePo35('/VAT/123,00/IDC/12345123451234/INV/FV-201701/17/TXT/tekst wolny')).toBe(
      '/VAT/123,00/IDC/12345123451234/INV/|FV-201701/17/TXT/tekst wolny',
    );
  });

  it('komunikat MPP: kwota VAT z przecinkiem, NIP, numer KSeF jako numer faktury, numer faktury w /TXT/', async () => {
    const { komunikatMpp } = await import('@/lib/expenses/elixir0');
    expect(komunikatMpp({ vat: 230, nip: NIP, numerKsef: KSEF, tekst: 'FV/1/11/2026' })).toBe(
      `/VAT/230,00/IDC/${NIP}/INV/${KSEF}/TXT/FV/1/11/2026`,
    );
    expect(komunikatMpp({ vat: 1.005, nip: NIP, numerKsef: KSEF, tekst: null })).toBe(`/VAT/1,01/IDC/${NIP}/INV/${KSEF}`);
    // /TXT/ ma najwyżej 33 znaki i nie może zawierać słów kodowych: wtedy go nie ma, nic nie jest obcięte.
    expect(komunikatMpp({ vat: 10, nip: NIP, numerKsef: KSEF, tekst: 'X'.repeat(34) })).toBe(`/VAT/10,00/IDC/${NIP}/INV/${KSEF}`);
    expect(komunikatMpp({ vat: 10, nip: NIP, numerKsef: KSEF, tekst: 'FV/INV/7' })).toBe(`/VAT/10,00/IDC/${NIP}/INV/${KSEF}`);
    expect(komunikatMpp({ vat: 0, nip: NIP, numerKsef: KSEF, tekst: null })).toBeNull();
    expect(komunikatMpp({ vat: 10, nip: '123', numerKsef: KSEF, tekst: null })).toBeNull();
    expect(komunikatMpp({ vat: 10, nip: NIP, numerKsef: 'zły numer', tekst: null })).toBeNull();
  });

  it('rekord MPP: klasyfikacja "53", tytuł z komunikatem co 35 znaków', async () => {
    const { rekordElixir, komunikatMpp, liniePo35 } = await import('@/lib/expenses/elixir0');
    const tytul = liniePo35(komunikatMpp({ vat: 230, nip: NIP, numerKsef: KSEF, tekst: 'FV/1/11/2026' })!)!;
    expect(tytul).toBe(`/VAT/230,00/IDC/${NIP}/INV/${KSEF.slice(0, 4)}|${KSEF.slice(4)}/TXT|/FV/1/11/2026`);
    const rekord = rekordElixir({
      dataWykonania: '2026-11-10', kwotaGrosze: 123000, rachunekNadawcy: ING, rachunekOdbiorcy: ODBIORCA,
      nadawca: 'Firma', odbiorca: 'Dostawca', tytul, mpp: true,
    });
    expect(rekord.endsWith(`,"${tytul}","","","53"`)).toBe(true);
  });

  it('MPP tylko dla banku zleceniodawcy, którego specyfikacja Elixir-0 opisuje przelew MPP (ING, mBank)', async () => {
    const { bankObslugujeMppWElixir } = await import('@/lib/expenses/elixir0');
    expect(bankObslugujeMppWElixir(ING)).toBe(true);
    expect(bankObslugujeMppWElixir(nrbZ('114020040000000000009012'))).toBe(true);
    expect(bankObslugujeMppWElixir(PKO)).toBe(false);
  });

  it('rachunek: 26 cyfr z poprawną liczbą kontrolną; „PL” i spacje zdjęte; zagraniczny albo z literówką odrzucony', async () => {
    const { nrb } = await import('@/lib/expenses/elixir0');
    expect(nrb(`PL${ODBIORCA}`)).toBe(ODBIORCA);
    expect(nrb(ODBIORCA.replace(/(\d{4})/g, '$1 '))).toBe(ODBIORCA);
    expect(nrb(`${ODBIORCA.slice(0, 25)}${(Number(ODBIORCA[25]) + 1) % 10}`)).toBeNull();
    expect(nrb('DE89370400440532013000')).toBeNull();
    expect(nrb(ODBIORCA.slice(1))).toBeNull();
    expect(nrb(null)).toBeNull();
  });
});

describe('Elixir-0: teksty', () => {
  it('cudzysłowy w nazwie nie psują pola: zamiana na apostrof, pole dalej w jednym cudzysłowie', async () => {
    const { poleNazwyElixir, rekordElixir } = await import('@/lib/expenses/elixir0');
    expect(poleNazwyElixir(['Przedsiębiorstwo „Krzak” sp. z o.o.'])).toBe("Przedsiębiorstwo 'Krzak' sp. z o.o.");
    expect(poleNazwyElixir(['Firma "ABC" s.c.'])).toBe("Firma 'ABC' s.c.");
    const rekord = rekordElixir({
      dataWykonania: '2026-11-10', kwotaGrosze: 1, rachunekNadawcy: ING, rachunekOdbiorcy: ODBIORCA,
      nadawca: poleNazwyElixir(['Firma "ABC" s.c.'])!, odbiorca: poleNazwyElixir(['„Krzak”, Kowalski i wspólnicy'])!,
      tytul: 'x', mpp: false,
    });
    // Każde pole tekstowe to "…" bez cudzysłowu w środku: rekord rozkłada się na 15 pól.
    const pola = rekord.match(/"[^"]*"|[^,]+/g)!;
    expect(pola).toHaveLength(15);
    expect(pola[8]).toBe(`"'Krzak', Kowalski i wspólnicy"`);
  });

  it('znak „|” w nazwie albo tytule nie tworzy nowej linii; znaki spoza listy banku zamienione, litery bez obcych znaków diakrytycznych', async () => {
    const { tekstElixir } = await import('@/lib/expenses/elixir0');
    expect(tekstElixir('Dostawca | Serwis')).toBe('Dostawca Serwis');
    expect(tekstElixir('Müller & Söhne GmbH')).toBe('Muller & Sohne GmbH');
    expect(tekstElixir('Faktura #12; zlecenie: 7!')).toBe('Faktura 12 zlecenie 7');
    expect(tekstElixir('Łódź – Żółta 5\tlok. 2')).toBe('Łódź - Żółta 5 lok. 2');
    expect(tekstElixir('Straße')).toBe('Strasse');
    expect(tekstElixir('ООО Ромашка')).toBe('');
  });

  it('nazwa i adres: linie najwyżej po 35 znaków, cała nazwa przed adresem, najwyżej 4 linie', async () => {
    const { poleNazwyElixir } = await import('@/lib/expenses/elixir0');
    const pole = poleNazwyElixir([
      'Przedsiębiorstwo Handlowo Usługowe Transport i Spedycja Kowalski',
      'ul. Długa 15/3',
      '80-001 Gdańsk',
    ])!;
    expect(pole).toBe('Przedsiębiorstwo Handlowo Usługowe|Transport i Spedycja Kowalski|ul. Długa 15/3|80-001 Gdańsk');
    for (const linia of pole.split('|')) expect(linia.length).toBeLessThanOrEqual(35);
    expect(poleNazwyElixir(['A'.repeat(200), 'adres'])!.split('|')).toEqual(['A'.repeat(35), 'A'.repeat(35), 'A'.repeat(35), 'A'.repeat(35)]);
    expect(poleNazwyElixir(['', 'adres'])).toBeNull();
    expect(poleNazwyElixir(['ООО Ромашка'])).toBeNull();
  });
});

describe('Elixir-0: plik', () => {
  it('Windows-1250: polskie litery na bajtach strony kodowej (wyrocznia TextDecoder), CR LF po każdym rekordzie, bez nagłówka', async () => {
    const { zakodujPlikElixir } = await import('@/lib/expenses/elixir0-kodowanie');
    const bajty = zakodujPlikElixir(['ĄĆĘŁŃÓŚŹŻąćęłńóśźż', 'drugi']);
    expect(Array.from(bajty.slice(0, 18))).toEqual([
      0xa5, 0xc6, 0xca, 0xa3, 0xd1, 0xd3, 0x8c, 0x8f, 0xaf, 0xb9, 0xe6, 0xea, 0xb3, 0xf1, 0xf3, 0x9c, 0x9f, 0xbf,
    ]);
    expect(dekoduj(bajty)).toBe('ĄĆĘŁŃÓŚŹŻąćęłńóśźż\r\ndrugi\r\n');
    expect(bajty.length).toBe(18 + 2 + 5 + 2);
  });

  it('znak spoza Windows-1250 nie przechodzi po cichu jako „?”', async () => {
    const { zakodujPlikElixir } = await import('@/lib/expenses/elixir0-kodowanie');
    expect(() => zakodujPlikElixir(['Ромашка'])).toThrow();
  });
});
