'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { mfaStepUpHref } from '@/lib/auth/mfa-step-up';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { uploadImportFile } from '@/lib/import/file-storage';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import { formatJobSendError } from '@/lib/jobs/error-message';
import { importFileUploaded } from '@/lib/jobs/events';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { setKsefHistoryClientPause } from '@/lib/ksef/history-sync/client-pause';
import { ActionAuthError, requireOwner, requireUserAndActiveOrg } from '@/lib/supabase/auth-context';

/**
 * Akcje ekranu Import danych i kroku onboardingu „Skąd przenosisz dane?”.
 *
 * Decyzja Bartosza 22.10.2026: Magiczny import z KSeF znika. Historię z KSeF
 * FaktWay pobiera sam (`ksef-history-sync`, cron co 15 minut), więc tu nie ma
 * już startu importu z KSeF. Zostaje:
 * - import z pliku — tylko cztery duże programy (Fakturownia, inFakt, wFirma,
 *   iFirma). Ogólny „Inny program (JPK_FA)” zniknął z ekranu; dawne wiersze
 *   `jpk_fa` w historii i parser w workerze działają dalej;
 * - „Pomiń” w onboardingu;
 * - wstrzymanie i wznowienie pobierania historii z KSeF — tylko właściciel
 *   z potwierdzonym logowaniem dwuetapowym, jak przy wgrywaniu certyfikatu.
 */

// ============================================================================
// Import z pliku (CSV z czterech programów)
// ============================================================================

export type FileImportSource = 'fakturownia_csv' | 'infakt_csv' | 'wfirma_csv' | 'ifirma_csv';

export type FileImportActionResult = { success: true; importJobId: string } | { success: false; error: string };

/** Lista dozwolonych źródeł — decyzja Bartosza 22.10.2026: bez `jpk_fa`. */
const FILE_SOURCES: readonly FileImportSource[] = ['fakturownia_csv', 'infakt_csv', 'wfirma_csv', 'ifirma_csv'];

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function startFileImportAction(formData: FormData): Promise<FileImportActionResult> {
  let context;
  try {
    context = await requireUserAndActiveOrg();
  } catch (error) {
    if (error instanceof ActionAuthError) return { success: false, error: error.message };
    throw error;
  }
  const { supabase, user, tenantId: activeOrg } = context;

  const file = formData.get('file');
  const sourceRaw = formData.get('source');
  const tenantIdRaw = formData.get('tenantId');

  if (!(file instanceof File) || !sourceRaw || !tenantIdRaw) {
    return { success: false, error: 'Brakujące dane' };
  }

  const source = typeof sourceRaw === 'string' ? sourceRaw.trim() : String(sourceRaw);
  const tenantId = typeof tenantIdRaw === 'string' ? tenantIdRaw.trim() : String(tenantIdRaw);

  if (!FILE_SOURCES.includes(source as FileImportSource)) {
    return { success: false, error: 'Nieobsługiwane źródło pliku.' };
  }

  if (file.size === 0) {
    return { success: false, error: 'Plik jest pusty.' };
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return { success: false, error: 'Plik za duży (max 10 MB)' };
  }

  if (activeOrg !== tenantId) {
    return { success: false, error: 'Brak uprawnień' };
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
    return { success: false, error: jobError?.message ?? 'Błąd tworzenia jobu' };
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
    return { success: false, error: msg };
  }

  const { error: pathErr } = await supabase.from('import_jobs').update({ source_file_path: filePath }).eq('id', job.id);

  if (pathErr) {
    await failJob(pathErr.message);
    return { success: false, error: pathErr.message };
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
    return { success: false, error: friendly };
  }

  revalidatePath('/import-danych');
  revalidatePath('/onboarding/import-source');
  revalidatePath(`/onboarding/progress/${job.id}`);

  return { success: true, importJobId: job.id };
}

// ============================================================================
// „Pomiń” w onboardingu
// ============================================================================

