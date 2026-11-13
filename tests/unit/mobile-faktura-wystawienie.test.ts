import { describe, expect, it } from 'vitest';

import { doWartosciFormularza, fakturaTelefonuSchema } from '@/lib/api/mobile/schematy';
import { parseRegularInvoiceForm } from '@/lib/invoices/issue-regular';

import { cenaPozycji, type Faktura } from '../../mobile/src/dane-przykladowe';
import {
  doFakturyTelefonu,
  kluczZapisu,
  nabywcyZFaktur,
  poleFormularza,
  type FormularzZwyklej,
} from '../../mobile/src/lib/faktura/wystawienie';

/**
 * Plan aplikacji mobilnej, M8: formularz telefonu na treść `POST /faktury`.
 * Wynik przechodzi kontrakt (schemat telefonu) i prawdziwy schemat formularza
 * strony (`parseRegularInvoiceForm`), czyli serwer przyjmie fakturę bez błędu.
 */

const formularz = (extra: Partial<FormularzZwyklej> = {}): FormularzZwyklej => ({
  numer: ' FV/3/11/2026 ',
  dataWystawienia: '2026-11-13',
  dataSprzedazy: '2026-11-13',
  terminDni: 14,
  rodzajNabywcy: 'firma',
  nip: '525-224-15-85',
  nazwa: 'Klient Sp. z o.o.',
  adres1: 'ul. Kliencka 3',
  adres2: '00-003 Warszawa',
  email: '',
  metoda: 'Przelew',
  rachunek: 'PL61 1090 1014 0000 0712 1981 2874',
  mpp: false,
  pozycje: [
    { nazwa: 'Projekt', ilosc: '1,5', jednostka: 'godz.', cena: '1 200,1234', stawka: '23' },
    { nazwa: 'Szkolenie', ilosc: '1', jednostka: '', cena: '500', stawka: 'zw' },
  ],
  uwagi: '',
  ...extra,
});

describe('formularz telefonu na treść żądania', () => {
  it('przechodzi kontrakt i schemat formularza strony', () => {
    const f = doFakturyTelefonu(formularz());
    expect(fakturaTelefonuSchema.safeParse(f).success).toBe(true);
    const parsed = parseRegularInvoiceForm(doWartosciFormularza(f));
    expect(parsed).toMatchObject({ ok: true });
  });

  it('wartości jak z formularza strony: numer bez spacji, NIP cyframi, sprzedaż = wystawienie jako pusta, termin z dni', () => {
    const f = doFakturyTelefonu(formularz());
    expect(f).toMatchObject({
      internalNumber: 'FV/3/11/2026',
      buyerNip: '5252241585',
      saleDate: '',
      paymentDueDate: '2026-11-27',
      paymentMethod: 'transfer',
      bankAccount: 'PL61109010140000071219812874',
      buyerIsConsumer: false,
    });
  });

  it('ceny i ilości bez zaokrąglania do groszy, stawka zw zostaje zw (nie 0%)', () => {
    const f = doFakturyTelefonu(formularz());
    expect(f.lines).toEqual([
      { name: 'Projekt', unit: 'godz.', quantity: 1.5, unitPriceNet: 1200.1234, vatRate: '23' },
      { name: 'Szkolenie', unit: 'szt', quantity: 1, unitPriceNet: 500, vatRate: 'zw' },
    ]);
  });

  it('osoba prywatna bez NIP; gotówka bez rachunku; inna data sprzedaży zostaje', () => {
    const f = doFakturyTelefonu(formularz({ rodzajNabywcy: 'osoba', nip: '123', metoda: 'Gotówka', dataSprzedazy: '2026-11-10' }));
    expect(f).toMatchObject({ buyerIsConsumer: true, buyerNip: '', paymentMethod: 'cash', bankAccount: '', saleDate: '2026-11-10' });
    expect(parseRegularInvoiceForm(doWartosciFormularza(f))).toMatchObject({ ok: true });
  });

  it('błędna cena daje błąd schematu strony z polem pozycji', () => {
    const f = doFakturyTelefonu(formularz({ pozycje: [{ nazwa: 'X', ilosc: '1', jednostka: 'szt', cena: 'abc', stawka: '23' }] }));
    const parsed = parseRegularInvoiceForm(doWartosciFormularza(f));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(poleFormularza(parsed.path.join('.'))).toBe('pozycje');
  });
});

describe('pole błędu z serwera na pole telefonu', () => {
  it.each([
    ['buyerName', 'nazwa'],
    ['buyerNip', 'nip'],
    ['buyerAddressLine2', 'adres'],
    ['lines.0.name', 'pozycje'],
    ['internalNumber', 'numer'],
    ['issueDate', 'numer'],
    ['bankAccount', 'rachunek'],
    ['paymentDueDate', 'termin'],
    [undefined, 'ogolny'],
  ])('%s → %s', (pole, oczekiwane) => {
    expect(poleFormularza(pole)).toBe(oczekiwane);
  });
});

