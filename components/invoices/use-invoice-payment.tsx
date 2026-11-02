'use client';

import { useCallback, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RiCheckLine } from '@remixicon/react';
import { toast } from 'sonner';

import { markInvoicePaidAction, undoInvoicePaidAction } from '@/app/actions/invoice-payments';
import { Button } from '@/components/ui/button';
import {
  alreadyPaidToast,
  MARK_PAID_FAILED,
  markedPaidToast,
  nothingToUndoToast,
  UNDO_PAID_FAILED,
  undonePaidToast,
  type MarkInvoicePaidResult,
  type UndoInvoicePaidResult,
} from '@/lib/invoices/manual-payment';
import { cn } from '@/lib/utils';

/** Co musi wiedzieć przycisk: identyfikator i numer do tekstów toastu. */
export interface PayableInvoice {
  id: string;
  number: string | null;
}

/** „Cofnij” w toaście to też pole dotyku: co najmniej 44×44 px (sonner rysuje je niższe). */
const TOAST_ACTION_STYLE = { minHeight: 44, minWidth: 44 };
/** Czas na „Cofnij”: dłuższy od domyślnego, bo to jedyna droga z listy. */
const UNDO_TOAST_MS = 10_000;

/**
 * Reducer do `useOptimistic`, który przy tym samym wejściu oddaje ten sam obiekt.
 * React stosuje reducer od nowa przy każdym renderze, dopóki przejście trwa, więc
 * zwykły `filter` daje za każdym razem nową tablicę. Tabela TanStack bierze to za nowe
 * dane: zeruje numer strony, czyli ustawia stan, czyli znów renderuje. Taka pętla
 * głodzi samo przejście, więc karta wisi na 100% CPU i nigdy się nie kończy.
 */
export function stableOptimisticReducer<S, A extends object>(reducer: (state: S, action: A) => S) {
  const cache = new WeakMap<A, { input: S; output: S }>();
  return (state: S, action: A): S => {
    const hit = cache.get(action);
    if (hit && hit.input === state) return hit.output;
    const output = reducer(state, action);
    cache.set(action, { input: state, output });
    return output;
  };
}

const safeMark = (id: string, paidOn?: string): Promise<MarkInvoicePaidResult> =>
  markInvoicePaidAction(id, paidOn).catch(() => ({ success: false, error: MARK_PAID_FAILED }));
const safeUndo = (id: string): Promise<UndoInvoicePaidResult> =>
  undoInvoicePaidAction(id).catch(() => ({ success: false, error: UNDO_PAID_FAILED }));

/**
 * „Zapłacone” jednym dotknięciem: bez okna potwierdzenia, od razu stan
 * optymistyczny i toast z „Cofnij”, jeszcze zanim odpowie serwer (na telefonie
 * w słabym zasięgu to może być kilka sekund).
 *
 * Wycofanie przy błędzie: `onPaid` i `onRestored` wołają setter z `useOptimistic`
 * wewnątrz przejścia, więc React zdejmuje nakładkę sam, gdy przejście się skończy.
 * Po sukcesie koniec przejścia to nowy stan z serwera (`router.refresh()`), a po
 * błędzie wiersz wraca do stanu sprzed dotknięcia.
 */
export function useInvoicePayment<T extends PayableInvoice>({
  onPaid,
  onRestored,
}: {
  onPaid?: (invoice: T, paidOn: string | undefined) => void;
  onRestored?: (invoice: T) => void;
} = {}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const undo = useCallback(
    (invoice: T, pendingMark?: Promise<MarkInvoicePaidResult>) => {
      startTransition(async () => {
        onRestored?.(invoice);
        // „Cofnij” przed odpowiedzią serwera: najpierw musi dojść samo oznaczenie.
        const marked = pendingMark ? await pendingMark : null;
        // Oznaczenie się nie udało: nie ma czego cofać, a o błędzie mówi już jego toast.
        if (marked && !marked.success) return;
        const result = await safeUndo(invoice.id);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        if (result.status === 'nothing_to_undo') toast.info(nothingToUndoToast(invoice.number));
        else toast.success(undonePaidToast(invoice.number));
        router.refresh();
      });
    },
    [onRestored, router],
  );

  const mark = useCallback(
    (invoice: T, paidOn?: string) => {
      startTransition(async () => {
        onPaid?.(invoice, paidOn);
        const pending = safeMark(invoice.id, paidOn);
        const toastId = toast.success(markedPaidToast(invoice.number), {
          duration: UNDO_TOAST_MS,
          // Styl na poziomie toastu: `action.actionButtonStyle` sonner ma w typach, ale go nie czyta.
          actionButtonStyle: TOAST_ACTION_STYLE,
          action: { label: 'Cofnij', onClick: () => undo(invoice, pending) },
        });
        const result = await pending;
        if (!result.success) {
          toast.error(result.error, { id: toastId, action: undefined, duration: UNDO_TOAST_MS });
          return;
        }
        // Inna karta albo druga osoba zdążyła pierwsza: nowej wpłaty nie ma, więc nie ma też „Cofnij”.
        if (result.status === 'already_paid') {
          toast.info(alreadyPaidToast(invoice.number), { id: toastId, action: undefined });
        }
        router.refresh();
      });
    },
    [onPaid, router, undo],
  );

  return { mark, undo, isPending };
}

/**
 * Przycisk „Zapłacone”: tekst zawsze widoczny, nic nie zależy od najechania.
 * Poniżej `lg` pole dotyku ma co najmniej 44×44 px także bez `pointer: coarse`.
 * Piksele, nie `min-h-11`: `--spacing` aplikacji jest mniejszy niż 4 px, więc 11
 * jednostek to mniej niż 44 px. Od `lg` z dotykiem pilnuje tego `buttonVariants`.
 */
export const TOUCH_TARGET = 'max-lg:min-h-[44px] max-lg:min-w-[44px]';

export function MarkPaidButton({
  number,
  onClick,
  disabled,
  className,
  iconClassName,
}: {
  number: string | null;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabled}
      aria-label={number ? `Oznacz fakturę ${number} jako zapłaconą` : 'Oznacz fakturę jako zapłaconą'}
      onClick={onClick}
      className={cn(TOUCH_TARGET, className)}
    >
      <RiCheckLine aria-hidden className={iconClassName} />
      Zapłacone
    </Button>
  );
}
