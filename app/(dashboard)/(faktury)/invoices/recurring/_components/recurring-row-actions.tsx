'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  RiDeleteBinLine,
  RiEditLine,
  RiFlashlightLine,
  RiLoader4Line,
  RiMore2Line,
  RiPauseLine,
  RiPlayLine,
} from '@remixicon/react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  deleteRecurringInvoiceAction,
  pauseRecurringInvoiceAction,
  resumeRecurringInvoiceAction,
} from '@/app/actions/recurring-invoices';
import type { RecurringInvoiceListItem } from '@/lib/invoices/recurring/queries';

/** „Wystaw teraz”: formularz zwykłej faktury z podkładem wzoru (plan Finora N1). */
export function issueNowHref(id: string): string {
  return `/invoices/new/regular?cykliczna=${encodeURIComponent(id)}`;
}

/**
 * Akcje jednej pozycji (P6): „Wystaw teraz” (link), „Usuń” (z potwierdzeniem)
 * i menu „⋯” z „Wstrzymaj / Wznów” oraz „Edytuj”. JEDEN komponent dla tabeli
 * i dla karty na telefonie — inaczej dwie kopie obsługi wstrzymania i usuwania.
 *
 * „Wystaw teraz” dla wstrzymanej pozycji jest nieaktywne (jak w Finorze:
 * `disabled={!isActive}`): strona formularza odmówiłaby i tak. Żadna z akcji
 * nie tworzy faktury — fakturę wystawia człowiek w formularzu.
 *
 * `layout='card'` (karta poniżej `lg`): „Wystaw teraz” jako przycisk z
 * napisem — na telefonie nie ma podpowiedzi po najechaniu, a to główna akcja
 * wiersza. Usuń i „⋯” zostają ikonami jak w tabeli.
 */
export function RecurringRowActions({
  item,
  onEdit,
  layout = 'table',
}: {
  item: RecurringInvoiceListItem;
  onEdit: (item: RecurringInvoiceListItem) => void;
  layout?: 'table' | 'card';
}) {
  const router = useRouter();
  const [togglePending, startToggle] = useTransition();
  const [deletePending, startDelete] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const issueLabel = item.active
    ? `Wystaw teraz fakturę „${item.name}”`
    : `Wystaw teraz — „${item.name}” jest wstrzymana, wznów ją, żeby wystawić fakturę`;

  const toggle = () => {
    startToggle(async () => {
      const result = item.active
        ? await pauseRecurringInvoiceAction(item.id)
        : await resumeRecurringInvoiceAction(item.id);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(item.active ? `Wstrzymano „${item.name}”` : `Wznowiono „${item.name}”`);
      router.refresh();
    });
  };

  const confirmDelete = () => {
    startDelete(async () => {
      const result = await deleteRecurringInvoiceAction(item.id);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setConfirmOpen(false);
      toast.success(`Usunięto „${item.name}”`);
      router.refresh();
    });
  };

  return (
    <div className={layout === 'card' ? 'flex items-center gap-1' : 'flex items-center justify-center gap-1'}>
      {layout === 'card' ? (
        item.active ? (
          <Link
            href={issueNowHref(item.id)}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            aria-label={issueLabel}
          >
            <RiFlashlightLine aria-hidden='true' />
            Wystaw teraz
          </Link>
        ) : (
          <Button variant='outline' size='sm' disabled aria-label={issueLabel}>
            <RiFlashlightLine aria-hidden='true' />
            Wystaw teraz
          </Button>
        )
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              item.active ? (
                <Link
                  href={issueNowHref(item.id)}
                  className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                  aria-label={issueLabel}
                />
              ) : (
                <Button variant='ghost' size='icon' disabled aria-label={issueLabel} />
              )
            }
          >
            <RiFlashlightLine className='size-4.5' aria-hidden='true' />
          </TooltipTrigger>
          <TooltipContent>
            <p>Wystaw teraz</p>
          </TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant='ghost'
              size='icon'
              aria-label={`Usuń fakturę cykliczną „${item.name}”`}
              onClick={() => setConfirmOpen(true)}
            />
          }
        >
          <RiDeleteBinLine className='size-4.5' aria-hidden='true' />
        </TooltipTrigger>
        <TooltipContent>
          <p>Usuń</p>
        </TooltipContent>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button size='icon' variant='ghost' aria-label={`Więcej akcji dla „${item.name}”`} />}
        >
          <RiMore2Line className='size-4.5' aria-hidden='true' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='min-w-40 p-0.5'>
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={togglePending} onClick={toggle}>
              {togglePending ? (
                <RiLoader4Line className='animate-spin' />
              ) : item.active ? (
                <RiPauseLine />
              ) : (
                <RiPlayLine />
              )}
              <span>{item.active ? 'Wstrzymaj' : 'Wznów'}</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onEdit(item)}>
              <RiEditLine />
              <span>Edytuj</span>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Usunąć fakturę cykliczną „{item.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Pozycja zniknie z listy i przestanie przypominać o wystawieniu. Faktury, które już z niej
              wystawiono, zostają bez zmian, tak samo jak faktura-wzór.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              disabled={deletePending}
              onClick={confirmDelete}
            >
              {deletePending ? <RiLoader4Line className='animate-spin' /> : null}
              Usuń
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
