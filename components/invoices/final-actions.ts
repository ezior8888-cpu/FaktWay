'use server';

import { revalidatePath } from 'next/cache';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logAudit } from '@/lib/audit/log';
import { readTenantCashMethodForIssuance } from '@/lib/invoices/cash-method';
import { issueDateNotTodayError } from '@/lib/invoices/issue-date';
import { findAdvancesAlreadySettled } from '@/lib/invoices/settled-advances';
import { finalSpecialData, specialDataInsertError } from '@/lib/invoices/special-data';
import {
  settlementRowFromAdvance,
  type AdvanceInvoiceDbRow,
} from '@/lib/invoices/advance-settlement';
import { ROZ_SUBMISSION_HOLD_MESSAGE } from '@/lib/ksef/roz-submission-hold';
import { createClient } from '@/lib/supabase/server';
import { enqueueKsefSubmitAfterDraft } from '@/lib/invoices/ksef-submit-enqueue';
import { requireUserAndActiveOrg, type FormTenantCheck } from '@/lib/supabase/auth-context';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { formatJobSendError } from '@/lib/jobs/error-message';
import {
  settlementVatSummaries,
  type AdvanceInvoiceSettlementRow,
} from '@/lib/ksef/fa3-advance-generator';
import {
  calculateFinalInvoiceTotals,
  calculateInvoiceTotals,
} from '@/lib/invoices/calculator';
import { matchesTenantSeller, sellerFromTenantProfile } from '@/lib/invoices/tenant-seller';
import {
  buyerPartyFromBuyerData,
  sellerPartyFromSellerData,
} from '@/lib/invoices/map-buyer-party';
import {
  finalInvoiceSchema,
  type FinalInvoiceSchemaIn,
} from '@/lib/validators/invoice-validators';
import {
  calculateLineItem,
  roundToCents,
} from '@/lib/xml/invoice-calculator';
import type {
  Invoice,
  InvoiceLineItem,
  PaymentMethod,
  SellerParty,
  VatRate,
} from '@/types/invoice';
import type { BuyerData, FinalInvoiceData, InvoiceLine, SellerData } from '@/types/invoice-types';

type ActionResult =
  | { success: true; invoiceId: string; offline?: boolean }
  | { success: false; error: string; invoiceId?: string };

function zodIssuesMessage(err: {
  issues: readonly { path: PropertyKey[]; message: string }[];
}): string {
  return err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · ');
}

interface TenantSnap {
  id: string;
  nip: string;
  name: string;
  address: {
    countryCode?: string;
    addressLine1?: string;
    addressLine2?: string;
  } | null;
}

/** `formTenant` — firma formularza musi być firmą aktywną teraz (UX-01). */
async function tenantContext(formTenant: FormTenantCheck): Promise<{
  supabase: SupabaseClient;
  userId: string;
  tenant: TenantSnap;
}> {
  const { supabase, user, tenantId } = await requireUserAndActiveOrg(formTenant);

  const { data: raw, error } = await supabase
    .from('tenants')
    .select('id, nip, name, address_json')
    .eq('id', tenantId)
    .maybeSingle();

  if (error || !raw) throw new Error('Brak danych firmy');

  return {
    supabase,
    userId: user.id,
    tenant: {
      id: raw.id as string,
      nip: raw.nip as string,
      name: raw.name as string,
      address: (raw.address_json as TenantSnap['address']) ?? null,
    },
  };
}

function normalizeBank(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  return raw.replace(/\s+/g, '');
}

function paymentMethodFa(m: FinalInvoiceSchemaIn['paymentMethod']): PaymentMethod {
  if (m === 'compensation') return 'other';
  return m as PaymentMethod;
}

