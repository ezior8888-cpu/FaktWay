'use server';

import { revalidatePath } from 'next/cache';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logAudit } from '@/lib/audit/log';
import { enqueueKsefSubmitAfterDraft } from '@/lib/invoices/ksef-submit-enqueue';
import { requireUserAndActiveOrg, type FormTenantCheck } from '@/lib/supabase/auth-context';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
// Plik 'use server' eksportuje tylko akcje — komunikat i typ K4 żyją w czystym module.
import {
  correctionNotAllowedMessage,
  openCorrectionMessage,
  type CorrectionBaselineOf,
  type OpenCorrectionRef,
} from '@/lib/invoices/correction-parents';
import { formatJobSendError } from '@/lib/jobs/error-message';
import {
  correctionInvoiceSchema,
  correctionLineSchema,
  correctionNpIiBuyerError,
  type CorrectionInvoiceSchemaIn,
  type CorrectionLineSchema,
} from '@/lib/validators/invoice-validators';
import { calculateCorrectionTotals } from '@/lib/invoices/calculator';
import { issueDateNotTodayError } from '@/lib/invoices/issue-date';
import {
  resolveAmountChangeVatRate,
  zeroVatRateFromParentLines,
} from '@/lib/invoices/correction-amount-change';
import { isNpIiBuyerVat, parseVatUe } from '@/lib/invoices/vat-ue';
import { calculateLineItem, calculateInvoiceTotals, roundToCents } from '@/lib/xml/invoice-calculator';
import type { Invoice, InvoiceLineItem, BuyerParty, PaymentMethod, SellerParty } from '@/types/invoice';
import type {
  BuyerB2B,
  BuyerEU,
  CorrectionBuyer,
  CorrectionInvoiceData,
  InvoiceLine,
  SellerData,
  ZeroVatAmountChangeRate,
} from '@/types/invoice-types';
import { loadParentAnnotations } from '@/lib/invoices/correction-annotations';
import { correctionSpecialData, specialDataInsertError } from '@/lib/invoices/special-data';

// ══════════════════════════════════════════════════════════════════════════════
// Tenant
// ══════════════════════════════════════════════════════════════════════════════

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

/**
 * `formTenant` — zapis korekty z formularza: firma formularza musi być firmą
 * aktywną teraz (UX-01). Odczyt faktury pierwotnej woła bez niego.
 */
async function tenantContext(formTenant?: FormTenantCheck): Promise<{
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

export type CorrectionActionResult =
  | { success: true; invoiceId: string; offline?: boolean }
  | { success: false; error: string; invoiceId?: string };

function zodIssuesMessage(err: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' · ');
}

function mapPaymentMethodToFa(m: CorrectionInvoiceSchemaIn['paymentMethod']): PaymentMethod {
  if (m === 'compensation') return 'other';
  return m as PaymentMethod;
}

function normalizeBankAccount(raw: string | undefined): string | undefined {
  if (!raw || raw.trim() === '') return undefined;
  return raw.replace(/\s+/g, '');
}

/**
 * Pozycje z faktury pierwotnej (DB) mogą mieć stare stawki (np. zw) — forma korekt dopuszcza wyłącznie pełny zestaw do FA.
 * Zwykła faktura zapisuje kody aplikacji (`np`, `np_ii` — AUD-70); import z KSeF od W9 też (`lib/xml/fa3-p12.ts`),
 * a wcześniejsze wiersze importu mogą mieć surowe P_12 z XML (`np I`, `np II`).
 */
function vatRateFromDbForCorrectionLine(raw: unknown): CorrectionLineSchema['vatRate'] {
  const s = typeof raw === 'string' ? raw.trim() : '';
  switch (s) {
    case '23':
    case '8':
    case '5':
    case '0':
    case 'oo':
    case 'np':
    case 'np_ii':
      return s;
    case 'np I':
      return 'np';
    case 'np II':
      return 'np_ii';
    default:
      throw new Error('Faktura pierwotna ma stawkę VAT nieobsługiwaną w korekcie. Wymagane ręczne uzgodnienie.');
  }
}

/** Stawki bez VAT, których z samych kwot (VAT 0) nie da się odróżnić od „0 KR”. */
const ZERO_VAT_RATES: ReadonlySet<string> = new Set<ZeroVatAmountChangeRate>(['np', 'np_ii', 'oo']);

/**
 * Nabywca faktury pierwotnej jako nabywca korekty: firma z NIP albo firma z UE
 * (AUD-70 — `buyer_data` z `vatUeNumber`, bez NIP). Numer VAT-UE w postaci
 * kanonicznej, jak zapisuje go zwykła faktura. Niespójne dane — błąd, nie zgadujemy.
 */
