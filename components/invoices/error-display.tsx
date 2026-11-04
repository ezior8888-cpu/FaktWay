'use client';

import { AlertCircle, ChevronRight, Lightbulb } from 'lucide-react';
import Link from 'next/link';

interface InvoiceErrorDisplayProps {
  errorMessage: string;
  errorCode?: string | null;
  errorField?: string | null;
  errorSuggestion?: string | null;
  invoiceId?: string;
  showEditLink?: boolean;
}

/**
 * Kartka błędu KSeF (przetłumaczony komunikat z DB).
 *
 * UWAGA: nie ma jeszcze `app/(dashboard)/invoices/[id]/edit` — link prowadzi
 * na szczegóły faktury z `focus` (na późniejsze scroll-to-field / pierwszą edycję).
 */
export function InvoiceErrorDisplay({
  errorMessage,
  errorCode,
  errorField,
  errorSuggestion,
  invoiceId,
  showEditLink = true,
}: InvoiceErrorDisplayProps) {
  return (
    <div className="space-y-3 border border-destructive/30 bg-destructive/5 p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center bg-destructive/10">
          <AlertCircle className="size-4 text-destructive" />
        </div>
        <div className="flex-1 space-y-1">
          <p className="text-xs font-medium uppercase tracking-wider text-destructive">
            Błąd wysyłki do KSeF
          </p>
          <p className="font-medium text-foreground">{errorMessage}</p>
          {errorCode && (
            <p className="text-xs text-muted-foreground font-mono">
              Kod techniczny: {errorCode}
            </p>
          )}
        </div>
      </div>

      {errorSuggestion && (
        <div className="flex items-start gap-3 border bg-muted/40 p-3">
          <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="flex-1 space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-primary">
              Jak naprawić
            </p>
            <p className="text-sm text-foreground leading-relaxed">{errorSuggestion}</p>
          </div>
        </div>
      )}

      {showEditLink && invoiceId && errorField && (
        <Link
          href={`/invoices/${invoiceId}?focus=${encodeURIComponent(errorField)}`}
          className="inline-flex items-center gap-2 text-sm font-medium text-foreground transition-colors hover:text-primary"
        >
          Przejdź do problematycznego pola
          <ChevronRight className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}
