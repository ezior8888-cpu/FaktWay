/**
 * Wyłącznik klienta: „Wstrzymaj pobieranie historii” (decyzja Bartosza
 * 22.10.2026 — zabezpieczenie zgody; punkt 12 krytyki).
 *
 * Klucz serwisowy: klient nie pisze do `ksef_history_sync` (00155). ROLI
 * TU NIE SPRAWDZAMY — robi to akcja serwera (`requireOwner` + potwierdzone
 * MFA, jak przy wgrywaniu certyfikatu). Pauza zatrzymuje wyłącznie wywołania
 * KSeF historii tej firmy; wysyłka faktur i Skrzynka KSeF działają dalej.
 *
 * Idempotentne: ponowne wstrzymanie zostawia pierwotną chwilę, ponowne
 * wznowienie nic nie zmienia. Każde wywołanie zapisuje audyt
 * (`ksef.history.paused` / `ksef.history.resumed`).
 */

import { logAudit } from '@/lib/audit/log';
import { createAdminClient } from '@/lib/supabase/admin';

import { asHistoryClient, ensureOutgoingStreams, type KsefHistoryEnvironment, type KsefHistorySyncRow } from './db';
import { historyFloorFor, initialOutgoingStream } from './windows';

export type KsefHistoryClientPauseResult =
  | { ok: true; pausedAt: string | null }
  | { ok: false; reason: 'write-failed' };

export async function setKsefHistoryClientPause(params: {
  tenantId: string;
  environment: KsefHistoryEnvironment;
  paused: boolean;
  userId: string;
}): Promise<KsefHistoryClientPauseResult> {
  const { tenantId, environment, paused, userId } = params;
  const admin = createAdminClient();
  const history = asHistoryClient(admin);
  const now = new Date();
  try {
    const { data: tenant, error: tenantError } = await admin
      .from('tenants')
      .select('business_started_on')
      .eq('id', tenantId)
      .maybeSingle();
    if (tenantError || !tenant) return { ok: false, reason: 'write-failed' };

    // Strumień może jeszcze nie istnieć (cron zakłada go do 15 minut po
    // weryfikacji) — wtedy zakładamy go tu, żeby pauza zadziałała od razu.
    await ensureOutgoingStreams(history, environment, [{
      tenantId,
      initial: initialOutgoingStream(now, historyFloorFor((tenant as { business_started_on: string | null }).business_started_on)),
    }]);

    const { data: current, error: readError } = await history
      .from('ksef_history_sync')
      .select('id, client_paused_at')
      .eq('tenant_id', tenantId)
      .eq('environment', environment)
      .eq('direction', 'outgoing')
      .maybeSingle();
    if (readError || !current) return { ok: false, reason: 'write-failed' };
    const row = current as Pick<KsefHistorySyncRow, 'id' | 'client_paused_at'>;

    const pausedAt = paused ? (row.client_paused_at ?? now.toISOString()) : null;
    const { error: writeError } = await history
      .from('ksef_history_sync')
      .update(paused
        ? { client_paused_at: pausedAt, client_paused_by: userId }
        : { client_paused_at: null, client_paused_by: null })
      .eq('id', row.id);
    if (writeError) return { ok: false, reason: 'write-failed' };

    await logAudit({
      action: paused ? 'ksef.history.paused' : 'ksef.history.resumed',
      tenantId,
      userId,
      entityType: 'ksef_history',
      entityId: row.id,
      // Przebieg w toku kończy się sam (najpóźniej po 90 s bez nowych wywołań
      // KSeF); nowy już nie wystartuje — dzierżawa wymaga braku pauzy klienta.
      metadata: {
        environment,
        changed: paused ? row.client_paused_at === null : row.client_paused_at !== null,
      },
    });
    return { ok: true, pausedAt };
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
}

/** Błędy firmy, które klient naprawia nowym certyfikatem. */
export const KSEF_HISTORY_CERTIFICATE_ERRORS = ['certificate_expired', 'credentials', 'permission'] as const;

/**
 * Po wgraniu NOWEGO certyfikatu (akcja serwera po `finalize_ksef_certificate_claim`)
 * czyści zapisany błąd firmy, który klient właśnie naprawił — ekran Import
 * danych nie każe wtedy wgrywać certyfikatu drugi raz, zanim najbliższy
 * przebieg potwierdzi sesję (poprawka po przeglądzie, decyzja Bartosza
 * 22.10.2026). Jeśli nowy certyfikat też nie działa, przebieg zapisze błąd
 * ponownie.
 *
 * Jeden warunkowy UPDATE (tylko błąd z listy) — idempotentny; inne błędy
 * (operatora, KSeF) zostają. Klucz serwisowy; roli nie sprawdza — robi to
 * akcja wgrania certyfikatu (właściciel + MFA). `ok: false` nie cofa wgrania:
 * błąd zniknie przy najbliższym udanym przebiegu.
 */
export async function clearKsefHistoryCertificateErrors(params: {
  tenantId: string;
  environment: KsefHistoryEnvironment;
}): Promise<{ ok: true; cleared: boolean } | { ok: false }> {
  try {
    const history = asHistoryClient(createAdminClient());
    const { data, error } = await history
      .from('ksef_history_sync')
      .update({ last_error_code: null, last_error_detail: null, last_error_at: null, consecutive_failures: 0 })
      .eq('tenant_id', params.tenantId)
      .eq('environment', params.environment)
      .eq('direction', 'outgoing')
      .in('last_error_code', [...KSEF_HISTORY_CERTIFICATE_ERRORS])
      .select('id');
    if (error) return { ok: false };
    return { ok: true, cleared: (data ?? []).length > 0 };
  } catch {
    return { ok: false };
  }
}
