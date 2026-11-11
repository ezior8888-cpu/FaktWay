import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';

/**
 * Akcje proformy i oferty (plan kompletnej aplikacji, krok 2.4) na prawdziwej
 * ścieżce: schemat, kontrahent z bazy firmy, kwoty z funkcji faktury, PDF,
 * wysyłka przez `sendEmail` i `sendViaResend` z kluczem idempotencji. Atrapy
 * tylko dla sesji, bazy (w pamięci, z RPC) i HTTP do Resend. RLS, numeracja
 * w bazie, wyzwalacz „wystawionego nie zmieniasz” i zapis historii raz na
 * klucz: tests/rls-proformy.test.ts na prawdziwym Postgresie.
 */

const TENANT = 'ten-1';
const OTHER = 'ten-2';
const KONTRAHENT = '0b8a3f4e-2c1d-4e5f-8a9b-0c1d2e3f4a5b';
const OBCY_KONTRAHENT = '1c9b4a5f-3d2e-4f60-9bac-1d2e3f4a5b6c';
const DOKUMENT = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';
const ODBIORCA = 'zakupy@kontrahent.test';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  audit: vi.fn(),
  revalidate: vi.fn(),
  resendSend: vi.fn(),
  canSendTo: vi.fn(),
  rpc: vi.fn(),
  lookup: vi.fn(),
}));

vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: mocks.auth,
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('resend', () => ({ Resend: class { emails = { send: mocks.resendSend }; } }));
vi.mock('@/lib/email/preferences', () => ({ canSendTo: mocks.canSendTo }));
// Wyszukanie po NIP z formularza faktury (baza firmy albo GUS): granica HTTP do GUS.
vi.mock('@/components/invoices/actions', () => ({ lookupBuyerAction: mocks.lookup }));

import {
  addQuoteContractorAction,
  deleteQuoteDraftAction,
  issueQuoteAction,
  saveQuoteDraftAction,
  sendQuoteEmailAction,
} from '@/app/actions/proformy';
import { quoteEmailIdempotencyKey } from '@/lib/proformy/mail';
import { ActionAuthError } from '@/lib/supabase/auth-context';

let db: MemoryDb;

function kontrahent(extra: Row = {}): Row {
  return {
    id: KONTRAHENT,
    tenant_id: TENANT,
    nip: '1234567890',
    name: 'Kontrahent Testowy',
    address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
    email: ODBIORCA,
    ...extra,
  };
}

const STRONA = {
  name: 'Kontrahent Testowy',
  nip: '1234567890',
  countryCode: 'PL',
  addressLine1: 'ul. Klienta 10',
  addressLine2: '02-001 Warszawa',
  email: ODBIORCA,
};

function dokument(extra: Row = {}): Row {
  return {
    id: DOKUMENT,
    tenant_id: TENANT,
    kind: 'proforma',
    status: 'issued',
    number: 'PRO/1/2026',
    number_year: 2026,
    number_seq: 1,
    issue_date: '2026-11-11',
    valid_until: null,
    items: [
      { name: 'Wdrożenie systemu', unit: 'szt', quantity: 1, unitPriceNet: 1000, vatRate: '23', netAmount: 1000, vatAmount: 230, grossAmount: 1230 },
    ],
    net_total: 1000,
    vat_total: 230,
    gross_total: 1230,
    currency: 'PLN',
    contractor_id: KONTRAHENT,
    counterparty: STRONA,
    issuer: { name: 'Moja Firma', nip: '1234567890', countryCode: 'PL', addressLine1: 'ul. Przykładowa 1', addressLine2: '00-001 Warszawa' },
    payment_method: 'transfer',
    payment_due_date: '2026-11-25',
    bank_account: 'PL61109010140000071219812874',
    notes: null,
    issued_at: '2026-11-11T09:30:00.000Z',
    created_at: '2026-11-11T09:00:00.000Z',
    updated_at: '2026-11-11T09:30:00.000Z',
    ...extra,
  };
}

const SZKIC = { status: 'draft', number: null, number_year: null, number_seq: null, issuer: null, issued_at: null };

const dane = {
  kind: 'proforma' as const,
  contractorId: KONTRAHENT,
  issueDate: '2026-11-11',
  validUntil: '',
  items: [
    { name: 'Usługa A', unit: 'godz.', quantity: 3, unitPriceNet: 0.1, vatRate: '23' as const },
    { name: 'Towar B', unit: 'szt', quantity: 1.005, unitPriceNet: 1, vatRate: '8' as const },
  ],
  currency: 'PLN',
  paymentMethod: 'transfer' as const,
  paymentDueDate: '2026-11-25',
  bankAccount: 'PL61 1090 1014 0000 0712 1981 2874',
  notes: 'Płatne z góry',
};

