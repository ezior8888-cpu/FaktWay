import Link from 'next/link';
import { RiArrowRightLine, RiExternalLinkLine } from '@remixicon/react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { KSEF_ENVIRONMENT_LABELS } from '@/lib/ksef/application-url';
import { SUPPORT_EMAIL } from '@/lib/site';
import { cn } from '@/lib/utils';
import type { KsefEnvironment } from '@/types/ksef';

import { WIZARD_FILES_HREF } from './wizard-model';
import { WizardProgress } from './wizard-progress';

const AMBER_ALERT = 'border-none bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400';
const AMBER_TEXT = 'text-amber-800 dark:text-amber-400/80';
const TOUCH_BUTTON = 'h-11 w-full justify-center sm:w-auto';

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: 'Zaloguj się w Aplikacji Podatnika na właściwą firmę',
    body: 'Wybierz firmę, którą łączysz z FaktWay. Zalogujesz się tak jak do KSeF, np. profilem zaufanym, podpisem kwalifikowanym albo pieczęcią firmową.',
  },
  {
    title: 'Wejdź w „Certyfikaty”, a potem w „Wnioskuj o certyfikat”',
    body: 'Wpisz dowolną nazwę, np. FaktWay.',
  },
  {
    title: 'Ustaw hasło do klucza i zapisz je',
    body: 'Aplikacja poprosi o mocne hasło (powtórzone dwa razy). Nie da się go potem odczytać ani zmienić, a bez niego plik klucza jest bezużyteczny.',
  },
  {
    title: 'Kliknij „Generuj” i zachowaj plik klucza (.key)',
    body: 'Przeglądarka zapisze go na Twoim urządzeniu. Drugi raz nie da się go pobrać. Jeśli go zgubisz, trzeba wygenerować nowy certyfikat.',
  },
  {
    title: 'W polu „Przeznaczenie certyfikatu” wybierz „Uwierzytelnienie w systemie KSeF” i wyślij wniosek',
    body: 'Nie wybieraj opcji do podpisu linku weryfikującego wystawcę (typ Offline): taki certyfikat nie pozwala zalogować się do KSeF.',
  },
  {
    title: 'Pobierz plik certyfikatu (.crt)',
    body: 'Po chwili certyfikat pojawi się na liście certyfikatów. Pobierz go. Masz teraz dwa pliki: certyfikat (.crt) i klucz (.key).',
  },
];

/** Krok 2: instrukcja zgodna z Aplikacją Podatnika (nazwy opisane w dokumentacji MF i pomocach programów do faktur). */
export function CertificateStep({
  nip,
  env,
  applicationUrl,
}: {
  nip: string;
  env: KsefEnvironment | null;
  applicationUrl: string;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="ksef-step-certyfikat">
      <WizardProgress current={2} />

      <p className="text-muted-foreground text-sm">
        FaktWay loguje się do KSeF certyfikatem wystawionym przez Ministerstwo Finansów. Zrobisz go raz, w Aplikacji
        Podatnika, a potem wskażesz tu dwa pliki. Zajmie to kilka minut.
      </p>

      {env && env !== 'production' ? (
        <Alert role="note" className={AMBER_ALERT}>
          <AlertTitle>To środowisko {KSEF_ENVIRONMENT_LABELS[env]} KSeF</AlertTitle>
          <AlertDescription className={AMBER_TEXT}>
            Certyfikat musi pochodzić z Aplikacji Podatnika pod adresem poniżej. Certyfikat z prawdziwego KSeF tu nie
            zadziała.
          </AlertDescription>
        </Alert>
      ) : null}

      <a
        href={applicationUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(buttonVariants({ variant: 'outline' }), TOUCH_BUTTON)}
      >
        <RiExternalLinkLine aria-hidden />
        Otwórz Aplikację Podatnika
      </a>
      <p className="text-muted-foreground -mt-2 text-xs break-all">{applicationUrl}</p>

      <ol className="flex flex-col gap-3" data-testid="ksef-instrukcja">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex gap-3">
            <span
              className="bg-muted text-foreground flex size-6 shrink-0 items-center justify-center text-xs font-medium"
              aria-hidden
            >
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium">{step.title}</p>
              <p className="text-muted-foreground text-xs">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <Alert role="note">
        <AlertTitle>Kto może to zrobić</AlertTitle>
        <AlertDescription>
          Certyfikat musi wystawić właściciel firmy w KSeF (osoba z pełnymi uprawnieniami do firmy z NIP {nip}). Jeśli to
          ktoś inny, przekaż mu tę instrukcję. Nazwy przycisków w Aplikacji Podatnika mogą się trochę różnić. Jeśli
          utkniesz, napisz do nas:{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="underline underline-offset-4">
            {SUPPORT_EMAIL}
          </a>
          .
        </AlertDescription>
      </Alert>

      <Link href={WIZARD_FILES_HREF} className={cn(buttonVariants(), TOUCH_BUTTON)} data-testid="ksef-dalej">
        Mam oba pliki i hasło, dalej
        <RiArrowRightLine aria-hidden />
      </Link>
    </div>
  );
}
