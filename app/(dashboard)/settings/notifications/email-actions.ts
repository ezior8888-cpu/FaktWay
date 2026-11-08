'use server';

import { revalidatePath } from 'next/cache';
import { getVerifiedUserContext } from '@/lib/auth/verified-user';
import { resubscribe, unsubscribe, type EmailCategory } from '@/lib/email/preferences';
import { setEmailConsent } from '@/lib/legal/record';

export type EmailPreferenceResult =
  | { success: true }
  | { success: false; error: string };

const TOGGLEABLE: EmailCategory[] = ['product_updates', 'marketing'];

export async function toggleEmailCategoryAction(
  category: EmailCategory,
  subscribed: boolean,
): Promise<EmailPreferenceResult> {
  const context = await getVerifiedUserContext();
  if (!context.ok) return { success: false, error: context.error };
  if (!TOGGLEABLE.includes(category) || typeof subscribed !== 'boolean') {
    return { success: false, error: 'Nieprawidłowe ustawienie powiadomień.' };
  }
  // Porady i oferty wymagają zgody (art. 398 Prawa komunikacji elektronicznej):
  // włączenie przełącznika JEST wyrażeniem zgody, wyłączenie — jej wycofaniem.
  // Przy wyłączaniu najpierw wiersz wypisu (blokuje wysyłkę od razu), potem zgoda.
  const consentCategory = category as Exclude<EmailCategory, 'transactional'>;
  try {
    if (subscribed) {
      await resubscribe(context.user.id, category);
      const consent = await setEmailConsent({
        userId: context.user.id, category: consentCategory, granted: true, method: 'settings_ui',
      });
      if (!consent.ok) throw new Error('consent_write_failed');
    } else {
      await unsubscribe({ userId: context.user.id, category, source: 'settings_ui' });
      const consent = await setEmailConsent({
        userId: context.user.id, category: consentCategory, granted: false, method: 'settings_ui',
      });
      if (!consent.ok) throw new Error('consent_write_failed');
    }
  } catch {
    return { success: false, error: 'Nie udało się zapisać ustawienia. Spróbuj ponownie.' };
  }
  revalidatePath('/settings/notifications');
  return { success: true };
}
