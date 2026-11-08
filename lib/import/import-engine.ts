/**
 * Centralny silnik importu: deduplikacja numerów, kontrahenci, produkty, zapis faktur.
 * Używa service role (`createAdminClient`) — wywoływać tylko z zaufanej ścieżki serwerowej / jobów.
 * Mapowanie pliku na wiersz faktury (nagłówek, pozycje, `fa3_data`, ostrzeżenie
 * JPK) jest czyste i wspólne z zapisem oryginału KSeF — `./imported-invoice-row`
 * (PR C0). Tu zostaje całe I/O: odczyty duplikatów, kolejność zapisów,
 * kontrahenci, produkty, znaczniki czasu i lista ostrzeżeń.
 */

import { KeysetPageError, readAllById } from '@/lib/pagination/keyset';
import { createAdminClient } from '@/lib/supabase/server';
import type { Json } from '@/types/database';
import type { KsefEnvironment } from '@/types/ksef';
import type { InvoiceOrigin } from '@/lib/flo/functions/import-history';
import type { ParsedInvoice } from './fa3-parser';
import { isTenantStoragePath } from '@/lib/storage/tenant-path';
import { recordXmlDocument } from '@/lib/storage/xml-documents';
import type { ArchivedKsefXml } from './ksef-xml-archive';
import { fa3ImportContent } from './fa3-content';
import {
  buildImportedInvoiceRow,
  buildImportedLineRows,
  contentFa3Fields,
  heldDocumentWarning,
  importedInvoiceContent,
  normalizeInvoiceKindForInsert,
} from './imported-invoice-row';

export interface ImportEngineParams {
  tenantId: string;
  importJobId: string;
  invoices: ParsedInvoice[];
  source: string;
  /** Domyślnie `outgoing` (CSV / sprzedaż); `incoming` dla historii odebranej z KSeF. */
  invoiceDirection?: 'outgoing' | 'incoming';
  /**
   * Status KSeF w DB (`draft` przy imporcie plików).
   * Historia z KSeF — zwykle `accepted` (faktury już w systemie KSeF).
   */
  invoiceKsefStatus?: string | null;
  /** Required provenance when importing invoices already accepted by KSeF. */
  ksefEnvironment?: KsefEnvironment;
  /**
   * Zapis katalogów (decyzja Bartosza 22.10.2026, IMP-PROD): `upsert`
   * (domyślnie — zachowanie bez zmian) dopisuje nowe i aktualizuje istniejące,
   * `insert-only` tylko dopisuje nowych (bez nadpisania danych kontrahenta
   * i bez zwiększania `use_count`), `skip` nie pisze nic. Synchronizacja
   * historii KSeF: sprzedaż `insert-only`, zakupy i naprawy `skip`.
   */
  catalogPolicy?: { contractors: CatalogPolicy; products: CatalogPolicy };
}

export type CatalogPolicy = 'upsert' | 'insert-only' | 'skip';

export interface ImportEngineResult {
  invoicesImported: number;
  /** Dokumenty nieutrwalone wskutek braku numeru, konfliktu KSeF albo błędu zapisu; potwierdzone duplikaty nie są awarią. */
  invoicesFailed: number;
  contractorsCreated: number;
  contractorsUpdated: number;
  productsCreated: number;
  warnings: string[];
}

/**
 * Wynik z osobną listą notatek JPK (`held` — te same, które prowadzą
 * `warnings`). Osobna funkcja, żeby wynik `processImportedInvoices` (migawka
 * `import-wiersze-tozsamosc`) został bajt w bajt ten sam.
 */
export interface ImportEngineDetailedResult extends ImportEngineResult {
  held: string[];
}

type AdminSupabase = ReturnType<typeof createAdminClient>;

export async function processImportedInvoices(
  params: ImportEngineParams,
): Promise<ImportEngineResult> {
  // Bez `held` — kształt wyniku sprzed zmiany (strażnik migawki).
  const { held: _held, ...result } = await processImportedInvoicesDetailed(params);
  void _held;
  return result;
}

