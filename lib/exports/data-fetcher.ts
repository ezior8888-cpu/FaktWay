// lib/exports/data-fetcher.ts
// Pobieranie danych z DB do eksportów (uniform interface)

import { fetchAdvanceSettlementRows } from '@/lib/invoices/advance-settlement';
import {
  assertKsefExpensesReadyForPln,
  type KsefExpenseForPlnReport,
} from '@/lib/expenses/ksef-currency-review';
import { fetchSettledAdvancesNet } from '@/lib/invoices/settled-advances';
import { parseVatUe } from '@/lib/invoices/vat-ue';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { assertAcceptedInvoiceEnvironmentComplete } from '@/lib/ksef/accounting-provenance';
import { filterExpensesForKsefEnvironment } from '@/lib/expenses/ksef-environment';
import { readCompletePages } from '@/lib/accounting/read-complete-pages';
import type { KsefEnvironment } from '@/types/ksef';
import type { Database, Json } from '@/types/database';

import type { JpkFaInputData, JpkInvoice, JpkInvoiceLine } from './jpk-fa-generator';
import { jpkAnnotationsFromJson, type Fa3Markers } from '@/lib/xml/fa3-annotations';
import type { KsefLineFields } from '@/lib/import/fa3-line-amounts';

type InvoiceRow = Database['public']['Tables']['invoices']['Row'];
type LineItemRow = Database['public']['Tables']['invoice_line_items']['Row'];

export interface FetchInvoicesParams {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  direction: 'issued' | 'received' | 'both';
  includeCorrections?: boolean;
  /** KPiR/JPK_V7M need deductible costs even when received invoices are omitted. */
  includeExpenses?: boolean;
}

/**
 * Koszt w eksporcie — z `expenses`, tego samego źródła, z którego liczy KPiR
 * w aplikacji (`app/(dashboard)/reports/kpir`). Do 26.09 eksport brał koszty
 * z faktur otrzymanych: bez paragonów, wszystko w kol. 13, z naszą firmą jako
 * „kontrahentem” i bez decyzji klienta (`is_deductible`). Faktura ze skrzynki
 * istnieje jako faktura I jako koszt — koszty z jednego źródła, więc bez
 * podwójnego liczenia.
 */
export interface ExportExpense {
  id: string;
  issueDate: string;
  documentNumber: string;
  /** invoice | simplified_invoice | receipt | other */
  documentType: string;
  sellerName: string;
  sellerNip: string | null;
  sellerAddress: string | null;
  netAmount: number;
  vatAmount: number;
  grossAmount: number;
  /** VAT, który klient może odliczyć — nie zawsze cały `vatAmount`. */
  vatDeductibleAmount: number;
  /** col_10 | col_11 | col_12 | col_13 | col_15 (B+R w aplikacji) | … */
  kpirColumn: string | null;
  categoryLabel: string | null;
  /** Numer KSeF faktury, z której powstał koszt (skrzynka) — JPK_V7M(3) NrKSeF. */
  ksefNumber?: string | null;
}

export interface FetchedInvoiceData {
  issuer: JpkFaInputData['issuer'];
  issuedInvoices: JpkInvoice[];
  receivedInvoices: JpkInvoice[];
  /** Koszty do KPiR i JPK_V7M — tylko gdy eksport obejmuje stronę kosztów. */
  expenses: ExportExpense[];
}

