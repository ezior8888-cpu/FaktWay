import { describe, expect, it } from 'vitest';

import { matchInvoice, type MatchCandidate } from '@/lib/import/bank/dopasowanie';
import { operationKeys } from '@/lib/import/bank/klucz';
import { canonicalKsefNumber, ksefNumbersInText } from '@/lib/import/bank/numer-ksef';
import type { BankOperation } from '@/lib/import/bank/typy';

/**
 * Duplikaty i dopasowanie wpłat do faktur sprzedaży (plan kompletnej
 * aplikacji, krok 3.2, część 1). Dopasowanie to zawsze propozycja: zapis wpłaty
 * robi dopiero „Potwierdź” klienta (`confirm_bank_operation`, 00180).
 */

const RACHUNEK = 'PL61109010140000071219812874';
const KONTRAHENT = 'PL27114020040000300201355387';
const KSEF = '1234567890-20261105-0A1B2C-3D4E5F-6A';

function op(over: Partial<BankOperation> = {}): BankOperation {
  return {
    account: RACHUNEK,
    bookingDate: '2026-11-05',
    valueDate: '2026-11-05',
    amountGrosze: 123000,
    currency: 'PLN',
    counterpartyName: 'ŻÓŁTA ŁÓDŹ SP. Z O.O. UL. KRÓTKA 1 00-950 WARSZAWA',
    counterpartyAccount: KONTRAHENT,
    title: 'Przelew',
    bankReference: null,
    ...over,
  };
}

describe('klucz duplikatu', () => {
  it('ta sama operacja z drugiego, dłuższego pliku ma ten sam klucz; nowa operacja nowy', () => {
    const a = op();
    const b = op({ amountGrosze: 50000, title: 'FV/2/2026' });
    const [first] = operationKeys([a]);
    const [again, other] = operationKeys([a, b]);
    expect(first).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });

  it('dwie identyczne operacje jednego dnia w jednym pliku to dwa klucze, a ten sam plik drugi raz daje te same', () => {
    const keys = operationKeys([op(), op()]);
    expect(new Set(keys).size).toBe(2);
    expect(operationKeys([op(), op()])).toEqual(keys);
  });

  it('ta sama operacja z MT940 i z CSV tego samego banku (inny zapis tytułu i referencji) ma ten sam klucz', () => {
    const z940 = op({ title: 'Zapłata za fakturę FV/12/11/2026 dziękujemy', bankReference: '3370500600001400' });
    const zCsv = op({ title: 'Zapłata za fakturę numer FV/12/11/2026', bankReference: '3370523300000016', counterpartyAccount: '27114020040000300201355387' });
    expect(operationKeys([z940])).toEqual(operationKeys([zCsv]));
  });

  it('inny rachunek, dzień, kwota albo nadawca to inna operacja', () => {
    const [base] = operationKeys([op()]);
    for (const changed of [
      op({ account: 'PL10105000997603123456789123' }),
      op({ bookingDate: '2026-11-06' }),
      op({ amountGrosze: 123001 }),
      op({ amountGrosze: -123000 }),
      op({ counterpartyAccount: null }),
    ]) {
      expect(operationKeys([changed])[0]).not.toBe(base);
    }
  });
});

describe('numer KSeF w tytule (wzorzec TNumerKSeF ze schematu FA(3))', () => {
  it('znajduje numer z myślnikiem i bez myślnika środkowego, także rozcięty spacją', () => {
    const canonical = canonicalKsefNumber(KSEF);
    expect(canonical).toBe('1234567890-20261105-0A1B2C3D4E5F-6A');
    expect(ksefNumbersInText(`Zapłata ${KSEF} dziękuję`)).toEqual([canonical]);
    expect(ksefNumbersInText('za 1234567890-20261105-0a1b2c3d4e5f-6a')).toEqual([canonical]);
    expect(ksefNumbersInText('za 1234567890-20261105-0A1B2C-3D4E 5F-6A')).toEqual([canonical]);
  });

  it('nie bierze napisu spoza wzorca (zła data, za krótka część, NIP z zerem na drugim miejscu)', () => {
    expect(ksefNumbersInText('1234567890-20261341-0A1B2C3D4E5F-6A')).toEqual([]);
    expect(ksefNumbersInText('1234567890-20261105-0A1B2C3D4E5-6A')).toEqual([]);
    expect(ksefNumbersInText('1004567890-20261105-0A1B2C3D4E5F-6A')).toEqual([]);
    expect(canonicalKsefNumber('nie numer')).toBeNull();
  });
});

