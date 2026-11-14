import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plan aplikacji mobilnej 4.3, etap M8: logika „Wystaw i wyślij”, szkicu
 * i wysyłki szkicu z akcji strony (`components/invoices/actions.ts`,
 * `draft-actions.ts`) leży w `lib/invoices/issue-regular.ts` i
 * `lib/invoices/send-draft.ts`, żeby trasa `POST /api/mobile/v1/faktury`
 * wołała te same funkcje co strona.
 *
 * Test zgodności (charakterystyka): akcja strony i funkcja z `lib/` na tych
 * samych danych robią te same zapisy w tej samej kolejności (wiersz faktury,
 * pozycje, audyt) i zlecają kolejkę KSeF tymi samymi argumentami. Atrapy tylko
 * dla bazy (klient Supabase) i granic: kolejka, audyt, sesja z ciasteczek.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  audit: vi.fn(),
  enqueue: vi.fn(),
  calls: [] as Array<{ table: string; op: string; payload?: unknown; filters: Array<[string, unknown]> }>,
  draftRow: null as Record<string, unknown> | null,
}));

const TENANT_ROW = {
  id: 'ten-1',
  nip: '5260001246',
  name: 'Moja Firma',
  address_json: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' },
  vat_exemption_basis: null,
  vat_cash_method: false,
};

function fakeSupabase() {
  return {
    from(table: string) {
      const call: (typeof mocks.calls)[number] = { table, op: 'select', filters: [] };
      mocks.calls.push(call);
      const q = {
        select: () => q,
        eq: (column: string, value: unknown) => {
          call.filters.push([column, value]);
          return q;
        },
        insert: (payload: unknown) => {
          call.op = 'insert';
          call.payload = payload;
          return q;
        },
        delete: () => {
          call.op = 'delete';
          return q;
        },
        maybeSingle: async () => ({
          data: table === 'tenants' ? TENANT_ROW : table === 'invoices' ? mocks.draftRow : null,
          error: null,
        }),
        single: async () => ({ data: call.op === 'insert' ? { id: 'inv-new' } : null, error: null }),
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
          Promise.resolve({ data: table === 'ksef_submissions' ? [] : null, error: null }).then(ok, fail),
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
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: vi.fn() }));

import { saveAndSendInvoiceAction, saveDraftAction } from '@/components/invoices/actions';
import { sendDraftInvoiceAction } from '@/components/invoices/draft-actions';
import {
  parseRegularInvoiceForm,
  readTenantSnapshot,
  saveAndSendRegularInvoice,
  saveRegularDraft,
  type RegularIssueContext,
} from '@/lib/invoices/issue-regular';
import { sendRegularDraft } from '@/lib/invoices/send-draft';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

// 2026-11-13 10:00 czasu polskiego.
const NOW = new Date('2026-11-13T09:00:00Z');
const DZIS = '2026-11-13';

const form = (extra: Partial<InvoiceFormValues> = {}): InvoiceFormValues => ({
  internalNumber: 'FV/7/11/2026',
  issueDate: DZIS,
  saleDate: '',
  buyerNip: '5252241585',
  buyerName: 'Klient Sp. z o.o.',
  buyerAddressLine1: 'ul. B 2',
  buyerAddressLine2: '00-002 Warszawa',
  buyerEmail: 'klient@example.test',
  buyerIsConsumer: false,
  buyerPesel: '',
  buyerIdDocument: '',
  paymentMethod: 'transfer',
  paymentDueDate: '2026-11-27',
  bankAccount: 'PL61109010140000071219812874',
  notes: 'Dziękujemy',
  splitPayment: false,
  lines: [
    { name: 'Projekt graficzny', unit: 'szt', quantity: 2, unitPriceNet: 1500, vatRate: '23' },
    { name: 'Konsultacja', unit: 'godz.', quantity: 1.5, unitPriceNet: 200.5, vatRate: '8' },
  ],
  ...extra,
});

/** Zapisy do bazy i wywołania granic jednego przebiegu, bez obiektu klienta. */
function przebieg() {
  return {
    zapisy: mocks.calls.filter((c) => c.op !== 'select').map(({ table, op, payload, filters }) => ({ table, op, payload, filters })),
    odczyty: mocks.calls.filter((c) => c.op === 'select').map(({ table, filters }) => ({ table, filters })),
    kolejka: mocks.enqueue.mock.calls.map(([params]) => {
      const { supabase: _klient, ...reszta } = params as Record<string, unknown>;
      return reszta;
    }),
    audyt: mocks.audit.mock.calls.map(([wpis]) => wpis),
  };
}

function wyczysc() {
  mocks.calls = [];
  mocks.enqueue.mockClear();
  mocks.audit.mockClear();
}

async function kontekst(): Promise<RegularIssueContext> {
  const supabase = fakeSupabase() as unknown as RegularIssueContext['supabase'];
  return { supabase, userId: 'user-1', tenant: await readTenantSnapshot(supabase, 'ten-1') };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.calls = [];
  mocks.draftRow = null;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.auth.mockImplementation(async () => ({ supabase: fakeSupabase(), user: { id: 'user-1' }, tenantId: 'ten-1', role: 'owner' }));
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
});