export async function fetchInvoicesForExport(
  params: FetchInvoicesParams,
): Promise<FetchedInvoiceData> {
  const environment = requireConfiguredKsefEnvironment();
  const supabase = createAdminClient();

  const needIssued =
    params.direction === 'issued' || params.direction === 'both';
  const needReceived =
    params.direction === 'received' || params.direction === 'both';
  const needExpenses = params.includeExpenses ?? needReceived;

  await assertAcceptedInvoiceEnvironmentComplete(supabase, {
    tenantId: params.tenantId,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    direction: params.direction === 'issued' ? 'outgoing' :
      params.direction === 'received' ? 'incoming' : 'both',
    environment,
  });

  // Trzy zapytania niezależne od siebie — odpalane równolegle.
  // Wcześniej szły sekwencyjnie (tenant → issued → received), co dla okresu
  // miesięcznego dawało 3 round-tripy do Postgresa. Promise.all ścina to do 1.
  const [tenantResult, issuedRows, receivedRows] = await Promise.all([
    supabase
      .from('tenants')
      .select('nip, name, address_json')
      .eq('id', params.tenantId)
      .single(),
    needIssued
      ? fetchInvoiceRows(supabase, {
          tenantId: params.tenantId,
          environment,
          direction: 'issued',
          periodStart: params.periodStart,
          periodEnd: params.periodEnd,
          includeCorrections: params.includeCorrections,
        })
      : Promise.resolve<InvoiceRow[]>([]),
    needReceived
      ? fetchInvoiceRows(supabase, {
          tenantId: params.tenantId,
          environment,
          direction: 'received',
          periodStart: params.periodStart,
          periodEnd: params.periodEnd,
          includeCorrections: params.includeCorrections,
        })
      : Promise.resolve<InvoiceRow[]>([]),
  ]);

  if (tenantResult.error || !tenantResult.data) {
    throw new Error('Tenant not found');
  }

  const issuer: JpkFaInputData['issuer'] = {
    nip: tenantResult.data.nip ?? '',
    name: tenantResult.data.name ?? '',
    address: parseIssuerAddress(tenantResult.data.address_json),
  };

  // Mapowanie rows → JpkInvoice też idzie równolegle dla obu kierunków
  // (każde robi swoje SELECT-y na liniach + parentach).
  const [issuedInvoices, receivedInvoices, expenses, settledAdvances, advanceRows] = await Promise.all([
    mapRowsToJpkInvoices(supabase, issuedRows, params.tenantId, environment),
    mapRowsToJpkInvoices(supabase, receivedRows, params.tenantId, environment),
    needExpenses
      ? fetchExpensesForExport(supabase, params, environment)
      : Promise.resolve<ExportExpense[]>([]),
    fetchSettledAdvancesNet(supabase, params.tenantId, issuedRows),
    fetchAdvanceSettlementRows(supabase, params.tenantId, issuedRows),
  ]);

  // ROZ niesie pełną wartość zamówienia; KPiR odejmuje zaliczki, które już
  // policzył, a JPK_FA — jak faktura w KSeF — wykazuje kwoty po ich odjęciu.
  // `mapRowsToJpkInvoices` zachowuje kolejność wierszy.
  issuedRows.forEach((row, i) => {
    const settled = settledAdvances.get(row.id);
    if (settled !== undefined) issuedInvoices[i].settledAdvancesNet = settled;
    const rows = advanceRows.get(row.id);
    if (rows !== undefined) issuedInvoices[i].advanceSettlement = rows;
  });

  return { issuer, issuedInvoices, receivedInvoices, expenses };
}

/**
 * Koszty okresu, które klient uznał za koszt (`is_deductible`) — ten sam
 * filtr co KPiR w aplikacji. Czytane stronami: PostgREST ucina odpowiedź
 * na 1000 wierszach, a ucięta lista kosztów wyglądałaby na udany eksport.
 */
