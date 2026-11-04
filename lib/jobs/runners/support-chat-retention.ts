// Cron job: retencja rozmów z czatem pomocy — „do 24 miesięcy od ostatniej
// wiadomości” (polityka prywatności, pkt 3). Logika: lib/support/retention.ts.
//
// Trigger: codziennie o 03:30 PL. Przy kadencji miesięcznej rozmowa żyłaby do
// 25 miesięcy, a polityka mówi „do 24”. Przebieg jest lekki: kandydatami są
// tylko rozmowy założone przed terminem i rozmowy bez właściciela.
//
// Ponowienie: przebieg jest idempotentny (usuwa tylko to, co zostało), więc
// ponowienie od zera po błędzie w połowie nie dubluje skutków.

import * as Sentry from '@sentry/nextjs';

import type { JobContext } from '@/lib/jobs/registry';
import { createAdminClient } from '@/lib/supabase/admin';
import { purgeExpiredSupportConversations } from '@/lib/support/retention';

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-a.ts (kolejka cron.support-chat-retention).
 */
export async function runSupportChatRetention({ step }: JobContext) {
  const supabase = createAdminClient();

  const result = await step.run('purge', () => purgeExpiredSupportConversations(supabase, new Date()));

  Sentry.addBreadcrumb({
    category: 'db.cleanup',
    level: 'info',
    message: 'support chat retention completed',
    data: { ...result },
  });

  // Pułap stron osiągnięty: reszta poczeka do jutra, ale przy stałym
  // przekraczaniu rozmowy żyją dłużej niż obiecuje polityka.
  if (result.truncated) {
    Sentry.captureMessage('support chat retention: pułap stron, reszta w następnym przebiegu', {
      level: 'warning',
      extra: { ...result },
    });
  }

  return result;
}
