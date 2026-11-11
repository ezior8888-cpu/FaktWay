'use server';

import { revalidatePath } from 'next/cache';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logAudit } from '@/lib/audit/log';
import { requireCodeForAccessGrant } from '@/lib/auth/access-grant-mfa';
import { adresKalendarza, generujTokenKalendarza } from '@/lib/kalendarz/token';
import { ActionAuthError, requireOrgRole } from '@/lib/supabase/auth-context';

/**
 * Adres kalendarza (krok 7.3 planu kompletnej aplikacji). Właściciel albo
 * administrator; adres daje wgląd w numery, kwoty i nazwy nabywców, więc
 * sesja po biometrii potrzebuje kodu (jak link dla księgowej). W bazie jest
 * tylko skrót tokenu, więc adres widać raz, w odpowiedzi na utworzenie.
 * Wymiana to nadpisanie skrótu: stary adres przestaje działać od razu.
 *
 * Ponowienie: utworzenie jest jednym upsertem (po `tenant_id`), więc powtórka
 * po przerwaniu wymienia adres, a nie dubluje wiersza; audyt dopisuje się po
 * udanym zapisie.
 */

export type CreateCalendarFeedResult =
  | { success: true; url: string }
  | { success: false; error: string; mfaStepUp?: true };

export type DeleteCalendarFeedResult = { success: true } | { success: false; error: string };

export async function createCalendarFeedAction(): Promise<CreateCalendarFeedResult> {
  let ctx: Awaited<ReturnType<typeof requireOrgRole>>;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const { tenantId, user } = ctx;
  // Tabela z 00182 czeka na typy z produkcji (po wgraniu migracji).
  const supabase = ctx.supabase as unknown as SupabaseClient;

  const stepUp = await requireCodeForAccessGrant(ctx.supabase, user.id, 'Utworzenie adresu kalendarza');
  if (stepUp) return stepUp;

  const { data: istniejacy, error: odczyt } = await supabase
    .from('calendar_feed_tokens')
    .select('tenant_id')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (odczyt) return { success: false, error: 'Nie udało się sprawdzić adresu kalendarza. Spróbuj ponownie.' };

  const { token, hash } = generujTokenKalendarza();
  const { error } = await supabase.from('calendar_feed_tokens').upsert(
    { tenant_id: tenantId, token_hash: hash, created_by: user.id, created_at: new Date().toISOString() },
    { onConflict: 'tenant_id' },
  );
  if (error) return { success: false, error: 'Nie udało się utworzyć adresu kalendarza. Spróbuj ponownie.' };

  // Bez tokenu i jego skrótu w metadanych: audyt mówi „kto i kiedy”, nie daje dostępu.
  await logAudit({
    action: istniejacy ? 'calendar_feed.regenerated' : 'calendar_feed.created',
    tenantId,
    userId: user.id,
    entityType: 'calendar_feed',
    entityId: tenantId,
  });

  revalidatePath('/settings');
  return { success: true, url: adresKalendarza(token) };
}

export async function deleteCalendarFeedAction(): Promise<DeleteCalendarFeedResult> {
  let ctx: Awaited<ReturnType<typeof requireOrgRole>>;
  try {
    ctx = await requireOrgRole(['owner', 'admin']);
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const { tenantId, user } = ctx;
  // Tabela z 00182 czeka na typy z produkcji (po wgraniu migracji).
  const supabase = ctx.supabase as unknown as SupabaseClient;

  const { error } = await supabase.from('calendar_feed_tokens').delete().eq('tenant_id', tenantId);
  if (error) return { success: false, error: 'Nie udało się usunąć adresu kalendarza. Spróbuj ponownie.' };

  await logAudit({
    action: 'calendar_feed.deleted',
    tenantId,
    userId: user.id,
    entityType: 'calendar_feed',
    entityId: tenantId,
  });

  revalidatePath('/settings');
  return { success: true };
}
