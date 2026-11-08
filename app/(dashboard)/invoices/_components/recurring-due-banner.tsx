import Link from 'next/link';
import { RiArrowRightLine, RiRepeatLine } from '@remixicon/react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { plural } from '@/lib/i18n/plural';
import { countRecurringInvoicesDue } from '@/lib/invoices/recurring/queries';
import type { PageContext } from '@/lib/supabase/page-context';

/**
 * Napis banera: „1 faktura cykliczna czeka na wystawienie”, „2 faktury
 * cykliczne czekają…”, „5 faktur cyklicznych czeka…” (`plural`, jedno
 * miejsce odmiany w aplikacji). Dla 0 nie ma banera, więc funkcja
 * zakłada `count >= 1`.
 */
export function recurringDueText(count: number): string {
  const verb = plural(count, ['faktura cykliczna czeka', 'faktury cykliczne czekają', 'faktur cyklicznych czeka']);
  return `${count} ${verb} na wystawienie`;
}

/** Sam baner (bez odczytu) — osobno dla testów i dla stanu z gotową liczbą. */
export function RecurringDueBannerView({ count }: { count: number }) {
  if (!Number.isFinite(count) || count < 1) return null;
  return (
    <Alert role='status' data-testid='baner-faktur-cyklicznych'>
      <RiRepeatLine aria-hidden />
      <AlertTitle>{recurringDueText(count)}</AlertTitle>
      <AlertDescription>
        <Link href='/invoices/recurring' className='inline-flex items-center gap-1 font-medium'>
          Zobacz faktury cykliczne
          <RiArrowRightLine className='size-3.5' aria-hidden />
        </Link>
      </AlertDescription>
    </Alert>
  );
}

/**
 * Baner nad kafelkami listy faktur (plan Finora N1): ile pozycji cyklicznych
 * czeka na wystawienie (aktywne, `next_run_date <= dziś` w Europe/Warsaw).
 * Gdy 0 — nic. Błąd odczytu licznika (`null`: np. baza przed migracją 00154)
 * albo wyjątek NIE psuje listy: baner po prostu się nie pokazuje — to dodatek,
 * a lista faktur ma własne, ważniejsze komunikaty błędów. Sam odczyt zwraca
 * `null` zamiast rzucać, a `try/catch` łapie nieprzewidziany wyjątek klienta.
 */
export async function RecurringDueBanner({
  supabase,
  tenantId,
  today,
}: {
  supabase: PageContext['supabase'];
  tenantId: string;
  today: string;
}) {
  let count: number | null = null;
  try {
    count = await countRecurringInvoicesDue(supabase, tenantId, today);
  } catch (error) {
    console.error('[invoices] licznik faktur cyklicznych:', error);
  }
  return count === null ? null : <RecurringDueBannerView count={count} />;
}
