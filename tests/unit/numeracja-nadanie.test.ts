import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  NUMBER_RACE_MESSAGE,
  numberConflictOf,
  saveWithInvoiceNumber,
  type AssignedNumber,
  type NumberConflict,
} from '@/lib/numeracja/nadanie';

/**
 * Krok 2.5: numer z licznika serii nadaje baza (wyzwalacz 00199 pod blokadą
 * serii), a aplikacja tylko proponuje kolejny numer i ponawia zapis, gdy
 * w tym czasie inna faktura zajęła ten numer. Ten test sprawdza ścieżkę
 * aplikacji z atrapą bazy; sam wyzwalacz, blokadę i wyścig dwóch wystawień na
 * prawdziwym Postgresie sprawdza tests/rls-numeracja.test.ts.
 */

const SERIES = '0c0b5a9e-1d2f-4e3a-8b4c-5d6e7f809102';
const KEY = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const DAY = '2026-11-11';

type SaveResult =
  | { success: true; invoiceId: string }
  | { success: false; error: string; invoiceId?: string; numberConflict?: NumberConflict };

/** Atrapa: `invoice_number_next` oddaje kolejne liczniki z listy, `invoices` zna zapisany klucz. */
function fakeDb(options: {
  next?: Array<{ status: 'ok'; counter: number } | { status: 'refused'; code: string }>;
  savedByKey?: { id: string; internal_number: string } | null;
} = {}) {
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const queue = [...(options.next ?? [])];
  const db = {
    rpc: vi.fn(async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      const step = queue.shift() ?? { status: 'ok', counter: 99 };
      if (step.status === 'refused') return { data: step, error: null };
      return {
        data: { status: 'ok', counter: step.counter, period: '2026-11', number: `FV/${step.counter}/11/2026` },
        error: null,
      };
    }),
    from: vi.fn(() => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: options.savedByKey ?? null, error: null }),
      };
      return chain;
    }),
  };
  return { db: db as unknown as SupabaseClient, rpcCalls, raw: db };
}

function recorder(results: SaveResult[]) {
  const calls: AssignedNumber[] = [];
  const save = async (assigned: AssignedNumber) => {
    calls.push(assigned);
    const result = results.shift() ?? { success: true as const, invoiceId: `inv-${calls.length}` };
    return { result, built: { number: assigned.number } };
  };
  return { calls, save };
}

const moved: SaveResult = { success: false, error: 'invoice_number_moved', numberConflict: 'moved' };

describe('numer wpisany w pole (bez licznika serii)', () => {
  it('bez serii: zapis z numerem z pola, bez wywołań bazy i bez nowych kolumn', async () => {
    const { db, raw } = fakeDb();
    const { calls, save } = recorder([]);

    const out = await saveWithInvoiceNumber(db, { typed: 'FV/7/2026' }, DAY, save);

    expect(out.result).toEqual({ success: true, invoiceId: 'inv-1' });
    expect(calls).toEqual([{ number: 'FV/7/2026', columns: {}, fromSeries: false }]);
    expect(raw.rpc).not.toHaveBeenCalled();
    expect(raw.from).not.toHaveBeenCalled();
  });

  it('numer zmieniony ręcznie w serii: numer z pola, seria i klucz zapisu, bez licznika', async () => {
    const { db, raw } = fakeDb();
    const { calls, save } = recorder([]);

    await saveWithInvoiceNumber(
      db,
      { typed: 'FV/50/11/2026', seriesId: SERIES, preview: 'FV/8/11/2026', requestKey: KEY },
      DAY,
      save,
    );

    expect(calls).toEqual([
      { number: 'FV/50/11/2026', columns: { number_series_id: SERIES, number_request_key: KEY }, fromSeries: false },
    ]);
    expect(raw.rpc).not.toHaveBeenCalled();
  });

  it('zajęty numer wpisany ręcznie: komunikat zapisu bez zmian (bez ponowienia z innym numerem)', async () => {
    const { db } = fakeDb();
    const taken: SaveResult = {
      success: false,
      error: 'Faktura o numerze "FV/7/2026" już istnieje. Sprawdź listę faktur lub wybierz inny numer.',
      numberConflict: 'number_taken',
    };
    const { calls, save } = recorder([taken]);

    const out = await saveWithInvoiceNumber(db, { typed: 'FV/7/2026' }, DAY, save);

    expect(calls).toHaveLength(1);
    expect(out.result).toEqual({
      success: false,
      error: 'Faktura o numerze "FV/7/2026" już istnieje. Sprawdź listę faktur lub wybierz inny numer.',
    });
  });
});

