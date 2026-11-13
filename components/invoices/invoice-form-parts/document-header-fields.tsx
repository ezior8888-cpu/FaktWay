import type { ReactNode } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { AlertCircle } from 'lucide-react';

import { DocumentHeaderRow } from '@/components/invoices/finora/invoice-document';
import { Input } from '@/components/ui/input';
import { dueDateFrom } from '@/lib/format/warsaw-date';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

import { errorTextClass } from './constants';

/**
 * Numer i daty w nagłówku dokumentu (obok sprzedawcy). `seriesRow` (krok 2.5):
 * wybór serii numeracji nad numerem, gdy firma ma kilka serii.
 */
export function DocumentHeaderFields({
  form,
  seriesRow = null,
}: {
  form: UseFormReturn<InvoiceFormValues>;
  seriesRow?: ReactNode;
}) {
  /**
   * Pigułki terminu: „14 dni” zamiast wybierania daty z kalendarza.
   * Liczone od daty wystawienia z formularza, nie od dzisiaj — inaczej przy
   * fakturze wystawionej wstecz termin wypadałby przed datą wystawienia,
   * a schemat to odrzuca (`paymentDueDate >= issueDate`).
   */
  const ustawTermin = (dni: number) => {
    // Dodawanie dni na samej dacie — lokalna północ zamieniona na UTC dawała
    // w Polsce termin o dzień krótszy (F-013).
    form.setValue('paymentDueDate', dueDateFrom(form.getValues('issueDate'), dni), {
      shouldValidate: true,
    });
  };

  return (
    <>
      {seriesRow}
      <DocumentHeaderRow
        label="Numer faktury"
        htmlFor="internalNumber"
        error={
          form.formState.errors.internalNumber ? (
            <p className={errorTextClass}>
              <AlertCircle className="h-3 w-3" />
              {form.formState.errors.internalNumber.message}
            </p>
          ) : null
        }
      >
        <Input
          id="internalNumber"
          placeholder="FV/2026/04/001"
          {...form.register('internalNumber')}
        />
      </DocumentHeaderRow>
      <DocumentHeaderRow label="Data wystawienia" htmlFor="issue-date">
        <Input id="issue-date" type="date" {...form.register('issueDate')} />
      </DocumentHeaderRow>
      <DocumentHeaderRow
        label="Data sprzedaży / dostawy"
        htmlFor="sale-date"
        hint="Opcjonalnie, gdy jest inna od daty wystawienia (pole P_6 w KSeF); identyczna data nie jest duplikowana w XML."
        error={
          form.formState.errors.saleDate ? (
            <p className={errorTextClass}>
              <AlertCircle className="h-3 w-3" />
              {form.formState.errors.saleDate.message}
            </p>
          ) : null
        }
      >
        <Input id="sale-date" type="date" {...form.register('saleDate')} />
      </DocumentHeaderRow>
      <DocumentHeaderRow
        label="Termin płatności"
        htmlFor="payment-due-date"
        hint={
          /* Skróty zamiast kalendarza: na telefonie wybranie daty
             z natywnego okna to cztery dotknięcia, a „14 dni” jedno.
             Liczone od daty WYSTAWIENIA, nie od dzisiaj. */
          <span className="flex flex-wrap gap-2 sm:justify-end">
            {[7, 14, 30].map((dni) => (
              <button
                key={dni}
                type="button"
                onClick={() => ustawTermin(dni)}
                className="border-border text-muted-foreground hover:text-foreground hover:bg-muted min-h-8 border px-3 text-xs transition-colors"
              >
                {dni} dni
              </button>
            ))}
          </span>
        }
      >
        <Input id="payment-due-date" type="date" {...form.register('paymentDueDate')} />
      </DocumentHeaderRow>
    </>
  );
}
