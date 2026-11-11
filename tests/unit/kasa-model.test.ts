import { describe, expect, it } from 'vitest';

import {
  buildCashReport,
  canWriteCash,
  cashDelta,
  cashDocumentNumber,
  cashKindTitle,
  parseCashAmount,
  parseCashDocumentRow,
  parseCashReportRpc,
  resolveCashPeriod,
  type CashReportDocument,
} from '@/lib/kasa/model';
import { cashCorrectionSchema, cashDocumentSchema, cashOpeningSchema } from '@/lib/kasa/schemat';
import {
  CASH_ROLE_REFUSAL,
  correctionRefusalText,
  issueRefusalText,
  openingRefusalText,
} from '@/lib/kasa/teksty';

/**
 * Kasa (plan kompletnej aplikacji, krok 3.7): dowody wpłaty (KP) i wypłaty
 * (KW) gotówki oraz raport kasowy. Tu część bez bazy: numer, kierunek
 * operacji, raport za okres (stan na początek, wpłaty, wypłaty, stan na
 * koniec, stan po każdym dowodzie), schematy pól i teksty odmów z wyjściem.
 * Numer, blokadę serii, stan kasy przy wystawieniu i niezmienność sprawdza
 * baza (tests/rls-kasa.test.ts, job CI „RLS isolation”).
 */

const NBSP = /[  ]/g;
const plain = (text: string) => text.replace(NBSP, ' ');

function dowod(over: Partial<CashReportDocument> = {}): CashReportDocument {
  return {
    id: 'd-1',
    kind: 'KP',
    number: 'KP/1/2026',
    operationDate: '2026-11-03',
    issueDate: '2026-11-03',
    amount: 100,
    title: 'Zapłata za fakturę FV/1/2026',
    counterpartyName: 'Jan Kowalski',
    invoiceNumber: null,
    correctsNumber: null,
    correctedByNumber: null,
    issuedAt: '2026-11-03T09:00:00.000Z',
    ...over,
  };
}

describe('numer i kierunek operacji', () => {
  it('numer z serii: rodzaj, kolejny numer i rok, bez zer wiodących', () => {
    expect(cashDocumentNumber('KP', 3, 2026)).toBe('KP/3/2026');
    expect(cashDocumentNumber('KW', 12, 2027)).toBe('KW/12/2027');
  });

  it('KP dodaje gotówkę, KW ją zabiera; korekta (kwota ujemna) działa odwrotnie', () => {
    expect(cashDelta('KP', 100)).toBe(100);
    expect(cashDelta('KW', 100)).toBe(-100);
    expect(cashDelta('KP', -100)).toBe(-100);
    expect(cashDelta('KW', -40.5)).toBe(40.5);
  });

  it('pełna nazwa dowodu po polsku', () => {
    expect(cashKindTitle('KP')).toBe('KP Dowód wpłaty');
    expect(cashKindTitle('KW')).toBe('KW Dowód wypłaty');
  });

  it('dowody wystawia właściciel, administrator i członek; księgowa ma wgląd', () => {
    expect(['owner', 'admin', 'member'].map(canWriteCash)).toEqual([true, true, true]);
    expect(canWriteCash('accountant')).toBe(false);
    expect(canWriteCash(undefined)).toBe(false);
    expect(CASH_ROLE_REFUSAL).toBe('Dowody kasowe wystawia właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.');
  });
});

describe('kwota z pola formularza', () => {
  it.each([
    ['300', 300],
    ['1 234,56', 1234.56],
    ['0,30', 0.3],
    ['12.5', 12.5],
  ])('%s → %s', (text, value) => {
    expect(parseCashAmount(text)).toBe(value);
  });

  it.each(['', '0', '-5', '1,005', 'abc', '12,3,4'])('%s → null (kwota dowodu musi być większa od zera)', (text) => {
    expect(parseCashAmount(text)).toBeNull();
  });

  it('stan początkowy może być zerem', () => {
    expect(parseCashAmount('0', { allowZero: true })).toBe(0);
    expect(parseCashAmount('0,00', { allowZero: true })).toBe(0);
    expect(parseCashAmount('-1', { allowZero: true })).toBeNull();
  });
});

