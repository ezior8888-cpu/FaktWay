import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { PasskeyDevice } from '@/lib/auth/passkey/types';

/** Kolumny z grantem dla `authenticated` (00159): bez klucza i identyfikatora poświadczenia. */
export const DEVICE_COLUMNS = 'id, device_label, backed_up, created_at, last_used_at';

interface DeviceRow {
  id: string;
  device_label: string;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
}

export function toPasskeyDevice(row: DeviceRow): PasskeyDevice {
  return {
    id: row.id,
    deviceLabel: row.device_label,
    backedUp: row.backed_up,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
  };
}

/** Klient użytkownika (RLS); `user_id` jawnie, żeby zapytanie nie zależało tylko od polityki. */
export async function listPasskeyDevices(
  supabase: Pick<SupabaseClient, 'from'>,
  userId: string,
): Promise<PasskeyDevice[]> {
  const { data, error } = await supabase.from('user_passkeys')
    .select(DEVICE_COLUMNS)
    .eq('user_id', userId)
    .order('created_at');
  if (error) throw new Error('passkey_devices_unavailable');
  return ((data ?? []) as DeviceRow[]).map(toPasskeyDevice);
}

/**
 * Wszystkie klucze konta, klientem serwisowym. Reset hasła z e-maila to sesja AAL1,
 * a polityka usuwania z 00159 na koncie z 2FA wpuszcza tylko AAL2, więc klientem
 * użytkownika to nie przejdzie. Zwraca liczbę usuniętych kluczy; błąd bazy rzuca.
 */
export async function deleteAllPasskeysWith(
  admin: Pick<SupabaseClient, 'from'>,
  userId: string,
): Promise<number> {
  const { data, error } = await admin.from('user_passkeys')
    .delete()
    .eq('user_id', userId)
    .select('id');
  if (error) throw new Error('passkey_delete_failed');
  return data?.length ?? 0;
}
