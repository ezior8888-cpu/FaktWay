import type { Json } from '@/types/database';
import { NonRetriableError, type RetryAfterError } from '../errors';
import type { JobContext } from '@/lib/jobs/registry';

import { logAuditSystem } from '@/lib/audit/log-system';
import { downloadUpoFromKsef } from '@/lib/ksef/upo-client';
import { findSessionReferenceForKsefNumber } from '@/lib/ksef/submission-log';
import { generateUpoPdf } from '@/lib/ksef/upo-pdf-generator';
import { uploadUpoPdf, uploadUpoXml } from '@/lib/ksef/upo-storage';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { KSEF_PAUSE_DEFAULT_MS, ksefPausedUntil, ksefPauseRetryError } from '@/lib/ksef/rate-limit-pause';

import { invoiceUpoRequested } from '../events';
import { assertUpoReceipt, readUpoReceipt, requireAcceptedUpoInvoice, requireUpoBoundary } from './upo-identity';

type BuyerBlob = { name?: unknown };

function stringFromBuyerData(buyerData: Json | null): string {
  if (!buyerData || typeof buyerData !== 'object' || Array.isArray(buyerData)) {
    return '';
  }
  const n = (buyerData as BuyerBlob).name;
  return typeof n === 'string' ? n : '';
}

/**
 * Kod wyniku klienta UPO „firma w pauzie po 429” (`lib/ksef/upo-client.ts`).
 * Napis, nie import: testy granic zastępują cały moduł klienta atrapą.
 */
const KSEF_RATE_LIMIT_PAUSE = 'KSEF_RATE_LIMIT_PAUSE';

/** Błąd ponowienia na czas pauzy firmy (L1a): bez zużycia próby, rozrzut po fakturze. */
function upoPauseError(invoiceId: string, remainingMs: number): RetryAfterError {
  return ksefPauseRetryError(
    `${KSEF_RATE_LIMIT_PAUSE}: UPO faktury ${invoiceId} czeka na koniec pauzy firmy po 429 z KSeF ` +
      `(jeszcze ${Math.ceil(Math.max(0, remainingMs) / 1000)} s)`,
    remainingMs,
    invoiceId,
  );
}

/**
 * Job: pobiera UPO XML z KSeF, wgrywa do R2, generuje PDF pomocniczy.
 *
 * Trigger: `invoice/upo.requested` (np. po `invoice.submit.succeeded`).
 */
/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-d.ts
 */
