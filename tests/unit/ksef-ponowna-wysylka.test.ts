import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cykl życia faktury, PR 3b (K3 z rewizji 03.10.2026): „Wyślij ponownie”
 * i „Wróć do szkicu” mają prawdziwą implementację. Do 03.10.2026
 * `resendInvoiceAction` zawsze odpowiadała „wstrzymana, uzgodnij ręcznie”,
 * a powrotu do szkicu nie było — każda nieudana wysyłka była ślepą uliczką.
 *
 * A4b PR2b: akcja czyta kolumny źródła ponowienia (`KSEF_RESEND_SOURCE_COLUMNS`)
 * i bierze fakty oraz dane zdarzenia z tego samego modułu co cron i operator.
 * Kolumna niepobrana to błąd programisty — trafia do Sentry, klient dostaje
 * ogólny komunikat.
 */

const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const m = vi.hoisted(() => ({
  ctx: vi.fn(),
  enqueue: vi.fn(),
  rpc: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  revalidate: vi.fn(),
  row: null as Record<string, unknown> | null,
  tenant: { nip: '5260001246' } as Record<string, unknown> | null,
}));

vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return {
    ActionAuthError,
    requireUserAndActiveOrg: m.ctx,
    requireOrgRole: async (roles: string | string[]) => {
      const ctx = await m.ctx();
      const allowed = Array.isArray(roles) ? roles : [roles];
      if (!allowed.includes(ctx.role)) throw new ActionAuthError('Niewystarczające uprawnienia');
      return ctx;
    },
  };
});
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: m.enqueue }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: m.rpc }) }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: m.captureMessage, captureException: m.captureException }));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: vi.fn() }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: vi.fn() }));
vi.mock('@/lib/pdf/invoice-data', () => ({ loadInvoiceForPdf: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendInvoiceEmail: vi.fn() }));

