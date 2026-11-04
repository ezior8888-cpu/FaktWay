'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { RiDeleteBinLine, RiEditLine, RiEyeLine, RiLoader4Line, RiMore2Line } from '@remixicon/react'

import { deleteExpenseAction } from '@/app/actions/expenses'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * Wydatek ze skrzynki KSeF albo powiązany z fakturą KSeF nie znika z listy —
 * ten sam warunek co przycisk „Usuń” w `ExpenseEditForm` (akcja i tak
 * sprawdza go po stronie serwera).
 */
export function canDeleteExpense(expense: { source: string; ksef_invoice_id: string | null }): boolean {
  return expense.source !== 'ksef_inbox' && expense.ksef_invoice_id === null
}

/**
 * Kolumna „Akcje” (Finora: podgląd z podpowiedzią + usuń; plan P8:
 * „Szczegóły, ⋯”). Szczegóły to nasza strona `/expenses/[id]`, menu „⋯” ma
 * „Opisz” (ta sama strona) i „Usuń” dla wydatków spoza KSeF.
 */
export function ExpenseRowActions({
  expense,
  label
}: {
  expense: { id: string; source: string; ksef_invoice_id: string | null }
  /** Nazwa sprzedawcy do etykiet dostępności. */
  label: string
}) {
  const router = useRouter()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deletePending, startDelete] = useTransition()
  const deletable = canDeleteExpense(expense)

  const confirmDelete = () => {
    startDelete(async () => {
      const result = await deleteExpenseAction(expense.id)
      if (!result.success) {
        toast.error(result.error)
        return
      }
      setConfirmOpen(false)
      toast.success('Usunięto')
      router.refresh()
    })
  }

  return (
    <div className='flex items-center justify-center gap-1'>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              href={`/expenses/${expense.id}`}
              className={buttonVariants({ variant: 'ghost', size: 'icon' })}
              aria-label={`Szczegóły wydatku: ${label}`}
            />
          }
        >
          <RiEyeLine className='size-4.5' />
        </TooltipTrigger>
        <TooltipContent>
          <p>Szczegóły</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size='icon' variant='ghost' aria-label={`Więcej akcji: ${label}`} />}>
          <RiMore2Line className='size-4.5' aria-hidden='true' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='min-w-40'>
          <DropdownMenuGroup>
            <DropdownMenuItem render={<Link href={`/expenses/${expense.id}`} />}>
              <RiEditLine />
              Opisz
            </DropdownMenuItem>
            {deletable ? (
              <DropdownMenuItem variant='destructive' onClick={() => setConfirmOpen(true)}>
                <RiDeleteBinLine />
                Usuń
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {deletable ? (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Usunąć ten wydatek?</DialogTitle>
              <DialogDescription>
                Wydatek „{label}” zniknie z listy i z KPiR. Tej operacji nie można cofnąć.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant='outline' onClick={() => setConfirmOpen(false)} disabled={deletePending}>
                Anuluj
              </Button>
              <Button variant='destructive' onClick={confirmDelete} disabled={deletePending}>
                {deletePending ? <RiLoader4Line className='animate-spin' /> : null}
                Usuń wydatek
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  )
}
