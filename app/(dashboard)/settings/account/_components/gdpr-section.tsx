'use client';

import { useState, useTransition } from 'react';
import { RiDownloadLine } from '@remixicon/react';
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import { TurnstileWidget } from '@/components/auth/turnstile-widget';
import { Separator } from '@/components/ui/separator';
import {
  cancelOwnGdprDeletionAction, requestGdprDeletionAction,
  type GdprCancellationResult, type GdprDeletionResult,
} from '../actions';

const ERROR_MESSAGES: Record<string, string> = {
  not_authenticated: 'Sesja wygasła. Zaloguj się ponownie.',
  mfa_required: 'Potwierdź logowanie kodem weryfikacji dwuetapowej i spróbuj ponownie.',
  session_verification_failed: 'Nie udało się zweryfikować sesji. Zaloguj się ponownie.',
  invalid_password: 'Hasło nieprawidłowe.',
  rate_limited: 'Zbyt wiele prób potwierdzenia hasła. Odczekaj kilka minut i spróbuj ponownie.',
  verification_unavailable: 'Nie udało się bezpiecznie potwierdzić hasła. Spróbuj ponownie później.',
  no_email: 'Twoje konto nie ma przypisanego emaila.',
  request_failed: 'Nie udało się potwierdzić operacji. Odśwież stronę i sprawdź stan żądania.',
  not_pending: 'Żądanie zostało zakończone albo usuwanie konta już się rozpoczęło. Odśwież stronę.',
  active_subscription: 'Jesteś jedyną osobą, która może zarządzać subskrypcją firmy. Po usunięciu konta opłaty pobierałyby się dalej, a nikt nie mógłby ich zatrzymać. Najpierw anuluj subskrypcję w Ustawienia → Abonament albo nadaj innej osobie rolę właściciela lub administratora.',
};
const blockedOrganizations = (result: GdprDeletionResult | null) =>
  result && !result.ok && result.organizations?.length ? ` Dotyczy: ${result.organizations.join(', ')}.` : '';
type ScheduledRequest = { scheduledFor: string; status: 'pending' | 'processing' };