async function fetchExpensesForExport(
  supabase: ReturnType<typeof createAdminClient>,
  params: FetchInvoicesParams,
  environment: KsefEnvironment,
): Promise<ExportExpense[]> {
  const rows = await readCompletePages('expenses', (from, to) =>
    supabase
      .from('expenses')
      .select('id, source, ksef_invoice_id, issue_date, document_number, document_type, seller_name, seller_nip, seller_address, net_amount, vat_amount, gross_amount, vat_deductible_amount, kpir_column, category_label, is_reviewed, ocr_extracted_data', { count: 'exact' })
      .eq('tenant_id', params.tenantId)
      .eq('is_deductible', true)
      .gte('issue_date', params.periodStart)
      .lte('issue_date', params.periodEnd)
      .order('id', { ascending: true })
      .range(from, to),
  );

  const eligible = await filterExpensesForKsefEnvironment(
    supabase,
    params.tenantId,
    environment,
    rows,
  );
  eligible.sort((a, b) =>
    a.issue_date.localeCompare(b.issue_date) || a.id.localeCompare(b.id));
  const out = eligible.map((row) => ({
    id: String(row.id),
    issueDate: String(row.issue_date),
    documentNumber: typeof row.document_number === 'string' ? row.document_number : '',
    documentType: typeof row.document_type === 'string' ? row.document_type : 'invoice',
    sellerName: typeof row.seller_name === 'string' ? row.seller_name : '',
    sellerNip: typeof row.seller_nip === 'string' && row.seller_nip.trim() ? row.seller_nip.trim() : null,
    sellerAddress: typeof row.seller_address === 'string' ? row.seller_address : null,
    netAmount: Number(row.net_amount ?? 0),
    vatAmount: Number(row.vat_amount ?? 0),
    grossAmount: Number(row.gross_amount ?? 0),
    vatDeductibleAmount: Number(row.vat_deductible_amount ?? 0),
    kpirColumn: typeof row.kpir_column === 'string' ? row.kpir_column : null,
    categoryLabel: typeof row.category_label === 'string' ? row.category_label : null,
  }));
  /** Only the reconciled costs may contribute a NrKSeF to the exported file. */
  const linked = new Map<string, string>();
  for (const row of eligible) {
    if (typeof row.ksef_invoice_id === 'string') {
      linked.set(String(row.id), row.ksef_invoice_id);
    }
  }
  // C-11: koszt KSeF w walucie obcej trafia do pliku tylko po przeglądzie
  // i ze śladem kursu — inaczej eksport się zatrzymuje.
  const currencyRows: KsefExpenseForPlnReport[] = eligible.map((row) => ({
    source: typeof row.source === 'string' ? row.source : null,
    ksef_invoice_id: typeof row.ksef_invoice_id === 'string' ? row.ksef_invoice_id : null,
    issue_date: String(row.issue_date),
    is_reviewed: row.is_reviewed === true,
    ocr_extracted_data: (row.ocr_extracted_data ?? null) as Json,
  }));
  await assertKsefExpensesReadyForPln(currencyRows, async (ids) => {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, currency')
      .eq('tenant_id', params.tenantId)
      .in('id', ids);
    if (error) throw new Error('Nie można sprawdzić walut faktur KSeF w eksporcie');
    return new Map((data ?? []).map((row) => [row.id, row.currency]));
  });
  await attachKsefNumbers(supabase, params.tenantId, out, linked);
  return out;
}

const KSEF_LOOKUP_CHUNK = 200;

/**
 * Numer KSeF faktury, z której powstał koszt (skrzynka) — JPK_V7M(3) wymaga
 * go w wierszu zakupu (NrKSeF), inaczej BFK. Osobne zapytanie zamiast
 * osadzenia: między `expenses` a `invoices` jest więcej niż jeden klucz obcy.
 */
export async function attachKsefNumbers(
  supabase: ReturnType<typeof createAdminClient>,
  tenantId: string,
  expenses: ExportExpense[],
  linked: ReadonlyMap<string, string>,
): Promise<void> {
  const invoiceIds = [...new Set(linked.values())];
  const numbers = new Map<string, string>();
  for (let i = 0; i < invoiceIds.length; i += KSEF_LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, ksef_number')
      .eq('tenant_id', tenantId)
      .in('id', invoiceIds.slice(i, i + KSEF_LOOKUP_CHUNK));
    // Błąd to nie „brak numeru” — inaczej plik po cichu dostałby BFK.
    if (error) throw new Error(`invoices (numery KSeF kosztów): ${error.message}`);
    for (const row of (data ?? []) as Array<{ id: string; ksef_number: string | null }>) {
      if (row.ksef_number?.trim()) numbers.set(row.id, row.ksef_number.trim());
    }
  }
  for (const expense of expenses) {
    const invoiceId = linked.get(expense.id);
    expense.ksefNumber = invoiceId ? (numbers.get(invoiceId) ?? null) : null;
  }
}