describe('nabywcy z ostatnich faktur', () => {
  const f = (extra: Partial<Faktura>): Faktura => ({
    id: 'x', numer: 'FV/1', kontrahent: 'Klient', nipKontrahenta: '5252241585', dataWystawienia: '2026-11-01',
    terminPlatnosci: '2026-11-15', brutto: 100, netto: 81, statusKsef: 'przyjeta', zaplacona: false, pozycje: [],
    rodzaj: 'vat', metodaPlatnosci: 'Przelew', nabywcaTyp: 'firma', adresKontrahentaLinie: { linia1: 'ul. A 1', linia2: '00-001 Warszawa' }, ...extra,
  });

  it('najnowsze pierwsze, bez powtórzeń, bez faktur bez adresu i korekt; termin z ostatniej faktury', () => {
    const lista = nabywcyZFaktur([
      f({ id: '1', terminPlatnosci: '2026-12-01' }),
      f({ id: '2', kontrahent: 'Klient (stara nazwa)' }),
      f({ id: '3', kontrahent: 'Bez adresu', nipKontrahenta: '1234567890', adresKontrahentaLinie: undefined }),
      f({ id: '4', kontrahent: 'Jan Kowalski', nipKontrahenta: '', nabywcaTyp: 'osoba' }),
      f({ id: '5', kontrahent: 'Korekta', nipKontrahenta: '9999999999', rodzaj: 'korygujaca' }),
    ]);
    expect(lista).toEqual([
      { nazwa: 'Klient', nip: '5252241585', osoba: false, adres1: 'ul. A 1', adres2: '00-001 Warszawa', email: '', terminDni: 30 },
      { nazwa: 'Jan Kowalski', nip: '', osoba: true, adres1: 'ul. A 1', adres2: '00-001 Warszawa', email: '', terminDni: 14 },
    ]);
  });
});

describe('klucz zapisu', () => {
  it('UUID v4, za każdym razem inny', () => {
    const a = kluczZapisu();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(kluczZapisu()).not.toBe(a);
    expect(kluczZapisu((b) => b.fill(0))).toBe('00000000-0000-4000-8000-000000000000');
  });
});

// ─── Przegląd #716 (drugi czytelnik): ustalenia 1 do 3 ───────────────

import { calculateLineItem } from '@/lib/xml/invoice-calculator';

import { fakturaZBazy } from '../../mobile/src/lib/dane/mapowanie';
import {
  bladFirmyZapisu,
  kopiaNaTelefonie,
  kwotyPozycji,
  liczbaZPola,
  stawkaTelefonu,
} from '../../mobile/src/lib/faktura/wystawienie';