export async function runDownloadUpo(data: Parameters<typeof invoiceUpoRequested.create>[0], { step, logger }: JobContext) {
  const { invoiceId, tenantId, ksefNumber } = data;
  if (data.environment !== requireConfiguredKsefEnvironment()) {
    throw new NonRetriableError('KSeF UPO event environment requires reconciliation');
  }
  const identity = { invoiceId, tenantId, ksefNumber };

  // Authorization must be fresh on every resume, including cached steps.
  await requireAcceptedUpoInvoice(identity);
  logger.info('UPO download start', { invoiceId, tenantId });
  const existingUpo = await readUpoReceipt(identity);
  if (existingUpo?.status === 'downloaded') {
    return { skipped: true, reason: 'UPO already downloaded' };
  }

  // L1a: firma w pauzie po 429 z KSeF — czekamy do końca pauzy, zanim
  // cokolwiek zapiszemy (bez `pending`/`failed` i bez `download_attempts`)
  // i zanim zapytamy KSeF. Po każdym powrocie ten odczyt idzie od nowa.
  // NIP ze zdarzenia (klucz grupy kolejki); klient UPO sprawdza jeszcze NIP
  // z poświadczeń firmy.
  const pausedUntil = data.nip ? await ksefPausedUntil(data.environment, data.nip) : null;
  if (pausedUntil !== null) {
    logger.info('UPO czeka na koniec pauzy firmy po 429', { invoiceId, tenantId, code: KSEF_RATE_LIMIT_PAUSE });
    throw upoPauseError(invoiceId, pausedUntil - Date.now());
  }

  const upoRecord = await step.run('upsert-upo-record', async () => {
    await requireAcceptedUpoInvoice(identity);
    const supabase = createAdminClient();
    const current = await readUpoReceipt(identity);
    if (current) {
      const { data: updated, error } = await supabase.from('upo_receipts')
        .update({ last_error: null, status: 'pending' })
        .eq('id', current.id).eq('tenant_id', tenantId)
        .eq('invoice_id', invoiceId).eq('ksef_number', ksefNumber)
        .in('status', ['pending', 'failed'])
        .select('id, tenant_id, invoice_id, ksef_number, ksef_environment').single();
      if (error || !updated) throw new Error('Nie można przygotować rekordu UPO');
      assertUpoReceipt(updated, identity, current.id);
      return updated;
    }
    const { data: inserted, error } = await supabase.from('upo_receipts')
      .insert({ tenant_id: tenantId, invoice_id: invoiceId, ksef_number: ksefNumber,
        ksef_acceptance_timestamp: new Date().toISOString(), status: 'pending',
        ksef_environment: data.environment })
      .select('id, tenant_id, invoice_id, ksef_number, ksef_environment').single();
    if (error || !inserted) throw new Error('Nie można utworzyć rekordu UPO');
    assertUpoReceipt(inserted, identity);
    return inserted;
  });
  // Durable results are data, not proof that the current relation is still valid.
  assertUpoReceipt(upoRecord, identity);
  await requireUpoBoundary(identity, upoRecord.id);

  const downloadResult = await step.run('download-from-ksef', async () => {
    await requireUpoBoundary(identity, upoRecord.id);
    // Numer sesji ze zdarzenia, a dla starszych zdarzeń i ponowień
    // z `upo-retry-stale` — z historii wysyłek (AUD-17).
    const sessionReferenceNumber =
      data.sessionReferenceNumber ??
      (await findSessionReferenceForKsefNumber(tenantId, invoiceId, ksefNumber));
    return downloadUpoFromKsef(tenantId, ksefNumber, { invoiceId, sessionReferenceNumber });
  });
  if (!downloadResult.success) {
    // L1a: klient UPO nie zapytał KSeF, bo firma jest w pauzie (NIP
    // z poświadczeń, pauza mogła się zacząć po odczycie wyżej). To czekanie,
    // nie porażka: bez `failed` i bez kolejnej próby w `download_attempts`.
    if (downloadResult.errorCode === KSEF_RATE_LIMIT_PAUSE) {
      throw upoPauseError(invoiceId, downloadResult.retryAfterMs ?? KSEF_PAUSE_DEFAULT_MS);
    }
    await step.run('mark-failed', async () => {
      const { receipt } = await requireUpoBoundary(identity, upoRecord.id);
      const { data: updated, error } = await createAdminClient().from('upo_receipts')
        .update({ status: 'failed', last_error: downloadResult.error,
          download_attempts: receipt.download_attempts + 1 })
        .eq('id', upoRecord.id).eq('tenant_id', tenantId)
        .eq('invoice_id', invoiceId).eq('ksef_number', ksefNumber)
        .in('status', ['pending', 'failed'])
        .select('id, tenant_id, invoice_id, ksef_number, ksef_environment').single();
      if (error || !updated) throw new Error('Nie można zapisać nieudanego pobrania UPO');
      assertUpoReceipt(updated, identity, upoRecord.id);
    });
    if (downloadResult.retryable) throw new Error(downloadResult.error);
    throw new NonRetriableError(downloadResult.error);
  }

  const xmlPath = await step.run('upload-xml-to-r2', async () => {
    await requireUpoBoundary(identity, upoRecord.id);
    return uploadUpoXml(tenantId, invoiceId, downloadResult.upoXml);
  });
  const pdfPath = await step.run('generate-and-upload-pdf', async () => {
    const { invoice } = await requireUpoBoundary(identity, upoRecord.id);
    const tenants = invoice.tenants as
      | { name: string; nip: string }
      | { name: string; nip: string }[]
      | null;
    const tenantRow = Array.isArray(tenants) ? tenants[0] : tenants;
    const pdfBuffer = await generateUpoPdf({
      ksefNumber, invoiceNumber: invoice.internal_number, issueDate: invoice.issue_date,
      sellerName: tenantRow?.name ?? '', sellerNip: tenantRow?.nip ?? invoice.seller_nip ?? '',
      buyerName: stringFromBuyerData(invoice.buyer_data), buyerNip: invoice.buyer_nip ?? '',
      grossAmount: Number(invoice.gross_total ?? 0),
      acceptanceTimestamp: downloadResult.acceptanceTimestamp,
      upoId: downloadResult.upoId, upoXmlHash: downloadResult.upoXmlHash,
    });
    await requireUpoBoundary(identity, upoRecord.id);
    return uploadUpoPdf(tenantId, invoiceId, pdfBuffer);
  });
  await step.run('finalize-upo-record', async () => {
    await requireUpoBoundary(identity, upoRecord.id);
    const { data: updated, error } = await createAdminClient().from('upo_receipts')
      .update({ status: 'downloaded', upo_xml_path: xmlPath, upo_pdf_path: pdfPath,
        upo_xml_hash: downloadResult.upoXmlHash, upo_id: downloadResult.upoId ?? null,
        ksef_acceptance_timestamp: downloadResult.acceptanceTimestamp,
        downloaded_at: new Date().toISOString(), last_error: null })
      .eq('id', upoRecord.id).eq('tenant_id', tenantId)
      .eq('invoice_id', invoiceId).eq('ksef_number', ksefNumber)
      .in('status', ['pending', 'failed', 'downloaded'])
      .select('id, tenant_id, invoice_id, ksef_number, ksef_environment').single();
    if (error || !updated) throw new Error('Nie można zakończyć pobrania UPO');
    assertUpoReceipt(updated, identity, upoRecord.id);
  });
  await step.run('audit-log', async () => {
    await requireUpoBoundary(identity, upoRecord.id);
    await logAuditSystem({ tenantId, action: 'invoice.upo_downloaded', entityType: 'invoice',
      entityId: invoiceId, metadata: { ksefNumber, upoId: downloadResult.upoId, xmlPath, pdfPath } });
  });
  return { success: true, ksefNumber, xmlPath, pdfPath };
}