describe('raport kasowy za okres', () => {
  const base = {
    from: '2026-11-01',
    to: '2026-11-30',
    openingDate: '2026-10-01',
    balanceBefore: 50,
  };

  it('stan na początek, wpłaty, wypłaty, stan na koniec i stan po każdym dowodzie', () => {
    const report = buildCashReport({
      ...base,
      documents: [
        dowod({ id: 'a', kind: 'KP', number: 'KP/1/2026', amount: 100, operationDate: '2026-11-03' }),
        dowod({ id: 'b', kind: 'KW', number: 'KW/1/2026', amount: 30.5, operationDate: '2026-11-04' }),
        dowod({ id: 'c', kind: 'KP', number: 'KP/2/2026', amount: 0.1, operationDate: '2026-11-05' }),
        dowod({ id: 'd', kind: 'KP', number: 'KP/3/2026', amount: 0.2, operationDate: '2026-11-05' }),
      ],
    });

    expect(report.balanceStart).toBe(50);
    // 0,1 + 0,2 liczone przez roundToCents: 0,3, a nie 0,30000000000000004.
    expect(report.receipts).toBe(100.3);
    expect(report.payouts).toBe(30.5);
    expect(report.balanceEnd).toBe(119.8);
    expect(report.rows.map((row) => [row.number, row.receipt, row.payout, row.balance])).toEqual([
      ['KP/1/2026', 100, null, 150],
      ['KW/1/2026', null, 30.5, 119.5],
      ['KP/2/2026', 0.1, null, 119.6],
      ['KP/3/2026', 0.2, null, 119.8],
    ]);
    expect(report.belowZero).toBe(false);
  });

  it('w obrębie dnia najpierw wpłaty, potem wypłaty (stan liczony na koniec dnia)', () => {
    const report = buildCashReport({
      ...base,
      balanceBefore: 0,
      documents: [
        dowod({ id: 'kw', kind: 'KW', number: 'KW/1/2026', amount: 80, operationDate: '2026-11-03', issuedAt: '2026-11-03T08:00:00.000Z' }),
        dowod({ id: 'kp', kind: 'KP', number: 'KP/1/2026', amount: 100, operationDate: '2026-11-03', issuedAt: '2026-11-03T10:00:00.000Z' }),
      ],
    });

    expect(report.rows.map((row) => [row.number, row.balance])).toEqual([
      ['KP/1/2026', 100],
      ['KW/1/2026', 20],
    ]);
    expect(report.lowest).toEqual({ balance: 20, day: '2026-11-03' });
  });

  it('korekta KP (kwota ujemna) zmniejsza wpłaty, korekta KW zmniejsza wypłaty', () => {
    const report = buildCashReport({
      ...base,
      balanceBefore: 0,
      documents: [
        dowod({ id: 'a', kind: 'KP', number: 'KP/1/2026', amount: 200, correctedByNumber: 'KP/2/2026' }),
        dowod({ id: 'b', kind: 'KP', number: 'KP/2/2026', amount: -200, correctsNumber: 'KP/1/2026', issuedAt: '2026-11-03T12:00:00.000Z' }),
        dowod({ id: 'c', kind: 'KP', number: 'KP/3/2026', amount: 150, operationDate: '2026-11-04' }),
        dowod({ id: 'd', kind: 'KW', number: 'KW/1/2026', amount: 50, operationDate: '2026-11-05' }),
        dowod({ id: 'e', kind: 'KW', number: 'KW/2/2026', amount: -50, operationDate: '2026-11-05', correctsNumber: 'KW/1/2026', issuedAt: '2026-11-05T12:00:00.000Z' }),
      ],
    });

    expect(report.receipts).toBe(150);
    expect(report.payouts).toBe(0);
    expect(report.balanceEnd).toBe(150);
    expect(report.rows.find((row) => row.number === 'KP/2/2026')).toMatchObject({ receipt: -200, payout: null, balance: 0 });
    expect(report.rows.find((row) => row.number === 'KW/2/2026')).toMatchObject({ receipt: null, payout: -50, balance: 150 });
  });

  it('stan poniżej zera na koniec dnia: raport to mówi (baza na to nie pozwala, więc to sygnał błędu)', () => {
    const report = buildCashReport({
      ...base,
      balanceBefore: 10,
      documents: [dowod({ id: 'a', kind: 'KW', number: 'KW/1/2026', amount: 25, operationDate: '2026-11-07' })],
    });

    expect(report.belowZero).toBe(true);
    expect(report.lowest).toEqual({ balance: -15, day: '2026-11-07' });
  });

  it('pusty okres: stan na koniec równy stanowi na początek', () => {
    const report = buildCashReport({ ...base, documents: [] });

    expect(report).toMatchObject({ balanceStart: 50, receipts: 0, payouts: 0, balanceEnd: 50, rows: [], lowest: null, belowZero: false });
  });
});

