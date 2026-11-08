'use client';

// Plan Finora P15 (E10b): pola nowego hasła na `Field` + pole hasła Finory
// (oko). Logika bez zmian: `useActionState(resetPasswordAction)`.

import Link from 'next/link';
import { useActionState } from 'react';

import { AuthMessage } from '@/components/auth/finora/auth-message';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { PasswordInput } from '@/components/auth/finora/password-input';
import { Button } from '@/components/ui/button';

import { resetPasswordAction } from './actions';

const ERRORS = {
  invalid_link: 'Potwierdzenie odzyskiwania wygasło. Poproś o nowy link.',
  mfa_required: 'Potwierdź drugi składnik, zanim zmienisz hasło.',
  weak_password: 'Użyj od 12 do 128 znaków, małej i wielkiej litery, cyfry oraz znaku specjalnego.',
  password_breached: 'To hasło występuje w znanych wyciekach. Wybierz inne.',
  password_mismatch: 'Wpisane hasła różnią się.',
  rate_limited: 'Zbyt wiele prób. Poczekaj kilka minut.',
  verification_unavailable: 'Nie możemy teraz bezpiecznie wykonać operacji. Spróbuj ponownie za chwilę.',
  restart_required: 'Potwierdzenie zostało wykorzystane lub zapis nie został potwierdzony. Poproś o nowy link.',
} as const;

const linkClass = 'text-foreground hover:underline';

export function ResetPasswordForm() {
  const [result, action, pending] = useActionState(resetPasswordAction, null);
  if (result?.ok) {
    return (
      <div className="space-y-4">
        <AuthMessage tone="success">Hasło zostało zmienione.</AuthMessage>
        {result.passkeys === 'removed' && <AuthMessage tone="success">
          Usunęliśmy zapisane urządzenia do logowania biometrią. Zaloguj się hasłem i dodaj je ponownie
          w Ustawieniach, w zakładce Bezpieczeństwo.
        </AuthMessage>}
        {result.passkeys === 'failed' && <AuthMessage tone="error">
          Nie udało się usunąć zapisanych urządzeń do logowania biometrią. Po zalogowaniu otwórz Ustawienia,
          zakładkę Bezpieczeństwo, i usuń te, których nie rozpoznajesz. Jeśli to się nie uda, skontaktuj się z pomocą.
        </AuthMessage>}
        {!result.globalSignOutConfirmed && <AuthMessage tone="error">
          Nie udało się potwierdzić odwołania pozostałych sesji. Skontaktuj się z pomocą.
        </AuthMessage>}
        {!result.localSessionCleared && <AuthMessage tone="error">
          Nie udało się wylogować tej przeglądarki. Wyloguj się w ustawieniach konta.
        </AuthMessage>}
        <Link className={linkClass} href={result.localSessionCleared ? '/login' : '/settings/security'}>
          {result.localSessionCleared ? 'Zaloguj się nowym hasłem' : 'Ustawienia bezpieczeństwa'}
        </Link>
      </div>
    );
  }
  return (
    <form action={action}>
      <FieldGroup className="gap-4">
        {result && <AuthMessage tone="error">{ERRORS[result.error]}</AuthMessage>}
        {result && result.error === 'mfa_required' && (
          <Link href="/login/two-factor?redirect=%2Freset-password" className={linkClass}>Potwierdź 2FA</Link>
        )}
        <Field className="w-full gap-2">
          <FieldLabel htmlFor="new_password" className="leading-5">Nowe hasło*</FieldLabel>
          <PasswordInput id="new_password" name="new_password" required minLength={12} maxLength={128} autoComplete="new-password" disabled={pending} />
        </Field>
        <Field className="w-full gap-2">
          <FieldLabel htmlFor="confirm_password" className="leading-5">Powtórz nowe hasło*</FieldLabel>
          <PasswordInput id="confirm_password" name="confirm_password" required minLength={12} maxLength={128} autoComplete="new-password" disabled={pending} />
        </Field>
        <Field>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? 'Zapisuję…' : 'Zapisz nowe hasło'}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
