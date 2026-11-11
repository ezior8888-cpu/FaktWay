import iconv from 'iconv-lite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mikrorachunekZNip } from '@/lib/ksiegowosc/mikrorachunek';
import { nrbZNumeruBankuIRachunku } from '@/lib/import/bank/rachunek';

/**
 * Przelewy do ZUS i urzędu skarbowego z wyciągu (krok 3.2, część 2): prawdziwe
 * akcje serwerowe i prawdziwy wyłącznik modułu (`czyKsiegowoscWlaczona`),
 * atrapy tylko dla sesji, RPC, odczytów z bazy (flaga firmy, NIP, ustawienia
 * podatkowe) i globalnej flagi. Same RPC (zapis zapłaty raz, rola, obca firma,
 * różnica kwot, cofnięcie) sprawdza `tests/rls-wyciag-podatki.test.ts` na bazie.
 */

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  requireOrgRole: vi.fn(),
  invalidate: vi.fn(),
  revalidate: vi.fn(),
  globalStop: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: m.invalidate }));
// Globalny stop księgowości czyta się rozstrzygająco (F11-B6, #553):
// `czyKsiegowoscWlaczona` woła `getGlobalFlagForExecution`, więc atrapa ma obie.
vi.mock('@/lib/feature-flags/global-flags', () => ({
  getGlobalFlag: m.globalStop,
  getGlobalFlagForExecution: m.globalStop,
}));
vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return { ActionAuthError, requireOrgRole: m.requireOrgRole };
});

const { importBankStatementAction, confirmBankTaxPaymentAction, undoBankTaxPaymentAction } = await import('@/app/actions/bank-statement');
const { ActionAuthError } = await import('@/lib/supabase/auth-context');

const TENANT = '22222222-2222-4222-8222-222222222222';
const OPERATION = '66666666-6666-4666-8666-666666666666';
const SPOLECZNE = '77777777-7777-4777-8777-777777777771';
const ZDROWOTNA = '77777777-7777-4777-8777-777777777772';
const NIP = '1234563218';
const MIKRO = mikrorachunekZNip(NIP)!;
const NRS = nrbZNumeruBankuIRachunku('60000002', '0260123456789012')!.slice(2);
const RACHUNEK = '61109010140000071219812874';

/** Stan atrapy bazy: flaga firmy, NIP, ustawienia podatkowe. */
const db = {
  flaga: true,
  nip: NIP as string | null,
  nrs: NRS as string | null,
  bladProfilu: false,
};

function wynik(table: string) {
  if (table === 'tenant_feature_flags') return { data: { ksiegowosc_enabled: db.flaga }, error: null };
  if (table === 'tenants') return { data: db.nip === null ? null : { nip: db.nip }, error: null };
  if (table === 'tax_profiles') {
    if (db.bladProfilu) return { data: null, error: { code: 'XX000', message: 'awaria' } };
    return {
      data: [{ id: 'p1', valid_from: '2026-01-01', forma: 'ryczalt', stawka_domyslna: 1200, zus_etap: 'pelny', zus_od: null, chorobowe: false, najem: false, nrs_zus: db.nrs }],
      error: null,
    };
  }
  throw new Error(`nieoczekiwana tabela ${table}`);
}

function from(table: string) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'in']) chain[method] = () => chain;
  chain.maybeSingle = async () => wynik(table);
  chain.single = async () => wynik(table);
  chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(() => wynik(table)).then(resolve, reject);
  return chain;
}