describe('odczyt z bazy: nieznany kształt to „nie wiem”, a nie pusty raport', () => {
  const rpc = {
    status: 'ok',
    register: { id: 'r-1', opening_date: '2026-10-01', opening_balance: '50.00' },
    from: '2026-11-01',
    to: '2026-11-30',
    balance_before: '75.50',
    documents: [
      {
        id: 'd-1', kind: 'KP', number: 'KP/1/2026', operation_date: '2026-11-03', issue_date: '2026-11-03',
        amount: '100.00', title: 'Wpłata', counterparty_name: 'Jan Kowalski', invoice_number: null,
        corrects_number: null, corrected_by_number: null, issued_at: '2026-11-03T09:00:00+00:00',
      },
    ],
  };

  it('raport: kwoty z napisów numeric, kasa i dowody', () => {
    expect(parseCashReportRpc(rpc)).toEqual({
      register: { id: 'r-1', openingDate: '2026-10-01', openingBalance: 50 },
      from: '2026-11-01',
      to: '2026-11-30',
      balanceBefore: 75.5,
      documents: [dowod({ id: 'd-1', title: 'Wpłata', issuedAt: '2026-11-03T09:00:00+00:00' })],
    });
  });

  it('bez kasy: register null', () => {
    expect(parseCashReportRpc({ status: 'ok', register: null })).toMatchObject({ register: null, documents: [] });
  });

  it.each([
    ['nie obiekt', null],
    ['dowód bez numeru', { ...rpc, documents: [{ ...rpc.documents[0], number: null }] }],
    ['zły rodzaj', { ...rpc, documents: [{ ...rpc.documents[0], kind: 'XX' }] }],
    ['kwota nieliczbowa', { ...rpc, documents: [{ ...rpc.documents[0], amount: 'abc' }] }],
    ['brak stanu przed okresem', { ...rpc, balance_before: null }],
  ])('%s → null', (_name, data) => {
    expect(parseCashReportRpc(data)).toBeNull();
  });

  it('wiersz dowodu: wszystkie elementy dowodu albo null', () => {
    const row = {
      id: 'd-1', tenant_id: 't-1', kind: 'KW', number: 'KW/2/2026', issue_date: '2026-11-04', operation_date: '2026-11-03',
      amount: '-40.00', title: 'Korekta dowodu KW/1/2026', counterparty: { name: 'Sklep', nip: null, addressLine1: '', addressLine2: '' },
      issuer: { name: 'Moja Firma', nip: '1234567890', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' },
      issued_by_name: 'Anna Nowak', issued_at: '2026-11-04T10:00:00+00:00', invoice_id: null, invoice_number: null,
      payment_id: null, related_document: null, corrects_id: 'd-0', corrects_number: 'KW/1/2026', correction_reason: 'Zła kwota',
    };
    expect(parseCashDocumentRow(row)).toMatchObject({
      kind: 'KW', number: 'KW/2/2026', amount: -40, operationDate: '2026-11-03', issueDate: '2026-11-04',
      counterparty: { name: 'Sklep', nip: null }, issuer: { name: 'Moja Firma', nip: '1234567890' },
      issuedByName: 'Anna Nowak', correctsNumber: 'KW/1/2026', correctionReason: 'Zła kwota',
    });
    expect(parseCashDocumentRow({ ...row, issuer: null })).toBeNull();
    expect(parseCashDocumentRow({ ...row, issued_by_name: '' })).toBeNull();
  });
});

describe('okres raportu', () => {
  const today = '2026-11-11';

  it('domyślnie bieżący miesiąc do dziś', () => {
    expect(resolveCashPeriod({ today, openingDate: '2026-01-01' })).toEqual({ from: '2026-11-01', to: '2026-11-11', notice: null });
  });

  it('od dnia rozpoczęcia kasy, nie wcześniej; do dziś, nie dalej', () => {
    expect(resolveCashPeriod({ od: '2026-10-01', do: '2026-12-31', today, openingDate: '2026-10-15' })).toEqual({
      from: '2026-10-15',
      to: '2026-11-11',
      notice: 'Kasa działa w FaktWay od 15.10.2026, więc raport zaczyna się od tego dnia.',
    });
  });

  it.each([
    [{ od: '2026-11-10', do: '2026-11-01' }, 'Data „od” jest późniejsza niż data „do”. Pokazujemy bieżący miesiąc.'],
    [{ od: '2024-01-01', do: '2026-11-01' }, 'Raport obejmuje najwyżej rok. Pokazujemy bieżący miesiąc.'],
    [{ od: 'wczoraj', do: '2026-11-01' }, 'Nie rozpoznaliśmy dat okresu. Pokazujemy bieżący miesiąc.'],
  ])('zły okres %o: bieżący miesiąc z wyjaśnieniem', (query, notice) => {
    expect(resolveCashPeriod({ ...query, today, openingDate: '2020-01-01' })).toEqual({ from: '2026-11-01', to: today, notice });
  });
});

describe('schemat dowodu (formularz i akcja)', () => {
  const opts = { today: '2026-11-11', openingDate: '2026-11-01' };
  const ok = {
    kind: 'KP' as const,
    source: 'none' as const,
    invoiceId: '',
    paymentId: '',
    operationDate: '2026-11-10',
    amount: '1 234,56',
    title: 'Wpłata zaliczki',
    counterpartyName: 'Jan Kowalski',
    counterpartyNip: '',
    counterpartyAddressLine1: '',
    counterpartyAddressLine2: '',
    relatedDocument: '',
  };
  const error = (values: Record<string, unknown>) => {
    const parsed = cashDocumentSchema(opts).safeParse({ ...ok, ...values });
    return parsed.success ? null : parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]);
  };

  it('poprawny KP bez faktury przechodzi', () => {
    expect(error({})).toBeNull();
  });

  it.each([
    [{ operationDate: '2026-11-12' }, 'operationDate', 'Data operacji nie może być z przyszłości. Wpisz dzisiejszą albo wcześniejszą datę.'],
    [{ operationDate: '2026-10-31' }, 'operationDate', 'Data operacji nie może być wcześniejsza niż dzień rozpoczęcia kasy (01.11.2026).'],
    [{ operationDate: '2026-02-30' }, 'operationDate', 'Wpisz datę operacji.'],
    [{ amount: '0' }, 'amount', 'Wpisz kwotę większą od zera, np. 300 albo 1 234,56.'],
    [{ amount: '1000000000' }, 'amount', 'Kwota może mieć najwyżej 999 999 999,99 zł.'],
    [{ title: '   ' }, 'title', 'Wpisz tytuł operacji, np. „Zapłata za fakturę FV/1/2026”.'],
    [{ title: 'x'.repeat(201) }, 'title', 'Tytuł może mieć najwyżej 200 znaków.'],
    [{ counterpartyName: ' ' }, 'counterpartyName', 'Wpisz nazwę firmy albo imię i nazwisko.'],
    [{ relatedDocument: 'x'.repeat(121) }, 'relatedDocument', 'Pole „Dotyczy” może mieć najwyżej 120 znaków.'],
    [{ kind: 'KW', source: 'invoice', invoiceId: '00000000-0000-4000-8000-000000000001' }, 'source', 'Wypłata (KW) nie wiąże się z fakturą sprzedaży. Wybierz „Inna wypłata”.'],
    [{ source: 'invoice' }, 'invoiceId', 'Wybierz fakturę, którą zapłacono gotówką.'],
    [{ source: 'payment' }, 'paymentId', 'Wybierz wpłatę zapisaną przy fakturze.'],
  ])('%o → %s: %s', (values, path, message) => {
    expect(error(values)).toEqual([[path, message]]);
  });
});

