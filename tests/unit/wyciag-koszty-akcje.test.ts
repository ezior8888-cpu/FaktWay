import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sumaKontrolnaIdentyfikatora } from '@/lib/invoices/identyfikator-zbiorczy';

/**
 * Przelewy do dostawców z wyciągu jako zapłaty kosztów (krok 3.2, część 3):
 * prawdziwe akcje serwerowe, prawdziwy parser CAMT.053 i prawdziwe
 * dopasowanie (`lib/import/bank/koszty.ts`), atrapy tylko dla sesji, RPC
 * i odczytów z bazy (koszty z listy „Do zapłaty”, zapisane identyfikatory
 * zbiorcze). RODO: przy wgraniu żaden wypływ nie idzie do zapisu, a do
 * klienta wracają tylko przelewy na rachunki dostawców z listy. Same RPC
 * (zapis raz, rola, obca firma, cofnięcie, maskowanie) sprawdza
 * `tests/rls-wyciag-koszty.test.ts` na bazie.
 */

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  requireOrgRole: vi.fn(),
  invalidate: vi.fn(),
  revalidate: vi.fn(),
  globalStop: vi.fn(),
  from: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: m.invalidate }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlag: m.globalStop }));
vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return { ActionAuthError, requireOrgRole: m.requireOrgRole };
});

const {
  proposeBankExpensePaymentsAction,
  confirmBankExpensePaymentAction,
  skipBankExpenseOperationAction,
  undoBankExpensePaymentAction,
} = await import('@/app/actions/bank-statement');
const { ActionAuthError } = await import('@/lib/supabase/auth-context');

const TENANT = '22222222-2222-4222-8222-222222222222';
const OPERATION = '66666666-6666-4666-8666-666666666666';
const KOSZT_A = '11111111-1111-4111-8111-111111111111';
const KOSZT_B = '33333333-3333-4333-8333-333333333333';
const RACHUNEK = 'PL61109010140000071219812874';
const DOSTAWCA = 'PL27114020040000300201355387';
const PRYWATNY = 'PL49101010100160562221000000';
const KSEF_A = '1234567890-20261101-0A1B2C3D4E01-7A';
const KSEF_B = '1234567890-20261102-0A1B2C3D4E02-7B';
const POCZATEK = '1234567890-IZ202611-0A1B2C3D4E5F';
const ZBIORCZY = `${POCZATEK}-${sumaKontrolnaIdentyfikatora(POCZATEK)}`;
const KEY = `v1:${'ab'.repeat(32)}`;
const NBSP = /[  ]/g;
const plain = (text: string) => text.replace(NBSP, ' ');

/** Wiersz kosztu z listy „Do zapłaty” (kolumny 00177 i faktura KSeF), jak go czyta `wczytajKosztyNaRachunki`. */
function wiersz(id: string, numer: string, ksef: string | null, brutto: number) {
  return {
    id,
    seller_name: 'Dostawca Testowy sp. z o.o.',
    seller_nip: '1234567890',
    document_number: numer,
    gross_amount: brutto,
    vat_amount: 0,
    payment_due_date: '2026-11-20',
    payment_account: '27114020040000300201355387',
    payment_split: false,
    payment_terms: { zrodlo: 'ksef_xml', odczytano: '2026-11-01T10:00:00Z', problemy: [] },
    paid_at: null,
    faktura: { ksef_number: ksef, internal_number: numer, currency: 'PLN', ksef_environment: 'test' },
  };
}

/** Stan atrapy bazy. */
const db = {
  koszty: [wiersz(KOSZT_A, 'FV/7/11/2026', KSEF_A, 1230), wiersz(KOSZT_B, 'FV/8/11/2026', KSEF_B, 500)] as Array<Record<string, unknown>>,
  bladKosztow: false,
  identyfikatory: [] as Array<{ ksef_numbers: string[]; identifier: string }>,
  zapytania: [] as Array<{ table: string; calls: Array<[string, unknown[]]> }>,
};

