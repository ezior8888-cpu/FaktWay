// Mail bezpieczeństwa o logowaniu z nowego urządzenia (krok 8.5, część 2).

import { describeUserAgent } from '@/lib/auth/sessions/user-agent';
import { formatIpPrefix } from '@/lib/auth/sessions/ip-prefix';
import { sendNewLoginEmail } from '@/lib/email/send';
import { authLoginCompleted } from '@/lib/jobs/events';
import type { JobContext } from '@/lib/jobs/registry';
import { createAdminClient } from '@/lib/supabase/admin';

const HISTORY_LIMIT = 200;

interface LoginRow {
  action: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

function sessionOf(row: LoginRow): string | null {
  const id = row.metadata?.session_id;
  return typeof id === 'string' ? id : null;
}

/** Przeglądarka z systemem i sieć (IPv4 /24, IPv6 /48). Nieznane nie pasuje do niczego. */
function fingerprint(row: LoginRow): { device: string | null; network: string | null } {
  return { device: describeUserAgent(row.user_agent).label, network: formatIpPrefix(row.ip_address) };
}

function formatWarsaw(iso: string): string {
  return new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

/**
 * Runner joba (worker pg-boss). Rejestracja: lib/jobs/handlers/package-b.ts
 *
 * Ponowienie od zera: odczyt jest bez efektów, jedyny efekt zewnętrzny (mail)
 * ma klucz idempotencji dostawcy `new-login/<sessionId>` (Resend, 24 h), więc
 * kolejne wykonanie po wysyłce nie wyśle drugiego maila. Błąd odczytu bazy
 * i błąd wysyłki to rzut (ponowienie), nie cicha rezygnacja.
 */
export async function runNewLoginMail(rawData: unknown, { step }: JobContext) {
  const { userId, sessionId } = authLoginCompleted.parse(rawData);
  const admin = createAdminClient();

  const rows = await step.run('read-logins', async () => {
    const { data, error } = await admin
      .from('audit_logs')
      .select('action, user_agent, ip_address, created_at, metadata')
      .eq('user_id', userId)
      .in('action', ['auth.login', 'auth.signup'])
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as LoginRow[];
  });

  const current = rows.find((row) => sessionOf(row) === sessionId);
  // Wpis powstaje przed zleceniem, ale `logAudit` nie rzuca: gdy jeszcze go nie
  // widać albo zapis padł, ponowienie zamiast zgadywania urządzenia.
  if (!current) throw new Error('Brak wpisu logowania tej sesji w audycie');

  // Tylko wcześniejsze wpisy z innych sesji: późniejsze logowanie nie robi
  // z tego urządzenia „znanego”.
  const earlier = rows.filter(
    (row) => sessionOf(row) !== sessionId && new Date(row.created_at).getTime() < new Date(current.created_at).getTime(),
  );
  if (earlier.length === 0) return { skipped: true as const, reason: 'first-login' as const };

  const now = fingerprint(current);
  const known = now.device !== null && now.network !== null && earlier.some((row) => {
    const before = fingerprint(row);
    return before.device === now.device && before.network === now.network;
  });
  if (known) return { skipped: true as const, reason: 'known-device' as const };

  const email = await step.run('read-email', async () => {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) throw new Error(error.message);
    return data.user?.email ?? null;
  });
  if (!email) return { skipped: true as const, reason: 'no-email' as const };

  await step.run('send-mail', async () => {
    await sendNewLoginEmail({
      to: email,
      userId,
      occurredAt: formatWarsaw(current.created_at),
      device: now.device ?? 'Nieznane urządzenie',
      ip: now.network,
      idempotencyKey: `new-login/${sessionId}`,
    });
  });
  return { sent: true as const };
}