/** Jak `processImportedInvoices`, plus notatki JPK osobno (synchronizacja historii KSeF: `jpk_note`). */
export async function processImportedInvoicesDetailed(
  params: ImportEngineParams,
): Promise<ImportEngineDetailedResult> {
  const invoiceKsefStatus = params.invoiceKsefStatus ?? 'draft';
  if (invoiceKsefStatus === 'accepted' && !params.ksefEnvironment) {
    throw new Error('Accepted KSeF import requires verified environment provenance');
  }
  if (params.invoiceDirection === 'incoming' && !params.ksefEnvironment &&
      params.invoices.some((invoice) => Boolean(invoice.ksefNumber?.trim()))) {
    throw new Error('Incoming KSeF number requires verified environment provenance');
  }
  const supabase = createAdminClient();
  const warnings: string[] = [];

  for (const inv of params.invoices) {
    if (inv.warnings?.length) warnings.push(...inv.warnings.map((w) => `${inv.invoiceNumber}: ${w}`));
  }

  const invoiceDirection = params.invoiceDirection ?? 'outgoing';
  const counterparty =
    invoiceDirection === 'incoming' ? ('seller' as const) : ('buyer' as const);

  const contractorsPolicy = params.catalogPolicy?.contractors ?? 'upsert';
  const productsPolicy = params.catalogPolicy?.products ?? 'upsert';

  const contractorsMap = extractUniqueContractors(params.invoices, counterparty);

  const contractorResult = contractorsPolicy === 'skip'
    ? { created: 0, updated: 0 }
    : await upsertContractors(
      supabase,
      params.tenantId,
      contractorsMap,
      warnings,
      contractorsPolicy,
    );

  const productsMap = extractUniqueProducts(params.invoices);
  const productsCreated = productsPolicy === 'skip'
    ? 0
    : await upsertProducts(supabase, params.tenantId, productsMap, warnings, productsPolicy);

  // W9: dokumenty zapisane, których JPK nie wykaże (stawka spoza FaktWay,
  // zaimportowana korekta / zaliczka / ROZ) — na początku listy, bo widok
  // importu pokazuje tylko pierwsze ostrzeżenia.
  const held: string[] = [];
  const invoiceResult = await insertInvoices(
    supabase,
    params.tenantId,
    params.invoices,
    params.source,
    params.importJobId,
    invoiceDirection,
    invoiceKsefStatus,
    params.ksefEnvironment ?? null,
    warnings,
    held,
  );

  return {
    invoicesImported: invoiceResult.imported,
    invoicesFailed: invoiceResult.failed,
    contractorsCreated: contractorResult.created,
    contractorsUpdated: contractorResult.updated,
    productsCreated,
    warnings: [...held, ...warnings],
    held: [...held],
  };
}

// ─── Kontrahenci ─────────────────────────────────────────────────────────────

interface ContractorSummary {
  nip: string;
  name: string;
  address?: {
    addressLine1?: string;
    addressLine2?: string;
    countryCode?: string;
  };
  email?: string;
  invoiceCount: number;
  firstInvoiceDate: string;
  lastInvoiceDate: string;
}

function extractUniqueContractors(
  invoices: ParsedInvoice[],
  counterparty: 'buyer' | 'seller',
): Map<string, ContractorSummary> {
  const map = new Map<string, ContractorSummary>();

  for (const inv of invoices) {
    const party = counterparty === 'seller' ? inv.seller : inv.buyer;
    const nip = party.nip?.replace(/\D/g, '');
    if (!nip || nip.length !== 10) continue;

    const existing = map.get(nip);
    if (existing) {
      existing.invoiceCount += 1;
      if (inv.issueDate < existing.firstInvoiceDate) existing.firstInvoiceDate = inv.issueDate;
      if (inv.issueDate > existing.lastInvoiceDate) existing.lastInvoiceDate = inv.issueDate;
      if (party.name && party.name.length > existing.name.length) existing.name = party.name;
    } else {
      map.set(nip, {
        nip,
        name: party.name,
        address: {
          addressLine1: party.addressLine1,
          addressLine2: party.addressLine2,
          countryCode: party.countryCode ?? 'PL',
        },
        email: party.email,
        invoiceCount: 1,
        firstInvoiceDate: inv.issueDate,
        lastInvoiceDate: inv.issueDate,
      });
    }
  }

  return map;
}

