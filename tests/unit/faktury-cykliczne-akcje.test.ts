import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';

/**
 * Plan Finora N1: akcje pozycji cyklicznej (tworzenie z warunkami wzoru,
 * edycja bez treści wzoru, wstrzymanie, wznowienie, usunięcie) i odczyty
 * dla P6 (lista z kontrahentem i kwotą wzoru, licznik banera). Klient
 * z sesji — atrapa bazy w pamięci; RLS i klucze obce na prawdziwej bazie:
 * tests/rls-faktury-cykliczne.test.ts.
 */

const TENANT = 'ten-1';
const OTHER = 'ten-2';
const TPL = '7f1c2d3e-4b5a-4c6d-8e7f-901234567890';
const TPL_2 = '7f1c2d3e-4b5a-4c6d-8e7f-901234567891';
const POS = '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), audit: vi.fn(), revalidate: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: mocks.auth,
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));

import {
  createRecurringInvoiceAction,
  deleteRecurringInvoiceAction,
  pauseRecurringInvoiceAction,
  resumeRecurringInvoiceAction,
  updateRecurringInvoiceAction,
} from '@/app/actions/recurring-invoices';
import { countRecurringInvoicesDue, listRecurringInvoices, listRecurringTemplateCandidates } from '@/lib/invoices/recurring/queries';

let db: MemoryDb;

function wzor(extra: Row = {}): Row {
  return {
    id: TPL, tenant_id: TENANT, direction: 'outgoing', origin: 'app', invoice_kind: 'regular',
    invoice_type: 'VAT', ksef_status: 'accepted', currency: 'PLN', internal_number: 'FV/7/09/2026',
    issue_date: '2026-09-10', gross_total: 1230, buyer_data: { name: 'Klient spółka z ograniczoną odpowiedzialnością' },
    ...extra,
  };
}

function pozycja(extra: Row = {}): Row {
  return {
    id: POS, tenant_id: TENANT, template_invoice_id: TPL, name: 'Abonament', frequency: 'monthly',
    day_of_month: 10, next_run_date: '2026-11-10', active: true, created_by: 'user-1',
    created_at: '2026-10-01T08:00:00Z', updated_at: '2026-10-01T08:00:00Z', ...extra,
  };
}

const dane = { templateInvoiceId: TPL, name: 'Abonament', frequency: 'monthly' as const, dayOfMonth: 25 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  // 20.10.2026 10:00 w Polsce.
  vi.setSystemTime(new Date('2026-10-20T08:00:00Z'));
  db = memoryDb({ invoices: [wzor()], recurring_invoices: [] });
  mocks.auth.mockResolvedValue({ supabase: fakeSupabase(db), user: { id: 'user-1' }, tenantId: TENANT, role: 'member' });
});

