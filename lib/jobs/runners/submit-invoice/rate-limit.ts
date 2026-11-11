/**
 * Pauza firmy po 429 z KSeF w jobie wysyłki (L1a, `lib/ksef/rate-limit-pause.ts`):
 * rozpoznanie 429, zwolnienie przejęcia na czas pauzy, alarm hamulca 429.
 * Wydzielone z `../submit-invoice.ts` bez zmiany logiki (plan usprawnień 3.7a);
 * `releaseOwnClaimBeforeWait` i `rateLimitPause` były domknięciami w runnerze.
 */
import * as Sentry from '@sentry/nextjs';
import type { RetryAfterError } from '../../errors';
import type { KsefEnvironment } from '@/types/ksef';
import { createAdminClient } from '@/lib/supabase/server';
import { isKsefLocalPause, isKsefRateLimitResponse, KsefApiError } from '@/lib/ksef/client';
import {
  KSEF_PAUSE_DEFAULT_MS,
  ksefPauseRetryError,
  recordKsefRateLimit,
} from '@/lib/ksef/rate-limit-pause';
import type { SubmitRunContext } from './shared';

/**
 * Kod pauzy limitu w logach (L1a). Nie `KSEF_PAUSED` ani znacznik
 * `[KSEF_PAUSED]` — to wyłącznik operatora (klasa hold, cron I7).
 */
export const KSEF_RATE_LIMIT_PAUSE = 'KSEF_RATE_LIMIT_PAUSE';

/** 429 z KSeF: prawdziwa odpowiedź MF albo lokalna pauza firmy (żądanie nie wyszło). */
export function isKsefRateLimit(error: unknown): error is KsefApiError {
  return isKsefRateLimitResponse(error) || (error instanceof KsefApiError && isKsefLocalPause(error));
}

/**
 * L1a: zwolnienie przejęcia wysyłki na czas pauzy firmy po 429. Karta L1a:
 * „czekanie wypada przed przejęciem wysyłki albo po jego zwolnieniu, nigdy
 * z fakturą w `sending`”. Pauza trwa tyle, ile podał MF (do doby), a faktura
 * w `sending` po 15 min włącza alarm `stale_ksef_sending_invoices`
 * (`critical-alerts-monitor.ts`), po 30 min jest naruszeniem I2 cyklu życia.
 *
 * Warunkowy UPDATE `sending` → `queued` tylko dla własnego przejęcia tej
 * próby (`ksef_send_owner` = `sendAttemptId`): przyjęcie przez inny worker
 * i cudza dzierżawa wygrywają. `ksef_send_owner` i `submitted_to_ksef_at`
 * ZOSTAJĄ — po pauzie `claim_ksef_send` tym samym właścicielem przejdzie od
 * razu (00124), a inna próba dopiero po końcu dzierżawy, więc dwie wysyłki
 * naraz dalej są niemożliwe. Wyzwalacze 00119/00132/00148 dopuszczają to
 * przejście dla service_role. `queued` z zaplanowanym ponowieniem w pg-boss
 * nie jest naruszeniem I1; gdyby zlecenie zginęło, I1 woła
 * `release_ksef_enqueue`, które fakturze z dowodem kontaktu odmawia powrotu
 * do szkicu (`ENQUEUE_LOST` dla operatora).
 *
 * Bez `sendAttemptId` (zdarzenia sprzed AUD-10) nie zwalniamy — nie wiadomo,
 * czyje to przejęcie. Błąd zapisu = zwykły `Error` (ponowienie): pauza
 * z fakturą w `sending` to dokładnie stan, którego karta zabrania.
 */
export async function releaseSendClaimForPause(
  invoiceId: string,
  tenantId: string,
  owner: string | null | undefined,
): Promise<boolean> {
  if (!owner) return false;
  const { data, error } = await (await createAdminClient())
    .from('invoices')
    .update({ ksef_status: 'queued' })
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .eq('ksef_status', 'sending')
    .eq('ksef_send_owner', owner)
    .select('id')
    .maybeSingle();
  if (error) throw new Error('Nie można zwolnić przejęcia wysyłki faktury na czas pauzy KSeF');
  return data?.id === invoiceId;
}

