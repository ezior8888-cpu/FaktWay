import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D-A4-1b-3 PR B, decyzja Bartosza 10 (07.10.2026): dokumentu wycofanego —
 * szkicu z wpisem `number_taken` (decyzja klienta albo automatyczny „numer
 * zajęty”) — nie wysyłamy nabywcy e-mailem: jego numer ma w KSeF inna
 * faktura, więc PDF nie jest fakturą dla nabywcy. Odmowę daje
 * `verifyInvoicePdfDeliveryState` (jedyny wywołujący: `emailInvoiceAction`)
 * przez `findKsefNumberTaken`; błąd odczytu historii = odmowa (fail-closed).
 *
 * Do PR B sprawdzenie stanu przed wysyłką patrzyło tylko na kody QR i klucz
 * stanu PDF — PDF wycofanego szkicu szedł do nabywcy, a akcja kończyła się
 * sukcesem i audytem `invoice.emailed`.
 *
 * Prawdziwe: `emailInvoiceAction`, `verifyInvoicePdfDeliveryState`,
 * `findKsefNumberTaken` (submission-log), `buildInvoicePdfKey`, limit wysyłek.
 * Zastąpione: sesja (zweryfikowany właściciel), `generateInvoicePdf` (render
 * i magazyn), odczyt faktury do PDF, klient serwisowy (tabela
 * `ksef_submissions` w pamięci), wysyłka e-maila i audyt.
 */

const m = vi.hoisted(() => ({
  submissions: [] as Array<Record<string, unknown>>,
  failRead: false,
  ksefStatus: 'draft' as string,
  generatePdf: vi.fn(),
  sendEmail: vi.fn(),
  audit: vi.fn(),
  submissionReads: 0,
}));

vi.mock('@/lib/supabase/auth-context', () => ({
  ActionAuthError: class ActionAuthError extends Error {},
  requireUserAndActiveOrg: async () => ({
    user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9',
    role: 'owner',
    supabase: {},
  }),
}));
vi.mock('@/lib/pdf/invoice-pdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pdf/invoice-pdf')>()),
  generateInvoicePdf: m.generatePdf,
}));
vi.mock('@/lib/pdf/invoice-data', () => ({
  loadInvoiceForPdf: async (invoiceId: string, tenantId: string) => ({
    invoice: {
      internalNumber: 'FV/9/10/2026',
      type: 'VAT',
      issueDate: '2026-10-07',
      seller: { nip: '1234567890', name: 'Moja Firma' },
      buyer: { nip: '1234567890', name: 'Nabywca testowy' },
      lines: [],
      grossTotal: 123,
      payment: { dueDate: '2026-10-21', amountDue: 123 },
    },
    tenantId,
    invoiceId,
    issueDate: '2026-10-07',
    ksefNumber: null,
    ksefStatus: m.ksefStatus,
    offlineIdempotencyKey: null,
    sellerNip: '1234567890',
    xmlSha256Hex: null,
    correctedInvoice: null,
    updatedAt: null,
    pdfStoragePath: null,
    pdfGeneratedAt: null,
  }),
  invoiceHasOfflineQueueEntry: async () => false,
  saveInvoicePdfPath: vi.fn(),
}));
vi.mock('@/lib/email/send', () => ({ sendInvoiceEmail: m.sendEmail }));
vi.mock('@/lib/audit/log', () => ({ logAudit: m.audit }));
/** Klient serwisowy: `ksef_submissions` w pamięci, filtry eq/neq/in/is, sortowanie i limit; `failRead` = błąd bazy. */
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const predicates: Array<(r: Record<string, unknown>) => boolean> = [];
      let limitN: number | null = null;
      let sort: { key: string; ascending: boolean } | null = null;
      const exec = () => {
        if (table !== 'ksef_submissions') throw new Error(`faktura-wycofana-mail: nieoczekiwana tabela ${table}`);
        m.submissionReads += 1;
        if (m.failRead) return { data: null, error: { message: 'odczyt ksef_submissions nieudany' } };
        let rows = m.submissions.filter((r) => predicates.every((p) => p(r)));
        if (sort) {
          const { key, ascending } = sort;
          rows = [...rows].sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * (ascending ? 1 : -1));
        }
        if (limitN !== null) rows = rows.slice(0, limitN);
        return { data: rows.map((r) => ({ ...r })), error: null };
      };
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => { predicates.push((r) => r[k] === v); return q; },
        neq: (k: string, v: unknown) => { predicates.push((r) => r[k] !== v); return q; },
        in: (k: string, vs: unknown[]) => { predicates.push((r) => vs.includes(r[k])); return q; },
        is: (k: string, v: unknown) => { predicates.push((r) => (r[k] ?? null) === v); return q; },
        order: (key: string, o?: { ascending?: boolean }) => { sort = { key, ascending: o?.ascending ?? true }; return q; },
        limit: (n: number) => { limitN = n; return q; },
        maybeSingle: async () => {
          const res = exec();
          return { data: res.data?.[0] ?? null, error: res.error };
        },
        then: <A, B>(ok: (v: ReturnType<typeof exec>) => A, fail?: (e: unknown) => B) =>
          Promise.resolve().then(exec).then(ok, fail),
      };
      return q;
    },
    rpc: vi.fn(),
  }),
}));

