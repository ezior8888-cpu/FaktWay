import 'server-only';

import { z } from 'zod';

import { hashToken } from '@/lib/accountant/tokens';
import { getClientIp } from '@/lib/auth/get-client-ip';
import { amountDueOf } from '@/lib/invoices/amount-due';
import { isBuyerLinkToken } from '@/lib/invoice-share/policy';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { invoiceVerificationUrl, ksefEnvForQr, qrLabel } from '@/lib/ksef/qr-verification';
import { checkBuyerInvoiceRateLimit } from '@/lib/rate-limit/invoice-share';
import { createAdminClient } from '@/lib/supabase/server';

/**
 * Odczyt faktury dla nabywcy po tokenie z adresu (`/faktura/<token>`, krok
 * 2.10). Wspólny dla strony i tras plików, w tej kolejności:
 *
 * 1. limit prób na adres IP w Redisie; bez Redisa odmowa (fail-closed);
 * 2. kształt tokenu; zły kształt to „link nie działa” bez pytania bazy;
 * 3. funkcja `invoice_share_link_view` (00179) kluczem serwisowym, ze skrótem
 *    SHA-256 tokenu (`hashToken`, jak portal księgowej): baza zwraca dane tej
 *    jednej faktury albo NULL, bez powodu (wygasły, cofnięty, nieznany,
 *    faktura nieprzyjęta);
 * 4. środowisko KSeF faktury musi być środowiskiem aplikacji.
 *
 * Wynik dzieli się na `view` (to wolno pokazać nabywcy) i `access`
 * (identyfikatory i ścieżka pliku tylko dla serwera; nigdy do komponentu).
 */

export interface BuyerParty {
  name: string | null;
  nip: string | null;
  vatUeNumber: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
}

/** Pozycja jak w `invoice_line_items` (nazwy kolumn, bo liczy z nich `vatSummaryByRate`). */
export interface BuyerInvoiceLine {
  ordinal: number;
  name: string | null;
  unit: string | null;
  quantity: number | null;
  unit_price_net: number | null;
  vat_rate: string | null;
  net_amount: number | null;
  vat_amount: number | null;
  gross_amount: number | null;
}

export interface BuyerInvoiceView {
  number: string | null;
  invoiceType: string | null;
  invoiceKind: string;
  issueDate: string;
  saleDate: string | null;
  currency: string;
  netTotal: number | null;
  vatTotal: number | null;
  grossTotal: number | null;
  amountDue: number;
  notes: string | null;
  ksefNumber: string;
  ksefAcceptedAt: string | null;
  splitPayment: boolean;
  seller: BuyerParty;
  buyer: BuyerParty;
  payment: {
    method: string | null;
    dueDate: string | null;
    bankAccount: string | null;
    bankName: string | null;
    swift: string | null;
  };
  lines: BuyerInvoiceLine[];
  /** KOD I: ten sam link weryfikacji w KSeF co na PDF; `null`, gdy nie da się go zbudować. */
  qr: { url: string; label: string } | null;
  /** Do kiedy działa link (znacznik czasu z bazy). */
  expiresAt: string;
}

/** Tylko dla serwera: generator PDF i podpis adresu pliku XML. */
export interface BuyerInvoiceAccess {
  tenantId: string;
  invoiceId: string;
  linkId: string;
  xmlStoragePath: string;
}

export type BuyerInvoiceResult =
  | { status: 'ok'; view: BuyerInvoiceView; access: BuyerInvoiceAccess }
  | { status: 'not_found' }
  | { status: 'limited'; retryAfter: number }
  | { status: 'unavailable' };

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = z.string().nullable();
const amount = z.number().nullable();

const partySchema = z.object({
  name: text,
  nip: text,
  vat_ue_number: text.optional(),
  address_line1: text,
  address_line2: text,
});

const lineSchema = z.object({
  ordinal: z.number(),
  name: text,
  unit: text,
  quantity: amount,
  unit_price_net: amount,
  vat_rate: text,
  net_amount: amount,
  vat_amount: amount,
  gross_amount: amount,
});

