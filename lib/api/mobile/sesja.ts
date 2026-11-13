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
 * (`requestNewLoginCheck`). Telefon logował się w GoTrue sam (M5b), więc tego
 * wpisu nie było. Aplikacja woła `POST /api/mobile/v1/sesja` raz, po pełnym
 * logowaniu (po kodzie 2FA, gdy konto go ma). Od M6b logowanie hasłem idzie
 * przez `POST /api/mobile/v1/logowanie`, które zapisuje wpis od razu po haśle,
 * jak strona (`lib/api/mobile/logowanie.ts`); `POST /sesja` zastaje go gotowy.
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

/** Sesja telefonu do wpisu: tożsamość i fakty ze sprawdzonego tokenu, klient bazy z tym tokenem (RLS). */
export interface MobileLoginSession {
  userId: string;
  sessionId: string | null;
  amrMethods: readonly string[];
  db: SupabaseClient;
  /** Sesja właśnie wydana przez GoTrue (`POST /logowanie`): nie może mieć wpisu, więc bez sprawdzania. */
  nowa?: boolean;
}

/**
 * Wpis `auth.login` dla sesji telefonu i zlecenie maila o nowym urządzeniu, raz na sesję.
 * Wołają go `POST /sesja` (po pełnym logowaniu, także Google) i `POST /logowanie`
 * (zaraz po haśle, jak strona). Błąd bazy albo nieudany zapis rzuca `MobileUpstreamError`.
 */
export async function recordMobileLoginSession(session: MobileLoginSession): Promise<MobileLoginRecord> {
  const { userId, sessionId } = session;
  // Token GoTrue zawsze ma `session_id`; bez niego wpisu nie da się połączyć z sesją ani odróżnić ponowienia.
  if (!sessionId) return 'no_session';

  if (!session.nowa && (await isLoginRecorded(createAdminClient(), userId, sessionId))) return 'already_recorded';

  // Firma wpisu jak przy logowaniu hasłem na stronie: ostatnio używana (dziennik firmy pokazuje logowania).
  const aktywnaFirma = await readMobileActiveFirm(session.db, userId);
  const method = mobileLoginMethod(session.amrMethods);
  const saved = await logAuditWithResult({
    action: 'auth.login',
    tenantId: aktywnaFirma,
    userId,
    metadata: { ...(method ? { method } : {}), ...sessionAuditMetadata(sessionId), client: 'mobile' },
  });
  // Bez wpisu runner maila nie znalazłby logowania; telefon ponowi wywołanie.
  if (!saved) throw new MobileUpstreamError('audit_logs insert');

  await requestNewLoginCheck({ userId, sessionId });
  return 'recorded';
}

export async function recordMobileLogin(caller: MobileCaller): Promise<MobileLoginRecord> {
  return recordMobileLoginSession({
    userId: caller.user.id,
    sessionId: caller.session.sessionId,
    amrMethods: caller.session.amrMethods,
    db: caller.db,
  });
}
