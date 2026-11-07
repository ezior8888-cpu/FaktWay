/**
 * Dane powiadomień modułu księgowości (plan księgowości JDG, K5): firmy
 * w pilotażu, wpis `tax_notifications` (00169) przed wysyłką i po niej,
 * adres właściciela. Tylko w zadaniach, kluczem serwisowym (AGENTS.md).
 *
 * Idempotencja jak `billing_notifications` (00048): wpis „sending” powstaje
 * przed wysyłką, więc ponowienie zadania od zera nie wyśle drugi raz; wpis
 * „failed” i przerwany „sending” wolno przejąć.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { isMissingColumnError } from '@/lib/invoices/business-start';

/** Limit odczytu PostgREST; pilotaż to kilka firm, więcej to sygnał, że pora na fan-out. */
const LIMIT_FIRM = 1000;

/** Firmy z `ksiegowosc_enabled = true`; obszar i globalny stop sprawdza wołający (`czyKsiegowoscWlaczona`). */
export async function firmyWPilotazu(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.from('tenant_feature_flags').select('tenant_id').eq('ksiegowosc_enabled', true).limit(LIMIT_FIRM);
  if (error) {
    if (isMissingColumnError(error.code)) return [];
    throw new Error(`Nie można odczytać firm w pilotażu księgowości: ${error.message}`);
  }
  const firmy = (data ?? []).map((w) => (w as { tenant_id: string }).tenant_id);
  if (firmy.length >= LIMIT_FIRM) {
    throw new Error(`Pilotaż księgowości ma ${LIMIT_FIRM} lub więcej firm: zadanie potrzebuje fan-outu na kolejkę (plan, sekcja 9).`);
  }
  return [...new Set(firmy)].sort();
}

export type Zajecie = 'zajete' | 'duplikat';

/**
 * Wpis przed wysyłką. UNIQUE (tenant_id, rozliczenie, etap) zatrzymuje drugą
 * wysyłkę; „failed” i „sending” (przerwany przebieg) przejmuje się warunkowo.
 */
export async function zajmij(admin: SupabaseClient, tenantId: string, rozliczenie: string, etap: string): Promise<Zajecie> {
  const { error } = await admin.from('tax_notifications').insert({ tenant_id: tenantId, rozliczenie, etap, status: 'sending' });
  if (!error) return 'zajete';
  if (error.code !== '23505') throw new Error(`Nie można zapisać powiadomienia: ${error.message}`);
  const { data, error: bladPrzejecia } = await admin
    .from('tax_notifications')
    .update({ status: 'sending', blad: null })
    .eq('tenant_id', tenantId)
    .eq('rozliczenie', rozliczenie)
    .eq('etap', etap)
    .in('status', ['failed', 'sending'])
    .select('id');
  if (bladPrzejecia) throw new Error(`Nie można przejąć powiadomienia: ${bladPrzejecia.message}`);
  return data && data.length > 0 ? 'zajete' : 'duplikat';
}

export async function zamknij(
  admin: SupabaseClient,
  tenantId: string,
  rozliczenie: string,
  etap: string,
  wynik: { status: 'sent'; wynik: Record<string, unknown> } | { status: 'failed'; blad: string },
): Promise<void> {
  const zmiana =
    wynik.status === 'sent'
      ? { status: 'sent', wynik: wynik.wynik, blad: null, wyslano_o: new Date().toISOString() }
      : { status: 'failed', blad: wynik.blad.slice(0, 500) };
  const { error } = await admin.from('tax_notifications').update(zmiana).eq('tenant_id', tenantId).eq('rozliczenie', rozliczenie).eq('etap', etap);
  if (error) throw new Error(`Nie można zamknąć powiadomienia: ${error.message}`);
}

/** Najwcześniej dołączony właściciel firmy: odbiorca maila z przypomnieniem. */
export async function wlasciciel(admin: SupabaseClient, tenantId: string): Promise<{ userId: string; email: string } | null> {
  const { data, error } = await admin
    .from('memberships')
    .select('user_id')
    .eq('organization_id', tenantId)
    .eq('role', 'owner')
    .eq('status', 'active')
    .order('joined_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Nie można odczytać właściciela firmy: ${error.message}`);
  const userId = (data as { user_id?: string } | null)?.user_id;
  if (!userId) return null;
  const { data: konto, error: bladKonta } = await admin.auth.admin.getUserById(userId);
  if (bladKonta) throw new Error(`Nie można odczytać konta właściciela: ${bladKonta.message}`);
  const email = konto.user?.email;
  return email ? { userId, email } : null;
}
