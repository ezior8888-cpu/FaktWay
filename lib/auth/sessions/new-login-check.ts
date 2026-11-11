import { authLoginCompleted } from '@/lib/jobs/events';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import { logger } from '@/lib/observability/logger';

/**
 * Zleca sprawdzenie, czy właśnie zapisane logowanie jest z nowego urządzenia
 * (mail bezpieczeństwa, krok 8.5 część 2). Wołane z miejsc, które zapisują
 * `auth.login`: hasło, biometria, `/auth/callback`, rejestracja z otwartą sesją.
 *
 * Klucz zlecenia to identyfikator sesji. Na naszych kolejkach (polityka
 * `standard`) sam `singletonKey` niczego nie deduplikuje (zob. `lib/jobs/enqueue.ts`),
 * więc przed drugim mailem chroni klucz idempotencji dostawcy poczty w runnerze.
 *
 * Nie rzuca: awaria kolejki nie może zatrzymać logowania. Skutek: to jedno
 * logowanie nie dostanie maila (ślad w logu kontenera), a lista urządzeń
 * w Ustawieniach pokazuje je i tak.
 */
export async function requestNewLoginCheck(input: {
  userId: string;
  sessionId: string | null | undefined;
}): Promise<void> {
  if (!input.sessionId) return;
  try {
    const event = authLoginCompleted.create({ userId: input.userId, sessionId: input.sessionId });
    await sendJobEvent({ ...event, singletonKey: `new-login/${input.sessionId}` });
  } catch (error) {
    logger.error('[auth] new_login_check_not_queued', error instanceof Error ? error.message : 'unknown');
  }
}
