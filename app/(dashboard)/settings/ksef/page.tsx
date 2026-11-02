import Link from 'next/link';
import { RiGoogleLine, RiHistoryLine, RiShieldCheckLine } from '@remixicon/react';

import { formatSettingsDate } from '@/components/settings/finora/format-date';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { ksefApplicationUrl } from '@/lib/ksef/application-url';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { getPageContext } from '@/lib/supabase/page-context';

import { CertificateStep } from './_components/certificate-step';
import { ConditionsStep } from './_components/conditions-step';
import { ConnectedStep } from './_components/connected-step';
import { FilesStep } from './_components/files-step';
import { deriveWizardStep, type WizardMfa } from './_components/wizard-model';

export const dynamic = 'force-dynamic';

const AMBER_ALERT = 'border-none bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400';
const AMBER_TEXT = 'text-amber-800 dark:text-amber-400/80';
const BADGE_OK = 'bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400';
const BADGE_WARN = 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400';

/**
 * Zakładka „KSeF” = Connected Accounts z Finory (`views/settings/
 * connected-accounts`): połączenie z KSeF jako wiersz instytucji
 * (`connected-institution-row.tsx`), kreator podłączenia, historia faktur
 * z KSeF i logowanie przez Google. Banków u nas nie ma.
 *
 * Kreator zastąpił formularz z dwoma polami pliku (FAKTWAY-1-0, sekcja 3
 * pkt 1): krok liczy serwer (`wizard-model.ts`), a `?krok=` mówi tylko, czy
 * klient ma już pliki z Aplikacji Podatnika. Ta sama droga służy odnowieniu.
 *
 * Decyzja Bartosza 22.10.2026: Magiczny import znika, po podłączeniu
 * FaktWay sam pobiera historię z KSeF. Tu tylko o tym mówimy i prowadzimy do
 * postępu w Imporcie danych (tam też wstrzymanie).
 */
export default async function KsefSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ krok?: string | string[] }>;
}) {
  const requested = (await searchParams).krok;
  const { supabase, tenantId, role } = await getPageContext();

  const [{ data: tenant }, { data: authUser }, mfaState] = await Promise.all([
    supabase
      .from('tenants')
      .select('name, nip, has_ksef_credentials, ksef_certificate_expiry')
      .eq('id', tenantId)
      .single(),
    supabase.auth.getUser(),
    // Bez wyniku (błąd Auth) kreator pokazuje „spróbuj ponownie”, nie udaje, że 2FA jest.
    getVerifiedMfaState(supabase).catch(() => null),
  ]);

  // Sama flaga obecności: zaszyfrowany blob nie wychodzi do klienta (AUD-103).
  const hasCredentials = !!tenant?.has_ksef_credentials;
  const nip = tenant?.nip?.trim() ?? '';
  const hasNip = nip.length > 0;
  const isOwner = role === 'owner';
  const mfa: WizardMfa = mfaState && mfaState.status !== 'unauthenticated' ? mfaState.status : 'unknown';

  // Tylko odczyt: czy konto ma tożsamość Google (logowanie „Zaloguj przez Google”).
  const user = authUser?.user ?? null;
  const providers = Array.isArray(user?.app_metadata?.providers) ? (user.app_metadata.providers as unknown[]) : [];
  const hasGoogle =
    (user?.identities ?? []).some((identity) => identity.provider === 'google') || providers.includes('google');

  const step = deriveWizardStep({
    hasNip,
    isOwner,
    mfa,
    hasCredentials,
    requested: typeof requested === 'string' ? requested : null,
  });
  const env = configuredKsefEnvironment();

  // BUG-007: organizacja-szkic (pomiń NIP w onboardingu): zamiast reszty strony
  // krok 1 kreatora prosi o uzupełnienie NIP-u. Akcja podłączenia i tak odmawia przy pustym NIP.
  if (!hasNip) {
    return (
      <FieldGroup>
        <ConditionsStep hasNip={false} nip="" isOwner={isOwner} mfa={mfa} />
      </FieldGroup>
    );
  }

  return (
    <FieldGroup>
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-sm font-medium">Połączenie z KSeF</p>
          <p className="text-muted-foreground text-xs">Certyfikat do podpisywania i wysyłki faktur</p>
        </div>

        <div className="flex flex-col gap-3 border p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar className="size-10 items-center justify-center">
              <AvatarFallback className="bg-transparent">
                <RiShieldCheckLine className="text-foreground size-5" />
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="truncate text-sm font-medium">KSeF</p>
                <Badge className={hasCredentials ? BADGE_OK : BADGE_WARN}>
                  {hasCredentials ? 'Skonfigurowano połączenie' : 'Brak certyfikatu'}
                </Badge>
              </div>
              <p className="text-muted-foreground truncate text-xs">
                NIP: <span className="font-mono">{nip}</span>
              </p>
              <p className="text-muted-foreground text-xs">
                {hasCredentials
                  ? tenant?.ksef_certificate_expiry
                    ? `Certyfikat ważny do: ${formatSettingsDate(tenant.ksef_certificate_expiry)}`
                    : 'Certyfikat wgrany'
                  : 'Podłącz KSeF, aby móc wysyłać faktury'}
              </p>
            </div>
          </div>
        </div>
      </div>

      <Separator />

      {step === 'warunki' ? <ConditionsStep hasNip nip={nip} isOwner={isOwner} mfa={mfa} /> : null}
      {step === 'certyfikat' ? (
        <CertificateStep nip={nip} env={env} applicationUrl={ksefApplicationUrl(env)} />
      ) : null}
      {step === 'pliki' ? <FilesStep /> : null}
      {step === 'polaczono' ? (
        <ConnectedStep
          name={tenant?.name ?? ''}
          nip={nip}
          validTo={tenant?.ksef_certificate_expiry ?? null}
          isOwner={isOwner}
        />
      ) : null}

      <Separator />

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel>Historia faktur z KSeF</FieldLabel>
          <FieldDescription>
            Po wgraniu certyfikatu FaktWay sam pobiera z KSeF całą historię sprzedaży i zakupów, a potem
            na bieżąco faktury wystawione poza FaktWay. Pobieranie możesz wstrzymać w Imporcie danych.
          </FieldDescription>
        </FieldContent>
        {hasCredentials && step !== 'polaczono' ? (
          <Link href="/import-danych" className={buttonVariants({ variant: 'outline' })}>
            <RiHistoryLine aria-hidden />
            Zobacz postęp
          </Link>
        ) : null}
      </Field>
      {hasCredentials ? null : (
        <Alert role="note" className={AMBER_ALERT}>
          <AlertDescription className={AMBER_TEXT}>
            Aby FaktWay pobrał historię, najpierw podłącz KSeF kreatorem powyżej: KSeF wymaga
            uwierzytelnienia przy pobieraniu historii.
          </AlertDescription>
        </Alert>
      )}

      <Separator />

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel>Logowanie przez Google</FieldLabel>
          <FieldDescription>Przycisk „Zaloguj przez Google” na stronie logowania FaktWay.</FieldDescription>
        </FieldContent>
        <div className="flex items-center gap-2">
          <RiGoogleLine className="text-muted-foreground size-4" aria-hidden />
          <Badge className={hasGoogle ? BADGE_OK : undefined} variant={hasGoogle ? 'default' : 'secondary'}>
            {hasGoogle ? 'Połączone' : 'Niepołączone'}
          </Badge>
        </div>
      </Field>
    </FieldGroup>
  );
}
