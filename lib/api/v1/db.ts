import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Klient bazy dla jednego żądania `/api/v1`: klucz anon (jak przeglądarka)
 * i token roli `api_key_client` z `mintApiKeyToken`. Polityki RLS z 00181
 * widzą wtedy tylko firmę i zakres klucza. Nigdy klucz serwisowy.
 */
export function createApiKeyDbClient(
  token: string,
  target: { url?: string; anonKey?: string } = {},
): SupabaseClient {
  const url = target.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = target.anonKey ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('Brak adresu albo klucza anon Supabase');
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