async function fetchInvoiceRows(
  supabase: ReturnType<typeof createAdminClient>,
  params: {
    tenantId: string;
    environment: KsefEnvironment;
    direction: 'issued' | 'received';
    periodStart: string;
    periodEnd: string;
    includeCorrections?: boolean;
  },
): Promise<InvoiceRow[]> {
  const rows = await readCompletePages('invoices', (from, to) => {
    let query = supabase
      .from('invoices')
      .select('*', { count: 'exact' })
      .eq('tenant_id', params.tenantId)
      .eq('direction', params.direction === 'issued' ? 'outgoing' : 'incoming')
      .eq('ksef_status', 'accepted')
      .eq('ksef_environment', params.environment)
      .gte('issue_date', params.periodStart)
      .lte('issue_date', params.periodEnd)
      .order('id', { ascending: true });

    if (params.includeCorrections === false) {
      query = query.eq('invoice_kind', 'regular');
    }
    return query.range(from, to);
  });
  return rows.sort((a, b) =>
    a.issue_date.localeCompare(b.issue_date) || a.id.localeCompare(b.id));
}

// ============================================================================
// Mapping: DB rows → JpkInvoice
// ============================================================================

async function mapRowsToJpkInvoices(
  supabase: ReturnType<typeof createAdminClient>,
  rows: InvoiceRow[],
  tenantId: string,
  environment: KsefEnvironment,
): Promise<JpkInvoice[]> {
  if (rows.length === 0) return [];

  // Parents (numery faktur korygowanych) i linie pozycji są niezależne —
  // jeden SELECT po `invoices`, drugi po `invoice_line_items`. Promise.all
  // ścina latencję per direction o ~50% przy paczkach miesięcznych.
  const [parentNumberById, linesByInvoiceId] = await Promise.all([
    fetchParentInvoiceNumbers(supabase, rows, tenantId, environment),
    resolveLinesForInvoices(supabase, rows),
  ]);

  return rows.map((row) =>
    mapInvoiceRow(row, linesByInvoiceId.get(row.id) ?? [], parentNumberById),
  );
}

