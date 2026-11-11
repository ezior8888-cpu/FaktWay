import { describe, expect, it } from 'vitest';

import { nrbZNumeruBankuIRachunku } from '@/lib/import/bank/rachunek';
import {
  czytajTytulPrzelewu,
  opisPropozycji,
  propozycjaZaplaty,
  rodzajPrzelewu,
  taxConfirmedText,
  type OperacjaPodatkowa,
  type RozliczenieZaplaty,
} from '@/lib/import/bank/podatki';
import { formatPaymentMoney } from '@/lib/invoices/invoice-payments';
import { formatujRachunek, mikrorachunekZNip } from '@/lib/ksiegowosc/mikrorachunek';

/**
 * Przelewy do ZUS i urzędu skarbowego z wyciągu (plan kompletnej aplikacji,
 * krok 3.2, część 2): rozpoznanie po rachunku odbiorcy, odczyt symbolu
 * formularza i okresu z tytułu przelewu na mikrorachunek i propozycja zapłaty
 * rozliczenia. Czyste funkcje, bez bazy.
 *
 * Źródła zapisu w tytule:
 *  - okres i typ okresu: rozporządzenie MFiG z 8.04.2026 r. w sprawie wzoru
 *    formularza wpłaty gotówkowej oraz polecenia przelewu na rachunek organu
 *    podatkowego (Dz. U. poz. 537), załącznik nr 2, pole 11 (przykłady 25R,
 *    25K03, 25M02, 25D0207, 25J0703);
 *  - symbol formularza: rozporządzenie MFiG z 25.09.2025 r. w sprawie rodzajów
 *    podatków ... wpłacanych przy użyciu mikrorachunku podatkowego (Dz. U.
 *    poz. 1305), załącznik, części II (PIT, PIT-28, PIT-36, PIT-36L, PPE, PPL)
 *    i III (JPK-V7M, JPK-V7K, VAT-7, VAT-7K).
 *
 * NIP 1234563218 i 1111111111 są fikcyjne, z poprawną sumą kontrolną
 * (1234567890 z AGENTS.md nie jest NIP-em, więc nie ma mikrorachunku).
 */

const NIP = '1234563218';
const MIKRO = mikrorachunekZNip(NIP)!;
const NRS = nrbZNumeruBankuIRachunku('60000002', '0260123456789012')!.slice(2);
const KONTA = { zus: [NRS], us: MIKRO };

describe('rozpoznanie przelewu po rachunku odbiorcy', () => {
  it('ZUS po rachunku składkowym z ustawień podatkowych, także bez „PL” i ze spacjami', () => {
    expect(rodzajPrzelewu(`PL${NRS}`, KONTA)).toBe('zus');
    expect(rodzajPrzelewu(NRS, KONTA)).toBe('zus');
    expect(rodzajPrzelewu(formatujRachunek(NRS), KONTA)).toBe('zus');
    // Rachunek z innej wersji ustawień też jest rachunkiem firmy.
    expect(rodzajPrzelewu(`PL${NRS}`, { zus: ['11111111111111111111111111', NRS], us: null })).toBe('zus');
  });

  it('urząd skarbowy po mikrorachunku z NIP firmy', () => {
    expect(rodzajPrzelewu(`PL${MIKRO}`, KONTA)).toBe('us');
    expect(rodzajPrzelewu(`PL ${formatujRachunek(MIKRO)}`, KONTA)).toBe('us');
  });

  it('inny rachunek, mikrorachunek innej firmy i brak rachunku: to nie przelew do ZUS ani urzędu', () => {
    expect(rodzajPrzelewu('PL61109010140000071219812874', KONTA)).toBeNull();
    expect(rodzajPrzelewu(`PL${mikrorachunekZNip('1111111111')}`, KONTA)).toBeNull();
    expect(rodzajPrzelewu(null, KONTA)).toBeNull();
    expect(rodzajPrzelewu(`PL${NRS}`, { zus: [], us: null })).toBeNull();
    expect(rodzajPrzelewu(`PL${MIKRO}`, { zus: [], us: null })).toBeNull();
  });
});

