import Link from 'next/link';
import { FileText } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { QUOTE_KIND_LABELS, QUOTE_STATUS_LABELS, type QuoteListItem, type QuoteStatus } from '@/lib/proformy/model';

/**
 * Lista proform i ofert (krok 2.4): od `lg` tabela, poniżej karty (na 375 px
 * tabela przewijana w bok to błąd, plan Finora §7.2), jak lista not. Ta sama
 * treść w obu układach; wiersz prowadzi do podglądu dokumentu.
 */

function StatusBadge({ status }: { status: QuoteStatus }) {
  return <Badge variant={status === 'issued' ? 'secondary' : 'outline'}>{QUOTE_STATUS_LABELS[status]}</Badge>;
}

function numberLabel(row: QuoteListItem): string {
  return row.number ?? 'Szkic';
}

function validUntilLabel(row: QuoteListItem): string {
  return row.kind === 'offer' && row.validUntil ? formatIsoDatePl(row.validUntil) : '';
}

export function QuotesList({ rows }: { rows: QuoteListItem[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title='Nie masz jeszcze proform ani ofert'
        description='Proforma albo oferta trafia do kontrahenta jako PDF mailem, a jednym kliknięciem otwiera formularz faktury z jej danymi. Numer nadaje się przy wystawieniu.'
        primaryAction={{ type: 'link', label: 'Nowa proforma albo oferta', href: '/proformy/nowa', icon: FileText }}
      />
    );
  }

  return (
    <>
      <div className='hidden lg:block'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Numer</TableHead>
              <TableHead>Rodzaj</TableHead>
              <TableHead>Kontrahent</TableHead>
              <TableHead>Data</TableHead>
              <TableHead>Ważna do</TableHead>
              <TableHead className='text-right'>Kwota brutto</TableHead>
              <TableHead>Stan</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className='h-14'>
                <TableCell className='font-medium'>
                  <Link href={`/proformy/${row.id}`} className='hover:underline'>
                    {numberLabel(row)}
                  </Link>
                </TableCell>
                <TableCell>{QUOTE_KIND_LABELS[row.kind]}</TableCell>
                <TableCell className='max-w-56 truncate'>{row.counterpartyName}</TableCell>
                <TableCell>{formatIsoDatePl(row.issueDate)}</TableCell>
                <TableCell>{validUntilLabel(row)}</TableCell>
                <TableCell className='text-right tabular-nums'>{formatPlMoney(row.grossTotal)} zł</TableCell>
                <TableCell>
                  <StatusBadge status={row.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className='divide-y lg:hidden'>
        {rows.map((row) => (
          <li key={row.id}>
            <Link href={`/proformy/${row.id}`} className='flex min-h-[44px] flex-col gap-1 px-4 py-3'>
              <span className='flex items-center justify-between gap-2'>
                <span className='font-medium'>{numberLabel(row)}</span>
                <StatusBadge status={row.status} />
              </span>
              <span className='text-muted-foreground text-sm'>
                {QUOTE_KIND_LABELS[row.kind]} · {formatIsoDatePl(row.issueDate)}
                {validUntilLabel(row) ? ` · ważna do ${validUntilLabel(row)}` : ''}
              </span>
              <span className='flex items-center justify-between gap-2 text-sm'>
                <span className='truncate'>{row.counterpartyName}</span>
                <span className='tabular-nums font-medium'>{formatPlMoney(row.grossTotal)} zł</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
