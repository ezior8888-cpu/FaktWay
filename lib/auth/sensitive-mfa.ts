import 'server-only';

import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { getGlobalFlagForExecution } from '@/lib/feature-flags/global-flags';
import { createAdminClient, createClient } from '@/lib/supabase/server';

/**
 * Drugi krok (AAL2) przy operacjach wrażliwych właściciela i admina (AUD-65):
 * wysyłka do KSeF, wgranie certyfikatu, płatności. Decyzje B10/B13 — tylko
 * owner/admin (pozostałe role opcjonalnie) i za flagą globalną
 * `requireMfaForSensitive`, domyślnie WYŁĄCZONĄ: włączenie bez zapowiedzi
 * odcięłoby od wysyłki każdego właściciela bez MFA.
 *
 * Błąd odczytu flagi nie blokuje — to dodatkowa warstwa, nie wyłącznik.
 *
 * Logowanie biometrią: sesja AAL1 konta z 2FA wchodzi do panelu ze znacznikiem
 * (`lib/auth/panel-mfa.ts`). Dawniej taka sesja nie docierała tu wcale, więc
 * flaga wyłączona nic nie ryzykowała. Płatności i certyfikat proszą teraz o kod
 * niezależnie od flagi i roli. Wysyłka do KSeF nie: biometria to dwa składniki,
 * a kod przy każdej fakturze przekreśliłby sens logowania bez kodu.
 */

export type SensitiveOperation = 'ksef_submit' | 'certificate' | 'billing';

/** `challenge`: konto ma 2FA, ta sesja go nie potwierdziła. `enrollment`: konto nie ma 2FA. */
export type SensitiveMfaReason = 'challenge' | 'enrollment';

const MESSAGES: Record<SensitiveMfaReason, string> = {
  enrollment: 'Ta operacja wymaga weryfikacji dwuetapowej. Włącz ją w Ustawieniach → Bezpieczeństwo i zaloguj się ponownie.',
  challenge: 'Ta operacja wymaga weryfikacji dwuetapowej. Otwórz Ustawienia → Bezpieczeństwo, potwierdź kodem z aplikacji i spróbuj ponownie.',
};

export class SensitiveMfaRequiredError extends Error {
  constructor(readonly operation: SensitiveOperation, readonly reason: SensitiveMfaReason = 'enrollment') {
    super(MESSAGES[reason]);
    this.name = 'SensitiveMfaRequiredError';
  }
}

const GUARDED_ROLES = new Set(['owner', 'admin']);

/** Stan 2FA sesji sprawdzonej poza ciasteczkami (token telefonu, `lib/api/mobile/auth.ts`). */
export type TokenMfaStatus = 'verified' | 'enrollment_required' | 'challenge_required';

/**
 * `tokenMfa`: sesja nie z ciasteczek strony, tylko z tokenu sprawdzonego przez
 * wołającego (`getVerifiedMfaStateForToken`); ta sama reguła na tym stanie.
 * Bez niego stan czytamy z ciasteczek, jak dotąd.
 */
export async function assertSensitiveMfa(
  ctx: { tenantId: string; userId: string },
  operation: SensitiveOperation,
  tokenMfa?: TokenMfaStatus,
): Promise<void> {
  const readState = async () =>
    tokenMfa ? { status: tokenMfa } : await getVerifiedMfaState(await createClient()).catch(() => null);
  if (operation !== 'ksef_submit') {
    const state = await readState();
    if (!state || state.status === 'challenge_required') throw new SensitiveMfaRequiredError(operation, 'challenge');
  }

  let required: boolean;
  try {
    required = await getGlobalFlagForExecution('requireMfaForSensitive');
  } catch {
    return;
  }
  if (!required) return;

  const { data: membership } = await createAdminClient()
    .from('memberships')
    .select('role')
    .eq('user_id', ctx.userId)
    .eq('organization_id', ctx.tenantId)
    .eq('status', 'active')
    .maybeSingle();
  const role = (membership as { role?: string } | null)?.role;
  if (!role || !GUARDED_ROLES.has(role)) return;

  const state = await readState();
  if (state?.status === 'challenge_required') throw new SensitiveMfaRequiredError(operation, 'challenge');
  if (state?.status !== 'verified') throw new SensitiveMfaRequiredError(operation, 'enrollment');
}
