import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Firma ostatnio używana (`users.last_active_tenant_id`): od niej startuje
 * panel strony i telefon (`GET /api/mobile/v1/konto`, `aktywnaFirma`). Wspólne
 * dla przełącznika firm na stronie (`setActiveOrganizationAction`) i wyboru
 * firmy w telefonie (`POST /api/mobile/v1/firma`, M10b).
 *
 * Klient sesji klienta (polityka `users_update_self`, 00002): zmienia tylko
 * własny wiersz. Członkostwo w firmie sprawdza wywołujący, zanim tu przyjdzie.
 * Błąd zapisu nie psuje przełączenia (strona ma ciasteczko, telefon swój wybór):
 * wynik mówi tylko, czy zapis się udał. Ponowienie zapisuje to samo.
 */
export async function rememberLastActiveOrganization(
  supabase: Pick<SupabaseClient, 'from'>,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const { error } = await supabase.from('users').update({ last_active_tenant_id: organizationId }).eq('id', userId);
  return !error;
}