async function upsertContractors(
  supabase: AdminSupabase,
  tenantId: string,
  contractorsMap: Map<string, ContractorSummary>,
  warnings: string[],
  policy: Exclude<CatalogPolicy, 'skip'> = 'upsert',
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  if (contractorsMap.size === 0) return { created, updated };

  const nips = Array.from(contractorsMap.keys());
  const { data: existing, error: selErr } = await supabase
    .from('contractors')
    .select('id, nip, name, email, address')
    .eq('tenant_id', tenantId)
    .in('nip', nips);

  if (selErr) {
    warnings.push(`Kontrahenci: odczyt — ${selErr.message}`);
    return { created: 0, updated: 0 };
  }

  const existingMap = new Map(existing?.map((c) => [c.nip, c]) ?? []);

  const rowsToInsert = Array.from(contractorsMap.values()).filter((s) => !existingMap.has(s.nip));

  if (rowsToInsert.length > 0) {
    const { data: ins, error: insErr } = await supabase
      .from('contractors')
      .insert(
        rowsToInsert.map((summary) => ({
          tenant_id: tenantId,
          nip: summary.nip,
          name: summary.name,
          address: summary.address as Json,
          email: summary.email ?? null,
          last_used_at: new Date().toISOString(),
        })),
      )
      .select('id');

    if (insErr) warnings.push(`Kontrahenci: insert — ${insErr.message}`);
    else created = ins?.length ?? 0;
  }

  // `insert-only`: istniejącego kontrahenta nie nadpisujemy (dane z KSeF
  // mogą być starsze niż poprawione ręcznie w FaktWay).
  if (policy === 'insert-only') return { created, updated };

  for (const [nip, summary] of contractorsMap.entries()) {
    const row = existingMap.get(nip);
    if (!row?.id) continue;

    const { error: updErr } = await supabase
      .from('contractors')
      .update({
        name: summary.name,
        address: summary.address as Json,
        email: summary.email ?? row.email ?? null,
        last_used_at: new Date().toISOString(),
      })
      .eq('id', row.id);

    if (updErr) warnings.push(`Kontrahent NIP ${nip}: update — ${updErr.message}`);
    else updated++;
  }

  return { created, updated };
}

// ─── Produkty ──────────────────────────────────────────────────────────────

interface ProductSummary {
  name: string;
  unit: string;
  /** NULL, gdy plik KSeF nie podaje ceny netto (ceny brutto — C5c). */
  defaultPriceNet: number | null;
  defaultVatRate: string;
  useCount: number;
}

function extractUniqueProducts(invoices: ParsedInvoice[]): Map<string, ProductSummary> {
  const map = new Map<string, ProductSummary>();

  for (const inv of invoices) {
    for (const line of inv.lines) {
      const key = normalizeProductKey(line.name, line.unit);
      if (!key) continue;

      const existing = map.get(key);
      if (existing) {
        existing.useCount += 1;
      } else {
        map.set(key, {
          name: line.name,
          unit: line.unit,
          // C5c: z pliku KSeF cena netto tylko z P_9A — przy cenach brutto jej nie ma (nie 0).
          defaultPriceNet: line.ksef ? (line.ksef.P_9A !== undefined && Number.isFinite(Number(line.ksef.P_9A)) ? Number(line.ksef.P_9A) : null) : line.unitPriceNet,
          defaultVatRate: line.vatRate,
          useCount: 1,
        });
      }
    }
  }

  return map;
}