describe('„Wystaw i wyślij”: akcja strony i lib robią to samo', () => {
  it('zapis szkicu, pozycje i kolejka KSeF z tymi samymi danymi', async () => {
    const zAkcji = await saveAndSendInvoiceAction(form(), 'ten-1');
    const strona = przebieg();
    wyczysc();

    const ctx = await kontekst();
    mocks.calls = [];
    const zLib = await saveAndSendRegularInvoice(ctx, form());
    const lib = przebieg();

    expect(zAkcji).toEqual({ success: true, invoiceId: 'inv-new', offline: false });
    expect(zLib).toEqual(zAkcji);
    expect(lib.zapisy).toEqual(strona.zapisy);
    expect(lib.kolejka).toEqual(strona.kolejka);
    expect(lib.audyt).toEqual(strona.audyt);
    // Strona czyta firmę przed resztą; lib dostaje ją w kontekście (`readTenantSnapshot`).
    expect(lib.odczyty).toEqual(strona.odczyty.slice(1));
    expect(strona.zapisy.map((z) => z.table)).toEqual(['invoices', 'invoice_line_items']);
    expect(strona.kolejka).toHaveLength(1);
  });

  it('odmowa kolejki (brak certyfikatu) zostawia szkic z tym samym wpisem audytu', async () => {
    const odmowa = { ok: false, error: 'Najpierw wgraj certyfikat KSeF w Ustawienia KSeF — bez niego wysyłka nie jest możliwa. Faktura została zapisana jako szkic.' };
    mocks.enqueue.mockResolvedValue(odmowa);
    const zAkcji = await saveAndSendInvoiceAction(form(), 'ten-1');
    const strona = przebieg();
    wyczysc();

    const zLib = await saveAndSendRegularInvoice(await kontekst(), form());
    const lib = przebieg();

    expect(zAkcji).toEqual({ success: false, error: odmowa.error, invoiceId: 'inv-new' });
    expect(zLib).toEqual(zAkcji);
    expect(lib.audyt).toEqual(strona.audyt);
    expect(strona.audyt).toEqual([expect.objectContaining({ action: 'invoice.draft_created', metadata: expect.objectContaining({ note: 'submit_blocked_no_ksef_cert' }) })]);
  });

  it('data wystawienia inna niż dziś: ta sama odmowa, bez zapisu i bez kolejki', async () => {
    const zAkcji = await saveAndSendInvoiceAction(form({ issueDate: '2026-11-12' }), 'ten-1');
    const zLib = await saveAndSendRegularInvoice(await kontekst(), form({ issueDate: '2026-11-12' }));
    expect(zAkcji.success).toBe(false);
    expect(zLib).toEqual(zAkcji);
    expect(mocks.calls.filter((c) => c.op === 'insert')).toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('błąd schematu: ten sam pierwszy komunikat co akcja', async () => {
    const zle = form({ buyerName: '' });
    const zAkcji = await saveAndSendInvoiceAction(zle, 'ten-1');
    const parsed = parseRegularInvoiceForm(zle);
    expect(zAkcji.success).toBe(false);
    expect(parsed.ok).toBe(false);
    if (!zAkcji.success && !parsed.ok) {
      expect(parsed.error).toBe(zAkcji.error);
      expect(parsed.path).toEqual(['buyerName']);
    }
  });
});

describe('szkic: akcja strony i lib robią to samo', () => {
  it('ten sam wiersz, pozycje i wpis invoice.draft_created', async () => {
    const zAkcji = await saveDraftAction(form({ issueDate: '2026-11-20' }), 'ten-1');
    const strona = przebieg();
    wyczysc();

    const zLib = await saveRegularDraft(await kontekst(), form({ issueDate: '2026-11-20' }));
    const lib = przebieg();

    expect(zAkcji).toEqual({ success: true, invoiceId: 'inv-new' });
    expect(zLib).toEqual(zAkcji);
    expect(lib.zapisy).toEqual(strona.zapisy);
    expect(lib.audyt).toEqual(strona.audyt);
    expect(strona.kolejka).toEqual([]);
    expect(strona.audyt).toEqual([expect.objectContaining({ action: 'invoice.draft_created' })]);
  });
});

describe('wysyłka szkicu: akcja strony i lib robią to samo', () => {
  const szkic = {
    id: 'inv-1',
    ksef_status: 'draft',
    direction: 'outgoing',
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    internal_number: 'FV/7/11/2026',
    fa3_data: null as unknown,
  };

  beforeEach(async () => {
    // fa3_data jak zapisała go strona: faktura zbudowana z formularza.
    const { buildInvoiceFromForm } = await import('@/lib/invoices/build-from-form');
    szkic.fa3_data = buildInvoiceFromForm(form(), { id: 'ten-1', nip: TENANT_ROW.nip, name: TENANT_ROW.name, address: TENANT_ROW.address_json }, null, false);
    mocks.draftRow = szkic;
  });

  it('ta sama kolejka i ten sam wynik', async () => {
    const zAkcji = await sendDraftInvoiceAction('inv-1');
    const strona = przebieg();
    wyczysc();

    const zLib = await sendRegularDraft({ supabase: fakeSupabase() as never, userId: 'user-1', tenantId: 'ten-1' }, 'inv-1');
    const lib = przebieg();

    expect(zAkcji).toEqual({ success: true, offline: false });
    expect(zLib).toEqual(zAkcji);
    expect(lib.kolejka).toEqual(strona.kolejka);
    expect(lib.odczyty).toEqual(strona.odczyty);
    expect(strona.kolejka).toEqual([expect.objectContaining({ invoiceId: 'inv-1', nip: TENANT_ROW.nip, auditKind: 'regular', userId: 'user-1' })]);
  });

  it('faktura po wysyłce: ta sama odmowa, bez kolejki', async () => {
    mocks.draftRow = { ...szkic, ksef_status: 'queued' };
    const zAkcji = await sendDraftInvoiceAction('inv-1');
    const zLib = await sendRegularDraft({ supabase: fakeSupabase() as never, userId: 'user-1', tenantId: 'ten-1' }, 'inv-1');
    expect(zAkcji).toEqual({ success: false, error: 'Do KSeF można wysłać tylko szkic.' });
    expect(zLib).toEqual({ ...zAkcji, reason: 'not_draft' });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('obca albo nieistniejąca faktura: ta sama odmowa', async () => {
    mocks.draftRow = null;
    const zAkcji = await sendDraftInvoiceAction('inv-1');
    const zLib = await sendRegularDraft({ supabase: fakeSupabase() as never, userId: 'user-1', tenantId: 'ten-1' }, 'inv-1');
    expect(zAkcji).toEqual({ success: false, error: 'Nie znaleziono faktury w tej organizacji.' });
    expect(zLib).toEqual({ ...zAkcji, reason: 'not_found' });
  });
});
