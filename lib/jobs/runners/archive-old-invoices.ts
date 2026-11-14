

import type { JobContext } from '@/lib/jobs/registry';
import { inListChunks } from '@/lib/pagination/in-list';
import { granicaArchiwizacji, terminUsunieciaPoArchiwizacji } from '@/lib/retention/terminy';
import { createAdminClient } from '@/lib/supabase/server';
import { uploadToGlacier } from '@/lib/storage/glacier';
import {
  downloadInvoiceXml,
  downloadInvoiceXmlUnchecked,
} from '@/lib/storage/r2';

/**
 * Cron codziennie o 3:00 PL — faktury starsze niż ~2 lata od daty wystawienia,
 * z zapisanym XML w R2: kopiujemy XML do S3 Glacier Deep Archive, zapisujemy
 * `archive_storage_path`, potem jednym zapisem `archived_at` i termin usunięcia
 * `scheduled_deletion_at` (usuwa `cron.retention-delete`).
 */
/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-a.ts (kolejka cron.archive-old-invoices).
 */
export async function runArchiveOldInvoices({ step, logger }: JobContext) {
    // Granica i termin usunięcia z tej samej chwili, dni w Polsce
    // (lib/retention/terminy.ts, NZ-RET-01: usunięcie po 10 latach od wystawienia).
    // Oba liczone przed pierwszym zapisem: błąd daty zatrzymuje przebieg na starcie.
    const teraz = new Date();
    const issueBefore = granicaArchiwizacji(teraz);
    const terminUsuniecia = terminUsunieciaPoArchiwizacji(teraz);

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

    // Zapisy paczkami (FZ-011): `.in('id', …)` trafia do adresu PATCH, a 500
    // identyfikatorów to ok. 19 KB, ponad limit wiersza żądania bramki.
    const paczki = inListChunks(candidates.map((c) => c.id as string));

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

    // Archiwizacja i termin usunięcia jednym zapisem (FZ-009): ponowienie
    // zaczyna od zera i bierze tylko faktury bez `archived_at`, więc błąd
    // między dwoma osobnymi zapisami zostawiał fakturę na zawsze bez terminu.
    await step.run('mark-archived', async () => {
      const supabase = createAdminClient();
      // Każda paczka jednym zapisem obu kolumn: błąd w kolejnej paczce zostawia
      // poprzednie z terminem, a pozostałe bez `archived_at` bierze ponowienie.
      const archivedAt = new Date().toISOString();
      for (const paczka of paczki) {
        const { error } = await supabase
          .from('invoices')
          .update({ archived_at: archivedAt, scheduled_deletion_at: terminUsuniecia })
          .in('id', paczka);
        if (error) throw new Error(`Mark archived failed: ${error.message}`);
      }
    });

    return { archived: candidates.length };
}