function buyerDataFromParty(bp: BuyerParty): BuyerB2B | BuyerEU {
  if (bp.nip) {
    const b: BuyerB2B = {
      type: 'b2b',
      idType: 'nip',
      nip: bp.nip.replace(/\s+/g, ''),
      name: bp.name,
      address: {
        countryCode: (bp.address.countryCode as string) || 'PL',
        addressLine1: bp.address.addressLine1 || ' ',
        addressLine2: bp.address.addressLine2 || ' ',
      },
      email: bp.email,
    };
    return b;
  }
  if (bp.vatUeNumber?.trim()) {
    const vat = parseVatUe(bp.vatUeNumber);
    if (!vat) {
      throw new Error('Faktura pierwotna ma nieprawidłowy numer VAT-UE nabywcy. Wymagane ręczne uzgodnienie.');
    }
    if (vat.kodUE === 'PL') {
      throw new Error('Faktura pierwotna ma polski numer VAT-UE (PL) nabywcy zamiast NIP. Wymagane ręczne uzgodnienie.');
    }
    const countryCode = bp.address?.countryCode?.trim() ?? '';
    if (!/^[A-Z]{2}$/.test(countryCode) || countryCode === 'PL') {
      throw new Error('Nabywca z UE na fakturze pierwotnej nie ma w adresie kraju spoza Polski. Wymagane ręczne uzgodnienie.');
    }
    const addressLine2 = bp.address.addressLine2?.trim() ? bp.address.addressLine2 : undefined;
    return {
      type: 'eu',
      vatUeNumber: vat.normalized,
      name: bp.name,
      address: {
        countryCode,
        addressLine1: bp.address.addressLine1 || ' ',
        ...(addressLine2 ? { addressLine2 } : {}),
      },
      email: bp.email,
    };
  }
  throw new Error('Korekta: brak NIP ani numeru VAT-UE nabywcy na fakturze pierwotnej (korekta obsługuje firmy z Polski i z UE).');
}

/** Nabywca korekty z formularza = nabywca faktury pierwotnej, bez zmiany typu (NIP ↔ VAT-UE). */
function sameBuyerAsParent(
  supplied: CorrectionInvoiceSchemaIn['buyer'],
  original: BuyerB2B | BuyerEU,
): boolean {
  if (supplied.name !== original.name ||
      supplied.address.countryCode !== original.address.countryCode ||
      supplied.address.addressLine1 !== original.address.addressLine1) {
    return false;
  }
  if (original.type === 'b2b') {
    return supplied.type === 'b2b' &&
      supplied.nip.replace(/\s+/g, '') === original.nip &&
      supplied.address.addressLine2 === original.address.addressLine2;
  }
  // Firma z UE: numer porównany w postaci kanonicznej (wielkość liter, spacje, kropki).
  return supplied.type === 'eu' &&
    parseVatUe(supplied.vatUeNumber)?.normalized === original.vatUeNumber &&
    (supplied.address.addressLine2 ?? '') === (original.address.addressLine2 ?? '');
}

function sellerDataFromParty(sp: SellerParty): SellerData {
  return {
    nip: sp.nip.replace(/\s+/g, ''),
    name: sp.name,
    address: {
      countryCode: (sp.address.countryCode as string) || 'PL',
      addressLine1: sp.address.addressLine1 || ' ',
      addressLine2: sp.address.addressLine2 || ' ',
    },
    email: sp.email,
  };
}

