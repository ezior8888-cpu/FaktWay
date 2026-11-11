'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { mfaStepUpHref } from '@/lib/auth/mfa-step-up';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { setKsefHistoryClientPause } from '@/lib/ksef/history-sync/client-pause';
import { ActionAuthError, requireOwner } from '@/lib/supabase/auth-context';

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

// Import z pliku nie jest już Server Action (plan skalowania, sesja 31: plik
// ponad 1 MB nie mieścił się w ciele akcji): trasa `app/api/uploads/import/route.ts`,
// ciało `lib/import/start-file-import.ts`, źródła `lib/import/file-sources.ts`.

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