describe('createRecurringInvoiceAction', () => {
  it('tworzy pozycję z najbliższym dniem od dziś (Warszawa), autorem i wpisem audytu', async () => {
    const r = await createRecurringInvoiceAction(dane);
    expect(r).toMatchObject({
      success: true,
      recurringInvoice: {
        tenant_id: TENANT, template_invoice_id: TPL, name: 'Abonament', frequency: 'monthly',
        day_of_month: 25, next_run_date: '2026-10-25', active: true, created_by: 'user-1',
      },
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'recurring_invoice.created', tenantId: TENANT, userId: 'user-1', entityType: 'recurring_invoice',
    }));
    expect(mocks.revalidate).toHaveBeenCalledWith('/invoices/recurring');
  });

  it('dzień już minął — pierwsze wystawienie w przyszłym miesiącu', async () => {
    const r = await createRecurringInvoiceAction({ ...dane, dayOfMonth: 5 });
    expect(r.success && r.recurringInvoice.next_run_date).toBe('2026-11-05');
  });

  it('wzór z tego samego miesiąca, dzień pozycji jeszcze przed nami → pierwszy termin za miesiąc (C5, C6)', async () => {
    // Wzór 15.10, dzień 25, dziś 20.10: październik pokrywa już sam wzór.
    db.tables.invoices = [wzor({ issue_date: '2026-10-15' })];
    const r = await createRecurringInvoiceAction(dane);
    expect(r.success && r.recurringInvoice.next_run_date).toBe('2026-11-25');
  });

  it('wzór wystawiony dziś, dzień dzisiejszy → nie od razu „Do wystawienia”', async () => {
    db.tables.invoices = [wzor({ issue_date: '2026-10-20' })];
    const r = await createRecurringInvoiceAction({ ...dane, dayOfMonth: 20 });
    expect(r.success && r.recurringInvoice.next_run_date).toBe('2026-11-20');
  });

  it.each([
    ['quarterly' as const, '2026-10-05', 5, '2027-01-05'],
    ['yearly' as const, '2026-01-15', 15, '2027-01-15'],
  ])('co %s: wzór z bieżącego okresu → pierwszy termin w następnym okresie', async (frequency, issueDate, day, wynik) => {
    db.tables.invoices = [wzor({ issue_date: issueDate })];
    const r = await createRecurringInvoiceAction({ ...dane, frequency, dayOfMonth: day });
    expect(r.success && r.recurringInvoice.next_run_date).toBe(wynik);
  });

  it('ta sama faktura jest już wzorem innej pozycji → odmowa z nazwą pozycji, bez drugiej pozycji (K2)', async () => {
    db.tables.recurring_invoices = [pozycja({ name: 'Abonament Klient' })];
    await expect(createRecurringInvoiceAction(dane)).resolves.toEqual({
      success: false,
      error: 'Ta faktura jest już wzorem faktury cyklicznej „Abonament Klient” — zmień ją na liście faktur cyklicznych.',
    });
    expect(db.tables.recurring_invoices).toHaveLength(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('wyścig dwóch arkuszy: indeks unikalny wzoru (23505) → ten sam komunikat (K2)', async () => {
    db.failures['recurring_invoices:insert'] = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "recurring_invoices_template_unique"',
    };
    await expect(createRecurringInvoiceAction(dane)).resolves.toEqual({
      success: false,
      error: 'Ta faktura jest już wzorem innej faktury cyklicznej — zmień ją na liście faktur cyklicznych.',
    });
  });

  it.each([
    [{ direction: 'incoming' }, 'Wzorem może być tylko faktura sprzedaży, nie faktura kosztowa.'],
    [{ origin: 'import' }, 'Wzorem może być tylko faktura wystawiona w FaktWay — nie faktura z importu.'],
    [{ invoice_kind: 'correction', invoice_type: 'KOR' }, 'Wzorem może być tylko zwykła faktura VAT — nie korekta, zaliczka ani faktura końcowa.'],
    [{ invoice_kind: 'advance', invoice_type: 'ZAL' }, 'Wzorem może być tylko zwykła faktura VAT — nie korekta, zaliczka ani faktura końcowa.'],
    [{ invoice_kind: 'final', invoice_type: 'ROZ' }, 'Wzorem może być tylko zwykła faktura VAT — nie korekta, zaliczka ani faktura końcowa.'],
    [{ ksef_status: 'draft' }, 'Wzorem może być tylko faktura przyjęta przez KSeF. Poczekaj na przyjęcie albo wybierz inną fakturę.'],
    [{ ksef_status: 'rejected' }, 'Wzorem może być tylko faktura przyjęta przez KSeF. Poczekaj na przyjęcie albo wybierz inną fakturę.'],
    [{ currency: 'EUR' }, 'Wzorem może być tylko faktura w złotych (PLN).'],
    [{ tenant_id: OTHER }, 'Nie znaleziono faktury-wzoru w tej firmie.'],
  ])('odrzuca wzór %o', async (zmiana, komunikat) => {
    db.tables.invoices = [wzor(zmiana)];
    await expect(createRecurringInvoiceAction(dane)).resolves.toEqual({ success: false, error: komunikat });
    expect(db.tables.recurring_invoices).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...dane, dayOfMonth: 29 }, 'Podaj dzień miesiąca od 1 do 28 — 29, 30 i 31 nie ma w każdym miesiącu'],
    [{ ...dane, dayOfMonth: 0 }, 'Podaj dzień miesiąca od 1 do 28'],
    [{ ...dane, name: '   ' }, 'Podaj nazwę faktury cyklicznej'],
    [{ ...dane, frequency: 'weekly' as unknown as 'monthly' }, 'Wybierz częstotliwość'],
    [{ ...dane, templateInvoiceId: 'nie-uuid' }, 'Wybierz fakturę-wzór'],
  ])('walidacja Zod przed bazą: %o', async (wejscie, komunikat) => {
    await expect(createRecurringInvoiceAction(wejscie)).resolves.toEqual({ success: false, error: komunikat });
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it('przed wgraniem 00154 — komunikat o aktualizacji bazy, nie błąd techniczny', async () => {
    db.failures['recurring_invoices:insert'] = { code: 'PGRST205', message: 'Could not find the table' };
    await expect(createRecurringInvoiceAction(dane)).resolves.toEqual({
      success: false,
      error: 'Faktury cykliczne czekają jeszcze na aktualizację bazy danych. Spróbuj ponownie później.',
    });
  });

  it('odmowa sesji (MFA, brak firmy) wraca jako wynik akcji', async () => {
    const { ActionAuthError } = await import('@/lib/supabase/auth-context');
    mocks.auth.mockRejectedValue(new ActionAuthError('Wymagana weryfikacja dwuetapowa'));
    await expect(createRecurringInvoiceAction(dane)).resolves.toEqual({
      success: false,
      error: 'Wymagana weryfikacja dwuetapowa',
    });
  });
});

describe('updateRecurringInvoiceAction', () => {
  beforeEach(() => {
    db.tables.recurring_invoices = [pozycja()];
  });

  it('zmiana nazwy nie rusza harmonogramu', async () => {
    const r = await updateRecurringInvoiceAction(POS, { ...dane, dayOfMonth: 10, name: 'Abonament IT' });
    expect(r).toMatchObject({ success: true, recurringInvoice: { name: 'Abonament IT', next_run_date: '2026-11-10' } });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'recurring_invoice.updated' }));
  });

  it('zmiana dnia — ten sam miesiąc następnego wystawienia, nowy dzień', async () => {
    const r = await updateRecurringInvoiceAction(POS, { ...dane, dayOfMonth: 5 });
    expect(r.success && r.recurringInvoice.next_run_date).toBe('2026-11-05');
  });

  it('co miesiąc → co kwartał po fakturze za październik: pierwszy kwartał bez faktury (K1)', async () => {
    db.tables.invoices!.push({
      id: 'f-10', tenant_id: TENANT, recurring_invoice_id: POS, recurring_period: '2026-10', issue_date: '2026-10-10',
    });
    const r = await updateRecurringInvoiceAction(POS, { ...dane, frequency: 'quarterly', dayOfMonth: 10 });
    expect(r.success && r.recurringInvoice.next_run_date).toBe('2027-01-10');
  });

  it('co miesiąc → co rok po fakturze za październik: rok 2027 (K1)', async () => {
    db.tables.invoices!.push({
      id: 'f-10', tenant_id: TENANT, recurring_invoice_id: POS, recurring_period: '2026-10', issue_date: '2026-10-10',
    });
    const r = await updateRecurringInvoiceAction(POS, { ...dane, frequency: 'yearly', dayOfMonth: 10 });
    expect(r.success && r.recurringInvoice.next_run_date).toBe('2027-01-10');
  });

  it('faktury innej firmy nie wpływają na harmonogram', async () => {
    db.tables.invoices!.push({
      id: 'f-obca', tenant_id: OTHER, recurring_invoice_id: POS, recurring_period: '2026-12', issue_date: '2026-12-10',
    });
    const r = await updateRecurringInvoiceAction(POS, { ...dane, frequency: 'quarterly', dayOfMonth: 10 });
    expect(r.success && r.recurringInvoice.next_run_date).toBe('2026-11-10');
  });

  it('nowy wzór przechodzi te same warunki co przy tworzeniu', async () => {
    db.tables.invoices!.push(wzor({ id: TPL_2, ksef_status: 'draft' }));
    await expect(updateRecurringInvoiceAction(POS, { ...dane, dayOfMonth: 10, templateInvoiceId: TPL_2 })).resolves.toEqual({
      success: false,
      error: 'Wzorem może być tylko faktura przyjęta przez KSeF. Poczekaj na przyjęcie albo wybierz inną fakturę.',
    });
    expect(db.tables.recurring_invoices![0]!.template_invoice_id).toBe(TPL);
  });

  it('zmiana samego wzoru: termin w okresie pokrytym nowym wzorem przesuwa się (weryfikacja C5)', async () => {
    // Październik „Do wystawienia”, klient wystawił go ręcznie i ustawia tę fakturę jako wzór.
    db.tables.recurring_invoices = [pozycja({ next_run_date: '2026-10-10' })];
    db.tables.invoices!.push(wzor({ id: TPL_2, internal_number: 'FV/3/10/2026', issue_date: '2026-10-15' }));
    const r = await updateRecurringInvoiceAction(POS, { ...dane, dayOfMonth: 10, templateInvoiceId: TPL_2 });
    expect(r.success && r.recurringInvoice.next_run_date).toBe('2026-11-10');
  });

  it('pozycja innej firmy — „nie znaleziono”', async () => {
    db.tables.recurring_invoices = [pozycja({ tenant_id: OTHER })];
    await expect(updateRecurringInvoiceAction(POS, dane)).resolves.toEqual({
      success: false,
      error: 'Nie znaleziono tej faktury cyklicznej — mogła zostać usunięta. Odśwież stronę.',
    });
  });
});