/**
 * „Pomiń — wejdę do aplikacji”: przekierowanie po stronie serwera na Pulpit
 * (`?welcome=1` otwiera okno powitalne). Kolejne żądanie idzie już
 * z aktualnymi ciasteczkami (sesja i aktywna organizacja).
 */
export async function skipImportStepAction(): Promise<void> {
  redirect('/dashboard?welcome=1');
}

// ============================================================================
// Wstrzymanie pobierania historii z KSeF (tylko właściciel, decyzja Bartosza 22.10.2026)
// ============================================================================

const PAUSE_ERROR_PATH = '/import-danych?wstrzymanie=blad';
const PAUSE_MFA_PATH = '/import-danych?wstrzymanie=2fa';

/**
 * Formularz karty „Historia z KSeF” (`paused` = `1` wstrzymuje, `0` wznawia).
 * Wstrzymanie zatrzymuje tylko pobieranie historii — wysyłka faktur
 * z FaktWay i Skrzynka KSeF działają dalej. Zapis i wpis w dzienniku
 * zdarzeń robi `setKsefHistoryClientPause`; tutaj jest tylko granica
 * uprawnień: właściciel aktywnej firmy, potem logowanie dwuetapowe
 * potwierdzone dokładnie tak jak przy wgrywaniu certyfikatu
 * (`uploadCertificateAction`).
 *
 * Właściciel bez potwierdzonego 2FA wraca z `?wstrzymanie=2fa` — ekran mówi,
 * co włączyć, i daje link do ustawień bezpieczeństwa (poprawka po
 * przeglądzie, decyzja Bartosza 22.10.2026: „spróbuj ponownie” nigdy by tu
 * nie pomogło). Każda inna odmowa i każdy błąd kończy się powrotem
 * z `?wstrzymanie=blad` („Nie udało się zmienić ustawienia — spróbuj
 * ponownie.”). Sukces wraca na czysty adres, żeby stary komunikat o błędzie
 * nie został na ekranie.
 */
export async function setKsefHistoryPausedAction(formData: FormData): Promise<void> {
  const outcome = await changeKsefHistoryPause(formData);
  if (outcome === 'mfa') redirect(PAUSE_MFA_PATH);
  // Sesja po biometrii ma już 2FA: „włącz” byłoby nieprawdą, wystarczy podać kod.
  if (outcome === 'mfa_code') redirect(mfaStepUpHref('/import-danych'));
  if (outcome !== 'ok') redirect(PAUSE_ERROR_PATH);
  revalidatePath('/import-danych');
  redirect('/import-danych');
}

/**
 * `ok` — ustawienie zapisane; `mfa` — właściciel bez włączonego
 * i potwierdzonego 2FA (bez zapisu); `error` — każda inna odmowa albo błąd
 * (bez szczegółów dla klienta).
 */
async function changeKsefHistoryPause(formData: FormData): Promise<'ok' | 'mfa' | 'mfa_code' | 'error'> {
  const raw = formData.get('paused');
  if (raw !== '1' && raw !== '0') return 'error';
  const paused = raw === '1';

  let context;
  try {
    context = await requireOwner();
  } catch (error) {
    if (error instanceof ActionAuthError) return 'error';
    throw error;
  }
  const { supabase, tenantId, user } = context;

  // Ten sam warunek co przy zmianie certyfikatu KSeF: MFA włączone i potwierdzone w tej sesji.
  const mfa = await getVerifiedMfaState(supabase).catch(() => null);
  if (!mfa || mfa.status === 'unauthenticated' || mfa.user.id !== user.id) return 'error';
  if (mfa.status === 'challenge_required') return 'mfa_code';
  if (mfa.status !== 'verified') return 'mfa';

  const environment = configuredKsefEnvironment();
  if (!environment) return 'error';

  try {
    const result = await setKsefHistoryClientPause({ tenantId, environment, paused, userId: user.id });
    return result.ok ? 'ok' : 'error';
  } catch (error) {
    console.error('[import-danych] wstrzymanie historii KSeF:', error instanceof Error ? error.name : 'błąd');
    return 'error';
  }
}