function normalizeProductKey(name: string, unit: string): string | null {
  const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized.length < 3) return null;
  if (normalized.includes('pozycja zbiorcza') || normalized === 'usługa') return null;
  return `${normalized}|${unit.trim().toLowerCase()}`;
}

async function upsertProducts(
  supabase: AdminSupabase,
  tenantId: string,
  productsMap: Map<string, ProductSummary>,
  warnings: string[],
  policy: Exclude<CatalogPolicy, 'skip'> = 'upsert',
): Promise<number> {
  if (productsMap.size === 0) return 0;

  // Cały katalog firmy stronami po kluczu (sesja 27 planu skalowania): jedno
  // zapytanie oddawało najwyżej 1000 produktów (PGRST_DB_MAX_ROWS), a pozycja
  // pasująca do produktu spoza tej części szła do INSERT — tabela nie ma
  // UNIQUE, więc powstawał dubel, przy każdej kolejnej fakturze następny.
  // Błąd którejkolwiek strony = nic nie zapisujemy (częściowy katalog to ten
  // sam dubel w innym przebraniu).
  let existingRows: Array<{ id: string; name: string; unit: string; use_count: number | null }>;
  try {
    existingRows = await readAllById('Produkty: odczyt', (afterId, limit) => {
      let query = supabase
        .from('products')
        .select('id, name, unit, use_count')
        .eq('tenant_id', tenantId);
      if (afterId) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit);
    });
  } catch (error) {
    if (!(error instanceof KeysetPageError)) throw error;
    warnings.push(`Produkty: odczyt — ${error.reason}`);
    return 0;
  }

  const existingByKey = new Map<string, { id: string; use_count: number }>();
  for (const row of existingRows) {
    const k = normalizeProductKey(row.name, row.unit);
    if (k) existingByKey.set(k, { id: row.id, use_count: row.use_count ?? 0 });
  }

  let created = 0;

  const toInsert: {
    tenant_id: string;
    name: string;
    unit: string;
    default_price_net: number | null;
    default_vat_rate: string;
    use_count: number;
    last_used_at: string;
  }[] = [];

  for (const summary of productsMap.values()) {
    const key = normalizeProductKey(summary.name, summary.unit);
    if (!key) continue;

    const hit = existingByKey.get(key);
    if (hit && policy === 'insert-only') continue; // bez zwiększania `use_count` (IMP-PROD)
    if (hit) {
      const { error } = await supabase
        .from('products')
        .update({
          use_count: hit.use_count + summary.useCount,
          last_used_at: new Date().toISOString(),
        })
        .eq('id', hit.id);

      if (error) warnings.push(`Produkt „${summary.name.slice(0, 40)}…”: update — ${error.message}`);
    } else {
      toInsert.push({
        tenant_id: tenantId,
        name: summary.name,
        unit: summary.unit || 'szt.',
        default_price_net: summary.defaultPriceNet,
        default_vat_rate: summary.defaultVatRate,
        use_count: summary.useCount,
        last_used_at: new Date().toISOString(),
      });
      existingByKey.set(key, { id: '__pending__', use_count: summary.useCount });
    }
  }

  if (toInsert.length === 0) return 0;

  const { data: insData, error: insErr } = await supabase
    .from('products')
    .insert(toInsert)
    .select('id');

  if (insErr) {
    warnings.push(`Produkty: insert — ${insErr.message}`);
    return 0;
  }

  created = insData?.length ?? 0;
  return created;
}

// ─── Faktury ───────────────────────────────────────────────────────────────

