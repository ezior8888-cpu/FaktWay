/**
 * Krok transakcji kolejkowania wysyłki do KSeF (cykl życia faktury, PR 3).
 *
 * Przejście stanu faktury (`draft → queued` albo `failed → queued`) robi RPC
 * z 00131 po stronie serwera — na TYM SAMYM połączeniu i w tej samej
 * transakcji, w której pg-boss zapisuje zlecenie (`sendJobEvent(...,
 * { inTransaction })`). Dzięki temu nie ma faktury w `queued` bez zlecenia
 * ani zlecenia bez statusu (W16/W2 z rewizji 03.10.2026). Sesja klienta
 * nigdy nie pisze `ksef_status`.
 *
 * Moduł celowo bez zależności od Next i Supabase: ten sam krok wykonuje test
 * na prawdziwej bazie (`tests/rls-kolejkowanie-wysylki.test.ts`).
 */

import type { Db } from 'pg-boss';

import { formatJobSendError } from '@/lib/jobs/error-message';

export type KsefSendMode =
  /** Pierwsza wysyłka: `draft → queued` (`enqueue_ksef_send`). */
  | { kind: 'enqueue' }
  /**
   * Ponowna wysyłka: `failed → queued` (`requeue_ksef_send`); z `rejected`
   * tylko w trybie „tylko uzgodnij” (job zaczyna od uzgodnienia po referencji).
   * `actorUserId: null` = automat (cron cyklu życia) — po tym cron rozpoznaje
   * swoje ponowienia w `audit_logs` i liczy je do limitu dobowego.
   */
  | { kind: 'requeue'; actorUserId: string | null; reconcileOnly?: boolean };

export interface KsefSendIds {
  invoiceId: string;
  tenantId: string;
  /** `sendAttemptId` zdarzenia — właściciel przejęcia wysyłki (00124). */
  attemptId: string;
}

type Tx = Pick<Db, 'executeSql'>;

/** Krok do `sendJobEvent(event, { inTransaction })`. Rzuca błędem Postgresa (`code`) przy odmowie RPC. */
export function ksefSendTransactionStep(mode: KsefSendMode, ids: KsefSendIds): (tx: Tx) => Promise<void> {
  return async (tx) => {
    if (mode.kind === 'requeue') {
      await tx.executeSql(
        'SELECT id FROM public.requeue_ksef_send($1::uuid, $2::uuid, $3::text, $4::uuid, $5::boolean)',
        [ids.invoiceId, ids.tenantId, ids.attemptId, mode.actorUserId, mode.reconcileOnly ?? false],
      );
      return;
    }
    await tx.executeSql(
      'SELECT id FROM public.enqueue_ksef_send($1::uuid, $2::uuid, $3::text)',
      [ids.invoiceId, ids.tenantId, ids.attemptId],
    );
  };
}

/** Odmowa `enqueue_ksef_send` (P0002): faktura nie jest już szkicem — np. drugie kliknięcie. */
export const KSEF_ALREADY_QUEUED_MESSAGE = 'Ta faktura jest już wysyłana albo nie jest szkicem.';

/** Odmowa `requeue_ksef_send` (P0002): brak faktury w firmie. */
export const KSEF_REQUEUE_NOT_FOUND_MESSAGE = 'Nie znaleziono faktury w tej organizacji.';

/** Brak uprawnień roli połączenia do RPC (42501) — błąd konfiguracji, nie klienta. */
export const KSEF_SEND_FORBIDDEN_MESSAGE =
  'Serwer nie ma uprawnień do uruchomienia wysyłki. Faktura została zapisana — zgłoś to operatorowi.';

/** 00135: tekst 23505 RPC, gdy inna korekta tej samej faktury pierwotnej jest w toku. */
export const OPEN_CORRECTION_CONFLICT_PREFIX = 'Faktura pierwotna ma korektę w toku';

/** Konflikt korekty (00135) — tylko ten 23505; każdy inny naruszony klucz to błąd. */
export function isOpenCorrectionConflict(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  return code === '23505' && typeof message === 'string' && message.startsWith(OPEN_CORRECTION_CONFLICT_PREFIX);
}

/**
 * Komunikat dla klienta po nieudanym kolejkowaniu. Komunikaty P0001 piszą RPC
 * z 00131 wprost dla klienta („wróć do szkicu i popraw” itd.), więc idą bez zmian.
 */
export function describeKsefSendError(error: unknown, mode: KsefSendMode): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error ? error.message : '';
  if (code === 'P0002') {
    return mode.kind === 'enqueue' ? KSEF_ALREADY_QUEUED_MESSAGE : KSEF_REQUEUE_NOT_FOUND_MESSAGE;
  }
  if (code === 'P0001' && message) return message;
  if (code === '42501') return KSEF_SEND_FORBIDDEN_MESSAGE;
  return formatJobSendError(error);
}
