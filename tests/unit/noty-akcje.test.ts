import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeSupabase, memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';

/**
 * Akcje not (plan kompletnej aplikacji, krok 2.9, część 1) na prawdziwej
 * ścieżce: schemat, kontrahent z bazy firmy, PDF, wysyłka przez `sendEmail`
 * i `sendViaResend` z kluczem idempotencji. Atrapy tylko dla sesji, bazy
 * (w pamięci, z RPC) i HTTP do Resend. RLS, numeracja w bazie, wyzwalacz
 * „wystawionej nie zmieniasz” i zapis historii raz na klucz:
 * tests/rls-noty.test.ts na prawdziwym Postgresie.
 */

const TENANT = 'ten-1';
const OTHER = 'ten-2';
const KONTRAHENT = '0b8a3f4e-2c1d-4e5f-8a9b-0c1d2e3f4a5b';
const OBCY_KONTRAHENT = '1c9b4a5f-3d2e-4f60-9bac-1d2e3f4a5b6c';
const NOTA = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';
const ODBIORCA = 'ksiegowosc@kontrahent.test';

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
  addNoteContractorAction,
  deleteNoteDraftAction,
  issueNoteAction,
  saveNoteDraftAction,
  sendNoteEmailAction,
} from '@/app/actions/noty';
import { ActionAuthError } from '@/lib/supabase/auth-context';
import { noteEmailIdempotencyKey } from '@/lib/noty/mail';

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

function nota(extra: Row = {}): Row {
  return {
    id: NOTA,
    tenant_id: TENANT,
    kind: 'debit',
    status: 'issued',
    number: 'NO/1/2026',
    number_year: 2026,
    number_seq: 1,
    issue_date: '2026-11-11',
    title: 'Kara umowna',
    items: [{ description: 'Kara za opóźnienie dostawy', amount: 1250.5 }],
    total: 1250.5,
    currency: 'PLN',
    contractor_id: KONTRAHENT,
    counterparty: {
      name: 'Kontrahent Testowy',
      nip: '1234567890',
      countryCode: 'PL',
      addressLine1: 'ul. Klienta 10',
      addressLine2: '02-001 Warszawa',
      email: ODBIORCA,
    },
    issuer: {
      name: 'Moja Firma',
      nip: '1234567890',
      countryCode: 'PL',
      addressLine1: 'ul. Przykładowa 1',
      addressLine2: '00-001 Warszawa',
    },
    related_document: null,
    due_date: '2026-11-25',
    bank_account: 'PL61109010140000071219812874',
    issued_at: '2026-11-11T09:30:00.000Z',
    created_at: '2026-11-11T09:00:00.000Z',
    updated_at: '2026-11-11T09:30:00.000Z',
    ...extra,
  };
}

const dane = {
  kind: 'debit' as const,
  contractorId: KONTRAHENT,
  issueDate: '2026-11-11',
  title: 'Kara umowna',
  items: [
    { description: 'Kara za opóźnienie', amount: '0,10' },
    { description: 'Zwrot kosztów', amount: '0,20' },
  ],
  currency: 'PLN',
  relatedDocument: 'FV/2026/11/3',
  dueDate: '2026-11-25',
  bankAccount: 'PL61 1090 1014 0000 0712 1981 2874',
};

/** Zapis historii jak RPC `record_accounting_note_email` (00193): raz na klucz w firmie. */
function zapisHistorii(args: Record<string, unknown>) {
  const emails = (db.tables.accounting_note_emails ??= []);
  if (emails.some((e) => e.tenant_id === TENANT && e.idempotency_key === args.p_idempotency_key)) {
    return { data: { status: 'already_recorded' }, error: null };
  }
  emails.push({
    id: `mail-${emails.length + 1}`,
    tenant_id: TENANT,
    note_id: args.p_note_id,
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
  db = memoryDb({ contractors: [kontrahent(), kontrahent({ id: OBCY_KONTRAHENT, tenant_id: OTHER })], accounting_notes: [], accounting_note_emails: [] });
  mocks.auth.mockResolvedValue(sesja());
  mocks.canSendTo.mockResolvedValue({ ok: true });
  mocks.resendSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  mocks.rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'record_accounting_note_email') return zapisHistorii(args);
    return { data: null, error: { code: 'PGRST202', message: `brak funkcji ${fn}` } };
  });
});