describe('odczyt tytułu przelewu na mikrorachunek', () => {
  it.each([
    ['25R', { typ: 'R', rok: 2025, miesiac: null }],
    ['25K03', { typ: 'K', rok: 2025, miesiac: null }],
    ['25M02', { typ: 'M', rok: 2025, miesiac: '2025-02' }],
    ['25D0207', { typ: 'D', rok: 2025, miesiac: null }],
    ['25J0703', { typ: 'J', rok: 2025, miesiac: null }],
  ])('okres %s w zapisie z przykładów rozporządzenia (Dz. U. 2026 poz. 537)', (zapis, okres) => {
    expect(czytajTytulPrzelewu(`/TI/N${NIP}/OKR/${zapis}/SFP/PIT/`).okres).toEqual({ zapis, ...okres });
  });

  it.each([
    ['PPE', 'ryczalt'],
    ['PIT-28', 'ryczalt'],
    ['PPL', 'pit'],
    ['PIT-36L', 'pit'],
    ['PIT-36', 'pit'],
    ['PIT', 'pit'],
    ['VAT-7', 'vat'],
    ['JPK-V7M', 'vat'],
    // Deklaracje kwartalne: FaktWay rozlicza VAT tylko miesięcznie.
    ['JPK-V7K', null],
    ['VAT-7K', null],
  ])('symbol %s z wykazu MF (Dz. U. 2025 poz. 1305)', (symbol, podatek) => {
    expect(czytajTytulPrzelewu(`/TI/N${NIP}/OKR/26M01/SFP/${symbol}/TXT/`)).toMatchObject({
      symbol,
      podatek,
      wWykazieMf: true,
      niejednoznaczny: false,
      zrodlo: 'pola',
      okres: { miesiac: '2026-01' },
    });
  });

  it('PIT-5L i PIT-5 nie są w wykazie MF: symbol odczytany, bez podatku', () => {
    expect(czytajTytulPrzelewu(`/TI/N${NIP}/OKR/26M01/SFP/PIT-5L/`)).toMatchObject({ symbol: 'PIT-5L', podatek: null, wWykazieMf: false });
    expect(czytajTytulPrzelewu('PIT-5 26M01')).toMatchObject({ symbol: 'PIT-5', podatek: null, wWykazieMf: false });
  });

  it('symbol i okres zapisane w tekście tytułu, małymi literami i bez łącznika', () => {
    expect(czytajTytulPrzelewu('PPE 26M01')).toMatchObject({ symbol: 'PPE', podatek: 'ryczalt', okres: { miesiac: '2026-01' }, zrodlo: 'tekst' });
    expect(czytajTytulPrzelewu('zaliczka ppl za 26m03')).toMatchObject({ symbol: 'PPL', podatek: 'pit', okres: { miesiac: '2026-03' } });
    expect(czytajTytulPrzelewu('PIT28 26M02')).toMatchObject({ symbol: 'PIT-28', podatek: 'ryczalt' });
    expect(czytajTytulPrzelewu('JPK_V7M 26M02')).toMatchObject({ symbol: 'JPK-V7M', podatek: 'vat' });
  });

  it('pola /OKR/ i /SFP/ mają pierwszeństwo przed tekstem, także rozcięte spacją po sklejeniu linii wyciągu', () => {
    expect(czytajTytulPrzelewu(`/TI/N${NIP}/OKR/26M01/SFP/PPE/TXT/KOREKTA 25M12 PPL`)).toMatchObject({
      symbol: 'PPE',
      okres: { miesiac: '2026-01' },
      niejednoznaczny: false,
      zrodlo: 'pola',
    });
    expect(czytajTytulPrzelewu(`/TI/N${NIP}/OKR/26M01/ SFP/PPE/`)).toMatchObject({ symbol: 'PPE', okres: { miesiac: '2026-01' } });
  });

  it('dwa różne okresy albo symbole w tekście: nic nie jest pewne', () => {
    expect(czytajTytulPrzelewu('PPE 26M01 26M02')).toMatchObject({ okres: null, niejednoznaczny: true });
    expect(czytajTytulPrzelewu('PPE PPL 26M01')).toMatchObject({ symbol: null, podatek: null, niejednoznaczny: true });
    // Ten sam okres dwa razy to nadal jeden okres.
    expect(czytajTytulPrzelewu('PPE 26M01 ZA 26M01')).toMatchObject({ okres: { miesiac: '2026-01' }, niejednoznaczny: false });
  });

  it('bez zapisu MF: brak okresu i symbolu, bez zgadywania', () => {
    expect(czytajTytulPrzelewu('Podatek za styczeń 2026')).toEqual({ symbol: null, podatek: null, wWykazieMf: false, okres: null, niejednoznaczny: false, zrodlo: null });
    expect(czytajTytulPrzelewu('PPE 26M13').okres).toBeNull();
    expect(czytajTytulPrzelewu('PPE FV26M01').okres).toBeNull();
    expect(czytajTytulPrzelewu(`/OKR/26M13/SFP/PPE/`).okres).toBeNull();
    expect(czytajTytulPrzelewu(null)).toMatchObject({ symbol: null, okres: null, niejednoznaczny: false });
  });
});

