'use client';

import { useState, useTransition } from 'react';
import { RiComputerLine, RiDeviceLine, RiSmartphoneLine, RiTabletLine } from '@remixicon/react';

import { MfaStepUpNotice } from '@/components/auth/mfa-step-up-notice';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FieldDescription, FieldLabel } from '@/components/ui/field';
import type { SessionDeviceKind } from '@/lib/auth/sessions/user-agent';
import type { AccountSessionView } from '@/lib/auth/sessions/view';

import { revokeOtherSessionsAction, revokeSessionAction, type SessionActionError } from '../session-actions';

/**
 * Zalogowane urządzenia (krok 8.5). Wygląd: `security/sessions-card.tsx` Finory
 * (wiersz w ramce z ikoną urządzenia, opis pod nazwą, „Wyloguj” po prawej),
 * przyciski i potwierdzenie jak w karcie biometrii na tej samej stronie.
 * Dane czyta strona funkcją 00174 `list_account_sessions`.
 */

const RETURN_TO = '/settings/security';

const DEVICE_ICON: Record<SessionDeviceKind, typeof RiComputerLine> = {
  computer: RiComputerLine,
  phone: RiSmartphoneLine,
  tablet: RiTabletLine,
  unknown: RiDeviceLine,
};

const ERROR_MESSAGES: Record<Exclude<SessionActionError, 'mfa_required'>, string> = {
  invalid_request: 'Nie rozpoznaliśmy tego urządzenia. Odśwież stronę i spróbuj ponownie.',
  not_authenticated: 'Sesja na tym urządzeniu wygasła. Zaloguj się ponownie i spróbuj jeszcze raz.',
  current_session: 'To urządzenie wylogujesz przyciskiem „Wyloguj” w menu konta.',
  verification_unavailable: 'Nie możemy teraz potwierdzić operacji. Spróbuj ponownie za chwilę.',
  failed: 'Nie udało się wylogować urządzenia. Spróbuj ponownie za chwilę.',
};

export type SessionsLoadState = 'ok' | 'failed' | 'code_required';

interface Props {
  initialSessions: AccountSessionView[];
  state: SessionsLoadState;
  /** Strona pokazuje już wyżej przejście do kodu (sesja po biometrii): tu wystarczy zdanie. */
  stepUpShownAbove?: boolean;
}

