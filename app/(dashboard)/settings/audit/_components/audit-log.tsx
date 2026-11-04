import { RiHistoryLine } from '@remixicon/react';

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { FieldDescription, FieldLabel } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { plural } from '@/lib/i18n/plural';

/**
 * Dziennik zdarzeń. Wygląd: tabela w ramce jak `notifications/index.tsx`
 * Finory (`border` + `Table`) — tylko od `lg`; poniżej `lg` te same wpisy
 * jako wiersze `border p-3` (`security/sessions-card.tsx`), bo tabela
 * przewijana w bok na telefonie to błąd (plan §7.2). Komponent tylko
 * prezentuje — dane czyta strona.
 */

export type AuditLogEntry = {
  id: string;
  /** „DD.MM.RRRR, GG:MM” w czasie polskim. */
  when: string;
  action: string;
  resource: string;
  ip: string;
};

export function AuditLog({ entries }: { entries: AuditLogEntry[] }) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <FieldLabel>Log zdarzeń</FieldLabel>
        <FieldDescription>
          {entries.length} {plural(entries.length, ['wpis', 'wpisy', 'wpisów'])} (max. 200) • sortowanie od
          najnowszych
        </FieldDescription>
      </div>

      {entries.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RiHistoryLine />
            </EmptyMedia>
            <EmptyTitle>Brak wpisów.</EmptyTitle>
            <EmptyDescription>Tu pojawią się logowania, wysyłki do KSeF i zmiany w koncie.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="hidden border lg:block" data-testid="audit-table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Akcja</TableHead>
                  <TableHead>Zasób</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-muted-foreground whitespace-nowrap">{entry.when}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{entry.action}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{entry.resource}</TableCell>
                    <TableCell className="font-mono text-xs">{entry.ip}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="flex flex-col gap-3 lg:hidden" data-testid="audit-cards">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 border p-3">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="secondary" className="max-w-full truncate" title={entry.action}>
                    {entry.action}
                  </Badge>
                  <span className="text-muted-foreground shrink-0 text-xs">{entry.when}</span>
                </div>
                <p className="text-muted-foreground truncate font-mono text-xs">
                  {entry.resource} · IP {entry.ip}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
