

import type { JobContext } from '@/lib/jobs/registry';
import { granicaArchiwizacji, terminUsunieciaPoArchiwizacji } from '@/lib/retention/terminy';
import { createAdminClient } from '@/lib/supabase/server';
import { uploadToGlacier } from '@/lib/storage/glacier';
import {
  downloadInvoiceXml,
  downloadInvoiceXmlUnchecked,
} from '@/lib/storage/r2';

/**
 * Cron codziennie o 3:00 PL — faktury starsze niż ~2 lata od daty wystawienia,
 * z zapisanym XML w R2: kopiujemy XML do S3 Glacier Deep Archive i zaraz po
 * wgraniu oznaczamy fakturę jednym zapisem: `archive_storage_path`,
 * `archived_at` i data usunięcia (`scheduled_deletion_at`).
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

    // Znaczniki z jednej chwili dla całego przebiegu. Termin usunięcia
    // policzony na starcie, z tej samej chwili co granica (NZ-RET-01).
    const marks = {
      archived_at: new Date().toISOString(),
      scheduled_deletion_at: terminUsuniecia,
    };

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

        // Oznaczenie zaraz po wgraniu, jednym UPDATE po `id` (plan skalowania
        // 3000, sesja 30). Wcześniej osobne kroki po pętli oznaczały wszystkie
        // kandydatki listą id w adresie (`id=in.(…)`): przy 500 to ok. 19,5 tys.
        // znaków, a nginx domyślnie przyjmuje 8 KB na wiersz żądania
        // (konfiguracji Konga z produkcji nie ma w repo). Zapis padał po wgraniu
        // plików, ponowienie wgrywało je od nowa i archiwum stało.
        //
        // Trzy kolumny jednym zapisem: faktura ma wszystkie albo żadnej.
        // `find-candidates` pomija faktury z `archived_at`, a
        // `cron.retention-delete` szuka tylko po `scheduled_deletion_at`, więc
        // `archived_at` bez daty usunięcia oznaczałoby fakturę, której nikt nie
        // usunie. Ponowienie (pg-boss wykonuje cały handler od nowa, bez pamięci
        // kroków) pomija faktury już oznaczone: drugi raz idzie tylko ta, której
        // zapis się nie udał. Warunek `archived_at IS NULL` chroni datę
        // usunięcia faktury oznaczonej w tym czasie przez inny przebieg.
        const { error: upErr } = await supabase
          .from('invoices')
          .update({ archive_storage_path: glacierKey, ...marks })
          .eq('id', candidate.id)
          .is('archived_at', null);

        if (upErr) {
          throw new Error(
            `Archive marks update failed for ${candidate.id}: ${upErr.message}`
          );
        }

        return { glacierKey };
      });
    }

    return { archived: candidates.length };
}