function requireTenantSeller(supplied: SellerData, tenant: TenantSnap): SellerData {
  const seller = sellerFromTenantProfile({
    nip: tenant.nip,
    name: tenant.name,
    address_json: tenant.address,
  });
  if (!seller) {
    throw new Error('Uzupełnij poprawne dane sprzedawcy w ustawieniach firmy przed wystawieniem faktury.');
  }
  if (!matchesTenantSeller(supplied, seller)) {
    throw new Error('Dane sprzedawcy zmieniły się lub nie należą do tej firmy. Odśwież formularz.');
  }
  return seller;
}

function invoiceLineItemsFromDomain(lines: InvoiceLine[]): InvoiceLineItem[] {
  return lines.map((line, idx) => {
    const calc = calculateLineItem({
      quantity: line.quantity,
      unitPriceNet: line.unitPriceNet,
      vatRate: line.vatRate as VatRate,
    });
    return {
      ordinal: idx + 1,
      name: line.name,
      unit: line.unit,
      quantity: line.quantity,
      unitPriceNet: line.unitPriceNet,
      vatRate: line.vatRate as VatRate,
      ...calc,
    };
  });
}

function buildFinalEnvelope(
  parsed: FinalInvoiceSchemaIn,
  advancesSum: number,
  cashMethod: boolean,
): FinalInvoiceData {
  const bankNorm = normalizeBank(parsed.bankAccount ?? '');
  const buyer = parsed.buyer as BuyerData;
  const seller = parsed.seller as SellerData;

  return {
    invoiceType: 'final',
    internalNumber: parsed.internalNumber,
    issueDate: parsed.issueDate,
    paymentMethod: parsed.paymentMethod,
    paymentDueDate: parsed.paymentDueDate,
    bankAccount: bankNorm,
    notes: parsed.notes?.trim()?.length ? parsed.notes.trim() : undefined,
    seller,
    buyer,
    taxAnnotations: {
      cashMethod: cashMethod ? 1 : 2,
      splitPayment: parsed.splitPayment ? 1 : 2,
    },
    advanceInvoiceIds: parsed.advanceInvoiceIds,
    totalAdvances: advancesSum,
    lines: parsed.lines.map((l) => ({
      ...l,
      vatRate: l.vatRate as InvoiceLine['vatRate'],
    })),
  };
}

function ghostFinalInvoice(envelope: FinalInvoiceData): Invoice {
  const preparedLines = invoiceLineItemsFromDomain(envelope.lines);
  const totals = calculateInvoiceTotals(preparedLines);

  const roundedAdvancesSum = envelope.advanceInvoiceIds.length
    ? roundToCents(envelope.totalAdvances)
    : 0;

  const finalTotals = calculateFinalInvoiceTotals(envelope.lines, roundedAdvancesSum);

  const seller: SellerParty = sellerPartyFromSellerData(envelope.seller);
  const buyer = buyerPartyFromBuyerData(envelope.buyer);

  return {
    internalNumber: envelope.internalNumber,
    type: 'ROZ',
    issueDate: envelope.issueDate,
    seller,
    buyer,
    lines: preparedLines,
    netTotal: totals.netTotal,
    vatTotal: totals.vatTotal,
    grossTotal: totals.grossTotal,
    payment: {
      amountDue: finalTotals.amountDue,
      currency: 'PLN',
      dueDate: envelope.paymentDueDate,
      method: paymentMethodFa(envelope.paymentMethod),
      bankAccount: normalizeBank(envelope.bankAccount),
    },
    annotations: envelope.taxAnnotations,
    notes: envelope.notes,
  };
}

