/**
 * Self-invoicing: budowanie + zapis faktury VAT za subskrypcję klienta
 * (Faza 25 Krok 4).
 *
 * Meta-rekursja: nasza apka wystawia fakturę VAT własnym pipeline'em KSeF.
 * Operator (spółka prowadząca FaktWay) jest sprzedawcą, klient płacący Stripe'a
 * jest nabywcą.
 *
 * Założenia rozliczeniowe:
 *   - Stripe `amount_paid` = kwota brutto w groszach (PLN). Bez Stripe Tax
 *     przyjmujemy że Stripe Price zawiera już VAT (gross).
 *   - VAT 23% (standard PL). `net = round(gross / 1.23, 2)`, `vat = gross - net`.
 *   - Currency hard-coded PLN (Stripe Price w EUR/USD = TODO Faza 41+).
 *   - Issue date = paid_at, sale date = ten sam dzień.
 *   - Termin płatności = paid_at (faktura wystawiana PO już dokonanej zapłacie,
 *     bo Stripe robi capture przed naszą reakcją).
 *
 * Numerowanie: format `FF/YYYY/MM/<seq>` gdzie `seq` = ostatnie 8 znaków
 * Stripe Invoice ID (UPPER). Daje unique per (year, month) + przyjazne czytaniu.
 */

import type { Invoice, InvoiceLineItem } from '@/types/invoice';
import { createAdminClient } from '@/lib/supabase/admin';

import { getOperatorTenant, type OperatorTenantInfo } from './operator-config';
import { roundToCents } from '@/lib/xml/invoice-calculator';

export interface BuildSelfInvoiceInput {
  /** Brutto w groszach (PLN). */
  grossCents: number;
  /** ISO datetime płatności (z `stripe_payments.paid_at`). */
  paidAt: string;
  /** Stripe Invoice ID `in_*` — używany do `internalNumber`. */
  stripeInvoiceId: string;
  /** Plan subskrypcji — wpływa na nazwę pozycji. */
  plan: 'monthly' | 'annual';
  /** Rodzaj metody ze sprawdzonego Charge (`card`, `blik`); brak = karta. */
  paymentMethodType?: string;
}

export interface BuildSelfInvoiceOutput {
  invoice: Invoice;
  operator: OperatorTenantInfo;
  customerTenantId: string;
}

const VAT_RATE_PCT = 23;

function roundMoney(value: number): number {
  return roundToCents(value);
}

function centsToPln(cents: number): number {
  return roundMoney(cents / 100);
}

/**
 * Dzień płatności według czasu polskiego (`YYYY-MM-DD`) — ten sam, który
 * liczy baza (`paid_at AT TIME ZONE 'Europe/Warsaw'`, 00110). Do 02.10
 * brany z UTC: płatność 00:00–02:00 lądowała w poprzednim dniu (AUD-69).
 */
export function paidDateInPoland(paidAt: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(paidAt));
}

/**
 * Forma płatności na fakturze. BLIK to w FA(3) „mobilna”, nie „karta”; faktura
 * VAT ma mówić, jak klient naprawdę zapłacił. `create_billing_vat_invoice`
 * (00158) przyjmuje tylko te dwie formy.
 */
function selfInvoicePaymentMethod(paymentMethodType: string | undefined): 'card' | 'mobile' {
  return paymentMethodType === 'blik' ? 'mobile' : 'card';
}

// `create_billing_vat_invoice` (00152) przyjmuje tylko te wzorce nazwy
// pozycji i uwag (oraz dawną nazwę produktu z okresu przejścia).
function planLineName(plan: 'monthly' | 'annual', issueDate: string): string {
  const dateLabel = new Date(issueDate).toLocaleDateString('pl-PL', {
    year: 'numeric',
    month: 'long',
  });
  return plan === 'annual'
    ? `FaktWay — subskrypcja roczna (${dateLabel})`
    : `FaktWay — subskrypcja miesięczna (${dateLabel})`;
}

/**
 * Buduje obiekt `Invoice` (zgodny z FA(3) generatorem) z danych payment'u.
 * Pure function — żaden DB hit poza `getOperatorTenant`. Łatwo testowalna.
 */