async function fetchParentInvoiceLines(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<CorrectionLineSchema[]> {
  const { data, error } = await supabase
    .from('invoice_line_items')
    .select('name, unit, quantity, unit_price_net, vat_rate')
    .eq('invoice_id', invoiceId)
    .order('ordinal', { ascending: true });

  if (error || !data?.length) {
    throw new Error('Brak pozycji na fakturze pierwotnej lub błąd odczytu.');
  }

  return data.map((row) => {
    if (row.quantity == null || row.unit_price_net == null ||
        !Number.isFinite(Number(row.quantity)) ||
        !Number.isFinite(Number(row.unit_price_net))) {
      throw new Error('Niepełne kwoty pozycji faktury pierwotnej; wymagane ręczne uzgodnienie.');
    }
    // Schemat korekty — dopuszcza pozycje np. II faktury dla firmy z UE (AUD-70).
    const parsed = correctionLineSchema.safeParse({
      name: row.name,
      unit: row.unit,
      quantity: Number(row.quantity),
      unitPriceNet: Number(row.unit_price_net),
      vatRate: vatRateFromDbForCorrectionLine(row.vat_rate),
    });
    if (!parsed.success) {
      throw new Error('Niepoprawne pozycje faktury pierwotnej; wymagane ręczne uzgodnienie.');
    }
    return parsed.data;
  });
}

function buildCorrectionEnvelope(parsed: CorrectionInvoiceSchemaIn): CorrectionInvoiceData {
  const bankNorm = normalizeBankAccount(parsed.bankAccount ?? undefined);
  const buyer = parsed.buyer as CorrectionBuyer;
  const seller = parsed.seller as SellerData;

  return {
    invoiceType: 'correction',
    internalNumber: parsed.internalNumber,
    issueDate: parsed.issueDate,
    paymentMethod: parsed.paymentMethod,
    paymentDueDate: parsed.paymentDueDate,
    bankAccount: bankNorm,
    notes: parsed.notes,
    seller,
    buyer,
    parentInvoiceId: parsed.parentInvoiceId,
    parentInvoiceNumber: parsed.parentInvoiceNumber,
    parentKsefNumber: parsed.parentKsefNumber ?? undefined,
    parentInvoiceIssueDate: parsed.parentInvoiceIssueDate,
    correctionType: parsed.correctionType,
    correctionReason: parsed.correctionReason,
    typKorekty: parsed.typKorekty,
    linesBefore: parsed.linesBefore,
    linesAfter: parsed.linesAfter,
    amountChange: parsed.amountChange,
  };
}

function linesToStoredItems(correctionData: CorrectionInvoiceData): InvoiceLineItem[] {
  const { correctionType } = correctionData;

  if (correctionType === 'cancellation' && correctionData.linesBefore?.length) {
    return correctionData.linesBefore.map((line, idx) => {
      const neg = { ...line, quantity: -line.quantity };
      const calc = calculateLineItem({
        quantity: neg.quantity,
        unitPriceNet: neg.unitPriceNet,
        vatRate: neg.vatRate,
      });
      return {
        ordinal: idx + 1,
        name: neg.name,
        unit: neg.unit,
        quantity: neg.quantity,
        unitPriceNet: neg.unitPriceNet,
        vatRate: neg.vatRate,
        netAmount: calc.netAmount,
        vatAmount: calc.vatAmount,
        grossAmount: calc.grossAmount,
      };
    });
  }

  if (correctionType === 'amount_change' && correctionData.amountChange) {
    const ac = correctionData.amountChange;
    const rate = resolveAmountChangeVatRate(ac);
    const line: InvoiceLine = {
      name: ac.description,
      unit: 'szt.',
      quantity: 1,
      unitPriceNet: ac.netDelta,
      vatRate: rate,
    };
    return [
      {
        ordinal: 1,
        ...line,
        netAmount: ac.netDelta,
        vatAmount: ac.vatDelta,
        grossAmount: ac.grossDelta,
      },
    ];
  }

  const after = correctionData.linesAfter ?? [];
  return after.map((line, idx) => {
    const calc = calculateLineItem({
      quantity: line.quantity,
      unitPriceNet: line.unitPriceNet,
      vatRate: line.vatRate,
    });
    return {
      ordinal: idx + 1,
      name: line.name,
      unit: line.unit,
      quantity: line.quantity,
      unitPriceNet: line.unitPriceNet,
      vatRate: line.vatRate,
      ...calc,
    };
  });
}

function ghostInvoice(correctionEnvelope: CorrectionInvoiceData, lines: InvoiceLineItem[]): Invoice {
  const totals = calculateCorrectionTotals(correctionEnvelope);
  const totalsFromLines =
    lines.length > 0
      ? calculateInvoiceTotals(lines)
      : {
          netTotal: totals.netAfter,
          vatTotal: totals.vatAfter,
          grossTotal: totals.grossAfter,
        };

  const seller: SellerParty = {
    nip: correctionEnvelope.seller.nip,
    name: correctionEnvelope.seller.name,
    address: {
      countryCode: correctionEnvelope.seller.address.countryCode,
      addressLine1: correctionEnvelope.seller.address.addressLine1,
      addressLine2: correctionEnvelope.seller.address.addressLine2,
    },
    email: correctionEnvelope.seller.email,
  };

  let buyerParty: BuyerParty;
  const b = correctionEnvelope.buyer;
  if (b.type === 'eu') {
    // AUD-70: firma z UE jak nabywca zwykłej faktury (`components/invoices/actions.ts`):
    // numer VAT-UE zamiast NIP, adres z krajem nabywcy.
    buyerParty = {
      vatUeNumber: b.vatUeNumber,
      name: b.name,
      address: {
        countryCode: b.address.countryCode,
        addressLine1: b.address.addressLine1,
        addressLine2: b.address.addressLine2 ?? '',
      },
      email: b.email,
      jst: 2,
      gv: 2,
    };
  } else if (b.type === 'b2b') {
    buyerParty = {
      nip: b.nip,
      name: b.name,
      address: {
        countryCode: b.address.countryCode,
        addressLine1: b.address.addressLine1,
        addressLine2: b.address.addressLine2,
      },
      email: b.email,
      jst: 2,
      gv: 2,
    };
  } else {
    buyerParty = {
      name: b.name,
      address: {
        countryCode: b.address.countryCode,
        addressLine1: b.address.addressLine1,
        addressLine2: b.address.addressLine2,
      },
      email: b.email,
      jst: 2,
      gv: 2,
    };
    if (b.idType === 'no_id') buyerParty.noIdMarker = true;
    else if (b.idType === 'pesel' && b.pesel) {
      buyerParty.nip = undefined;
      // PESEL konsument MVP: jako brak nip w FA - uproszczony marker
      buyerParty.noIdMarker = true;
    }
  }

  const method = mapPaymentMethodToFa(correctionEnvelope.paymentMethod);

  return {
    internalNumber: correctionEnvelope.internalNumber,
    type: 'KOR',
    issueDate: correctionEnvelope.issueDate,
    seller,
    buyer: buyerParty,
    lines,
    netTotal: totalsFromLines.netTotal,
    vatTotal: totalsFromLines.vatTotal,
    grossTotal: totalsFromLines.grossTotal,
    payment: {
      amountDue: totalsFromLines.grossTotal,
      currency: 'PLN',
      dueDate: correctionEnvelope.paymentDueDate,
      method,
      bankAccount: normalizeBankAccount(correctionEnvelope.bankAccount),
    },
    notes:
      correctionEnvelope.notes?.trim()?.length ?
        correctionEnvelope.notes.trim()
      : undefined,
  };
}

/**
 * Kolumny nabywcy w `invoices` — jak zwykła faktura (`buyerColumnsFromInvoiceForm`,
 * AUD-70): firma z UE to B2B typu `nip` z pustym `buyer_nip` (VARCHAR(10) na
 * polski NIP), a numer VAT-UE leży tylko w `buyer_data` / `fa3_data`.
 */
function buyerColumnsForCorrection(buyer: CorrectionBuyer): {
  is_b2c: boolean;
  buyer_id_type: 'nip' | 'pesel' | 'id_card' | 'passport' | 'no_id';
  buyer_nip: string | null;
} {
  if (buyer.type === 'eu') return { is_b2c: false, buyer_id_type: 'nip', buyer_nip: null };
  if (buyer.type === 'b2b') return { is_b2c: false, buyer_id_type: 'nip', buyer_nip: buyer.nip };
  return { is_b2c: true, buyer_id_type: buyer.idType, buyer_nip: null };
}

async function insertCorrection(
  supabase: SupabaseClient,
  tenantId: string,
  correctionEnvelope: CorrectionInvoiceData,
  lines: InvoiceLineItem[],
): Promise<CorrectionActionResult> {
  const ghost = ghostInvoice(correctionEnvelope, lines);
  const totals = calculateCorrectionTotals(correctionEnvelope);

  const { data: inserted, error } = await supabase
    .from('invoices')
    .insert({
      tenant_id: tenantId,
      direction: 'outgoing',
      ksef_status: 'draft',
      internal_number: ghost.internalNumber,
      invoice_kind: 'correction',
      invoice_type: 'KOR',
      issue_date: ghost.issueDate,
      parent_invoice_id: correctionEnvelope.parentInvoiceId,
      correction_reason: correctionEnvelope.correctionReason,
      correction_type: correctionEnvelope.correctionType,
      seller_nip: ghost.seller.nip,
      ...buyerColumnsForCorrection(correctionEnvelope.buyer),
      seller_data: correctionEnvelope.seller,
      buyer_data: ghost.buyer,
      payment_data: ghost.payment,
      payment_due_date: ghost.payment.dueDate,
      currency: 'PLN',
      // Sumy korekty = RÓŻNICA dla każdego typu (AUD-21, decyzja z 02.10.2026),
      // spójnie z P_13/P_15 w FA(3) KOR. KPiR, CSV i pulpit sumują `net_total`
      // faktur sprzedaży — z różnicą liczą przychód poprawnie bez wyjątków.
      net_total: roundToCents(totals.netDelta),
      vat_total: roundToCents(totals.vatDelta),
      gross_total: roundToCents(totals.grossDelta),
      notes: correctionEnvelope.notes ?? null,
      fa3_data: ghost,
      // A4b (00137): koperta zdarzenia wysyłki — ponowienie odtworzy z niej korektę.
      special_data: correctionSpecialData(correctionEnvelope),
    })
    .select('id')
    .single();

  if (error || !inserted) {
    return {
      success: false,
      error: specialDataInsertError(error, `korekty ${ghost.internalNumber}`)
        ?? error?.message ?? 'Nie udało się zapisać korekty',
    };
  }

  const invoiceId = inserted.id as string;

  const insLines = lines.map((line) => ({
    invoice_id: invoiceId,
    ordinal: line.ordinal,
    name: line.name,
    unit: line.unit,
    quantity: line.quantity,
    unit_price_net: line.unitPriceNet,
    net_amount: line.netAmount,
    vat_rate: line.vatRate,
    vat_amount: line.vatAmount,
    gross_amount: line.grossAmount,
  }));

  const { error: linesErr } = await supabase.from('invoice_line_items').insert(insLines);
  if (linesErr) {
    await supabase.from('invoices').delete().eq('id', invoiceId);
    return { success: false, error: `Błąd zapisu pozycji korekty: ${linesErr.message}` };
  }

  return { success: true, invoiceId };
}

async function readAcceptedCorrectionParent(
  supabase: SupabaseClient,
  tenantId: string,
  parentId: string,
) {
  const environment = requireConfiguredKsefEnvironment();
  const { data: row, error } = await supabase
    .from('invoices')
    .select('id, tenant_id, issue_date, internal_number, ksef_number, net_total, vat_total, gross_total, seller_data, buyer_data')
    .eq('id', parentId)
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('invoice_kind', 'regular')
    .eq('ksef_status', 'accepted')
    .eq('ksef_environment', environment)
    .maybeSingle();

  if (error || !row?.id || !row.ksef_number?.trim()) {
    throw new Error('Faktura pierwotna nie ma potwierdzonego numeru KSeF w bieżącym środowisku tej firmy.');
  }
  // K4 — łańcuch korekt: kolejna korekta liczy różnicę od stanu PO
  // poprzednich przyjętych korektach, a druga korekta w toku jest
  // niedozwolona (ta sama reguła w wyzwalaczu 00133/00135).
  const corrections = await listCorrectionsOf(supabase, tenantId, parentId);
  const open = corrections.find((c) => isInFlightCorrection(c.ksef_status));
  if (open) {
    throw new Error(openCorrectionMessage(row.internal_number as string | null, open));
  }
  const baseline = await correctionBaseline(supabase, row, corrections);
  return { parent: row, baseline };
}

interface CorrectionRow extends OpenCorrectionRef {
  id: string;
  correction_type: string | null;
  ksef_accepted_at: string | null;
  created_at: string | null;
  net_total: unknown;
  vat_total: unknown;
  gross_total: unknown;
}

/** Korekta w drodze do KSeF albo po nieudanej wysyłce — blokuje kolejną; przyjęta i odrzucona nie. */
function isInFlightCorrection(status: string | null): boolean {
  return status !== 'accepted' && status !== 'rejected';
}

async function listCorrectionsOf(
  supabase: SupabaseClient,
  tenantId: string,
  parentId: string,
): Promise<CorrectionRow[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, internal_number, ksef_status, correction_type, ksef_accepted_at, created_at, net_total, vat_total, gross_total')
    .eq('tenant_id', tenantId)
    .eq('parent_invoice_id', parentId)
    .eq('invoice_kind', 'correction');
  if (error) throw new Error('Nie można sprawdzić wcześniejszych korekt faktury pierwotnej.');
  return (Array.isArray(data) ? data : data ? [data] : []) as CorrectionRow[];
}

/**
 * Stan faktury PO przyjętych korektach (łańcuch korekt, K4):
 *   - sumy = sumy pierwotne + różnice przyjętych korekt (wiersz korekty
 *     przechowuje różnicę — AUD-21),
 *   - pozycje = pozycje ostatniej przyjętej korekty „przed/po” (jej wiersze
 *     to stan po), a bez takiej korekty — pozycje pierwotne,
 *   - po korekcie kwotowej stan pozycji nie jest jednoznaczny: wolno tylko
 *     kolejną korektę kwotową; po anulowaniu nie ma już czego korygować.
 * Każda niezgodność sum z pozycjami kończy się odmową — nie zgadujemy.
 */
type CorrectionBaseline = CorrectionBaselineOf<CorrectionLineSchema>;

function linesTotals(lines: CorrectionLineSchema[]) {
  return calculateInvoiceTotals(lines.map((line, index) => ({ ...line, ordinal: index + 1, ...calculateLineItem(line) })));
}

async function correctionBaseline(
  supabase: SupabaseClient,
  parent: { id: string; internal_number: string | null; net_total: unknown; vat_total: unknown; gross_total: unknown },
  corrections: CorrectionRow[],
): Promise<CorrectionBaseline> {
  const original = await fetchParentInvoiceLines(supabase, parent.id);
  const storedRaw = [parent.net_total, parent.vat_total, parent.gross_total];
  const stored = storedRaw.map(Number);
  const originalTotals = linesTotals(original);
  if (storedRaw.some((amount) => amount == null) ||
      stored.some((amount) => !Number.isFinite(amount)) ||
      roundToCents(stored[0]!) !== originalTotals.netTotal ||
      roundToCents(stored[1]!) !== originalTotals.vatTotal ||
      roundToCents(stored[2]!) !== originalTotals.grossTotal) {
    throw new Error('Pozycje faktury pierwotnej nie zgadzają się z zaakceptowaną kwotą; wymagane ręczne uzgodnienie.');
  }

  const accepted = corrections
    .filter((c) => c.ksef_status === 'accepted')
    .sort((a, b) => String(a.ksef_accepted_at ?? a.created_at ?? '').localeCompare(String(b.ksef_accepted_at ?? b.created_at ?? '')));
  let net = originalTotals.netTotal;
  let vat = originalTotals.vatTotal;
  let gross = originalTotals.grossTotal;
  for (const c of accepted) {
    const deltas = [c.net_total, c.vat_total, c.gross_total].map(Number);
    if (deltas.some((d) => !Number.isFinite(d))) {
      throw new Error(`Przyjęta korekta ${c.internal_number ?? ''} nie ma zapisanych kwot różnicy; wymagane ręczne uzgodnienie.`);
    }
    net = roundToCents(net + deltas[0]!);
    vat = roundToCents(vat + deltas[1]!);
    gross = roundToCents(gross + deltas[2]!);
  }
  const totals = { net, vat, gross };
  const last = accepted.at(-1);
  if (!last) return { lines: original, totals, latest: null, allowed: 'all' };
  const latest = { id: last.id, internalNumber: last.internal_number, correctionType: last.correction_type };
  if (last.correction_type === 'cancellation') return { lines: [], totals, latest, allowed: 'none' };
  if (last.correction_type !== 'before_after') return { lines: original, totals, latest, allowed: 'amount_change_only' };

  const after = await fetchParentInvoiceLines(supabase, last.id);
  const afterTotals = linesTotals(after);
  if (afterTotals.netTotal !== totals.net || afterTotals.vatTotal !== totals.vat || afterTotals.grossTotal !== totals.gross) {
    throw new Error(`Stan po korekcie ${last.internal_number ?? ''} nie zgadza się z sumami faktury i jej korekt; wymagane ręczne uzgodnienie.`);
  }
  return { lines: after, totals, latest, allowed: 'all' };
}



async function normalizePayload(
  supabase: SupabaseClient,
  tenant: TenantSnap,
  raw: CorrectionInvoiceSchemaIn,
): Promise<CorrectionInvoiceSchemaIn | { error: string }> {
  const parsed = correctionInvoiceSchema.safeParse(raw);
  if (!parsed.success) return { error: zodIssuesMessage(parsed.error) };

  // Server Actions can be invoked without the form. Never trust parent identifiers
  // or invoice metadata supplied by the browser when building a legal KSeF XML.
  const { parent, baseline } = await readAcceptedCorrectionParent(supabase, tenant.id, parsed.data.parentInvoiceId);
  const parentNumber = parent.internal_number as string | null;
  const parentIssueDate = parent.issue_date as string | null;
  const parentKsefNumber = (parent.ksef_number as string | null) ?? null;
  const seller = parent.seller_data as SellerParty | null;
  const compactNip = (nip: string) => nip.replace(/\s+/g, '');
  if (!parentNumber || !parentIssueDate || !parentKsefNumber?.trim() ||
      parsed.data.parentInvoiceNumber !== parentNumber ||
      parsed.data.parentInvoiceIssueDate !== parentIssueDate ||
      (parsed.data.parentKsefNumber?.trim() || null) !== parentKsefNumber ||
      !seller?.nip ||
      compactNip(seller.nip) !== compactNip(tenant.nip) ||
      compactNip(parsed.data.seller.nip) !== compactNip(seller.nip)) {
    return { error: 'Dane faktury pierwotnej zmieniły się lub nie należą do tej firmy. Wybierz ją ponownie.' };
  }

  // MVP corrections change amounts or lines, never the legal buyer identity —
  // ani typu nabywcy (firma z NIP / firma z UE z numerem VAT-UE, AUD-70).
  const originalBuyer = parent.buyer_data as BuyerParty | null;
  if (!originalBuyer) {
    return { error: 'Korekta wymaga zweryfikowanego nabywcy faktury pierwotnej.' };
  }
  let authoritativeBuyer: BuyerB2B | BuyerEU;
  try {
    authoritativeBuyer = buyerDataFromParty(originalBuyer);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Korekta wymaga zweryfikowanego nabywcy faktury pierwotnej.' };
  }
  if (!sameBuyerAsParent(parsed.data.buyer, authoritativeBuyer)) {
    return { error: 'Korekta musi wskazywać nabywcę zaakceptowanej faktury pierwotnej.' };
  }

  // K4 — łańcuch korekt: po anulowaniu nic, po korekcie kwotowej tylko kwotowa.
  const notAllowed = correctionNotAllowedMessage(parentNumber, baseline, parsed.data.correctionType);
  if (notAllowed) return { error: notAllowed };

  let linesBefore = parsed.data.linesBefore;
  if (parsed.data.correctionType === 'cancellation' ||
      parsed.data.correctionType === 'before_after') {
    // Stan przed = stan PO poprzednich przyjętych korektach (K4), z bazy,
    // nie z formularza. Sumy pierwotne i łańcuch sprawdza `correctionBaseline`.
    const current = baseline.lines;
    const supplied = parsed.data.linesBefore;
    if (supplied?.length && (
      supplied.length !== current.length ||
      supplied.some((line, index) => {
        const source = current[index]!;
        return line.name !== source.name || line.unit !== source.unit ||
          line.quantity !== source.quantity || line.unitPriceNet !== source.unitPriceNet ||
          line.vatRate !== source.vatRate;
      })
    )) {
      return {
        error: baseline.latest
          ? `Korekta musi odzwierciedlać stan pozycji po korekcie ${baseline.latest.internalNumber ?? ''}. Wybierz fakturę ponownie.`
          : 'Korekta musi odzwierciedlać pozycje zaakceptowanej faktury pierwotnej.',
      };
    }
    linesBefore = current;
  }

  let amountChange = parsed.data.amountChange;
  if (parsed.data.correctionType === 'amount_change' && amountChange) {
    // Stawka bez VAT (np I / np II / oo) nie wynika z kwot — wyznacza ją serwer
    // z pozycji faktury (stan bieżący). Inna wartość od klienta = odrzucenie.
    const original = baseline.lines;
    // Stan przed = pozycje z bazy, nie z formularza — generator liczy z nich
    // adnotację P_18 (oo / np. II).
    linesBefore = original;
    const parentRate = zeroVatRateFromParentLines(original);
    const { vatRate: suppliedRate, ...amounts } = amountChange;
    if (suppliedRate !== undefined && suppliedRate !== parentRate) {
      return { error: 'Stawka korekty kwotowej różni się od stawki faktury pierwotnej. Wybierz fakturę ponownie.' };
    }
    amountChange = parentRate ? { ...amounts, vatRate: parentRate } : amounts;
    let rate: ReturnType<typeof resolveAmountChangeVatRate>;
    try {
      rate = resolveAmountChangeVatRate(amountChange);
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Korekta kwotowa: niespójne kwoty.' };
    }
    // VAT 0 przy fakturze z różnymi stawkami, w tym bez VAT: z kwot wyszłoby
    // „0 KR”, a korekta może dotyczyć pozycji np I / np II / oo — nie zgadujemy.
    if (!parentRate && rate === '0' && original.some((line) => ZERO_VAT_RATES.has(line.vatRate))) {
      return {
        error: 'Korekta kwotowa bez VAT faktury z różnymi stawkami (w tym np., np. II lub oo) jest niejednoznaczna — skoryguj pozycje („przed / po”).',
      };
    }
  }

  const normalized: CorrectionInvoiceSchemaIn = {
    ...parsed.data,
    linesBefore,
    amountChange,
    buyer: authoritativeBuyer,
    parentInvoiceNumber: parentNumber,
    parentInvoiceIssueDate: parentIssueDate,
    parentKsefNumber: parentKsefNumber ?? undefined,
  };
  // np. II tylko dla firmy z innego kraju UE (bez XI) — także dla pozycji z bazy
  // i stawki wyznaczonej przez serwer, nie tylko danych z formularza.
  const npIiError = correctionNpIiBuyerError(normalized);
  if (npIiError) return { error: npIiError };
  return normalized;
}

export async function getCorrectionParentContextAction(parentId: string): Promise<
  | {
      success: true;
      issueDate: string;
      internalNumber: string | null;
      ksefNumber: string | null;
      grossTotal: number | null;
      seller: CorrectionInvoiceSchemaIn['seller'];
      buyer: CorrectionInvoiceSchemaIn['buyer'];
      /** Numer VAT-UE nabywcy z UE (postać kanoniczna, np. `DE123456789`); brak dla firmy z NIP. */
      buyerVatUe?: string;
      /** Czy w korekcie wolno użyć stawki „np. II” (nabywca z UE poza PL i XI — `isNpIiBuyerVat`). */
      npIiAllowed: boolean;
      /** Stawka bez VAT korekty kwotowej — wspólna stawka np / np_ii / oo pozycji faktury pierwotnej. */
      amountChangeVatRate?: ZeroVatAmountChangeRate;
      /** Ostatnia przyjęta korekta tej faktury (K4): „stan przed” to stan po niej. */
      previousCorrection?: { internalNumber: string | null; correctionType: string | null };
      /** Po korekcie kwotowej tylko kwotowa; po anulowaniu kontekst kończy się błędem. */
      allowedCorrectionTypes: 'all' | 'amount_change_only' | 'none';
      linesBefore: NonNullable<CorrectionInvoiceSchemaIn['linesBefore']>;
      linesAfter: NonNullable<CorrectionInvoiceSchemaIn['linesAfter']>;
    }
  | { success: false; error: string }
> {
  try {
    const { supabase, tenant } = await tenantContext();

    const { parent: row, baseline } = await readAcceptedCorrectionParent(supabase, tenant.id, parentId);
    if (baseline.allowed === 'none') {
      return { success: false, error: correctionNotAllowedMessage(row.internal_number as string | null, baseline, 'before_after')! };
    }

    const sellerRow = row.seller_data as SellerParty | null;
    const buyerRow = row.buyer_data as BuyerParty | null;
    if (!sellerRow || !buyerRow)
      return { success: false, error: 'Niepełne dane pierwotnej (sprzedawca / nabywca).' };

    const buyer = buyerDataFromParty(buyerRow);
    // K4: stan PO poprzednich przyjętych korektach — to od niego liczy się różnicę.
    const linesRaw = baseline.lines;
    // Pozycje np. II dla nabywcy, który ich mieć nie może (np. XI) — każda
    // korekta i tak zostałaby odrzucona; mówimy o tym od razu.
    const npIiError = correctionNpIiBuyerError({ buyer, linesBefore: linesRaw });
    if (npIiError) return { success: false, error: npIiError };
    const buyerVatUe = buyer.type === 'eu' ? buyer.vatUeNumber : undefined;
    const amountChangeVatRate = zeroVatRateFromParentLines(linesRaw);

    return {
      success: true,
      issueDate: row.issue_date as string,
      internalNumber: row.internal_number,
      ksefNumber: row.ksef_number,
      grossTotal: baseline.totals.gross,
      previousCorrection: baseline.latest ? { internalNumber: baseline.latest.internalNumber, correctionType: baseline.latest.correctionType } : undefined,
      allowedCorrectionTypes: baseline.allowed,
      seller: sellerDataFromParty(sellerRow) as CorrectionInvoiceSchemaIn['seller'],
      buyer: buyer as CorrectionInvoiceSchemaIn['buyer'],
      ...(buyerVatUe ? { buyerVatUe } : {}),
      npIiAllowed: isNpIiBuyerVat(buyerVatUe),
      ...(amountChangeVatRate ? { amountChangeVatRate } : {}),
      linesBefore: linesRaw,
      linesAfter: structuredClone(linesRaw),
    };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * `expectedTenantId` — firma, dla której strona wyrenderowała formularz
 * (UX-01); tylko do porównania z firmą z ciasteczka. Także w wysyłce.
 */
export async function saveCorrectionDraftAction(
  raw: CorrectionInvoiceSchemaIn,
  expectedTenantId: string,
): Promise<CorrectionActionResult> {
  try {
    const { supabase, tenant, userId } = await tenantContext({ expectedTenantId });
    const normalized = await normalizePayload(supabase, tenant, raw);
    if ('error' in normalized && typeof normalized.error === 'string') {
      return { success: false, error: normalized.error };
    }
    const envelope = buildCorrectionEnvelope(normalized as CorrectionInvoiceSchemaIn);
    // P_16/P_18A z faktury pierwotnej (AUD-23) — zapis i wysyłka mają te same.
    envelope.annotations = await loadParentAnnotations(supabase, tenant.id, envelope.parentInvoiceId);
    const lines = linesToStoredItems(envelope);

    const result = await insertCorrection(supabase, tenant.id, envelope, lines);
    if (result.success) {
      await logAudit({
        action: 'invoice.draft_created',
        tenantId: tenant.id,
        userId,
        entityType: 'invoice',
        entityId: result.invoiceId,
        metadata: { kind: 'correction', internalNumber: envelope.internalNumber },
      });
      revalidatePath('/invoices');
    }
    return result;
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : 'Nieznany błąd' };
  }
}

export async function saveAndSendCorrectionAction(
  raw: CorrectionInvoiceSchemaIn,
  expectedTenantId: string,
): Promise<CorrectionActionResult> {
  try {
    // Original XML and the cumulative state after earlier KOR are not yet
    // independently proven. A draft is allowed; legal PROD submit is not.
    if (requireConfiguredKsefEnvironment() === 'production') {
      return {
        success: false,
        error: 'Wysyłka korekt w PROD jest wstrzymana do uzgodnienia oryginału i wcześniejszych korekt. Możesz zapisać szkic.',
      };
    }
    const { supabase, tenant, userId } = await tenantContext({ expectedTenantId });
    const normalized = await normalizePayload(supabase, tenant, raw);
    if ('error' in normalized && typeof normalized.error === 'string') {
      return { success: false, error: normalized.error };
    }
    const envelope = buildCorrectionEnvelope(normalized as CorrectionInvoiceSchemaIn);
    // P_16/P_18A z faktury pierwotnej (AUD-23) — zapis i wysyłka mają te same.
    envelope.annotations = await loadParentAnnotations(supabase, tenant.id, envelope.parentInvoiceId);
    const lines = linesToStoredItems(envelope);
    const ghost = ghostInvoice(envelope, lines);

    // Ta sama reguła co zwykła faktura (A1, W5): w KSeF tylko z dzisiejszą datą
    // wystawienia — odmowa przed zapisem i przed zleceniem wysyłki.
    const notToday = issueDateNotTodayError(ghost.issueDate, 'special');
    if (notToday) return { success: false, error: notToday };

    const saved = await insertCorrection(supabase, tenant.id, envelope, lines);
    if (!saved.success) return saved;

    const invoiceId = saved.invoiceId;

    const enq = await enqueueKsefSubmitAfterDraft({
      supabase,
      tenantId: tenant.id,
      userId,
      invoiceId,
      nip: tenant.nip,
      invoice: ghost,
      correctionData: envelope,
      auditKind: 'correction',
      internalNumberForAudit: envelope.internalNumber,
    });

    if (!enq.ok) {
      return { success: false, error: enq.error, invoiceId };
    }

    return {
      success: true,
      invoiceId,
      offline: false,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? formatJobSendError(e) : 'Nieznany błąd wysyłki',
    };
  }
}
