import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D-A4-1b-3 PR C (00149, decyzje Bartosza 08.10.2026: C8, T10; spec v3 5.12, INV-23):
 * szkic wycofany po zapisie oryginału — dokument X, któremu decyzja klienta
 * zdjęła numer (`internal_number IS NULL`, wpis `number_taken` z
 * `decision.importedInvoiceId`) — nie jest fakturą: numer przeszedł na fakturę
 * K zapisaną z KSeF. Dlatego:
 *   - `generateInvoicePdf(X)` odmawia (`RETIRED_DRAFT`) tekstem nazywającym
 *     dokument (`FAKTFLOW.RETIRED_DOCUMENT_REFUSAL(dawny numer)`) i odnośnikiem
 *     do PDF faktury K (`link`); nie renderuje i nie zapisuje cache;
 *   - trasa `GET /api/invoices/[id]/pdf` oddaje 409 z `{ error, link }`;
 *   - `emailInvoiceAction(X)` kończy się TYM SAMYM tekstem (jeden tekst dla PDF
 *     i e-maila), bez wysyłki i bez audytu;
 *   - błąd odczytu historii (`ksef_submissions`) to odmowa `HISTORY_READ_FAILED`
 *     (fail-closed: „nie wiem” to nie „zwykły szkic”);
 *   - PDF faktury K i zwykłego szkicu Z numerem — bez zmian, bez dodatkowego
 *     odczytu historii (odczyt tylko dla szkicu bez numeru).
 *
 * Do PR C szkic bez numeru dostawał PDF z numerem zastępczym `id.slice(0, 8)`,
 * a e-mail odmawiał tekstem „numer zajęty przez inną fakturę” z tym samym
 * numerem zastępczym.
 *
 * Prawdziwe: `generateInvoicePdf`, `verifyInvoicePdfDeliveryState`,
 * `loadInvoiceForPdf` (invoice-data), `findKsefNumberTaken` (submission-log),
 * `buildInvoicePdfKey`, `emailInvoiceAction`, trasa PDF, limit wysyłek.
 * Zastąpione: klient bazy (jedna baza w pamięci dla `@/lib/supabase/server`
 * i `@/lib/supabase/admin`), renderer pdfkit, magazyn PDF (R2), sesja,
 * wysyłka e-maila i audyt.
 */

const m = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  db: null as null | { from: (table: string) => unknown },
  /** Nazwy tabel w kolejności odczytów (`from`) — dowód, kiedy NIE czytamy historii. */
  reads: [] as string[],
  failTable: null as string | null,
  render: vi.fn(),
  upload: vi.fn(),
  exists: vi.fn(),
  download: vi.fn(),
  sendEmail: vi.fn(),
  audit: vi.fn(),
  /** Wstrzyknięty wynik generatora (test mapowania trasy); domyślnie prawdziwy `generateInvoicePdf`. */
  generateOverride: null as null | ((id: string, tenantId: string) => Promise<unknown>),
  auth: vi.fn(),
}));

