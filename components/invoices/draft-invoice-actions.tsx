'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { RiDeleteBinLine, RiLoader4Line, RiUploadCloud2Line } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { DUPLICATE_DECISION_TEXTS } from '@/lib/ksef/duplicate-decision';
import { deleteDraftInvoiceAction, sendDraftInvoiceAction } from './draft-actions';

const PLAIN_DELETE_CONFIRM = 'Usunąć szkic? Numer faktury będzie można użyć ponownie.';

interface Props {
  invoiceId: string;
  /** VAT / KOR / ZAL / ROZ — wysłać ze szkicu można tylko zwykłą fakturę VAT. */
  invoiceType: string | null;
  /**
   * D-A4-1b-3 PR B: szkic wycofany (wpis `number_taken`) — bez „Wyślij do KSeF”
   * dla każdego rodzaju; „Usuń szkic” tylko, gdy `deletable` (korekta i faktura
   * rozliczeniowa, decyzja 9). Jedyny inny przycisk ma baner. Akcje i wyzwalacze
   * 00148 odmawiają tego samego po stronie serwera.
   */
  retired?: { deletable: boolean } | null;
}

/** Przyciski szkicu: wysyłka do KSeF i usunięcie (F-001). */
export function DraftInvoiceActions({ invoiceId, invoiceType, retired = null }: Props) {
  const router = useRouter();
  const [isSending, startSending] = useTransition();
  const [isDeleting, startDeleting] = useTransition();
  const busy = isSending || isDeleting;
  const canSend = !retired && (invoiceType ?? 'VAT') === 'VAT';
  const canDelete = !retired || retired.deletable;

  const handleSend = () => {
    startSending(async () => {
      const result = await sendDraftInvoiceAction(invoiceId);
      if (!result.success) {
        toast.error(result.error);
        // Odmowa mogła wynikać ze stanu, którego strona nie zna (np. szkic wycofany
        // decyzją zapisaną gdzie indziej — Realtime nie przelicza banera): serwer policzy go od nowa.
        router.refresh();
        return;
      }
      toast.success(
        result.offline
          ? 'KSeF jest niedostępny — faktura czeka w kolejce offline i zostanie wysłana automatycznie.'
          : 'Faktura wysłana do kolejki KSeF.',
      );
      router.refresh();
    });
  };

  const handleDelete = () => {
    if (!window.confirm(retired ? DUPLICATE_DECISION_TEXTS.RETIRED_DELETE_CONFIRM : PLAIN_DELETE_CONFIRM)) return;
    startDeleting(async () => {
      const result = await deleteDraftInvoiceAction(invoiceId);
      if (!result.success) {
        toast.error(result.error);
        // C15: jak po odmowie wysyłki — przyciski mogły być nieaktualne.
        router.refresh();
        return;
      }
      toast.success('Szkic usunięty.');
      router.push('/invoices');
    });
  };

  return (
    <>
      {canSend && (
        <Button onClick={handleSend} disabled={busy}>
          {isSending ? <RiLoader4Line className="animate-spin" /> : <RiUploadCloud2Line />}
          Wyślij do KSeF
        </Button>
      )}
      {canDelete && (
        <Button variant="outline" onClick={handleDelete} disabled={busy}>
          {isDeleting ? <RiLoader4Line className="animate-spin" /> : <RiDeleteBinLine />}
          Usuń szkic
        </Button>
      )}
    </>
  );
}
