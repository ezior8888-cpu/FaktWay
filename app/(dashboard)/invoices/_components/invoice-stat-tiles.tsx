import { Fragment, Suspense, type ComponentType, type ReactNode } from 'react';
import Link from 'next/link';
import { RiMoneyDollarCircleLine, RiPagesLine, RiUserLine, RiWalletLine } from '@remixicon/react';

import { pulpitErrorMessage, PULPIT_GENERIC_ERROR } from '@/components/dashboard/pulpit/pulpit-grid';
import { SectionErrorBoundary } from '@/components/dashboard/section-error-boundary';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { getReceivables, RECEIVABLES_NOTE } from '@/lib/dashboard/receivables';
import { formatPlCompactMoney, formatPlInt, formatPlMoney } from '@/lib/format/pl';
import { plural } from '@/lib/i18n/plural';
import { countContractors, countInvoicesThisMonth, PAID_EMPTY_STATE, PAID_NOTE, paidThisMonth } from '@/lib/invoices/list-stats';
import type { PageContext } from '@/lib/supabase/page-context';
import { cn } from '@/lib/utils';

/**
 * Kafle listy faktur = `InvoiceStatsCards` Finory (`invoices-list/stats-cards.tsx`
 * → `views/stats-cards.tsx`, `iconPosition='right'`): JEDNA karta, cztery
 * statystyki w dwóch grupach po dwie, między nimi separatory (pionowe od `sm`
 * / `xl`, poziome niżej). Klasy siatki 1:1 z `StatsCards`.
 *
 * Konieczność (§2.4 pkt 15): każda statystyka to osobny asynchroniczny Server
 * Component w <Suspense> + `SectionErrorBoundary`. Wyjątek strażnika (waluta,
 * środowisko, niepełna strona) zabiera jedną komórkę karty, nie tabelę ani
 * sąsiednie liczby. Granice nie dodają elementów DOM, więc siatka Finory się
 * nie zmienia.
 *
 * Komunikat błędu bierzemy z samego wyjątku w komórce (try/catch), bo granica
 * błędu nie przekazuje tekstu, a Next.js w produkcji ukrywa treść wyjątków
 * serwerowych; filtr `pulpitErrorMessage` (jak Pulpit) zostawia polskie
 * komunikaty strażników i ucina angielski ogon PostgREST-a. Granica zostaje
 * siatką bezpieczeństwa na błąd renderu.
 */

export interface TileProps {
  supabase: PageContext['supabase'];
  tenantId: string;
  now?: Date;
}

const money = (n: number) => `${formatPlMoney(n)} zł`;

/** Komórka statystyki Finory: wartość `text-2xl`, etykieta, ikona po prawej w kwadracie `bg-muted`. */
export function StatCell({
  label,
  value,
  title,
  note,
  icon: Icon,
}: {
  label: string;
  value: string;
  /** Pełna kwota, gdy wartość jest skrócona („45,6 tys. zł”). */
  title?: string;
  note?: ReactNode;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-4">
      <div className="min-w-0">
        <h4 className="text-foreground text-2xl font-medium tabular-nums" title={title}>
          {value}
        </h4>
        <p className="text-muted-foreground text-sm">{label}</p>
        {note ? <p className="text-muted-foreground mt-0.5 text-xs">{note}</p> : null}
      </div>
      <div className="bg-muted flex size-10 shrink-0 items-center justify-center">
        <Icon className="text-foreground size-6" />
      </div>
    </div>
  );
}

/** Komórka błędu jednej statystyki: tekst wyjątku + wyjście do przepływów. */
export function TileError({ label, message }: { label: string; message: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col justify-center gap-1" role="status">
      <p className="text-foreground text-sm font-medium">{label}</p>
      <p className="text-muted-foreground text-xs">{message}</p>
      <Link href="/przeplywy" className="text-primary text-xs underline-offset-4 hover:underline">
        Sprawdź w Przepływach
      </Link>
    </div>
  );
}

function TileSkeleton() {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between gap-4" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="size-10" />
    </div>
  );
}

interface TileData {
  value: string;
  title?: string;
  note?: ReactNode;
  icon: ComponentType<{ className?: string }>;
}

async function loadTile(label: string, load: () => Promise<TileData>): Promise<ReactNode> {
  try {
    const data = await load();
    return <StatCell label={label} {...data} />;
  } catch (error) {
    const message = pulpitErrorMessage(error);
    if (message === PULPIT_GENERIC_ERROR) console.error(`[invoices] kafel „${label}”:`, error);
    return <TileError label={label} message={message} />;
  }
}

