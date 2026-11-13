import { describe, expect, it } from 'vitest';

import { doWartosciFormularza, fakturaTelefonuSchema } from '@/lib/api/mobile/schematy';
import { parseRegularInvoiceForm } from '@/lib/invoices/issue-regular';

import type { Faktura } from '../../mobile/src/dane-przykladowe';
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
    rodzaj: 'vat', metodaPlatnosci: 'Przelew', adresKontrahentaLinie: { linia1: 'ul. A 1', linia2: '00-001 Warszawa' }, ...extra,
  });

  it('najnowsze pierwsze, bez powtórzeń, bez faktur bez adresu i korekt; termin z ostatniej faktury', () => {
    const lista = nabywcyZFaktur([
      f({ id: '1', terminPlatnosci: '2026-12-01' }),
      f({ id: '2', kontrahent: 'Klient (stara nazwa)' }),
      f({ id: '3', kontrahent: 'Bez adresu', nipKontrahenta: '1234567890', adresKontrahentaLinie: undefined }),
      f({ id: '4', kontrahent: 'Jan Kowalski', nipKontrahenta: '' }),
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
