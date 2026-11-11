import iconv from 'iconv-lite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Akcje ekranu „Bank” (plan kompletnej aplikacji, krok 3.2, część 1): prawdziwe
 * akcje serwerowe, atrapy tylko dla sesji i RPC. Same RPC (firma z sesji,
 * duplikaty, zapis wpłaty raz, maskowanie, cofnięcie) sprawdza
 * `tests/rls-wyciag-bankowy.test.ts` na prawdziwej bazie.
 */

const m = vi.hoisted(() => ({
  rpc: vi.fn(),
  requireOrgRole: vi.fn(),
  invalidate: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('@/lib/cache/invalidation', () => ({ invalidateTenantDashboard: m.invalidate }));
vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return { ActionAuthError, requireOrgRole: m.requireOrgRole };
});

const {
  importBankStatementAction,
  confirmBankOperationAction,
  skipBankOperationAction,
  undoBankOperationAction,
} = await import('@/app/actions/bank-statement');
const { ActionAuthError } = await import('@/lib/supabase/auth-context');

const TENANT = '22222222-2222-4222-8222-222222222222';
const OPERATION = '66666666-6666-4666-8666-666666666666';
const INVOICE = '11111111-1111-4111-8111-111111111111';
const RACHUNEK = 'PL61109010140000071219812874';
const NBSP = /[  ]/g;
const plain = (text: string) => text.replace(NBSP, ' ');

const ELIXIR = [
  '111,20261105,1234567,11402004,10901014,"PL27114020040000300201355387","61109010140000071219812874","ŻÓŁTA ŁÓDŹ SP. Z O.O.|||","|||",00000000,10901014,"FV/12/11/2026|||","","3370523300000016","",""',
  '222,20261105,123456,10901014,10101010,"PL49101010100160562221000000","61109010140000071219812874","DOSTAWCA|||","|||",00000000,10101010,"FAKTURA 77/2026|||","","3170516000000251","",""',
].join('\r\n');

function plik(text: string, name = 'wyciag.txt', encoding = 'win1250'): FormData {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(iconv.encode(text, encoding))], name));
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
  m.requireOrgRole.mockResolvedValue({ supabase: { rpc: m.rpc }, tenantId: TENANT, user: { id: 'u' }, role: 'member' });
});

describe('importBankStatementAction', () => {
  it('wysyła do RPC tylko wpływy w złotych, z kluczem duplikatu i kwotą w złotych jako napis; obciążenia tylko liczy', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'imported', received: 1, inserted: 1, duplicates: 0 }, error: null });

    const result = await importBankStatementAction(plik(ELIXIR));

    expect(m.requireOrgRole).toHaveBeenCalledWith(['owner', 'admin', 'member']);
    expect(m.rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = m.rpc.mock.calls[0]!;
    expect(fn).toBe('import_bank_operations');
    expect(args.p_file_format).toBe('csv_pko_elixir');
    expect(args.p_operations).toEqual([
      {
        key: expect.stringMatching(/^v1:[0-9a-f]{64}$/),
        account: RACHUNEK,
        booking_date: '2026-11-05',
        amount: '12345.67',
        currency: 'PLN',
        counterparty_name: 'ŻÓŁTA ŁÓDŹ SP. Z O.O.',
        counterparty_account: 'PL27114020040000300201355387',
        title: 'FV/12/11/2026',
        reference: '3370523300000016',
      },
    ]);
    expect(result).toEqual({
      success: true, format: 'csv_pko_elixir', inserted: 1, duplicates: 0, debitsSkipped: 1, otherCurrencySkipped: 0,
    });
    expect(m.revalidate).toHaveBeenCalledWith('/bank');
  });

  it('ten sam plik drugi raz: RPC mówi, ile operacji już było, i nic nowego nie wchodzi', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'imported', received: 1, inserted: 0, duplicates: 1 }, error: null });
    expect(await importBankStatementAction(plik(ELIXIR))).toMatchObject({ success: true, inserted: 0, duplicates: 1 });
  });

  it('plik bez wpływów nie woła RPC', async () => {
    const result = await importBankStatementAction(plik(ELIXIR.split('\r\n')[1]!));
    expect(m.rpc).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, format: 'csv_pko_elixir', inserted: 0, duplicates: 0, debitsSkipped: 1, otherCurrencySkipped: 0 });
  });

  it('nieznany format, pusty i za duży plik: komunikat z wyjściem, bez RPC', async () => {
    const unknown = await importBankStatementAction(plik('#Data operacji;#Kwota\n2026-11-05;-1 234,56', 'mbank.csv', 'utf8'));
    expect(unknown).toEqual({ success: false, error: expect.stringContaining('MT940 albo CAMT.053') });
    expect(await importBankStatementAction(plik(''))).toEqual({ success: false, error: 'Plik jest pusty. Wybierz plik wyciągu pobrany z banku.' });
    const big = new FormData();
    big.set('file', new File([new Uint8Array(950 * 1024)], 'duzy.xml'));
    expect(await importBankStatementAction(big)).toEqual({ success: false, error: expect.stringContaining('krótszy okres') });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('plik z błędem w środku: odmowa całego pliku, nic nie zapisujemy', async () => {
    const zly = `${ELIXIR}\r\n111,20261341,100,10901014,10901014,"","61109010140000071219812874","|||","|||",00000000,10901014,"X|||","","1","",""`;
    const result = await importBankStatementAction(plik(zly));
    expect(result).toEqual({ success: false, error: expect.stringContaining('Nic nie zapisaliśmy') });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('księgowa: komunikat o roli, bez RPC', async () => {
    m.requireOrgRole.mockRejectedValue(new ActionAuthError('Niewystarczające uprawnienia'));
    expect(await importBankStatementAction(plik(ELIXIR))).toEqual({
      success: false, error: 'Wyciąg wgrywa i wpłaty potwierdza właściciel, administrator albo członek firmy. Księgowa ma tu wgląd.',
    });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('błąd RPC: ogólny komunikat bez szczegółów bazy', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'secret' } });
    expect(await importBankStatementAction(plik(ELIXIR))).toEqual({
      success: false, error: 'Nie udało się zapisać wyciągu. Sprawdź połączenie i spróbuj ponownie: operacje wgrane wcześniej nie wejdą drugi raz.',
    });
  });
});