describe('wstrzymanie i wznowienie', () => {
  it('wstrzymanie zostawia datę; wznowienie po miesiącach zostawia ostatni czekający okres', async () => {
    db.tables.recurring_invoices = [pozycja({ next_run_date: '2026-03-10' })];
    const p = await pauseRecurringInvoiceAction(POS);
    expect(p).toMatchObject({ success: true, recurringInvoice: { active: false, next_run_date: '2026-03-10' } });
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'recurring_invoice.paused' }));

    const w = await resumeRecurringInvoiceAction(POS);
    expect(w).toMatchObject({ success: true, recurringInvoice: { active: true, next_run_date: '2026-10-10' } });
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'recurring_invoice.resumed' }));
  });

  it('wznowienie aktywnej — bez zmian i bez wpisu audytu', async () => {
    db.tables.recurring_invoices = [pozycja()];
    await expect(resumeRecurringInvoiceAction(POS)).resolves.toMatchObject({ success: true });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe('deleteRecurringInvoiceAction', () => {
  it('usuwa pozycję i zapisuje audyt', async () => {
    db.tables.recurring_invoices = [pozycja()];
    await expect(deleteRecurringInvoiceAction(POS)).resolves.toEqual({ success: true });
    expect(db.tables.recurring_invoices).toEqual([]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'recurring_invoice.deleted', entityId: POS }));
  });

  it('obca albo nieistniejąca — „nie znaleziono”, nic nie znika', async () => {
    db.tables.recurring_invoices = [pozycja({ tenant_id: OTHER })];
    await expect(deleteRecurringInvoiceAction(POS)).resolves.toEqual({
      success: false,
      error: 'Nie znaleziono tej faktury cyklicznej — mogła zostać usunięta. Odśwież stronę.',
    });
    expect(db.tables.recurring_invoices).toHaveLength(1);
  });
});

