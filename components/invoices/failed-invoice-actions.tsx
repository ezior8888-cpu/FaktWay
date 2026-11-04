'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { RiArrowGoBackLine, RiLoader4Line, RiSettings3Line, RiUploadCloud2Line } from '@remixicon/react';

import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import { failedInvoiceButtons, resetDoneMessage } from '@/lib/invoices/ksef-send-policy';
import { resendInvoiceAction, resetInvoiceToDraftAction } from './actions-detail';

interface Props {
  invoiceId: string;
  /** `failed` albo `rejected` — dla innych stanów komponent nic nie renderuje. */
  status: string;
  errorCode: string | null;
  invoiceKind: string | null;
  canManage: boolean;
  /** A4b PR2b: fakty ponowienia z kopii (liczone na serwerze, bez treści dokumentu). */
  facts: KsefResendFacts;
  environmentKnown: boolean;
  /**
   * `KSEF_DUPLICATE_RECONCILE`: nad paskiem stoi panel duplikatu (decyzja albo
   * nota) — zdanie odsyła do ramki wyżej (D-A4-1b-3 PR B).
   */
  duplicatePanel?: boolean;
}

/**
 * Przyciski po nieudanej wysyłce wg tabeli stanów (cykl życia faktury,
 * sekcja 7): „Wyślij ponownie”, „Wróć do szkicu”, link do ustawień KSeF —
 * albo samo wyjaśnienie, gdy sprawą zajmuje się automat lub operator.
 * Decyzję podejmuje `failedInvoiceButtons`, tę samą, którą sprawdzają akcje.
 */
export function FailedInvoiceActions({
  invoiceId,
  status,
  errorCode,
  invoiceKind,
  canManage,
  facts,
  environmentKnown,
  duplicatePanel = false,
}: Props) {
  const router = useRouter();
  const [isResending, startResending] = useTransition();
  const [isResetting, startResetting] = useTransition();
  const plan = failedInvoiceButtons({ status, errorCode, invoiceKind, canManage, facts, environmentKnown, duplicatePanel });
  if (!plan) return null;
  const busy = isResending || isResetting;

  const handleResend = () => {
    startResending(async () => {
      const result = await resendInvoiceAction(invoiceId);
      if (!result.success) {
        toast.error(result.error);
        // Strona otwarta po północy: serwer przeliczy fakty i zamieni przycisk na wyjaśnienie.
        router.refresh();
        return;
      }
      toast.success('Faktura wróciła do kolejki KSeF.');
      router.refresh();
    });
  };

  const handleReset = () => {
    if (!window.confirm('Wrócić do szkicu? Dane wysyłki zostaną wyczyszczone, numer faktury zostaje.')) return;
    startResetting(async () => {
      const result = await resetInvoiceToDraftAction(invoiceId);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      // KSEF_NUMBER_TAKEN: szkic wraca jako wycofany — tekst wg rodzaju (C4, decyzja 9).
      toast.success(resetDoneMessage(invoiceKind, facts, errorCode));
      router.refresh();
    });
  };

  // Prawa kolumna podglądu (Finora `invoice-actions.tsx`): opis, pod nim przyciski jeden pod
  // drugim na całą szerokość (kolejność przycisków bez zmian).
  return (
    <div className="w-full space-y-4">
      <p className="text-muted-foreground text-sm">{plan.info}</p>
      {(plan.resend || plan.reset || plan.settings) && (
        <div className="space-y-4">
          {plan.settings && (
            <Link href="/settings/ksef" className={cn(buttonVariants({ variant: 'outline' }), 'w-full')}>
              <RiSettings3Line />
              Ustawienia KSeF
            </Link>
          )}
          {plan.reset && (
            <Button variant="outline" className="w-full" onClick={handleReset} disabled={busy}>
              {isResetting ? <RiLoader4Line className="animate-spin" /> : <RiArrowGoBackLine />}
              Wróć do szkicu
            </Button>
          )}
          {plan.resend && (
            <Button className="w-full" onClick={handleResend} disabled={busy}>
              {isResending ? <RiLoader4Line className="animate-spin" /> : <RiUploadCloud2Line />}
              Wyślij ponownie
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
