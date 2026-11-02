import { redirect } from 'next/navigation';
import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import { FieldGroup } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { listPasskeyDevices } from '@/lib/auth/passkey/devices';
import type { PasskeyDevice } from '@/lib/auth/passkey/types';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { createClient } from '@/lib/supabase/server';
import { PasskeysCard } from './_components/passkeys-card';
import { PasswordChangeCard } from './_components/password-change-card';
import { TwoFactorCard } from './_components/two-factor-card';

export const dynamic = 'force-dynamic';

/**
 * Zakładka „Bezpieczeństwo” = Security z Finory (`views/settings/security`):
 * hasło, weryfikacja dwuetapowa i logowanie biometrią. Blokady aplikacji (PIN),
 * listy sesji i historii logowań z Finory nie mamy, więc ich tu nie ma.
 */
export default async function SecuritySettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const { notice } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: factorsRes } = await supabase.auth.mfa.listFactors();
  const verifiedTotp = factorsRes?.totp?.find((f) => f.status === 'verified');
  const isTotpEnabled = Boolean(verifiedTotp);

  // Sesja po biometrii wchodzi do panelu bez kodu, a wszystko na tej stronie go wymaga.
  // Mówimy o tym od razu, zanim klient wpisze hasło w formularz, który i tak odmówi.
  const mfaState = await getVerifiedMfaState(supabase).catch(() => null);
  const stepUpRequired = mfaState?.status === 'challenge_required';

  let devices: PasskeyDevice[] = [];
  let devicesLoadFailed = false;
  try {
    devices = await listPasskeyDevices(supabase, user.id);
  } catch {
    devicesLoadFailed = true;
  }

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
    </FieldGroup>
  );
}
