import { NonRetriableError } from '@/lib/jobs/errors';
import { isDeepStrictEqual } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { KsefEnvironment } from '@/types/ksef';
import type { Invoice } from '@/types/invoice';
import type { AdvanceInvoiceData, CorrectionInvoiceData, FinalInvoiceData, SellerData } from '@/types/invoice-types';
import { sellerPartyFromSellerData } from '@/lib/invoices/map-buyer-party';
import { matchesTenantSeller, sellerFromTenantProfile } from '@/lib/invoices/tenant-seller';
import { parseVatUe } from '@/lib/invoices/vat-ue';

interface SubmitReferenceInput {
  supabase: SupabaseClient;
  tenantId: string;
  invoiceId: string;
  invoice: Invoice;
  environment: KsefEnvironment;
  correctionData?: CorrectionInvoiceData;
  advanceData?: AdvanceInvoiceData;
  finalData?: FinalInvoiceData;
  finalAdvanceSettlementRows?: readonly unknown[];
  /**
   * A4b PR2a: pominąć porównanie z BIEŻĄCYM profilem firmy (`tenants`)?
   * Runner podaje to tylko przed uzgodnieniem — gdy jest otwarty wpis albo
   * zlecenie „tylko uzgodnij”: zmiana nazwy firmy po pierwszej wysyłce nie
   * może zamienić uzgodnienia w INVALID_DOCUMENT. Granica tuż przed POST
   * nigdy tego nie podaje. Liczone leniwie, tylko dla ZAL i ROZ.
   */
  skipLiveTenantSeller?: () => Promise<boolean>;
}

function invalidPayload(): never {
  throw new NonRetriableError('KSeF document kind or source requires manual reconciliation');
}

function plainJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    invalidPayload();
  }
}