export function GdprSection({ initialRequest = null }: { initialRequest?: ScheduledRequest | null }) {
  const [scheduled, setScheduled] = useState(initialRequest);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<GdprDeletionResult | null>(null);
  const [cancellation, setCancellation] = useState<GdprCancellationResult | null>(null);
  const [isPending, startTransition] = useTransition();

  const requestDeletion = (formData: FormData) => {
    setResult(null);
    setCancellation(null);
    startTransition(async () => {
      const response = await requestGdprDeletionAction(formData);
      setResult(response);
      if (response.ok) {
        setScheduled({ scheduledFor: response.scheduledFor, status: 'pending' });
        setConfirming(false);
      }
    });
  };
  const cancelDeletion = (formData: FormData) => {
    setCancellation(null);
    startTransition(async () => {
      const response = await cancelOwnGdprDeletionAction(formData);
      setCancellation(response);
      if (response.ok) {
        setScheduled(null);
        setResult(null);
      }
    });
  };

  const needsCode = (result && !result.ok && result.error === 'mfa_required')
    || (cancellation && !cancellation.ok && cancellation.error === 'mfa_required');

  // Wygląd z Finory (`views/settings/privacy`): „Export my data” (opis
  // i przycisk), separator, „Delete account” jako wiersz z przyciskiem
  // destrukcyjnym; potwierdzenie hasłem w miejscu, jak pola
  // `change-password-card.tsx`.
  return (
    <FieldGroup>
      <div>
        <p className="text-sm font-medium">Pobierz moje dane</p>
        <p className="text-muted-foreground mb-3 text-xs">
          Eksport JSON profilu konta, członkostw i ostatnich wpisów audytu. Plik wskazuje ograniczenia wyników. Faktury
          pobierzesz przez eksport w panelu firmy.
        </p>
        <a href="/api/gdpr/export" className={buttonVariants({ variant: 'outline' })}>
          <RiDownloadLine aria-hidden />
          Pobierz dane (JSON)
        </a>
      </div>

      {/* Sesja po biometrii: usunięcie i anulowanie konta wymagają prawdziwego kodu. */}
      {needsCode && (
        <MfaStepUpNotice returnTo="/settings/account">
          Ta operacja wymaga kodu z aplikacji. Po potwierdzeniu wrócisz tutaj.
        </MfaStepUpNotice>
      )}

      {cancellation?.ok && (
        <Alert role="status" className="border-none bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400">
          <AlertDescription className="text-green-800 dark:text-green-400/80">
            Usunięcie konta zostało anulowane. Konto pozostaje aktywne.
          </AlertDescription>
        </Alert>
      )}

      <Separator />

      {scheduled ? (
        <div className="flex flex-col gap-4">
          <div>
            <FieldLabel>
              {scheduled.status === 'processing' ? 'Usuwanie konta rozpoczęte' : 'Usunięcie konta zaplanowane'}
            </FieldLabel>
            {scheduled.status === 'processing' ? (
              <FieldDescription>
                Usuwanie konta już się rozpoczęło. Nie można go teraz anulować. W razie wątpliwości skontaktuj się
                z pomocą.
              </FieldDescription>
            ) : (
              <FieldDescription>
                Planowana data usunięcia: <strong>{scheduled.scheduledFor}</strong>.
              </FieldDescription>
            )}
          </div>
          {scheduled.status === 'processing' ? null : (
            <>
              {result?.ok && (
                <Alert role="status">
                  <AlertDescription>
                    {result.alreadyScheduled
                      ? 'Żądanie było już zaplanowane. Poprzedni link z maila pozostaje ważny; termin nie został zmieniony.'
                      : result.emailSent
                        ? 'Wysłaliśmy email z linkiem do anulowania. Możesz też anulować żądanie poniżej.'
                        : 'Żądanie zapisano, ale nie udało się wysłać emaila. Możesz anulować je tutaj, potwierdzając hasłem.'}
                  </AlertDescription>
                </Alert>
              )}
              <form action={cancelDeletion} className="flex flex-col gap-4">
                <Field data-invalid={cancellation && !cancellation.ok ? true : undefined}>
                  <FieldContent>
                    <FieldLabel htmlFor="gdpr-cancel-password">Aktualne hasło</FieldLabel>
                    <FieldDescription>Aby zachować konto, potwierdź aktualne hasło.</FieldDescription>
                  </FieldContent>
                  <Input
                    id="gdpr-cancel-password"
                    name="current_password"
                    type="password"
                    required
                    autoComplete="current-password"
                    placeholder="Aktualne hasło"
                  />
                  {cancellation && !cancellation.ok && (
                    <p role="alert" className="text-destructive text-xs">{ERROR_MESSAGES[cancellation.error]}</p>
                  )}
                </Field>
                <TurnstileWidget action="reauth" theme="auto" />
                <div>
                  <Button type="submit" variant="outline" disabled={isPending}>
                    {isPending ? 'Potwierdzanie...' : 'Anuluj usunięcie konta'}
                  </Button>
                </div>
              </form>
            </>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field orientation="horizontal" className="items-center!">
            <FieldContent>
              <FieldLabel>Trwałe usunięcie konta</FieldLabel>
              <FieldDescription>
                Usunięcie konta zostanie zaplanowane z 14-dniowym okresem na wycofanie decyzji. Faktury objęte
                retencją pozostaną w organizacjach.
              </FieldDescription>
            </FieldContent>
            {!confirming ? (
              <Button variant="destructive" onClick={() => setConfirming(true)}>
                Usuń moje konto
              </Button>
            ) : null}
          </Field>
          {confirming ? (
            <form action={requestDeletion} className="flex flex-col gap-4">
              <Field data-invalid={result && !result.ok ? true : undefined}>
                <FieldContent>
                  <FieldLabel htmlFor="gdpr-delete-password">Aktualne hasło</FieldLabel>
                </FieldContent>
                <Input
                  id="gdpr-delete-password"
                  name="current_password"
                  type="password"
                  required
                  autoComplete="current-password"
                  placeholder="Aktualne hasło"
                />
                {result && !result.ok && (
                  <p role="alert" className="text-destructive text-xs">
                    {ERROR_MESSAGES[result.error]}
                    {blockedOrganizations(result)}
                  </p>
                )}
              </Field>
              <TurnstileWidget action="reauth" theme="auto" />
              <div className="flex gap-3">
                <Button type="submit" variant="destructive" disabled={isPending}>
                  {isPending ? 'Zapisywanie...' : 'Potwierdź żądanie'}
                </Button>
                <Button type="button" variant="outline" disabled={isPending} onClick={() => setConfirming(false)}>
                  Wróć
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      )}
    </FieldGroup>
  );
}