async function insertInvoices(
  supabase: AdminSupabase,
  tenantId: string,
  invoices: ParsedInvoice[],
  source: string,
  importJobId: string,
  invoiceDirection: 'outgoing' | 'incoming',
  invoiceKsefStatus: string,
  ksefEnvironment: KsefEnvironment | null,
  warnings: string[],
  held: string[],
): Promise<{ imported: number; failed: number }> {
  if (invoices.length === 0) return { imported: 0, failed: 0 };
  const noteHeld = (inv: ParsedInvoice, num: string, ksefNumber: string | undefined) => {
    const { content, amounts } = importedInvoiceContent(inv);
    const note = heldDocumentWarning(inv, num, ksefNumber, invoiceDirection, invoiceKsefStatus, content, amounts);
    if (note) held.push(note);
  };
  const origin: InvoiceOrigin = source === 'ksef_history' ? 'ksef_import'
    : source === 'ksef_inbox' ? 'ksef_inbox'
    : source === 'ocr_photo' ? 'ocr'
    : 'file_import';

  const numbers = [...new Set(invoices
    .filter((invoice) => invoiceDirection === 'outgoing' || !invoice.ksefNumber?.trim())
    .map((invoice) => invoice.invoiceNumber.trim()).filter(Boolean))];
  const ksefNumbers = [
    ...new Set(
      invoices
        .map((i) => i.ksefNumber?.trim())
        .filter((x): x is string => !!x?.length),
    ),
  ];

  const numberKey = (num: string, sellerNip: string | null, issueDate: string) =>
    invoiceDirection === 'outgoing' ? num : `${sellerNip ?? ''}|${issueDate}|${num}`;
  const existingNumbers = new Map<string, Set<string | null>>();
  const rememberNumber = (key: string, ksefNumber: string | null) => {
    const matches = existingNumbers.get(key) ?? new Set<string | null>();
    matches.add(ksefNumber);
    existingNumbers.set(key, matches);
  };
  if (numbers.length > 0) {
    const { data: existingNums, error: exNumErr } = await supabase
      .from('invoices')
      .select('internal_number, seller_nip, issue_date, ksef_number')
      .eq('tenant_id', tenantId)
      .eq('direction', invoiceDirection)
      .in('internal_number', numbers);

    if (exNumErr) throw new Error(`Faktury: odczyt duplikatów (numer) — ${exNumErr.message}`);
    for (const row of existingNums ?? []) {
      if (row.internal_number?.trim()) {
        rememberNumber(
          numberKey(row.internal_number.trim(), row.seller_nip, row.issue_date),
          row.ksef_number?.trim() || null,
        );
      }
    }
  }

  type ExistingKsefInvoice = {
    id: string;
    internal_number: string | null;
    ksef_status: string | null;
    ksef_environment: string | null;
    xml_storage_path: string | null;
    origin: string | null;
    /** C5b: `fa3_data->annotations` — NULL przy imporcie sprzed C5b. */
    stored_annotations?: unknown;
  };
  const existingKsef = new Map<string, ExistingKsefInvoice[]>();
  if (ksefNumbers.length > 0) {
    let query = supabase
      .from('invoices')
      .select('id, ksef_number, internal_number, ksef_status, ksef_environment, xml_storage_path, origin, stored_annotations:fa3_data->annotations')
      .eq('tenant_id', tenantId)
      .eq('direction', invoiceDirection);
    if (invoiceDirection === 'incoming' && ksefEnvironment) {
      query = query.eq('ksef_environment', ksefEnvironment);
    }
    const { data: ksefExisting, error: exKErr } = await query.in('ksef_number', ksefNumbers);

    if (exKErr) throw new Error(`Faktury: odczyt duplikatów (ksef) — ${exKErr.message}`);
    for (const row of ksefExisting ?? []) {
      const ksefNumber = row.ksef_number?.trim();
      if (ksefNumber) {
        const matches = existingKsef.get(ksefNumber) ?? [];
        matches.push(row);
        existingKsef.set(ksefNumber, matches);
      }
    }
  }

  const seenInBatch = new Map<string, string | null>();
  const seenKsefInBatch = new Map<string, string>();
  let imported = 0;
  let failed = 0;

  for (const inv of invoices) {
    const num = inv.invoiceNumber.trim();

    if (!num) {
      warnings.push('Pominięto fakturę bez numeru');
      failed++;
      continue;
    }

    const ksefNorm = inv.ksefNumber?.trim();
    const key = numberKey(num, inv.seller.nip?.replace(/\D/g, '') ?? null, inv.issueDate);
    if (source === 'ksef_history' && invoiceDirection === 'outgoing' && ksefNorm) {
      if (seenInBatch.has(key) && seenInBatch.get(key) !== ksefNorm) {
        warnings.push(`${num}: konflikt numeru faktury z innym numerem KSeF w imporcie`);
        failed++;
        continue;
      }
      const storedKsefNumbers = existingNumbers.get(key);
      if (storedKsefNumbers && [...storedKsefNumbers].some((stored) => stored !== ksefNorm)) {
        warnings.push(`${num}: konflikt numeru faktury z innym numerem KSeF w bazie`);
        failed++;
        continue;
      }
    }
    if (ksefNorm) {
      const matches = existingKsef.get(ksefNorm);
      if (matches?.length) {
        if (source === 'ksef_history') {
          const stored = matches.length === 1 ? matches[0] : null;
          if (!stored?.id || stored.internal_number?.trim() !== num ||
              stored.ksef_status !== 'accepted' ||
              stored.ksef_environment !== ksefEnvironment) {
            warnings.push(`${num}: nie można potwierdzić kompletności duplikatu KSeF ${ksefNorm} (nagłówek)`);
            failed++;
            continue;
          }
          const { count, error: countErr } = await supabase
            .from('invoice_line_items')
            .select('id', { count: 'exact', head: true })
            .eq('invoice_id', stored.id);
          if (countErr || count === null || count !== inv.lines.length) {
            warnings.push(`${num}: nie można potwierdzić kompletności duplikatu KSeF ${ksefNorm} (pozycje: ${countErr?.message ?? 'niezgodna lub nieznana liczba'})`);
            failed++;
            continue;
          }
          // Ponowienie po nieudanym zapisie oryginału: uzupełniamy XML tylko
          // przy fakturze bez własnego pliku albo z tym samym archiwum.
          if (inv.xmlArchive && !(await repairImportedXml(supabase, tenantId, stored, inv.xmlArchive, num, warnings))) {
            failed++;
            continue;
          }
          // C5b: faktura z importu sprzed odczytu daty sprzedaży i adnotacji —
          // ponowny import uzupełnia je z oryginału (decyzja Bartosza 06.10).
          if (stored.origin === 'ksef_import' && stored.stored_annotations == null &&
              !(await backfillImportedContent(supabase, tenantId, stored.id, inv, num, warnings))) {
            failed++;
            continue;
          }
        }
        // Ponowienie importu: dokument zapisany wcześniej PRZEZ IMPORT — ostrzeżenie
        // zostaje. Faktura wystawiona w FaktWay (korekta, zaliczka z aplikacji)
        // ma w bazie właściwy rodzaj i stawki — JPK ją wykaże, bez ostrzeżenia.
        if (source === 'ksef_history' && matches.length === 1 && matches[0]?.origin === 'ksef_import') {
          noteHeld(inv, num, ksefNorm);
        }
        warnings.push(`Pominięto duplikat (DB, KSeF): ${ksefNorm}`);
        continue;
      }
      const earlierNumber = seenKsefInBatch.get(ksefNorm);
      if (earlierNumber !== undefined) {
        if (source === 'ksef_history' && earlierNumber !== num) {
          warnings.push(`${num}: numer KSeF ${ksefNorm} ma inny numer faktury w imporcie`);
          failed++;
          continue;
        }
        warnings.push(`Pominięto duplikat (import, KSeF): ${ksefNorm}`);
        continue;
      }
    }

    if (invoiceDirection === 'outgoing' || !ksefNorm) {
      if (existingNumbers.has(key)) {
        warnings.push(`Pominięto duplikat (DB): ${num}`);
        continue;
      }
      if (seenInBatch.has(key)) {
        warnings.push(`Pominięto duplikat (plik importu): ${num}`);
        continue;
      }
      seenInBatch.set(key, ksefNorm ?? null);
    }
    if (ksefNorm) seenKsefInBatch.set(ksefNorm, num);

    const sellerNipDigits = inv.seller.nip?.replace(/\D/g, '') ?? '';
    if (invoiceDirection === 'outgoing' && sellerNipDigits.length !== 10) {
      warnings.push(`${num}: brak NIP sprzedawcy w importie — kolumna seller_nip została pusta`);
    }

    const kindWarning = normalizeInvoiceKindForInsert(inv).warning;
    if (kindWarning) warnings.push(kindWarning);
    // C5c: netto / VAT / brutto pozycji zgodne z sumami stawek nagłówka (art. 106e ust. 7–11).
    const { content, amounts } = importedInvoiceContent(inv);

    // IMP-ACC (decyzja Bartosza 22.10.2026): chwila nadania numeru w KSeF,
    // gdy wywołujący ją zna; bez pola — jak dotąd chwila importu.
    let acceptedNow: string | null = null;
    if (invoiceKsefStatus === 'accepted') {
      const ksefAcceptedMs = inv.ksefAcceptedAt === undefined ? Number.NaN : Date.parse(inv.ksefAcceptedAt);
      if (Number.isFinite(ksefAcceptedMs)) {
        acceptedNow = new Date(ksefAcceptedMs).toISOString();
      } else {
        acceptedNow = new Date().toISOString();
        if (inv.ksefAcceptedAt !== undefined) {
          warnings.push(`${num}: brak daty przyjęcia w KSeF — użyto chwili importu`);
        }
      }
    }

    if (inv.xmlArchive && (source !== 'ksef_history' || !ksefNorm ||
        !isTenantStoragePath(inv.xmlArchive.storagePath, tenantId))) {
      warnings.push(`${num}: oryginał XML spoza importu historii tej firmy — pominięto`);
      failed++;
      continue;
    }

    const invoiceRow = buildImportedInvoiceRow(inv, {
      tenantId,
      direction: invoiceDirection,
      origin,
      ksefStatus: invoiceKsefStatus,
      ksefEnvironment,
      ksefAcceptedAt: acceptedNow,
      ksefNumber: ksefNorm ?? null,
      xmlStoragePath: inv.xmlArchive?.storagePath,
      notes: `[import] ${source} job=${importJobId}`,
      provenance: { source, importJobId, importedAt: new Date().toISOString() },
    }, content, amounts);

    const { data: inserted, error: invErr } = await supabase
      .from('invoices')
      .insert(invoiceRow)
      .select('id')
      .single();

    if (invErr || !inserted?.id) {
      warnings.push(`Błąd zapisu faktury ${num}: ${invErr?.message ?? 'unknown'}`);
      failed++;
      continue;
    }

    const lineRows = buildImportedLineRows(inv, amounts).map((row) => ({ invoice_id: inserted.id, ...row }));

    const { error: linesErr } = await supabase.from('invoice_line_items').insert(lineRows);

    if (linesErr) {
      warnings.push(`Faktura ${num}: błąd pozycji — ${linesErr.message}`);
      const { data: removed, error: cleanupErr } = await supabase
        .from('invoices')
        .delete()
        .eq('id', inserted.id)
        .eq('tenant_id', tenantId)
        .select('id');
      if (cleanupErr || removed?.length !== 1 || removed[0]?.id !== inserted.id) {
        warnings.push(`Faktura ${num}: nie potwierdzono usunięcia niepełnego nagłówka — ${cleanupErr?.message ?? 'brak potwierdzenia DELETE'}`);
      }
      failed++;
      continue;
    }

    if (inv.xmlArchive) {
      try {
        await recordXmlDocument({ tenantId, invoiceId: inserted.id, ...inv.xmlArchive });
      } catch (e) {
        // Faktura zostaje; ponowienie importu uzupełni wiersz (gałąź duplikatu).
        warnings.push(`Faktura ${num}: nie zapisano oryginału XML (KOD I) — ponów import (${e instanceof Error ? e.message : 'błąd'})`);
        // Faktura i pozycje są zapisane — ostrzeżenie o JPK też musi być.
        noteHeld(inv, num, ksefNorm);
        failed++;
        rememberNumber(key, ksefNorm ?? null);
        continue;
      }
    }

    imported++;
    noteHeld(inv, num, ksefNorm);
    rememberNumber(key, ksefNorm ?? null);
  }

  return { imported, failed };
}