function from(table: string) {
  const calls: Array<[string, unknown[]]> = [];
  db.zapytania.push({ table, calls });
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'is', 'not', 'in', 'order', 'range', 'limit']) {
    chain[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return chain;
    };
  }
  const wynik = () => {
    if (table === 'expenses') {
      if (db.bladKosztow) return { data: null, count: null, error: { code: 'XX000', message: 'awaria' } };
      return { data: db.koszty, count: db.koszty.length, error: null };
    }
    if (table === 'ksef_collective_identifiers') return { data: db.identyfikatory, error: null };
    throw new Error(`nieoczekiwana tabela ${table}`);
  };
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(wynik).then(resolve, reject);
  return chain;
}

function zapytanie(table: string) {
  return db.zapytania.find((z) => z.table === table);
}

function ntry(ccy: string, kwota: string, rachunek: string, nazwa: string, tytul: string, ref: string, kierunek = 'DBIT') {
  const strona = kierunek === 'DBIT' ? 'Cdtr' : 'Dbtr';
  return `<Ntry><Amt Ccy="${ccy}">${kwota}</Amt><CdtDbtInd>${kierunek}</CdtDbtInd><Sts>BOOK</Sts>
<BookgDt><Dt>2026-11-05</Dt></BookgDt><ValDt><Dt>2026-11-05</Dt></ValDt><AcctSvcrRef>${ref}</AcctSvcrRef>
<NtryDtls><TxDtls><RltdPties><${strona}><Nm>${nazwa}</Nm></${strona}><${strona}Acct><Id><IBAN>${rachunek}</IBAN></Id></${strona}Acct></RltdPties>
<RmtInf><Ustrd>${tytul}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`;
}

function camt(entries: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
<BkToCstmrStmt><GrpHdr><MsgId>CAMT1</MsgId><CreDtTm>2026-11-06T08:00:00+01:00</CreDtTm></GrpHdr>
<Stmt><Id>S1</Id><Acct><Id><IBAN>${RACHUNEK}</IBAN></Id><Ccy>PLN</Ccy></Acct>
${entries.join('\n')}
</Stmt></BkToCstmrStmt></Document>`;
}

/** Wyciąg: zapłata kosztu A z numerem KSeF, zapłata B bez numeru, przelew prywatny, przelew w euro, wpływ. */
const WYCIAG = camt([
  ntry('PLN', '1230.00', DOSTAWCA, 'DOSTAWCA TESTOWY', `${KSEF_A} FV/7/11/2026`, 'R1'),
  ntry('PLN', '500.00', DOSTAWCA, 'DOSTAWCA TESTOWY', 'ZA LISTOPAD', 'R2'),
  ntry('PLN', '77.00', PRYWATNY, 'JAN PRYWATNY', 'KIESZONKOWE DLA SYNA', 'R3'),
  ntry('EUR', '1230.00', DOSTAWCA, 'DOSTAWCA TESTOWY', KSEF_A, 'R4'),
  ntry('PLN', '100.00', 'PL29105010251000009098143861', 'NABYWCA', 'FV/1/11/2026', 'R5', 'CRDT'),
]);

function plik(text: string): FormData {
  const form = new FormData();
  form.set('file', new File([new TextEncoder().encode(text)], 'wyciag.xml'));
  return form;
}

function rpcZnane(known: Array<{ key: string; state: string }> = []) {
  m.rpc.mockImplementation(async (fn: string) => {
    if (fn === 'bank_known_operations') return { data: { status: 'ok', known }, error: null };
    throw new Error(`nieoczekiwane RPC ${fn}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('KSEF_ENV', 'test');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
  db.koszty = [wiersz(KOSZT_A, 'FV/7/11/2026', KSEF_A, 1230), wiersz(KOSZT_B, 'FV/8/11/2026', KSEF_B, 500)];
  db.bladKosztow = false;
  db.identyfikatory = [];
  db.zapytania = [];
  m.from.mockImplementation(from);
  m.globalStop.mockResolvedValue(false);
  m.requireOrgRole.mockResolvedValue({ supabase: { rpc: m.rpc, from: m.from }, tenantId: TENANT, user: { id: 'u' }, role: 'member' });
});

