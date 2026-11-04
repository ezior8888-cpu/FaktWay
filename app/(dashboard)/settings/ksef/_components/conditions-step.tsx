'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { RiCheckboxCircleFill, RiCircleLine, RiRefreshLine } from '@remixicon/react';

import { CompleteNipForm } from '@/components/settings/complete-nip-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { SUPPORT_EMAIL } from '@/lib/site';
import { cn } from '@/lib/utils';

import { TwoFactorCard } from '../../security/_components/two-factor-card';
import { WIZARD_TWO_FACTOR_HREF, type WizardMfa } from './wizard-model';
import { WizardProgress } from './wizard-progress';

const AMBER_ALERT = 'border-none bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400';
const AMBER_TEXT = 'text-amber-800 dark:text-amber-400/80';
const TOUCH_BUTTON = 'h-11 w-full justify-center sm:w-auto';

function Condition({
  done,
  title,
  children,
}: {
  done: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3 border p-3" data-done={done}>
      {done ? (
        <RiCheckboxCircleFill className="mt-0.5 size-5 shrink-0 text-green-700 dark:text-green-400" aria-hidden />
      ) : (
        <RiCircleLine className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm font-medium">
          {title}
          <span className="sr-only">{done ? ': gotowe' : ': do zrobienia'}</span>
        </p>
        {children}
      </div>
    </li>
  );
}

/**
 * Krok 1: trzy warunki, każdy z wyjściem. NIP (uzupełnij tu), właściciel (kogo
 * poprosić) i logowanie dwuetapowe (włącz bez wychodzenia z kreatora albo
 * potwierdź kodem i wróć). Ekran znika sam, gdy wszystko jest spełnione.
 */
export function ConditionsStep({
  hasNip,
  nip,
  isOwner,
  mfa,
}: {
  hasNip: boolean;
  nip: string;
  isOwner: boolean;
  mfa: WizardMfa;
}) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-4" data-testid="ksef-step-warunki">
      <WizardProgress current={1} />
      <p className="text-muted-foreground text-sm">
        Zanim wskażesz pliki z KSeF, sprawdzamy trzy rzeczy. Gdy wszystkie będą gotowe, ten ekran przejdzie dalej sam.
      </p>

      <ul className="flex flex-col gap-3">
        <Condition done={hasNip} title="NIP firmy">
          {hasNip ? (
            <p className="text-muted-foreground text-xs">
              NIP: <span className="font-mono">{nip}</span>
            </p>
          ) : (
            <>
              <Alert className={AMBER_ALERT}>
                <AlertTitle>Organizacja bez NIP-u</AlertTitle>
                <AlertDescription className={AMBER_TEXT}>
                  Certyfikat KSeF jest przypisany do NIP-u firmy. Bez niego nie można go wgrać ani wysyłać faktur.
                </AlertDescription>
              </Alert>
              <p className="text-muted-foreground text-xs">
                Wpisz NIP, dane firmy pobierzemy automatycznie z bazy GUS REGON.
              </p>
              <CompleteNipForm />
            </>
          )}
        </Condition>

        <Condition done={isOwner} title="Właściciel firmy">
          {isOwner ? (
            <p className="text-muted-foreground text-xs">Jesteś właścicielem tej firmy w FaktWay.</p>
          ) : (
            <p className="text-muted-foreground text-xs">
              Certyfikat KSeF może zmienić wyłącznie właściciel organizacji. Poproś o to osobę, która założyła konto tej
              firmy w FaktWay. Jeśli nie wiesz, kto to jest, napisz do nas:{' '}
              <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-4">
                {SUPPORT_EMAIL}
              </a>
              .
            </p>
          )}
        </Condition>

        <Condition done={mfa === 'verified'} title="Logowanie dwuetapowe">
          {mfa === 'verified' ? (
            <p className="text-muted-foreground text-xs">Logowanie dwuetapowe jest włączone i potwierdzone.</p>
          ) : null}

          {mfa === 'challenge_required' ? (
            <>
              <p className="text-muted-foreground text-xs">
                Masz włączone logowanie dwuetapowe, ale w tej sesji nie wpisano jeszcze kodu z aplikacji (np. zalogowano
                się odciskiem palca). Zmiana certyfikatu wymaga kodu.
              </p>
              <Link href={WIZARD_TWO_FACTOR_HREF} className={cn(buttonVariants(), TOUCH_BUTTON)}>
                Potwierdź kodem z aplikacji
              </Link>
            </>
          ) : null}

          {mfa === 'enrollment_required' ? (
            <>
              <p className="text-muted-foreground text-xs">
                Certyfikat daje dostęp do KSeF firmy, więc zmienia się go tylko po potwierdzeniu kodem z aplikacji
                uwierzytelniającej. Włącz to teraz, zajmie to minutę.
              </p>
              <TwoFactorCard isEnabled={false} />
              <p className="text-muted-foreground text-xs">Po potwierdzeniu kodu kliknij poniższy przycisk.</p>
              <Button variant="outline" className={TOUCH_BUTTON} onClick={() => router.refresh()}>
                <RiRefreshLine aria-hidden />
                Mam włączone 2FA, sprawdź ponownie
              </Button>
            </>
          ) : null}

          {mfa === 'unknown' ? (
            <>
              <p className="text-muted-foreground text-xs">
                Nie udało się sprawdzić logowania dwuetapowego. Odśwież stronę. Jeśli to się powtarza, napisz do nas:{' '}
                <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-4">
                  {SUPPORT_EMAIL}
                </a>
                .
              </p>
              <Button variant="outline" className={TOUCH_BUTTON} onClick={() => router.refresh()}>
                <RiRefreshLine aria-hidden />
                Spróbuj ponownie
              </Button>
            </>
          ) : null}
        </Condition>
      </ul>
    </div>
  );
}
