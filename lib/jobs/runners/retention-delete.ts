

import type { JobContext } from '@/lib/jobs/registry';
import { createAdminClient } from '@/lib/supabase/server';
import { logAuditSystem } from '@/lib/audit/log-system';
import {
  collectInvoiceStorageKeys,
  deleteInvoiceStorage,
  type RetainedInvoice,
} from '@/lib/retention/invoice-files';

/**
 * Cron codziennie o 4:00 PL: usuwa faktury, których `scheduled_deletion_at`
 * już minął. Termin zapisuje archiwizacja: północ po dniu „archiwizacja plus
 * 8 lat”, czyli co najmniej 10 lat od wystawienia (`lib/retention/terminy.ts`).
 *
 * HARD DELETE — `invoice_line_items`, `ksef_submissions`, `xml_documents`
 * kasują się kaskadowo (FK ON DELETE CASCADE w schemacie). Najpierw pliki
 * w R2 i Glacier (`lib/retention/invoice-files.ts`), potem wiersz: odwrotna
 * kolejność zostawiała pliki bez śladu w bazie (AUD-45). Faktura, której
 * plików nie udało się usunąć, czeka do następnego przebiegu.
 */
/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-a.ts (kolejka cron.retention-delete).
 */
export async function runRetentionDelete({ step, logger }: JobContext) {
    const nowIso = new Date().toISOString();

    const candidates = await step.run('find-candidates', async () => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from('invoices')
        .select('id, tenant_id, internal_number, issue_date, xml_storage_path, pdf_storage_path, archive_storage_path')
        .not('scheduled_deletion_at', 'is', null)
        .lt('scheduled_deletion_at', nowIso)
        .limit(100);

      if (error) throw new Error(`Find candidates failed: ${error.message}`);
      return data ?? [];
    });

    if (candidates.length === 0) return { deleted: 0 };

    logger.info(`Usuwam ${candidates.length} faktur (retencja)`);

    const purged: string[] = [];
    for (const invoice of candidates) {
      const result = await step.run(`purge-files-${invoice.id}`, async () => {
        try {
          const keys = await collectInvoiceStorageKeys(createAdminClient(), invoice as RetainedInvoice);
          const filesDeleted = await deleteInvoiceStorage(keys);
          await logAuditSystem({
            action: 'retention.deletion_executed',
            tenantId: invoice.tenant_id,
            entityType: 'invoice',
            entityId: invoice.id,
            metadata: {
              internalNumber: invoice.internal_number,
              reason: '10-year retention expired',
              filesDeleted,
              foreignKeysSkipped: keys.foreign,
            },
          });
          return { ok: true as const };
        } catch (e) {
          logger.error('Retencja: pliki faktury nieusunięte — wiersz zostaje do następnego przebiegu', {
            invoiceId: invoice.id,
            error: e instanceof Error ? e.message : String(e),
          });
          return { ok: false as const };
        }
      });
      if (result.ok) purged.push(invoice.id);
    }

    if (purged.length === 0) return { deleted: 0, pending: candidates.length };

    await step.run('delete-invoices', async () => {
      const supabase = createAdminClient();
      const { error } = await supabase.from('invoices').delete().in('id', purged);
      if (error) throw new Error(`Delete invoices failed: ${error.message}`);
    });

    return { deleted: purged.length, pending: candidates.length - purged.length };
}