/**
 * Duplikat z importu historii bez zapisanego oryginału XML: ustawia ścieżkę
 * (tylko gdy pusta) i wiersz `xml_documents`. Faktura z własnym plikiem
 * (wysłana z aplikacji) zostaje bez zmian. `false` = nie udało się.
 */
async function repairImportedXml(
  supabase: AdminSupabase,
  tenantId: string,
  stored: { id: string; xml_storage_path: string | null },
  archive: ArchivedKsefXml,
  num: string,
  warnings: string[],
): Promise<boolean> {
  if (!isTenantStoragePath(archive.storagePath, tenantId)) {
    warnings.push(`${num}: oryginał XML spoza folderu firmy — pominięto`);
    return false;
  }
  if (stored.xml_storage_path && stored.xml_storage_path !== archive.storagePath) return true;
  try {
    if (!stored.xml_storage_path) {
      const { data, error } = await supabase
        .from('invoices')
        .update({ xml_storage_path: archive.storagePath })
        .eq('id', stored.id)
        .eq('tenant_id', tenantId)
        .is('xml_storage_path', null)
        .select('id')
        .maybeSingle();
      if (error || data?.id !== stored.id) throw new Error(error?.message ?? 'faktura zmieniła się w międzyczasie');
    }
    await recordXmlDocument({ tenantId, invoiceId: stored.id, ...archive });
    return true;
  } catch (e) {
    warnings.push(`${num}: nie uzupełniono oryginału XML (KOD I) — ${e instanceof Error ? e.message : 'błąd'}`);
    return false;
  }
}

