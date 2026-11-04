// lib/jobs/runners/exports-generate.ts
// Inngest: generuje plik exportu i zapisuje w R2.
//
// Flow rozbity na dwa memoizowane przez Inngest stepy:
//
//   1. generate-upload — generuje plik raz, wysyła dokładnie te bajty i liczy
//      SHA-256 zapisanych bajtów. Zwraca tylko metadane. Buffer NIE jest
//      serializowany do Inngest store'u (default limit ~64 KB na step memo,
//      a XML/Excel/CSV potrafią mieć MB-y; do tego niepotrzebnie wystawiamy
//      treść biznesową w cudzej bazie).
//
//      Warunkowy PUT chroni pierwszy obiekt przed równoległym nadpisaniem.
//      Gdy istnieje po wcześniejszej próbie, hash liczymy z jego treści.
//
//   2. persist — UPSERT export_files z ON CONFLICT (export_job_id, filename)
//      + UPDATE export_jobs.status = 'completed'. Wymaga unique indexu
//      `uq_export_files_job_filename` z migracji 00026.

import { createHash } from 'node:crypto';

import { NonRetriableError } from '../errors';
import type { JobContext } from '@/lib/jobs/registry';

import {
  exportsGenerateRequested,
} from '@/lib/jobs/events';
import { generateComarchOptimaXml } from '@/lib/exports/comarch-optima-generator';
import { OutgoingInvoiceCurrencyNotSupportedError } from '@/lib/exports/currency-guard';
import {
  CsvForeignCurrencyNotSupportedError,
  generateInsertSubiektCsv,
  generateSymfoniaCsv,
  generateUniversalCsv,
  generateWaproCsv,
} from '@/lib/exports/csv-generators';
import { fetchInvoicesForExport } from '@/lib/exports/data-fetcher';
import { exportScopeFor, UnknownExportFormatError, type ExportScope } from '@/lib/exports/export-scope';
import { KsefExpenseCurrencyNotSupportedError } from '@/lib/expenses/ksef-currency-review';
import { MissingIssuerAddressError, readIssuerRegisteredAddress } from '@/lib/exports/issuer-address';
import {
  generateJpkFa,
  JPK_DOCUMENT_REFUSAL_PREFIX,
  JpkDocumentNotSupportedError,
  JpkFaCorrectionNotSupportedError,
  JpkFaForeignCurrencyNotSupportedError,
} from '@/lib/exports/jpk-fa-generator';
import {
  assertJpkMatchesSchema,
  JPK_SCHEMA_ERROR_MESSAGES,
  JpkSchemaError,
} from '@/lib/exports/jpk-schema-check';
import { MissingTaxOfficeError, readTenantTaxOffice } from '@/lib/exports/tax-office';
import { readTaxpayerEmail } from '@/lib/exports/taxpayer-email';
import {
  generateJpkV7m,
  JpkV7mReverseChargeNotSupportedError,
  MissingTaxpayerEmailError,
} from '@/lib/exports/jpk-v7m-generator';
import { generateKpirXlsx } from '@/lib/exports/kpir-generator';
import { createAdminClient } from '@/lib/supabase/admin';
import { isExportFormatSuspended, SUSPENDED_EXPORT_FORMATS } from '@/lib/exports/suspended-formats';
import { downloadFromR2, uploadToR2IfAbsent } from '@/lib/storage/r2';

import type { Database } from '@/types/database';
import type { FetchedInvoiceData } from '@/lib/exports/data-fetcher';

type ExportJobRow = Database['public']['Tables']['export_jobs']['Row'];

interface GeneratedExportFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

interface GeneratedExportMeta {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  fileHash: string;
}

function safeNip(nip: string): string {
  return nip.replace(/\D/g, '').slice(0, 14) || 'braknip';
}

