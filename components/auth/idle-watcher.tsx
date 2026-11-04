'use client';

import { useCallback, useRef, useState, useTransition } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useInactivityTimeout } from '@/hooks/use-inactivity-timeout';
import { forceSignOutInactive } from '@/lib/auth/inactivity-logout';

/**
 * Monitoruje aktywność użytkownika w panelu. Po 59 min bez aktywności
 * pokazuje modal z 60-sekundowym countdownem. Po 60 min idle — automatic
 * sign-out (Server Action czyści sesję).
 *
 * Stosowane tylko w (dashboard) layout — strony marketingowe i auth
 * nie wymagają sesyjnego timeout.
 *
 * Zasada UX: w fazie warning ruch myszki NIE resetuje timera — user
 * musi explicit kliknąć "Pozostań zalogowany". Inaczej kot na klawiaturze
 * zniweczyłby ochronę.
 */
export function IdleWatcher() {
  const [isPending, startTransition] = useTransition();
  const [logoutError, setLogoutError] = useState<string | null>(null);

  const logoutInFlight = useRef(false);

  const handleTimeout = useCallback(() => {
    if (logoutInFlight.current) return;
    logoutInFlight.current = true;
    startTransition(async () => {
      setLogoutError(null);
      try {
        const result = await forceSignOutInactive();
        if (!result.ok) setLogoutError('Nie udało się wylogować tej przeglądarki. Spróbuj ponownie.');
      } catch {
        setLogoutError('Nie udało się potwierdzić wylogowania. Spróbuj ponownie.');
      } finally {
        logoutInFlight.current = false;
      }
    });
  }, []);

  const { isWarning, secondsLeft, reset } = useInactivityTimeout({
    onTimeout: handleTimeout,
  });

  return (
    // E1: Base UI nie ma onEscapeKeyDown/onPointerDownOutside — okna nie da się
    // zamknąć ani Escape, ani kliknięciem poza nim (tylko przyciski).
    <Dialog
      open={isWarning}
      disablePointerDismissal
      onOpenChange={(open, details) => {
        if (!open && details.reason === 'escape-key') details.cancel();
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Sesja wygasa</DialogTitle>
          <DialogDescription>
            {secondsLeft > 0 ? <>
              Nie wykryliśmy aktywności. Za{' '}
              <span className="font-mono font-semibold text-foreground">{secondsLeft}s</span>{' '}
              zostaniesz automatycznie wylogowany.
            </> : 'Czas bezczynności minął. Kończymy sesję na tym urządzeniu.'}
          </DialogDescription>
        </DialogHeader>
        {logoutError && <p role="alert" className="text-sm text-destructive">{logoutError}</p>}
        <div className="mt-2 flex gap-2 sm:justify-end">
          <Button
            variant="outline"
            onClick={handleTimeout}
            disabled={isPending}
          >
            {logoutError ? 'Spróbuj wylogować ponownie' : 'Wyloguj teraz'}
          </Button>
          <Button onClick={reset} disabled={isPending || secondsLeft === 0}>
            Pozostań zalogowany
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