/**
 * C5b: wiersz z importu historii sprzed odczytu daty sprzedaży i adnotacji
 * (`fa3_data.annotations` brak). Ponowny import tej samej faktury dopisuje je
 * z oryginału — warunkowo (tylko gdy adnotacji nadal nie ma), więc ponowienie
 * joba niczego nie nadpisze. Serwis może: przyjęta faktura z importu nie ma
 * `submitted_to_ksef_at` ani wysyłki w toku (00132). `false` = nie udało się.
 */
async function backfillImportedContent(
  supabase: AdminSupabase,
  tenantId: string,
  invoiceId: string,
  inv: ParsedInvoice,
  num: string,
  warnings: string[],
): Promise<boolean> {
  const content = fa3ImportContent(inv);
  if (!content.annotations) return true; // plik bez Adnotacji do odczytu (nie z KSeF) — nic do dopisania
  try {
    const { data: row, error: readErr } = await supabase
      .from('invoices')
      .select('fa3_data, sale_date')
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .single();
    if (readErr || !row) throw new Error(readErr?.message ?? 'brak faktury');
    const stored = (row.fa3_data && typeof row.fa3_data === 'object' && !Array.isArray(row.fa3_data) ? row.fa3_data : {}) as Record<string, unknown>;
    const { data, error } = await supabase
      .from('invoices')
      .update({
        fa3_data: { ...stored, ...contentFa3Fields(content) } as unknown as Json,
        ...(row.sale_date == null ? { sale_date: content.saleDate } : {}),
      })
      .eq('id', invoiceId)
      .eq('tenant_id', tenantId)
      .is('fa3_data->annotations', null)
      .select('id');
    if (error) throw new Error(error.message);
    if (data?.length) warnings.push(`${num}: uzupełniono datę sprzedaży i adnotacje z oryginału KSeF (faktura z wcześniejszego importu)`);
    return true;
  } catch (e) {
    warnings.push(`${num}: nie uzupełniono daty sprzedaży i adnotacji z KSeF — ponów import (${e instanceof Error ? e.message : 'błąd'})`);
    return false;
  }
}
