import Link from 'next/link';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatPlMoney } from '@/lib/format/pl';
import { dayPl, type CashReportRow } from '@/lib/kasa/model';

/**
 * Dowody w raporcie kasowym (krok 3.7): od `lg` tabela, poniżej karty (na
 * 375 px tabela przewijana w bok to błąd, plan Finora §7.2). Ta sama treść
 * w obu układach: dzień, numer (do dowodu), strona i tytuł, wpłata albo
 * wypłata i stan kasy po dowodzie. Korekta i dowód skorygowany są opisane.
 */

function note(row: CashReportRow): string | null {
  if (row.correctsNumber) return `Korekta dowodu ${row.correctsNumber}`;
  if (row.correctedByNumber) return `Skorygowany dowodem ${row.correctedByNumber}`;
  return null;
}

const money = (value: number | null) => (value === null ? '' : formatPlMoney(value));

export function CashDocumentsList({ rows }: { rows: CashReportRow[] }) {
  if (rows.length === 0) {
    return <p className='text-muted-foreground px-4 py-8 text-center text-sm'>W tym okresie nie ma dowodów kasowych.</p>;
  }

  return (
    <>
      <div className='hidden lg:block'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Data</TableHead>
              <TableHead>Numer</TableHead>
              <TableHead>Strona i tytuł</TableHead>
              <TableHead className='text-right'>Wpłata (zł)</TableHead>
              <TableHead className='text-right'>Wypłata (zł)</TableHead>
              <TableHead className='text-right'>Stan (zł)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className='h-14'>
                <TableCell>{dayPl(row.operationDate)}</TableCell>
                <TableCell className='font-medium'>
                  <Link href={`/kasa/${row.id}`} className='hover:underline'>
                    {row.number}
                  </Link>
                </TableCell>
                <TableCell className='max-w-80'>
                  <span className='block truncate font-medium'>{row.counterpartyName}</span>
                  <span className='text-muted-foreground block truncate text-xs'>{row.title}</span>
                  {note(row) ? <span className='text-muted-foreground block text-xs'>{note(row)}</span> : null}
                </TableCell>
                <TableCell className='text-right tabular-nums'>{money(row.receipt)}</TableCell>
                <TableCell className='text-right tabular-nums'>{money(row.payout)}</TableCell>
                <TableCell className='text-right font-medium tabular-nums'>{formatPlMoney(row.balance)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <ul className='divide-y lg:hidden'>
        {rows.map((row) => (
          <li key={row.id}>
            <Link href={`/kasa/${row.id}`} className='flex min-h-[44px] flex-col gap-1 px-4 py-3'>
              <span className='flex items-center justify-between gap-2'>
                <span className='font-medium'>{row.number}</span>
                <span className='tabular-nums font-medium'>
                  {row.kind === 'KP' ? 'Wpłata' : 'Wypłata'} {money(row.receipt ?? row.payout)} zł
                </span>
              </span>
              <span className='text-muted-foreground text-sm'>{dayPl(row.operationDate)}</span>
              <span className='truncate text-sm'>{row.counterpartyName}</span>
              <span className='text-muted-foreground truncate text-sm'>{row.title}</span>
              {note(row) ? <span className='text-muted-foreground text-xs'>{note(row)}</span> : null}
              <span className='text-muted-foreground text-sm tabular-nums'>Stan kasy po dowodzie: {formatPlMoney(row.balance)} zł</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
