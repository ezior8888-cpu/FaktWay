import 'server-only';

import { revalidatePath } from 'next/cache';

import { FILE_IMPORT_SOURCES, type FileImportSource } from '@/lib/import/file-sources';
import { uploadImportFile } from '@/lib/import/file-storage';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import { formatJobSendError } from '@/lib/jobs/error-message';
import { importFileUploaded } from '@/lib/jobs/events';
import type { AuthContext } from '@/lib/supabase/auth-context';
import { formatUploadSize, UPLOAD_FILE_LIMIT_BYTES, UPLOAD_FILE_LIMIT_LABEL } from '@/lib/upload-limit';

/**
 * Import z pliku CSV (Fakturownia, inFakt, wFirma, iFirma): zadanie
 * `import_jobs`, plik w magazynie, zdarzenie dla workera. Do sesji 31 planu
 * skalowania to było ciało `startFileImportAction`; teraz woła je trasa
 * `/api/uploads/import` po bramce z `lib/uploads/server.ts` (sesja, 2FA,
 * członkostwo w aktywnej firmie).
 *
 * NIE eksportuj tego z pliku `'use server'`: każdy taki eksport to publiczna
 * końcówka.
 *
 * Decyzja Bartosza 22.10.2026: tylko cztery programy, bez ogólnego JPK_FA.
 */


export type FileImportOutcome =
  | { success: true; importJobId: string }
  | { success: false; error: string; status: number };

export async function startFileImport(
  context: Pick<AuthContext, 'supabase' | 'user' | 'tenantId'>,
  formData: FormData,
): Promise<FileImportOutcome> {
  const { supabase, user, tenantId: activeOrg } = context;

  const file = formData.get('file');
  const sourceRaw = formData.get('source');
  const tenantIdRaw = formData.get('tenantId');

  if (!(file instanceof File) || !sourceRaw || !tenantIdRaw) {
    return { success: false, status: 400, error: 'Brakujące dane' };
  }

  const source = typeof sourceRaw === 'string' ? sourceRaw.trim() : String(sourceRaw);
  const tenantId = typeof tenantIdRaw === 'string' ? tenantIdRaw.trim() : String(tenantIdRaw);

  if (!FILE_IMPORT_SOURCES.includes(source as FileImportSource)) {
    return { success: false, status: 400, error: 'Nieobsługiwane źródło pliku.' };
  }

  if (file.size === 0) {
    return { success: false, status: 400, error: 'Plik jest pusty.' };
  }

  if (file.size > UPLOAD_FILE_LIMIT_BYTES) {
    return {
      success: false,
      status: 413,
      error: `Plik ma ${formatUploadSize(file.size)}, a można wgrać najwyżej ${UPLOAD_FILE_LIMIT_LABEL}. Wyeksportuj krótszy okres (np. kwartał) i wgraj pliki po kolei.`,
    };
  }

  if (activeOrg !== tenantId) {
    return { success: false, status: 403, error: 'Brak uprawnień' };
  }

  const sourceTyped = source as FileImportSource;

  const { data: job, error: jobError } = await supabase
    .from('import_jobs')
    .insert({
      tenant_id: tenantId,
      triggered_by: user.id,
      source: sourceTyped,
      status: 'pending',
      source_filename: file.name,
      source_file_size: file.size,
      progress_message: 'Wgrywanie pliku...',
    })
    .select('id')
    .single();

  if (jobError || !job) {
    return { success: false, status: 500, error: jobError?.message ?? 'Błąd tworzenia jobu' };
  }

  const failJob = async (message: string) => {
    await supabase
      .from('import_jobs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        progress_percent: 100,
        progress_message: message.slice(0, 900),
      })
      .eq('id', job.id);
  };

  let filePath: string;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    filePath = await uploadImportFile(tenantId, job.id, file.name, buffer, file.type?.trim() || 'application/octet-stream');
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Błąd zapisu pliku.';
    await failJob(msg);
    return { success: false, status: 500, error: msg };
  }

  const { error: pathErr } = await supabase.from('import_jobs').update({ source_file_path: filePath }).eq('id', job.id);

  if (pathErr) {
    await failJob(pathErr.message);
    return { success: false, status: 500, error: pathErr.message };
  }

  try {
    await sendJobEvent(
      importFileUploaded.create({
        importJobId: job.id,
        tenantId,
        filePath,
        source: sourceTyped,
      }),
    );
  } catch (e) {
    const friendly = formatJobSendError(e);
    await failJob(friendly);
    return { success: false, status: 500, error: friendly };
  }

  revalidatePath('/import-danych');
  revalidatePath('/onboarding/import-source');
  revalidatePath(`/onboarding/progress/${job.id}`);

  return { success: true, importJobId: job.id };
}