function rozliczenie(over: Partial<RozliczenieZaplaty> & Pick<RozliczenieZaplaty, 'id'>): RozliczenieZaplaty {
  return { miesiac: '2026-09', rodzaj: 'ryczalt', wersja: 1, kwotaGr: 120000, status: 'zatwierdzone', zaplaconeO: null, ...over };
}

function przelewUs(over: Partial<OperacjaPodatkowa> = {}): OperacjaPodatkowa {
  return { id: 'op-us', rodzaj: 'us', bookingDate: '2026-10-15', amountGrosze: -123400, title: `/TI/N${NIP}/OKR/26M09/SFP/PPE/`, ...over };
}

function przelewZus(over: Partial<OperacjaPodatkowa> = {}): OperacjaPodatkowa {
  return { id: 'op-zus', rodzaj: 'zus', bookingDate: '2026-10-15', amountGrosze: -200000, title: null, ...over };
}

const BRAK = new Map<string, string>();
const NBSP = /[  ]/g;
const plain = (text: string | null) => (text ?? '').replace(NBSP, ' ');
const zl = (grosze: number) => plain(formatPaymentMoney(grosze / 100));

describe('propozycja zapłaty: urząd skarbowy', () => {
  const US = [
    rozliczenie({ id: 'ry-09-v1', wersja: 1, kwotaGr: 120000 }),
    rozliczenie({ id: 'ry-09-v2', wersja: 2, kwotaGr: 123400 }),
    rozliczenie({ id: 'vat-09', rodzaj: 'vat', kwotaGr: 50000 }),
    rozliczenie({ id: 'ry-08', miesiac: '2026-08', kwotaGr: 110000, status: 'zaplacone', zaplaconeO: '2026-09-18' }),
    // Okres po dniu przelewu: nie jest do wyboru.
    rozliczenie({ id: 'ry-10', miesiac: '2026-11', kwotaGr: 99000 }),
    // Składki nie są zapłatą do urzędu.
    rozliczenie({ id: 'zus-09', rodzaj: 'zus_spoleczne', kwotaGr: 150000 }),
  ];

  it('pewny okres i symbol z tytułu: przypisanie do najnowszej wersji rozliczenia', () => {
    const p = propozycjaZaplaty(przelewUs(), US, BRAK);
    expect(p.przypisanie).toMatchObject({ sposob: 'tytul', opcja: { ids: ['ry-09-v2'], miesiac: '2026-09', rodzaje: ['ryczalt'], wyliczoneGr: 123400 } });
    expect(p.roznicaGr).toBe(0);
    expect(p.opcje.map((o) => o.ids)).toEqual([['ry-09-v2'], ['vat-09'], ['ry-08']]);
    expect(plain(opisPropozycji(przelewUs(), p))).toContain('Zapłata ryczałtu za wrzesień 2026');
  });

  it('kwota inna niż wyliczona: przypisanie zostaje, różnica jest widoczna, wyliczenie bez zmian', () => {
    const op = przelewUs({ amountGrosze: -125000 });
    const p = propozycjaZaplaty(op, US, BRAK);
    expect(p.przypisanie?.opcja.ids).toEqual(['ry-09-v2']);
    expect(p.przypisanie?.opcja.wyliczoneGr).toBe(123400);
    expect(p.roznicaGr).toBe(1600);
    const tekst = plain(opisPropozycji(op, p));
    expect(tekst).toContain(`o ${zl(1600)} więcej`);
    expect(tekst).toContain(zl(123400));
    expect(tekst).toContain('wyliczenie zostaje bez zmian');
    expect(plain(opisPropozycji(przelewUs({ amountGrosze: -120000 }), propozycjaZaplaty(przelewUs({ amountGrosze: -120000 }), US, BRAK)))).toContain(
      `o ${zl(3400)} mniej`,
    );
  });

  it('bez okresu w tytule: bez przypisania, rozliczenia do wyboru', () => {
    const p = propozycjaZaplaty(przelewUs({ title: 'RYCZALT ZA WRZESIEN' }), US, BRAK);
    expect(p.przypisanie).toBeNull();
    expect(p.powod).toContain('okresu');
    expect(p.opcje.map((o) => o.ids[0])).toContain('ry-09-v2');
  });

  it('okres roczny, symbol spoza wykazu albo dwa okresy: bez przypisania', () => {
    expect(propozycjaZaplaty(przelewUs({ title: `/TI/N${NIP}/OKR/26R/SFP/PIT-28/` }), US, BRAK)).toMatchObject({ przypisanie: null });
    expect(propozycjaZaplaty(przelewUs({ title: `/TI/N${NIP}/OKR/26R/SFP/PIT-28/` }), US, BRAK).powod).toContain('rok');
    expect(propozycjaZaplaty(przelewUs({ title: `/TI/N${NIP}/OKR/26M09/SFP/PIT-5L/` }), US, BRAK)).toMatchObject({ przypisanie: null });
    expect(propozycjaZaplaty(przelewUs({ title: `/TI/N${NIP}/OKR/26M09/SFP/PIT-5L/` }), US, BRAK).powod).toContain('PIT-5L');
    expect(propozycjaZaplaty(przelewUs({ title: 'PPE 26M08 26M09' }), US, BRAK)).toMatchObject({ przypisanie: null });
  });

  it('okres z tytułu bez zatwierdzonego rozliczenia: bez przypisania, z nazwą miesiąca', () => {
    const p = propozycjaZaplaty(przelewUs({ title: `/TI/N${NIP}/OKR/26M07/SFP/PPE/` }), US, BRAK);
    expect(p.przypisanie).toBeNull();
    expect(p.powod).toContain('lipiec 2026');
  });

  it('rozliczenie potwierdzone już innym przelewem: bez przypisania i bez tej opcji', () => {
    const p = propozycjaZaplaty(przelewUs(), US, new Map([['ry-09-v2', 'op-inny']]));
    expect(p.przypisanie).toBeNull();
    expect(p.opcje.map((o) => o.ids[0])).not.toContain('ry-09-v2');
    // Ta sama operacja po odświeżeniu nie blokuje sama siebie.
    expect(propozycjaZaplaty(przelewUs(), US, new Map([['ry-09-v2', 'op-us']])).przypisanie?.opcja.ids).toEqual(['ry-09-v2']);
  });
});