/** Builds the bytes for one export attempt. Some formats include current time. */
async function generateExportFile(
  job: ExportJobRow,
  data: FetchedInvoiceData,
): Promise<GeneratedExportFile> {
  const periodStr = `${job.period_start}_${job.period_end}`;
  const nip = safeNip(data.issuer.nip);

  // `jpk_v7m` doszło migracją 00056; `types/database.ts` regenerujemy
  // dopiero przed Fazą 35 — cast rozszerza union o nową wartość enuma.
  const format = job.format as ExportJobRow['format'] | 'jpk_v7m';

  switch (format) {
    case 'jpk_v7m': {
      // Zakupy z listy wydatków, nie z faktur otrzymanych (zob. data-fetcher).
      const xml = generateJpkV7m({
        issuer: data.issuer,
        periodStart: job.period_start,
        periodEnd: job.period_end,
        issuedInvoices: data.issuedInvoices,
        expenses: data.expenses,
      });
      await assertJpkMatchesSchema('JPK_V7M', xml);
      return {
        buffer: Buffer.from(xml, 'utf8'),
        filename: `JPK_V7M_${nip}_${periodStr}.xml`,
        mimeType: 'application/xml',
      };
    }
    case 'jpk_fa': {
      // JPK_FA obejmuje faktury WYSTAWIONE przez podatnika — zakupy nie.
      const xml = generateJpkFa({
        issuer: data.issuer,
        periodStart: job.period_start,
        periodEnd: job.period_end,
        issuedInvoices: data.issuedInvoices,
      });
      await assertJpkMatchesSchema('JPK_FA', xml);
      return {
        buffer: Buffer.from(xml, 'utf8'),
        filename: `JPK_FA_${nip}_${periodStr}.xml`,
        mimeType: 'application/xml',
      };
    }
    case 'kpir_excel': {
      const buffer = await generateKpirXlsx({
        issuer: data.issuer,
        periodStart: job.period_start,
        periodEnd: job.period_end,
        issuedInvoices: data.issuedInvoices,
        expenses: data.expenses,
      });
      return {
        buffer,
        filename: `KPiR_${nip}_${periodStr}.xlsx`,
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      };
    }
    case 'comarch_optima': {
      const xml = generateComarchOptimaXml({
        issuer: data.issuer,
        periodStart: job.period_start,
        periodEnd: job.period_end,
        issuedInvoices: data.issuedInvoices,
        receivedInvoices: data.receivedInvoices,
      });
      return {
        buffer: Buffer.from(xml, 'utf8'),
        filename: `Optima_${nip}_${periodStr}.xml`,
        mimeType: 'application/xml',
      };
    }
    case 'insert_subiekt': {
      const buffer = generateInsertSubiektCsv({
        issuer: data.issuer,
        periodStart: job.period_start,
        periodEnd: job.period_end,
        issuedInvoices: data.issuedInvoices,
        receivedInvoices: data.receivedInvoices,
      });
      return {
        buffer,
        filename: `Subiekt_${nip}_${periodStr}.csv`,
        mimeType: 'text/csv; charset=Windows-1250',
      };
    }
    case 'symfonia': {
      const buffer = generateSymfoniaCsv({
        issuer: data.issuer,
        periodStart: job.period_start,
        periodEnd: job.period_end,
        issuedInvoices: data.issuedInvoices,
        receivedInvoices: data.receivedInvoices,
      });
      return {
        buffer,
        filename: `Symfonia_${nip}_${periodStr}.csv`,
        mimeType: 'text/csv; charset=UTF-8',
      };
    }
    case 'wapro': {
      const buffer = generateWaproCsv({
        issuer: data.issuer,
        periodStart: job.period_start,
        periodEnd: job.period_end,
        issuedInvoices: data.issuedInvoices,
        receivedInvoices: data.receivedInvoices,
      });
      return {
        buffer,
        filename: `Wapro_${nip}_${periodStr}.csv`,
        mimeType: 'text/csv; charset=UTF-8',
      };
    }
    case 'csv_universal': {
      const buffer = generateUniversalCsv({
        issuer: data.issuer,
        periodStart: job.period_start,
        periodEnd: job.period_end,
        issuedInvoices: data.issuedInvoices,
        receivedInvoices: data.receivedInvoices,
      });
      return {
        buffer,
        filename: `Eksport_${nip}_${periodStr}.csv`,
        mimeType: 'text/csv; charset=UTF-8',
      };
    }
    default: {
      const unexpected: never = format;
      throw new NonRetriableError(
        `Format ${String(unexpected)} not implemented`,
      );
    }
  }
}

