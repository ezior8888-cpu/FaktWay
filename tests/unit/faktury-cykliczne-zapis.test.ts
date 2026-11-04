import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan Finora N1, „Idempotencja (zajęcie okresu)”: zapis faktury z pozycji
 * cyklicznej wpisuje `recurring_invoice_id` i `recurring_period` w tym samym
 * INSERT, unikalny indeks `uq_invoices_recurring_period` daje najwyżej jedną
 * fakturę na okres, a `next_run_date` przesuwa warunkowy UPDATE po zapisie
 * (albo — gdy ten się nie udał — następna próba po 23505).
 *
 * Prawdziwa ścieżka akcji (`saveAndSendInvoiceAction`, `saveDraftAction`);
 * atrapa to tylko baza w pamięci z oboma unikalnymi indeksami faktur
 * i kolejka KSeF. Sam indeks i klucze obce na prawdziwym Postgresie:
 * tests/rls-faktury-cykliczne.test.ts (job CI „RLS isolation”).
 */

type Row = Record<string, unknown>;

const TENANT = 'ten-1';
const RECURRING = '5b0f6f43-2a51-4c55-9f0c-6f8a1b2c3d4e';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  audit: vi.fn(),
  enqueue: vi.fn(),
  gus: vi.fn(),
}));

const state = {
  invoices: [] as Row[],
  invoice_line_items: [] as Row[],
  recurring_invoices: [] as Row[],
  tenants: [] as Row[],
  ksef_submissions: [] as Row[],
  /** Każdy INSERT do `invoices` (także odrzucony) — dowód „zero zmian” dla zwykłej faktury. */
  invoiceInserts: [] as Row[],
  tablesTouched: [] as string[],
  failRecurringUpdate: false,
  failLines: false,
  nextId: 1,
};

function unique(row: Row): { code: string; message: string; details: string } | null {
  const sameNumber = state.invoices.some(
    (r) => r.tenant_id === row.tenant_id && r.internal_number === row.internal_number,
  );
  if (sameNumber) {
    return {
      code: '23505',
      message: 'duplicate key value violates unique constraint "uq_invoices_tenant_outgoing_internal_number"',
      details: `Key (tenant_id, internal_number)=(${String(row.tenant_id)}, ${String(row.internal_number)}) already exists.`,
    };
  }
  if (row.recurring_invoice_id != null) {
    const samePeriod = state.invoices.some(
      (r) =>
        r.tenant_id === row.tenant_id &&
        r.recurring_invoice_id === row.recurring_invoice_id &&
        r.recurring_period === row.recurring_period,
    );
    if (samePeriod) {
      return {
        code: '23505',
        message: 'duplicate key value violates unique constraint "uq_invoices_recurring_period"',
        details: 'Key (tenant_id, recurring_invoice_id, recurring_period)=(…) already exists.',
      };
    }
  }
  return null;
}

function table(
  name: keyof Pick<typeof state, 'invoices' | 'invoice_line_items' | 'recurring_invoices' | 'tenants' | 'ksef_submissions'>,
) {
  return state[name];
}

