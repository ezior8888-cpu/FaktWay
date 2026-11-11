import { RiHistoryLine } from '@remixicon/react';

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { FieldDescription, FieldLabel } from '@/components/ui/field';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { AccountLoginStatus, AccountLoginView } from '@/lib/auth/sessions/view';

/**
 * Historia logowań (krok 8.5). Wygląd: `security/login-history-card.tsx` Finory
 * (tabela w ramce: urządzenie, adres, data, stan) od `lg`, a poniżej te same
 * wpisy jako wiersze w ramce, jak dziennik zdarzeń (`audit/_components/audit-log.tsx`):
 * tabela przewijana w bok na telefonie to błąd. Komponent tylko prezentuje,
 * dane czyta strona funkcją 00174 `list_account_logins`.
 */

export type LoginHistoryLoadState = 'ok' | 'failed' | 'code_required';

const STATUS_LABELS: Record<AccountLoginStatus, string> = {
  current: 'To urządzenie',
  active: 'Nadal zalogowane',
  ended: 'Zakończone',
  // Wpis sprzed listy urządzeń: nie wiemy, czy ta sesja jeszcze trwa.
  unknown: 'Stan nieznany',
};

function addressLine(entry: AccountLoginView): string {
  return entry.ip ? `IP ${entry.ip}` : 'Adres nieznany';
}

export function LoginHistoryCard({ entries, state, limit }: {
  entries: AccountLoginView[];
  state: LoginHistoryLoadState;
  limit: number;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="login-history">
      <div>
        <FieldLabel>Historia logowań</FieldLabel>
        <FieldDescription>
          Ostatnie logowania na to konto, najwyżej {limit}. Adres IP pokazujemy w skrócie.
        </FieldDescription>
      </div>

      {state === 'code_required' && (
        <p className="text-muted-foreground text-xs">
          Historia logowań pojawi się po potwierdzeniu kodem z aplikacji uwierzytelniającej.
        </p>
      )}
      {state === 'failed' && (
        <p role="alert" className="text-destructive text-xs">Nie udało się wczytać historii logowań. Odśwież stronę.</p>
      )}

      {state === 'ok' && entries.length === 0 && (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <RiHistoryLine />
            </EmptyMedia>
            <EmptyTitle>Brak zapisanych logowań.</EmptyTitle>
            <EmptyDescription>Tu pojawi się każde kolejne logowanie: data, urządzenie i adres.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {state === 'ok' && entries.length > 0 && (
        <>
          <div className="hidden border lg:block" data-testid="login-history-table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Urządzenie</TableHead>
                  <TableHead>Adres</TableHead>
                  <TableHead>Stan</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.key}>
                    <TableCell className="text-muted-foreground whitespace-nowrap">{entry.when}</TableCell>
                    <TableCell>
                      <p className="font-medium">{entry.device}</p>
                      {entry.method && <p className="text-muted-foreground text-xs">{entry.method}</p>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{entry.ip ?? 'nieznany'}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{STATUS_LABELS[entry.status]}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="flex flex-col gap-3 lg:hidden" data-testid="login-history-cards">
            {entries.map((entry) => (
              <li key={entry.key} className="flex flex-col gap-0.5 border p-3">
                <span className="text-sm font-medium break-words">{entry.device}</span>
                <span className="text-muted-foreground text-xs">
                  {entry.when}{entry.method ? ` · ${entry.method}` : ''}
                </span>
                <span className="text-muted-foreground text-xs">
                  {addressLine(entry)} · {STATUS_LABELS[entry.status]}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