function buildR2Path(job: ExportJobRow, exportJobId: string, filename: string) {
  return `exports/${job.tenant_id}/${exportJobId}/${filename}`;
}

// ============================================================================

/** Komunikaty, które wolno pokazać człowiekowi — reszta to szczegóły techniczne. */
const HUMAN_EXPORT_ERRORS = [
  new MissingTaxOfficeError().message,
  new MissingTaxpayerEmailError().message,
  new MissingIssuerAddressError().message,
  new JpkFaCorrectionNotSupportedError().message,
  new JpkFaForeignCurrencyNotSupportedError().message,
  new CsvForeignCurrencyNotSupportedError().message,
  new OutgoingInvoiceCurrencyNotSupportedError().message,
  new KsefExpenseCurrencyNotSupportedError().message,
  new JpkV7mReverseChargeNotSupportedError().message,
  ...JPK_SCHEMA_ERROR_MESSAGES,
];

/**
 * Po wyczerpaniu prób (Inngest `onFailure`, pg-boss `onExhausted`): eksport
 * „nieudany” z powodem. Do 27.09 zostawał w „generating” na zawsze — Centrum
 * eksportu kręciło się bez końca, a Co-Pilot czekał do limitu czasu.
 */
export async function onExportsGenerateExhausted(
  failure: Error,
  data: { exportJobId: string },
): Promise<void> {
  const human =
    HUMAN_EXPORT_ERRORS.includes(failure.message) ||
    // W9: odmowa dokumentu ma w treści jego numer — rozpoznawana po początku.
    failure.message.startsWith(JPK_DOCUMENT_REFUSAL_PREFIX) ||
    Object.values(SUSPENDED_EXPORT_FORMATS).includes(failure.message);
  const message = human
    ? failure.message
    : 'Nie udało się wygenerować pliku. Spróbuj ponownie albo napisz do nas.';
  const { error } = await createAdminClient()
    .from('export_jobs')
    .update({ status: 'failed', error_message: message })
    .eq('id', data.exportJobId)
    .in('status', ['pending', 'generating']);
  if (error) throw new Error(error.message);
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-c.ts
 */
export async function runExportsGenerate(eventData: Parameters<typeof exportsGenerateRequested.create>[0], { step, logger }: JobContext) {
    const { exportJobId } = eventData;
    const supabase = createAdminClient();

    const job = await step.run('fetch-job', async () => {
      const { data, error } = await supabase
        .from('export_jobs')
        .select('*')
        .eq('id', exportJobId)
        .single();

      if (error || !data) {
        throw new NonRetriableError(`Export job ${exportJobId} not found`);
      }
      return data as ExportJobRow;
    });

    // Format wstrzymany (np. zlecony przed wstrzymaniem albo z ustawień paczki)
    // — bez pliku, z powodem dla człowieka zamiast pliku, którego nikt nie użyje.
    if (isExportFormatSuspended(job.format)) {
      throw new NonRetriableError(SUSPENDED_EXPORT_FORMATS[job.format]!);
    }

    // FIR-01: zakres z reguły formatu, nie z flag joba — Co-Pilot zapisuje
    // ustawienia paczki w każdym jobie, a KPiR ma zawsze całą sprzedaż.
    let scope: ExportScope;
    try {
      scope = exportScopeFor(job.format, {
        includeIssued: job.include_issued,
        includeReceived: job.include_received,
        includeCorrections: job.include_corrections,
      });
    } catch (error) {
      // Format spoza reguły (baza przed kodem) — ponowienie nic nie zmieni.
      if (error instanceof UnknownExportFormatError) throw new NonRetriableError(error.message);
      throw error;
    }

    await step.run('mark-generating', async () => {
      const { error } = await supabase
        .from('export_jobs')
        .update({
          status: 'generating',
          started_at: new Date().toISOString(),
          progress_message: 'Pobieranie danych z bazy...',
          // Wiersz mówi, co plik obejmuje: czyta go ponowienie z historii
          // i ostrzeżenie o fakturach dodanych po eksporcie (widok 00155).
          include_issued: scope.includeIssued,
          include_received: scope.includeReceived,
          include_corrections: scope.includeCorrections,
        })
        .eq('id', exportJobId);

      if (error) throw new Error(error.message);
    });

    // Nowe ID od pobrania do zapisu: Inngest nie może użyć memoizowanych
    // wyników sprzed kontroli waluty przy wznowieniu starszego eksportu.
    const data = await step.run('fetch-invoices-currency-guard', async () => {
      try {
        return await fetchInvoicesForExport({
          tenantId: job.tenant_id,
          periodStart: job.period_start,
          periodEnd: job.period_end,
          direction: scope.invoiceDirection,
          includeCorrections: scope.includeCorrections,
          includeExpenses: scope.includeExpenses,
        });
      } catch (error) {
        // Ponowienie nie zmieni waluty kosztu — to czeka na przegląd (C-11).
        if (error instanceof KsefExpenseCurrencyNotSupportedError) {
          throw new NonRetriableError(error.message);
        }
        throw error;
      }
    });

    const format = job.format as ExportJobRow['format'] | 'jpk_v7m';
    // JPK_FA bez faktur wystawionych nie istnieje (schemat wymaga co najmniej
    // jednej) — same zakupy w okresie to też „brak faktur” dla tego pliku.
    // KPiR i JPK_V7M mają sens także z samymi kosztami (#71).
    const hasExpensesForFormat = scope.includeExpenses && data.expenses.length > 0;
    const empty =
      format === 'jpk_fa'
        ? data.issuedInvoices.length === 0
        : data.issuedInvoices.length === 0 && data.receivedInvoices.length === 0 &&
          !hasExpensesForFormat;
    if (empty) {
      await step.run('mark-empty', async () => {
        const { error } = await supabase
          .from('export_jobs')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            invoices_count: 0,
            progress_message: 'Brak faktur w wybranym okresie',
          })
          .eq('id', exportJobId);
        if (error) throw new Error(error.message);
      });
      return { success: true as const, count: 0 };
    }

    // Urząd firmy dla plików JPK — odpornie przed migracją 00092. Ten sam
    // wkład trafia do OBU generowań (sumy kontrolnej i wysyłki do R2) — inaczej
    // drugie generowanie nie znałoby urzędu i plik padałby przy wysyłce.
    const taxOfficeCode =
      format === 'jpk_fa' || format === 'jpk_v7m'
        ? await step.run('read-tax-office', () => readTenantTaxOffice(supabase, job.tenant_id))
        : null;
    // JPK_V7M(3) wymaga e-maila podatnika — adres właściciela firmy.
    const taxpayerEmail =
      format === 'jpk_v7m'
        ? await step.run('read-taxpayer-email', () => readTaxpayerEmail(supabase, job.tenant_id))
        : null;
    // JPK_FA(4) wymaga adresu z województwem, powiatem i gminą — z rejestru GUS.
    // Błąd GUS rzuca (ponowienie ma sens); „nie znaleziono” to `null`, a
    // generator zamienia go w komunikat dla człowieka.
    const registeredAddress =
      format === 'jpk_fa'
        ? await step.run('read-registered-address', () => readIssuerRegisteredAddress(data.issuer.nip))
        : null;
    const fileData = {
      ...data,
      issuer: {
        ...data.issuer,
        taxOfficeCode: taxOfficeCode ?? undefined,
        email: taxpayerEmail ?? undefined,
        registeredAddress: registeredAddress ?? undefined,
      },
    };

    // Step 1: generate and upload exactly one byte sequence
    // ─────────────────────────────────────────────────────────────
    // Buffer NIE jest zwracany ze stepu (Inngest serializuje return-value).
    // Po udanym PUT to jego bajty wyznaczają hash. Jeśli poprzednia próba
    // zdążyła zapisać obiekt, czytamy jego rzeczywistą treść do metadanych.
    const fileMeta: GeneratedExportMeta = await step.run(
      'generate-upload',
      async () => {
        let generated: Awaited<ReturnType<typeof generateExportFile>>;
        try {
          generated = await generateExportFile(job, fileData);
        } catch (e) {
          // Ponowienie nic nie da — urząd ustawia człowiek, adresu GUS nie ma,
          // korekt JPK_FA nie obsługuje (C-01), a odwrotnego obciążenia JPK_V7M.
          // Plik niezgodny z XSD MF też: ten sam generator zbuduje go znowu.
          if (e instanceof JpkSchemaError) {
            logger.error('Plik JPK niezgodny z XSD MF — nie wydany', {
              exportJobId,
              kind: e.kind,
              errors: e.details,
            });
            throw new NonRetriableError(e.message);
          }
          if (
            e instanceof MissingTaxOfficeError ||
            e instanceof MissingTaxpayerEmailError ||
            e instanceof MissingIssuerAddressError ||
            e instanceof JpkFaCorrectionNotSupportedError ||
            e instanceof JpkFaForeignCurrencyNotSupportedError ||
            e instanceof JpkDocumentNotSupportedError ||
            e instanceof CsvForeignCurrencyNotSupportedError ||
            e instanceof OutgoingInvoiceCurrencyNotSupportedError ||
            e instanceof JpkV7mReverseChargeNotSupportedError
          ) {
            throw new NonRetriableError(e.message);
          }
          throw e;
        }
        const r2Path = buildR2Path(job, exportJobId, generated.filename);
        const uploaded = await uploadToR2IfAbsent(
          r2Path,
          generated.buffer,
          generated.mimeType,
        );
        const storedBytes = uploaded
          ? generated.buffer
          : await downloadFromR2(r2Path, job.tenant_id);
        const fileHash = createHash('sha256')
          .update(storedBytes)
          .digest('hex');
        return {
          filename: generated.filename,
          mimeType: generated.mimeType,
          sizeBytes: storedBytes.length,
          fileHash,
        };
      },
    );

    const r2Path = buildR2Path(job, exportJobId, fileMeta.filename);

    // Step 2: persist (UPSERT + UPDATE)
    // ─────────────────────────────────────────────────────────────
    // UPSERT z ON CONFLICT na (export_job_id, filename) — wymaga unique
    // indexu z migracji 00026. Bez niego retry tego stepu po częściowym
    // sukcesie (insert OK, update timeout) zwracałby 23505.
    const persistResult = await step.run('persist-currency-guard', async () => {
      const { error: insertErr } = await supabase
        .from('export_files')
        .upsert(
          {
            export_job_id: exportJobId,
            tenant_id: job.tenant_id,
            filename: fileMeta.filename,
            format: job.format,
            mime_type: fileMeta.mimeType,
            size_bytes: fileMeta.sizeBytes,
            r2_path: r2Path,
            file_hash: fileMeta.fileHash,
          },
          { onConflict: 'export_job_id,filename' },
        );

      if (insertErr) throw new Error(insertErr.message);

      const invoices = [...data.issuedInvoices, ...data.receivedInvoices];
      const invoicesCount = invoices.length;
      const totalNet = invoices.reduce((s, inv) => s + inv.netTotal, 0);
      const totalVat = invoices.reduce((s, inv) => s + inv.vatTotal, 0);
      const totalGross = invoices.reduce((s, inv) => s + inv.grossTotal, 0);

      const { error: updateErr } = await supabase
        .from('export_jobs')
        .update({
          status: 'completed',
          completed_at: new Date().toISOString(),
          progress_message: 'Gotowe',
          invoices_count: invoicesCount,
          total_net: totalNet,
          total_vat: totalVat,
          total_gross: totalGross,
        })
        .eq('id', exportJobId);

      if (updateErr) throw new Error(updateErr.message);

      return {
        invoicesCount,
        totalNet,
        totalVat,
        totalGross,
      };
    });

    return {
      success: true as const,
      filename: fileMeta.filename,
      size: fileMeta.sizeBytes,
      invoicesCount: persistResult.invoicesCount,
    };
}