function fakeSupabase() {
  return {
    from(name: string) {
      state.tablesTouched.push(name);
      const filters: Array<[string, unknown]> = [];
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let payload: Row | Row[] | null = null;
      const rows = () => table(name as 'invoices');
      const matches = (r: Row) => filters.every(([k, v]) => r[k] === v);

      const run = async (): Promise<{ data: Row[] | null; error: Row | null }> => {
        // Jedno okrążenie sieci — dwa równoległe zapisy przeplatają się jak na produkcji.
        await new Promise((r) => setTimeout(r, 0));
        if (op === 'insert') {
          const list = Array.isArray(payload) ? payload : [payload!];
          if (name === 'invoice_line_items' && state.failLines) {
            return { data: null, error: { code: '23514', message: 'linie odrzucone' } };
          }
          const out: Row[] = [];
          for (const p of list) {
            if (name === 'invoices') {
              state.invoiceInserts.push(p);
              const conflict = unique(p);
              if (conflict) return { data: null, error: conflict };
            }
            const row = { id: `${name}-${state.nextId++}`, ...p };
            rows().push(row);
            out.push(row);
          }
          return { data: out, error: null };
        }
        if (op === 'update') {
          if (name === 'recurring_invoices' && state.failRecurringUpdate) {
            return { data: null, error: { code: '08006', message: 'połączenie zerwane' } };
          }
          const hit = rows().filter(matches);
          hit.forEach((r) => Object.assign(r, payload));
          return { data: hit.map((r) => ({ id: r.id })), error: null };
        }
        if (op === 'delete') {
          const hit = rows().filter(matches);
          const keep = rows().filter((r) => !matches(r));
          rows().splice(0, rows().length, ...keep);
          // DELETE … RETURNING (`.select(...)` po `.delete()`), jak PostgREST.
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        return { data: rows().filter(matches), error: null };
      };

      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return q;
        },
        order: () => q,
        limit: () => q,
        not: () => q,
        insert: (p: Row | Row[]) => {
          op = 'insert';
          payload = p;
          return q;
        },
        update: (p: Row) => {
          op = 'update';
          payload = p;
          return q;
        },
        delete: () => {
          op = 'delete';
          return q;
        },
        maybeSingle: async () => {
          const r = await run();
          return { data: r.data?.[0] ?? null, error: r.error };
        },
        single: async () => {
          const r = await run();
          return { data: r.data?.[0] ?? null, error: r.error };
        },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => run().then(ok, fail),
      };
      return q;
    },
  };
}

vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: mocks.auth,
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: mocks.enqueue }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: mocks.gus }));

import { saveAndSendInvoiceAction, saveDraftAction } from '@/components/invoices/actions';
import { deleteDraftInvoiceAction } from '@/components/invoices/draft-actions';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

// 20.10.2026 10:00 w Polsce.
const NOW = new Date('2026-10-20T08:00:00Z');
const DZIS = '2026-10-20';

