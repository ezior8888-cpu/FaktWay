import type { CorrectedInvoiceRef } from '@/lib/pdf/invoice-renderer';
import { isTenantStoragePath } from '@/lib/storage/tenant-path';
import { createAdminClient } from '@/lib/supabase/server';
import type {
  Invoice,
  InvoiceLineItem,
  InvoiceType,
  PaymentInfo,
  BuyerParty,
  SellerParty,
  VatRate,
} from '@/types/invoice';

/**
 * Mapowanie wiersza DB → domenowy typ `Invoice` dla renderera PDF
 * (Faza 33 Krok 4).
 *
 * `seller_data` / `buyer_data` / `payment_data` to JSONB zapisywane
 * bezpośrednio jako kształt `SellerParty` / `BuyerParty` / `PaymentInfo`
 * (zob. `lib/import/imported-invoice-row.ts`, `lib/billing/self-invoice.ts`)
 * — castujemy 1:1.
 */

export interface InvoicePdfData {
  invoice: Invoice;
  tenantId: string;
  invoiceId: string;
  /** Do budowy klucza R2 (YYYY-MM-DD). */
  issueDate: string;
  ksefNumber: string | null;
  ksefStatus: string | null;
  /**
   * Wiersz nie ma numeru (`internal_number IS NULL`): szkic wycofany po zapisie oryginału z KSeF
   * (D-A4-1b-3 PR C, 5.12) — numer przeszedł na fakturę K. `invoice.internalNumber` jest wtedy
   * tylko numerem zastępczym (`id.slice(0, 8)`) i nie wolno go drukować jako numeru faktury.
   */
  internalNumberMissing: boolean;
  /** Trwały ślad wejścia do kolejki Offline24, również po statusie failed/rejected. */
  offlineIdempotencyKey: string | null;
  /** NIP sprzedawcy i SHA-256 pliku XML (hex) — do KOD I (`qr-verification.ts`). */
  sellerNip: string | null;
  xmlSha256Hex: string | null;
  /** Korekta: faktura, której dotyczy (art. 106j ust. 2); inne faktury — `null`. */
  correctedInvoice: CorrectedInvoiceRef | null;
  /** Cache: PDF jest ważny gdy pdf_generated_at >= updated_at. */
  updatedAt: string | null;
  pdfStoragePath: string | null;
  pdfGeneratedAt: string | null;
}

interface LineItemRow {
  ordinal: number | null;
  name: string | null;
  unit: string | null;
  quantity: number | null;
  unit_price_net: number | null;
  net_amount: number | null;
  vat_rate: string | null;
  vat_amount: number | null;
  gross_amount: number | null;
}

interface InvoiceRow {
  id: string;
  tenant_id: string;
  internal_number: string | null;
  invoice_type: string | null;
  issue_date: string;
  sale_date: string | null;
  ksef_number: string | null;
  ksef_status: string | null;
  offline_idempotency_key: string | null;
  seller_nip: string | null;
  xml_storage_path: string | null;
  net_total: number | null;
  vat_total: number | null;
  gross_total: number | null;
  notes: string | null;
  parent_invoice_id: string | null;
  correction_reason: string | null;
  /** `fa3_data->annotations` — sama gałąź, nie cały snapshot. */
  annotations: unknown;
  updated_at: string | null;
  pdf_storage_path: string | null;
  pdf_generated_at: string | null;
  seller_data: unknown;
  buyer_data: unknown;
  payment_data: unknown;
  invoice_line_items: LineItemRow[] | null;
}

const SELECT = `
  id, tenant_id, internal_number, invoice_type, issue_date, sale_date,
  ksef_number, ksef_status, offline_idempotency_key, seller_nip, xml_storage_path,
  net_total, vat_total, gross_total, notes, updated_at,
  parent_invoice_id, correction_reason,
  pdf_storage_path, pdf_generated_at, seller_data, buyer_data, payment_data,
  annotations:fa3_data->annotations,
  invoice_line_items(
    ordinal, name, unit, quantity, unit_price_net,
    net_amount, vat_rate, vat_amount, gross_amount
  )
`;