describe('saveNoteDraftAction', () => {
  it('zapisuje szkic: firma formularza sprawdzona, kontrahent z bazy firmy, suma przez roundToCents, migawka danych, audyt', async () => {
    const r = await saveNoteDraftAction(dane, TENANT);

    expect(r).toMatchObject({ success: true });
    expect(mocks.auth).toHaveBeenCalledWith({ expectedTenantId: TENANT });
    const [row] = db.tables.accounting_notes!;
    expect(row).toMatchObject({
      tenant_id: TENANT,
      kind: 'debit',
      issue_date: '2026-11-11',
      title: 'Kara umowna',
      items: [
        { description: 'Kara za opóźnienie', amount: 0.1 },
        { description: 'Zwrot kosztów', amount: 0.2 },
      ],
      total: 0.3,
      currency: 'PLN',
      contractor_id: KONTRAHENT,
      counterparty: {
        name: 'Kontrahent Testowy',
        nip: '1234567890',
        countryCode: 'PL',
        addressLine1: 'ul. Klienta 10',
        addressLine2: '02-001 Warszawa',
        email: ODBIORCA,
      },
      related_document: 'FV/2026/11/3',
      due_date: '2026-11-25',
      bank_account: 'PL61109010140000071219812874',
    });
    // Stan, numer i wystawca należą do bazy (RPC wystawienia), nie do formularza.
    for (const kolumna of ['status', 'number', 'number_year', 'number_seq', 'issuer', 'issued_at']) {
      expect(row, kolumna).not.toHaveProperty(kolumna);
    }
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'accounting_note.draft_created', tenantId: TENANT, userId: 'user-1', entityType: 'accounting_note',
    }));
    expect(mocks.revalidate).toHaveBeenCalledWith('/noty');
  });

  it('inna waluta niż PLN: odmowa z komunikatem, nic nie zapisane', async () => {
    const r = await saveNoteDraftAction({ ...dane, currency: 'EUR' }, TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/PLN/) });
    expect(db.tables.accounting_notes).toEqual([]);
  });

  it('kontrahent innej firmy: „nie znaleziono w bazie”, nic nie zapisane', async () => {
    const r = await saveNoteDraftAction({ ...dane, contractorId: OBCY_KONTRAHENT }, TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/kontrahent/i) });
    expect(db.tables.accounting_notes).toEqual([]);
  });

  it('data wystawienia z przyszłości: odmowa', async () => {
    const r = await saveNoteDraftAction({ ...dane, issueDate: '2026-11-12', dueDate: '' }, TENANT);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/przyszł/) });
    expect(db.tables.accounting_notes).toEqual([]);
  });

  it('formularz innej firmy niż aktywna: odmowa z kontroli firmy (UX-01)', async () => {
    mocks.auth.mockRejectedValue(new ActionAuthError('Aktywna firma zmieniła się od otwarcia formularza.'));
    const r = await saveNoteDraftAction(dane, OTHER);
    expect(r).toEqual({ success: false, error: 'Aktywna firma zmieniła się od otwarcia formularza.' });
    expect(mocks.auth).toHaveBeenCalledWith({ expectedTenantId: OTHER });
    expect(db.tables.accounting_notes).toEqual([]);
  });

  it('rola spoza listy: odmowa przed zapisem', async () => {
    mocks.auth.mockResolvedValue(sesja(TENANT, 'viewer'));
    const r = await saveNoteDraftAction(dane, TENANT);
    expect(r).toMatchObject({ success: false });
    expect(db.tables.accounting_notes).toEqual([]);
  });

  it('edycja szkicu zmienia treść i sumę', async () => {
    db.tables.accounting_notes = [nota({ status: 'draft', number: null, number_year: null, number_seq: null, issuer: null, issued_at: null })];
    const r = await saveNoteDraftAction({ ...dane, title: 'Zwrot kosztów' }, TENANT, NOTA);
    expect(r).toEqual({ success: true, id: NOTA });
    expect(db.tables.accounting_notes![0]).toMatchObject({ title: 'Zwrot kosztów', total: 0.3 });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'accounting_note.draft_updated', entityId: NOTA }));
  });

  it('wystawionej noty nie zmienisz: komunikat z numerem i drogą przez nową notę', async () => {
    db.tables.accounting_notes = [nota()];
    const r = await saveNoteDraftAction({ ...dane, title: 'Zmiana po wystawieniu' }, TENANT, NOTA);
    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/NO\/1\/2026.*now(ą|a) not/) });
    expect(db.tables.accounting_notes![0]).toMatchObject({ title: 'Kara umowna', total: 1250.5 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe('addNoteContractorAction', () => {
  it('kontrahent po NIP drogą formularza faktury; identyfikator z bazy tej firmy, nie innej', async () => {
    mocks.lookup.mockResolvedValue({
      success: true,
      source: 'gus',
      data: { nip: '1234567890', name: 'Kontrahent Testowy', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
    });
    expect(await addNoteContractorAction('123-456-78-90')).toEqual({
      success: true,
      contractor: { id: KONTRAHENT, name: 'Kontrahent Testowy', nip: '1234567890', email: ODBIORCA },
    });
    expect(mocks.lookup).toHaveBeenCalledWith('1234567890');
  });

  it('błąd wyszukania (np. suma kontrolna NIP): komunikat wyszukiwarki bez zmian', async () => {
    mocks.lookup.mockResolvedValue({ success: false, error: 'Nieprawidłowa suma kontrolna NIP' });
    expect(await addNoteContractorAction('1234567891')).toEqual({ success: false, error: 'Nieprawidłowa suma kontrolna NIP' });
  });

  it('rola spoza listy: bez wyszukania', async () => {
    mocks.auth.mockResolvedValue(sesja(TENANT, 'viewer'));
    expect(await addNoteContractorAction('1234567890')).toMatchObject({ success: false });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });
});

describe('issueNoteAction', () => {
  it('numer nadaje baza (RPC issue_accounting_note), aplikacja go nie wylicza', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { status: 'issued', number: 'NO/1/2026' }, error: null });
    const r = await issueNoteAction(NOTA);
    expect(r).toEqual({ success: true, number: 'NO/1/2026', alreadyIssued: false });
    expect(mocks.rpc).toHaveBeenCalledWith('issue_accounting_note', { p_note_id: NOTA });
    expect(mocks.revalidate).toHaveBeenCalledWith('/noty');
  });

  it('drugie kliknięcie po wystawieniu: ten sam numer, bez drugiego numeru', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { status: 'already_issued', number: 'NO/1/2026' }, error: null });
    expect(await issueNoteAction(NOTA)).toEqual({ success: true, number: 'NO/1/2026', alreadyIssued: true });
  });

  it.each([
    ['not_found', /Nie znaleziono noty/],
    ['future_date', /przyszł/],
    ['contractor_missing', /kontrahent/i],
    ['issuer_incomplete', /Ustawieniach/],
  ])('odmowa bazy %s: komunikat z wyjściem', async (code, komunikat) => {
    mocks.rpc.mockResolvedValueOnce({ data: { status: 'refused', code }, error: null });
    expect(await issueNoteAction(NOTA)).toMatchObject({ success: false, error: expect.stringMatching(komunikat) });
  });

  it('odmowa uprawnień w bazie (42501): komunikat, nie surowy błąd', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Insufficient role to issue an accounting note' } });
    const r = await issueNoteAction(NOTA);
    expect(r).toMatchObject({ success: false });
    expect((r as { error: string }).error).not.toMatch(/Insufficient/);
  });

  it('identyfikator spoza wzoru: bez wywołania bazy', async () => {
    expect(await issueNoteAction('nie-uuid')).toMatchObject({ success: false });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('deleteNoteDraftAction', () => {
  it('usuwa szkic z audytem', async () => {
    db.tables.accounting_notes = [nota({ status: 'draft', number: null, number_year: null, number_seq: null, issuer: null, issued_at: null })];
    expect(await deleteNoteDraftAction(NOTA)).toEqual({ success: true });
    expect(db.tables.accounting_notes).toEqual([]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'accounting_note.draft_deleted', entityId: NOTA }));
  });

  it('wystawionej nie usuwa: komunikat z numerem', async () => {
    db.tables.accounting_notes = [nota()];
    expect(await deleteNoteDraftAction(NOTA)).toMatchObject({ success: false, error: expect.stringMatching(/NO\/1\/2026/) });
    expect(db.tables.accounting_notes).toHaveLength(1);
  });
});

