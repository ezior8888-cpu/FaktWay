'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';

import {
  currencySymbol,
  resolveOutstanding,
  resolvePaymentState,
  type InvoiceFactsById,
  type InvoiceRow,
} from '@/components/invoices/invoice-row-types';
import { StatusBadge } from '@/components/invoices/status-badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { companyInitials, shortenLegalForm } from '@/lib/format/legal-form';
import { formatPlMoney } from '@/lib/format/pl';
import { formatInvoiceDate } from '@/lib/invoices/display-date';
import type { InvoiceListRowFacts } from '@/lib/invoices/list-row-facts';

import { InvoiceRowActions } from './invoice-row-actions';
import { PaymentIndicator } from './payment-indicator';

interface Props {
  invoices: InvoiceRow[];
  facts: InvoiceFactsById;
  /** Dziś w Europe/Warsaw (RRRR-MM-DD) — „po terminie” z daty. */
  today: string;
  selectedIds: ReadonlySet<string>;
  onToggleRow: (id: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  /** „Zapłacone”: tylko gdy rola pozwala. */
  onMarkPaid?: (invoice: InvoiceRow, facts: InvoiceListRowFacts | undefined) => void;
}

function money(amount: string | number | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(amount);
  return Number.isFinite(n) ? `${formatPlMoney(n)} ${currencySymbol(currency)}` : '—';
}

/**
 * Kolumny Finory (`invoice-table/data-table.tsx`, `columns`): nagłówek i
 * szerokość (`size` z definicji kolumny → `style.width`). Kolejność i rozmiary
 * jak w szablonie; „Płatność” niesie też plakietkę KSeF, a „Numer” i
 * „Nabywca” są szersze, bo polskie numery i nazwy firm są dłuższe (§7.2).
 */
const COLUMNS: Array<{ id: string; header: ReactNode; size?: number }> = [
  { id: 'select', header: null, size: 50 },
  { id: 'number', header: 'Numer', size: 100 },
  { id: 'payment', header: 'Płatność', size: 100 },
  { id: 'buyer', header: 'Nabywca', size: 280 },
  { id: 'gross', header: 'Brutto' },
  { id: 'issued', header: 'Wystawiona' },
  { id: 'due', header: 'Termin' },
  { id: 'balance', header: 'Do zapłaty' },
  { id: 'actions', header: 'Akcje', size: 200 },
];

/**
 * Tabela listy faktur 1:1 z data-table Finory (tylko od `lg`): wiersz
 * nagłówka `h-14 border-t`, komórki `h-14 first:pl-4`, kolumna akcji
 * wyśrodkowana. Rysujemy bieżącą stronę z serwera na prymitywach Finory —
 * filtrowanie, sortowanie i stronicowanie robi baza (adres listy), więc
 * `@tanstack/react-table` nie miałby tu nic do liczenia.
 */
export function InvoicesTable({ invoices, facts, today, selectedIds, onToggleRow, onToggleAll, onMarkPaid }: Props) {
  const selectedOnPage = invoices.filter((inv) => selectedIds.has(inv.id)).length;
  const allSelected = invoices.length > 0 && selectedOnPage === invoices.length;

  return (
    <Table>
      <TableHeader>
        <TableRow className="h-14 border-t">
          {COLUMNS.map((column) => (
            <TableHead
              key={column.id}
              style={column.size ? { width: `${column.size}px` } : undefined}
              className="text-muted-foreground first:pl-4 last:px-4 last:text-center"
            >
              {column.id === 'select' ? (
                <Checkbox
                  aria-label="Zaznacz wszystkie faktury na stronie"
                  checked={allSelected}
                  indeterminate={selectedOnPage > 0 && !allSelected}
                  onCheckedChange={(checked) => onToggleAll(checked === true)}
                />
              ) : (
                column.header
              )}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.map((inv) => {
          const rowFacts = facts[inv.id];
          const state = resolvePaymentState(inv, rowFacts, today);
          const outstanding = resolveOutstanding(inv, rowFacts);
          const number = inv.internal_number ?? '(bez numeru)';
          const buyerName = inv.buyer_data?.name ?? null;
          return (
            <TableRow key={inv.id} data-state={selectedIds.has(inv.id) ? 'selected' : undefined}>
              <TableCell className="h-14 first:pl-4">
                <Checkbox
                  aria-label={`Zaznacz fakturę ${number}`}
                  checked={selectedIds.has(inv.id)}
                  onCheckedChange={(checked) => onToggleRow(inv.id, checked === true)}
                />
              </TableCell>
              <TableCell className="h-14 first:pl-4">
                <Link href={`/invoices/${inv.id}`} className="text-muted-foreground hover:text-foreground hover:underline">
                  {number}
                </Link>
              </TableCell>
              <TableCell className="h-14 first:pl-4">
                <div className="flex items-center gap-2">
                  <PaymentIndicator state={state} />
                  <StatusBadge status={inv.ksef_status} errorCode={inv.last_error_code} />
                </div>
              </TableCell>
              <TableCell className="h-14 max-w-72 first:pl-4">
                <div className="flex items-center gap-2">
                  <Avatar className="size-9">
                    <AvatarFallback className="text-xs">{companyInitials(buyerName)}</AvatarFallback>
                  </Avatar>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium" title={buyerName ?? undefined}>
                      {buyerName ? shortenLegalForm(buyerName) : '—'}
                    </span>
                    {inv.buyer_data?.nip ? (
                      <span className="text-muted-foreground truncate">NIP {inv.buyer_data.nip}</span>
                    ) : null}
                  </div>
                </div>
              </TableCell>
              <TableCell className="h-14 tabular-nums first:pl-4">
                <span>{money(inv.gross_total, inv.currency)}</span>
              </TableCell>
              <TableCell className="h-14 first:pl-4">
                <span className="text-muted-foreground tabular-nums">{formatInvoiceDate(inv.issue_date)}</span>
              </TableCell>
              <TableCell className="h-14 first:pl-4">
                <span className="text-muted-foreground tabular-nums">{formatInvoiceDate(inv.payment_due_date)}</span>
              </TableCell>
              <TableCell className="h-14 tabular-nums first:pl-4">
                {outstanding === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : outstanding === 0 ? (
                  <Badge className="h-auto rounded-sm bg-green-600/10 text-green-700 focus-visible:ring-green-600/20 dark:bg-green-400/10 dark:text-green-400 dark:focus-visible:ring-green-400/40">
                    Opłacona
                  </Badge>
                ) : (
                  <span>{money(outstanding, inv.currency)}</span>
                )}
              </TableCell>
              <TableCell className="h-14 first:pl-4 last:px-4">
                <InvoiceRowActions invoice={inv} facts={rowFacts} onMarkPaid={onMarkPaid} />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