/** Zapis historii jak RPC `record_sales_quote_email` (00198): raz na klucz w firmie. */
function zapisHistorii(args: Record<string, unknown>) {
  const emails = (db.tables.sales_quote_emails ??= []);
  if (emails.some((e) => e.tenant_id === TENANT && e.idempotency_key === args.p_idempotency_key)) {
    return { data: { status: 'already_recorded' }, error: null };
  }
  emails.push({
    id: `mail-${emails.length + 1}`,
    tenant_id: TENANT,
    quote_id: args.p_quote_id,
    recipient: args.p_recipient,
    idempotency_key: args.p_idempotency_key,
    provider_message_id: args.p_provider_message_id,
    sent_at: '2026-11-11T10:00:00.000Z',
  });
  return { data: { status: 'recorded' }, error: null };
}

function sesja(tenantId = TENANT, role = 'member') {
  return { supabase: { ...fakeSupabase(db), rpc: mocks.rpc }, user: { id: 'user-1' }, tenantId, role };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  // 11.11.2026 11:00 w Polsce.
  vi.setSystemTime(new Date('2026-11-11T10:00:00Z'));
  vi.stubEnv('RESEND_API_KEY', 'a'.repeat(24));
  db = memoryDb({
    contractors: [kontrahent(), kontrahent({ id: OBCY_KONTRAHENT, tenant_id: OTHER })],
    sales_quotes: [],
    sales_quote_emails: [],
  });
  mocks.auth.mockResolvedValue(sesja());
  mocks.canSendTo.mockResolvedValue({ ok: true });
  mocks.resendSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  mocks.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'record_sales_quote_email') return zapisHistorii(args);
    return { data: null, error: { code: 'PGRST202', message: `brak funkcji ${fn}` } };
  });
});

