'use client';

import { useRef, useState, useTransition, type FormEvent } from 'react';
import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import { refreshTurnstileToken, TurnstileWidget } from '@/components/auth/turnstile-widget';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import {
  changePasswordAction,
  requestPasswordChangeNonceAction,
  type PasswordChangeResult,
} from '../actions';

const ERROR_MESSAGES: Record<Exclude<PasswordChangeResult, { ok: true }>['error'], string> = {
  not_authenticated: 'Sesja wygasła. Zaloguj się ponownie.',
  invalid_current: 'Aktualne hasło jest nieprawidłowe.',
  mfa_required: 'Potwierdź logowanie kodem z aplikacji 2FA i spróbuj ponownie.',
  verification_unavailable: 'Nie możemy teraz potwierdzić operacji. Spróbuj ponownie za chwilę.',
  weak_password: 'Nowe hasło musi mieć 12–128 znaków, małą i dużą literę, cyfrę oraz znak specjalny.',
  password_breached: 'To hasło pojawiło się w znanych wyciekach danych. Wybierz inne.',
  update_failed: 'Nie udało się zmienić hasła. Spróbuj ponownie.',
  reauthentication_needed: 'Zmiana hasła wymaga dodatkowego potwierdzenia. Wyślij kod i wpisz go poniżej.',
  invalid_nonce: 'Kod potwierdzenia jest nieprawidłowy lub wygasł. Wpisz go ponownie albo wyślij nowy kod.',
  same_password: 'Nowe hasło musi różnić się od aktualnego.',
  rate_limited: 'Zbyt wiele prób. Odczekaj przed kolejną próbą.',
  nonce_send_failed: 'Nie udało się wysłać kodu potwierdzenia. Spróbuj ponownie za chwilę.',
};

export function PasswordChangeCard() {
  const formRef = useRef<HTMLFormElement>(null);
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<PasswordChangeResult | null>(null);
  const [needsNonce, setNeedsNonce] = useState(false);
  const [nonceSent, setNonceSent] = useState(false);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    // Turnstile wstrzymał wysyłkę do gotowego tokenu i wyśle formularz sam.
    if (event.defaultPrevented) return;
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setResult(null);
    startTransition(async () => {
      try {
        const response = await changePasswordAction(data);
        setResult(response);
        if (response.ok) {
          // Native submit handling preserves fields on errors and clears secrets on success.
          form.reset();
          setNeedsNonce(false);
          setNonceSent(false);
        } else if (response.error === 'reauthentication_needed' || response.error === 'invalid_nonce') {
          setNeedsNonce(true);
        }
      } catch {
        setResult({ ok: false, error: 'verification_unavailable' });
      }
    });
  }

  function sendNonce() {
    const form = formRef.current;
    if (!form) return;
    const fields = new FormData(form);
    const data = new FormData();
    data.set('current_password', fields.get('current_password') ?? '');
    // Hasło sprawdza GoTrue, a przy włączonej captcha wymaga tokenu (jednorazowego).
    data.set('cf-turnstile-response', fields.get('cf-turnstile-response') ?? '');
    refreshTurnstileToken(form);
    setResult(null);
    setNonceSent(false);
    startTransition(async () => {
      try {
        const response = await requestPasswordChangeNonceAction(data);
        if (!response.ok) {
          setResult(response);
          return;
        }
        const input = form.elements.namedItem('nonce');
        if (input instanceof HTMLInputElement) input.value = '';
        setNonceSent(true);
      } catch {
        setResult({ ok: false, error: 'verification_unavailable' });
      }
    });
  }

  const failure = result && !result.ok ? result : null;
  // Układ `change-password-card.tsx` z Finory: nagłówek „Hasło” z opisem,
  // pola z etykietą nad polem na całą szerokość, separator, przycisk.
  return (
    <form ref={formRef} onSubmit={onSubmit} aria-busy={isPending}>
      <FieldGroup>
        <Field orientation="responsive">
          <FieldContent>
            <FieldLabel>Hasło</FieldLabel>
            <FieldDescription>
              Zmień hasło — wymagamy minimum 12 znaków, mieszanki liter, cyfr i znaków specjalnych. Sprawdzamy też
              w bazie wycieków.
            </FieldDescription>
          </FieldContent>
        </Field>

        {result?.ok && (
          <Alert role="status" className="border-none bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400">
            <AlertDescription className="text-green-800 dark:text-green-400/80">Hasło zmienione.</AlertDescription>
          </Alert>
        )}
        {failure?.error === 'mfa_required' && (
          <MfaStepUpNotice returnTo="/settings/security">{ERROR_MESSAGES.mfa_required}</MfaStepUpNotice>
        )}
        {failure && failure.error !== 'mfa_required' && (
          <Alert variant="destructive">
            <AlertDescription>
              {ERROR_MESSAGES[failure.error]}
              {failure.error === 'rate_limited' && failure.retryAfter && (
                <span> Spróbuj ponownie za {failure.retryAfter} s.</span>
              )}
            </AlertDescription>
          </Alert>
        )}

        <Field orientation="responsive" className="flex-col!">
          <FieldContent>
            <FieldLabel htmlFor="current_password">Aktualne hasło</FieldLabel>
          </FieldContent>
          <div className="w-full!">
            <Input
              id="current_password"
              name="current_password"
              type="password"
              required
              maxLength={1024}
              autoComplete="current-password"
              placeholder="Aktualne hasło"
            />
          </div>
        </Field>

        <Field orientation="responsive" className="flex-col!">
          <FieldContent>
            <FieldLabel htmlFor="new_password">Nowe hasło</FieldLabel>
            <FieldDescription>12–128 znaków, mała i duża litera, cyfra oraz znak specjalny.</FieldDescription>
          </FieldContent>
          <div className="w-full!">
            <Input
              id="new_password"
              name="new_password"
              type="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
              placeholder="Nowe hasło"
            />
          </div>
        </Field>

        {needsNonce && (
          <Field orientation="responsive" className="flex-col!">
            <FieldContent>
              <FieldLabel htmlFor="nonce">Kod potwierdzenia</FieldLabel>
              <FieldDescription>
                Kod potwierdzenia wyślemy na adres e-mail lub numer telefonu przypisany do konta. To osobny kod do
                zmiany hasła.
              </FieldDescription>
            </FieldContent>
            <div className="flex w-full! flex-col gap-3">
              <div>
                <Button type="button" variant="outline" disabled={isPending} onClick={sendNonce}>
                  {nonceSent ? 'Wyślij ponownie kod' : 'Wyślij kod potwierdzenia'}
                </Button>
              </div>
              {nonceSent && (
                <p role="status" className="text-muted-foreground text-xs">
                  Kod został wysłany. Ponowna wysyłka jest możliwa najwcześniej po minucie.
                </p>
              )}
              <Input
                id="nonce"
                name="nonce"
                type="text"
                required
                minLength={6}
                maxLength={10}
                pattern="[0-9]{6,10}"
                inputMode="numeric"
                autoComplete="one-time-code"
              />
            </div>
          </Field>
        )}

        <TurnstileWidget action="reauth" theme="auto" />

        <Separator />

        <div>
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Proszę czekać...' : 'Zmień hasło'}
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
