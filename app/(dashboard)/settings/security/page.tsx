import { redirect } from 'next/navigation';
import { FieldGroup } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { getDashboardSessionUser } from '@/lib/dashboard-shell-data';
import { PasswordChangeCard } from './_components/password-change-card';
import { TwoFactorCard } from './_components/two-factor-card';

export const dynamic = 'force-dynamic';

/**
 * Zakładka „Bezpieczeństwo” = Security z Finory (`views/settings/security`):
 * hasło i weryfikacja dwuetapowa. Blokady aplikacji (PIN), listy sesji
 * i historii logowań z Finory nie mamy, więc ich tu nie ma.
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

      <PasswordChangeCard />

      <Separator />

      <TwoFactorCard isEnabled={isTotpEnabled} />
    </FieldGroup>
  );
}