/** Jedna baza dla obu importów klienta serwisowego; `failTable` = błąd odczytu tabeli, `reads` = rejestr. */
const database = () => ({
  from: (table: string) => {
    m.reads.push(table);
    if (m.failTable === table) {
      const failing: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'neq', 'in', 'is', 'limit', 'order', 'maybeSingle', 'single']) failing[method] = () => failing;
      failing.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: { message: 'PRIVATE odczyt nieudany' } }).then(ok, fail);
      return failing;
    }
    return m.db!.from(table);
  },
  rpc: vi.fn(),
});

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => database(), createClient: async () => database() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => database() }));
vi.mock('@/lib/supabase/auth-context', () => ({
  ActionAuthError: class ActionAuthError extends Error {},
  requireUserAndActiveOrg: async () => ({
    user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
    tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9',
    role: 'owner',
    supabase: {},
  }),
  resolveApiUserAndActiveOrg: () => m.auth(),
}));
vi.mock('@/lib/pdf/invoice-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pdf/invoice-renderer')>()),
  renderInvoicePdf: m.render,
}));
vi.mock('@/lib/pdf/pdf-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pdf/pdf-storage')>()),
  invoicePdfExists: m.exists,
  downloadInvoicePdf: m.download,
  uploadInvoicePdf: m.upload,
}));
vi.mock('@/lib/pdf/invoice-pdf', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/invoice-pdf')>();
  return {
    ...real,
    generateInvoicePdf: (id: string, tenantId: string) =>
      m.generateOverride ? m.generateOverride(id, tenantId) : real.generateInvoicePdf(id, tenantId),
  };
});
vi.mock('@/lib/email/send', () => ({ sendInvoiceEmail: m.sendEmail }));
vi.mock('@/lib/audit/log', () => ({ logAudit: m.audit }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { GET as getPdf } from '@/app/api/invoices/[id]/pdf/route';
import { emailInvoiceAction } from '@/components/invoices/actions-detail';
import { DUPLICATE_DECISION_TEXTS } from '@/lib/ksef/duplicate-decision';
import { generateInvoicePdf, verifyInvoicePdfDeliveryState } from '@/lib/pdf/invoice-pdf';

import { memoryClient } from './helpers/baza-w-pamieci';
import { DECIDED_AT, K, numberTakenRow } from './helpers/decyzja-klienta';

const T = DUPLICATE_DECISION_TEXTS;
const F = DUPLICATE_DECISION_TEXTS.FAKTFLOW;

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9';
/** Dokument X: szkic wycofany po zapisie oryginału — bez numeru. */
const X_ID = '55555555-5555-4555-8555-555555555551';
/** Faktura K zapisana z KSeF — ma dawny numer X. */
const K_ID = '55555555-5555-4555-8555-555555555552';
/** Zwykły szkic Z numerem (nie wycofany). */
const Z_ID = '55555555-5555-4555-8555-555555555553';
const NR = 'FV/9/10/2026';
const NR_Z = 'FV/10/10/2026';
const SHA_XML = 'ab'.repeat(32);
const ARCHIVE_PATH = `${TENANT}/ksef-import/${K}.xml`;

type Row = Record<string, unknown>;

/** Wiersz faktury w kształcie, który czyta `loadInvoiceForPdf` (kolumny `SELECT` + relacja pozycji). */
function invoiceRow(patch: Row = {}): Row {
  return {
    id: X_ID,
    tenant_id: TENANT,
    internal_number: null,
    invoice_type: 'VAT',
    issue_date: '2026-10-07',
    sale_date: null,
    ksef_number: null,
    ksef_status: 'draft',
    offline_idempotency_key: null,
    seller_nip: '5260001246',
    xml_storage_path: null,
    net_total: 100,
    vat_total: 23,
    gross_total: 123,
    notes: null,
    updated_at: null,
    parent_invoice_id: null,
    correction_reason: null,
    pdf_storage_path: null,
    pdf_generated_at: null,
    seller_data: { nip: '5260001246', name: 'ACME', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
    buyer_data: { nip: '5252241585', name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '02-001 Warszawa' } },
    payment_data: { currency: 'PLN', dueDate: '2026-10-21', method: 'transfer', amountDue: 123 },
    invoice_line_items: [
      { ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unit_price_net: 100, net_amount: 100, vat_rate: '23', vat_amount: 23, gross_amount: 123 },
    ],
    ...patch,
  };
}

/** Szkic X po zapisie oryginału: bez numeru. */
const retiredX = (): Row => invoiceRow({ id: X_ID, internal_number: null });
/** Faktura K: przyjęta, numer = dawny numer X, plik w archiwum z wierszem `xml_documents` (KOD I). */
const importedK = (): Row => invoiceRow({
  id: K_ID, internal_number: NR, ksef_status: 'accepted', ksef_number: K, xml_storage_path: ARCHIVE_PATH, origin: 'ksef_import',
});
/** Zwykły szkic Z numerem. */
const plainDraft = (): Row => invoiceRow({ id: Z_ID, internal_number: NR_Z });

/** Wpis `number_taken` szkicu wycofanego z decyzją, która zapisała K (klucze 00149 w `decision`). */
function importedDecisionRow(decision: Row = {}, invoiceId = X_ID): Row {
  return numberTakenRow(TENANT, invoiceId, 'automatic', {
    original_check: {
      v: 1,
      env: 'test',
      reason: 'faktflow-original',
      decision: {
        choice: 'same_sale', via: 'client', at: DECIDED_AT, reason: 'faktflow-original', env: 'test',
        mode: 'import', offer: 'pair', actorUserId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', note: null,
        importedInvoiceId: K_ID, retiredInternalNumber: NR, ...decision,
      },
    },
  });
}

function seed(invoices: Row[], submissions: Row[] = []): void {
  m.tables = {
    invoices,
    ksef_submissions: submissions,
    xml_documents: [{ storage_path: ARCHIVE_PATH, tenant_id: TENANT, invoice_id: K_ID, sha256_hash: SHA_XML }],
    ksef_offline_queue: [],
  };
  m.db = memoryClient(m.tables);
}

const submissionReads = (): number => m.reads.filter((table) => table === 'ksef_submissions').length;

const REFUSAL = (nrOld = NR) => ({
  success: false,
  code: 'RETIRED_DRAFT',
  error: F.RETIRED_DOCUMENT_REFUSAL(nrOld),
  link: { href: `/api/invoices/${K_ID}/pdf`, label: F.RETIRED_PDF_LINK(nrOld) },
});

beforeEach(() => {
  vi.resetAllMocks();
  m.reads = [];
  m.failTable = null;
  m.generateOverride = null;
  seed([retiredX(), importedK(), plainDraft()], [importedDecisionRow()]);
  m.render.mockResolvedValue(Buffer.from('pdf'));
  m.exists.mockResolvedValue(false);
  m.upload.mockResolvedValue(undefined);
  m.sendEmail.mockResolvedValue({ sent: true });
  m.auth.mockResolvedValue({ ok: true, tenantId: TENANT });
});

describe('PDF szkicu wycofanego po zapisie oryginału (D-A4-1b-3 PR C, C8/T10)', () => {
  it.each([
    ['„ta sama sprzedaż”, oferta pair', { choice: 'same_sale', offer: 'pair' }],
    ['„inna sprzedaż”, oferta pair', { choice: 'other_sale', offer: 'pair' }],
    ['zapis faktury z KSeF, oferta record', { choice: 'same_sale', offer: 'record' }],
    ['zapis operatora w przeglądzie, oferta review-pair', { choice: 'other_sale', offer: 'review-pair', via: 'operator' }],
  ])('PD1: %s — generateInvoicePdf odmawia RETIRED_DRAFT tekstem z dawnym numerem i odnośnikiem do PDF faktury K; bez renderu i bez zapisu cache', async (_label, decision) => {
    seed([retiredX(), importedK()], [importedDecisionRow(decision)]);

    const r = await generateInvoicePdf(X_ID, TENANT);

    expect(r).toEqual(REFUSAL());
    expect(m.render).not.toHaveBeenCalled();
    expect(m.upload).not.toHaveBeenCalled();
    expect(m.exists).not.toHaveBeenCalled();
    expect(m.download).not.toHaveBeenCalled();
  });

  it('PD2: odmowa dotyczy tylko szkicu bez numeru — PDF faktury K (cel odnośnika) i zwykłego szkicu Z numerem działają jak dotąd, a historię wysyłki czyta się tylko dla X', async () => {
    expect(await generateInvoicePdf(X_ID, TENANT)).toEqual(REFUSAL());
    expect(submissionReads()).toBe(1);

    const k = await generateInvoicePdf(K_ID, TENANT);
    const z = await generateInvoicePdf(Z_ID, TENANT);

    expect(k).toMatchObject({ success: true, filename: 'Faktura_FV_9_10_2026.pdf', missingKodI: false });
    expect(z).toMatchObject({ success: true, filename: 'Faktura_FV_10_10_2026.pdf' });
    expect(m.render).toHaveBeenCalledTimes(2);
    expect(m.render.mock.calls.map(([invoice]) => (invoice as { internalNumber: string }).internalNumber)).toEqual([NR, NR_Z]);
    // K i szkic z numerem: bez dodatkowego odczytu `ksef_submissions` (`findKsefNumberTaken` tylko dla szkicu bez numeru).
    expect(submissionReads()).toBe(1);
  });

  it('PD3: błąd odczytu historii wysyłki szkicu bez numeru — RETIRED_DRAFT z HISTORY_READ_FAILED (fail-closed), bez renderu', async () => {
    m.failTable = 'ksef_submissions';

    const r = await generateInvoicePdf(X_ID, TENANT);

    expect(r).toEqual({ success: false, code: 'RETIRED_DRAFT', error: T.HISTORY_READ_FAILED });
    expect(m.render).not.toHaveBeenCalled();
    expect(m.upload).not.toHaveBeenCalled();
  });

  it('PD4: verifyInvoicePdfDeliveryState (obrona przy wysyłce): szkic wycofany z zapisem oryginału — ten sam tekst co PDF, nie „numer zajęty” z numerem zastępczym', async () => {
    const r = await verifyInvoicePdfDeliveryState(X_ID, TENANT, 'dowolny-klucz-stanu', { refuseRetiredDraft: true });

    expect(r).toMatchObject({ success: false, code: 'RETIRED_DRAFT', error: F.RETIRED_DOCUMENT_REFUSAL(NR) });
    expect(r?.error).not.toBe(T.RETIRED_EMAIL_REFUSAL(X_ID.slice(0, 8)));
  });

  it('PD5: trasa GET /api/invoices/[id]/pdf — szkic wycofany: 409 z { error, link } (przez prawdziwy generator i bazę)', async () => {
    const response = await getPdf(new Request(`https://example.test/api/invoices/${X_ID}/pdf`), { params: Promise.resolve({ id: X_ID }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: F.RETIRED_DOCUMENT_REFUSAL(NR), link: REFUSAL().link });
  });

  it('PD5: trasa — wynik RETIRED_DRAFT z linkiem przechodzi do odpowiedzi 409 bez zmian (mapowanie kodu)', async () => {
    const link = { href: `/api/invoices/${K_ID}/pdf`, label: F.RETIRED_PDF_LINK(NR) };
    m.generateOverride = async () => ({ success: false, code: 'RETIRED_DRAFT', error: F.RETIRED_DOCUMENT_REFUSAL(NR), link });

    const response = await getPdf(new Request(`https://example.test/api/invoices/${X_ID}/pdf`), { params: Promise.resolve({ id: X_ID }) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: F.RETIRED_DOCUMENT_REFUSAL(NR), link });
  });

  it('PD5: trasa — PDF faktury K (cel odnośnika) pobiera się normalnie, 200 z nagłówkiem pliku', async () => {
    // Odmowa X i pobranie K w jednym przebiegu: odnośnik z odmowy musi prowadzić do działającego PDF.
    const refused = await getPdf(new Request(`https://example.test/api/invoices/${X_ID}/pdf`), { params: Promise.resolve({ id: X_ID }) });
    expect(refused.status).toBe(409);
    const link = ((await refused.json()) as { link?: { href: string } }).link;
    expect(link?.href).toBe(`/api/invoices/${K_ID}/pdf`);

    const response = await getPdf(new Request(`https://example.test${link!.href}`), { params: Promise.resolve({ id: K_ID }) });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain('Faktura_FV_9_10_2026.pdf');
  });

  it('PD6: emailInvoiceAction dla szkicu wycofanego po zapisie — ten sam tekst co PDF (RETIRED_DOCUMENT_REFUSAL z dawnym numerem), bez e-maila i bez audytu wysyłki', async () => {
    const r = await emailInvoiceAction(X_ID, 'nabywca@example.test');

    expect(r).toEqual({ success: false, error: F.RETIRED_DOCUMENT_REFUSAL(NR) });
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.audit.mock.calls.filter(([entry]) => (entry as { action?: string }).action === 'invoice.emailed')).toEqual([]);
    expect(m.render).not.toHaveBeenCalled();
  });

  it('PD6: emailInvoiceAction — błąd odczytu historii szkicu bez numeru: HISTORY_READ_FAILED, bez e-maila', async () => {
    m.failTable = 'ksef_submissions';

    const r = await emailInvoiceAction(X_ID, 'nabywca@example.test');

    expect(r).toEqual({ success: false, error: T.HISTORY_READ_FAILED });
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.render).not.toHaveBeenCalled();
  });
});