describe('numer z licznika serii', () => {
  it('numer z pola równy podpowiedzi: numer, okres i licznik z bazy w kolumnach zapisu', async () => {
    const { db, rpcCalls } = fakeDb({ next: [{ status: 'ok', counter: 8 }] });
    const { calls, save } = recorder([]);

    const out = await saveWithInvoiceNumber(
      db,
      { typed: 'FV/8/11/2026', seriesId: SERIES, preview: 'FV/8/11/2026', requestKey: KEY },
      DAY,
      save,
    );

    expect(out.result).toEqual({ success: true, invoiceId: 'inv-1' });
    expect(rpcCalls).toEqual([{ fn: 'invoice_number_next', args: { p_series_id: SERIES, p_issue_date: DAY } }]);
    expect(calls).toEqual([
      {
        number: 'FV/8/11/2026',
        columns: { number_series_id: SERIES, number_period: '2026-11', number_counter: 8, number_request_key: KEY },
        fromSeries: true,
      },
    ]);
  });

  it('numer zajęty w międzyczasie (wyzwalacz: moved): kolejny numer z licznika, inny niż pierwszy', async () => {
    const { db } = fakeDb({ next: [{ status: 'ok', counter: 8 }, { status: 'ok', counter: 9 }] });
    const { calls, save } = recorder([moved]);

    const out = await saveWithInvoiceNumber(db, { typed: 'FV/8/11/2026', seriesId: SERIES, preview: 'FV/8/11/2026' }, DAY, save);

    expect(out.result).toEqual({ success: true, invoiceId: 'inv-2' });
    expect(calls.map((c) => c.number)).toEqual(['FV/8/11/2026', 'FV/9/11/2026']);
    expect(out.built).toEqual({ number: 'FV/9/11/2026' });
  });

  it('numer z serii zajęty przez fakturę spoza serii (indeks numeru): też kolejny numer', async () => {
    const { db } = fakeDb({ next: [{ status: 'ok', counter: 8 }, { status: 'ok', counter: 9 }] });
    const { calls, save } = recorder([{ success: false, error: 'zajęty', numberConflict: 'number_taken' }]);

    const out = await saveWithInvoiceNumber(db, { typed: 'FV/8/11/2026', seriesId: SERIES, preview: 'FV/8/11/2026' }, DAY, save);

    expect(out.result.success).toBe(true);
    expect(calls.map((c) => c.number)).toEqual(['FV/8/11/2026', 'FV/9/11/2026']);
  });

  it('po 5 zajętych numerach z rzędu: komunikat zamiast kolejnych prób', async () => {
    const { db } = fakeDb({ next: [1, 2, 3, 4, 5, 6].map((counter) => ({ status: 'ok' as const, counter })) });
    const { calls, save } = recorder([moved, moved, moved, moved, moved, moved]);

    const out = await saveWithInvoiceNumber(db, { typed: 'FV/1/11/2026', seriesId: SERIES, preview: 'FV/1/11/2026' }, DAY, save);

    expect(calls).toHaveLength(5);
    expect(out.result).toEqual({ success: false, error: NUMBER_RACE_MESSAGE });
    expect(NUMBER_RACE_MESSAGE).not.toContain('—');
  });

  it('drugi zapis z tego samego otwarcia formularza (klucz zapisu): numer pierwszej faktury, bez drugiej', async () => {
    const { db } = fakeDb({
      next: [{ status: 'ok', counter: 9 }],
      savedByKey: { id: 'inv-first', internal_number: 'FV/8/11/2026' },
    });
    const { calls, save } = recorder([{ success: false, error: 'invoice_number_request_done', numberConflict: 'request_done' }]);

    const out = await saveWithInvoiceNumber(
      db,
      { typed: 'FV/8/11/2026', seriesId: SERIES, preview: 'FV/8/11/2026', requestKey: KEY },
      DAY,
      save,
    );

    expect(calls).toHaveLength(1);
    expect(out.result).toMatchObject({ success: false, invoiceId: 'inv-first' });
    expect(out.result.success ? '' : out.result.error).toContain('FV/8/11/2026');
  });

  it('seria bez wzoru (numeracja jak dotąd): numer z pola z serią, bez licznika', async () => {
    const { db } = fakeDb({ next: [{ status: 'refused', code: 'no_pattern' }] });
    const { calls, save } = recorder([]);

    await saveWithInvoiceNumber(db, { typed: 'FV/8/11/2026', seriesId: SERIES, preview: 'FV/8/11/2026' }, DAY, save);

    expect(calls).toEqual([{ number: 'FV/8/11/2026', columns: { number_series_id: SERIES }, fromSeries: false }]);
  });

  it.each(['archived', 'not_found', 'exhausted'])('seria odmawia (%s): komunikat z wyjściem, bez zapisu', async (code) => {
    const { db } = fakeDb({ next: [{ status: 'refused', code }] });
    const { calls, save } = recorder([]);

    const out = await saveWithInvoiceNumber(db, { typed: 'FV/8/11/2026', seriesId: SERIES, preview: 'FV/8/11/2026' }, DAY, save);

    expect(calls).toHaveLength(0);
    expect(out.result.success).toBe(false);
    const error = out.result.success ? '' : out.result.error;
    expect(error).toMatch(/seri/i);
    expect(error).not.toContain('—');
  });
});

describe('rozpoznanie konfliktu numeru z błędu bazy', () => {
  it.each<[{ code: string; message: string }, NumberConflict | null]>([
    [{ code: 'P0001', message: 'invoice_number_moved' }, 'moved'],
    [{ code: 'P0001', message: 'invoice_number_request_done' }, 'request_done'],
    [{ code: '23505', message: 'duplicate key value violates unique constraint "uq_invoices_number_request_key"' }, 'request_done'],
    [{ code: '23505', message: 'duplicate key value violates unique constraint "uq_invoices_tenant_outgoing_internal_number"' }, 'number_taken'],
    [{ code: '23505', message: 'duplicate key value violates unique constraint "uq_invoices_number_series_counter"' }, 'moved'],
    [{ code: '23505', message: 'duplicate key value violates unique constraint "uq_invoices_recurring_period"' }, null],
    [{ code: 'P0001', message: 'invoice_number_series_archived' }, null],
  ])('%j → %s', (error, expected) => {
    expect(numberConflictOf(error)).toBe(expected);
  });

  it('brak błędu to brak konfliktu', () => {
    expect(numberConflictOf(null)).toBeNull();
  });
});
