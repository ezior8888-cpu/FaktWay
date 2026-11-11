'use server';

import {
  APP_NOTIFICATION_LIST_LIMIT,
  isAppNotificationKind,
  isAppNotificationLink,
  type AppNotificationItem,
  type AppNotificationsResult,
  type MarkAppNotificationsReadResult,
} from '@/lib/app-notifications/types';
import { ActionAuthError, requireUserAndActiveOrg } from '@/lib/supabase/auth-context';

/**
 * Dzwonek w nagłówku (plan kompletnej aplikacji, krok 8.1, część 2, 00188).
 * Klient sesji (RLS: tylko własne wpisy aktywnej firmy) i jawny filtr firmy
 * oraz użytkownika, żeby zapytanie szło po indeksie. Datę przeczytania
 * ustawia tylko RPC `app_notifications_mark_read` (klucz użytkownika nie ma
 * UPDATE na tabeli).
 */

const LOAD_ERROR = 'Nie udało się wczytać powiadomień. Spróbuj ponownie za chwilę.';
const MARK_ERROR = 'Nie udało się oznaczyć powiadomień. Spróbuj ponownie za chwilę.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: unknown;
  kind: unknown;
  title: unknown;
  body: unknown;
  link: unknown;
  created_at: unknown;
  read_at: unknown;
};

function toItem(row: Row): AppNotificationItem | null {
  if (!isAppNotificationKind(row.kind) || typeof row.title !== 'string') return null;
  return {
    id: String(row.id),
    kind: row.kind,
    title: row.title,
    body: typeof row.body === 'string' && row.body ? row.body : null,
    // Druga zapora obok CHECK w bazie: do przeglądarki idzie tylko ścieżka w aplikacji.
    link: isAppNotificationLink(row.link) ? row.link : null,
    createdAt: String(row.created_at),
    read: row.read_at !== null && row.read_at !== undefined,
  };
}

/** Ostatnie wpisy i liczba nieprzeczytanych zalogowanego użytkownika w aktywnej firmie. */
export async function loadAppNotificationsAction(): Promise<AppNotificationsResult> {
  let ctx;
  try {
    ctx = await requireUserAndActiveOrg();
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }
  const { supabase, tenantId, user } = ctx;

  try {
    const [list, unread] = await Promise.all([
      supabase
        .from('app_notifications')
        .select('id, kind, title, body, link, created_at, read_at')
        .eq('tenant_id', tenantId)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(APP_NOTIFICATION_LIST_LIMIT),
      supabase
        .from('app_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('user_id', user.id)
        .is('read_at', null),
    ]);
    if (list.error || unread.error) return { success: false, error: LOAD_ERROR };
    const items = ((list.data ?? []) as Row[]).map(toItem).filter((i): i is AppNotificationItem => i !== null);
    return { success: true, unread: unread.count ?? 0, items };
  } catch {
    return { success: false, error: LOAD_ERROR };
  }
}

/**
 * Oznacza wpisy jako przeczytane: bez listy wszystkie nieprzeczytane w aktywnej
 * firmie („Oznacz wszystkie jako przeczytane”), z listą tylko te (kliknięty wpis).
 */
export async function markAppNotificationsReadAction(ids?: string[]): Promise<MarkAppNotificationsReadResult> {
  if (
    ids !== undefined &&
    (!Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > APP_NOTIFICATION_LIST_LIMIT ||
      !ids.every((id) => typeof id === 'string' && UUID.test(id)))
  ) {
    return { success: false, error: MARK_ERROR };
  }

  let ctx;
  try {
    ctx = await requireUserAndActiveOrg();
  } catch (e) {
    if (e instanceof ActionAuthError) return { success: false, error: e.message };
    throw e;
  }

  try {
    const { data, error } = await ctx.supabase.rpc('app_notifications_mark_read', { p_ids: ids ?? null });
    if (error) return { success: false, error: MARK_ERROR };
    const updated = Number(data ?? 0);
    return { success: true, updated: Number.isFinite(updated) ? updated : 0 };
  } catch {
    return { success: false, error: MARK_ERROR };
  }
}