describe('confirmBankOperationAction', () => {
  const input = { operationId: OPERATION, invoiceId: INVOICE, matchKind: 'ksef_number' as const };

  it('potwierdzenie woła RPC z operacją, fakturą i rodzajem dopasowania; odświeża widoki wpłat', async () => {
    m.rpc.mockResolvedValue({
      data: { status: 'confirmed', payment_id: 'p1', amount: 1230, paid_on: '2026-11-05', payment_status: 'paid', internal_number: 'FV/12/11/2026' },
      error: null,
    });

    const result = await confirmBankOperationAction(input);

    expect(m.rpc).toHaveBeenCalledWith('confirm_bank_operation', {
      p_operation_id: OPERATION, p_invoice_id: INVOICE, p_match_kind: 'ksef_number',
    });
    expect(result).toMatchObject({ success: true, status: 'confirmed' });
    expect(plain(result.success ? result.message : '')).toBe('Zapisano wpłatę 1230,00 PLN do faktury FV/12/11/2026. Faktura jest zapłacona w całości.');
    expect(m.invalidate).toHaveBeenCalledWith(TENANT);
    expect(m.revalidate).toHaveBeenCalledWith('/bank');
    expect(m.revalidate).toHaveBeenCalledWith(`/invoices/${INVOICE}`);
  });

  it('drugie potwierdzenie tej samej operacji to sukces bez drugiej wpłaty', async () => {
    m.rpc.mockResolvedValue({ data: { status: 'already_confirmed', payment_id: 'p1', internal_number: 'FV/12/11/2026' }, error: null });
    expect(await confirmBankOperationAction(input)).toEqual({ success: true, status: 'already_confirmed', message: 'Ta wpłata jest już zapisana do faktury FV/12/11/2026.' });
  });

  it('odmowa zapisu wpłaty ma tekst z numerem faktury i wyjściem (nadpłata, pominięta operacja)', async () => {
    m.rpc.mockResolvedValueOnce({ data: { status: 'refused', code: 'over_remaining', remaining: 300, internal_number: 'FV/1/2026' }, error: null });
    const over = await confirmBankOperationAction(input);
    expect(over.success).toBe(false);
    expect(plain(over.success ? '' : over.error)).toContain('na fakturze FV/1/2026 (300,00 PLN)');

    m.rpc.mockResolvedValueOnce({ data: { status: 'refused', code: 'operation_skipped' }, error: null });
    expect(await confirmBankOperationAction(input)).toEqual({ success: false, error: expect.stringContaining('pominięta') });
  });

  it('zły identyfikator albo rodzaj dopasowania: bez RPC', async () => {
    expect((await confirmBankOperationAction({ ...input, operationId: 'x' })).success).toBe(false);
    expect((await confirmBankOperationAction({ ...input, matchKind: 'auto' as never })).success).toBe(false);
    expect(m.rpc).not.toHaveBeenCalled();
  });
});

describe('skipBankOperationAction i undoBankOperationAction', () => {
  it('pominięcie woła RPC; operacja z zapisaną wpłatą to odmowa z wyjściem', async () => {
    m.rpc.mockResolvedValueOnce({ data: { status: 'skipped' }, error: null });
    expect(await skipBankOperationAction(OPERATION)).toEqual({ success: true, status: 'skipped', message: 'Pominięto operację. Dane nadawcy i tytuł przelewu usunęliśmy.' });
    expect(m.rpc).toHaveBeenCalledWith('skip_bank_operation', { p_operation_id: OPERATION });

    m.rpc.mockResolvedValueOnce({ data: { status: 'refused', code: 'operation_confirmed', internal_number: 'FV/1/2026' }, error: null });
    expect(await skipBankOperationAction(OPERATION)).toEqual({ success: false, error: expect.stringContaining('Najpierw cofnij') });
  });

  it('cofnięcie woła RPC; „Zapłacone” policzone po tej wpłacie to odmowa z dniem i kwotą', async () => {
    m.rpc.mockResolvedValueOnce({ data: { status: 'undone', amount: 1230, internal_number: 'FV/1/2026' }, error: null });
    const undone = await undoBankOperationAction(OPERATION);
    expect(undone).toMatchObject({ success: true, status: 'undone' });
    expect(plain(undone.success ? undone.message : '')).toBe('Cofnięto wpłatę 1230,00 PLN. Operacja wróciła do sprawdzenia.');
    expect(m.rpc).toHaveBeenCalledWith('undo_bank_operation', { p_operation_id: OPERATION });

    m.rpc.mockResolvedValueOnce({
      data: { status: 'refused', code: 'manual_first', manual_paid_on: '2026-11-06', manual_amount: 100, internal_number: 'FV/1/2026' },
      error: null,
    });
    const refused = await undoBankOperationAction(OPERATION);
    expect(plain(refused.success ? '' : refused.error)).toContain('Faktura FV/1/2026 ma oznaczenie „Zapłacone” z 06.11.2026 na 100,00 PLN');
  });
});
