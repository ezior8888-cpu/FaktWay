import 'server-only';

/**
 * Email preferences API (Faza 26).
 *
 * Strategia: per user × per kategoria opt-out. Brak wiersza w
 * `email_preferences` = nie wypisał się. Wiersz z `unsubscribed_at` =
 * user wyłączył tę kategorię. Od 15.10.2026 porady i oferty wymagają
 * DODATKOWO zapisanej zgody (`canSendTo`, warstwa 5) — brak wypisu to
 * jeszcze nie zgoda (art. 398 Prawa komunikacji elektronicznej).
 *
 * UWAGA: `transactional` kategoria jest SERVICE-CRITICAL. Nawet jeśli
 * user "wyłączy" przez settings UI, transactional emaile (KSeF accepted,
 * password reset, payment failed) NADAL będą wysyłane — to wymóg prawny
 * + bez tego user nie wie że jego faktury padają. Hard bounce / complaint
 * to jedyne ścieżki które realnie blokują transactional (Resend i tak
 * by je rejectował).
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { hasEmailConsent } from '@/lib/legal/acceptance';

/**
 * Lokalny typ — `email_category_enum` powstaje w migracji 00049 i nie jest
 * jeszcze w `types/database.ts` (pre-regeneracja). Po `supabase gen types`
 * można podmienić na `Database['public']['Enums']['email_category_enum']`.
 */
export type EmailCategory = 'transactional' | 'product_updates' | 'marketing';

export const ALL_CATEGORIES: EmailCategory[] = [
  'transactional',
  'product_updates',
  'marketing',
];

export interface UnsubscribeInput {
  userId: string;
  category: EmailCategory;
  source: 'one_click' | 'settings_ui' | 'hard_bounce_auto' | 'complaint_auto' | 'admin';
  reason?: string;
}

/**
 * Czy user jest zapisany na daną kategorię. Brak wiersza = subscribed.
 */
export async function isSubscribed(
  userId: string,
  category: EmailCategory,
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('email_preferences')
    .select('id')
    .eq('user_id', userId)
    .eq('category', category)
    .maybeSingle();
  if (error) throw new Error('email_preferences_unavailable');
  return !data;
}

/**
 * Czy email adres jest dezaktywowany przez bounce/complaint. Lookup po
 * `email_bounces` — hard bounce / complaint blokuje wszystkie emails
 * (włącznie z transactional, żeby nie zniszczyć reputacji domeny).
 */
export async function isEmailBlocked(email: string): Promise<{
  blocked: boolean;
  reason?: 'hard_bounce' | 'complaint';
}> {
  const supabase = createAdminClient();
  const normalizedEmail = email.toLowerCase().trim();

  const { data, error } = await supabase
    .from('email_bounces')
    .select('bounce_type')
    .eq('email', normalizedEmail)
    .in('bounce_type', ['hard', 'complaint'])
    .order('occurred_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error('email_suppression_unavailable');
  if (!data) return { blocked: false };
  return {
    blocked: true,
    reason: data.bounce_type === 'hard' ? 'hard_bounce' : 'complaint',
  };
}

/**
 * Unsubscribe user × kategoria. Idempotent — powtórny call nie crashuje.
 *
 * `source` jest WAŻNY dla audit: pozwala odróżnić "user kliknął w mailu"
 * od "Gmail oznaczył jako spam = complaint" od "admin ręcznie zablokował".
 */
export async function unsubscribe(input: UnsubscribeInput): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase.from('email_preferences').upsert(
    {
      user_id: input.userId,
      category: input.category,
      source: input.source,
      reason: input.reason ?? null,
      unsubscribed_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,category', ignoreDuplicates: false },
  );
  if (error) throw new Error('email_preference_write_failed');
}

/**
 * Resubscribe — usuwa wiersz z `email_preferences` (czyli wraca do
 * domyślnego subscribed). UI w `/settings/notifications` używa tego.
 */
export async function resubscribe(
  userId: string,
  category: EmailCategory,
): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from('email_preferences')
    .delete()
    .eq('user_id', userId)
    .eq('category', category);
  if (error) throw new Error('email_preference_write_failed');
}

