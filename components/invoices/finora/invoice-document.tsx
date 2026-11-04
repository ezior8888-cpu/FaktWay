import type { ReactNode } from 'react';
import Link from 'next/link';
import { RiArrowLeftLine } from '@remixicon/react';

import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { SellerData } from '@/types/invoice-types';

/**
 * Oprawa formularza faktury w układzie Finory (P5,
 * `finora-src/src/views/pages/invoices/invoices-create/invoice-form.tsx`).
 *
 * TYLKO UKŁAD. Te komponenty nie znają pól, walidacji ani akcji — dostają
 * gotowe dzieci z formularzy (`invoice-form`, `advance-form`, `final-form`),
 * które dalej same rejestrują pola w React Hook Form. Dzięki temu oprawę da
 * się sprawdzić `renderToStaticMarkup` bez formularza
 * (`tests/unit/wystaw-fakture-uklad.test.tsx`).
 *
 * Mapa Finora → u nas:
 *  - siatka `grid grid-cols-1 gap-6 lg:grid-cols-[1fr_18rem]` → `InvoiceCreateGrid`,
 *  - karta dokumentu `Card gap-6 py-0 shadow-none` → `InvoiceDocumentCard`,
 *  - nagłówek `bg-muted/50 … p-6` (logo + adres | Invoice, Date Issued,
 *    Date Due) → `InvoiceDocumentHeader` (sprzedawca | numer, daty),
 *  - wiersz „etykieta — pole” po prawej → `DocumentHeaderRow`,
 *  - kolumny „Invoice To:” / „Bill To:” (`w-full max-w-xs space-y-3`)
 *    → `DocumentColumns` + `DocumentSection` (Nabywca / Płatność),
 *  - blok „Subtotal / Tax / Total” → `DocumentSummary` + `DocumentSummaryRow`.
 */

/** Siatka strony: dokument po lewej, kolumna akcji 18rem po prawej od `lg`. */
export function InvoiceCreateGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-testid="wystaw-fakture-siatka"
      className={cn('grid grid-cols-1 gap-6 lg:grid-cols-[1fr_18rem]', className)}
    >
      {children}
    </div>
  );
}

/** Karta dokumentu: nagłówek na szarym tle + treść z odstępem 24 px. */
export function InvoiceDocumentCard({
  header,
  children,
  className,
}: {
  header: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card data-testid="dokument-formularza" className={cn('min-w-0 gap-6 py-0 shadow-none', className)}>
      {header}
      <CardContent className="space-y-6 px-4 pb-6 sm:px-6">{children}</CardContent>
    </Card>
  );
}

/**
 * Nagłówek dokumentu: sprzedawca po lewej (w Finorze logo i adres
 * wystawcy), numer i daty po prawej.
 *
 * Bez danych sprzedawcy (`seller = null`) pokazujemy, skąd je weźmiemy —
 * blokadę wystawiania robi strona (`SellerProfileBlock`), nie oprawa.
 */
export function InvoiceDocumentHeader({
  seller,
  children,
}: {
  seller: SellerData | null;
  children: ReactNode;
}) {
  return (
    <div className="bg-muted/50 flex flex-wrap items-start justify-between gap-6 p-4 sm:p-6">
      <div data-testid="sprzedawca" className="min-w-0 space-y-2">
        <p className="text-muted-foreground text-xs font-medium">Sprzedawca</p>
        {seller ? (
          <>
            <p className="text-xl font-semibold break-words">{seller.name}</p>
            <div className="text-muted-foreground space-y-1 text-sm">
              <p className="tabular-nums">NIP: {seller.nip}</p>
              <p>{seller.address.addressLine1}</p>
              <p>{seller.address.addressLine2}</p>
            </div>
          </>
        ) : (
          <div className="text-muted-foreground space-y-1 text-sm">
            <p>Dane sprzedawcy weźmiemy z profilu firmy.</p>
            <Link href="/settings" className="text-primary underline-offset-4 hover:underline">
              Sprawdź dane firmy
            </Link>
          </div>
        )}
      </div>
      <div className="w-full shrink-0 space-y-3 sm:w-auto">{children}</div>
    </div>
  );
}