/** Wiersz faktury z bazy jak w `KOLUMNY_FAKTURY` (nabywca z UE: `buyer_nip` NULL, `is_b2c` false). */
const zBazy = (zmiany: Record<string, unknown> = {}) =>
  fakturaZBazy({
    id: 'inv-1', internal_number: 'FV/1/11/2026', invoice_kind: 'regular', issue_date: '2026-11-01',
    payment_due_date: '2026-11-15', ksef_status: 'accepted', net_total: 100, vat_total: 23, gross_total: 123, currency: 'PLN',
    buyer_nip: '5252241585', is_b2c: false, buyer_id_type: 'nip',
    buyer_data: { name: 'Klient', nip: '5252241585', address: { addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
    invoice_line_items: [{ ordinal: 1, name: 'Usługa', unit: 'szt', quantity: 3, unit_price_net: 33.3333, vat_rate: '23', net_amount: 100, vat_amount: 23, gross_amount: 123 }],
    ...zmiany,
  } as never);

const UE = { buyer_nip: null, is_b2c: false, buyer_id_type: 'nip', buyer_data: { name: 'Kunde GmbH', vatUeNumber: 'DE123456789', address: { countryCode: 'DE', addressLine1: 'Hauptstr. 1', addressLine2: '10115 Berlin' } } };

describe('1: nabywca z UE i stawka spoza telefonu nie przechodzą jako osoba prywatna i 0%', () => {
  it('faktura dla firmy z UE: nie ma jej na liście nabywców (nie stanie się osobą prywatną)', () => {
    expect(nabywcyZFaktur([zBazy(UE)])).toEqual([]);
  });

  it('osoba prywatna z PESEL albo dokumentem: nie na liście (telefon zna tylko „bez numeru”)', () => {
    expect(nabywcyZFaktur([zBazy({ buyer_nip: null, is_b2c: true, buyer_id_type: 'pesel', buyer_data: { name: 'Jan', address: { addressLine1: 'a', addressLine2: 'b' } } })])).toEqual([]);
  });

  it('firma z NIP i osoba bez numeru zostają na liście z właściwym rodzajem', () => {
    const lista = nabywcyZFaktur([
      zBazy(),
      zBazy({ id: 'inv-2', buyer_nip: null, is_b2c: true, buyer_id_type: 'no_id', buyer_data: { name: 'Jan Kowalski', address: { addressLine1: 'a', addressLine2: 'b' } } }),
    ]);
    expect(lista.map((n) => [n.nazwa, n.osoba])).toEqual([['Klient', false], ['Jan Kowalski', true]]);
  });

  it('„Duplikuj” na telefonie tylko dla zwykłej faktury w PLN z nabywcą i stawkami, które telefon zna', () => {
    expect(kopiaNaTelefonie(zBazy())).toBe(true);
    expect(kopiaNaTelefonie(zBazy(UE))).toBe(false);
    expect(kopiaNaTelefonie(zBazy({ invoice_line_items: [{ ordinal: 1, name: 'Usługa', unit: 'szt', quantity: 1, unit_price_net: 100, vat_rate: 'np_ii' }] }))).toBe(false);
    expect(kopiaNaTelefonie(zBazy({ currency: 'EUR' }))).toBe(false);
  });

  it('stawka spoza telefonu nie zamienia się w 0% ani 23%', () => {
    expect(stawkaTelefonu('np_ii')).toBeNull();
    expect(stawkaTelefonu('0 WDT')).toBeNull();
    expect(stawkaTelefonu('zw')).toBe('zw');
    const f = doFakturyTelefonu(formularz({ pozycje: [{ nazwa: 'X', ilosc: '1', jednostka: 'szt', cena: '10', stawka: 'np_ii' }] }));
    expect(f.lines[0]!.vatRate).toBe('np_ii');
  });
});

describe('2: firma formularza przy zapisie', () => {
  it('zapis w innej firmie niż ta, w której otwarto formularz: odmowa z instrukcją', () => {
    expect(bladFirmyZapisu('firma-a', 'firma-a')).toBeNull();
    expect(bladFirmyZapisu('firma-a', 'firma-b')).toMatch(/Zamknij formularz/);
    expect(bladFirmyZapisu('firma-a', null)).toMatch(/Zamknij formularz/);
  });
});

describe('3: kwoty pozycji jak na serwerze (4 miejsca po przecinku, bez zaokrąglania ceny)', () => {
  it.each([
    ['3', '33,3333', '23'],
    ['1000', '6,4599', '23'],
    ['1 000', '0,0049', '23'],
    ['1,5', '200,5', '8'],
    ['2', '0', '23'],
    ['1', '-100,01', '23'],
  ])('%s × %s, VAT %s: te same grosze co calculateLineItem', (ilosc, cena, stawka) => {
    const k = kwotyPozycji({ nazwa: 'X', ilosc, jednostka: 'szt', cena, stawka });
    const serwer = calculateLineItem({ quantity: liczbaZPola(ilosc), unitPriceNet: liczbaZPola(cena), vatRate: stawka as '23' });
    expect(k).toEqual({ netto: Math.round(serwer.netAmount * 100), vat: Math.round(serwer.vatAmount * 100), brutto: Math.round(serwer.grossAmount * 100) });
  });

  it('3 × 33,3333 to 100,00 + 23,00 = 123,00 (nie 99,99), a „1 000” to tysiąc', () => {
    expect(kwotyPozycji({ nazwa: 'X', ilosc: '3', jednostka: 'szt', cena: '33,3333', stawka: '23' })).toEqual({ netto: 10000, vat: 2300, brutto: 12300 });
    expect(kwotyPozycji({ nazwa: 'X', ilosc: '1 000', jednostka: 'szt', cena: '0,0049', stawka: '23' })).toEqual({ netto: 490, vat: 113, brutto: 603 });
  });

  it('kopia faktury z bazy zachowuje cenę z 4 miejscami (nie obcina do groszy)', () => {
    expect(zBazy().pozycje[0]!.cenaTekst).toBe('33,3333');
  });

  it('cena w wierszu pozycji i podglądzie: 33,3333 zł, nie 33,33 zł; bez 4 miejsc zwykłe grosze', () => {
    expect(cenaPozycji(zBazy().pozycje[0]!)).toBe('33,3333\u00a0zł');
    expect(cenaPozycji({ nazwa: 'x', ilosc: 1, jednostka: 'szt.', cenaNetto: 1050, stawkaVat: 23, cenaTekst: '10,5' })).toBe('10,50\u00a0zł');
    expect(cenaPozycji({ nazwa: 'x', ilosc: 1, jednostka: 'szt.', cenaNetto: 1050, stawkaVat: 23 })).toBe('10,50\u00a0zł');
  });
});
