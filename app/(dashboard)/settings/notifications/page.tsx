import { redirect } from 'next/navigation';

import { NotificationsSettings } from '@/components/pwa/notifications-settings';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import {
  getEmailConsents,
  getUnsubscribedCategories,
  type EmailCategory,
} from '@/lib/email/preferences';
import { getDashboardSessionUser } from '@/lib/dashboard-shell-data';
import { createClient } from '@/lib/supabase/server';
import type { Tables } from '@/types/database';

import { EmailPreferences } from './_components/email-preferences';

export const dynamic = 'force-dynamic';

/**
 * Zakładka „Powiadomienia” = Notifications z Finory (`views/settings/
 * notifications`): u góry push na urządzeniach, pod separatorem e-maile
 * (w Finorze w tym miejscu stoją „Quiet hours”).
 */
export default async function NotificationsPage() {
  // Ten sam użytkownik co w layoucie (`cache()` na żądanie) — bez drugiego wywołania GoTrue.
  const [supabase, user] = await Promise.all([createClient(), getDashboardSessionUser()]);
  if (!user) redirect('/login');

  const [{ data: subscriptions }, unsubscribed, consents] = await Promise.all([
    supabase
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false }),
    getUnsubscribedCategories(user.id).catch(() => null),
    getEmailConsents(user.id).catch(() => null),
  ]);

  // Przełącznik jest włączony tylko przy zgodzie i bez wypisu — tak samo,
  // jak decyduje wysyłka (`canSendTo`). Bez zgody pokazujemy „wyłączone”.
  const unsubscribedCategories: EmailCategory[] | null =
    unsubscribed && consents
      ? [
          ...new Set<EmailCategory>([
            ...unsubscribed,
            ...(['product_updates', 'marketing'] as const).filter((c) => !consents[c]),
          ]),
        ]
      : null;

  return (
    <div className="flex flex-col gap-6">
      <NotificationsSettings
        subscriptions={
          (subscriptions ?? []) as Tables<'push_subscriptions'>[]
        }
      />

      <Separator />

      {unsubscribedCategories === null ? (
        <Alert variant="destructive">
          <AlertDescription>Nie udało się odczytać ustawień email. Odśwież stronę, zanim je zmienisz.</AlertDescription>
        </Alert>
      ) : (
        <EmailPreferences unsubscribedCategories={unsubscribedCategories} />
      )}
    </div>
  );
}
