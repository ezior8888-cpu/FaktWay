'use client';

import { useState, useTransition } from 'react';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import { TurnstileWidget } from '@/components/auth/turnstile-widget';
import {
  enrollTotpAction,
  unenrollTotpAction,
  verifyTotpEnrollmentAction,
} from '../actions';
import { SUPPORT_EMAIL } from '@/lib/site';

/**
 * Weryfikacja dwuetapowa (TOTP). Wygląd: `security/two-factor-card.tsx`
 * Finory (wiersz: etykieta i opis po lewej, odznaka i przycisk po prawej),
 * a kroki rejestracji jak w jej `two-factor-setup-dialog.tsx` (QR na środku,
 * ostrzeżenie w bursztynowym Alert, pole kodu, przyciski po prawej) — ale
 * w miejscu, nie w oknie: ten sam komponent stoi też na
 * `/login/two-factor/setup` i logika kroków się nie zmienia.
 */

interface Props {
  isEnabled: boolean;
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'enrolling'; factorId: string; qrCode: string; secret: string }
  | { kind: 'unenroll' };

const MFA_ERROR_MESSAGES: Record<string, string> = {
  not_authenticated: 'Zaloguj się ponownie i spróbuj jeszcze raz.',
  mfa_required: 'Potwierdź logowanie kodem z aplikacji 2FA i spróbuj ponownie.',
  rate_limited: 'Zbyt wiele prób. Poczekaj chwilę i spróbuj ponownie.',
  verification_unavailable: 'Nie możemy teraz potwierdzić operacji. Spróbuj ponownie za chwilę.',
  unenroll_incomplete: 'Usunięto część aplikacji TOTP, ale nie udało się zakończyć. Sprawdź stan zabezpieczeń i spróbuj ponownie.',
  already_enrolled: 'Masz już aktywne 2FA. Potwierdź logowanie kodem z aplikacji.',
  verify_failed: 'Nieprawidłowy kod. Sprawdź godzinę w telefonie i spróbuj ponownie.',
};

