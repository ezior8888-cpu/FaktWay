import { beforeEach, expect, it, vi } from 'vitest';

/**
 * Granica rodzaju dokumentu przy „Wyślij ponownie” (PR 3b cyklu życia,
 * A4b PR2b): KOR/ZAL wysyłamy ponownie z kopii na wierszu (`special_data`,
 * `fa3_data.advanceEnvelope`) tylko w dniu wystawienia. Bez kopii albo przy
 * wstrzymanym rodzaju (ROZ do C4) akcja odmawia z powodem i wyjściem —
 * kolejność klienta: rodzaj wstrzymany → dane → data. Zwykła faktura `failed`
 * jest ponawiana przez `requeue_ksef_send`, a select czyta krotkę
 * `KSEF_RESEND_SOURCE_COLUMNS` (ta sama co cron i operator).
 */

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  update: vi.fn(),
  enqueue: vi.fn(),
  logAudit: vi.fn(),
  row: {} as Record<string, unknown>,
}));

vi.mock('@/lib/supabase/auth-context', () => ({
  ActionAuthError: class ActionAuthError extends Error {},
  requireUserAndActiveOrg: mocks.requireAuth,
  requireOrgRole: mocks.requireAuth,
}));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: mocks.enqueue }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: vi.fn() }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.logAudit }));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: vi.fn() }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: vi.fn() }));
vi.mock('@/lib/pdf/invoice-data', () => ({ loadInvoiceForPdf: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendInvoiceEmail: vi.fn() }));

import { resendInvoiceAction } from '@/components/invoices/actions-detail';
import { KSEF_RESEND_SOURCE_COLUMNS } from '@/lib/invoices/ksef-requeue-event';
import { KSEF_SPECIAL_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';

const invoiceId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';

const snapshot = finalizeInvoice({
  internalNumber: 'FV 2/10/2026',
  type: 'VAT',
  issueDate: '2026-10-01',
  saleDate: '2026-10-01',
  seller: { nip: '5260001246', name: 'Firma', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
  buyer: { nip: '5252241585', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
  lines: [{ ordinal: 1, name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
  payment: { currency: 'PLN', dueDate: '2026-10-15', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
  const query = {
    select: (columns: string) => { mocks.select(columns); return query; },
    eq: (key: string, value: unknown) => { mocks.eq(key, value); return query; },
    maybeSingle: async () => ({ data: mocks.row, error: null }),
    update: (patch: unknown) => { mocks.update(patch); return query; },
  };
  mocks.from.mockReturnValue(query);
  mocks.requireAuth.mockResolvedValue({
    supabase: { from: mocks.from },
    user: { id: 'fixture-user' },
    tenantId,
    role: 'owner',
  });
});

// Komunikat liczony w teście (nie przy zbieraniu tabeli) i wzorzec powodu, czerwony do PR2b
// (wtedy każdy dokument specjalny dostawał jeden tekst „special”, a odrzucona korekta — tekst zwykłej faktury).
it.each([
  ['correction', 'failed', /kopii danych korekty/, () => KSEF_SPECIAL_SEND_MESSAGES.incomplete('correction')],
  ['advance', 'failed', /kopii danych faktury zaliczkowej/, () => KSEF_SPECIAL_SEND_MESSAGES.incomplete('advance')],
  // Kolejność klienta: rodzaj wstrzymany przed brakiem danych (projekt mówił „incomplete”).
  ['final', 'failed', /faktur rozliczeniowych do KSeF jest wstrzymana/, () => KSEF_SPECIAL_SEND_MESSAGES.kindHeld('final')],
  ['correction', 'rejected', /treść korekty/, () => KSEF_SPECIAL_SEND_MESSAGES.rejected('correction')],
] as const)('blocks %s/%s resend before any job or status update', async (kind, status, reason, message) => {
  mocks.row = { ksef_status: status, direction: 'outgoing', invoice_kind: kind, invoice_type: 'KOR', last_error_code: 'INFRA', issue_date: '2026-10-01', fa3_data: snapshot, special_data: null };

  const result = await resendInvoiceAction(invoiceId);

  expect(result.success).toBe(false);
  expect(result.success ? '' : result.error).toMatch(reason);
  expect(result).toEqual({ success: false, error: message() });
  expect(mocks.eq).toHaveBeenCalledWith('id', invoiceId);
  expect(mocks.eq).toHaveBeenCalledWith('tenant_id', tenantId);
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.logAudit).not.toHaveBeenCalled();
});

it('regular/failed is requeued through the lifecycle RPC, never by a session status update', async () => {
  mocks.row = { ksef_status: 'failed', direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT', last_error_code: 'INFRA', issue_date: '2026-10-01', fa3_data: snapshot, special_data: null };

  expect(await resendInvoiceAction(invoiceId)).toEqual({ success: true });
  expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ mode: { kind: 'requeue', actorUserId: 'fixture-user' } }));
  expect(mocks.update).not.toHaveBeenCalled();
  // A4b PR2b: ta sama krotka kolumn źródła co cron i operator (do PR2b — literał bez special_data).
  expect(mocks.select).toHaveBeenCalledWith(expect.stringContaining(KSEF_RESEND_SOURCE_COLUMNS));
});
