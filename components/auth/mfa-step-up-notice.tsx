import type { ReactNode } from 'react';
import Link from 'next/link';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { mfaStepUpHref } from '@/lib/auth/mfa-step-up';
import { cn } from '@/lib/utils';

/**
 * „Ta operacja wymaga kodu”: komunikat i przejście na ekran kodu z powrotem tutaj.
 * Sesja po biometrii jest w panelu bez kodu, a operacje wrażliwe dalej go wymagają,
 * więc taka odmowa nigdy nie może zostać samym tekstem błędu.
 */
export function MfaStepUpNotice({ returnTo, children, className }: {
  returnTo: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Alert
      role="status"
      data-slot="mfa-step-up"
      className={cn('border-none bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400', className)}
    >
      <AlertDescription className="flex flex-col items-start gap-2 text-amber-800 dark:text-amber-400/80">
        <span>{children}</span>
        <Link href={mfaStepUpHref(returnTo)} className={buttonVariants({ variant: 'outline' })}>
          Potwierdź kodem z aplikacji
        </Link>
      </AlertDescription>
    </Alert>
  );
}
