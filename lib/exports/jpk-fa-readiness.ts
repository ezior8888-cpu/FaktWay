/**
 * Czy JPK_FA za okres w ogóle powstanie — sprawdzane PRZED utworzeniem
 * eksportów paczki Co-Pilot. Jeden nieudany format wywraca całą paczkę
 * dla księgowej (`co-pilot-monthly.ts`), więc zamiast pliku, który odmówi,
 * paczka dostaje uniwersalny CSV (jak przy braku urzędu, #67).
 *
 * JPK_FA odmawia, gdy (`jpk-fa-generator.ts`):
 * - w okresie jest faktura korygująca (kwoty korekty w bazie — C-01),
 * - w okresie jest dokument z importu, którego JPK nie wykaże (W9): pozycja
 *   ze stawką spoza FaktWay albo zaimportowana korekta / zaliczka / ROZ,
 * - GUS nie zna adresu firmy z województwem, powiatem i gminą.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { MissingIssuerAddressError, readIssuerRegisteredAddress } from '@/lib/exports/issuer-address';
import { amountsOf, JpkFaCorrectionNotSupportedError, type JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { attachKsefLineFields, importedContentFlags } from '@/lib/exports/data-fetcher';
import { jpkAnnotationsFromJson } from '@/lib/xml/fa3-annotations';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { VAT_RATES } from '@/lib/xml/fa3-p12';

const PAGE = 1000;
const LINE_CHUNK = 200;

interface PeriodInvoice {
  id: string;
  internal_number: string | null;
  ksef_number: string | null;
  invoice_kind: string | null;
  invoice_type: string | null;
  origin: string | null;
  net_total: number | string | null;
  vat_total?: number | string | null;
  /** C5c: `fa3_data.lineAmountProblems` / `lineAmountTotalsUnknown` aliasami. */
  line_amount_problems?: unknown;
  line_amount_totals_unknown?: unknown;
  ksef_line_fields?: unknown;
  /** C5b: pola `fa3_data` aliasami (bez pozycji — na fakturach FaktWay `fa3_data` niesie wszystkie). */
  annotations?: unknown;
  annotation_problems?: unknown;
  sale_dates?: unknown;
  ksef_markers?: unknown;
}

interface PeriodLine {
  invoice_id: string;
  /** C5c: numer pozycji — para z `fa3_data.ksefLineFields` (jak eksport). */
  ordinal?: number | null;
  vat_rate: string | null;
  net_amount: number | string | null;
  /** C5c: VAT pozycji — kontrola co do grosza z VAT faktury (jak eksport). */
  vat_amount?: number | string | null;
}

/**
 * W9: pierwszy dokument okresu, którego JPK nie wykaże — powód tą samą
 * odmową co generator (`amountsOf`), więc paczka i plik mówią to samo.
 * Te same faktury co eksport: sprzedaż przyjęta w KSeF, w tym środowisku.
 * Faktury z importu sprawdzane z pozycjami (stawki i suma netto), pozostałe
 * — rodzaj i stawki spoza FaktWay.
 */
