import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D-A4-1b-3 PR B (decyzje Bartosza 04.10 i 07.10.2026): klient — właściciel
 * albo administrator — rozstrzyga nierozstrzygnięty duplikat 440 na karcie
 * faktury: „to ta sama sprzedaż” albo „to inna sprzedaż”. Akcja
 * `decideKsefDuplicateAction` sprawdza rolę, środowisko, fakty (ta sama
 * polityka co panel), wiązanie z danymi pokazanymi klientowi (numer KSeF
 * i SHA-256 oryginału) i „Rozumiem skutki” po stronie serwera (decyzja 7),
 * a dopiero potem woła RPC `decide_ksef_duplicate` kluczem serwisowym.
 *
 * Do PR B (f49e687) klient nie miał jak zdecydować: panel pokazywał tylko
 * dane oryginału i notę „Zajmujemy się tym”, a faktura stała w
 * `failed / KSEF_DUPLICATE_RECONCILE` bez wyjścia klienta.
 *
 * Prawdziwe: akcja, polityka (`lib/ksef/duplicate-decision.ts`), loader faktów
 * (`lib/ksef/duplicate-decision-facts.ts`) i `duplicate-check`.
 * Zastąpione: sesja Supabase (baza w pamięci z projekcją kolumn, bez `.not`),
 * klient serwisowy (tylko `rpc`), środowisko KSeF, `next/cache`, Sentry.
 */

const m = vi.hoisted(() => ({
  db: null as null | import('./helpers/ponowienie-specjalne-baza').MemoryDb,
  role: 'owner',
  env: 'test' as string | null,
  rpc: vi.fn(),
  // PR C: blokada SQL dla sesji klienta (`ksef_duplicate_decision_blocker_for_session`) — czytana tylko przy powodzie `faktflow-original`.
  sessionRpc: vi.fn(),
  adminFrom: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  const ctx = async () => ({
    supabase: { from: (table: string) => m.db!.from(table), rpc: (fn: string, args: unknown) => m.sessionRpc(fn, args) },
    user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: m.role,
  });
  return {
    ActionAuthError,
    requireUserAndActiveOrg: ctx,
    requireOrgRole: async (roles: string | string[]) => {
      const c = await ctx();
      const allowed = Array.isArray(roles) ? roles : [roles];
      if (!allowed.includes(c.role)) throw new ActionAuthError('Niewystarczające uprawnienia');
      return c;
    },
  };
});
vi.mock('@/lib/supabase/admin', () => ({
  // Akcja klienta czyta fakty sesją (RLS); klucz serwisowy tylko do RPC.
  createAdminClient: () => ({
    rpc: m.rpc,
    from: (table: string) => {
      m.adminFrom(table);
      throw new Error(`akcja klienta: odczyt ${table} kluczem serwisowym zamiast sesją`);
    },
  }),
}));
vi.mock('@/lib/ksef/claim-environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ksef/claim-environment')>()),
  configuredKsefEnvironment: () => m.env,
}));
vi.mock('@sentry/nextjs', () => ({ captureMessage: m.captureMessage, captureException: m.captureException }));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
// Sąsiednie akcje pliku `actions-detail` — bez znaczenia dla decyzji.
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: vi.fn() }));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: vi.fn() }));
vi.mock('@/lib/pdf/invoice-data', () => ({ loadInvoiceForPdf: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendInvoiceEmail: vi.fn() }));