/** Wyciąg CSV PKO BP (Elixir): wpływ, przelew do ZUS, przelew na mikrorachunek, zapłata dostawcy. */
const ELIXIR = [
  `111,20261015,123000,11402004,10901014,"PL27114020040000300201355387","${RACHUNEK}","NABYWCA SP. Z O.O.|||","|||",00000000,10901014,"FV/1/10/2026|||","","3370523300000016","",""`,
  `222,20261015,200000,10901014,60000002,"PL${NRS}","${RACHUNEK}","ZUS|||","|||",00000000,60000002,"SKLADKI 09/2026|||","","3170516000000251","",""`,
  `222,20261015,123400,10901014,10100071,"PL${MIKRO}","${RACHUNEK}","URZAD SKARBOWY|||","|||",00000000,10100071,"/TI/N${NIP}/OKR/26M09/SFP/PPE/|||","","3170516000000252","",""`,
  `222,20261015,5000,10901014,10101010,"PL49101010100160562221000000","${RACHUNEK}","DOSTAWCA|||","|||",00000000,10101010,"FAKTURA 77/2026|||","","3170516000000253","",""`,
].join('\r\n');

function plik(text: string): FormData {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(iconv.encode(text, 'win1250'))], 'wyciag.txt'));
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
  Object.assign(db, { flaga: true, nip: NIP, nrs: NRS, bladProfilu: false });
  m.globalStop.mockResolvedValue(false);
  m.requireOrgRole.mockResolvedValue({ supabase: { rpc: m.rpc, from }, tenantId: TENANT, user: { id: 'u' }, role: 'owner' });
});

describe('importBankStatementAction: przelewy do ZUS i urzędu', () => {
  it('moduł włączony: do RPC idą wpływ i przelewy do ZUS i urzędu z rodzajem i kwotą ujemną; zapłata dostawcy nie', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'imported', received: 3, inserted: 3, duplicates: 0, tax_inserted: 2 }, error: null });

    const result = await importBankStatementAction(plik(ELIXIR));

    expect(m.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = m.rpc.mock.calls[0]!;
    expect(fn).toBe('import_bank_operations');
    expect(args.p_operations).toHaveLength(3);
    expect(args.p_operations[0]).not.toHaveProperty('tax_kind');
    expect(args.p_operations.slice(1)).toEqual([
      expect.objectContaining({ tax_kind: 'zus', amount: '-2000.00', counterparty_account: `PL${NRS}`, booking_date: '2026-10-15', key: expect.stringMatching(/^v1:[0-9a-f]{64}$/) }),
      expect.objectContaining({ tax_kind: 'us', amount: '-1234.00', counterparty_account: `PL${MIKRO}`, title: `/TI/N${NIP}/OKR/26M09/SFP/PPE/` }),
    ]);
    expect(JSON.stringify(args.p_operations)).not.toContain('DOSTAWCA');
    expect(result).toEqual({
      success: true,
      format: 'csv_pko_elixir',
      inserted: 1,
      duplicates: 0,
      debitsSkipped: 1,
      otherCurrencySkipped: 0,
      tax: { inserted: 2, duplicates: 0 },
    });
  });

  it('ten sam plik drugi raz: przelewy podatkowe liczą się jako wgrane wcześniej', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'imported', received: 3, inserted: 0, duplicates: 3, tax_inserted: 0 }, error: null });
    expect(await importBankStatementAction(plik(ELIXIR))).toMatchObject({ inserted: 0, duplicates: 1, tax: { inserted: 0, duplicates: 2 } });
  });

  it.each([
    ['moduł wyłączony dla firmy', () => { db.flaga = false; }],
    ['globalny stop modułu', () => { m.globalStop.mockResolvedValue(true); }],
  ])('%s: do RPC idzie tylko wpływ, wypływów nie zapisujemy', async (_nazwa, ustaw) => {
    ustaw();
    m.rpc.mockResolvedValue({ data: { status: 'imported', received: 1, inserted: 1, duplicates: 0, tax_inserted: 0 }, error: null });

    const result = await importBankStatementAction(plik(ELIXIR));

    const [, args] = m.rpc.mock.calls[0]!;
    expect(args.p_operations).toHaveLength(1);
    expect(args.p_operations[0]).not.toHaveProperty('tax_kind');
    expect(result).toEqual({ success: true, format: 'csv_pko_elixir', inserted: 1, duplicates: 0, debitsSkipped: 3, otherCurrencySkipped: 0 });
  });

  it('nie udało się odczytać ustawień podatkowych: wpływy wchodzą, przelewów podatkowych nie zgadujemy i mówimy o tym', async () => {
    db.bladProfilu = true;
    m.rpc.mockResolvedValue({ data: { status: 'imported', received: 1, inserted: 1, duplicates: 0, tax_inserted: 0 }, error: null });

    const result = await importBankStatementAction(plik(ELIXIR));

    expect(m.rpc.mock.calls[0]![1].p_operations).toHaveLength(1);
    expect(result).toMatchObject({ success: true, inserted: 1, debitsSkipped: 3, taxUnavailable: true });
  });

  it('bez rachunku składkowego w ustawieniach: przelew do ZUS nie jest rozpoznany, na mikrorachunek tak', async () => {
    db.nrs = null;
    m.rpc.mockResolvedValue({ data: { status: 'imported', received: 2, inserted: 2, duplicates: 0, tax_inserted: 1 }, error: null });

    await importBankStatementAction(plik(ELIXIR));

    const ops = m.rpc.mock.calls[0]![1].p_operations as Array<{ tax_kind?: string }>;
    expect(ops.map((op) => op.tax_kind ?? null)).toEqual([null, 'us']);
  });

  it('sam przelew podatkowy w pliku: RPC dostaje go bez wpływów', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'imported', received: 1, inserted: 1, duplicates: 0, tax_inserted: 1 }, error: null });
    const result = await importBankStatementAction(plik(ELIXIR.split('\r\n')[2]!));
    expect(m.rpc.mock.calls[0]![1].p_operations).toEqual([expect.objectContaining({ tax_kind: 'us' })]);
    expect(result).toMatchObject({ success: true, inserted: 0, tax: { inserted: 1, duplicates: 0 } });
  });
});