/**
 * Pobiera wszystkie wyłączone kategorie dla user'a. Używane przez
 * `/settings/notifications` UI żeby zaznaczyć checkboxy.
 */
export async function getUnsubscribedCategories(
  userId: string,
): Promise<EmailCategory[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('email_preferences')
    .select('category')
    .eq('user_id', userId);
  if (error) throw new Error('email_preferences_unavailable');
  return (data ?? []).map((r) => r.category as EmailCategory);
}

/**
 * Helper przed wysyłką email'a: czy MOŻEMY ten email wysłać?
 *
 * Reguły:
 *   1. Hard bounce / complaint → NIE wysyłamy nic (nawet transactional)
 *   2. User opt-out + kategoria 'transactional' → wysyłamy mimo wszystko
 *      (service-critical)
 *   3. User opt-out + product_updates/marketing → NIE wysyłamy
 *   4. product_updates/marketing bez zapisanej zgody → NIE wysyłamy
 *   5. Zgoda i brak wiersza wypisu → wysyłamy
 */
export async function canSendTo(
  email: string,
  userId: string | null,
  category: EmailCategory,
): Promise<{ ok: boolean; reason?: string }> {
  // Failed reads throw: callers retry, rather than sending past an unknown opt-out.
  // Layer 1: bounce check (zawsze).
  const bounce = await isEmailBlocked(email);
  if (bounce.blocked) {
    return { ok: false, reason: bounce.reason };
  }

  // Layer 2: transactional ZAWSZE OK (service-critical).
  if (category === 'transactional') return { ok: true };

  // Layer 3: bez userId nie sprawdzimy zgody — porad i ofert nie wysyłamy
  // (do 15.10.2026 brak userId znaczył „wolno”).
  if (!userId) return { ok: false, reason: 'no_consent' };

  // Layer 4: user opt-out check.
  const subscribed = await isSubscribed(userId, category);
  if (!subscribed) {
    return { ok: false, reason: 'user_unsubscribed' };
  }

  // Layer 5: uprzednia zgoda (art. 398 ust. 1 Prawa komunikacji elektronicznej).
  // Brak wypisu to nie zgoda: do 15.10.2026 porady i oferty szły do każdego,
  // kto się nie wypisał (model opt-out), co przy e-mailach jest niedozwolone.
  if (!(await hasRecordedEmailConsent(userId, category))) {
    return { ok: false, reason: 'no_consent' };
  }

  return { ok: true };
}

/**
 * Zgoda z `app_metadata.legal.email_consents` (zapis: lib/legal/record.ts).
 * Błąd odczytu rzuca — wywołujący ponowi, zamiast wysłać bez wiedzy o zgodzie.
 */
async function hasRecordedEmailConsent(
  userId: string,
  category: Exclude<EmailCategory, 'transactional'>,
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error) {
    // Konto usunięte = brak zgody, a nie awaria.
    if (error.status === 404) return false;
    throw new Error('email_consent_unavailable');
  }
  return hasEmailConsent(data.user?.app_metadata, category);
}

/**
 * Stan przełączników w ustawieniach: włączone = zgoda i brak wypisu.
 * Bez zgody przełącznik jest wyłączony, nawet gdy nie ma wiersza wypisu.
 */
export async function getEmailConsents(
  userId: string,
): Promise<Record<Exclude<EmailCategory, 'transactional'>, boolean>> {
  const supabase = createAdminClient();
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error) throw new Error('email_consent_unavailable');
  const meta = data.user?.app_metadata;
  return {
    product_updates: hasEmailConsent(meta, 'product_updates'),
    marketing: hasEmailConsent(meta, 'marketing'),
  };
}
