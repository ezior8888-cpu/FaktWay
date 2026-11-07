'use server';

import { revalidatePath } from 'next/cache';

import { isAllowedPushEndpoint, isValidPushKeys } from '@/lib/push/endpoint';
import {
  ActionAuthError,
  requireUserAndActiveOrg,
  requireVerifiedUser,
} from '@/lib/supabase/auth-context';

interface SubscribeInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
  deviceType?: 'mobile' | 'tablet' | 'desktop';
  deviceName?: string;
}

export async function subscribePushAction(input: SubscribeInput) {
  // Firma z potwierdzonego członkostwa, nie z samego ciasteczka (AUD-58):
  // powiadomienia `sendPushToTenant` idą do subskrypcji z tym `tenant_id`.
  let ctx: Awaited<ReturnType<typeof requireUserAndActiveOrg>>;
  try {
    ctx = await requireUserAndActiveOrg();
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false as const, error: e.message };
    throw e;
  }
  const { supabase, user, tenantId } = ctx;

  // AUD-61: serwer wysyła na ten adres — tylko usługi push przeglądarek.
  if (!isAllowedPushEndpoint(input.endpoint) || !isValidPushKeys(input.p256dh, input.auth)) {
    return { success: false as const, error: 'Nieprawidłowa subskrypcja powiadomień' };
  }

  // Upsert po endpoint (UNIQUE) — ten sam browser odświeża klucze
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_id: user.id,
      tenant_id: tenantId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      user_agent: input.userAgent?.slice(0, 500),
      device_type: input.deviceType,
      device_name: input.deviceName?.slice(0, 100),
      is_active: true,
      failed_count: 0,
    },
    { onConflict: 'endpoint' },
  );

  if (error) {
    return { success: false as const, error: error.message };
  }

  revalidatePath('/settings/notifications');
  return { success: true as const };
}

export async function unsubscribePushAction(endpoint: string) {
  const auth = await verifiedUserOrNull();
  if (!auth) return { success: false as const };
  const { supabase, user } = auth;

  await supabase
    .from('push_subscriptions')
    .update({ is_active: false })
    .eq('endpoint', endpoint)
    .eq('user_id', user.id);

  revalidatePath('/settings/notifications');
  return { success: true as const };
}

const PREFERENCE_KEYS = new Set([
  'notify_invoice_accepted',
  'notify_invoice_rejected',
  'notify_payment_received',
  'notify_cert_expiry',
  'notify_inbox_new',
  // Moduł księgowości (K5, 00169): przełącznik widzi tylko firma w pilotażu.
  'notify_ksiegowosc',
]);

export async function updatePushPreferencesAction(
  subscriptionId: string,
  preferences: Partial<{
    notify_invoice_accepted: boolean;
    notify_invoice_rejected: boolean;
    notify_payment_received: boolean;
    notify_cert_expiry: boolean;
    notify_inbox_new: boolean;
    notify_ksiegowosc: boolean;
  }>,
) {
  const auth = await verifiedUserOrNull();
  if (!auth) return { success: false as const };
  const { supabase, user } = auth;

  // AUD-61: tylko pola preferencji — akcja przepuszczała dowolne kolumny.
  const allowed = Object.fromEntries(
    Object.entries(preferences).filter(
      ([key, value]) => PREFERENCE_KEYS.has(key) && typeof value === 'boolean',
    ),
  );
  if (Object.keys(allowed).length === 0) return { success: false as const };

  await supabase
    .from('push_subscriptions')
    .update(allowed)
    .eq('id', subscriptionId)
    .eq('user_id', user.id);

  revalidatePath('/settings/notifications');
  return { success: true as const };
}

/** Sesja po drugim kroku MFA (gdy konto je ma) — nie sam `getUser()` (AUD-58). */
async function verifiedUserOrNull() {
  try {
    return await requireVerifiedUser();
  } catch (e) {
    if (e instanceof ActionAuthError) return null;
    throw e;
  }
}
