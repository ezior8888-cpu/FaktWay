'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { InvoiceList } from '@/components/invoices/invoice-list';
import { PullToRefresh } from '@/components/pwa/pull-to-refresh';

import type { InvoiceFactsById, InvoiceRow } from '@/components/invoices/invoice-row-types';

/**
 * Lista bez klucza z danych: Realtime zmienia dane widocznego wiersza →
 * `router.refresh()` → nowy snapshot. Remont listy kasowałby zaznaczenie
 * i otwarte okna wierszy, więc `InvoiceList` bierze snapshot z
 * `initialInvoices` bez remontu.
 */
export function InvoicesPullToRefresh({
  tenantId,
  initialInvoices,
  filtered = false,
  summary,
  facts,
  today,
  canMarkPaid = false,
}: {
  tenantId: string;
  initialInvoices: InvoiceRow[];
  /** Lista zawężona filtrem albo dalszą stroną (F-086). */
  filtered?: boolean;
  /** Opis zakresu pozycji pod nagłówkiem tabeli. */
  summary?: string;
  /** Fakty płatności wierszy z serwera (id → fakty). */
  facts?: InvoiceFactsById;
  /** Dziś w Europe/Warsaw (RRRR-MM-DD). */
  today?: string;
  /** Rola pozwala oznaczać zapłatę. */
  canMarkPaid?: boolean;
}) {
  const router = useRouter();
  // `router.refresh()` nie zwraca obietnicy; przejście mówi, kiedy nowy
  // snapshot z serwera już stoi na ekranie.
  const [refreshing, startRefresh] = useTransition();

  return (
    <PullToRefresh refreshing={refreshing} onRefresh={() => startRefresh(() => router.refresh())}>
      <InvoiceList
        tenantId={tenantId}
        initialInvoices={initialInvoices}
        filtered={filtered}
        summary={summary}
        facts={facts}
        today={today}
        canMarkPaid={canMarkPaid}
      />
    </PullToRefresh>
  );
}
