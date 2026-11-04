import Link from 'next/link';
import { RiArrowRightLine, RiHistoryLine, RiRefreshLine } from '@remixicon/react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { formatSettingsDate } from '@/components/settings/finora/format-date';
import { cn } from '@/lib/utils';

import { WIZARD_CERTIFICATE_HREF } from './wizard-model';
import { WizardProgress } from './wizard-progress';

const AMBER_ALERT = 'border-none bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400';
const AMBER_TEXT = 'text-amber-800 dark:text-amber-400/80';
const TOUCH_BUTTON = 'h-11 w-full justify-center sm:w-auto';
const DAY_MS = 24 * 3600 * 1000;
/** Tyle dni przed końcem ważności podpowiadamy odnowienie (zbieżnie z mailem o wygasającym certyfikacie). */
const EXPIRY_WARNING_DAYS = 30;

/** Krok 5: firma, NIP, ważność certyfikatu, co robi FaktWay i dokąd iść dalej. */
export function ConnectedStep({
  name,
  nip,
  validTo,
  isOwner,
  now = new Date(),
}: {
  name: string;
  nip: string;
  validTo: string | null;
  isOwner: boolean;
  now?: Date;
}) {
  const expiry = validTo ? new Date(validTo) : null;
  const daysLeft = expiry && !Number.isNaN(expiry.getTime()) ? Math.ceil((expiry.getTime() - now.getTime()) / DAY_MS) : null;
  const expiring = daysLeft !== null && daysLeft <= EXPIRY_WARNING_DAYS;

  return (
    <div className="flex flex-col gap-4" data-testid="ksef-step-polaczono">
      <WizardProgress current={5} />

      <Alert role="status">
        <AlertTitle>Połączono z KSeF</AlertTitle>
        <AlertDescription>
          {name}, NIP <span className="font-mono">{nip}</span>.
          {validTo ? ` Certyfikat ważny do ${formatSettingsDate(validTo)}.` : ''}
        </AlertDescription>
      </Alert>

      {expiring ? (
        <Alert role="note" className={AMBER_ALERT}>
          <AlertTitle>{daysLeft! > 0 ? `Certyfikat wygasa za ${daysLeft} dni` : 'Certyfikat wygasł'}</AlertTitle>
          <AlertDescription className={AMBER_TEXT}>
            Wygeneruj nowy w Aplikacji Podatnika i odnów go tutaj, zanim wygaśnie. Inaczej wysyłka faktur do KSeF się
            zatrzyma.
          </AlertDescription>
        </Alert>
      ) : null}

      <p className="text-muted-foreground text-sm">
        FaktWay pobiera z KSeF historię faktur sprzedaży i zakupów, a potem na bieżąco nowe faktury. Faktury wystawione
        w FaktWay wysyłamy do KSeF za Ciebie.
      </p>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Link href="/invoices/new" className={cn(buttonVariants(), TOUCH_BUTTON)}>
          Wystaw pierwszą fakturę
          <RiArrowRightLine aria-hidden />
        </Link>
        <Link href="/import-danych" className={cn(buttonVariants({ variant: 'outline' }), TOUCH_BUTTON)}>
          <RiHistoryLine aria-hidden />
          Zobacz postęp
        </Link>
        {isOwner ? (
          <Link href={WIZARD_CERTIFICATE_HREF} className={cn(buttonVariants({ variant: 'ghost' }), TOUCH_BUTTON)}>
            <RiRefreshLine aria-hidden />
            Odnów certyfikat
          </Link>
        ) : null}
      </div>
    </div>
  );
}