describe('sendNoteEmailAction', () => {
  beforeEach(() => {
    db.tables.accounting_notes = [nota()];
  });

  it('wysyła wystawioną notę z PDF i kluczem idempotencji; historię zapisuje baza tym samym kluczem', async () => {
    const r = await sendNoteEmailAction(NOTA, '  KsiegowoSC@Kontrahent.test ');

    expect(r).toEqual({ success: true, recipient: ODBIORCA });
    const klucz = noteEmailIdempotencyKey(NOTA, ODBIORCA, 0);
    expect(mocks.resendSend).toHaveBeenCalledTimes(1);
    const [wiadomosc, opcje] = mocks.resendSend.mock.calls[0]!;
    expect(opcje).toEqual({ idempotencyKey: klucz });
    expect(wiadomosc).toMatchObject({ to: [ODBIORCA], subject: 'Nota obciążeniowa NO/1/2026 od Moja Firma' });
    const [zalacznik] = (wiadomosc as { attachments: Array<{ filename: string; content: Buffer }> }).attachments;
    expect(zalacznik!.filename).toBe('nota-NO-1-2026.pdf');
    expect(zalacznik!.content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(mocks.rpc).toHaveBeenCalledWith('record_accounting_note_email', {
      p_note_id: NOTA,
      p_recipient: ODBIORCA,
      p_idempotency_key: klucz,
      p_provider_message_id: 'msg-1',
    });
    expect(db.tables.accounting_note_emails).toHaveLength(1);
  });

  it('szkic: odmowa przed PDF i wysyłką', async () => {
    db.tables.accounting_notes = [nota({ status: 'draft', number: null, number_year: null, number_seq: null, issuer: null, issued_at: null })];
    expect(await sendNoteEmailAction(NOTA, ODBIORCA)).toMatchObject({ success: false, error: expect.stringMatching(/wystaw/i) });
    expect(mocks.resendSend).not.toHaveBeenCalled();
  });

  it('nota innej firmy: „nie znaleziono”, bez wysyłki', async () => {
    db.tables.accounting_notes = [nota({ tenant_id: OTHER })];
    expect(await sendNoteEmailAction(NOTA, ODBIORCA)).toMatchObject({ success: false, error: expect.stringMatching(/Nie znaleziono noty/) });
    expect(mocks.resendSend).not.toHaveBeenCalled();
  });

  it('ponowienie po wysyłce bez zapisu historii: ten sam klucz i ten sam plik, więc drugi mail nie wychodzi', async () => {
    mocks.rpc.mockImplementationOnce(async () => ({ data: null, error: { code: '08006', message: 'connection lost' } }));
    const pierwsza = await sendNoteEmailAction(NOTA, ODBIORCA);
    expect(pierwsza).toMatchObject({ success: false, error: expect.stringMatching(/Wyślij jeszcze raz/) });
    expect(db.tables.accounting_note_emails).toEqual([]);

    const druga = await sendNoteEmailAction(NOTA, ODBIORCA);

    expect(druga).toEqual({ success: true, recipient: ODBIORCA });
    const [p1, p2] = mocks.resendSend.mock.calls;
    expect(p2![1]).toEqual(p1![1]);
    expect(p2![1]).toEqual({ idempotencyKey: noteEmailIdempotencyKey(NOTA, ODBIORCA, 0) });
    // Resend porównuje treść żądania: inny PDF przy tym samym kluczu to błąd, nie drugi mail.
    const plik = (call: unknown[]) => (call[0] as { attachments: Array<{ content: Buffer }> }).attachments[0]!.content;
    expect(Buffer.compare(plik(p1!), plik(p2!))).toBe(0);
    expect(db.tables.accounting_note_emails).toHaveLength(1);
  });

  it('świadome „Wyślij ponownie” po zapisanej wysyłce: nowy klucz', async () => {
    await sendNoteEmailAction(NOTA, ODBIORCA);
    await sendNoteEmailAction(NOTA, ODBIORCA);
    expect(mocks.resendSend.mock.calls.map((c) => c[1])).toEqual([
      { idempotencyKey: noteEmailIdempotencyKey(NOTA, ODBIORCA, 0) },
      { idempotencyKey: noteEmailIdempotencyKey(NOTA, ODBIORCA, 1) },
    ]);
    expect(db.tables.accounting_note_emails).toHaveLength(2);
  });

  it('dwa kliknięcia naraz: Resend odrzuca drugie żądanie z tym samym kluczem, klient dostaje zrozumiały komunikat', async () => {
    mocks.resendSend.mockResolvedValueOnce({
      data: null,
      error: { name: 'concurrent_idempotent_requests', message: 'Same idempotency key in progress', statusCode: 409 },
    });
    expect(await sendNoteEmailAction(NOTA, ODBIORCA)).toMatchObject({ success: false, error: expect.stringMatching(/właśnie wychodzi/) });
    expect(db.tables.accounting_note_emails).toEqual([]);
  });

  it('adres, który odrzucał pocztę: komunikat, bez wysyłki i bez historii', async () => {
    mocks.canSendTo.mockResolvedValue({ ok: false, reason: 'hard_bounce' });
    expect(await sendNoteEmailAction(NOTA, ODBIORCA)).toMatchObject({ success: false, error: expect.stringMatching(/odrzuc/) });
    expect(mocks.resendSend).not.toHaveBeenCalled();
    expect(db.tables.accounting_note_emails).toEqual([]);
  });

  it('zły adres: odmowa bez odczytu noty i bez wysyłki', async () => {
    expect(await sendNoteEmailAction(NOTA, 'jan@firma')).toMatchObject({ success: false, error: expect.stringMatching(/adres/) });
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.resendSend).not.toHaveBeenCalled();
  });

  it('wysyłka nieskonfigurowana: komunikat, bez historii', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    expect(await sendNoteEmailAction(NOTA, ODBIORCA)).toMatchObject({ success: false, error: expect.stringMatching(/skonfigurowana/) });
    expect(db.tables.accounting_note_emails).toEqual([]);
  });

  it('limit 30 wysyłek not na godzinę na firmę: 31. odmówiona przed PDF i wysyłką', async () => {
    const LIMIT = 'ten-limit';
    db.tables.accounting_notes = [nota({ tenant_id: LIMIT })];
    mocks.auth.mockResolvedValue(sesja(LIMIT));
    mocks.rpc.mockResolvedValue({ data: { status: 'recorded' }, error: null });
    for (let i = 0; i < 30; i++) await sendNoteEmailAction(NOTA, ODBIORCA);
    expect(mocks.resendSend).toHaveBeenCalledTimes(30);

    const r = await sendNoteEmailAction(NOTA, ODBIORCA);

    expect(r).toMatchObject({ success: false, error: expect.stringMatching(/limit/i) });
    expect(mocks.resendSend).toHaveBeenCalledTimes(30);
  });
});
