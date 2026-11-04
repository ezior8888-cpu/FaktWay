

import type { JobContext } from '@/lib/jobs/registry';
import { createAdminClient } from '@/lib/supabase/server';
import { uploadToGlacier } from '@/lib/storage/glacier';
import {
  downloadInvoiceXml,
  downloadInvoiceXmlUnchecked,
} from '@/lib/storage/r2';

/**
 * Cron codziennie o 3:00 PL — faktury starsze niż ~2 lata od daty wystawienia,
 * z zapisanym XML w R2: kopiujemy XML do S3 Glacier Deep Archive, zapisujemy
 * `archive_storage_path`, potem oznaczamy `archived_at`.
 */
/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-a.ts (kolejka cron.archive-old-invoices).
 */
export async function runArchiveOldInvoices({ step, logger }: JobContext) {
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const issueBefore = twoYearsAgo.toISOString().slice(0, 10);

    const candidates = await step.run('find-candidates', async () => {
      const supabase = createAdminClient();
      const { data, error } = await supabase
        .from('invoices')
        .select('id, tenant_id, issue_date, xml_storage_path')
        .lt('issue_date', issueBefore)
        .is('archived_at', null)
        .not('xml_storage_path', 'is', null)
        // historia z KSeF: oryginał jest w KSeF; Glacier dla niej dopiero po
        // potwierdzeniu konfiguracji AWS na produkcji — decyzja Bartosza 22.10.2026
        .neq('origin', 'ksef_import')
        .limit(500);

      if (error) throw new Error(`Find candidates failed: ${error.message}`);
      return data ?? [];
    });

    logger.info(`Znaleziono ${candidates.length} faktur do archiwizacji`);

    if (candidates.length === 0) return { archived: 0 };

    const ids = candidates.map((c) => c.id);

    for (const candidate of candidates) {
      await step.run(`glacier-${candidate.id}`, async () => {
        if (!candidate.xml_storage_path) return { skipped: true };

        const supabase = createAdminClient();
        const { data: xmlDoc } = await supabase
          .from('xml_documents')
          .select('sha256_hash')
          .eq('storage_path', candidate.xml_storage_path)
          .eq('tenant_id', candidate.tenant_id)
          .eq('invoice_id', candidate.id)
          .maybeSingle();

        const hash = xmlDoc?.sha256_hash as string | undefined;
        const xml = hash
          ? await downloadInvoiceXml(candidate.xml_storage_path, hash, candidate.tenant_id)
          : await downloadInvoiceXmlUnchecked(candidate.xml_storage_path, candidate.tenant_id);

        const glacierKey = await uploadToGlacier(
          candidate.tenant_id as string,
          candidate.id as string,
          String(candidate.issue_date),
          xml
        );

        const { error: upErr } = await supabase
          .from('invoices')
          .update({ archive_storage_path: glacierKey })
          .eq('id', candidate.id);

        if (upErr) {
          throw new Error(
            `archive_storage_path update failed for ${candidate.id}: ${upErr.message}`
          );
        }

        return { glacierKey };
      });
    }

    await step.run('mark-archived', async () => {
      const supabase = createAdminClient();
      const { error } = await supabase
        .from('invoices')
        .update({
          archived_at: new Date().toISOString(),
        })
        .in('id', ids);

      if (error) throw new Error(`Mark archived failed: ${error.message}`);
    });

    await step.run('schedule-deletion', async () => {
      const supabase = createAdminClient();
      const deletionDate = new Date();
      deletionDate.setFullYear(deletionDate.getFullYear() + 8);

      const { error } = await supabase
        .from('invoices')
        .update({ scheduled_deletion_at: deletionDate.toISOString() })
        .in('id', ids);

      if (error) throw new Error(`Schedule deletion failed: ${error.message}`);
    });

    return { archived: candidates.length };
}