describe('propozycja zapłaty: ZUS', () => {
  const ZUS = [
    rozliczenie({ id: 'sp-09', rodzaj: 'zus_spoleczne', kwotaGr: 150000 }),
    rozliczenie({ id: 'zd-09', rodzaj: 'zdrowotna', kwotaGr: 50000 }),
    rozliczenie({ id: 'sp-08', miesiac: '2026-08', rodzaj: 'zus_spoleczne', kwotaGr: 150000, status: 'zaplacone', zaplaconeO: '2026-09-18' }),
    rozliczenie({ id: 'zd-08', miesiac: '2026-08', rodzaj: 'zdrowotna', kwotaGr: 50000, status: 'zaplacone', zaplaconeO: '2026-09-18' }),
    rozliczenie({ id: 'ry-09', kwotaGr: 50000 }),
  ];

  it('kwota równa składkom jednego niezapłaconego miesiąca: zapłata ZUS za ten miesiąc', () => {
    const p = propozycjaZaplaty(przelewZus(), ZUS, BRAK);
    expect(p.przypisanie).toMatchObject({ sposob: 'kwota', opcja: { ids: ['sp-09', 'zd-09'], miesiac: '2026-09', wyliczoneGr: 200000 } });
    expect(p.roznicaGr).toBe(0);
    expect(plain(opisPropozycji(przelewZus(), p))).toContain('Zapłata ZUS za wrzesień 2026');
    // Ryczałt nie jest składką.
    expect(p.opcje.flatMap((o) => o.ids)).not.toContain('ry-09');
  });

  it('ta sama kwota w dwóch niezapłaconych miesiącach: wybór klienta', () => {
    const dwa = ZUS.map((r) => (r.miesiac === '2026-08' ? { ...r, status: 'zatwierdzone' as const, zaplaconeO: null } : r));
    const p = propozycjaZaplaty(przelewZus(), dwa, BRAK);
    expect(p.przypisanie).toBeNull();
    expect(p.powod).toContain('kilka miesięcy');
    expect(p.opcje.filter((o) => o.wyliczoneGr === 200000).map((o) => o.miesiac)).toEqual(['2026-09', '2026-08']);
  });

  it('osobny przelew składki zdrowotnej: przypisanie tylko do niej', () => {
    const p = propozycjaZaplaty(przelewZus({ amountGrosze: -50000 }), ZUS, BRAK);
    expect(p.przypisanie?.opcja).toMatchObject({ ids: ['zd-09'], rodzaje: ['zdrowotna'] });
  });

  it('składki społeczne z kwotą zero (ulga na start): tylko zdrowotna do wyboru', () => {
    const ulga = [rozliczenie({ id: 'sp-09', rodzaj: 'zus_spoleczne', kwotaGr: 0 }), rozliczenie({ id: 'zd-09', rodzaj: 'zdrowotna', kwotaGr: 50000 })];
    const p = propozycjaZaplaty(przelewZus({ amountGrosze: -50000 }), ulga, BRAK);
    expect(p.przypisanie?.opcja.ids).toEqual(['zd-09']);
    expect(p.opcje).toHaveLength(1);
  });

  it('kwota nie pasuje do żadnego miesiąca: bez przypisania, miesiące do wyboru z różnicą', () => {
    const p = propozycjaZaplaty(przelewZus({ amountGrosze: -123456 }), ZUS, BRAK);
    expect(p.przypisanie).toBeNull();
    expect(p.powod).toContain('nie jest równa');
    expect(p.opcje[0]).toMatchObject({ ids: ['sp-09', 'zd-09'] });
  });

  it('niedopłata składek przy wyborze ręcznym: komunikat mówi, że odliczenie liczy się od kwoty wyliczonej (dopisane po kodzie)', () => {
    const wspolne = { status: 'confirmed' as const, okres: '2026-09', paidOn: '2026-10-15', computedGr: 200000, marked: 2 };
    const zus = plain(taxConfirmedText({ ...wspolne, rodzaj: 'zus', rodzaje: ['zdrowotna', 'zus_spoleczne'], differenceGr: -5000 }));
    expect(zus).toContain('Zapisano zapłatę ZUS za wrzesień 2026 (składki społeczne i zdrowotna) z dniem 15.10.2026.');
    expect(zus).toContain(`o ${zl(5000)} mniej`);
    expect(zus).toContain('liczy się od kwoty wyliczonej');
    expect(plain(taxConfirmedText({ ...wspolne, rodzaj: 'zus', rodzaje: ['zdrowotna', 'zus_spoleczne'], differenceGr: 5000 }))).not.toContain('Odliczenie');
    expect(plain(taxConfirmedText({ ...wspolne, rodzaj: 'us', rodzaje: ['ryczalt'], differenceGr: -5000 }))).not.toContain('Odliczenie');
  });

  it('bez zatwierdzonych składek: bez propozycji, z drogą do „Ten miesiąc”', () => {
    const p = propozycjaZaplaty(przelewZus(), [rozliczenie({ id: 'ry-09' })], BRAK);
    expect(p).toMatchObject({ przypisanie: null, opcje: [] });
    expect(p.powod).toContain('„Ten miesiąc”');
  });
});