async function fetchParentInvoiceNumbers(
  supabase: ReturnType<typeof createAdminClient>,
  rows: InvoiceRow[],
  tenantId: string,
  environment: KsefEnvironment,
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      rows
        .map((r) => r.parent_invoice_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  const map = new Map<string, string>();
  if (ids.length === 0) return map;

  // Bound the IN-list as well as the response; corrections can reference
  // parents outside the exported period.
  for (let from = 0; from < ids.length; from += 100) {
    const batch = ids.slice(from, from + 100);
    const { data, count, error } = await supabase
      .from('invoices')
      .select('id, internal_number, ksef_number', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('direction', rows[0]!.direction)
      .eq('ksef_status', 'accepted')
      .eq('ksef_environment', environment)
      .in('id', batch);
    if (error) throw new Error(error.message);
    if (!data || count !== batch.length || data.length !== batch.length) {
      throw new Error('Linked invoice not found in organization');
    }
    for (const p of data) {
      if (!batch.includes(p.id)) throw new Error('Linked invoice not found in organization');
      map.set(p.id, p.internal_number ?? p.ksef_number ?? '');
    }
  }
  // A parent UUID is writable invoice data, not proof of ownership.
  // Missing/foreign parents must not produce an incomplete accounting export.
  if (map.size !== ids.length) {
    throw new Error('Linked invoice not found in organization');
  }
  return map;
}

async function resolveLinesForInvoices(
  supabase: ReturnType<typeof createAdminClient>,
  rows: InvoiceRow[],
): Promise<Map<string, JpkInvoiceLine[]>> {
  const byId = new Map<string, JpkInvoiceLine[]>();
  const missingIds: string[] = [];

  for (const row of rows) {
    const fromFa = linesFromFa3Data(row.fa3_data);
    if (fromFa.length > 0) {
      byId.set(row.id, fromFa);
    } else {
      missingIds.push(row.id);
    }
  }

  if (missingIds.length > 0) {
    const grouped = new Map<string, LineItemRow[]>();
    for (let from = 0; from < missingIds.length; from += 100) {
      const batch = missingIds.slice(from, from + 100);
      const dbLines = await readCompletePages('invoice_line_items', (pageFrom, pageTo) =>
        supabase
          .from('invoice_line_items')
          .select(
            // vat_amount: VAT pozycji z tabeli, nie przeliczany (main).
            'id, invoice_id, ordinal, name, unit, quantity, unit_price_net, net_amount, vat_rate, vat_amount',
            { count: 'exact' },
          )
          .in('invoice_id', batch)
          .order('id', { ascending: true })
          .range(pageFrom, pageTo),
      );
      dbLines.sort((a, b) =>
        a.invoice_id.localeCompare(b.invoice_id) ||
        a.ordinal - b.ordinal || a.id.localeCompare(b.id));
      for (const item of dbLines) {
        if (!batch.includes(item.invoice_id)) throw new Error('Invoice line belongs to another invoice');
        const list = grouped.get(item.invoice_id) ?? [];
        list.push(item as LineItemRow);
        grouped.set(item.invoice_id, list);
      }
    }

    for (const id of missingIds) {
      const list = grouped.get(id) ?? [];
      byId.set(
        id,
        list.map((item) => mapDbLineItemToJpk(item)),
      );
    }
  }

  return byId;
}

function mapInvoiceRow(
  row: InvoiceRow,
  lines: JpkInvoiceLine[],
  parentNumberById: Map<string, string>,
): JpkInvoice {
  // Obie strony dokumentu. Faktury ze skrzynki KSeF nie mają `seller_data`
  // ani `buyer_data` — strony leżą w metadanych w `fa3_data` (seller:
  // { nip, name }, buyer: { identifier: { value }, name }).
  const fa3 = readBuyerDataJson(row.fa3_data) as Record<string, unknown>;
  const fa3Seller = readBuyerDataJson((fa3.seller ?? null) as Json | null);
  const fa3Buyer = (fa3.buyer ?? {}) as {
    name?: unknown;
    vatUeNumber?: unknown;
    identifier?: { type?: unknown; value?: unknown };
  };

  const buyerData = readBuyerDataJson(row.buyer_data);
  const nipFromJson =
    typeof buyerData.nip === 'string' ? buyerData.nip.trim() : undefined;
  // Metadane KSeF (import historii) mają typ identyfikatora: „VatUe” to numer
  // VAT-UE, nie NIP (AUD-70). Numer, którego nie da się rozebrać, zostaje
  // tam, gdzie był dotąd — w polu NIP.
  const fa3IdentifierVatUe =
    fa3Buyer.identifier?.type === 'VatUe' ? vatUeOf(fa3Buyer.identifier.value) : null;
  const fa3BuyerNip =
    !fa3IdentifierVatUe && typeof fa3Buyer.identifier?.value === 'string'
      ? fa3Buyer.identifier.value.trim()
      : undefined;
  const buyerNip = nipFromJson || row.buyer_nip?.trim() || fa3BuyerNip || undefined;
  // Nabywca z UE: `buyer_nip` NULL, numer w `buyer_data` (BuyerParty) albo
  // w kopii faktury w `fa3_data.buyer`. Tylko gdy nie ma NIP-u.
  const buyerVatUe = buyerNip
    ? undefined
    : (vatUeOf(buyerData.vatUeNumber) ?? vatUeOf(fa3Buyer.vatUeNumber) ?? fa3IdentifierVatUe)?.normalized;
  const buyerName =
    buyerData.name ?? (typeof fa3Buyer.name === 'string' ? fa3Buyer.name : '');

  const sellerData = readBuyerDataJson(row.seller_data);
  const sellerNip =
    (typeof sellerData.nip === 'string' ? sellerData.nip.trim() : '') ||
    row.seller_nip?.trim() ||
    (typeof fa3Seller.nip === 'string' ? fa3Seller.nip.trim() : '') ||
    undefined;
  const sellerName = sellerData.name ?? fa3Seller.name ?? '';
  const sellerAddress = formatBuyerAddress(sellerData) || undefined;

  let correctedNumber: string | undefined;
  if (row.invoice_kind === 'correction' && row.parent_invoice_id) {
    correctedNumber =
      parentNumberById.get(row.parent_invoice_id) ?? undefined;
  }

  // C5c: faktura z importu KSeF — pola pozycji z pliku (P_9B / P_11A…) dla JPK_FA.
  const attached = row.origin === 'ksef_import' ? attachKsefLineFields(lines, row.fa3_data) : { lines, problems: [] };
  const contentFlags = importedContentFlags(row.origin, row.fa3_data);
  const lineProblems = [...(contentFlags.importedLineAmountProblems ?? []), ...attached.problems];

  return {
    invoiceNumber: row.internal_number ?? row.ksef_number ?? '',
    currency: row.currency,
    invoiceType: mapInvoiceKind(row.invoice_kind),
    importedDocumentType: importedDocumentType(row),
    importedFromKsef: row.origin === 'ksef_import',
    issueDate: row.issue_date,
    saleDate: row.sale_date ?? row.issue_date,
    paymentDueDate: row.payment_due_date ?? undefined,

    buyerNip,
    buyerVatUe,
    buyerName,
    buyerAddress: formatBuyerAddress(buyerData),
    sellerNip,
    sellerName,
    sellerAddress,

    netTotal: Number(row.net_total ?? 0),
    vatTotal: Number(row.vat_total ?? 0),
    grossTotal: Number(row.gross_total ?? 0),

    lines: attached.lines,

    correctedInvoiceNumber: correctedNumber,
    correctionReason: row.correction_reason ?? undefined,
    ksefNumber: row.ksef_number ?? undefined,
    annotations: annotationsFromFa3(row.fa3_data),
    ...contentFlags,
    ...(lineProblems.length ? { importedLineAmountProblems: lineProblems } : {}),
  };
}

/** Adnotacje z `fa3_data.annotations` (#60, #75, #79; C5b: import KSeF) — JPK_FA: P_16–P_19C. */
export function annotationsFromFa3(fa3: Json | null): JpkInvoice['annotations'] {
  if (!fa3 || typeof fa3 !== 'object' || Array.isArray(fa3)) return undefined;
  return jpkAnnotationsFromJson((fa3 as Record<string, unknown>).annotations);
}

const isRecordJson = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * C5b: flagi treści z pliku KSeF dla `amountsOf` — wspólne dla pobierania
 * danych eksportu i gotowości paczki (`jpk-fa-readiness`). Przyjmuje
 * `fa3_data` albo jego pola wybrane aliasami.
 */
export function importedContentFlags(
  origin: string | null | undefined,
  fa3: unknown,
): Pick<JpkInvoice,
  'importedAnnotationsMissing' | 'importedAnnotationProblems' | 'importedSaleDateUnclear' | 'ksefMarkers' |
  'importedLineAmountProblems' | 'importedTotalsUnknown'> {
  const o = isRecordJson(fa3) ? fa3 : {};
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
  const problems = strings(o.annotationProblems);
  const lineProblems = strings(o.lineAmountProblems);
  const markers = isRecordJson(o.ksefMarkers) ? (o.ksefMarkers as Fa3Markers) : undefined;
  const saleDates = isRecordJson(o.saleDates) ? o.saleDates : undefined;
  return {
    ...(origin === 'ksef_import' && !isRecordJson(o.annotations) ? { importedAnnotationsMissing: true } : {}),
    ...(problems.length ? { importedAnnotationProblems: problems } : {}),
    ...(saleDates?.unclear === true ? { importedSaleDateUnclear: true } : {}),
    ...(markers ? { ksefMarkers: markers } : {}),
    // C5c: kwoty pozycji z pliku KSeF nieprzeniesione wiernie (ceny brutto, VAT od sumy stawki).
    ...(lineProblems.length ? { importedLineAmountProblems: lineProblems } : {}),
    ...(o.lineAmountTotalsUnknown === true ? { importedTotalsUnknown: true } : {}),
  };
}

/**
 * C5c: pola pozycji z pliku KSeF (`fa3_data.ksefLineFields`) do pozycji JPK
 * po numerze pozycji. Pozycja bez pary — powód zatrzymania (JPK nie zapisze
 * wyliczonego netto zamiast ceny brutto z pliku).
 */
export function attachKsefLineFields(
  lines: JpkInvoiceLine[],
  fa3: unknown,
): { lines: JpkInvoiceLine[]; problems: string[] } {
  const raw = isRecordJson(fa3) && Array.isArray(fa3.ksefLineFields) ? fa3.ksefLineFields : null;
  if (!raw) return { lines, problems: [] };
  const byOrdinal = new Map<number, Omit<KsefLineFields, 'ordinal'>>();
  for (const item of raw) {
    if (!isRecordJson(item) || typeof item.ordinal !== 'number') continue;
    const { ordinal, ...fields } = item as unknown as KsefLineFields;
    byOrdinal.set(ordinal, fields);
  }
  const problems: string[] = [];
  const out = lines.map((line) => {
    const fields = byOrdinal.get(line.position);
    if (!fields) problems.push(`pozycja ${line.position} bez pól z pliku KSeF`);
    return fields ? { ...line, ksefFields: fields } : line;
  });
  return { lines: out, problems };
}

/**
 * W9 (C5a): import historii KSeF zapisuje korektę, zaliczkę i ROZ jako
 * `invoice_kind = regular` (bez powiązań), a rodzaj z pliku zostaje
 * w `invoice_type`. JPK nie może ich policzyć jak zwykłej sprzedaży.
 */
function importedDocumentType(row: InvoiceRow): JpkInvoice['importedDocumentType'] {
  if (row.invoice_kind !== 'regular') return undefined;
  const type = (row.invoice_type ?? '').toUpperCase();
  return type === 'KOR' || type === 'ZAL' || type === 'ROZ' ? type : undefined;
}

function mapInvoiceKind(
  kind: InvoiceRow['invoice_kind'],
): JpkInvoice['invoiceType'] {
  switch (kind) {
    case 'correction':
      return 'correction';
    case 'advance':
      return 'advance';
    case 'final':
      return 'final';
    default:
      return 'regular';
  }
}

function mapDbLineItemToJpk(item: LineItemRow): JpkInvoiceLine {
  return {
    position: item.ordinal,
    name: item.name ?? '',
    unit: item.unit ?? 'szt.',
    quantity: Number(item.quantity ?? 1),
    unitPriceNet: Number(item.unit_price_net ?? 0),
    netAmount: Number(item.net_amount ?? 0),
    vatRate: String(item.vat_rate ?? '23'),
    vatAmount: item.vat_amount == null ? undefined : Number(item.vat_amount),
  };
}

function linesFromFa3Data(fa3: Json | null): JpkInvoiceLine[] {
  if (!fa3 || typeof fa3 !== 'object' || Array.isArray(fa3)) return [];
  const rawLines = (fa3 as Record<string, unknown>).lines;
  if (!Array.isArray(rawLines)) return [];

  const out: JpkInvoiceLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line || typeof line !== 'object' || Array.isArray(line)) continue;
    const o = line as Record<string, unknown>;
    out.push({
      position:
        typeof o.ordinal === 'number' && Number.isFinite(o.ordinal)
          ? o.ordinal
          : i + 1,
      name: typeof o.name === 'string' ? o.name : '',
      unit: typeof o.unit === 'string' ? o.unit : 'szt.',
      quantity:
        typeof o.quantity === 'number' && Number.isFinite(o.quantity)
          ? o.quantity
          : Number(o.quantity) || 1,
      unitPriceNet:
        typeof o.unitPriceNet === 'number' && Number.isFinite(o.unitPriceNet)
          ? o.unitPriceNet
          : Number(o.unitPriceNet) || 0,
      netAmount:
        typeof o.netAmount === 'number' && Number.isFinite(o.netAmount)
          ? o.netAmount
          : Number(o.netAmount) || 0,
      vatRate: String(o.vatRate ?? '23'),
      vatAmount:
        typeof o.vatAmount === 'number' && Number.isFinite(o.vatAmount) ? o.vatAmount : undefined,
    });
  }
  return out;
}