const form = (internalNumber: string, extra: Partial<InvoiceFormValues> = {}): InvoiceFormValues => ({
  internalNumber, issueDate: DZIS, saleDate: '',
  buyerNip: '5252241585', buyerName: 'Klient', buyerAddressLine1: 'ul. B 2',
  buyerAddressLine2: '00-002 Warszawa', buyerEmail: '', buyerIsConsumer: false,
  buyerPesel: '', buyerIdDocument: '', paymentMethod: 'transfer', paymentDueDate: '2026-11-03',
  bankAccount: 'PL61109010140000071219812874',
  lines: [{ name: 'Abonament', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
  ...extra,
});

/** Formularz z „Wystaw teraz”: pozycja i okres, który strona pokazała w banerze (C3). */
const cykliczna = (internalNumber: string, recurringPeriod = '2026-11') =>
  form(internalNumber, { recurringInvoiceId: RECURRING, recurringPeriod });

function pozycja(): Row {
  return state.recurring_invoices[0]!;
}

function fakturyOkresu(period: string): Row[] {
  return state.invoices.filter((r) => r.recurring_invoice_id === RECURRING && r.recurring_period === period);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  state.invoices = [];
  state.invoice_line_items = [];
  state.invoiceInserts = [];
  state.tablesTouched = [];
  state.failRecurringUpdate = false;
  state.failLines = false;
  state.ksef_submissions = [];
  state.tenants = [{
    id: TENANT, nip: '5260001246', name: 'Moja Firma',
    address_json: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' },
    vat_exemption_basis: null, vat_cash_method: false,
  }];
  state.recurring_invoices = [{
    id: RECURRING, tenant_id: TENANT, template_invoice_id: 'tpl-1', name: 'Abonament Klient',
    frequency: 'monthly', day_of_month: 10, next_run_date: '2026-11-10', active: true,
  }];
  mocks.auth.mockResolvedValue({ supabase: fakeSupabase(), user: { id: 'user-1' }, tenantId: TENANT, role: 'owner' });
  // Kolejka jak na produkcji przestawia szkic na „queued”.
  mocks.enqueue.mockImplementation(async ({ invoiceId }: { invoiceId: string }) => {
    const row = state.invoices.find((r) => r.id === invoiceId);
    if (row) row.ksef_status = 'queued';
    return { ok: true, mode: 'online_queued' };
  });
});

describe('faktura z pozycji cyklicznej — jedna faktura na okres (N1)', () => {
  it('zapis wpisuje powiązanie i okres w tym samym INSERT, potem przesuwa next_run_date', async () => {
    await expect(saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT)).resolves.toMatchObject({ success: true });

    expect(state.invoiceInserts).toHaveLength(1);
    expect(state.invoiceInserts[0]).toMatchObject({ recurring_invoice_id: RECURRING, recurring_period: '2026-11' });
    expect(fakturyOkresu('2026-11')).toHaveLength(1);
    expect(pozycja().next_run_date).toBe('2026-12-10');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('dwa równoległe zapisy tego samego okresu → jedna faktura i komunikat z numerem istniejącej', async () => {
    const [a, b] = await Promise.all([
      saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT),
      saveAndSendInvoiceAction(cykliczna('FV/2/11/2026'), TENANT),
    ]);

    const wyniki = [a, b];
    const udane = wyniki.filter((r) => r.success);
    const odrzucone = wyniki.filter((r) => !r.success);
    expect(udane).toHaveLength(1);
    expect(odrzucone).toHaveLength(1);
    expect(state.invoices).toHaveLength(1);
    const numer = String(state.invoices[0]!.internal_number);
    expect(odrzucone[0]).toEqual({ success: false, error: `Faktura za ten okres jest już wystawiona: ${numer}` });
    expect(pozycja().next_run_date).toBe('2026-12-10');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('podwójne kliknięcie z tym samym numerem → jedna faktura, komunikat o okresie (oba indeksy naraz)', async () => {
    const [a, b] = await Promise.all([
      saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT),
      saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT),
    ]);
    expect([a, b].filter((r) => r.success)).toHaveLength(1);
    expect([a, b].find((r) => !r.success)).toEqual({
      success: false,
      error: 'Faktura za ten okres jest już wystawiona: FV/1/11/2026',
    });
    expect(state.invoices).toHaveLength(1);
    expect(pozycja().next_run_date).toBe('2026-12-10');
  });

  it('ponowienie po zapisie faktury (to samo żądanie drugi raz) nie tworzy drugiej faktury', async () => {
    await expect(saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT)).resolves.toMatchObject({ success: true });
    const ponowienie = await saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT);

    // Komunikat o okresie (z okresu formularza), nie o numerze — klient nie
    // dostaje rady „wybierz inny numer”, która prowadzi do drugiej faktury (C3).
    expect(ponowienie).toEqual({ success: false, error: 'Faktura za ten okres jest już wystawiona: FV/1/11/2026' });
    expect(state.invoices).toHaveLength(1);
    expect(fakturyOkresu('2026-11')).toHaveLength(1);
    // Okres listopadowy wystawiony; pozycja czeka na grudzień i nie przeskakuje dalej.
    expect(pozycja().next_run_date).toBe('2026-12-10');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('UPDATE next_run_date nie wyszedł → faktura zostaje, następna próba dostaje 23505, komunikat i przesunięcie', async () => {
    state.failRecurringUpdate = true;
    await expect(saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT)).resolves.toMatchObject({ success: true });
    expect(state.invoices).toHaveLength(1);
    expect(pozycja().next_run_date).toBe('2026-11-10');

    state.failRecurringUpdate = false;
    // Klient widzi pozycję wciąż „Do wystawienia” i klika „Wystaw teraz” — numer podpowiada już kolejny.
    const druga = await saveAndSendInvoiceAction(cykliczna('FV/2/11/2026'), TENANT);

    expect(druga).toEqual({ success: false, error: 'Faktura za ten okres jest już wystawiona: FV/1/11/2026' });
    expect(state.invoices).toHaveLength(1);
    expect(pozycja().next_run_date).toBe('2026-12-10');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('ponowienie po nieudanym UPDATE, gdy przesunięcie też się nie udaje → nadal jedna faktura; kolejna próba naprawia', async () => {
    state.failRecurringUpdate = true;
    await saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT);
    const druga = await saveAndSendInvoiceAction(cykliczna('FV/2/11/2026'), TENANT);
    expect(druga).toEqual({ success: false, error: 'Faktura za ten okres jest już wystawiona: FV/1/11/2026' });
    expect(pozycja().next_run_date).toBe('2026-11-10');

    state.failRecurringUpdate = false;
    const trzecia = await saveAndSendInvoiceAction(cykliczna('FV/3/11/2026'), TENANT);
    expect(trzecia).toEqual({ success: false, error: 'Faktura za ten okres jest już wystawiona: FV/1/11/2026' });
    expect(state.invoices).toHaveLength(1);
    expect(pozycja().next_run_date).toBe('2026-12-10');
  });

  it('przesunięcie jest warunkowe: nie nadpisuje daty zmienionej w międzyczasie', async () => {
    state.failRecurringUpdate = true;
    await saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT);
    state.failRecurringUpdate = false;
    // Ktoś w międzyczasie przestawił pozycję na inny dzień.
    pozycja().next_run_date = '2026-11-05';
    pozycja().day_of_month = 5;

    // Nowa próba liczy okres z nowej daty (ten sam listopad) i trafia w 23505.
    const r = await saveAndSendInvoiceAction(cykliczna('FV/2/11/2026'), TENANT);
    expect(r).toEqual({ success: false, error: 'Faktura za ten okres jest już wystawiona: FV/1/11/2026' });
    expect(pozycja().next_run_date).toBe('2026-12-05');
  });

  it('błąd zapisu pozycji faktury → faktura wycofana, okres wolny, data bez zmian', async () => {
    state.failLines = true;
    const r = await saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT);
    expect(r.success).toBe(false);
    expect(state.invoices).toHaveLength(0);
    expect(pozycja().next_run_date).toBe('2026-11-10');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('druga karta z tym samym okresem i INNYM numerem → komunikat o okresie, jedna faktura, data przesunięta raz (C3)', async () => {
    // Dwie karty otwarte na „listopad 2026”; karta A wystawia.
    await expect(saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT)).resolves.toMatchObject({ success: true });
    expect(pozycja().next_run_date).toBe('2026-12-10');

    // Karta B: numer zmieniony (np. po komunikacie o zajętym numerze), okres z formularza nadal listopad.
    const b = await saveAndSendInvoiceAction(cykliczna('FV/2/11/2026'), TENANT);

    expect(b).toEqual({ success: false, error: 'Faktura za ten okres jest już wystawiona: FV/1/11/2026' });
    expect(state.invoices).toHaveLength(1);
    expect(fakturyOkresu('2026-12')).toHaveLength(0);
    expect(pozycja().next_run_date).toBe('2026-12-10');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('pozycja zmieniona od otwarcia formularza (inny okres, bez faktury za okres z formularza) → odmowa bez zapisu', async () => {
    // Formularz otwarty na listopad; w międzyczasie ktoś przestawił pozycję na grudzień.
    pozycja().next_run_date = '2026-12-10';
    const r = await saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT);
    expect(r).toEqual({
      success: false,
      error: 'Faktura cykliczna zmieniła się od otwarcia formularza — otwórz „Wystaw teraz” ponownie.',
    });
    expect(state.invoiceInserts).toEqual([]);
    expect(pozycja().next_run_date).toBe('2026-12-10');
  });

  it('formularz bez okresu (stara karta sprzed wdrożenia) → odmowa walidacji, bez zapisu', async () => {
    const r = await saveAndSendInvoiceAction(form('FV/1/11/2026', { recurringInvoiceId: RECURRING }), TENANT);
    expect(r).toEqual({
      success: false,
      error: 'Brakuje okresu faktury cyklicznej — otwórz „Wystaw teraz” ponownie.',
    });
    expect(state.invoiceInserts).toEqual([]);
  });

  it('wpis audytu: pozycja, okres i przesunięcie next_run_date (K3)', async () => {
    const r = await saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT);
    expect(r.success).toBe(true);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'recurring_invoice.issued',
      tenantId: TENANT,
      userId: 'user-1',
      entityType: 'recurring_invoice',
      entityId: RECURRING,
      metadata: expect.objectContaining({
        invoiceId: r.success ? r.invoiceId : null,
        internalNumber: 'FV/1/11/2026',
        recurringPeriod: '2026-11',
        fromNextRunDate: '2026-11-10',
        toNextRunDate: '2026-12-10',
        nextRunDateAdvanced: true,
      }),
    }));
  });

  it('samonaprawa po 23505 zapisuje przesunięcie w audycie (K3)', async () => {
    state.failRecurringUpdate = true;
    await saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'recurring_invoice.issued',
      metadata: expect.objectContaining({ nextRunDateAdvanced: false }),
    }));
    state.failRecurringUpdate = false;
    mocks.audit.mockClear();

    await saveAndSendInvoiceAction(cykliczna('FV/2/11/2026'), TENANT);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'recurring_invoice.run_date_repaired',
      entityType: 'recurring_invoice',
      entityId: RECURRING,
      metadata: expect.objectContaining({
        recurringPeriod: '2026-11',
        existingInternalNumber: 'FV/1/11/2026',
        fromNextRunDate: '2026-11-10',
        toNextRunDate: '2026-12-10',
      }),
    }));
  });
});

