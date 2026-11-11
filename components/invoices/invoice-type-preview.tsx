import { cn } from '@/lib/utils';

/**
 * Miniatura dokumentu na kartach wyboru rodzaju faktury (`/invoices/new`).
 *
 * Zamiast ikon (poprawka Bartosza 11.11.2026: „dziwne ikony brzydkie”) każda
 * karta pokazuje kartkę faktury narysowaną z pasków. Układ kartki jest wspólny
 * (nagłówek, strony, pozycje, suma), a różni się tylko miejsce, które ten
 * rodzaj faktury zmienia:
 *
 * - zwykła: pozycje i suma,
 * - korygująca: przekreślona pozycja „przed” i nowa „po”,
 * - zaliczkowa: pasek części umowy, za którą płaci się teraz,
 * - rozliczająca: pozycje, odjęte zaliczki i suma do dopłaty.
 *
 * Czysta ozdoba (`aria-hidden`): treść karty mówi to samo słowami.
 */
export type InvoiceTypePreviewVariant = 'regular' | 'correction' | 'advance' | 'final';

type Tone = 'muted' | 'strong' | 'accent' | 'accentSoft';

const TONE: Record<Tone, string> = {
  muted: 'bg-foreground/15',
  strong: 'bg-foreground/50',
  accent: 'bg-primary',
  accentSoft: 'bg-primary/40',
};

function Bar({ className, tone = 'muted' }: { className: string; tone?: Tone }) {
  return <span className={cn('block h-1 shrink-0 rounded-full', TONE[tone], className)} />;
}

function Row({ left, right, tone }: { left: string; right: string; tone?: Tone }) {
  return (
    <span className="flex items-center justify-between gap-2">
      <Bar className={left} tone={tone} />
      <Bar className={right} tone={tone} />
    </span>
  );
}

function Body({ variant }: { variant: InvoiceTypePreviewVariant }) {
  switch (variant) {
    case 'correction':
      return (
        <>
          <span className="relative flex items-center justify-between gap-2">
            <Bar className="w-14" />
            <Bar className="w-5" />
            <span className="bg-destructive/70 absolute inset-x-[-2px] top-1/2 h-px -translate-y-1/2" />
          </span>
          <Row left="w-12" right="w-6" tone="accentSoft" />
          <Row left="w-10" right="w-5" />
        </>
      );
    case 'advance':
      return (
        <>
          <Row left="w-12" right="w-7" />
          <span className="bg-foreground/10 block h-1.5 w-full overflow-hidden rounded-full">
            <span className="bg-primary block h-full w-[35%] rounded-full" />
          </span>
          <Row left="w-9" right="w-5" />
        </>
      );
    case 'final':
      return (
        <>
          <Row left="w-14" right="w-6" />
          <Row left="w-11" right="w-5" />
          <span className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1">
              <span className="bg-primary h-px w-1.5" />
              <Bar className="w-10" tone="accentSoft" />
            </span>
            <Bar className="w-5" tone="accentSoft" />
          </span>
        </>
      );
    case 'regular':
      return (
        <>
          <Row left="w-14" right="w-6" />
          <Row left="w-11" right="w-5" />
          <Row left="w-16" right="w-6" />
        </>
      );
  }
}

export function InvoiceTypePreview({
  variant,
  className,
}: {
  variant: InvoiceTypePreviewVariant;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-testid={`miniatura-${variant}`}
      className={cn(
        'bg-card ring-foreground/8 flex w-38 flex-col gap-3 p-3.5 ring-1',
        'shadow-[0_1px_2px_rgb(0_0_0/0.06),0_12px_28px_-10px_rgb(0_0_0/0.22)] dark:shadow-[0_12px_28px_-10px_rgb(0_0_0/0.6)]',
        className,
      )}
    >
      {/* Nagłówek: znak sprzedawcy i numer faktury. */}
      <span className="flex items-start justify-between">
        <span className="bg-primary/80 size-3" />
        <span className="flex flex-col items-end gap-1">
          <Bar className="w-11" tone="strong" />
          <Bar className="w-7" />
        </span>
      </span>
      {/* Sprzedawca i nabywca. */}
      <span className="grid grid-cols-2 gap-3">
        <span className="flex flex-col gap-1">
          <Bar className="w-8" />
          <Bar className="w-11" />
        </span>
        <span className="flex flex-col gap-1">
          <Bar className="w-8" />
          <Bar className="w-10" />
        </span>
      </span>
      <span className="border-foreground/10 flex flex-col gap-1.5 border-t pt-2.5">
        <Body variant={variant} />
      </span>
      <span className="border-foreground/10 flex items-center justify-between border-t pt-2.5">
        <Bar className="w-8" tone="strong" />
        <span className="bg-primary block h-1.5 w-10 rounded-full" />
      </span>
    </span>
  );
}