/** Kształt odpowiedzi `invoice_share_link_view`; inny kształt to błąd (strona niedostępna), nie pusta faktura. */
const viewRowSchema = z.object({
  link_id: z.string().regex(UUID_SHAPE),
  tenant_id: z.string().regex(UUID_SHAPE),
  invoice_id: z.string().regex(UUID_SHAPE),
  expires_at: z.string().min(1),
  ksef_environment: text,
  xml_storage_path: z.string().min(1),
  xml_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  invoice: z.object({
    internal_number: text,
    invoice_type: text,
    invoice_kind: z.string(),
    issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sale_date: text,
    currency: text,
    net_total: amount,
    vat_total: amount,
    gross_total: amount,
    notes: text,
    ksef_number: z.string().min(1),
    ksef_accepted_at: text,
    split_payment: z.boolean(),
    seller: partySchema,
    buyer: partySchema,
    payment: z.object({
      method: text,
      due_date: text,
      bank_account: text,
      bank_name: text,
      swift: text,
    }),
    lines: z.array(lineSchema),
  }),
});

type ViewRow = z.infer<typeof viewRowSchema>;

function party(raw: z.infer<typeof partySchema>): BuyerParty {
  return {
    name: raw.name,
    nip: raw.nip,
    vatUeNumber: raw.vat_ue_number ?? null,
    addressLine1: raw.address_line1,
    addressLine2: raw.address_line2,
  };
}

function toView(row: ViewRow): BuyerInvoiceView {
  const inv = row.invoice;
  const qrUrl = invoiceVerificationUrl({
    env: ksefEnvForQr(),
    sellerNip: inv.seller.nip,
    issueDate: inv.issue_date,
    sha256Hex: row.xml_sha256,
  });
  return {
    number: inv.internal_number,
    invoiceType: inv.invoice_type,
    invoiceKind: inv.invoice_kind,
    issueDate: inv.issue_date,
    saleDate: inv.sale_date,
    currency: inv.currency?.trim().toUpperCase() || 'PLN',
    netTotal: inv.net_total,
    vatTotal: inv.vat_total,
    grossTotal: inv.gross_total,
    // VAT i zaliczkowa: całe brutto (`amountDueOf`, ta sama reguła co ekran i PDF).
    amountDue: amountDueOf({ invoice_kind: inv.invoice_kind, gross_total: inv.gross_total }),
    notes: inv.notes,
    ksefNumber: inv.ksef_number,
    ksefAcceptedAt: inv.ksef_accepted_at,
    splitPayment: inv.split_payment,
    seller: party(inv.seller),
    buyer: party(inv.buyer),
    payment: {
      method: inv.payment.method,
      dueDate: inv.payment.due_date,
      bankAccount: inv.payment.bank_account,
      bankName: inv.payment.bank_name,
      swift: inv.payment.swift,
    },
    lines: inv.lines,
    qr: qrUrl ? { url: qrUrl, label: qrLabel(inv.ksef_number) } : null,
    expiresAt: row.expires_at,
  };
}

/**
 * `countOpen`: otwarcie strony liczy się do licznika otwarć linku, pobranie
 * pliku nie (trasy PDF i XML podają `false`).
 */
export async function loadBuyerInvoice(
  rawToken: string,
  { countOpen }: { countOpen: boolean },
): Promise<BuyerInvoiceResult> {
  const limit = await checkBuyerInvoiceRateLimit(await getClientIp());
  // Limit w pamięci procesu nie jest wspólny dla instancji: strona publiczna odmawia.
  if (limit.fallback) return { status: 'unavailable' };
  if (!limit.allowed) return { status: 'limited', retryAfter: limit.retryAfter };

  if (!isBuyerLinkToken(rawToken)) return { status: 'not_found' };

  const environment = configuredKsefEnvironment();
  if (!environment) return { status: 'unavailable' };

  let data: unknown;
  try {
    const result = await createAdminClient().rpc('invoice_share_link_view', {
      p_token_hash: hashToken(rawToken),
      p_count_open: countOpen,
    });
    if (result.error) {
      // Bez treści błędu i parametrów: w zapytaniu jest skrót tokenu.
      console.error('[buyer-invoice] view_failed');
      return { status: 'unavailable' };
    }
    data = result.data;
  } catch {
    console.error('[buyer-invoice] view_failed');
    return { status: 'unavailable' };
  }

  if (data === null || data === undefined) return { status: 'not_found' };

  const parsed = viewRowSchema.safeParse(data);
  if (!parsed.success) {
    console.error('[buyer-invoice] unexpected_shape');
    return { status: 'unavailable' };
  }
  const row = parsed.data;
  if (row.ksef_environment !== environment) return { status: 'not_found' };

  return {
    status: 'ok',
    view: toView(row),
    access: {
      tenantId: row.tenant_id,
      invoiceId: row.invoice_id,
      linkId: row.link_id,
      xmlStoragePath: row.xml_storage_path,
    },
  };
}