/** Wiersz nagłówka „etykieta — pole” (Finora: Invoice / Date Issued / Date Due). */
export function DocumentHeaderRow({
  label,
  htmlFor,
  children,
  hint,
  error,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  /** Krótka podpowiedź pod polem (np. P_6 przy dacie sprzedaży). */
  hint?: ReactNode;
  error?: ReactNode;
}) {
  return (
    <div className="space-y-1">
      {/* Poniżej sm etykieta nad polem: na 375 px etykieta „Data sprzedaży /
          dostawy” + pole 11rem nie mieszczą się w karcie (przegląd P5). */}
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <Label htmlFor={htmlFor} className="text-sm font-medium sm:shrink-0">
          {label}
        </Label>
        <div className="w-full sm:w-44 sm:flex-none">{children}</div>
      </div>
      {error ? <div className="sm:ml-auto sm:max-w-64">{error}</div> : null}
      {!error && hint ? (
        <p className="text-muted-foreground text-xs sm:ml-auto sm:max-w-64 sm:text-right">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Dwie kolumny pod nagłówkiem (Finora: „Invoice To:” | „Bill To:”).
 * Odstępstwo: Finora składa je od `sm`, my od `xl`. Sekcja Nabywca (trzy
 * rodzaje nabywcy, NIP z GUS, VAT-UE, kraj, adres) nie mieści się w połowie
 * karty, a od `lg` obok dokumentu stoi jeszcze kolumna akcji 18rem — poniżej
 * `xl` obie sekcje mają pełną szerokość (przegląd P5).
 */
export function DocumentColumns({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">{children}</div>;
}

/** Sekcja dokumentu z tytułem w stylu Finory (`h6 font-medium`). */
export function DocumentSection({
  title,
  description,
  action,
  children,
  className,
  testId,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section data-testid={testId} aria-label={title} className={cn('min-w-0 space-y-3', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-medium">{title}</h2>
          {description ? <p className="text-muted-foreground mt-1 text-xs">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Podsumowanie po prawej na dole (Finora: Subtotal / Tax / Total,
 * `w-full max-w-56 space-y-1.5 text-sm`). U nas szersze, bo polskie podpisy
 * są dłuższe („Do zapłaty po odliczeniu zaliczek”).
 */
export function DocumentSummary({
  label = 'Podsumowanie faktury',
  children,
  className,
}: {
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="flex justify-end">
      <section aria-label={label} className={cn('w-full space-y-1.5 text-sm sm:max-w-80', className)}>
        {children}
      </section>
    </div>
  );
}

export function DocumentSummaryRow({
  label,
  value,
  strong = false,
}: {
  label: ReactNode;
  value: ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={strong ? 'font-medium' : 'text-muted-foreground'}>{label}</span>
      <span className={cn('tabular-nums', strong ? 'text-base font-semibold' : 'font-medium')}>{value}</span>
    </div>
  );
}

/** Nagłówek strony nad siatką (jak „Faktury wystawione” na liście, P3). */
export function InvoiceCreatePageHeading({
  title,
  description,
  backHref = '/invoices/new',
  backLabel = 'Rodzaj faktury',
  className,
}: {
  title: string;
  description: ReactNode;
  backHref?: string;
  backLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn('space-y-3', className)}>
      <Link
        href={backHref}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <RiArrowLeftLine className="size-4" aria-hidden />
        {backLabel}
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
    </div>
  );
}

/**
 * Data z bazy (`RRRR-MM-DD`) w podpisie jako `DD.MM.RRRR` (§7.1 planu).
 * Bez strefy czasowej — to data kalendarzowa, nie chwila.
 */
export function formatIsoDatePl(iso: string | null | undefined): string {
  if (!iso) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}