/** Alarm hamulca 429 najwyżej raz na tyle ms na środowisko (każde zatrzymane zadanie to nie nowy alarm). */
const SEND_BRAKE_ALERT_INTERVAL_MS = 10 * 60_000;
const lastSendBrakeAlertAt = new Map<KsefEnvironment, number>();

/**
 * Hamulec 429 (L1a): wiele firm dostało 429 w ostatnich 10 minutach — sygnał,
 * że MF ogranicza nasz adres IP, nie jedną firmę (M11). To NIE hamulec
 * operatora (`KSEF_PAUSED`, `KOR_HOLD`): sam się zdejmuje, gdy okno minie.
 */
export function reportSendBrake(env: KsefEnvironment, extra: Record<string, unknown>): void {
  const now = Date.now();
  const last = lastSendBrakeAlertAt.get(env);
  if (last !== undefined && now - last < SEND_BRAKE_ALERT_INTERVAL_MS) return;
  lastSendBrakeAlertAt.set(env, now);
  Sentry.captureMessage('KSeF: hamulec 429, wiele firm z 429 naraz, wysyłka zwolniona', {
    level: 'warning',
    tags: { job: 'submit-invoice', kind: 'ksef-rate-limit-brake', env },
    fingerprint: ['ksef-rate-limit-brake'],
    extra: { env, ...extra },
  });
}

/**
 * L1a: własne przejęcie tej próby (`sending` po wcześniejszym wykonaniu,
 * np. po 503 albo padniętym workerze) zwalniamy przed czekaniem — pauza
 * nie może trzymać faktury w `sending` (`releaseSendClaimForPause`).
 * Świeży odczyt, bo stan z `current` nie niesie właściciela przejęcia.
 */
export async function releaseOwnClaimBeforeWait(ctx: SubmitRunContext): Promise<void> {
  const { parsed, tenantId, invoiceId } = ctx;
  const owner = parsed.data.sendAttemptId;
  if (!owner) return;
  const { data: row, error } = await (await createAdminClient())
    .from('invoices')
    .select('ksef_status, ksef_send_owner')
    .eq('id', invoiceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw new Error('Nie można sprawdzić przejęcia wysyłki faktury przed pauzą KSeF');
  if (row?.ksef_status === 'sending' && row.ksef_send_owner === owner) {
    await releaseSendClaimForPause(invoiceId, tenantId, owner);
  }
}

/**
 * L1a: 429 PO przejęciu wysyłki (odpowiedź MF albo lokalna pauza firmy) —
 * zwolnienie przejęcia i pauza do końca blokady, bez zużycia próby.
 * Prawdziwy 429 zapisuje pauzę firmy (tylko wydłużanie; `ksefFetch` robi to
 * już przy samej odpowiedzi, tu także dla błędu spoza kontekstu NIP-u).
 * Lokalna pauza niczego nie odnawia: czeka pozostały czas. `cause` niesie
 * oryginalny `KsefApiError` (dziennik prób, klasyfikacja po wyczerpaniu).
 */
export async function rateLimitPause(
  ctx: SubmitRunContext,
  error: KsefApiError,
  authNip: string | null | undefined,
  message: string,
  cause: unknown = error,
): Promise<RetryAfterError> {
  const { parsed, tenantId, invoiceId, nip, env, attempt, logger } = ctx;
  const local = isKsefLocalPause(error);
  const remaining = local
    ? error.retryAfterMs ?? KSEF_PAUSE_DEFAULT_MS
    : (await recordKsefRateLimit(env, authNip ?? nip, error.retryAfterMs)) - Date.now();
  const released = await releaseSendClaimForPause(invoiceId, tenantId, parsed.data.sendAttemptId);
  logger.warn('429 z KSeF po przejęciu wysyłki: firma w pauzie, przejęcie zwolnione', {
    code: KSEF_RATE_LIMIT_PAUSE,
    tenantId,
    invoiceId,
    attempt,
    localPause: local,
    released,
    remainingMs: remaining,
  });
  return ksefPauseRetryError(`${message}: ${error.message}`, remaining, invoiceId, cause);
}