function whereLine(session: AccountSessionView): string {
  const parts = [
    session.isCurrent ? 'To urządzenie' : null,
    session.ip ? `IP ${session.ip}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Adres nieznany';
}

function whenLine(session: AccountSessionView): string {
  const signedIn = session.signedInAt
    ? `Zalogowano: ${session.signedInAt}${session.method ? ` (${session.method})` : ''}`
    : null;
  const active = session.isCurrent
    ? 'Aktywne teraz'
    : session.lastActiveAt ? `Ostatnia aktywność: ${session.lastActiveAt}` : null;
  return [signedIn, active].filter(Boolean).join(' · ');
}

export function SessionsCard({ initialSessions, state, stepUpShownAbove = false }: Props) {
  const [sessions, setSessions] = useState(initialSessions);
  const [isPending, startTransition] = useTransition();
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsCode, setNeedsCode] = useState(state === 'code_required');

  const others = sessions.filter((session) => !session.isCurrent);

  const clearMessages = () => {
    setError(null);
    setNotice(null);
  };

  const fail = (code: SessionActionError) => {
    if (code === 'mfa_required') setNeedsCode(true);
    else setError(ERROR_MESSAGES[code]);
  };

  const onRevoke = (id: string) => {
    clearMessages();
    setConfirmingAll(false);
    startTransition(async () => {
      const result = await revokeSessionAction({ sessionId: id });
      if (!result.ok) {
        fail(result.error);
        return;
      }
      setSessions((current) => current.filter((session) => session.id !== id));
      setNotice(result.revoked
        ? 'Urządzenie wylogowane. Przy następnym działaniu w FaktWay zobaczy ekran logowania.'
        : 'To urządzenie było już wylogowane.');
    });
  };

  const onRevokeOthers = () => {
    clearMessages();
    startTransition(async () => {
      const result = await revokeOtherSessionsAction();
      setConfirmingAll(false);
      if (!result.ok) {
        fail(result.error);
        return;
      }
      setSessions((current) => current.filter((session) => session.isCurrent));
      // Bez liczby: baza wylogowuje też sesje spoza listy (wygasłe, ponad 50 pokazanych),
      // więc liczba nie zgadzałaby się z tym, co klient widział. Liczba jest w audycie.
      setNotice(result.count > 0
        ? 'Wylogowaliśmy wszystkie pozostałe urządzenia.'
        : 'Nie było innych zalogowanych urządzeń.');
    });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="account-sessions">
      <div>
        <FieldLabel>Zalogowane urządzenia</FieldLabel>
        <FieldDescription>
          Przeglądarki i aplikacje, w których konto jest teraz zalogowane. Nie rozpoznajesz urządzenia?
          Wyloguj je i zmień hasło.
        </FieldDescription>
      </div>

      {needsCode && (stepUpShownAbove ? (
        <p className="text-muted-foreground text-xs">
          Lista urządzeń pojawi się po potwierdzeniu kodem z aplikacji uwierzytelniającej.
        </p>
      ) : (
        <MfaStepUpNotice returnTo={RETURN_TO}>
          Lista urządzeń i wylogowanie na odległość wymagają kodu z aplikacji uwierzytelniającej. Po potwierdzeniu wrócisz tutaj.
        </MfaStepUpNotice>
      ))}
      {state === 'failed' && (
        <p role="alert" className="text-destructive text-xs">Nie udało się wczytać listy urządzeń. Odśwież stronę.</p>
      )}
      {error && <p role="alert" className="text-destructive text-xs">{error}</p>}
      {notice && (
        <Alert role="status" className="border-none bg-green-600/10 text-green-800 dark:bg-green-400/10 dark:text-green-400">
          <AlertDescription className="text-green-800 dark:text-green-400/80">{notice}</AlertDescription>
        </Alert>
      )}

      {sessions.length > 0 && (
        <ul className="flex flex-col gap-3">
          {sessions.map((session) => {
            const DeviceIcon = DEVICE_ICON[session.kind];
            return (
              <li
                key={session.id}
                data-testid="account-session"
                className="flex flex-col gap-3 border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="bg-muted flex size-10 shrink-0 items-center justify-center" aria-hidden="true">
                    <DeviceIcon className="text-muted-foreground size-5" />
                  </div>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium break-words">{session.device}</span>
                    <span className="text-muted-foreground text-xs break-words">{whereLine(session)}</span>
                    <span className="text-muted-foreground text-xs break-words">{whenLine(session)}</span>
                  </div>
                </div>
                {!session.isCurrent && (
                  <div>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-[44px]"
                      disabled={isPending}
                      aria-label={`Wyloguj ${session.device}`}
                      onClick={() => onRevoke(session.id)}
                    >
                      Wyloguj
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {others.length > 0 && (confirmingAll ? (
        <div className="flex flex-col gap-2 border p-3">
          <p className="text-sm">
            Wylogujemy wszystkie urządzenia poza tym. Na każdym trzeba będzie zalogować się ponownie.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" className="min-h-[44px]" disabled={isPending} onClick={onRevokeOthers}>
              Tak, wyloguj
            </Button>
            <Button type="button" variant="outline" className="min-h-[44px]" disabled={isPending} onClick={() => setConfirmingAll(false)}>
              Anuluj
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            type="button"
            variant="outline"
            className="min-h-[44px]"
            disabled={isPending}
            onClick={() => { clearMessages(); setConfirmingAll(true); }}
          >
            Wyloguj wszystkie inne urządzenia
          </Button>
        </div>
      ))}

      {state === 'ok' && (
        <FieldDescription>
          Wylogowane urządzenie traci dostęp przy następnym działaniu w FaktWay. Ostatnia aktywność odświeża się
          mniej więcej co godzinę.
        </FieldDescription>
      )}
    </div>
  );
}
