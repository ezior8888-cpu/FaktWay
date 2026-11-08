'use client';

import { useCallback, useEffect, useMemo, useOptimistic, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { RiAddLine, RiFileSearchLine, RiFileTextLine, RiUploadLine } from '@remixicon/react';

import { InvoicesTable } from '@/app/(dashboard)/invoices/_components/invoices-table';
import { createClient } from '@/lib/supabase/client';
import { buttonVariants } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { plural } from '@/lib/i18n/plural';
import { SelectedPdfDownload } from './batch-pdf-download';
import { SwipeableInvoiceRow } from './swipeable-invoice-row';

import {
  paidOverlay,
  PAYMENT_FACT_FIELDS,
  withPaymentOverlay,
  type InvoiceFactsById,
  type InvoicePaymentOverlay,
  type InvoiceRow,
} from './invoice-row-types';
import { stableOptimisticReducer, useInvoicePayment, type PayableInvoice } from './use-invoice-payment';
import { todayInWarsaw } from '@/lib/format/warsaw-date';
import type { InvoiceListRowFacts } from '@/lib/invoices/list-row-facts';

export type { InvoiceRow } from './invoice-row-types';

/** Faktura z dotknięcia „Zapłacone” razem ze stanem sprzed niego: do tego wraca „Cofnij”. */
interface PayableRow extends PayableInvoice {
  before: InvoicePaymentOverlay;
}

const NO_OVERLAYS: ReadonlyMap<string, InvoicePaymentOverlay> = new Map();

const overlayReducer = stableOptimisticReducer(
  (current: ReadonlyMap<string, InvoicePaymentOverlay>, change: { id: string; overlay: InvoicePaymentOverlay }) =>
    new Map(current).set(change.id, change.overlay) as ReadonlyMap<string, InvoicePaymentOverlay>,
);

/**
 * Lista faktur z nasłuchem Realtime.
 *
 * Server renderuje początkowy snapshot (stronę listy z filtrami z adresu),
 * a klient subskrybuje kanał `postgres_changes` dla tabeli `invoices`:
 *   - INSERT: doklejamy u góry listy.
 *   - UPDATE: mergujemy pola z `payload.new`.
 *   - DELETE: usuwamy wiersz.
 *
 * Nie pollujemy — po `queued` / `sending` / `accepted` job w tle (pg-boss) aktualizuje
 * `ksef_status` w DB; Supabase pushuje zdarzenie przez WebSocket w <1s.
 *
 * Stan płatności („Opłacona”, „Po terminie”, „Do zapłaty”) jest wyliczany przy
 * renderze z faktów serwera i dat wiersza, nie przechowywany. Zmiana kolumny,
 * od której zależą fakty serwera (`PAYMENT_FACT_FIELDS`), odświeża stronę
 * (`router.refresh()`), żeby fakty przeliczył serwer. „Zapłacone” nakłada stan
 * płatności optymistycznie na oba widoki wiersza naraz (karta i tabela są w DOM
 * równocześnie), do odpowiedzi serwera (`useInvoicePayment`).
 *
 * Nowy snapshot z serwera (`initialInvoices` — po `router.refresh()`, zmianie
 * strony albo filtra) zastępuje stan lokalny, ale lista NIE jest remontowana:
 * zaznaczenie wierszy zostaje (przycięte do wierszy, które nadal są), a
 * otwarte okna dialogowe wierszy nie znikają w trakcie pracy użytkownika.
 *
 * RLS na `invoices` zapewnia że klient nie dostanie zdarzeń dla obcych
 * tenantów (policy `invoices_select_own_tenant` + `tenant_id = get_current_tenant_id()`).
 * Dodatkowo `filter` na INSERT/UPDATE ogranicza payload do wierszy tego tenanta
 * (defense-in-depth przy Realtime). DELETE bez filtra — `old` często ma tylko PK
 * (REPLICA IDENTITY), więc filtr `tenant_id` mógłby nie działać; lokalnie i tak
 * usuwamy tylko po `id` obecnym na liście.
 */
export function InvoiceList({
  tenantId,
  initialInvoices,
  filtered = false,
  summary,
  facts = {},
  today,
  canMarkPaid = false,
}: {
  tenantId: string;
  /** Snapshot z serwera; nowa referencja (po `router.refresh()`) zastępuje stan lokalny. */
  initialInvoices: InvoiceRow[];
  /** Fakty wierszy z `loadInvoiceListRowFacts` (id → fakty); brak = „—” w kolumnach płatności. */
  facts?: InvoiceFactsById;
  /** Dziś w Europe/Warsaw (RRRR-MM-DD) z serwera; domyślnie liczone przy renderze. */
  today?: string;
  /**
   * Lista zawężona filtrem albo dalszą stroną (F-086): nowe faktury z Realtime
   * nie są wtedy doklejane (mogą nie pasować do filtra), a pusty wynik to
   * „brak wyników”, nie „brak faktur”.
   */
  filtered?: boolean;
  /** Opis zakresu pozycji z serwera (np. „1–50 z 230”). */
  summary?: string;
  /** Rola pozwala oznaczać zapłatę (`canChangeInvoicePayment`); księgowa ma wgląd. */
  canMarkPaid?: boolean;
}) {
  const router = useRouter();
  const [invoices, setInvoices] = useState<InvoiceRow[]>(initialInvoices);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Synchronizacja ze snapshotem serwera bez remontu (wzorzec „stan z poprzednich
  // propsów”: ustawiamy w trakcie renderu, więc nie ma klatki ze starymi danymi).
  const [syncedFrom, setSyncedFrom] = useState(initialInvoices);
  if (syncedFrom !== initialInvoices) {
    setSyncedFrom(initialInvoices);
    setInvoices(initialInvoices);
    const present = new Set(initialInvoices.map((inv) => inv.id));
    setSelected((prev) => {
      const kept = [...prev].filter((id) => present.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
  }
  const invoicesRef = useRef(invoices);
  useEffect(() => {
    invoicesRef.current = invoices;
  }, [invoices]);
  const dayToday = today ?? todayInWarsaw();

  const [overlays, setOverlay] = useOptimistic(NO_OVERLAYS, overlayReducer);
  const onPaid = useCallback(
    ({ id, before }: PayableRow) => setOverlay({ id, overlay: paidOverlay(before.facts) }),
    [setOverlay],
  );
  const onRestored = useCallback(
    ({ id, before }: PayableRow) => setOverlay({ id, overlay: before }),
    [setOverlay],
  );
  const { mark } = useInvoicePayment<PayableRow>({ onPaid, onRestored });
  const markPaid = useCallback(
    (invoice: InvoiceRow, rowFacts: InvoiceListRowFacts | undefined) =>
      mark({
        id: invoice.id,
        number: invoice.internal_number,
        before: { paymentStatus: invoice.payment_status, facts: rowFacts },
      }),
    [mark],
  );
  const viewFacts = useMemo(() => {
    if (overlays.size === 0) return facts;
    const next: InvoiceFactsById = { ...facts };
    for (const [id, overlay] of overlays) {
      if (overlay.facts) next[id] = overlay.facts;
      else delete next[id];
    }
    return next;
  }, [facts, overlays]);
  const viewInvoices = useMemo(
    () => (overlays.size === 0 ? invoices : invoices.map((inv) => withPaymentOverlay(inv, overlays.get(inv.id)))),
    [invoices, overlays],
  );

  const toggleRow = useCallback((id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const toggleAll = useCallback(
    (checked: boolean) => setSelected(checked ? new Set(invoicesRef.current.map((inv) => inv.id)) : new Set()),
    [],
  );
  // Zaznaczenie tylko wierszy, które nadal są na liście (Realtime potrafi je usunąć).
  const selectedIds = useMemo(
    () => invoices.filter((inv) => selected.has(inv.id)).map((inv) => inv.id),
    [invoices, selected],
  );

  useEffect(() => {
    const supabase = createClient();

    const filter = `tenant_id=eq.${tenantId}`;

    const channel = supabase
      .channel(`invoices-realtime:${tenantId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'invoices',
          filter,
        },
        (payload) => {
          const next = payload.new as Partial<InvoiceRow> & { id: string };
          const current = invoicesRef.current.find((inv) => inv.id === next.id);
          if (
            current &&
            PAYMENT_FACT_FIELDS.some((field) => field in next && String(next[field] ?? '') !== String(current[field] ?? ''))
          ) {
            router.refresh();
          }
          setInvoices((prev) =>
            prev.map((inv) => (inv.id === next.id ? { ...inv, ...next } : inv))
          );
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'invoices',
          filter,
        },
        (payload) => {
          const next = payload.new as InvoiceRow;
          if (filtered) return;
          if ((next as unknown as { direction?: string }).direction === 'incoming')
            return;
          setInvoices((prev) => {
            if (prev.some((inv) => inv.id === next.id)) return prev;
            return [next, ...prev];
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'invoices',
        },
        (payload) => {
          const old = payload.old as { id?: string };
          if (!old.id) return;
          setInvoices((prev) => prev.filter((inv) => inv.id !== old.id));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [tenantId, filtered, router]);

  // Puste stany w oprawie `Empty` Finory (jak „Invoice Not Found” w `invoices-view`),
  // z dzisiejszymi tekstami i linkami (PLAN-FINORA §7.3, e2e/tests/04-empty-states.spec.ts).
  if (invoices.length === 0 && filtered) {
    return (
      <Empty className="border-t py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RiFileSearchLine />
          </EmptyMedia>
          <EmptyTitle>Brak faktur dla tych filtrów</EmptyTitle>
          <EmptyDescription>Zmień frazę, status albo okres — albo wyczyść filtry.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link href="/invoices" className={buttonVariants({ variant: 'default' })}>
            Wyczyść filtry
          </Link>
        </EmptyContent>
      </Empty>
    );
  }

  if (invoices.length === 0) {
    return (
      <Empty className="border-t py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RiFileTextLine />
          </EmptyMedia>
          <EmptyTitle>Brak faktur wystawionych</EmptyTitle>
          <EmptyDescription>
            Wystaw pierwszą fakturę albo zaimportuj historię z poprzedniego programu. Migracja CSV z Fakturownia /
            inFakt / wFirma / iFirma zajmuje 5 minut.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row flex-wrap justify-center">
          <Link href="/invoices/new" className={buttonVariants({ variant: 'default' })}>
            <RiAddLine aria-hidden />
            Wystaw pierwszą fakturę
          </Link>
          <Link href="/onboarding/import-source" className={buttonVariants({ variant: 'outline' })}>
            <RiUploadLine aria-hidden />
            Importuj historię
          </Link>
        </EmptyContent>
      </Empty>
    );
  }

  const selectedSet = new Set(selectedIds);

  return (
    <>
      {/*
        Zaznaczone wiersze (od `lg`, jak zaznaczanie w tabeli Finory): pasek z „Pobierz PDF
        zaznaczonych” pokazuje się tylko przy zaznaczeniu. Finora nie ma akcji zbiorczej;
        to nasza funkcja (P3), więc stoi nad tabelą, nie w pasku narzędzi.
      */}
      {selectedIds.length > 0 ? (
        <div className="hidden items-center justify-between gap-3 border-t px-4 py-2 lg:flex">
          <p className="text-muted-foreground text-sm">
            {`Zaznaczono ${selectedIds.length} ${plural(selectedIds.length, ['fakturę', 'faktury', 'faktur'])}`}
          </p>
          <SelectedPdfDownload ids={selectedIds} />
        </div>
      ) : null}

      {/* TELEFON (< lg, §7.2): wiersze-karty ze swipe zamiast tabeli */}
      <div className="divide-y border-t lg:hidden">
        {viewInvoices.map((inv) => (
          <SwipeableInvoiceRow
            key={inv.id}
            invoice={inv}
            facts={viewFacts[inv.id]}
            today={dayToday}
            onMarkPaid={canMarkPaid ? markPaid : undefined}
          />
        ))}
      </div>

      {/* KOMPUTER (lg+): data-table Finory */}
      <div className="hidden lg:block">
        {summary ? <p className="sr-only">{summary}</p> : null}
        <InvoicesTable
          invoices={viewInvoices}
          facts={viewFacts}
          today={dayToday}
          selectedIds={selectedSet}
          onToggleRow={toggleRow}
          onToggleAll={toggleAll}
          onMarkPaid={canMarkPaid ? markPaid : undefined}
        />
      </div>
    </>
  );
}