describe('confirmBankTaxPaymentAction', () => {
  const wejscie = { operationId: OPERATION, settlementIds: [ZDROWOTNA, SPOLECZNE], matchKind: 'amount' as const };

  it('właściciel: RPC z operacją i rozliczeniami; zapis raz, ponowienie mówi, że już zapisane', async () => {
    m.rpc.mockResolvedValueOnce({
      data: {
        status: 'confirmed', operation_id: OPERATION, tax_kind: 'zus', settlement_ids: [SPOLECZNE, ZDROWOTNA], marked: 2,
        okres: '2026-09', rodzaje: ['zdrowotna', 'zus_spoleczne'], paid_on: '2026-10-15', bank_amount_gr: 200000, computed_gr: 200000, difference_gr: 0,
      },
      error: null,
    });
    m.rpc.mockResolvedValueOnce({ data: { status: 'already_confirmed', operation_id: OPERATION, settlement_ids: [SPOLECZNE, ZDROWOTNA], paid_on: '2026-10-15' }, error: null });

    const first = await confirmBankTaxPaymentAction(wejscie);
    const second = await confirmBankTaxPaymentAction(wejscie);

    expect(m.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin']);
    expect(m.rpc).toHaveBeenNthCalledWith(1, 'confirm_bank_tax_payment', {
      p_operation_id: OPERATION,
      p_settlement_ids: [ZDROWOTNA, SPOLECZNE],
      p_match_kind: 'amount',
    });
    expect(first).toEqual({ success: true, status: 'confirmed', message: expect.stringContaining('ZUS za wrzesień 2026') });
    expect(first.success && first.message).toContain('15.10.2026');
    expect(second).toEqual({ success: true, status: 'already_confirmed', message: expect.stringContaining('już zapisana') });
    expect(m.revalidate).toHaveBeenCalledWith('/bank');
    expect(m.revalidate).toHaveBeenCalledWith('/reports/ten-miesiac');
  });

  it('kwota z banku inna niż wyliczona: komunikat mówi o różnicy', async () => {
    m.rpc.mockResolvedValue({
      data: {
        status: 'confirmed', operation_id: OPERATION, tax_kind: 'us', settlement_ids: [SPOLECZNE], marked: 1,
        okres: '2026-09', rodzaje: ['ryczalt'], paid_on: '2026-10-15', bank_amount_gr: 125000, computed_gr: 123400, difference_gr: 1600,
      },
      error: null,
    });
    const result = await confirmBankTaxPaymentAction({ operationId: OPERATION, settlementIds: [SPOLECZNE], matchKind: 'title' });
    expect(result.success && result.message.replace(/[  ]/g, ' ')).toContain('16,00 PLN więcej');
  });

  it('moduł wyłączony: bez RPC, z komunikatem', async () => {
    db.flaga = false;
    expect(await confirmBankTaxPaymentAction(wejscie)).toEqual({ success: false, error: expect.stringContaining('nie jest dostępne') });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('członek firmy i księgowa: komunikat o roli, bez RPC', async () => {
    m.requireOrgRole.mockRejectedValue(new ActionAuthError('Niewystarczające uprawnienia'));
    expect(await confirmBankTaxPaymentAction(wejscie)).toEqual({ success: false, error: expect.stringContaining('właściciel albo administrator') });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('złe wejście: bez RPC', async () => {
    for (const bad of [
      { ...wejscie, operationId: 'x' },
      { ...wejscie, settlementIds: [] },
      { ...wejscie, settlementIds: [SPOLECZNE, ZDROWOTNA, OPERATION] },
      { ...wejscie, settlementIds: [SPOLECZNE, SPOLECZNE] },
      { ...wejscie, matchKind: 'ksef_number' },
    ]) {
      expect(await confirmBankTaxPaymentAction(bad as typeof wejscie)).toMatchObject({ success: false });
    }
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['settlement_linked', { linked_on: '2026-10-10' }, '10.10.2026'],
    ['paid_before_period', { okres: '2026-09' }, 'wrzesień 2026'],
    ['settlement_outdated', {}, 'nowszą wersję'],
    ['operation_confirmed', {}, '„Cofnij”'],
    ['tax_module_disabled', {}, 'nie jest dostępne'],
  ])('odmowa %s: komunikat z wyjściem', async (code, extra, fragment) => {
    m.rpc.mockResolvedValue({ data: { status: 'refused', code, ...extra }, error: null });
    expect(await confirmBankTaxPaymentAction(wejscie)).toEqual({ success: false, error: expect.stringContaining(fragment) });
    expect(m.revalidate).not.toHaveBeenCalled();
  });
});

describe('undoBankTaxPaymentAction', () => {
  it('cofnięcie: rozliczenia wracają do „zatwierdzone”, ponowne cofnięcie nic nie zmienia', async () => {
    m.rpc.mockResolvedValueOnce({ data: { status: 'undone', operation_id: OPERATION, reverted: 2, kept: 0 }, error: null });
    m.rpc.mockResolvedValueOnce({ data: { status: 'not_confirmed', operation_id: OPERATION }, error: null });

    expect(await undoBankTaxPaymentAction(OPERATION)).toEqual({ success: true, status: 'undone', message: expect.stringContaining('wróciła do sprawdzenia') });
    expect(await undoBankTaxPaymentAction(OPERATION)).toEqual({ success: true, status: 'not_confirmed', message: expect.any(String) });
    expect(m.rpc).toHaveBeenCalledWith('undo_bank_tax_payment', { p_operation_id: OPERATION });
  });

  it('rozliczenie zmienione po potwierdzeniu zostaje i komunikat to mówi', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'undone', operation_id: OPERATION, reverted: 0, kept: 1 }, error: null });
    expect(await undoBankTaxPaymentAction(OPERATION)).toEqual({ success: true, status: 'undone', message: expect.stringContaining('„Ten miesiąc”') });
  });
});