const KNOWN_TYPES: ReadonlySet<string> = new Set<InvoiceType>([
  'VAT',
  'KOR',
  'ZAL',
  'ROZ',
  'UPR',
  'KOR_ZAL',
  'KOR_ROZ',
]);

function mapLine(row: LineItemRow): InvoiceLineItem {
  return {
    ordinal: row.ordinal ?? 0,
    name: row.name ?? '',
    unit: row.unit ?? 'szt',
    quantity: Number(row.quantity ?? 0),
    unitPriceNet: Number(row.unit_price_net ?? 0),
    netAmount: Number(row.net_amount ?? 0),
    vatRate: (row.vat_rate as VatRate | null) ?? '23',
    vatAmount: Number(row.vat_amount ?? 0),
    grossAmount: Number(row.gross_amount ?? 0),
  };
}

/**
 * Adnotacje FA(3) ze snapshotu: podstawa zwolnienia (P_19A), MPP (P_18A),
 * metoda kasowa (P_16). Odwrotne obciążenie (P_18) wynika z pozycji „oo”.
 */
function readAnnotations(raw: unknown): Invoice['annotations'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const annotations: NonNullable<Invoice['annotations']> = {};
  if (typeof o.vatExemptionBasis === 'string' && o.vatExemptionBasis.trim()) {
    annotations.vatExemptionBasis = o.vatExemptionBasis.trim();
  }
  if (o.splitPayment === 1) annotations.splitPayment = 1;
  if (o.cashMethod === 1) annotations.cashMethod = 1;
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

/**
 * Ładuje fakturę z DB i mapuje do `Invoice`. Klient omija RLS, dlatego
 * wymagamy identyfikatora organizacji już w zapytaniu, nie po odczycie.
 */
export async function loadInvoiceForPdf(
  invoiceId: string,
  tenantId: string,
): Promise<InvoicePdfData | null> {
  const admin = createAdminClient();
  const res = await (
    admin as unknown as {
      from: (n: string) => {
        select: (c: string) => {
          eq: (
            k: string,
            v: string,
          ) => {
            eq: (k: string, v: string) => {
              maybeSingle: () => Promise<{
                data: InvoiceRow | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
    }
  )
    .from('invoices')
    .select(SELECT)
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (res.error || !res.data) return null;
  const row = res.data;

  const lines = (row.invoice_line_items ?? [])
    .map(mapLine)
    .sort((a, b) => a.ordinal - b.ordinal);

  const rawType = (row.invoice_type ?? 'VAT').toUpperCase();
  const type: InvoiceType = KNOWN_TYPES.has(rawType)
    ? (rawType as InvoiceType)
    : 'VAT';

  const invoice: Invoice = {
    internalNumber: row.internal_number ?? row.id.slice(0, 8),
    type,
    issueDate: row.issue_date,
    saleDate: row.sale_date ?? undefined,
    seller: row.seller_data as SellerParty,
    buyer: row.buyer_data as BuyerParty,
    lines,
    netTotal: Number(row.net_total ?? 0),
    vatTotal: Number(row.vat_total ?? 0),
    grossTotal: Number(row.gross_total ?? 0),
    payment: row.payment_data as PaymentInfo,
    notes: row.notes ?? undefined,
    annotations: readAnnotations(row.annotations),
  };

  return {
    invoice,
    tenantId: row.tenant_id,
    invoiceId: row.id,
    issueDate: row.issue_date,
    ksefNumber: row.ksef_number,
    ksefStatus: row.ksef_status,
    internalNumberMissing: row.internal_number == null,
    offlineIdempotencyKey: row.offline_idempotency_key,
    sellerNip: row.seller_nip ?? (invoice.seller as { nip?: string } | null)?.nip ?? null,
    xmlSha256Hex: await readXmlHash(admin, row),
    correctedInvoice: await readCorrectedInvoice(admin, row),
    updatedAt: row.updated_at,
    pdfStoragePath: row.pdf_storage_path,
    pdfGeneratedAt: row.pdf_generated_at,
  };
}

/**
 * Starsze, przerwane zapisy mogły zostawić wpis kolejki bez znacznika na
 * fakturze. Błąd odczytu nie może być interpretowany jako brak wpisu.
 */
export async function invoiceHasOfflineQueueEntry(
  invoiceId: string,
  tenantId: string,
): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from('ksef_offline_queue')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('invoice_id', invoiceId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('Could not verify offline queue before invoice PDF');
  return data !== null;
}

/**
 * SHA-256 pliku XML faktury (ten sam plik, który poszedł do KSeF) — jak trasa
 * pobierania XML w portalu księgowej: po ścieżce zapisanej przy fakturze,
 * z filtrem firmy i faktury. Brak pliku (szkic) albo błąd → `null`: PDF
 * powstaje bez kodu QR zamiast z kodem, który prowadzi donikąd.
 */
async function readXmlHash(
  admin: ReturnType<typeof createAdminClient>,
  row: Pick<InvoiceRow, 'id' | 'tenant_id' | 'xml_storage_path'>,
): Promise<string | null> {
  if (!row.xml_storage_path || !isTenantStoragePath(row.xml_storage_path, row.tenant_id)) return null;
  const { data, error } = await (
    admin as unknown as {
      from: (n: string) => {
        select: (c: string) => {
          eq: (k: string, v: string) => {
            eq: (k: string, v: string) => {
              eq: (k: string, v: string) => {
                maybeSingle: () => Promise<{ data: { sha256_hash: string | null } | null; error: unknown }>;
              };
            };
          };
        };
      };
    }
  )
    .from('xml_documents')
    .select('sha256_hash')
    .eq('storage_path', row.xml_storage_path)
    .eq('tenant_id', row.tenant_id)
    .eq('invoice_id', row.id)
    .maybeSingle();
  if (error || !data?.sha256_hash) return null;
  return data.sha256_hash;
}

/**
 * Faktura korygowana — z bazy, po `parent_invoice_id` i W OBRĘBIE FIRMY
 * (klient omija RLS, a `parent_invoice_id` to zapisywalne dane faktury).
 * Błąd odczytu rzuca: PDF korekty bez danych faktury korygowanej byłby
 * niepełny, a „brak” nie może udawać „nie dotyczy”.
 */
async function readCorrectedInvoice(
  admin: ReturnType<typeof createAdminClient>,
  row: Pick<InvoiceRow, 'tenant_id' | 'parent_invoice_id' | 'correction_reason'>,
): Promise<CorrectedInvoiceRef | null> {
  if (!row.parent_invoice_id) return null;
  const { data, error } = await (
    admin as unknown as {
      from: (n: string) => {
        select: (c: string) => {
          eq: (k: string, v: string) => {
            eq: (k: string, v: string) => {
              maybeSingle: () => Promise<{
                data: { internal_number: string | null; issue_date: string; ksef_number: string | null } | null;
                error: { message: string } | null;
              }>;
            };
          };
        };
      };
    }
  )
    .from('invoices')
    .select('internal_number, issue_date, ksef_number')
    .eq('id', row.parent_invoice_id)
    .eq('tenant_id', row.tenant_id)
    .maybeSingle();
  if (error) throw new Error(`PDF korekty: nie udało się odczytać faktury korygowanej (${error.message}).`);
  if (!data?.internal_number) return null;
  return {
    number: data.internal_number,
    issueDate: data.issue_date,
    ksefNumber: data.ksef_number?.trim() || null,
    reason: row.correction_reason?.trim() || null,
  };
}

/** Zapisuje ścieżkę PDF + timestamp po wygenerowaniu (cache). */
export async function saveInvoicePdfPath(
  invoiceId: string,
  storagePath: string,
): Promise<void> {
  const admin = createAdminClient();
  await (
    admin as unknown as {
      from: (n: string) => {
        update: (p: Record<string, unknown>) => {
          eq: (k: string, v: string) => Promise<{ error: unknown }>;
        };
      };
    }
  )
    .from('invoices')
    .update({
      pdf_storage_path: storagePath,
      pdf_generated_at: new Date().toISOString(),
    })
    .eq('id', invoiceId);
}
