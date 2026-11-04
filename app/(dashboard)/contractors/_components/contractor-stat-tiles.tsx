import { cache, Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import {
  RiAlarmWarningLine,
  RiContactsBook3Line,
  RiShieldCheckLine,
  RiUserFollowLine,
  type RemixiconComponentType,
} from '@remixicon/react';

import StatsCards from '@/components/dashboard/stats-cards';
import { pulpitErrorMessage, PULPIT_GENERIC_ERROR } from '@/components/dashboard/pulpit/pulpit-grid';
import { SectionErrorBoundary } from '@/components/dashboard/section-error-boundary';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  countActiveContractors,
  countContractorsWithOverdue,
  needsVatCheck,
  readContractorKeys,
} from '@/lib/contractors/overview';
import { getReceivables, RECEIVABLES_NOTE } from '@/lib/dashboard/receivables';
import { formatPlInt } from '@/lib/format/pl';
import { plural } from '@/lib/i18n/plural';
import type { PageContext } from '@/lib/supabase/page-context';

/**
 * Kafle `/contractors` (P13; Finora: `stats-cards` z Invoice List).
 * KAŻDY to osobny asynchroniczny Server Component w <Suspense> +
 * `SectionErrorBoundary` (§2.4 pkt 15): strażnik środowiska albo niepełna
 * strona zabiera jeden kafel, nie tabelę. Treść wyjątku przez
 * `pulpitErrorMessage` (polska część komunikatu, bez ogona PostgREST-a).
 *
 * Kartotekę i należności czytamy raz na żądanie (`cache`) — tabela kolumn
 * „Należności” i „Po terminie” bierze te same dane.
 */

export interface ContractorTileProps {
  supabase: PageContext['supabase'];
  tenantId: string;
  now?: Date;
}

export const loadContractorKeys = cache((supabase: PageContext['supabase'], tenantId: string) =>
  readContractorKeys(supabase, tenantId));

export const loadReceivables = cache((supabase: PageContext['supabase'], tenantId: string) =>
  getReceivables(supabase, tenantId));

/**
 * Faktury w walucie obcej nie wchodzą do należności (§2.4 pkt 6 i 11) —
 * mówimy o tym wprost, żeby „0,00 zł” nie wyglądało na prawdziwe zero
 * (wzór: kafel „Do zapłaty” listy faktur).
 */
export function foreignCurrencyNote(count: number): string | null {
  return count > 0 ? `Pominięto ${formatPlInt(count)} ${plural(count, ['fakturę', 'faktury', 'faktur'])} w walucie obcej` : null;
}

/** Karta błędu jednego kafla: tekst wyjątku + wyjście do przepływów. */
export function ContractorTileError({ label, message }: { label: string; message: string }) {
  return (
    <Card className="shadow-none" role="status">
      <CardContent className="space-y-1">
        <p className="text-foreground text-sm font-medium">{label}</p>
        <p className="text-muted-foreground text-xs">{message}</p>
        <Link href="/przeplywy" className="text-primary text-xs underline-offset-4 hover:underline">
          Sprawdź w Przepływach
        </Link>
      </CardContent>
    </Card>
  );
}

function TileSkeleton() {
  return (
    <Card className="shadow-none" aria-busy="true">
      <CardContent className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="size-10" />
      </CardContent>
    </Card>
  );
}

async function loadTile(
  label: string,
  load: () => Promise<{ value: string; note?: ReactNode; icon: RemixiconComponentType }>,
): Promise<ReactNode> {
  try {
    const { value, note, icon } = await load();
    return <StatsCards stats={[{ label, value, note, icon }]} iconPosition="right" />;
  } catch (error) {
    const message = pulpitErrorMessage(error);
    if (message === PULPIT_GENERIC_ERROR) console.error(`[kontrahenci] kafel „${label}”:`, error);
    return <ContractorTileError label={label} message={message} />;
  }
}

export async function ContractorsCountTile({ supabase, tenantId }: ContractorTileProps) {
  return loadTile('Kontrahenci', async () => ({
    value: formatPlInt((await loadContractorKeys(supabase, tenantId)).length),
    icon: RiContactsBook3Line,
  }));
}

export async function ActiveContractorsTile({ supabase, tenantId, now }: ContractorTileProps) {
  return loadTile('Aktywni (90 dni)', async () => {
    const contractors = await loadContractorKeys(supabase, tenantId);
    return {
      value: formatPlInt(await countActiveContractors(supabase, tenantId, contractors, now)),
      note: 'z fakturą przyjętą w KSeF',
      icon: RiUserFollowLine,
    };
  });
}

export async function OverdueContractorsTile({ supabase, tenantId }: ContractorTileProps) {
  return loadTile('Z zaległościami', async () => {
    const [contractors, receivables] = await Promise.all([
      loadContractorKeys(supabase, tenantId),
      loadReceivables(supabase, tenantId),
    ]);
    const skipped = foreignCurrencyNote(receivables.foreignCurrencyCount);
    return {
      value: formatPlInt(countContractorsWithOverdue(contractors, receivables)),
      note: skipped ? (
        <>
          {RECEIVABLES_NOTE}
          <br />
          {skipped}
        </>
      ) : RECEIVABLES_NOTE,
      icon: RiAlarmWarningLine,
    };
  });
}

export async function VatToCheckTile({ supabase, tenantId }: ContractorTileProps) {
  return loadTile('Status VAT do sprawdzenia', async () => {
    const contractors = await loadContractorKeys(supabase, tenantId);
    return {
      value: formatPlInt(contractors.filter(needsVatCheck).length),
      note: 'niezweryfikowani, wykreśleni i z ostrzeżeniem',
      icon: RiShieldCheckLine,
    };
  });
}

function TileSlot({ label, children }: { label: string; children: ReactNode }) {
  return (
    <SectionErrorBoundary fallback={<ContractorTileError label={label} message="Nie udało się wyświetlić kafla." />}>
      <Suspense fallback={<TileSkeleton />}>{children}</Suspense>
    </SectionErrorBoundary>
  );
}

/** Rząd czterech kafli: Kontrahenci · Aktywni (90 dni) · Z zaległościami · Status VAT do sprawdzenia. */
export function ContractorStatTiles(props: ContractorTileProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <TileSlot label="Kontrahenci">
        <ContractorsCountTile {...props} />
      </TileSlot>
      <TileSlot label="Aktywni (90 dni)">
        <ActiveContractorsTile {...props} />
      </TileSlot>
      <TileSlot label="Z zaległościami">
        <OverdueContractorsTile {...props} />
      </TileSlot>
      <TileSlot label="Status VAT do sprawdzenia">
        <VatToCheckTile {...props} />
      </TileSlot>
    </div>
  );
}
