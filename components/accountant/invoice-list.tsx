import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { AccountantPortalData } from '@/lib/accountant/load-accountant-portal';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlInt, formatPlMoney } from '@/lib/format/pl';
import { plural } from '@/lib/i18n/plural';
import { cn } from '@/lib/utils';

type InvoiceRow = AccountantPortalData['invoices'][number];

const STATUS_LABELS: Record<string, string> = {
  accepted: 'Przyjęta w KSeF',
  received: 'Odebrana z KSeF',
  offline_queued: 'Offline — czeka na KSeF',
};

// Kolory statusów Finory (`INVOICE_STATUS_STYLES`): przyjęta/odebrana zielono, offline bursztynowo.
const STATUS_STYLES: Record<string, string> = {
  accepted: 'bg-green-600/10 text-green-700 dark:bg-green-400/10 dark:text-green-400',
  received: 'bg-green-600/10 text-green-700 dark:bg-green-400/10 dark:text-green-400',
  offline_queued: 'bg-amber-600/10 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400',
};

function statusLabel(status: string | null): string {
  return status ? STATUS_LABELS[status] ?? status : '—';
}

function directionLabel(direction: string | null): string {
  if (direction === 'outgoing') return 'Sprzedaż';
  if (direction === 'incoming') return 'Koszt';
  return '—';
}

function amountLabel(gross: InvoiceRow['gross_total']): string {
  return gross != null ? `${formatPlMoney(Number(gross))} zł` : '—';
}

function StatusBadge({ status }: { status: string | null }) {
  return (
    <Badge className={cn('font-normal', (status && STATUS_STYLES[status]) || 'bg-muted text-muted-foreground')}>
      {statusLabel(status)}
    </Badge>
  );
}

interface Props {
  invoices: InvoiceRow[];
  canDownload: boolean;
  token: string;
}

/**
 * Lista dokumentów w portalu księgowej — Card + Table Finory (od `lg`)
 * i karty poniżej (plan §7.2). Logika (statusy, rodzaj, „Pobierz XML” tylko
 * przy dokumencie z plikiem) bez zmian.
 */
export function AccountantInvoiceList({
  invoices,
  canDownload,
  token,
}: Props) {
  const tokenSeg = encodeURIComponent(token);

  if (!invoices.length) {
    return (
      <Card className="shadow-none">
        <p className="text-muted-foreground py-12 text-center text-sm">Brak dokumentów przyjętych w KSeF.</p>
      </Card>
    );
  }

  const downloadCell = (inv: InvoiceRow) =>
    inv.xml_storage_path ? (
      <Link
        href={`/accountant/${tokenSeg}/download/${inv.id}`}
        className="text-primary text-xs font-medium hover:underline"
      >
        Pobierz XML
      </Link>
    ) : (
      <span className="text-muted-foreground text-xs">brak XML</span>
    );

  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="border-b py-4">
        <CardTitle className="text-sm font-medium">Dokumenty</CardTitle>
        <CardDescription>
          {`${formatPlInt(invoices.length)} ${plural(invoices.length, ['pozycja', 'pozycje', 'pozycji'])} · najnowsze na górze`}
        </CardDescription>
      </CardHeader>

      <div data-view="table" className="hidden lg:block">
        <Table>
          <TableHeader>
            <TableRow className="h-14 hover:bg-transparent">
              <TableHead className="text-muted-foreground pl-4">Numer</TableHead>
              <TableHead className="text-muted-foreground">Rodzaj</TableHead>
              <TableHead className="text-muted-foreground">Data</TableHead>
              <TableHead className="text-muted-foreground text-right">Kwota brutto</TableHead>
              <TableHead className="text-muted-foreground">Status KSeF</TableHead>
              {canDownload ? <TableHead className="pr-4" aria-label="Plik XML" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map((inv) => (
              <TableRow key={inv.id}>
                <TableCell className="h-14 pl-4 font-mono">{inv.internal_number ?? '—'}</TableCell>
                <TableCell>{directionLabel(inv.direction)}</TableCell>
                <TableCell className="text-muted-foreground tabular-nums">{formatIsoDatePl(inv.issue_date)}</TableCell>
                <TableCell className="text-right tabular-nums">{amountLabel(inv.gross_total)}</TableCell>
                <TableCell>
                  <StatusBadge status={inv.ksef_status} />
                </TableCell>
                {canDownload ? <TableCell className="pr-4 text-right">{downloadCell(inv)}</TableCell> : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div data-view="cards" className="divide-y lg:hidden">
        {invoices.map((inv) => (
          <div key={inv.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-medium">{inv.internal_number ?? '—'}</p>
                <p className="text-muted-foreground text-xs">
                  {directionLabel(inv.direction)} · {formatIsoDatePl(inv.issue_date)}
                </p>
              </div>
              <p className="shrink-0 text-sm font-medium tabular-nums">{amountLabel(inv.gross_total)}</p>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <StatusBadge status={inv.ksef_status} />
              {canDownload ? downloadCell(inv) : null}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
