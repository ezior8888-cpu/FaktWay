'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CreditCard, Loader2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';

import { issueRefundAction, type UserPaymentRow } from '../billing-actions';

interface Props {
  payments: UserPaymentRow[];
}

function fmtAmount(cents: number, currency: string): string {
  return (cents / 100).toLocaleString('pl-PL', {
    style: 'currency',
    currency: currency.toUpperCase(),
  });
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pl-PL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function PaymentsSection({ payments }: Props) {
  return (
    <section className="space-y-3">
      <h2 className="font-semibold text-lg flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-muted-foreground" />
        Płatności Stripe ({payments.length})
      </h2>

      {payments.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="Brak płatności"
          description="User nie ma jeszcze żadnych zaksięgowanych płatności w Stripe."
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-glass-border bg-foreground/3 backdrop-blur-glass">
          <table className="w-full text-sm">
            <thead className="border-b border-glass-border">
              <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Data</th>
                <th className="px-4 py-2.5 font-medium">Organizacja</th>
                <th className="px-4 py-2.5 font-medium">Stripe Invoice</th>
                <th className="px-4 py-2.5 font-medium text-right">Kwota</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Akcje</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <PaymentRow key={p.paymentId} payment={p} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PaymentRow({ payment }: { payment: UserPaymentRow }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState('');

  const fullyRefunded =
    payment.status === 'refunded' ||
    payment.refundedAmountCents >= payment.amountCents;
  const canRefund = payment.status === 'succeeded' && !fullyRefunded
    && payment.refundOperationStatus === null;

  const handleRefund = () => {
    startTransition(async () => {
      const result = await issueRefundAction(payment.paymentId, reason.trim() || null);
      if (result.success) {
        toast.success(result.message ?? 'Refund wystawiony');
        setDialogOpen(false);
        setReason('');
        router.refresh();
      } else {
        toast.error(result.error);
        if (result.reconciliationRequired || result.operationPending) {
          setDialogOpen(false);
          router.refresh();
        }
      }
    });
  };

  return (
    <tr className="border-b border-glass-border last:border-0 hover:bg-foreground/5">
      <td className="px-4 py-2.5 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
        {fmtDate(payment.paidAt)}
      </td>
      <td className="px-4 py-2.5 text-sm">{payment.tenantName}</td>
      <td className="px-4 py-2.5">
        {payment.stripeInvoiceId ? (
          <code className="text-xs font-mono text-muted-foreground">
            {payment.stripeInvoiceId.slice(0, 14)}…
          </code>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right tabular-nums font-medium">
        {fmtAmount(payment.amountCents, payment.currency)}
        {payment.refundedAmountCents > 0 ? (
          <div className="text-xs text-muted-foreground">
            zwrot: {fmtAmount(payment.refundedAmountCents, payment.currency)}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-2.5">
        <Badge
          variant={
            payment.status === 'succeeded'
              ? 'secondary'
              : payment.status === 'failed'
                ? 'destructive'
                : 'outline'
          }
          className="text-xs"
        >
          {payment.status}
        </Badge>
        {payment.refundOperationStatus === 'processing' ? (
          <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            {payment.refundOperationStale ? 'Wymaga uzgodnienia w Stripe (ponad 15 min)' : 'Zwrot w trakcie'}
          </div>
        ) : payment.refundOperationStatus === 'reconciliation_required' ? (
          <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            Wymaga uzgodnienia w Stripe
          </div>
        ) : payment.refundOperationStatus === 'completed' ? (
          <div className="mt-1 text-xs text-muted-foreground">Zwrot potwierdzony</div>
        ) : null}
      </td>
      <td className="px-4 py-2.5 text-right">
        {canRefund ? (
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialogOpen(true)}
              disabled={isPending}
              className="border-amber-500/30 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
            >
              {isPending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Undo2 className="mr-1.5 h-3.5 w-3.5" />
              )}
              Refund
            </Button>

            <DialogContent>
              <DialogHeader>
                <DialogTitle>Wystaw refund</DialogTitle>
                <DialogDescription>
                  Pełen zwrot kwoty{' '}
                  <strong>{fmtAmount(payment.amountCents, payment.currency)}</strong>{' '}
                  na metodę płatności klienta. Operacja nieodwracalna. Klient dostanie email z
                  potwierdzeniem.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-1">
                <label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Powód (opcjonalny)
                </label>
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder='np. "Klient zrezygnował w trakcie trialu"'
                />
              </div>

              <DialogFooter>
                <DialogClose render={<Button variant="outline" size="sm" />}>Anuluj</DialogClose>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={isPending}
                  onClick={handleRefund}
                >
                  Wystaw refund
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}