interface BuyerDataJson {
  name?: string;
  nip?: string;
  /** BuyerParty: numer VAT-UE z prefiksem kraju (nabywca z UE, AUD-70). */
  vatUeNumber?: unknown;
  address?: {
    addressLine1?: string;
    addressLine2?: string;
  };
  addressLine1?: string;
  addressLine2?: string;
}

function readBuyerDataJson(json: Json | null): BuyerDataJson {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return {};
  }
  return json as BuyerDataJson;
}

/** Numer VAT-UE z JSON-a — tylko poprawny (prefiks z listy UE, wzorzec FA(3)). */
function vatUeOf(value: unknown): ReturnType<typeof parseVatUe> {
  return typeof value === 'string' ? parseVatUe(value) : null;
}

// ============================================================================
// Helpers
// ============================================================================

function parseIssuerAddress(
  json: Json | null,
): JpkFaInputData['issuer']['address'] | undefined {
  if (!json) return undefined;

  if (typeof json === 'string') {
    const t = json.trim();
    return t ? { street: t, country: 'PL' } : undefined;
  }

  if (typeof json !== 'object' || Array.isArray(json)) return undefined;

  const a = json as Record<string, unknown>;
  const countryCode =
    typeof a.countryCode === 'string'
      ? a.countryCode.slice(0, 2).toUpperCase()
      : 'PL';
  const line1 =
    typeof a.addressLine1 === 'string' ? a.addressLine1 : undefined;
  const line2 =
    typeof a.addressLine2 === 'string' ? a.addressLine2 : undefined;

  let postCode: string | undefined;
  let city: string | undefined;
  if (line2) {
    const m = /^(\d{2}-\d{3})\s+(.+)$/.exec(line2.trim());
    if (m) {
      postCode = m[1];
      city = m[2].trim();
    } else {
      city = line2.trim();
    }
  }

  return {
    country: countryCode,
    street: line1,
    city,
    postCode,
  };
}

function formatBuyerAddress(buyerData: BuyerDataJson): string {
  const nested = buyerData.address;
  if (nested && (nested.addressLine1 || nested.addressLine2)) {
    return [nested.addressLine1, nested.addressLine2].filter(Boolean).join(', ');
  }
  if (buyerData.addressLine1 || buyerData.addressLine2) {
    return [buyerData.addressLine1, buyerData.addressLine2]
      .filter(Boolean)
      .join(', ');
  }
  return '';
}