/** Kwota w kaflu: skrót („45,6 tys. zł”, §7.1) z pełną kwotą w `title`. */
function compact(n: number): Pick<TileData, 'value' | 'title'> {
  return { value: formatPlCompactMoney(n), title: money(n) };
}

export async function ContractorsTile({ supabase, tenantId }: TileProps) {
  return loadTile('Kontrahenci', async () => ({
    value: formatPlInt(await countContractors(supabase, tenantId)),
    icon: RiUserLine,
  }));
}

export async function InvoicesThisMonthTile({ supabase, tenantId, now }: TileProps) {
  return loadTile('Faktury w tym miesiącu', async () => {
    const { accepted, drafts } = await countInvoicesThisMonth(supabase, tenantId, now);
    return {
      value: formatPlInt(accepted),
      note: drafts > 0 ? `+ ${drafts} ${plural(drafts, ['szkic', 'szkice', 'szkiców'])} poza KSeF` : undefined,
      icon: RiPagesLine,
    };
  });
}

export async function PaidThisMonthTile({ supabase, tenantId, now }: TileProps) {
  return loadTile('Opłacone w tym miesiącu', async () => {
    const paid = await paidThisMonth(supabase, tenantId, now);
    return paid === null
      ? { value: '—', note: PAID_EMPTY_STATE, icon: RiWalletLine }
      : { ...compact(paid), note: PAID_NOTE, icon: RiWalletLine };
  });
}

export async function ReceivablesTile({ supabase, tenantId, now }: TileProps) {
  return loadTile('Do zapłaty', async () => {
    const receivables = await getReceivables(supabase, tenantId, now);
    const skipped = receivables.foreignCurrencyCount;
    return {
      ...compact(receivables.total),
      note: (
        <>
          {RECEIVABLES_NOTE}
          {skipped > 0 ? (
            <>
              <br />
              Pominięto {skipped} {plural(skipped, ['fakturę', 'faktury', 'faktur'])} w walucie obcej
            </>
          ) : null}
        </>
      ),
      icon: RiMoneyDollarCircleLine,
    };
  });
}

function TileSlot({ label, children }: { label: string; children: ReactNode }) {
  return (
    <SectionErrorBoundary fallback={<TileError label={label} message="Nie udało się wyświetlić kafla." />}>
      <Suspense fallback={<TileSkeleton />}>{children}</Suspense>
    </SectionErrorBoundary>
  );
}

/**
 * Siatka `StatsCards` z Finory z gotowymi komórkami (każda w swoim slocie).
 * `cells` w parach: [Kontrahenci, Faktury] | [Opłacone, Do zapłaty].
 */
export function StatsCardsGrid({ cells, className }: { cells: Array<{ key: string; node: ReactNode }>; className?: string }) {
  const groups = cells.reduce<Array<typeof cells>>((acc, cell, index) => {
    if (index % 2 === 0) acc.push([cell]);
    else acc[acc.length - 1]?.push(cell);
    return acc;
  }, []);

  return (
    <Card className={cn('shadow-none', className)}>
      <CardContent>
        <div className="flex gap-5 max-xl:flex-col">
          {groups.map((group, groupIndex) => (
            <Fragment key={groupIndex}>
              {groupIndex > 0 && (
                <>
                  <Separator className="xl:hidden" />
                  <Separator orientation="vertical" className="hidden xl:block" />
                </>
              )}
              <div className="flex flex-1 gap-5 max-sm:flex-col">
                {group.map((cell, cellIndex) => (
                  <Fragment key={cell.key}>
                    {cellIndex > 0 && (
                      <>
                        <Separator className="sm:hidden" />
                        <Separator orientation="vertical" className="hidden sm:block" />
                      </>
                    )}
                    {cell.node}
                  </Fragment>
                ))}
              </div>
            </Fragment>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** Kafle listy: Kontrahenci · Faktury w tym miesiącu · Opłacone w tym miesiącu · Do zapłaty. */
export function InvoiceStatTiles(props: TileProps) {
  return (
    <StatsCardsGrid
      cells={[
        {
          key: 'kontrahenci',
          node: (
            <TileSlot label="Kontrahenci">
              <ContractorsTile {...props} />
            </TileSlot>
          ),
        },
        {
          key: 'faktury',
          node: (
            <TileSlot label="Faktury w tym miesiącu">
              <InvoicesThisMonthTile {...props} />
            </TileSlot>
          ),
        },
        {
          key: 'oplacone',
          node: (
            <TileSlot label="Opłacone w tym miesiącu">
              <PaidThisMonthTile {...props} />
            </TileSlot>
          ),
        },
        {
          key: 'do-zaplaty',
          node: (
            <TileSlot label="Do zapłaty">
              <ReceivablesTile {...props} />
            </TileSlot>
          ),
        },
      ]}
    />
  );
}