describe('szkic a pozycja cykliczna (C2, C4, C7)', () => {
  it('„Zapisz szkic” z pozycji cyklicznej → odmowa bez zapisu; okres i data bez zmian', async () => {
    const r = await saveDraftAction(cykliczna('FV/1/11/2026'), TENANT);
    expect(r).toEqual({
      success: false,
      error: 'Fakturę cykliczną wystaw przyciskiem „Wystaw i wyślij do KSeF”.',
    });
    expect(state.invoiceInserts).toEqual([]);
    expect(pozycja().next_run_date).toBe('2026-11-10');
  });

  it('kolejka KSeF odmówiła → szkic trzyma okres; komunikat mówi, co zrobić', async () => {
    mocks.enqueue.mockResolvedValue({ ok: false, error: 'Najpierw wgraj certyfikat KSeF w Ustawieniach.' });
    const r = await saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT);
    expect(r).toMatchObject({ success: false, invoiceId: expect.any(String) });
    expect(!r.success && r.error).toContain('Najpierw wgraj certyfikat KSeF w Ustawieniach.');
    expect(!r.success && r.error).toContain('wyślij go do KSeF dziś albo usuń');
    expect(fakturyOkresu('2026-11')).toHaveLength(1);
    expect(pozycja().next_run_date).toBe('2026-12-10');
  });

  it('usunięcie szkicu powiązanego z okresem przywraca next_run_date; okres znów do wystawienia', async () => {
    mocks.enqueue.mockResolvedValue({ ok: false, error: 'Najpierw wgraj certyfikat KSeF w Ustawieniach.' });
    const zapis = await saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT);
    const szkicId = String(!zapis.success && zapis.invoiceId);
    expect(pozycja().next_run_date).toBe('2026-12-10');

    await expect(deleteDraftInvoiceAction(szkicId)).resolves.toEqual({ success: true });

    expect(state.invoices).toHaveLength(0);
    expect(pozycja().next_run_date).toBe('2026-11-10');
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'recurring_invoice.run_date_restored',
      entityType: 'recurring_invoice',
      entityId: RECURRING,
      metadata: expect.objectContaining({ recurringPeriod: '2026-11', fromNextRunDate: '2026-12-10', toNextRunDate: '2026-11-10' }),
    }));

    // Ponowne „Wystaw teraz” wystawia TEN SAM okres.
    mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
    await expect(saveAndSendInvoiceAction(cykliczna('FV/2/11/2026'), TENANT)).resolves.toMatchObject({ success: true });
    expect(fakturyOkresu('2026-11')).toHaveLength(1);
    expect(pozycja().next_run_date).toBe('2026-12-10');
  });

  it('usunięcie szkicu, gdy pozycja zmieniła się od zapisu (inny okres) → data bez zmian', async () => {
    mocks.enqueue.mockResolvedValue({ ok: false, error: 'Najpierw wgraj certyfikat KSeF w Ustawieniach.' });
    const zapis = await saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT);
    const szkicId = String(!zapis.success && zapis.invoiceId);
    // Ktoś zmienił pozycję (np. częstotliwość) — cofnięcie nie trafiłoby w okres szkicu.
    pozycja().next_run_date = '2027-01-10';
    pozycja().frequency = 'quarterly';

    await expect(deleteDraftInvoiceAction(szkicId)).resolves.toEqual({ success: true });
    expect(pozycja().next_run_date).toBe('2027-01-10');
    expect(mocks.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'recurring_invoice.run_date_restored' }));
  });

  it('usunięcie zwykłego szkicu nie dotyka pozycji cyklicznych', async () => {
    await expect(saveDraftAction(form('FV/1/10/2026'), TENANT)).resolves.toMatchObject({ success: true });
    const szkicId = String(state.invoices[0]!.id);
    state.tablesTouched = [];
    await expect(deleteDraftInvoiceAction(szkicId)).resolves.toEqual({ success: true });
    expect(state.invoices).toHaveLength(0);
    expect(state.tablesTouched).not.toContain('recurring_invoices');
    expect(pozycja().next_run_date).toBe('2026-11-10');
  });
});