function frozenBankAccount(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') invalidPayload();
  return value.replace(/\s+/g, '') || undefined;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * KOR XML takes Podmiot2 from the event envelope, so its buyer identity must be
 * the accepted parent's `buyer_data`. FA(3) identifies the parent buyer by NIP
 * when present (generator choice order), otherwise by VAT-UE (KodUE+NrVatUE).
 * NIP buyer: same NIP digits. EU buyer: same canonical VAT-UE from another EU
 * state. Anything else (B2C, missing or ambiguous identity) fails closed.
 */
function sameCorrectionBuyer(buyer: CorrectionInvoiceData['buyer'] | undefined, stored: unknown): boolean {
  if (!buyer || typeof buyer !== 'object' || !stored || typeof stored !== 'object') return false;
  const { nip: storedNip, vatUeNumber: storedVatUe } = stored as { nip?: unknown; vatUeNumber?: unknown };
  const parentNip = typeof storedNip === 'string' ? digitsOnly(storedNip) : '';

  if (buyer.type === 'b2b') {
    return parentNip !== '' && typeof buyer.nip === 'string' && digitsOnly(buyer.nip) === parentNip;
  }
  if (buyer.type === 'eu') {
    if (parentNip !== '' || typeof storedVatUe !== 'string' || typeof buyer.vatUeNumber !== 'string') return false;
    const parentVatUe = parseVatUe(storedVatUe);
    const correctionVatUe = parseVatUe(buyer.vatUeNumber);
    return parentVatUe !== null && parentVatUe.kodUE !== 'PL' &&
      correctionVatUe !== null && correctionVatUe.normalized === parentVatUe.normalized;
  }
  return false;
}

/** A special XML uses its separate envelope, so it must have the frozen seller. */
async function assertSpecialSeller(
  input: SubmitReferenceInput,
  stored: { seller_nip?: unknown; seller_data?: unknown },
  envelopeSeller: SellerData,
): Promise<void> {
  if (!envelopeSeller || typeof envelopeSeller.nip !== 'string' ||
      typeof envelopeSeller.name !== 'string' ||
      typeof envelopeSeller.address?.countryCode !== 'string' ||
      typeof envelopeSeller.address.addressLine1 !== 'string' ||
      typeof envelopeSeller.address.addressLine2 !== 'string') invalidPayload();

  const sellerFromEnvelope = plainJson(sellerPartyFromSellerData(envelopeSeller));
  const sellerFromEvent = plainJson(input.invoice.seller);
  if (!isDeepStrictEqual(sellerFromEnvelope, sellerFromEvent) ||
      !isDeepStrictEqual(stored.seller_data, sellerFromEvent) ||
      typeof stored.seller_nip !== 'string' ||
      stored.seller_nip.replace(/\D/g, '') !== envelopeSeller.nip.replace(/\D/g, '')) invalidPayload();

  // Uzgodnienie wcześniejszej wysyłki (A4b PR2a): treść jest zamrożona i porównana wyżej.
  if (await input.skipLiveTenantSeller?.()) return;

  // An older queued event could predate the Server Action seller guard.
  const { data: tenant, error } = await input.supabase
    .from('tenants')
    .select('nip, name, address_json')
    .eq('id', input.tenantId)
    .maybeSingle();
  if (error) throw new Error('Cannot read KSeF seller tenant');
  if (!tenant) invalidPayload();
  const tenantSeller = sellerFromTenantProfile(tenant);
  if (!tenantSeller || !matchesTenantSeller(envelopeSeller, tenantSeller)) invalidPayload();
}

/** Re-read the stored legal document before KSeF I/O; old/replayed events are not authority. */
export async function assertSubmitReferences(
  input: SubmitReferenceInput,
): Promise<'regular' | 'correction' | 'advance' | 'final'> {
  const { data: invoice, error } = await input.supabase
    .from('invoices')
    .select('id, invoice_kind, invoice_type, internal_number, parent_invoice_id, advance_invoice_ids, seller_nip, seller_data, fa3_data, special_data')
    .eq('id', input.invoiceId)
    .eq('tenant_id', input.tenantId)
    .eq('direction', 'outgoing')
    .maybeSingle();
  if (error) throw new Error('Cannot read KSeF invoice kind');
  if (!invoice?.id) invalidPayload();

  // Enqueue publishes before the status becomes queued. A tenant could change
  // fa3_data in that interval; never send a stale event's legal document.
  let eventDocument: unknown;
  try {
    eventDocument = JSON.parse(JSON.stringify(input.invoice));
  } catch {
    invalidPayload();
  }
  if (!invoice.fa3_data || !isDeepStrictEqual(invoice.fa3_data, eventDocument) ||
      invoice.invoice_type !== input.invoice.type ||
      invoice.internal_number !== input.invoice.internalNumber) invalidPayload();

  const { correctionData, advanceData, finalData } = input;
  // A4b (00137): dane zdarzenia zapisane przy INSERT dokumentu. NULL = wiersz
  // sprzed 00137 — przyjmowany jak dotąd. Zapisana kopia musi być równa
  // zdarzeniu: zlecenie nie może nieść innej treści niż ta zapisana raz.
  const storedSpecial = invoice.special_data ?? null;
  const assertStoredSpecial = (fromEvent: unknown) => {
    if (storedSpecial !== null && !isDeepStrictEqual(storedSpecial, plainJson(fromEvent))) invalidPayload();
  };
  switch (invoice.invoice_kind) {
    case 'regular':
      if (correctionData || advanceData || finalData || storedSpecial !== null) invalidPayload();
      return 'regular';
    case 'correction': {
      if (input.environment === 'production') invalidPayload();
      if (!correctionData || advanceData || finalData ||
          correctionData.invoiceType !== 'correction' ||
          typeof correctionData.seller?.nip !== 'string' ||
          invoice.parent_invoice_id !== correctionData.parentInvoiceId ||
          invoice.internal_number !== correctionData.internalNumber) invalidPayload();
      assertStoredSpecial({ correctionData });

      const { data: parent, error: parentError } = await input.supabase
        .from('invoices')
        .select('id, internal_number, issue_date, ksef_number, seller_nip, buyer_data')
        .eq('id', correctionData.parentInvoiceId)
        .eq('tenant_id', input.tenantId)
        .eq('direction', 'outgoing')
        .eq('invoice_kind', 'regular')
        .eq('ksef_status', 'accepted')
        .eq('ksef_environment', input.environment)
        .maybeSingle();
      if (parentError) throw new Error('Cannot read KSeF correction parent');
      if (!parent?.id || !parent.ksef_number?.trim() ||
          parent.internal_number !== correctionData.parentInvoiceNumber ||
          parent.issue_date !== correctionData.parentInvoiceIssueDate ||
          parent.ksef_number !== correctionData.parentKsefNumber ||
          !parent.seller_nip ||
          parent.seller_nip.replace(/\s+/g, '') !== correctionData.seller.nip.replace(/\s+/g, '') ||
          !sameCorrectionBuyer(correctionData.buyer, parent.buyer_data)) {
        invalidPayload();
      }
      return 'correction';
    }
    case 'advance':
      // Koperta ZAL leży w fa3_data.advanceEnvelope (porównana niżej), nie tutaj.
      if (!advanceData || correctionData || finalData || storedSpecial !== null ||
          advanceData.invoiceType !== 'advance' ||
          invoice.internal_number !== advanceData.internalNumber) invalidPayload();
      if (!input.invoice.advanceEnvelope ||
          !isDeepStrictEqual(plainJson(input.invoice.advanceEnvelope), plainJson(advanceData)) ||
          !advanceData.taxAnnotations ||
          (advanceData.taxAnnotations.cashMethod !== 1 && advanceData.taxAnnotations.cashMethod !== 2) ||
          (advanceData.taxAnnotations.splitPayment !== 1 && advanceData.taxAnnotations.splitPayment !== 2) ||
          input.invoice.annotations?.cashMethod !== advanceData.taxAnnotations.cashMethod ||
          input.invoice.annotations?.splitPayment !== advanceData.taxAnnotations.splitPayment ||
          (advanceData.taxAnnotations.splitPayment === 1 &&
            (advanceData.paymentMethod !== 'transfer' ||
              typeof advanceData.bankAccount !== 'string' || !advanceData.bankAccount.trim())) ||
          input.invoice.payment?.dueDate !== advanceData.paymentDueDate ||
          input.invoice.payment?.method !==
            (advanceData.paymentMethod === 'compensation' ? 'other' : advanceData.paymentMethod) ||
          frozenBankAccount(input.invoice.payment?.bankAccount) !==
            frozenBankAccount(advanceData.bankAccount)) {
        invalidPayload();
      }
      await assertSpecialSeller(input, invoice, advanceData.seller);
      return 'advance';
    case 'final': {
      // Settlement rows are event-supplied and advances are not atomically
      // claimed yet. Never emit legal ROZ XML in production on that evidence.
      if (input.environment === 'production') invalidPayload();
      if (!finalData || correctionData || advanceData ||
          finalData.invoiceType !== 'final' ||
          invoice.internal_number !== finalData.internalNumber ||
          !Array.isArray(finalData.advanceInvoiceIds) ||
          !Array.isArray(input.finalAdvanceSettlementRows) ||
          !input.finalAdvanceSettlementRows.length) invalidPayload();
      assertStoredSpecial({ finalData, finalAdvanceSettlementRows: input.finalAdvanceSettlementRows });
      // AUD-23: P_16/P_18A ROZ tylko z dokumentu zapisanego przy wystawieniu.
      const flags = finalData.taxAnnotations;
      if (!flags ||
          (flags.cashMethod !== 1 && flags.cashMethod !== 2) ||
          (flags.splitPayment !== 1 && flags.splitPayment !== 2) ||
          input.invoice.annotations?.cashMethod !== flags.cashMethod ||
          input.invoice.annotations?.splitPayment !== flags.splitPayment ||
          (flags.splitPayment === 1 &&
            (finalData.paymentMethod !== 'transfer' ||
              typeof finalData.bankAccount !== 'string' || !finalData.bankAccount.trim()))) {
        invalidPayload();
      }
      const storedIds = invoice.advance_invoice_ids as string[] | null;
      if (!Array.isArray(storedIds) || storedIds.length !== finalData.advanceInvoiceIds.length ||
          storedIds.some((id, index) => id !== finalData.advanceInvoiceIds[index])) invalidPayload();
      await assertSpecialSeller(input, invoice, finalData.seller);
      return 'final';
    }
    default:
      invalidPayload();
  }
}