// Kolory Alert z Finory (`two-factor-setup-dialog.tsx`, „Can't scan the code?”).
function RecoveryUnavailableNotice() {
  return (
    <Alert role="note" className="border-none bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400">
      <AlertDescription className="text-amber-800 dark:text-amber-400/80">
        Utrata dostępu do aplikacji TOTP może zablokować logowanie.
        Samodzielne odzyskiwanie dostępu, także kodami ratunkowymi, jest obecnie
        niedostępne. W razie utraty dostępu{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-4">
          skontaktuj się z pomocą
        </a>.
      </AlertDescription>
    </Alert>
  );
}

function ErrorText({ children }: { children: string }) {
  // Sesja po biometrii: sama treść błędu nie mówi, gdzie podać kod, więc dajemy przejście.
  if (children === MFA_ERROR_MESSAGES.mfa_required) {
    return <MfaStepUpNotice returnTo="/settings/security">{children}</MfaStepUpNotice>;
  }
  return (
    <p role="alert" className="text-destructive text-xs">
      {children}
    </p>
  );
}

export function TwoFactorCard({ isEnabled }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const reset = () => {
    setStage({ kind: 'idle' });
    setError(null);
  };

  const onEnroll = () => {
    setError(null);
    startTransition(async () => {
      const r = await enrollTotpAction();
      if (!r.ok) {
        setError(MFA_ERROR_MESSAGES[r.error ?? ''] ?? 'Nie udało się rozpocząć rejestracji. Spróbuj ponownie.');
        return;
      }
      setStage({
        kind: 'enrolling',
        factorId: r.factorId!,
        qrCode: r.qrCode!,
        secret: r.secret!,
      });
    });
  };

  const onVerify = (formData: FormData) => {
    if (stage.kind !== 'enrolling') return;
    const code = String(formData.get('code') ?? '').trim();
    setError(null);
    startTransition(async () => {
      const r = await verifyTotpEnrollmentAction(stage.factorId, code);
      if (!r.ok) {
        setError(MFA_ERROR_MESSAGES[r.error] ?? 'Nie udało się potwierdzić 2FA. Spróbuj ponownie.');
        return;
      }
      reset();
    });
  };

  const onUnenrollSubmit = (formData: FormData) => {
    const password = String(formData.get('password') ?? '');
    const captchaToken = formData.get('cf-turnstile-response');
    setError(null);
    startTransition(async () => {
      const r = await unenrollTotpAction(password, typeof captchaToken === 'string' ? captchaToken : undefined);
      if (!r.ok) {
        setError(
          MFA_ERROR_MESSAGES[r.error] ??
            (r.error === 'invalid_password' ? 'Hasło nieprawidłowe.' : 'Nie udało się wyłączyć 2FA.'),
        );
        return;
      }
      reset();
    });
  };

  if (stage.kind === 'enrolling') {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <FieldLabel>Dodaj aplikację TOTP</FieldLabel>
          <FieldDescription>
            Zeskanuj QR aplikacją TOTP (Google Authenticator, 1Password, Authy)
            i wpisz 6-cyfrowy kod, aby potwierdzić.
          </FieldDescription>
        </div>
        <RecoveryUnavailableNotice />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={stage.qrCode} alt="QR code TOTP" className="mx-auto size-44 bg-white p-3" />
        <Field>
          <FieldContent>
            <FieldLabel>Lub wpisz ręcznie</FieldLabel>
          </FieldContent>
          <code className="bg-muted block px-3 py-2 font-mono text-xs break-all">{stage.secret}</code>
        </Field>
        <form action={onVerify} className="flex flex-col gap-4">
          <Field data-invalid={error ? true : undefined}>
            <FieldContent>
              <FieldLabel htmlFor="code">Kod z aplikacji</FieldLabel>
            </FieldContent>
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoComplete="one-time-code"
              placeholder="123456"
            />
            {error && <ErrorText>{error}</ErrorText>}
          </Field>
          <div className="flex gap-3 sm:justify-end">
            <Button type="button" variant="outline" onClick={reset} disabled={isPending}>
              Anuluj
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Weryfikacja...' : 'Potwierdź'}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  if (stage.kind === 'unenroll') {
    return (
      <form action={onUnenrollSubmit} className="flex flex-col gap-4">
        <Field data-invalid={error ? true : undefined}>
          <FieldContent>
            <FieldLabel htmlFor="totp-unenroll-password">Aktualne hasło</FieldLabel>
            <FieldDescription>
              Usunięcie aplikacji TOTP osłabi ochronę konta. Inne metody logowania pozostaną. Potwierdź aktualnym hasłem.
            </FieldDescription>
          </FieldContent>
          <Input
            id="totp-unenroll-password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            maxLength={1024}
            placeholder="Aktualne hasło"
          />
          {error && <ErrorText>{error}</ErrorText>}
        </Field>
        <TurnstileWidget action="reauth" theme="auto" />
        <div className="flex gap-3">
          <Button type="submit" variant="destructive" disabled={isPending}>
            {isPending ? 'Wyłączanie...' : 'Wyłącz aplikację TOTP'}
          </Button>
          <Button type="button" variant="outline" onClick={reset} disabled={isPending}>
            Anuluj
          </Button>
        </div>
      </form>
    );
  }

  // Ostrzeżenie o braku odzyskiwania stoi w opisie, PRZED przyciskiem
  // włączenia (pilnuje tego `mfa-settings-ui.test.tsx`).
  return (
    <Field orientation="responsive">
      <FieldContent className="gap-2">
        <div className="flex flex-col gap-0.5">
          <FieldLabel>Weryfikacja dwuetapowa (2FA)</FieldLabel>
          <FieldDescription>
            {isEnabled
              ? 'Włączona przez aplikację TOTP'
              : 'Dodaj drugi czynnik logowania (aplikacja TOTP — Google Authenticator, 1Password, Authy). Chroni konto nawet jeśli hasło wycieknie.'}
          </FieldDescription>
        </div>
        {error && <ErrorText>{error}</ErrorText>}
        <RecoveryUnavailableNotice />
      </FieldContent>
      <div className="flex items-center gap-3">
        {isEnabled ? (
          <>
            <Badge className="bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400">Włączone</Badge>
            <Button variant="outline" onClick={() => setStage({ kind: 'unenroll' })}>
              Wyłącz aplikację TOTP
            </Button>
          </>
        ) : (
          <Button onClick={onEnroll} disabled={isPending}>
            {isPending ? 'Ładowanie...' : 'Włącz 2FA'}
          </Button>
        )}
      </div>
    </Field>
  );
}
