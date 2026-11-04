import type { createAdminClient } from '@/lib/supabase/server';

/**
 * Kroki usunięcia konta oparte na funkcjach bazy, wspólne dla ścieżki
 * samoobsługowej (`executeGdprRequest`, lib/gdpr/deletion.ts) i panelu
 * admina (`deleteUserGdprAction`). Ścieżka samoobsługowa woła te same RPC
 * u siebie; obie muszą zachować kolejność: sprawdzenia → kroki odwracalne →
 * anonimizacja → deleteUser.
 */

type AdminClient = ReturnType<typeof createAdminClient>;
type RpcResult = { data: unknown; error: { message: string } | null };

/**
 * Klucze obce bez ON DELETE, które dalej wskazują konto (00113, AUD-41) —
 * lista „tabela.kolumna”. Niepusta = deleteUser padnie, więc wołać PRZED
 * pierwszym nieodwracalnym krokiem. Rzuca `deletion_blockers_check_failed`,
 * gdy odpowiedzi nie da się odczytać.
 */
export async function findUserDeletionForeignKeyBlockers(admin: AdminClient, userId: string): Promise<string[]> {
  const result = await (
    admin.rpc as unknown as (fn: 'gdpr_user_deletion_blockers', args: { p_user_id: string }) => Promise<RpcResult>
  )('gdpr_user_deletion_blockers', { p_user_id: userId });
  if (result.error || !Array.isArray(result.data)) throw new Error('deletion_blockers_check_failed');
  return result.data.map(String);
}

/**
 * Anonimizacja dziennika zdarzeń (00052): wpisy z `user_id` konta tracą
 * `user_id`, IP, przeglądarkę i metadane; samo zdarzenie zostaje. Polityka
 * prywatności: „po usunięciu Konta wpisy są anonimizowane”. Nieodwracalne —
 * wołać tuż przed deleteUser. Rzuca `audit_anonymize_failed`.
 */
export async function anonymizeUserAuditLogs(admin: AdminClient, userId: string): Promise<void> {
  const result = await (
    admin.rpc as unknown as (fn: 'anonymize_user_audit_logs', args: { p_user_id: string }) => Promise<RpcResult>
  )('anonymize_user_audit_logs', { p_user_id: userId });
  if (result.error) throw new Error('audit_anonymize_failed');
}