import * as detailActions from '@/components/invoices/actions-detail';
import { KSEF_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';

import {
  CLIENT,
  K,
  K2,
  SHA_K,
  SQL,
  Y_ID,
  Y_NR,
  duplicateCheck,
  fill,
  knownNumberCheck,
  markerRow,
  numberTakenRow,
} from './helpers/decyzja-klienta';
import { fillExpected } from './helpers/ksef-duplicate-decision-cases';
import { memoryDb, type Row } from './helpers/ponowienie-specjalne-baza';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const X_ID = '22222222-2222-4222-8222-222222222221';
const NR = 'FV/12/10/2026';

type Choice = 'same_sale' | 'other_sale';
type DecideInput = {
  invoiceId: string;
  choice: Choice;
  originalKsefNumber: string;
  originalSha256: string;
  confirmed: boolean;
};
type DecideResult = { success: true; message: string } | { success: false; error: string };

const NO_ACTION = '(f49e687: brak akcji decyzji klienta — panel pokazuje tylko notę)';

/**
 * `decideKsefDuplicateAction` (2.4). Na main akcji nie ma — klient nie ma jak
 * zapisać decyzji; wtedy wynik to „brak akcji”, a asercje padają na zachowaniu
 * (brak tekstu, RPC niewołane), nie na TypeError.
 */
async function decide(patch: Partial<DecideInput> = {}): Promise<DecideResult> {
  const action = (detailActions as unknown as Record<string, unknown>).decideKsefDuplicateAction;
  const input: DecideInput = {
    invoiceId: X_ID,
    choice: 'other_sale',
    originalKsefNumber: K,
    originalSha256: SHA_K,
    confirmed: true,
    ...patch,
  };
  if (typeof action !== 'function') return { success: false, error: NO_ACTION };
  return (action as (i: DecideInput) => Promise<DecideResult>)(input);
}

/** Faktura X: zwykła, failed `KSEF_DUPLICATE_RECONCILE`, NIP i kwota zgodne z oryginałem. */
function invoiceRow(patch: Row = {}): Row {
  return {
    id: X_ID,
    tenant_id: TENANT,
    internal_number: NR,
    direction: 'outgoing',
    ksef_status: 'failed',
    last_error_code: 'KSEF_DUPLICATE_RECONCILE',
    last_error: 'KSeF ma już fakturę o tym numerze — do uzgodnienia.',
    ksef_number: null,
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    stripe_invoice_id: null,
    offline_idempotency_key: null,
    offline_qr_offline: null,
    offline_qr_certyfikat: null,
    paid_amount: 0,
    issue_date: '2026-10-02',
    buyer_nip: '1234567890',
    buyer_data: { nip: '1234567890', name: 'Nabywca testowy' },
    gross_total: 123,
    currency: 'PLN',
    ...patch,
  };
}

/** Faktura Y — w FaktWay ma numer KSeF oryginału (known-number). */
function yRow(patch: Row = {}): Row {
  return {
    id: Y_ID,
    tenant_id: TENANT,
    internal_number: Y_NR,
    direction: 'outgoing',
    ksef_status: 'accepted',
    ksef_number: K,
    ...patch,
  };
}

function seed(o: { invoice?: Row; submissions?: Row[]; extraInvoices?: Row[] } = {}) {
  m.db = memoryDb({
    invoices: [o.invoice ?? invoiceRow(), ...(o.extraInvoices ?? [])],
    ksef_submissions: o.submissions ?? [markerRow(TENANT, X_ID)],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.role = 'owner';
  m.env = 'test';
  seed();
  m.sessionRpc.mockResolvedValue({ data: null, error: null });
  m.rpc.mockImplementation(async (_fn: string, args: Record<string, unknown>) => ({
    data: {
      invoice_id: args.p_invoice_id,
      internal_number: NR,
      original_ksef_number: args.p_original_ksef_number,
      choice: args.p_choice,
      via: args.p_via,
      reason: 'no-own-file',
      already_decided: false,
      submissions_closed: 1,
    },
    error: null,
  }));
});

describe('decideKsefDuplicateAction — decyzja klienta przy nierozstrzygniętym 440 (D-A4-1b-3 PR B)', () => {
  it.each([
    ['other_sale', CLIENT.toastOther],
    ['same_sale', CLIENT.toastSame(NR)],
  ] as const)('U3a: właściciel, %s z potwierdzeniem — jedno RPC jako klient, środowisko serwera, bez notatki; odświeżenie widoków', async (choice, toast) => {
    const r = await decide({ choice, confirmed: true });

    expect(r).toEqual({ success: true, message: toast });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith('decide_ksef_duplicate', {
      p_invoice_id: X_ID,
      p_tenant_id: TENANT,
      p_actor_user_id: USER,
      p_choice: choice,
      p_via: 'client',
      p_original_ksef_number: K,
      p_original_sha256: SHA_K,
      p_env: 'test',
      p_note: null,
    });
    expect(m.revalidate).toHaveBeenCalledWith('/invoices');
    expect(m.revalidate).toHaveBeenCalledWith(`/invoices/${X_ID}`);
    // Fakty czyta sesja klienta (RLS), nie klucz serwisowy (2.3).
    expect(m.adminFrom).not.toHaveBeenCalled();
    expect(m.db!.reads.some((read) => read.table === 'ksef_submissions')).toBe(true);
  });

  it.each(['member', 'accountant'])('U3b: rola %s — tekst ROLE klienta, bez RPC i przed odczytem faktów', async (role) => {
    m.role = role;

    const r = await decide();

    expect(r).toEqual({ success: false, error: CLIENT.role });
    expect(m.rpc).not.toHaveBeenCalled();
    expect(m.db!.reads).toEqual([]);
  });

  it.each([
    ['inny numer KSeF niż na stronie', { originalKsefNumber: K2 }],
    ['inny SHA-256 niż na stronie', { originalSha256: 'cc'.repeat(32) }],
  ])('U3c: %s — STALE, bez RPC', async (_label, patch) => {
    const r = await decide(patch);

    expect(r).toEqual({ success: false, error: CLIENT.stale });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['inna sprzedaż przy tym samym NIP nabywcy', 'other_sale', {}, null],
    ['ta sama sprzedaż przy innej kwocie brutto', 'same_sale', { gross_total: 150 }, null],
    ['ta sama sprzedaż przy innej walucie', 'same_sale', { currency: 'EUR' }, null],
    ['ta sama sprzedaż przy nieznanym NIP w KSeF', 'same_sale', {}, { buyerNip: null }],
  ] as const)('U3d: %s bez „Rozumiem skutki” — CONFIRM, bez RPC (decyzja 7 na serwerze)', async (_label, choice, invoicePatch, summaryPatch) => {
    const check = duplicateCheck();
    if (summaryPatch) check.summary = { ...(check.summary as Row), ...summaryPatch };
    seed({ invoice: invoiceRow(invoicePatch), submissions: [markerRow(TENANT, X_ID, { original_check: check })] });

    const r = await decide({ choice, confirmed: false });

    expect(r).toEqual({ success: false, error: CLIENT.confirm });
    expect(m.rpc).not.toHaveBeenCalled();

    // Z zaznaczonym „Rozumiem skutki” ta sama decyzja idzie do RPC.
    const confirmed = await decide({ choice, confirmed: true });
    expect(confirmed.success).toBe(true);
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ta sama sprzedaż przy zgodnym NIP i kwocie', 'same_sale', {}],
    ['inna sprzedaż przy innym NIP nabywcy', 'other_sale', { buyer_nip: '1234567899', buyer_data: { nip: '1234567899', name: 'Inny nabywca' } }],
  ] as const)('U3d: %s — bez tarcia, RPC także bez potwierdzenia', async (_label, choice, invoicePatch) => {
    seed({ invoice: invoiceRow(invoicePatch) });

    const r = await decide({ choice, confirmed: false });

    expect(r.success).toBe(true);
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc.mock.calls[0]![1]).toMatchObject({ p_choice: choice, p_via: 'client' });
  });

  it('U3e (C13): wpłaty na dokumencie — odmowa z numerem dokumentu i adresem pomocy, bez RPC', async () => {
    seed({ invoice: invoiceRow({ paid_amount: 100 }) });

    const r = await decide();

    expect(r).toEqual({ success: false, error: fill(SQL.payments, NR) });
    const error = r.success ? '' : r.error;
    expect(error).toContain(NR);
    // Tekst odmowy „payments” to lustro RAISE (00148, marka FaktWay od 00151).
    expect(error).toContain('pomoc@faktway.pl');
    expect(error).not.toMatch(/faktflow/i);
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('U3e: dane oryginału z innego środowiska KSeF — odmowa ENV z nazwami środowisk, bez RPC', async () => {
    seed({ submissions: [markerRow(TENANT, X_ID, { original_check: duplicateCheck({ env: 'production' }) })] });

    const r = await decide();

    expect(r).toEqual({ success: false, error: fill(SQL.env, K, 'produkcyjne', 'testowe', NR) });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('U3e: środowisko KSeF serwera nieznane — envUnknown, bez RPC', async () => {
    m.env = null;

    const r = await decide();

    expect(r).toEqual({ success: false, error: KSEF_SEND_MESSAGES.envUnknown });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  // PR C: zapis oryginału z FaktFlow i jego odmowy są w `zapis-oryginalu-akcja.test.ts`. Tu zostaje znacznik
  // `faktflow-original` BEZ oceny pliku (sprzed 00149 / stary runner): nie ma jeszcze czego pokazać ani zapisać —
  // `recheck-needed` (cron „Tylko uzgodnij” zrobi nowy werdykt), odmowa bez RPC. Wcześniej: `reason` i ogólny tekst.
  it('U3e (PR C): powód faktflow-original bez importGate — odmowa recheck-needed z numerem dokumentu, bez RPC', async () => {
    seed({
      submissions: [markerRow(TENANT, X_ID, {
        original_check: duplicateCheck({
          reason: 'faktflow-original',
          archivePath: `${TENANT}/ksef-import/${K}.xml`,
          summary: { ...(duplicateCheck().summary as Row), systemInfo: 'KSeF SaaS v1.0' },
          sameContentExceptHeader: false,
        }),
      })],
    });

    const r = await decide();

    expect(r).toEqual({ success: false, error: fillExpected('recheck-needed', NR) });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('U3e: korekta / zaliczka / ROZ — odmowa „kind” z numerem dokumentu, bez RPC', async () => {
    seed({ invoice: invoiceRow({ invoice_kind: 'advance', invoice_type: 'ZAL' }) });

    const r = await decide();

    expect(r).toEqual({ success: false, error: fill(SQL.kind, NR) });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('U3f: known-number, Y przyjęta z numerem KSeF oryginału — RPC wołane', async () => {
    seed({
      submissions: [markerRow(TENANT, X_ID, { original_check: knownNumberCheck() })],
      extraInvoices: [yRow()],
    });

    const r = await decide({ choice: 'other_sale', confirmed: true });

    expect(r.success).toBe(true);
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc.mock.calls[0]![1]).toMatchObject({ p_original_ksef_number: K, p_original_sha256: SHA_K, p_via: 'client' });
  });

  it.each([
    ['Y nie ma już numeru KSeF oryginału', { ksef_number: K2 }],
    ['Y w stanie failed z numerem KSeF oryginału (uwaga 1 sprawdzenia: I9, nie w JPK)', { ksef_status: 'failed' }],
  ])('U3f: known-number, %s — tekst known-stale, bez RPC', async (_label, yPatch) => {
    seed({
      submissions: [markerRow(TENANT, X_ID, { original_check: knownNumberCheck() })],
      extraInvoices: [yRow(yPatch)],
    });

    const r = await decide();

    expect(r).toEqual({ success: false, error: fill(SQL.knownStale, K, NR) });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('U3g (§7 p. 18): RPC odmawia P0001 mimo zgody polityki — komunikat RPC bez zmian i ostrzeżenie Sentry o rozjeździe', async () => {
    // Np. wiersz `payments` niewidoczny dla sesji (00074) — polityka widzi tylko `paid_amount`.
    const message = fill(SQL.payments, NR);
    m.rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message } });

    const r = await decide();

    expect(r).toEqual({ success: false, error: message });
    expect(m.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('RPC odmówiło mimo zgody polityki'),
      expect.objectContaining({ level: 'warning', tags: expect.objectContaining({ area: 'ksef.duplicate-decision' }) }),
    );
  });

  it.each([
    ['P0002 (faktura nie tej firmy)', 'P0002', KSEF_SEND_MESSAGES.notFound],
    ['42501 (rola)', '42501', CLIENT.role],
  ])('U3g: RPC zwraca %s — tekst klienta', async (_label, code, expected) => {
    m.rpc.mockResolvedValue({ data: null, error: { code, message: 'PRIVATE-DB-DIAGNOSTIC' } });

    const r = await decide();

    expect(r).toEqual({ success: false, error: expected });
  });

  it('U3h: szkic już wycofany tą samą decyzją (utracona odpowiedź, drugie kliknięcie) — sukces bez RPC', async () => {
    seed({
      invoice: invoiceRow({ ksef_status: 'draft', last_error_code: null, last_error: null }),
      submissions: [numberTakenRow(TENANT, X_ID, 'decided-other')],
    });

    const r = await decide({ choice: 'other_sale', confirmed: true });

    expect(r).toMatchObject({ success: true });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  // Przegląd PR B (#5): druga, nieodświeżona karta po zapisanej decyzji — nie „Zapisano: inna sprzedaż”,
  // tylko ALREADY z ZAPISANYM wyborem (ten sam tekst co RPC, krok 2); RPC niewołane.
  it.each([
    ['inny wybór niż zapisany („inna sprzedaż” przy zapisanej „tej samej”)', { choice: 'other_sale' as const }],
    ['ten sam wybór, ale inny numer KSeF oryginału niż zapisany', { choice: 'same_sale' as const, originalKsefNumber: K2 }],
  ])('U3h: szkic wycofany decyzją „ta sama sprzedaż”, %s — ALREADY, bez RPC', async (_label, patch) => {
    seed({
      invoice: invoiceRow({ ksef_status: 'draft', last_error_code: null, last_error: null }),
      submissions: [numberTakenRow(TENANT, X_ID, 'decided-same')],
    });

    const r = await decide({ ...patch, confirmed: true });

    expect(r).toEqual({ success: false, error: fillExpected('ALREADY', NR, 'ta sama sprzedaż') });
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['błąd bazy z RPC', () => m.rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'PRIVATE canceling statement due to statement timeout' } })],
    ['wyjątek klienta RPC', () => m.rpc.mockRejectedValue(new Error('PRIVATE fetch failed'))],
  ])('U3i: %s — GENERIC bez szczegółów bazy i Sentry.captureException', async (_label, arrange) => {
    arrange();

    const r = await decide();

    expect(r).toEqual({ success: false, error: CLIENT.generic });
    expect(m.captureException).toHaveBeenCalledTimes(1);
  });
});