describe('saveQuoteDraftAction', () => {
  it('zapisuje szkic: firma formularza sprawdzona, kontrahent z bazy firmy, kwoty z funkcji faktury, migawka, audyt', async () => {
    const r = await saveQuoteDraftAction(dane, TENANT);

    expect(r).toMatchObject({ success: true });
    expect(mocks.auth).toHaveBeenCalledWith({ expectedTenantId: TENANT });
    const [row] = db.tables.sales_quotes!;
    expect(row).toMatchObject({
      tenant_id: TENANT,
      kind: 'proforma',
      issue_date: '2026-11-11',
      valid_until: null,
      items: [
        { name: 'Usługa A', unit: 'godz.', quantity: 3, unitPriceNet: 0.1, vatRate: '23', netAmount: 0.3, vatAmount: 0.07, grossAmount: 0.37 },
        { name: 'Towar B', unit: 'szt', quantity: 1.005, unitPriceNet: 1, vatRate: '8', netAmount: 1.01, vatAmount: 0.08, grossAmount: 1.09 },
      ],
      net_total: 1.31,
      vat_total: 0.15,
      gross_total: 1.46,
      currency: 'PLN',
      contractor_id: KONTRAHENT,
      counterparty: STRONA,
      payment_method: 'transfer',
      payment_due_date: '2026-11-25',
      bank_account: 'PL61109010140000071219812874',
      notes: 'Płatne z góry',
    });
    // Stan, numer i wystawca należą do bazy (RPC wystawienia), nie do formularza.
    for (const kolumna of ['status', 'number', 'number_year', 'number_seq', 'issuer', 'issued_at']) {
      expect(row, kolumna).not.toHaveProperty(kolumna);
    }
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'sales_quote.draft_created', tenantId: TENANT, userId: 'user-1', entityType: 'sales_quote',
    }));
    expect(mocks.revalidate).toHaveBeenCalledWith('/proformy');
  });

  it('oferta: data ważności zapisana, płatność pusta', async () => {
    const r = await saveQuoteDraftAction({ ...dane, kind: 'offer', validUntil: '2026-12-11' }, TENANT);
    expect(r).toMatchObject({ success: true });
    expect(db.tables.sales_quotes![0]).toMatchObject({
      kind: 'offer', valid_until: '2026-12-11', payment_method: null, payment_due_date: null, bank_account: null,
    });
  });

  it('inna waluta niż PLN: odmowa z komunikatem, nic nie zapisane', async () => {
    const r = await saveQuoteDraftAction({ ...dane, currency: 'EUR' }, TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/PLN/) });
    expect(db.tables.sales_quotes).toEqual([]);
  });

  it('kontrahent innej firmy: „nie znaleziono w bazie”, nic nie zapisane', async () => {
    const r = await saveQuoteDraftAction({ ...dane, contractorId: OBCY_KONTRAHENT }, TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/kontrahent/i) });
    expect(db.tables.sales_quotes).toEqual([]);
  });

  it('data wystawienia z przyszłości: odmowa', async () => {
    const r = await saveQuoteDraftAction({ ...dane, issueDate: '2026-11-12' }, TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/przyszł/) });
    expect(db.tables.sales_quotes).toEqual([]);
  });

  it('formularz innej firmy niż aktywna: odmowa z kontroli firmy (UX-01)', async () => {
    mocks.auth.mockRejectedValue(new ActionAuthError('Aktywna firma zmieniła się od otwarcia formularza.'));
    const r = await saveQuoteDraftAction(dane, OTHER);
    expect(r).toEqual({ success: false, error: 'Aktywna firma zmieniła się od otwarcia formularza.' });
    expect(mocks.auth).toHaveBeenCalledWith({ expectedTenantId: OTHER });
    expect(db.tables.sales_quotes).toEqual([]);
  });

  it('rola spoza listy: odmowa przed zapisem', async () => {
    mocks.auth.mockResolvedValue(sesja(TENANT, 'viewer'));
    const r = await saveQuoteDraftAction(dane, TENANT);
    expect(r).toMatchObject({ success: false });
    expect(db.tables.sales_quotes).toEqual([]);
  });

  it('edycja szkicu zmienia treść i sumy', async () => {
    db.tables.sales_quotes = [dokument(SZKIC)];
    const r = await saveQuoteDraftAction({ ...dane, notes: 'Nowe uwagi' }, TENANT, DOKUMENT);
    expect(r).toEqual({ success: true, id: DOKUMENT });
    expect(db.tables.sales_quotes![0]).toMatchObject({ notes: 'Nowe uwagi', gross_total: 1.46 });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'sales_quote.draft_updated', entityId: DOKUMENT }));
  });

  it('wystawionego dokumentu nie zmienisz: komunikat z numerem i drogą przez nowy dokument', async () => {
    db.tables.sales_quotes = [dokument()];
    const r = await saveQuoteDraftAction({ ...dane, notes: 'Zmiana po wystawieniu' }, TENANT, DOKUMENT);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/PRO\/1\/2026.*now/) });
    expect(db.tables.sales_quotes![0]).toMatchObject({ notes: null, gross_total: 1230 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe('addQuoteContractorAction', () => {
  it('kontrahent po NIP drogą formularza faktury; identyfikator z bazy tej firmy', async () => {
    mocks.lookup.mockResolvedValue({
      success: true,
      source: 'gus',
      data: { nip: '1234567890', name: 'Kontrahent Testowy', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
    });
    expect(await addQuoteContractorAction('123-456-78-90')).toEqual({
      success: true,
      contractor: { id: KONTRAHENT, name: 'Kontrahent Testowy', nip: '1234567890', email: ODBIORCA },
    });
    expect(mocks.lookup).toHaveBeenCalledWith('1234567890');
  });

  it('rola spoza listy: bez wyszukania', async () => {
    mocks.auth.mockResolvedValue(sesja(TENANT, 'viewer'));
    expect(await addQuoteContractorAction('1234567890')).toMatchObject({ success: false });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
});

describe('issueQuoteAction', () => {
  it('numer nadaje baza (RPC issue_sales_quote), aplikacja go nie wylicza', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { status: 'issued', number: 'PRO/1/2026' }, error: null });
    const r = await issueQuoteAction(DOKUMENT);
    expect(r).toEqual({ success: true, number: 'PRO/1/2026', alreadyIssued: false });
    expect(mocks.rpc).toHaveBeenCalledWith('issue_sales_quote', { p_quote_id: DOKUMENT });
    expect(mocks.revalidate).toHaveBeenCalledWith('/proformy');
  });

  it('drugie kliknięcie po wystawieniu: ten sam numer', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { status: 'already_issued', number: 'PRO/1/2026' }, error: null });
    expect(await issueQuoteAction(DOKUMENT)).toEqual({ success: true, number: 'PRO/1/2026', alreadyIssued: true });
  });

  it.each([
    ['not_found', /Nie znaleziono/],
    ['future_date', /przyszł/],
    ['valid_until_past', /ważn/i],
    ['contractor_missing', /kontrahent/i],
    ['issuer_incomplete', /Ustawieniach/],
  ])('odmowa bazy %s: komunikat z wyjściem', async (code, komunikat) => {
    mocks.rpc.mockResolvedValueOnce({ data: { status: 'refused', code }, error: null });
    expect(await issueQuoteAction(DOKUMENT)).toMatchObject({ success: false, error: expect.stringMatching(komunikat) });
  });

  it('odmowa uprawnień w bazie (42501): komunikat, nie surowy błąd', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Insufficient role to issue a sales quote' } });
    const r = await issueQuoteAction(DOKUMENT);
    expect(r).toMatchObject({ success: false });
    expect((r as { error: string }).error).not.toMatch(/Insufficient/);
  });

  it('identyfikator spoza wzoru: bez wywołania bazy', async () => {
    expect(await issueQuoteAction('nie-uuid')).toMatchObject({ success: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('deleteQuoteDraftAction', () => {
  it('usuwa szkic z audytem', async () => {
    db.tables.sales_quotes = [dokument(SZKIC)];
    expect(await deleteQuoteDraftAction(DOKUMENT)).toEqual({ success: true });
    expect(db.tables.sales_quotes).toEqual([]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'sales_quote.draft_deleted', entityId: DOKUMENT }));
  });

  it('wystawionego nie usuwa: komunikat z numerem', async () => {
    db.tables.sales_quotes = [dokument()];
    expect(await deleteQuoteDraftAction(DOKUMENT)).toMatchObject({ success: false, error: expect.stringMatching(/PRO\/1\/2026/) });
    expect(db.tables.sales_quotes).toHaveLength(1);
  });
});

describe('sendQuoteEmailAction', () => {
  beforeEach(() => {
    db.tables.sales_quotes = [dokument()];
  });

  it('wysyła wystawioną proformę z PDF i kluczem idempotencji; historię zapisuje baza tym samym kluczem', async () => {
    const r = await sendQuoteEmailAction(DOKUMENT, '  Zakupy@Kontrahent.test ');

    expect(r).toEqual({ success: true, recipient: ODBIORCA });
    const klucz = quoteEmailIdempotencyKey(DOKUMENT, ODBIORCA, 0);
    expect(mocks.resendSend).toHaveBeenCalledTimes(1);
    const [wiadomosc, opcje] = mocks.resendSend.mock.calls[0]!;
    expect(opcje).toEqual({ idempotencyKey: klucz });
    expect(wiadomosc).toMatchObject({ to: [ODBIORCA], subject: 'Proforma PRO/1/2026 od Moja Firma' });
    const [zalacznik] = (wiadomosc as { attachments: Array<{ filename: string; content: Buffer }> }).attachments;
    expect(zalacznik!.filename).toBe('proforma-PRO-1-2026.pdf');
    expect(zalacznik!.content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(mocks.rpc).toHaveBeenCalledWith('record_sales_quote_email', {
      p_quote_id: DOKUMENT,
      p_recipient: ODBIORCA,
      p_idempotency_key: klucz,
      p_provider_message_id: 'msg-1',
    });
    expect(db.tables.sales_quote_emails).toHaveLength(1);
  });

  it('oferta: temat i nazwa pliku oferty', async () => {
    db.tables.sales_quotes = [dokument({
      kind: 'offer', number: 'OF/3/2026', valid_until: '2026-12-11', payment_method: null, payment_due_date: null, bank_account: null,
    })];
    await sendQuoteEmailAction(DOKUMENT, ODBIORCA);
    const [wiadomosc] = mocks.resendSend.mock.calls[0]!;
    expect(wiadomosc).toMatchObject({ subject: 'Oferta OF/3/2026 od Moja Firma' });
    expect((wiadomosc as { attachments: Array<{ filename: string }> }).attachments[0]!.filename).toBe('oferta-OF-3-2026.pdf');
  });

  it('szkic: odmowa przed PDF i wysyłką', async () => {
    db.tables.sales_quotes = [dokument(SZKIC)];
    expect(await sendQuoteEmailAction(DOKUMENT, ODBIORCA)).toMatchObject({ success: false, error: expect.stringMatching(/wystaw/i) });
    expect(mocks.resendSend).not.toHaveBeenCalled();
  });

  it('dokument innej firmy: „nie znaleziono”, bez wysyłki', async () => {
    db.tables.sales_quotes = [dokument({ tenant_id: OTHER })];
    expect(await sendQuoteEmailAction(DOKUMENT, ODBIORCA)).toMatchObject({ success: false, error: expect.stringMatching(/Nie znaleziono/) });
    expect(mocks.resendSend).not.toHaveBeenCalled();
  });

  it('ponowienie po wysyłce bez zapisu historii: ten sam klucz i ten sam plik, więc drugi mail nie wychodzi', async () => {
    mocks.rpc.mockImplementationOnce(async () => ({ data: null, error: { code: '08006', message: 'connection lost' } }));
    const pierwsza = await sendQuoteEmailAction(DOKUMENT, ODBIORCA);
    expect(pierwsza).toMatchObject({ success: false, error: expect.stringMatching(/Wyślij jeszcze raz/) });
    expect(db.tables.sales_quote_emails).toEqual([]);

    const druga = await sendQuoteEmailAction(DOKUMENT, ODBIORCA);

    expect(druga).toEqual({ success: true, recipient: ODBIORCA });
    const [p1, p2] = mocks.resendSend.mock.calls;
    expect(p2![1]).toEqual(p1![1]);
    expect(p2![1]).toEqual({ idempotencyKey: quoteEmailIdempotencyKey(DOKUMENT, ODBIORCA, 0) });
    // Resend porównuje treść żądania: inny PDF przy tym samym kluczu to błąd, nie drugi mail.
    const plik = (call: unknown[]) => (call[0] as { attachments: Array<{ content: Buffer }> }).attachments[0]!.content;
    expect(Buffer.compare(plik(p1!), plik(p2!))).toBe(0);
    expect(db.tables.sales_quote_emails).toHaveLength(1);
  });

  it('świadome „Wyślij ponownie” po zapisanej wysyłce: nowy klucz', async () => {
    await sendQuoteEmailAction(DOKUMENT, ODBIORCA);
    await sendQuoteEmailAction(DOKUMENT, ODBIORCA);
    expect(mocks.resendSend.mock.calls.map((c) => c[1])).toEqual([
      { idempotencyKey: quoteEmailIdempotencyKey(DOKUMENT, ODBIORCA, 0) },
      { idempotencyKey: quoteEmailIdempotencyKey(DOKUMENT, ODBIORCA, 1) },
    ]);
    expect(db.tables.sales_quote_emails).toHaveLength(2);
  });

  it('dwa kliknięcia naraz: Resend odrzuca drugie żądanie z tym samym kluczem, klient dostaje zrozumiały komunikat', async () => {
    mocks.resendSend.mockResolvedValueOnce({
      data: null,
      error: { name: 'concurrent_idempotent_requests', message: 'Same idempotency key in progress', statusCode: 409 },
    });
    expect(await sendQuoteEmailAction(DOKUMENT, ODBIORCA)).toMatchObject({ success: false, error: expect.stringMatching(/właśnie wychodzi/) });
    expect(db.tables.sales_quote_emails).toEqual([]);
  });

  it('adres, który odrzucał pocztę: komunikat, bez wysyłki i bez historii', async () => {
    mocks.canSendTo.mockResolvedValue({ ok: false, reason: 'hard_bounce' });
    expect(await sendQuoteEmailAction(DOKUMENT, ODBIORCA)).toMatchObject({ success: false, error: expect.stringMatching(/odrzuc/) });
    expect(mocks.resendSend).not.toHaveBeenCalled();
    expect(db.tables.sales_quote_emails).toEqual([]);
  });

  it('zły adres: odmowa bez odczytu dokumentu i bez wysyłki', async () => {
    expect(await sendQuoteEmailAction(DOKUMENT, 'jan@firma')).toMatchObject({ success: false, error: expect.stringMatching(/adres/) });
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.resendSend).not.toHaveBeenCalled();
  });

  it('limit 30 wysyłek na godzinę na firmę: 31. odmówiona przed PDF i wysyłką', async () => {
    const LIMIT = 'ten-limit-proformy';
    db.tables.sales_quotes = [dokument({ tenant_id: LIMIT })];
    mocks.auth.mockResolvedValue(sesja(LIMIT));
    mocks.rpc.mockResolvedValue({ data: { status: 'recorded' }, error: null });
    for (let i = 0; i < 30; i++) await sendQuoteEmailAction(DOKUMENT, ODBIORCA);
    expect(mocks.resendSend).toHaveBeenCalledTimes(30);

    const r = await sendQuoteEmailAction(DOKUMENT, ODBIORCA);

    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/limit/i) });
    expect(mocks.resendSend).toHaveBeenCalledTimes(30);
  });
});