describe('schemat stanu początkowego i korekty', () => {
  it('stan początkowy: zero wolno, minus nie, data nie z przyszłości', () => {
    const schema = cashOpeningSchema({ today: '2026-11-11' });
    expect(schema.safeParse({ openingDate: '2026-11-01', openingBalance: '0' }).success).toBe(true);
    expect(schema.safeParse({ openingDate: '2026-11-01', openingBalance: '-1' }).success).toBe(false);
    expect(schema.safeParse({ openingDate: '2026-11-12', openingBalance: '0' }).success).toBe(false);
  });

  it('korekta wymaga przyczyny do 300 znaków', () => {
    expect(cashCorrectionSchema.safeParse({ reason: 'Zła kwota' }).success).toBe(true);
    expect(cashCorrectionSchema.safeParse({ reason: '  ' }).success).toBe(false);
    expect(cashCorrectionSchema.safeParse({ reason: 'x'.repeat(301) }).success).toBe(false);
  });
});

describe('odmowy nazywają dokument i mówią, co zrobić (protokół, pkt 4)', () => {
  it('za mało gotówki w kasie: stan, dzień, kwota i wyjście', () => {
    expect(plain(issueRefusalText('insufficient_cash', { available: 100, availableOn: '2026-11-05', amount: 150 }))).toBe(
      'W kasie na koniec dnia 05.11.2026 jest 100,00 zł, a wypłata to 150,00 zł. Stan kasy nie może zejść poniżej zera. '
        + 'Jeśli gotówka wpłynęła do kasy, najpierw wystaw na nią KP z właściwą datą. Jeśli stan się nie zgadza od początku, sprawdź stan początkowy kasy.',
    );
  });

  it('kasa nieotwarta, wystawca bez danych, ten sam klucz z innymi danymi', () => {
    expect(issueRefusalText('register_missing')).toBe('Kasa nie jest jeszcze otwarta. Wpisz stan początkowy kasy na stronie Kasa, potem wystaw dowód.');
    expect(issueRefusalText('issuer_incomplete')).toBe('Uzupełnij nazwę, NIP i adres firmy w Ustawieniach, w danych firmy. Dowód kasowy musi wskazywać wystawcę.');
    expect(issueRefusalText('key_reused')).toBe('Ten dowód był już wystawiony z innymi danymi. Odśwież stronę i wystaw go jeszcze raz.');
  });

  it('wpłata z KP, wpłata z „Zapłacone”, odmowa faktury z wyjściem dla gotówki', () => {
    expect(issueRefusalText('payment_linked', { documentNumber: 'KP/3/2026' })).toBe('Ta wpłata ma już dowód KP/3/2026. Znajdziesz go w Kasie.');
    expect(issueRefusalText('payment_not_linkable', { source: 'manual', invoiceNumber: 'FV/1/2026' })).toBe(
      'Wpłatę do faktury FV/1/2026 oznaczono przyciskiem „Zapłacone”, więc KP jej nie obejmie. Jeśli zapłacono gotówką, cofnij „Zapłacone” na fakturze i wystaw KP do faktury: wpłata zapisze się razem z dowodem.',
    );
    expect(plain(issueRefusalText('invoice_refused', { invoiceCode: 'over_remaining', invoiceNumber: 'FV/1/2026', remaining: 930 }))).toBe(
      'Kwota jest większa niż pozostało do zapłaty na fakturze FV/1/2026 (930,00 PLN). FaktWay nie zapisuje nadpłat: wpisz kwotę najwyżej do tej reszty.',
    );
    expect(issueRefusalText('invoice_refused', { invoiceCode: 'not_accepted', invoiceNumber: 'FV/2/2026' })).toBe(
      'Faktura FV/2/2026 nie jest jeszcze przyjęta w KSeF. Wpłatę zapiszesz po jej przyjęciu. Jeśli gotówka już wpłynęła, wystaw KP jako „Inna wpłata” i wpisz numer faktury w polu „Dotyczy”.',
    );
  });

  it('korekta: już skorygowany, korekta korekty, „Zapłacone” po wpłacie, za mało gotówki', () => {
    expect(correctionRefusalText('already_corrected', { number: 'KP/3/2026', correctionNumber: 'KP/7/2026' })).toBe(
      'Dowód KP/3/2026 ma już korektę KP/7/2026. Jeśli trzeba, wystaw nowy dowód z poprawnymi danymi.',
    );
    expect(correctionRefusalText('is_correction', { number: 'KP/7/2026' })).toBe(
      'Dowód KP/7/2026 jest korektą, a korekty się nie koryguje. Jeśli korekta była błędem, wystaw nowy dowód z poprawnymi danymi.',
    );
    expect(plain(correctionRefusalText('payment_refused', {
      number: 'KP/3/2026', paymentCode: 'manual_first', invoiceNumber: 'FV/1/2026', manualPaidOn: '2026-11-06', manualAmount: 930,
    }))).toBe(
      'Faktura FV/1/2026 ma oznaczenie „Zapłacone” z 06.11.2026 na 930,00 zł, policzone jako reszta po wpłacie z dowodu KP/3/2026. Najpierw cofnij „Zapłacone” na fakturze, potem wystaw korektę.',
    );
    expect(plain(correctionRefusalText('insufficient_cash', { number: 'KP/3/2026', available: 20, availableOn: '2026-11-05', amount: 100 }))).toBe(
      'Korekta dowodu KP/3/2026 zmniejszy stan kasy o 100,00 zł, a na koniec dnia 05.11.2026 w kasie jest 20,00 zł. Stan kasy nie może zejść poniżej zera. '
        + 'Najpierw skoryguj błędne wypłaty (KW) z tego okresu albo wystaw KP na gotówkę, która wpłynęła.',
    );
  });

  it('stan początkowy po pierwszym dowodzie: stan, dzień i droga przez dowód', () => {
    expect(plain(openingRefusalText('documents_exist', { openingBalance: 500, openingDate: '2026-11-01' }))).toBe(
      'Stanu początkowego nie zmienia się po wystawieniu pierwszego dowodu. Kasa ma stan początkowy 500,00 zł na 01.11.2026. '
        + 'Różnicę między gotówką w kasie a stanem w FaktWay dokumentuje dowód KP albo KW, np. „Nadwyżka kasowa” albo „Niedobór kasowy”. Jak go ująć, ustala księgowa.',
    );
  });
});