export async function buildSelfInvoiceDraft(
  customerTenantId: string,
  input: BuildSelfInvoiceInput,
): Promise<BuildSelfInvoiceOutput | null> {
  const operator = await getOperatorTenant();
  if (!operator) return null;

  const supabase = createAdminClient();
  const { data: customer, error } = await supabase
    .from('tenants')
    .select('nip, name, address_json')
    .eq('id', customerTenantId)
    .maybeSingle();

  if (error || !customer) return null;

  const customerAddr =
    typeof customer.address_json === 'object' && customer.address_json !== null
      ? (customer.address_json as {
          countryCode?: string;
          addressLine1?: string;
          addressLine2?: string;
        })
      : null;

  // Money math: Stripe daje brutto. VAT 23% mieści się w cenie:
  //   gross = 100, net = gross / 1.23, vat = gross - net.
  const gross = centsToPln(input.grossCents);
  const net = roundMoney(gross / (1 + VAT_RATE_PCT / 100));
  const vat = roundMoney(gross - net);

  const issueDate = paidDateInPoland(input.paidAt);
  // Numer nadaje baza (kolejny w miesiącu, 00110) i zwraca z
  // `create_billing_vat_invoice` — draft go nie zna (AUD-69).
  const internalNumber = '';

  const line: InvoiceLineItem = {
    ordinal: 1,
    name: planLineName(input.plan, issueDate),
    unit: 'usł.',
    quantity: 1,
    unitPriceNet: net,
    netAmount: net,
    vatRate: '23',
    vatAmount: vat,
    grossAmount: gross,
  };

  const invoice: Invoice = {
    internalNumber,
    type: 'VAT',
    issueDate,
    saleDate: issueDate,
    seller: {
      nip: operator.nip,
      name: operator.name,
      address: {
        countryCode: operator.address.countryCode,
        addressLine1: operator.address.addressLine1,
        addressLine2: operator.address.addressLine2,
      },
    },
    buyer: {
      nip: customer.nip,
      name: customer.name,
      address: customerAddr
        ? {
            countryCode: customerAddr.countryCode ?? 'PL',
            addressLine1: customerAddr.addressLine1 ?? '',
            addressLine2: customerAddr.addressLine2 ?? '',
          }
        : {
            countryCode: 'PL',
            addressLine1: '',
            addressLine2: '',
          },
    },
    lines: [line],
    netTotal: net,
    vatTotal: vat,
    grossTotal: gross,
    payment: {
      amountDue: gross,
      currency: 'PLN',
      dueDate: issueDate, // Już opłacone (Stripe), termin = data wystawienia.
      method: selfInvoicePaymentMethod(input.paymentMethodType),
      bankAccount: operator.bankAccount ?? undefined,
    },
    notes: `Faktura za subskrypcję FaktWay. Płatność Stripe: ${input.stripeInvoiceId}.`,
  };

  return { invoice, operator, customerTenantId };
}

// ─── Persistence ──────────────────────────────────────────────────

export interface InsertResult {
  invoiceId: string;
  internalNumber: string;
  created: boolean;
}

/** Format numeru nadawanego przez bazę (`create_billing_vat_invoice`, 00110). */
const BILLING_INVOICE_NUMBER = /^FF\/\d{4}\/\d{2}\/\d{4}$/;

/**
 * Czy numer zwrócony przez RPC jest tym, którego się spodziewamy.
 *
 * Od 00110 numer nadaje baza, a draft idzie z pustym `internalNumber` —
 * porównanie „numer z bazy = numer draftu” było wtedy zawsze fałszywe
 * i każda faktura za abonament kończyła się wyjątkiem PO zacommitowanej
 * transakcji (K1 w rewizji z 03.10.2026, regresja AUD-69).
 *
 *   - draft bez numeru, nowa faktura: numer musi mieć format bazy,
 *   - draft bez numeru, faktura istniejąca: baza jest źródłem prawdy
 *     (także dawny format sprzed 00110),
 *   - draft z numerem (dawna ścieżka): numer musi się zgadzać dokładnie.
 */
function isExpectedInternalNumber(
  returned: unknown,
  draftNumber: string,
  created: boolean,
): returned is string {
  if (typeof returned !== 'string' || returned.length === 0) return false;
  if (draftNumber !== '') return returned === draftNumber;
  if (!created) return true;
  return BILLING_INVOICE_NUMBER.test(returned);
}

/**
 * Tworzy fakturę, jej pozycję i powiązanie z płatnością w jednej transakcji
 * SQL. RPC blokuje wiersz płatności także dla równoległego zwrotu.
 */
export async function insertSelfInvoice(
  invoice: Invoice,
  operatorTenantId: string,
  stripeInvoiceId: string,
  paymentId: string,
  customerTenantId: string,
): Promise<InsertResult> {
  if (!stripeInvoiceId.startsWith('in_') || invoice.lines.length !== 1) {
    throw new Error('Self-invoice identity requires reconciliation');
  }

  const supabase = createAdminClient() as unknown as {
    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{
      data: Array<{
        invoice_id: string;
        internal_number: string;
        created: boolean;
      }> | null;
      error: { message: string } | null;
    }>;
  };
  const { data, error } = await supabase.rpc('create_billing_vat_invoice', {
    p_payment_id: paymentId,
    p_customer_tenant_id: customerTenantId,
    p_operator_tenant_id: operatorTenantId,
    p_stripe_invoice_id: stripeInvoiceId,
    p_invoice: invoice,
  });

  if (error) {
    throw new Error('Self-invoice transaction failed: ' + error.message);
  }
  if (!Array.isArray(data) || data.length !== 1 ||
      typeof data[0].invoice_id !== 'string' ||
      typeof data[0].created !== 'boolean' ||
      !isExpectedInternalNumber(data[0].internal_number, invoice.internalNumber, data[0].created)) {
    throw new Error('Self-invoice transaction returned an invalid result');
  }

  return {
    invoiceId: data[0].invoice_id,
    internalNumber: data[0].internal_number,
    created: data[0].created,
  };
}