describe('pozycja wstrzymana, usunięta albo z innej firmy — odmowa przed zapisem', () => {
  it('wstrzymana', async () => {
    pozycja().active = false;
    const r = await saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT);
    expect(r).toEqual({
      success: false,
      error: 'Ta faktura cykliczna jest wstrzymana — wznów ją albo wystaw zwykłą fakturę.',
    });
    expect(state.invoiceInserts).toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['usunięta', () => { state.recurring_invoices = []; }],
    ['z innej firmy', () => { pozycja().tenant_id = 'ten-2'; }],
  ])('%s', async (_opis, ustaw) => {
    ustaw();
    // „Wystaw i wyślij” (szkic z pozycji jest odrzucany wcześniej, C2).
    const r = await saveAndSendInvoiceAction(cykliczna('FV/1/11/2026'), TENANT);
    expect(r).toEqual({
      success: false,
      error: 'Nie znaleziono tej faktury cyklicznej — mogła zostać usunięta. Wystaw zwykłą fakturę.',
    });
    expect(state.invoiceInserts).toEqual([]);
  });
});

describe('zwykła faktura bez pozycji cyklicznej — zachowanie bez zmian', () => {
  it('INSERT bez kolumn cyklicznych, bez odczytu i zapisu recurring_invoices', async () => {
    await expect(saveAndSendInvoiceAction(form('FV/1/10/2026'), TENANT)).resolves.toMatchObject({ success: true });
    expect(state.invoiceInserts).toHaveLength(1);
    expect(state.invoiceInserts[0]).not.toHaveProperty('recurring_invoice_id');
    expect(state.invoiceInserts[0]).not.toHaveProperty('recurring_period');
    expect(state.tablesTouched).not.toContain('recurring_invoices');
    expect(pozycja().next_run_date).toBe('2026-11-10');
  });

  it('duplikat numeru — ten sam komunikat co dotąd', async () => {
    await saveDraftAction(form('FV/1/10/2026'), TENANT);
    await expect(saveDraftAction(form('FV/1/10/2026'), TENANT)).resolves.toEqual({
      success: false,
      error: 'Faktura o numerze "FV/1/10/2026" już istnieje. Sprawdź listę faktur lub wybierz inny numer.',
    });
    expect(state.tablesTouched).not.toContain('recurring_invoices');
  });
});