describe('odczyty dla P6', () => {
  it('lista: kontrahent i kwota brutto wzoru, stan i okres; tylko ta firma', async () => {
    db.tables.recurring_invoices = [
      pozycja(),
      pozycja({ id: '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0e', name: 'Serwis', next_run_date: '2026-10-20', frequency: 'quarterly' }),
      pozycja({ id: '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0f', name: 'Wstrzymana', active: false }),
      pozycja({ id: '3a2b1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c10', tenant_id: OTHER, name: 'Obca' }),
    ];
    const lista = await listRecurringInvoices(fakeSupabase(db) as never, TENANT, '2026-10-20');
    expect(lista.map((p) => [p.name, p.status, p.period])).toEqual([
      ['Serwis', 'due', '2026-Q4'],
      ['Abonament', 'active', '2026-11'],
      ['Wstrzymana', 'paused', '2026-11'],
    ]);
    expect(lista[0]).toMatchObject({
      contractorName: 'Klient spółka z ograniczoną odpowiedzialnością',
      templateNumber: 'FV/7/09/2026',
      templateGrossTotal: 1230,
    });
  });

  it('licznik banera: aktywne z datą ≤ dziś', async () => {
    db.tables.recurring_invoices = [
      pozycja({ next_run_date: '2026-10-20' }),
      pozycja({ id: 'b', next_run_date: '2026-09-10' }),
      pozycja({ id: 'c', next_run_date: '2026-10-21' }),
      pozycja({ id: 'd', next_run_date: '2026-09-10', active: false }),
      pozycja({ id: 'e', next_run_date: '2026-09-10', tenant_id: OTHER }),
    ];
    await expect(countRecurringInvoicesDue(fakeSupabase(db) as never, TENANT, '2026-10-20')).resolves.toBe(2);
  });

  it('licznik banera przed wgraniem 00154 — null (baner się nie pokazuje)', async () => {
    db.failures['recurring_invoices:select'] = { code: 'PGRST205', message: 'Could not find the table' };
    await expect(countRecurringInvoicesDue(fakeSupabase(db) as never, TENANT, '2026-10-20')).resolves.toBeNull();
  });

  it('kandydaci na wzór: te same warunki co akcja', async () => {
    db.tables.invoices = [
      wzor(),
      wzor({ id: 'x1', ksef_status: 'draft' }),
      wzor({ id: 'x2', origin: 'import' }),
      wzor({ id: 'x3', currency: 'EUR' }),
      wzor({ id: 'x4', invoice_kind: 'correction', invoice_type: 'KOR' }),
      wzor({ id: 'x5', tenant_id: OTHER }),
    ];
    const kandydaci = await listRecurringTemplateCandidates(fakeSupabase(db) as never, TENANT);
    expect(kandydaci).toEqual([{
      id: TPL, internalNumber: 'FV/7/09/2026', issueDate: '2026-09-10', grossTotal: 1230,
      contractorName: 'Klient spółka z ograniczoną odpowiedzialnością',
    }]);
  });
});