async function fetchSettlementRows(
  supabase: SupabaseClient,
  tenantId: string,
  ids: string[],
): Promise<AdvanceInvoiceSettlementRow[] | { error: string }> {
  if (!ids.length) return { error: 'Brak zaliczek do rozliczenia.' };

  const { data, error } = await supabase
    .from('invoices')
    .select(
      'id, internal_number, ksef_number, issue_date, advance_amount, gross_total, net_total, vat_total, fa3_data, invoice_kind',
    )
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('ksef_status', 'accepted')
    .in('id', ids);

  if (error || !data) {
    return { error: error?.message ?? 'Odczyt faktur zaliczkowych nie powiódł się.' };
  }

  if (data.length !== ids.length) {
    return { error: 'Nie znaleziono wszystkich wybranych zaliczek albo są z innej firmy.' };
  }

  for (const row of data) {
    if (row.invoice_kind !== 'advance') {
      return {
        error: `Dokument ${row.internal_number ?? row.id.slice(0, 8)} nie jest fakturą zaliczkową.`,
      };
    }
  }

  const byId = new Map(data.map((r) => [r.id as string, r]));

  const rows: AdvanceInvoiceSettlementRow[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    const amt = Number(r.advance_amount ?? r.gross_total ?? 0);
    if (!(amt > 0)) {
      return { error: `Faktura zaliczkowa ${r.internal_number ?? id} nie ma kwoty rozliczenia.` };
    }
    // Ze stawką i rozbiciem — ROZ odejmuje zaliczkę w jej stawce (art. 106f ust. 3).
    rows.push(settlementRowFromAdvance(r as AdvanceInvoiceDbRow));
  }

  return rows;
}

async function insertFinalDraft(
  supabase: SupabaseClient,
  tenantId: string,
  ghost: Invoice,
  envelope: FinalInvoiceData,
  settlement: AdvanceInvoiceSettlementRow[],
): Promise<ActionResult> {
  const { data: inserted, error: invErr } = await supabase
    .from('invoices')
    .insert({
      tenant_id: tenantId,
      direction: 'outgoing',
      ksef_status: 'draft',
      internal_number: ghost.internalNumber,
      invoice_kind: 'final',
      invoice_type: 'ROZ',
      issue_date: ghost.issueDate,
      seller_nip: ghost.seller.nip,
      buyer_nip: ghost.buyer.nip ?? null,
      seller_data: ghost.seller,
      buyer_data: ghost.buyer,
      payment_data: ghost.payment,
      payment_due_date: ghost.payment.dueDate,
      currency: 'PLN',
      net_total: ghost.netTotal,
      vat_total: ghost.vatTotal,
      gross_total: ghost.grossTotal,
      advance_invoice_ids: envelope.advanceInvoiceIds,
      notes: envelope.notes ?? null,
      fa3_data: ghost,
      // A4b (00137): dane zdarzenia wysyłki ROZ (dziś szkic; wysyłka wstrzymana do C4).
      special_data: finalSpecialData(envelope, settlement),
    })
    .select('id')
    .single();

  if (invErr || !inserted) {
    return {
      success: false,
      error: specialDataInsertError(invErr, `faktury rozliczającej ${ghost.internalNumber}`)
        ?? invErr?.message ?? 'Nie udało się zapisać faktury rozliczającej',
    };
  }

  const invoiceId = inserted.id as string;

  const { error: linesErr } = await supabase.from('invoice_line_items').insert(
    ghost.lines.map((l) => ({
      invoice_id: invoiceId,
      ordinal: l.ordinal,
      name: l.name,
      unit: l.unit,
      quantity: l.quantity,
      unit_price_net: l.unitPriceNet,
      net_amount: l.netAmount,
      vat_rate: l.vatRate,
      vat_amount: l.vatAmount,
      gross_amount: l.grossAmount,
    })),
  );

  if (linesErr) {
    await supabase.from('invoices').delete().eq('id', invoiceId);
    return { success: false, error: `Błąd zapisu pozycji: ${linesErr.message}` };
  }

  return { success: true, invoiceId };
}

