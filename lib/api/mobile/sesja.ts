import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import { readMobileActiveFirm } from '@/lib/api/mobile/konto';
import { MobileUpstreamError } from '@/lib/api/mobile/responses';
import { logAuditWithResult } from '@/lib/audit/log';
import { requestNewLoginCheck } from '@/lib/auth/sessions/new-login-check';
import { sessionAuditMetadata } from '@/lib/auth/sessions/access-token';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Logowanie z telefonu w audycie (plan aplikacji mobilnej, M6).
 *
 * Strona zapisuje `auth.login` przy każdym logowaniu (hasło w
 * `app/(auth)/login/actions.ts`, Google w `/auth/callback`): z niego żyją
 * historia logowań i lista urządzeń (00174) oraz mail o nowym urządzeniu
 * (`requestNewLoginCheck`). Telefon loguje się w GoTrue sam (M5b), więc tego
 * wpisu nie było. Aplikacja woła `POST /api/mobile/v1/sesja` raz, po pełnym
 * logowaniu (po kodzie 2FA, gdy konto go ma).
 *
 * Wszystko, co trafia do wpisu, pochodzi ze sprawdzonego tokenu (`session_id`,
 * metoda z `amr`) i nagłówków żądania (adres i urządzenie czyta `logAudit`);
 * telefon niczego nie deklaruje.
 *
 * Ponowienie: przed zapisem sprawdzamy, czy ta sesja ma już wpis, więc drugie
 * wywołanie niczego nie dopisuje. Dwa wywołania naraz mogą oba zapisać wpis
 * (sprawdzenie i zapis to dwa zapytania): skutkiem jest podwójny wiersz
 * w historii logowań, a mail o nowym urządzeniu i tak wychodzi raz (klucz
 * idempotencji dostawcy `new-login/<sessionId>` w runnerze).
 */

export type MobileLoginRecord = 'recorded' | 'already_recorded' | 'no_session';

/** Metoda do `metadata.method` jak na stronie (`password`, `google`); bez `amr` nie zgadujemy. */
export function mobileLoginMethod(amrMethods: readonly string[]): 'google' | 'password' | null {
  if (amrMethods.includes('oauth')) return 'google';
  if (amrMethods.includes('password')) return 'password';
  return null;
}

/** Czy sesja ma już wpis `auth.login` (z telefonu albo ze strony). Błąd bazy rzuca. */
export async function isLoginRecorded(admin: SupabaseClient, userId: string, sessionId: string): Promise<boolean> {
  const { data, error } = await admin
    .from('audit_logs')
    .select('id')
    .eq('user_id', userId)
    .eq('action', 'auth.login')
    .eq('metadata->>session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new MobileUpstreamError('audit_logs');
  return (data ?? []).length > 0;
}

export async function recordMobileLogin(caller: MobileCaller): Promise<MobileLoginRecord> {
  const sessionId = caller.session.sessionId;
  // Token GoTrue zawsze ma `session_id`; bez niego wpisu nie da się połączyć z sesją ani odróżnić ponowienia.
  if (!sessionId) return 'no_session';

  if (await isLoginRecorded(createAdminClient(), caller.user.id, sessionId)) return 'already_recorded';

  // Firma wpisu jak przy logowaniu hasłem na stronie: ostatnio używana (dziennik firmy pokazuje logowania).
  const aktywnaFirma = await readMobileActiveFirm(caller.db, caller.user.id);
  const method = mobileLoginMethod(caller.session.amrMethods);
  const saved = await logAuditWithResult({
    action: 'auth.login',
    tenantId: aktywnaFirma,
    userId: caller.user.id,
    metadata: { ...(method ? { method } : {}), ...sessionAuditMetadata(sessionId), client: 'mobile' },
  });
  // Bez wpisu runner maila nie znalazłby logowania; telefon ponowi wywołanie.
  if (!saved) throw new MobileUpstreamError('audit_logs insert');

  await requestNewLoginCheck({ userId: caller.user.id, sessionId });
  return 'recorded';
}