describe('proposeBankExpensePaymentsAction: propozycje bez zapisu', () => {
  it('przelewy na rachunek dostawcy z propozycją; prywatny, w euro i wpływ nie wracają i nic nie idzie do zapisu', async () => {
    rpcZnane();

    const result = await proposeBankExpensePaymentsAction(plik(WYCIAG));

    expect(m.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin', 'member']);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.fileFormat).toBe('camt053');
    expect(result.przelewy).toEqual([
      expect.objectContaining({
        account: RACHUNEK, bookingDate: '2026-11-05', amountGrosze: -123000, counterpartyAccount: DOSTAWCA,
        title: `${KSEF_A} FV/7/11/2026`, key: expect.stringMatching(/^v1:[0-9a-f]{64}$/),
        propozycja: { rodzaj: 'ksef_number', kosztIds: [KOSZT_A], pewne: true },
        kandydaci: [KOSZT_A, KOSZT_B],
      }),
      expect.objectContaining({ amountGrosze: -50000, propozycja: { rodzaj: 'amount', kosztIds: [KOSZT_B], pewne: false } }),
    ]);
    // Kolejność jak na liście „Do zapłaty”: termin, potem większa kwota.
    expect(result.koszty.map((k) => [k.id, k.kwotaGr])).toEqual([[KOSZT_A, 123000], [KOSZT_B, 50000]]);
    expect(result.znane).toBe(0);
    // RODO: przelew prywatny (tytuł, nazwa, rachunek) nie wraca do przeglądarki.
    expect(JSON.stringify(result)).not.toContain('KIESZONKOWE');
    expect(JSON.stringify(result)).not.toContain('JAN PRYWATNY');
    expect(JSON.stringify(result)).not.toContain('R4');
    // Żaden zapis: tylko odczyt kluczy znanych już operacji.
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith('bank_known_operations', { p_keys: result.przelewy.map((p) => p.key) });
  });

  it('koszty czyta tylko na rachunki z wypływów w złotych, z „PL” i bez, kluczem sesji', async () => {
    rpcZnane();
    await proposeBankExpensePaymentsAction(plik(WYCIAG));
    const q = zapytanie('expenses');
    expect(q).toBeDefined();
    const inCall = q!.calls.find(([method]) => method === 'in');
    expect(inCall?.[1][0]).toBe('payment_account');
    expect(new Set(inCall?.[1][1] as string[])).toEqual(new Set([DOSTAWCA, DOSTAWCA.slice(2), PRYWATNY, PRYWATNY.slice(2)]));
    expect(q!.calls).toContainEqual(['is', ['paid_at', null]]);
    expect(q!.calls).toContainEqual(['eq', ['tenant_id', TENANT]]);
  });

  it('ponowne wgranie: przelew już potwierdzony albo pominięty nie wraca, a liczba mówi o nim', async () => {
    rpcZnane();
    const first = await proposeBankExpensePaymentsAction(plik(WYCIAG));
    if (!first.success) throw new Error('propozycje');
    rpcZnane([{ key: first.przelewy[0]!.key, state: 'confirmed' }]);

    const second = await proposeBankExpensePaymentsAction(plik(WYCIAG));

    expect(second).toMatchObject({ success: true, znane: 1 });
    if (!second.success) return;
    expect(second.przelewy.map((p) => p.amountGrosze)).toEqual([-50000]);
    expect(second.przelewy[0]!.key).toBe(first.przelewy[1]!.key);
  });

  it('identyfikator zbiorczy w tytule: jedno kliknięcie dla obu kosztów z zapisanego zestawu', async () => {
    rpcZnane();
    db.identyfikatory = [{ ksef_numbers: [KSEF_A, KSEF_B], identifier: ZBIORCZY }];

    const result = await proposeBankExpensePaymentsAction(plik(camt([ntry('PLN', '1730.00', DOSTAWCA, 'DOSTAWCA', ZBIORCZY, 'R9')])));

    expect(result).toMatchObject({ success: true });
    if (!result.success) return;
    expect(result.przelewy[0]!.propozycja).toEqual({ rodzaj: 'collective_identifier', kosztIds: [KOSZT_A, KOSZT_B], pewne: true });
    const q = zapytanie('ksef_collective_identifiers');
    expect(q!.calls).toContainEqual(['in', ['seller_nip', ['1234567890']]]);
    expect(q!.calls).toContainEqual(['eq', ['ksef_environment', 'test']]);
  });

  it('nie udało się odczytać kosztów: komunikat z wyjściem, bez propozycji i bez RPC', async () => {
    db.bladKosztow = true;
    const result = await proposeBankExpensePaymentsAction(plik(WYCIAG));
    expect(result).toEqual({ success: false, error: expect.stringContaining('jeszcze raz') });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('nie udało się sprawdzić, które przelewy już były: bez propozycji (fail-closed)', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'awaria' } });
    expect(await proposeBankExpensePaymentsAction(plik(WYCIAG))).toEqual({ success: false, error: expect.stringContaining('jeszcze raz') });
  });

  it('bez środowiska KSeF aplikacji: komunikat, bez odczytu kosztów', async () => {
    vi.stubEnv('KSEF_ENV', '');
    expect(await proposeBankExpensePaymentsAction(plik(WYCIAG))).toMatchObject({ success: false });
    expect(m.from).not.toHaveBeenCalled();
  });

  it('plik bez wypływów w złotych: pusta lista bez odczytów z bazy', async () => {
    const result = await proposeBankExpensePaymentsAction(plik(camt([ntry('PLN', '100.00', DOSTAWCA, 'NABYWCA', 'FV/1', 'R5', 'CRDT')])));
    expect(result).toEqual({ success: true, fileFormat: 'camt053', przelewy: [], koszty: [], znane: 0 });
    expect(m.from).not.toHaveBeenCalled();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('księgowa: komunikat o roli, bez odczytów; plik nieznany: komunikat parsera', async () => {
    m.requireOrgRole.mockRejectedValueOnce(new ActionAuthError('Niewystarczające uprawnienia'));
    expect(await proposeBankExpensePaymentsAction(plik(WYCIAG))).toEqual({ success: false, error: expect.stringContaining('Księgowa ma tu wgląd') });
    expect(m.from).not.toHaveBeenCalled();
    expect(await proposeBankExpensePaymentsAction(plik('#Data;#Kwota'))).toEqual({ success: false, error: expect.stringContaining('MT940 albo CAMT.053') });
  });
});

const przelew = {
  key: KEY,
  account: RACHUNEK,
  bookingDate: '2026-11-05',
  amountGrosze: -123000,
  counterpartyName: 'DOSTAWCA TESTOWY',
  counterpartyAccount: DOSTAWCA,
  title: `${KSEF_A} FV/7/11/2026`,
  reference: 'R1',
};

describe('confirmBankExpensePaymentAction', () => {
  const wejscie = { fileFormat: 'camt053' as const, przelew, expenseIds: [KOSZT_A], matchKind: 'ksef_number' as const };

  it('RPC z operacją z wyciągu (kwota ujemna jako napis) i kosztami; komunikat z dniem i numerem; ponowienie bez dubla', async () => {
    m.rpc.mockResolvedValueOnce({
      data: {
        status: 'confirmed', operation_id: OPERATION, expense_ids: [KOSZT_A], paid_on: '2026-11-05', amount_gr: 123000, match_kind: 'ksef_number',
        documents: [{ id: KOSZT_A, document_number: 'FV/7/11/2026', seller_name: 'Dostawca Testowy sp. z o.o.' }],
      },
      error: null,
    });
    m.rpc.mockResolvedValueOnce({ data: { status: 'already_confirmed', operation_id: OPERATION, expense_ids: [KOSZT_A], paid_on: '2026-11-05' }, error: null });

    const first = await confirmBankExpensePaymentAction(wejscie);
    const second = await confirmBankExpensePaymentAction(wejscie);

    expect(m.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin', 'member']);
    expect(m.rpc).toHaveBeenNthCalledWith(1, 'confirm_bank_expense_payment', {
      p_file_format: 'camt053',
      p_operation: {
        key: KEY, account: RACHUNEK, booking_date: '2026-11-05', amount: '-1230.00', currency: 'PLN',
        counterparty_name: 'DOSTAWCA TESTOWY', counterparty_account: DOSTAWCA, title: `${KSEF_A} FV/7/11/2026`, reference: 'R1',
      },
      p_expense_ids: [KOSZT_A],
      p_match_kind: 'ksef_number',
    });
    expect(first).toEqual({ success: true, status: 'confirmed', message: expect.stringContaining('05.11.2026') });
    expect(first.success && first.message).toContain('FV/7/11/2026');
    expect(second).toEqual({ success: true, status: 'already_confirmed', message: expect.stringContaining('już zapisana') });
    expect(m.revalidate).toHaveBeenCalledWith('/bank');
    expect(m.revalidate).toHaveBeenCalledWith('/expenses');
    expect(m.revalidate).toHaveBeenCalledWith(`/expenses/${KOSZT_A}`);
  });

  it.each([
    ['amount_mismatch', { due_gr: 123000, amount_gr: 100000 }, '1000,00 PLN'],
    ['account_mismatch', { document_number: 'FV/7/11/2026' }, 'FV/7/11/2026'],
    ['expense_paid', { document_number: 'FV/7/11/2026', paid_on: '2026-11-04' }, 'już oznaczony jako zapłacony'],
    ['operation_confirmed', {}, 'Cofnij'],
  ])('odmowa %s z bazy: komunikat z nazwą dokumentu i wyjściem, bez odświeżania', async (code, extra, fragment) => {
    m.rpc.mockResolvedValue({ data: { status: 'refused', code, ...extra }, error: null });
    const result = await confirmBankExpensePaymentAction(wejscie);
    expect(result.success).toBe(false);
    expect(!result.success && plain(result.error)).toContain(fragment);
    expect(m.revalidate).not.toHaveBeenCalled();
  });

  it.each([
    ['zły klucz', { ...wejscie, przelew: { ...przelew, key: 'v1:zly' } }],
    ['kwota dodatnia (wpływ)', { ...wejscie, przelew: { ...przelew, amountGrosze: 123000 } }],
    ['kwota nie w groszach', { ...wejscie, przelew: { ...przelew, amountGrosze: -1230.5 } }],
    ['bez rachunku odbiorcy', { ...wejscie, przelew: { ...przelew, counterpartyAccount: null } }],
    ['zły dzień', { ...wejscie, przelew: { ...przelew, bookingDate: '2026-13-01' } }],
    ['bez kosztów', { ...wejscie, expenseIds: [] }],
    ['koszt dwa razy', { ...wejscie, expenseIds: [KOSZT_A, KOSZT_A] }],
    ['koszt bez UUID', { ...wejscie, expenseIds: ['a'] }],
    ['nieznany rodzaj dopasowania', { ...wejscie, matchKind: 'title' }],
    ['nieznany format', { ...wejscie, fileFormat: 'csv_mbank' }],
  ])('złe wejście (%s): bez RPC', async (_name, input) => {
    expect(await confirmBankExpensePaymentAction(input as never)).toMatchObject({ success: false });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('księgowa: komunikat o roli bez RPC; błąd RPC: ogólny komunikat bez szczegółów bazy', async () => {
    m.requireOrgRole.mockRejectedValueOnce(new ActionAuthError('Niewystarczające uprawnienia'));
    expect(await confirmBankExpensePaymentAction(wejscie)).toEqual({ success: false, error: expect.stringContaining('Księgowa ma tu wgląd') });
    expect(m.rpc).not.toHaveBeenCalled();
    m.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'secret' } });
    const result = await confirmBankExpensePaymentAction(wejscie);
    expect(result).toEqual({ success: false, error: expect.stringContaining('Nie udało się zapisać decyzji') });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('skipBankExpenseOperationAction', () => {
  it('RODO: do RPC idą tylko kwota, dzień, rachunki i klucz, bez tytułu, nazwy i referencji', async () => {
    m.rpc.mockResolvedValueOnce({ data: { status: 'skipped', operation_id: OPERATION }, error: null });
    m.rpc.mockResolvedValueOnce({ data: { status: 'already_skipped', operation_id: OPERATION }, error: null });

    const first = await skipBankExpenseOperationAction({ fileFormat: 'camt053', przelew });
    const second = await skipBankExpenseOperationAction({ fileFormat: 'camt053', przelew });

    expect(m.rpc).toHaveBeenNthCalledWith(1, 'skip_bank_expense_operation', {
      p_file_format: 'camt053',
      p_operation: { key: KEY, account: RACHUNEK, booking_date: '2026-11-05', amount: '-1230.00', currency: 'PLN', counterparty_account: DOSTAWCA },
    });
    const sent = JSON.stringify(m.rpc.mock.calls[0]);
    expect(sent).not.toContain('DOSTAWCA TESTOWY');
    expect(sent).not.toContain('FV/7/11/2026');
    expect(sent).not.toContain('R1');
    expect(first).toEqual({ success: true, status: 'skipped', message: expect.stringContaining('nie zapisaliśmy') });
    expect(second).toMatchObject({ success: true, status: 'already_skipped' });
  });

  it('przelew potwierdzony wcześniej: odmowa z wyjściem przez „Cofnij”', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'refused', code: 'operation_confirmed' }, error: null });
    expect(await skipBankExpenseOperationAction({ fileFormat: 'camt053', przelew })).toEqual({ success: false, error: expect.stringContaining('Cofnij') });
  });
});

describe('undoBankExpensePaymentAction', () => {
  it('cofnięcie: koszt wraca do „Do zapłaty”, przelewu nie trzymamy; drugie cofnięcie nic nie zmienia', async () => {
    m.rpc.mockResolvedValueOnce({ data: { status: 'undone', operation_id: OPERATION, reverted: 1, kept: 0, kept_documents: [], expense_ids: [KOSZT_A] }, error: null });
    m.rpc.mockResolvedValueOnce({ data: { status: 'refused', code: 'operation_not_found' }, error: null });

    const first = await undoBankExpensePaymentAction(OPERATION);
    const second = await undoBankExpensePaymentAction(OPERATION);

    expect(m.rpc).toHaveBeenNthCalledWith(1, 'undo_bank_expense_payment', { p_operation_id: OPERATION });
    expect(first).toEqual({ success: true, status: 'undone', message: expect.stringMatching(/wgraj wyciąg jeszcze raz/i) });
    expect(m.revalidate).toHaveBeenCalledWith(`/expenses/${KOSZT_A}`);
    expect(second).toEqual({ success: true, status: 'not_confirmed', message: expect.stringContaining('Odśwież') });
  });

  it('koszt zmieniony po potwierdzeniu zostaje i komunikat to mówi; zły identyfikator bez RPC', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'undone', operation_id: OPERATION, reverted: 0, kept: 1, kept_documents: ['FV/7/11/2026'], expense_ids: [KOSZT_A] }, error: null });
    expect(await undoBankExpensePaymentAction(OPERATION)).toEqual({ success: true, status: 'undone', message: expect.stringContaining('FV/7/11/2026') });
    m.rpc.mockClear();
    expect(await undoBankExpensePaymentAction('x')).toMatchObject({ success: false });
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