async function unsupportedDocumentReason(
  client: SupabaseClient,
  params: { tenantId: string; periodStart: string; periodEnd: string },
): Promise<string | null> {
  const environment = requireConfiguredKsefEnvironment();
  const invoices: PeriodInvoice[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('invoices')
      .select('id, internal_number, ksef_number, invoice_kind, invoice_type, origin, net_total, vat_total, annotations:fa3_data->annotations, annotation_problems:fa3_data->annotationProblems, sale_dates:fa3_data->saleDates, ksef_markers:fa3_data->ksefMarkers, line_amount_problems:fa3_data->lineAmountProblems, line_amount_totals_unknown:fa3_data->lineAmountTotalsUnknown, ksef_line_fields:fa3_data->ksefLineFields')
      .eq('tenant_id', params.tenantId)
      .eq('direction', 'outgoing')
      .eq('ksef_status', 'accepted')
      .eq('ksef_environment', environment)
      .gte('issue_date', params.periodStart)
      .lte('issue_date', params.periodEnd)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Nie można sprawdzić faktur okresu: ${error.message}`);
    const page = (data ?? []) as PeriodInvoice[];
    invoices.push(...page);
    if (page.length < PAGE) break;
  }

  const asJpk = (inv: PeriodInvoice, lines: readonly PeriodLine[] | null): JpkInvoice => {
    const type = (inv.invoice_type ?? '').toUpperCase();
    const jpkLines = (lines ?? []).map((l, i) => ({
      position: typeof l.ordinal === 'number' ? l.ordinal : i + 1, name: '', unit: '', quantity: 1, unitPriceNet: 0,
      netAmount: Number(l.net_amount ?? 0), vatRate: String(l.vat_rate ?? ''),
      ...(l.vat_amount == null ? {} : { vatAmount: Number(l.vat_amount) }),
    }));
    const contentFlags = importedContentFlags(inv.origin, {
      annotations: inv.annotations, annotationProblems: inv.annotation_problems,
      saleDates: inv.sale_dates, ksefMarkers: inv.ksef_markers,
      lineAmountProblems: inv.line_amount_problems, lineAmountTotalsUnknown: inv.line_amount_totals_unknown,
    });
    // C5c: pozycja bez pól z pliku KSeF — ta sama odmowa co eksport (`attachKsefLineFields`).
    const attached = lines !== null && inv.origin === 'ksef_import'
      ? attachKsefLineFields(jpkLines, { ksefLineFields: inv.ksef_line_fields })
      : { lines: jpkLines, problems: [] };
    const lineProblems = [...(contentFlags.importedLineAmountProblems ?? []), ...attached.problems];
    return {
      invoiceNumber: inv.internal_number ?? inv.ksef_number ?? '',
      ksefNumber: inv.ksef_number ?? undefined,
      invoiceType: 'regular',
      importedDocumentType: inv.invoice_kind === 'regular' && (type === 'KOR' || type === 'ZAL' || type === 'ROZ') ? type : undefined,
      importedFromKsef: lines !== null && inv.origin === 'ksef_import',
      // C5b: te same flagi treści co eksport (`data-fetcher`) — paczka i plik mówią to samo.
      annotations: jpkAnnotationsFromJson(inv.annotations),
      ...contentFlags,
      ...(lineProblems.length ? { importedLineAmountProblems: lineProblems } : {}),
      issueDate: params.periodStart,
      buyerName: '',
      netTotal: Number(inv.net_total ?? 0),
      vatTotal: Number(inv.vat_total ?? 0),
      grossTotal: 0,
      lines: attached.lines,
    };
  };
  const refusal = (inv: JpkInvoice): string | null => {
    try {
      amountsOf(inv);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : null;
    }
  };

  for (const inv of invoices) {
    const reason = refusal(asJpk(inv, null));
    if (reason) return reason;
  }

  // Faktury z importu: wszystkie pozycje (stawka i suma netto).
  const imported = invoices.filter((inv) => inv.origin === 'ksef_import');
  for (let i = 0; i < imported.length; i += LINE_CHUNK) {
    const chunk = imported.slice(i, i + LINE_CHUNK);
    const lines: PeriodLine[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await client
        .from('invoice_line_items')
        .select('invoice_id, ordinal, vat_rate, net_amount, vat_amount')
        .in('invoice_id', chunk.map((inv) => inv.id))
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`Nie można sprawdzić pozycji faktur z importu: ${error.message}`);
      const page = (data ?? []) as PeriodLine[];
      lines.push(...page);
      if (page.length < PAGE) break;
    }
    for (const inv of chunk) {
      const reason = refusal(asJpk(inv, lines.filter((l) => l.invoice_id === inv.id)));
      if (reason) return reason;
    }
  }

  // Pozostałe faktury: stawka spoza FaktWay w którejkolwiek pozycji.
  const others = invoices.filter((inv) => inv.origin !== 'ksef_import');
  const byId = new Map(others.map((inv) => [inv.id, inv]));
  const allowed = `(${VAT_RATES.map((r) => `"${r}"`).join(',')})`;
  for (let i = 0; i < others.length; i += LINE_CHUNK) {
    const { data, error } = await client
      .from('invoice_line_items')
      .select('invoice_id, vat_rate, net_amount')
      .in('invoice_id', others.slice(i, i + LINE_CHUNK).map((inv) => inv.id))
      .not('vat_rate', 'in', allowed)
      .limit(1);
    if (error) throw new Error(`Nie można sprawdzić stawek pozycji okresu: ${error.message}`);
    const line = (data ?? [])[0] as PeriodLine | undefined;
    const inv = line ? byId.get(line.invoice_id) : undefined;
    if (inv && line) {
      const reason = refusal(asJpk(inv, [line]));
      if (reason) return reason;
    }
  }
  return null;
}

/** Powód, dla którego JPK_FA nie powstanie, albo `null`. */
export async function jpkFaBlocker(
  client: SupabaseClient,
  params: {
    tenantId: string;
    periodStart: string;
    periodEnd: string;
    /** Ustawienie paczki — bez korekt eksport ich nie czyta, więc nie blokują. */
    includeCorrections: boolean;
  },
): Promise<string | null> {
  if (params.includeCorrections) {
    const { count, error } = await client
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', params.tenantId)
      .eq('direction', 'outgoing')
      .eq('ksef_status', 'accepted')
      .eq('invoice_kind', 'correction')
      .gte('issue_date', params.periodStart)
      .lte('issue_date', params.periodEnd);
    if (error) throw new Error(`Nie można sprawdzić korekt okresu: ${error.message}`);
    if ((count ?? 0) > 0) return new JpkFaCorrectionNotSupportedError().message;
  }

  const unsupported = await unsupportedDocumentReason(client, params);
  if (unsupported) return unsupported;

  const { data: tenant, error: tenantError } = await client
    .from('tenants')
    .select('nip')
    .eq('id', params.tenantId)
    .maybeSingle();
  if (tenantError) throw new Error(`Nie można odczytać NIP-u firmy: ${tenantError.message}`);
  const nip = (tenant as { nip?: string | null } | null)?.nip?.trim();
  if (!nip) return new MissingIssuerAddressError().message;

  try {
    const address = await readIssuerRegisteredAddress(nip);
    return address ? null : new MissingIssuerAddressError().message;
  } catch {
    // GUS chwilowo nie odpowiada — paczka i tak ma pójść, z CSV zamiast JPK_FA.
    return new MissingIssuerAddressError().message;
  }
}
