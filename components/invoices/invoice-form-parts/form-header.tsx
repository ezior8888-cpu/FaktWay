import Link from 'next/link';
import { ChevronLeft, Loader2 } from 'lucide-react';

/**
 * Nagłówek formularza na telefonie (strzałka wstecz, tytuł z podtytułem,
 * „Szkic”). Od `sm` nagłówek strony daje `InvoiceCreatePageHeading`.
 */
export function MobileFormHeader({
  recurringMode,
  busy,
  isSaving,
  onSaveDraft,
}: {
  recurringMode: boolean;
  busy: boolean;
  isSaving: boolean;
  onSaveDraft: () => void;
}) {
  // Podtytuł nagłówka na telefonie („wrzesień 2026 · KSeF”). Liczony przy
  // renderze, a nie wpisany na stałe.
  const miesiacRok = new Date().toLocaleDateString('pl-PL', {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="flex items-center gap-2 sm:hidden">
      <Link
        href="/invoices/new"
        aria-label="Wróć do wyboru rodzaju faktury"
        className="text-muted-foreground hover:bg-muted -ml-2 flex size-10 shrink-0 items-center justify-center transition-colors"
      >
        <ChevronLeft className="h-5 w-5" />
      </Link>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-xl font-semibold tracking-tight">Nowa faktura</h1>
        <p className="text-muted-foreground truncate text-sm">{miesiacRok} · KSeF</p>
      </div>
      {recurringMode ? null : (
        <button
          type="button"
          onClick={onSaveDraft}
          disabled={busy}
          className="text-primary shrink-0 px-2 py-2 text-sm font-semibold transition-opacity disabled:opacity-50"
        >
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Szkic'}
        </button>
      )}
    </div>
  );
}

/** Podpowiedź FLO „Wypełnij” z ostatniej faktury (`wypelnijZOstatniej` w formularzu). */
export function PrefillBanner({
  contractorName,
  onFill,
}: {
  contractorName: string;
  onFill: () => void;
}) {
  return (
    <div className="flex items-start gap-3 border border-[var(--ff-accent)]/25 bg-[var(--ff-accent-tint)] p-4">
      <span
        aria-hidden
        className="bg-primary text-primary-foreground flex size-8 shrink-0 items-center justify-center text-sm font-semibold"
      >
        F
      </span>
      <p className="min-w-0 flex-1 text-sm leading-relaxed">
        Mogę wypełnić to za Ciebie na podstawie ostatniej faktury dla{' '}
        <span className="font-semibold">{contractorName}</span>.{' '}
        <button
          type="button"
          onClick={onFill}
          className="font-semibold text-[var(--ff-accent)] underline-offset-4 hover:underline"
        >
          Wypełnij →
        </button>
      </p>
    </div>
  );
}