import { resendInvoiceAction, resetInvoiceToDraftAction } from '@/components/invoices/actions-detail';
import { KSEF_SEND_MESSAGES, KSEF_SPECIAL_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';
import { SUPPORT_EMAIL } from '@/lib/site';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';

const GENERIC_RESEND_ERROR = 'Nie można sprawdzić możliwości ponownej wysyłki. Spróbuj później.';

function snapshot() {
  return finalizeInvoice({
    internalNumber: 'FV 7/10/2026',
    type: 'VAT',
    issueDate: '2026-10-02',
    saleDate: '2026-10-02',
    seller: { nip: '5260001246', name: 'Moja Firma', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
    buyer: { nip: '5252241585', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
    lines: [{ ordinal: 1, name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-10-16', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  });
}

/** Wiersz z kolumnami źródła ponowienia (`KSEF_RESEND_SOURCE_COLUMNS`) — zwykła faktura ma `special_data` NULL. */
function failedRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ksef_status: 'failed', direction: 'outgoing', invoice_kind: 'regular', invoice_type: 'VAT',
    last_error_code: 'INFRA', issue_date: '2026-10-02', fa3_data: snapshot(), special_data: null, ...extra,
  };
}

function session(role = 'owner') {
  const query = (table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: table === 'tenants' ? m.tenant : m.row, error: null }),
    };
    return q;
  };
  return { supabase: { from: query }, user: { id: USER }, tenantId: TENANT, role };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.row = failedRow();
  m.tenant = { nip: '5260001246' };
  m.ctx.mockResolvedValue(session('owner'));
  m.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
  m.rpc.mockResolvedValue({ data: { id: ID }, error: null });
});

describe('resendInvoiceAction — ponowna wysyłka przez requeue_ksef_send', () => {
  it.each([
    ['INFRA (transient)', 'INFRA'],
    ['NO_CERTIFICATE (setup)', 'NO_CERTIFICATE'],
    ['brak kodu (historyczny)', null],
  ])('failed z %s: kolejkuje w trybie requeue z aktorem, danymi ze snapshotu i NIP-em firmy', async (_l, code) => {
    m.row = failedRow({ last_error_code: code });

    await expect(resendInvoiceAction(ID)).resolves.toEqual({ success: true });

    expect(m.enqueue).toHaveBeenCalledTimes(1);
    expect(m.enqueue.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
      userId: USER,
      invoiceId: ID,
      nip: '5260001246',
      auditKind: 'regular',
      invoice: expect.objectContaining({ internalNumber: 'FV 7/10/2026' }),
      mode: { kind: 'requeue', actorUserId: USER },
    });
    expect(m.revalidate).toHaveBeenCalledWith(`/invoices/${ID}`);
  });

  it.each([
    ['rejected', { ksef_status: 'rejected', last_error_code: 'KSEF_REJECTED' }, KSEF_SEND_MESSAGES.rejected],
    ['failed terminal', { last_error_code: 'INVALID_DOCUMENT' }, KSEF_SEND_MESSAGES.terminal],
    ['failed hold', { last_error_code: 'KSEF_PAUSED' }, KSEF_SEND_MESSAGES.hold],
    ['przychodząca', { direction: 'incoming' }, KSEF_SEND_MESSAGES.direction],
    ['accepted', { ksef_status: 'accepted', last_error_code: null }, KSEF_SEND_MESSAGES.status],
  ])('%s → odmowa bez zlecenia', async (_l, patch, message) => {
    m.row = failedRow(patch);

    await expect(resendInvoiceAction(ID)).resolves.toEqual({ success: false, error: message });
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('A4b PR2b: stary KOR bez kopii (special_data NULL) → odmowa „wystaw od nowa” z adresem pomocy, bez zlecenia', async () => {
    m.row = failedRow({ invoice_kind: 'correction', invoice_type: 'KOR' });

    const result = await resendInvoiceAction(ID);
    expect(result.success).toBe(false);
    const error = result.success ? '' : result.error;
    // Do PR2b: jeden tekst „special” dla każdego dokumentu specjalnego, bez powodu i bez wyjścia.
    expect(error).toMatch(/kopii danych korekty/);
    expect(error).toContain(SUPPORT_EMAIL);
    expect(error).toBe(KSEF_SPECIAL_SEND_MESSAGES.incomplete('correction'));
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('A4b PR2b: zwykła faktura z niepustym special_data → M.incomplete (lustro granicy wysyłki), bez zlecenia', async () => {
    m.row = failedRow({ special_data: { correctionData: { invoiceType: 'correction', issueDate: '2026-10-02' } } });

    // Do PR2b akcja sprawdzała tylko `fa3_data.lines` i kolejkowała taki wiersz.
    await expect(resendInvoiceAction(ID)).resolves.toEqual({ success: false, error: KSEF_SEND_MESSAGES.incomplete });
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('A4b PR2b: wiersz bez pobranej kolumny special_data → ogólny komunikat i Sentry.captureException (kontrakt kolumn)', async () => {
    const row = failedRow();
    delete row.special_data;
    m.row = row;

    // Do PR2b akcja nie czytała special_data i kolejkowała wiersz bez niej.
    await expect(resendInvoiceAction(ID)).resolves.toEqual({ success: false, error: GENERIC_RESEND_ERROR });
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.captureException).toHaveBeenCalledTimes(1);
    expect(m.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('KSEF_RESEND_SOURCE_COLUMNS') }),
      expect.objectContaining({
        tags: expect.objectContaining({ area: 'ksef.resend' }),
        extra: expect.objectContaining({ invoiceId: ID }),
      }),
    );
  });

  it('klasa reconcile, KSEF_DUPLICATE_RECONCILE: odmowa tekstem „duplikat” bez „operatora” i alarm dla operatora (Sentry.captureMessage)', async () => {
    m.row = failedRow({ last_error_code: 'KSEF_DUPLICATE_RECONCILE' });

    // D-A4-1b-3 PR B (zasada z 07.10.2026): klient decyduje sam na karcie faktury,
    // więc tekst nie odsyła do operatora (do PR B: M.reconcile „zajmuje się tym
    // operator FaktWay”). Alarm Sentry dla operatora zostaje.
    const result = await resendInvoiceAction(ID);
    expect(result.success).toBe(false);
    const error = result.success ? '' : result.error;
    expect(error).not.toMatch(/operator/);
    expect(error).toContain(SUPPORT_EMAIL);
    expect(result).toEqual({ success: false, error: KSEF_SEND_MESSAGES.duplicate });
    expect(m.captureMessage).toHaveBeenCalledWith(expect.stringContaining('uzgodnienia'), expect.objectContaining({
      extra: expect.objectContaining({ invoiceId: ID, tenantId: TENANT, code: 'KSEF_DUPLICATE_RECONCILE' }),
    }));
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('strażnik: inne kody klasy reconcile (RESULT_UNCERTAIN) — dalej M.reconcile i alarm (§7 p. 17)', async () => {
    m.row = failedRow({ last_error_code: 'RESULT_UNCERTAIN' });

    await expect(resendInvoiceAction(ID)).resolves.toEqual({ success: false, error: KSEF_SEND_MESSAGES.reconcile });
    expect(m.captureMessage).toHaveBeenCalledWith(expect.stringContaining('uzgodnienia'), expect.objectContaining({
      extra: expect.objectContaining({ code: 'RESULT_UNCERTAIN' }),
    }));
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('member / accountant: odmowa przed odczytem faktury', async () => {
    for (const role of ['member', 'accountant']) {
      m.ctx.mockResolvedValue(session(role));
      await expect(resendInvoiceAction(ID)).resolves.toEqual({ success: false, error: KSEF_SEND_MESSAGES.role });
    }
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('odmowa kolejki (np. P0002 z RPC) wraca do klienta, bez sukcesu', async () => {
    m.enqueue.mockResolvedValue({ ok: false, error: 'Ta faktura jest już wysyłana albo nie jest szkicem.' });
    await expect(resendInvoiceAction(ID)).resolves.toEqual({ success: false, error: 'Ta faktura jest już wysyłana albo nie jest szkicem.' });
  });

  it('snapshot bez pozycji → odmowa z poleceniem powrotu do szkicu', async () => {
    m.row = failedRow({ fa3_data: { internalNumber: 'FV 7/10/2026' } });
    await expect(resendInvoiceAction(ID)).resolves.toEqual({ success: false, error: KSEF_SEND_MESSAGES.incomplete });
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it('brak faktury w firmie i brak sesji → komunikaty bez szczegółów bazy', async () => {
    m.row = null;
    await expect(resendInvoiceAction(ID)).resolves.toEqual({ success: false, error: KSEF_SEND_MESSAGES.notFound });
    m.ctx.mockRejectedValue(new Error('PRIVATE-DB-DIAGNOSTIC'));
    const r = await resendInvoiceAction(ID);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).not.toContain('PRIVATE');
  });
});

describe('resetInvoiceToDraftAction — powrót do szkicu przez reset_ksef_send', () => {
  it('owner: RPC adminem z firmą i aktorem, odświeżenie widoków', async () => {
    await expect(resetInvoiceToDraftAction(ID)).resolves.toEqual({ success: true });
    expect(m.rpc).toHaveBeenCalledWith('reset_ksef_send', { p_invoice_id: ID, p_tenant_id: TENANT, p_actor_user_id: USER });
    expect(m.revalidate).toHaveBeenCalledWith(`/invoices/${ID}`);
  });

  it('odmowa RPC (dowód kontaktu, klasa reconcile) wraca komunikatem RPC', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'Faktura mogła dotrzeć do KSeF — wymaga uzgodnienia, nie powrotu do szkicu' } });
    await expect(resetInvoiceToDraftAction(ID)).resolves.toEqual({
      success: false,
      error: 'Faktura mogła dotrzeć do KSeF — wymaga uzgodnienia, nie powrotu do szkicu',
    });
  });

  it('member: odmowa roli, RPC nie jest wołane', async () => {
    m.ctx.mockResolvedValue(session('member'));
    await expect(resetInvoiceToDraftAction(ID)).resolves.toEqual({ success: false, error: 'Niewystarczające uprawnienia' });
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
