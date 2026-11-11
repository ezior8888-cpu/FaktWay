import { redirect } from 'next/navigation';
import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import { FieldGroup } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { listPasskeyDevices } from '@/lib/auth/passkey/devices';
import type { PasskeyDevice } from '@/lib/auth/passkey/types';
import {
  loadAccountLogins,
  loadAccountSessions,
  readCurrentRequestDevice,
  type AccountSecurityLoad,
} from '@/lib/auth/sessions/load';
import type { AccountLoginView, AccountSessionView } from '@/lib/auth/sessions/view';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { getDashboardSessionUser } from '@/lib/dashboard-shell-data';
import { createClient } from '@/lib/supabase/server';
import { LoginHistoryCard } from './_components/login-history-card';
import { PasskeysCard } from './_components/passkeys-card';
import { PasswordChangeCard } from './_components/password-change-card';
import { SessionsCard } from './_components/sessions-card';
import { TwoFactorCard } from './_components/two-factor-card';

export const dynamic = 'force-dynamic';

const LOGIN_HISTORY_LIMIT = 20;

/**
 * Zakładka „Bezpieczeństwo” = Security z Finory (`views/settings/security`):
 * hasło, weryfikacja dwuetapowa, logowanie biometrią, a od kroku 8.5 planu
 * kompletnej aplikacji także zalogowane urządzenia i historia logowań
 * (`sessions-card.tsx`, `login-history-card.tsx` Finory; dane z funkcji 00174).
 * Nowe sekcje są pod istniejącymi, które zostają bez zmian (decyzja D1).
 * Blokady aplikacji (PIN) z Finory nie mamy, więc jej tu nie ma.
 */
export default async function SecuritySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const { notice } = await searchParams;
  // Ten sam użytkownik co w layoucie (`cache()` na żądanie). Czynniki MFA
  // z tego odczytu: `mfa.listFactors()` woła pod spodem drugie `getUser()`
  // (GoTrue) i filtruje `user.factors` tak samo — po typie i statusie.
  const user = await getDashboardSessionUser();
  if (!user) redirect('/login');

  const isTotpEnabled = (user.factors ?? []).some(
    (f) => f.factor_type === 'totp' && f.status === 'verified',
  );

  // Sesja po biometrii wchodzi do panelu bez kodu, a wszystko na tej stronie go wymaga.
  // Mówimy o tym od razu, zanim klient wpisze hasło w formularz, który i tak odmówi.
  const supabase = await createClient();
  const mfaState = await getVerifiedMfaState(supabase).catch(() => null);
  const stepUpRequired = mfaState?.status === 'challenge_required';

  let devices: PasskeyDevice[] = [];
  let devicesLoadFailed = false;
  try {
    devices = await listPasskeyDevices(supabase, user.id);
  } catch {
    devicesLoadFailed = true;
  }

  // Bez kodu baza i tak odmówi (`code_step_required`), więc sesja po biometrii od razu
  // dostaje przejście do kodu zamiast dwóch zapytań skazanych na odmowę.
  const codeRequired = { status: 'code_required' } as const;
  const [accountSessions, accountLogins]: [
    AccountSecurityLoad<AccountSessionView>,
    AccountSecurityLoad<AccountLoginView>,
  ] = stepUpRequired
    ? [codeRequired, codeRequired]
    : await Promise.all([
      readCurrentRequestDevice().then((current) => loadAccountSessions(supabase, current)),
      loadAccountLogins(supabase, LOGIN_HISTORY_LIMIT),
    ]);

  return (
    <FieldGroup>
      {notice === 'admin_mfa_required' && (
        <Alert role="status">
          <AlertDescription>
            Panel administratora wymaga weryfikacji dwuetapowej. Włącz 2FA poniżej,
            potwierdź kod z aplikacji TOTP i wróć do panelu administratora.
          </AlertDescription>
        </Alert>
      )}

      {stepUpRequired && (
        <MfaStepUpNotice returnTo="/settings/security">
          Zalogowano biometrią. Zmiana hasła, 2FA i urządzeń wymaga kodu z aplikacji uwierzytelniającej.
        </MfaStepUpNotice>
      )}

      <PasswordChangeCard />

      <Separator />

      <TwoFactorCard isEnabled={isTotpEnabled} />

      <Separator />

      <PasskeysCard initialDevices={devices} stepUpRequired={stepUpRequired} loadFailed={devicesLoadFailed} />

      <Separator />

      <SessionsCard
        initialSessions={accountSessions.status === 'ok' ? accountSessions.items : []}
        state={accountSessions.status}
        stepUpShownAbove={stepUpRequired}
      />

      <Separator />

      <LoginHistoryCard
        entries={accountLogins.status === 'ok' ? accountLogins.items : []}
        state={accountLogins.status}
        limit={LOGIN_HISTORY_LIMIT}
      />
    </FieldGroup>
  );
}