async function resolveFinalPayload(
  supabase: SupabaseClient,
  tenantId: string,
  parsed: FinalInvoiceSchemaIn,
): Promise<{ envelope: FinalInvoiceData; settlement: AdvanceInvoiceSettlementRow[] } | { error: string }> {
  const settlement = await fetchSettlementRows(supabase, tenantId, parsed.advanceInvoiceIds);
  if ('error' in settlement) return settlement;

  // AUD-67: zaliczka rozliczona już inną ROZ zaniżyłaby przychód drugi raz.
  const alreadySettled = await findAdvancesAlreadySettled(supabase, tenantId, parsed.advanceInvoiceIds);
  if (alreadySettled.size > 0) {
    const rozNumbers = [...new Set(alreadySettled.values())].join(', ');
    return {
      error: `Wybrana zaliczka jest już rozliczona fakturą ${rozNumbers}. Usuń tamten szkic albo wybierz inne zaliczki.`,
    };
  }

  const cashMethod = await readTenantCashMethodForIssuance(supabase, tenantId);

  const advancesSumRounded = settlement.reduce((s, r) => s + roundToCents(r.advance_amount), 0);

  if (parsed.totalAdvances > 0) {
    const diff = Math.abs(advancesSumRounded - roundToCents(parsed.totalAdvances));
    if (diff > 0.025) {
      return { error: 'Suma zaliczek nie zgadza się z koszykiem — odśwież listę lub wybór.' };
    }
  }

  const envelope = buildFinalEnvelope(parsed, advancesSumRounded, cashMethod);

  // Rozbicie reszty na stawki robi generator przy wysyłce — tu sprawdzamy je
  // od razu, żeby „zaliczka w stawce, której nie ma w zamówieniu” wróciła
  // do formularza, a nie wywróciła joba po zapisie szkicu.
  try {
    settlementVatSummaries(invoiceLineItemsFromDomain(envelope.lines), settlement);
  } catch (e) {
    return { error: e instanceof Error ? e.message.replace(/^FA\(3\) ROZ: /, '') : 'Nie można rozliczyć zaliczek.' };
  }

  return { envelope, settlement };
}

/**
 * `expectedTenantId` — firma, dla której strona wyrenderowała formularz
 * (UX-01); tylko do porównania z firmą z ciasteczka. Także w wysyłce.
 */
export async function saveFinalAction(raw: unknown, expectedTenantId: string): Promise<ActionResult> {
  try {
    const { supabase, tenant, userId } = await tenantContext({ expectedTenantId });
    const parsed = finalInvoiceSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: zodIssuesMessage(parsed.error) };

    const seller = requireTenantSeller(parsed.data.seller, tenant);
    const payload = await resolveFinalPayload(supabase, tenant.id, { ...parsed.data, seller });
    if ('error' in payload) return { success: false, error: payload.error };

    const ghost = ghostFinalInvoice(payload.envelope);

    const result = await insertFinalDraft(supabase, tenant.id, ghost, payload.envelope, payload.settlement);
    if (result.success) {
      await logAudit({
        action: 'invoice.draft_created',
        tenantId: tenant.id,
        userId,
        entityType: 'invoice',
        entityId: result.invoiceId,
        metadata: { kind: 'final', internalNumber: ghost.internalNumber },
      });
      revalidatePath('/invoices');
    }
    return result;
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Nieznany błąd' };
  }
}

export async function saveAndSendFinalAction(raw: unknown, expectedTenantId: string): Promise<ActionResult> {
  try {
    await tenantContext({ expectedTenantId });
    const parsed = finalInvoiceSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: zodIssuesMessage(parsed.error) };

    // Ta sama reguła co zwykła faktura (A1, W5): w KSeF tylko z dzisiejszą datą
    // wystawienia. Stoi przed hamulcem ROZ, żeby została po jego zdjęciu (C4).
    const notToday = issueDateNotTodayError(parsed.data.issueDate, 'special');
    if (notToday) return { success: false, error: notToday };

    // No accepted advance carries trustworthy KSeF environment provenance yet.
    // Keep the draft action available, but stop send before inserting a new ROZ.
    return { success: false, error: ROZ_SUBMISSION_HOLD_MESSAGE };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? formatJobSendError(e) : 'Nieznany błąd wysyłki',
    };
  }
}
