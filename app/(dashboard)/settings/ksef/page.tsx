import Link from 'next/link';
import { RiGoogleLine, RiHistoryLine, RiLockLine, RiShieldCheckLine } from '@remixicon/react';

import { CertificateUpload } from '@/components/settings/certificate-upload';
import { CompleteNipForm } from '@/components/settings/complete-nip-form';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { formatSettingsDate } from '@/components/settings/finora/format-date';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { getDashboardSessionUser } from '@/lib/dashboard-shell-data';
import { getPageContext } from '@/lib/supabase/page-context';

export const dynamic = 'force-dynamic';

const AMBER_ALERT = 'border-none bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400';
const AMBER_TEXT = 'text-amber-800 dark:text-amber-400/80';
const BADGE_OK = 'bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400';
const BADGE_WARN = 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400';

/**
 * Zakładka „KSeF” = Connected Accounts z Finory (`views/settings/
 * connected-accounts`): połączenie z KSeF jako wiersz instytucji
 * (`connected-institution-row.tsx`), certyfikat, historia faktur z KSeF
 * i logowanie przez Google. Banków u nas nie ma.
 *
 * Decyzja Bartosza 22.10.2026: Magiczny import znika — po wgraniu
 * certyfikatu FaktWay sam pobiera historię z KSeF. Tu tylko o tym mówimy
 * i prowadzimy do postępu w Imporcie danych (tam też wstrzymanie).
 */
export default async function KsefSettingsPage() {
  const { supabase, tenantId, role } = await getPageContext();

  const [{ data: tenant }, user] = await Promise.all([
    supabase
      .from('tenants')
      .select('name, nip, has_ksef_credentials, ksef_certificate_expiry')
      .eq('id', tenantId)
      .single(),
    // Ten sam użytkownik co w `getPageContext` (`cache()` na żądanie) — bez drugiego wywołania GoTrue.
    getDashboardSessionUser(),
  ]);

  // Sama flaga obecności — zaszyfrowany blob nie wychodzi do klienta (AUD-103).
  const hasCredentials = !!tenant?.has_ksef_credentials;
  const hasNip = !!tenant?.nip?.trim();

  // Tylko odczyt: czy konto ma tożsamość Google (logowanie „Zaloguj przez Google”).
  const providers = Array.isArray(user?.app_metadata?.providers) ? (user.app_metadata.providers as unknown[]) : [];
  const hasGoogle =
    (user?.identities ?? []).some((identity) => identity.provider === 'google') || providers.includes('google');

  // BUG-007: organizacja-szkic (pomiń NIP w onboardingu) — zamiast uploadu
  // certyfikatu pokazujemy uzupełnienie NIP-u. Server action i tak odmawia
  // uploadu przy pustym NIP (guard w uploadCertificateAction).
  if (!hasNip) {
    return (
      <FieldGroup>
        <Alert className={AMBER_ALERT}>
          <AlertTitle>Organizacja bez NIP-u</AlertTitle>
          <AlertDescription className={AMBER_TEXT}>
            Certyfikat KSeF jest przypisany do NIP-u firmy — bez niego nie
            można go wgrać ani wysyłać faktur.
          </AlertDescription>
        </Alert>

        <div>
          <FieldLabel>Przypisz NIP do organizacji</FieldLabel>
          <FieldDescription>
            Wpisz NIP — dane firmy pobierzemy automatycznie z bazy GUS REGON.
          </FieldDescription>
        </div>
        <CompleteNipForm />
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
                NIP: <span className="font-mono">{tenant?.nip}</span>
              </p>
              <p className="text-muted-foreground text-xs">
                {hasCredentials
                  ? tenant?.ksef_certificate_expiry
                    ? `Certyfikat ważny do: ${formatSettingsDate(tenant.ksef_certificate_expiry)}`
                    : 'Certyfikat wgrany'
                  : 'Wgraj certyfikat aby móc wysyłać faktury do KSeF'}
              </p>
            </div>
          </div>
        </div>
      </div>

      <Separator />

      <div>
        <FieldLabel>Wgrywanie certyfikatu</FieldLabel>
        <FieldDescription>
          Potrzebujesz certyfikatu KSeF typu 1 (uwierzytelnianie) — pobierz go
          z Modułu Certyfikatów w Aplikacji Podatnika KSeF.
        </FieldDescription>
      </div>
      <Alert role="note">
        <RiLockLine aria-hidden />
        <AlertDescription>
          Certyfikat i klucz prywatny są szyfrowane AES-256-GCM przed zapisem
          w bazie. Ich zmianę zatwierdza właściciel po weryfikacji dwuetapowej.
        </AlertDescription>
      </Alert>
      {role === 'owner' ? (
        <>
          <FieldDescription>
            Do zmiany certyfikatu potrzebujesz potwierdzonego logowania dwuetapowego.{' '}
            <Link href="/settings/security">Ustaw 2FA</Link>
          </FieldDescription>
          <CertificateUpload />
        </>
      ) : (
        <FieldDescription>Certyfikat KSeF może zmienić wyłącznie właściciel organizacji.</FieldDescription>
      )}

      <Separator />

      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel>Historia faktur z KSeF</FieldLabel>
          <FieldDescription>
            Po wgraniu certyfikatu FaktWay sam pobiera z KSeF całą historię sprzedaży i zakupów, a potem
            na bieżąco faktury wystawione poza FaktWay. Pobieranie możesz wstrzymać w Imporcie danych.
          </FieldDescription>
        </FieldContent>
        {hasCredentials ? (
          <Link href="/import-danych" className={buttonVariants({ variant: 'outline' })}>
            <RiHistoryLine aria-hidden />
            Zobacz postęp
          </Link>
        ) : null}
      </Field>
      {hasCredentials ? null : (
        <Alert role="note" className={AMBER_ALERT}>
          <AlertDescription className={AMBER_TEXT}>
            Aby FaktWay pobrał historię, najpierw wgraj certyfikat powyżej — KSeF wymaga
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