const faktury: MatchCandidate[] = [
  { id: 'f-ksef', number: 'FV/12/11/2026', ksefNumber: KSEF, outstandingGrosze: 123000, buyerName: 'Żółta Łódź sp. z o.o.' },
  { id: 'f-1', number: 'FV/1/2026', ksefNumber: null, outstandingGrosze: 50000, buyerName: 'Inny Nabywca' },
  { id: 'f-11', number: 'FV/11/2026', ksefNumber: null, outstandingGrosze: 70000, buyerName: 'Inny Nabywca' },
  { id: 'f-krotki', number: '7/2026', ksefNumber: null, outstandingGrosze: 99900, buyerName: 'Kowalski' },
];

describe('dopasowanie wpłaty do faktury', () => {
  it('numer KSeF w tytule: pewność wysoka, cała reszta', () => {
    expect(matchInvoice(op({ title: `Płatność ${KSEF}` }), faktury)).toEqual({
      kind: 'ksef_number', invoiceId: 'f-ksef', confidence: 'high', amount: 'full',
    });
  });

  it('numer KSeF ma pierwszeństwo przed numerem innej faktury w tym samym tytule', () => {
    expect(matchInvoice(op({ title: `FV/1/2026 ${KSEF}`, amountGrosze: 1000 }), faktury)).toMatchObject({
      kind: 'ksef_number', invoiceId: 'f-ksef', amount: 'partial',
    });
  });

  it('numer KSeF niezapłaconej faktury nie występuje: brak propozycji z informacją o numerze', () => {
    expect(matchInvoice(op({ title: '9876543210-20261105-0A1B2C3D4E5F-6A' }), faktury)).toEqual({ kind: 'none', unknownKsefNumber: true });
  });

  it('numer faktury w tytule (inne litery, spacje, ukośniki): pewność średnia, wpłata częściowa', () => {
    expect(matchInvoice(op({ title: 'zaplata fv 12/11/2026', amountGrosze: 30000 }), faktury)).toEqual({
      kind: 'invoice_number', invoiceId: 'f-ksef', confidence: 'medium', amount: 'partial',
    });
    expect(matchInvoice(op({ title: 'FV-1-2026', amountGrosze: 50000 }), faktury)).toMatchObject({ invoiceId: 'f-1', amount: 'full' });
  });

  it('granice numeru: FV/1/2026 nie pasuje do FV/11/2026, a 7/2026 do 17/2026', () => {
    expect(matchInvoice(op({ title: 'FV/11/2026', amountGrosze: 70000 }), faktury)).toMatchObject({ invoiceId: 'f-11' });
    expect(matchInvoice(op({ title: 'faktura 17/2026', counterpartyName: 'Nikt' }), faktury)).toEqual({ kind: 'none', unknownKsefNumber: false });
  });

  it('dwie faktury w jednym tytule: bez propozycji, wybór ręczny', () => {
    expect(matchInvoice(op({ title: 'FV/1/2026 i FV/11/2026', amountGrosze: 120000 }), faktury)).toEqual({
      kind: 'ambiguous', invoiceIds: ['f-1', 'f-11'],
    });
  });

  it('wpłata ponad resztę do zapłaty: propozycja z oznaczeniem nadpłaty (zapis odmówi)', () => {
    expect(matchInvoice(op({ title: KSEF, amountGrosze: 123001 }), faktury)).toMatchObject({ kind: 'ksef_number', amount: 'over' });
  });

  it('kwota równa reszcie i nazwa nabywcy: podpowiedź o niskiej pewności', () => {
    expect(matchInvoice(op({ title: 'przelew', amountGrosze: 123000 }), faktury)).toEqual({
      kind: 'amount_name', invoiceId: 'f-ksef', confidence: 'low', amount: 'full',
    });
  });

  it('sama kwota bez nazwy nabywcy nie wystarcza', () => {
    expect(matchInvoice(op({ title: 'przelew', amountGrosze: 123000, counterpartyName: 'Ktoś Inny' }), faktury)).toEqual({
      kind: 'none', unknownKsefNumber: false,
    });
  });

  it('dwie faktury cykliczne na tę samą kwotę dla tego samego nabywcy: bez propozycji', () => {
    const cykliczne: MatchCandidate[] = [
      { id: 'c-1', number: 'FV/1/10/2026', ksefNumber: null, outstandingGrosze: 49900, buyerName: 'Abonent Testowy' },
      { id: 'c-2', number: 'FV/1/11/2026', ksefNumber: null, outstandingGrosze: 49900, buyerName: 'Abonent Testowy' },
    ];
    expect(matchInvoice(op({ title: 'abonament', amountGrosze: 49900, counterpartyName: 'ABONENT TESTOWY UL. POLNA 1' }), cykliczne)).toEqual({
      kind: 'ambiguous', invoiceIds: ['c-1', 'c-2'],
    });
  });

  it('obciążenie nigdy nie dostaje propozycji', () => {
    expect(matchInvoice(op({ title: KSEF, amountGrosze: -123000 }), faktury)).toEqual({ kind: 'none', unknownKsefNumber: false });
  });
});
