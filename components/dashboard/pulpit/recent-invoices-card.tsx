import Link from 'next/link';

import { PaymentIndicator } from '@/app/(dashboard)/invoices/_components/payment-indicator';
import { currencySymbol } from '@/components/invoices/invoice-row-types';
import { StatusBadge } from '@/components/invoices/status-badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatPlMoney } from '@/lib/format/pl';
import type { InvoicePaymentState } from '@/lib/invoices/list-row-facts';
import { cn } from '@/lib/utils';

import { PulpitCardHeader } from './card-header';
import { PULPIT_EMPTY, PulpitEmptyState } from './card-states';

export type RecentInvoice = {
  id: string;
  internalNumber: string | null;
  buyerName: string | null;
  gross: number;
  currency: string | null;
  paymentDueDate: string | null;
  payment: InvoicePaymentState | null;
  ksefStatus: string | null;
};

/** RRRR-MM-DD → DD.MM.RRRR; coś innego niż data zostaje bez zmian. */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

/** Ostatnie faktury — struktura karty i tabeli z `datatable-user.tsx` Finory. */
export function RecentInvoicesCard({
  invoices,
  className,
}: {
  /** Stan płatności policzony w `getRecentInvoices` — karta tylko go pokazuje. */
  invoices: RecentInvoice[];
  className?: string;
}) {
  return (
    <Card className={cn('shadow-none', className)}>
      <PulpitCardHeader
        title="Ostatnie faktury"
        action={
          <Link href="/invoices" className={buttonVariants({ variant: 'outline', size: 'xs' })}>
            Wszystkie faktury
          </Link>
        }
      />
      <CardContent className="flex flex-1 flex-col">
        {invoices.length === 0 ? (
          <PulpitEmptyState message={PULPIT_EMPTY.noInvoices} action={PULPIT_EMPTY.issueInvoice} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Kontrahent</TableHead>
                <TableHead>Numer</TableHead>
                <TableHead className="text-right">Brutto</TableHead>
                <TableHead>Termin</TableHead>
                <TableHead>Płatność</TableHead>
                <TableHead>KSeF</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.map((inv) => (
                <TableRow key={inv.id}>
                  <TableCell className="max-w-56">
                    <p className="truncate font-medium" title={inv.buyerName ?? undefined}>
                      {inv.buyerName ?? '—'}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/invoices/${inv.id}`}
                      className="text-foreground font-mono text-xs font-medium hover:underline"
                    >
                      {inv.internalNumber ?? '(bez numeru)'}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPlMoney(inv.gross)} {currencySymbol(inv.currency)}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatDate(inv.paymentDueDate)}</TableCell>
                  <TableCell>
                    <PaymentIndicator state={inv.payment} />
                  </TableCell>
                  <TableCell>
                    {inv.ksefStatus ? (
                      <StatusBadge status={inv.ksefStatus} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
