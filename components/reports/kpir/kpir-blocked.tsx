import Link from 'next/link';
import { RiErrorWarningLine } from '@remixicon/react';

import { buttonVariants } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { cn } from '@/lib/utils';

const PREFIX = 'Raport wstrzymany: ';
const MAX_INVOICE_LINKS = 3;
/** Fragment komunikatu `KsefExpenseCurrencyNotSupportedError` (`lib/expenses/ksef-currency-review.ts`). */
const KSEF_COST_CAUSE = /koszt ze skrzynki KSeF/i;

// `cn()` (twMerge), nie samo `buttonVariants()`: baza cva ma `border-transparent`,
// wariant `border-border` — bez scalenia w CSS wygrywał przezroczysty i linki
// wyjścia w jasnym motywie wyglądały jak zwykły tekst.
const OUTLINE_LINK = cn(buttonVariants({ variant: 'outline', size: 'sm' }));
const PRIMARY_LINK = cn(buttonVariants({ size: 'sm' }));

/** Powód z `lib` bez przedrostka (tytuł mówi już „Raport wstrzymany”), z wielkiej litery. */
function reason(message: string): string {
  if (!message.startsWith(PREFIX)) return message;
  const rest = message.slice(PREFIX.length).trim();
  return rest ? rest.charAt(0).toLocaleUpperCase('pl-PL') + rest.slice(1) : message;
}

/**
 * KPiR wstrzymany przez walutę (faktura sprzedaży bez potwierdzonego PLN albo
 * koszt ze skrzynki KSeF bez przeliczenia) — w karcie z zakładkami, BEZ kwot
 * w złotych: kwoty z EUR liczone jak zł byłyby nieprawdą.
 *
 * Poprawka Bartosza 21.10.2026 (przeprojektowanie Księgowości): blokada ma
 * wyjście — linki do faktur, które ją powodują, i (gdy przyczyną jest koszt
 * KSeF) do kosztów miesiąca i Skrzynki KSeF; przełącznik miesiąca stoi nad
 * kartą. Wyjścia wynikają z przyczyny, nie tylko z listy faktur: `getKpirData`
 * przy obu naraz podaje komunikat o koszcie (`currencyError ?? …`), a faktury
 * w EUR i tak są na liście — same linki do faktur zostawiały podaną przyczynę
 * bez wyjścia. Komponent serwerowy (bez hooków).
 */
export function KpirBlocked({
  message,
  period,
  blockingInvoices,
}: {
  /** Komunikat z `getKpirData` (`currencyBlocked`). */
  message: string;
  /** Miesiąc RRRR-MM. */
  period: string;
  blockingInvoices: readonly { id: string; number: string }[];
}) {
  // Bez faktur na liście jedyną możliwą przyczyną jest koszt KSeF.
  const costCause = KSEF_COST_CAUSE.test(message) || blockingInvoices.length === 0;

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon" className="bg-destructive/10 text-destructive">
            <RiErrorWarningLine aria-hidden />
          </EmptyMedia>
          <EmptyTitle>Raport wstrzymany</EmptyTitle>
          <EmptyDescription>{reason(message)}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          {costCause ? (
            <>
              <Link href={`/expenses?miesiac=${period}`} className={PRIMARY_LINK}>
                Koszty miesiąca
              </Link>
              <Link href="/inbox" className={OUTLINE_LINK}>
                Skrzynka KSeF
              </Link>
            </>
          ) : null}
          {blockingInvoices.length > 0 ? (
            <>
              {blockingInvoices.slice(0, MAX_INVOICE_LINKS).map((invoice) => (
                <Link key={invoice.id} href={`/invoices/${invoice.id}`} className={OUTLINE_LINK}>
                  {invoice.number}
                </Link>
              ))}
              <Link href="/invoices" className={OUTLINE_LINK}>
                Faktury
              </Link>
            </>
          ) : null}
        </EmptyContent>
      </Empty>
    </div>
  );
}