import { emailInvoiceAction } from '@/components/invoices/actions-detail';
import { buildInvoicePdfKey } from '@/lib/pdf/pdf-storage';

import { CLIENT, numberTakenRow } from './helpers/decyzja-klienta';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9';
const ID = '55555555-5555-4555-8555-555555555551';
const NR = 'FV/9/10/2026';

beforeEach(() => {
  vi.clearAllMocks();
  m.submissions = [];
  m.failRead = false;
  m.ksefStatus = 'draft';
  m.submissionReads = 0;
  // Klucz stanu PDF jak w prawdziwym generatorze: szkic bez XML (bez KODU I) i bez numeru KSeF.
  m.generatePdf.mockResolvedValue({
    success: true,
    pdf: Buffer.from('pdf'),
    filename: 'Faktura_FV-9-10-2026.pdf',
    qrStateKey: buildInvoicePdfKey(TENANT, ID, '2026-10-07', null, null),
    missingKodI: false,
  });
  m.sendEmail.mockResolvedValue({ sent: true });
});

const emailedAudit = () => m.audit.mock.calls.filter(([entry]) => (entry as { action?: string }).action === 'invoice.emailed');

describe('e-mail do nabywcy — dokument wycofany (D-A4-1b-3 PR B, decyzja 10)', () => {
  it.each([
    ['decyzja klienta „inna sprzedaż”', 'decided-other'],
    ['automatyczny werdykt KSEF_NUMBER_TAKEN', 'automatic'],
  ] as const)('U22a: szkic wycofany (%s) — odmowa z numerem dokumentu, bez e-maila i bez audytu wysyłki', async (_label, shape) => {
    m.submissions = [numberTakenRow(TENANT, ID, shape)];

    const r = await emailInvoiceAction(ID, 'nabywca@example.test');

    expect(r).toEqual({ success: false, error: CLIENT.retiredEmailRefusal(NR) });
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(emailedAudit()).toEqual([]);
  });

  it('U22b: błąd odczytu historii wysyłki — HISTORY_READ_FAILED (fail-closed), bez e-maila', async () => {
    m.failRead = true;

    const r = await emailInvoiceAction(ID, 'nabywca@example.test');

    expect(r).toEqual({ success: false, error: CLIENT.historyReadFailed });
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(emailedAudit()).toEqual([]);
  });

  it('U22c strażnik: zwykły szkic (wpisy innych statusów, wpis number_taken innej faktury) — wysłany, jeden e-mail', async () => {
    m.submissions = [
      numberTakenRow(TENANT, '55555555-5555-4555-8555-555555555552', 'automatic'),
      numberTakenRow(TENANT, ID, 'automatic', { status: 'abandoned' }),
    ];

    const r = await emailInvoiceAction(ID, 'nabywca@example.test');

    expect(r).toEqual({ success: true });
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    expect(m.sendEmail.mock.calls[0]![0]).toMatchObject({ to: 'nabywca@example.test', invoiceNumber: NR });
    expect(emailedAudit()).toHaveLength(1);
  });
});
