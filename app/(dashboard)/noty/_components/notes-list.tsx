import Link from 'next/link';
import { FileText } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlMoney } from '@/lib/format/pl';
import { NOTE_KIND_LABELS, NOTE_STATUS_LABELS, type NoteListItem, type NoteStatus } from '@/lib/noty/model';

/**
 * Lista not (krok 2.9, część 1): od `lg` tabela, poniżej karty (na 375 px
 * tabela przewijana w bok to błąd, plan Finora §7.2). Ta sama treść w obu
 * układach; wiersz prowadzi do podglądu noty.
 */

function StatusBadge({ status }: { status: NoteStatus }) {
  return <Badge variant={status === 'issued' ? 'secondary' : 'outline'}>{NOTE_STATUS_LABELS[status]}</Badge>;
}

function numberLabel(row: NoteListItem): string {
  return row.number ?? 'Szkic';
}

export function NotesList({ rows }: { rows: NoteListItem[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title='Nie masz jeszcze not'
        description='Nota obciążeniowa albo uznaniowa trafia do kontrahenta jako PDF mailem. Numer nadaje się przy wystawieniu.'
        primaryAction={{ type: 'link', label: 'Nowa nota', href: '/noty/nowa', icon: FileText }}
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
              <TableHead>Tytuł</TableHead>
              <TableHead>Data</TableHead>
              <TableHead className='text-right'>Kwota</TableHead>
              <TableHead>Stan</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className='h-14'>
                <TableCell className='font-medium'>
                  <Link href={`/noty/${row.id}`} className='hover:underline'>
                    {numberLabel(row)}
                  </Link>
                </TableCell>
                <TableCell>{NOTE_KIND_LABELS[row.kind]}</TableCell>
                <TableCell className='max-w-56 truncate'>{row.counterpartyName}</TableCell>
                <TableCell className='max-w-56 truncate'>{row.title}</TableCell>
                <TableCell>{formatIsoDatePl(row.issueDate)}</TableCell>
                <TableCell className='text-right tabular-nums'>{formatPlMoney(row.total)} zł</TableCell>
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
            <Link href={`/noty/${row.id}`} className='flex min-h-[44px] flex-col gap-1 px-4 py-3'>
              <span className='flex items-center justify-between gap-2'>
                <span className='font-medium'>{numberLabel(row)}</span>
                <StatusBadge status={row.status} />
              </span>
              <span className='text-muted-foreground text-sm'>
                {NOTE_KIND_LABELS[row.kind]} · {formatIsoDatePl(row.issueDate)}
              </span>
              <span className='truncate text-sm'>{row.counterpartyName}</span>
              <span className='flex items-center justify-between gap-2 text-sm'>
                <span className='truncate'>{row.title}</span>
                <span className='tabular-nums font-medium'>{formatPlMoney(row.total)} zł</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
