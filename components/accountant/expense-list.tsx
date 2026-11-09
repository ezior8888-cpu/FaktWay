import {
  documentLabel,
  kpirShortLabel,
  REVIEW_LABELS,
  REVIEW_STYLES,
  type ReviewStatus,
} from '@/components/expenses/finora/labels';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { AccountantExpenseRow } from '@/lib/accountant/load-accountant-expenses';
import type { PortalPage } from '@/lib/accountant/portal-access';
import { monthLabel } from '@/lib/expenses/month';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { formatPlInt, formatPlMoney } from '@/lib/format/pl';
import { plural } from '@/lib/i18n/plural';
import { cn } from '@/lib/utils';

interface Props {
  rows: AccountantExpenseRow[];
  page: PortalPage;
  canDownload: boolean;
  token: string;
  /** Miesiąc listy RRRR-MM. */
  month: string;
  /** Strony listy pod tabelą. */
  footer?: React.ReactNode;
}

const money = (amount: number) => `${formatPlMoney(amount)} zł`;
const reviewStatus = (row: AccountantExpenseRow): ReviewStatus => (row.is_reviewed ? 'reviewed' : 'unreviewed');
const kpirLabel = (column: string | null) => (column ? kpirShortLabel(column) : 'bez kolumny');

function ReviewBadge({ row }: { row: AccountantExpenseRow }) {
  const status = reviewStatus(row);
  return <Badge className={cn('font-normal', REVIEW_STYLES[status])}>{REVIEW_LABELS[status]}</Badge>;
}

/**
 * Pliki kosztu: „Podgląd” przy każdym poziomie dostępu (nowa karta,
 * przeglądarka otwiera zdjęcie, PDF albo XML jako tekst), „Pobierz” tylko
 * przy dostępie z pobieraniem. Zwykłe `<a>`: trasa pliku zapisuje wpis
 * w audycie, więc nie może jej wywołać wstępne pobieranie linku.
 */
function FileLinks({ row, canDownload, token }: { row: AccountantExpenseRow; canDownload: boolean; token: string }) {
  if (!row.file_kind) return <span className="text-muted-foreground text-xs">brak pliku</span>;
  const tokenSeg = encodeURIComponent(token);
  const what = row.file_kind === 'xml' ? 'XML faktury z KSeF' : 'zdjęcie dokumentu';
  return (
    <span className="inline-flex items-center gap-3">
      <a
        href={`/accountant/${tokenSeg}/expenses/${row.id}/view`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Podgląd: ${what}`}
        className="text-primary text-xs font-medium hover:underline"
      >
        Podgląd
      </a>
      {canDownload ? (
        <a
          href={`/accountant/${tokenSeg}/expenses/${row.id}/download`}
          rel="noreferrer"
          aria-label={`Pobierz: ${what}`}
          className="text-primary text-xs font-medium hover:underline"
        >
          Pobierz
        </a>
      ) : null}
    </span>
  );
}

/**
 * Koszty firmy w portalu księgowej (krok 6.2): Card + Table jak lista
 * dokumentów (od `lg`) i karty poniżej. Kwoty tylko do wyświetlenia,
 * w złotych, jak zapisane przy koszcie.
 */
export function AccountantExpenseList({ rows, page, canDownload, token, month, footer }: Props) {
  const period = monthLabel(month);

  if (!rows.length) {
    return (
      <Card className="shadow-none">
        <p className="text-muted-foreground py-12 text-center text-sm">{`Brak kosztów za ${period}.`}</p>
      </Card>
    );
  }

  return (
    <Card className="gap-0 py-0 shadow-none">
      <CardHeader className="border-b py-4">
        <CardTitle className="text-sm font-medium">Koszty</CardTitle>
        <CardDescription>
          {`${formatPlInt(page.total)} ${plural(page.total, ['pozycja', 'pozycje', 'pozycji'])} · ${period}`}
        </CardDescription>
      </CardHeader>

      <div data-view="table" className="hidden lg:block">
        <Table>
          <TableHeader>
            <TableRow className="h-14 hover:bg-transparent">
              <TableHead className="text-muted-foreground pl-4">Data</TableHead>
              <TableHead className="text-muted-foreground">Dostawca</TableHead>
              <TableHead className="text-muted-foreground">Numer</TableHead>
              <TableHead className="text-muted-foreground">Numer KSeF</TableHead>
              <TableHead className="text-muted-foreground text-right">Netto</TableHead>
              <TableHead className="text-muted-foreground text-right">VAT</TableHead>
              <TableHead className="text-muted-foreground text-right">Brutto</TableHead>
              <TableHead className="text-muted-foreground">Kolumna KPiR</TableHead>
              <TableHead className="text-muted-foreground">Status</TableHead>
              <TableHead className="text-muted-foreground pr-4">Plik</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="text-muted-foreground h-14 pl-4 tabular-nums">{formatIsoDatePl(row.issue_date)}</TableCell>
                <TableCell>
                  <div className="flex max-w-56 flex-col">
                    <span className="truncate font-medium" title={row.seller_name}>
                      {row.seller_name}
                    </span>
                    <span className="text-muted-foreground font-mono text-xs">
                      {row.seller_nip ? `NIP ${row.seller_nip}` : 'bez NIP'}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <span className="font-mono">{row.document_number ?? 'bez numeru'}</span>
                    <span className="text-muted-foreground text-xs">{documentLabel(row.document_type)}</span>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground max-w-44 font-mono text-xs break-all whitespace-normal">
                  {row.ksef_number ?? 'brak'}
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(row.net_amount)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(row.vat_amount)}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{money(row.gross_amount)}</TableCell>
                <TableCell className="text-muted-foreground">{kpirLabel(row.kpir_column)}</TableCell>
                <TableCell>
                  <ReviewBadge row={row} />
                </TableCell>
                <TableCell className="pr-4">
                  <FileLinks row={row} canDownload={canDownload} token={token} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div data-view="cards" className="divide-y lg:hidden">
        {rows.map((row) => (
          <div key={row.id} className="space-y-2 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{row.seller_name}</p>
                <p className="text-muted-foreground text-xs">
                  {`${formatIsoDatePl(row.issue_date)} · ${documentLabel(row.document_type)} ${row.document_number ?? 'bez numeru'}`}
                </p>
              </div>
              <p className="shrink-0 text-sm font-medium tabular-nums">{money(row.gross_amount)}</p>
            </div>
            {row.ksef_number ? (
              <p className="text-muted-foreground font-mono text-xs break-all">{`KSeF: ${row.ksef_number}`}</p>
            ) : null}
            <p className="text-muted-foreground text-xs tabular-nums">
              {`Netto ${money(row.net_amount)} · VAT ${money(row.vat_amount)} · KPiR: ${kpirLabel(row.kpir_column)}`}
            </p>
            <div className="flex items-center justify-between gap-3">
              <ReviewBadge row={row} />
              <FileLinks row={row} canDownload={canDownload} token={token} />
            </div>
          </div>
        ))}
      </div>

      {footer}
    </Card>
  );
}
