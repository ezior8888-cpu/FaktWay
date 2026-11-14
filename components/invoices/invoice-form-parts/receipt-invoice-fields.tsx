import type { ReactNode } from 'react';
import type { UseFormReturn } from 'react-hook-form';

import { DocumentHeaderRow } from '@/components/invoices/finora/invoice-document';
import { Input } from '@/components/ui/input';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

import type { BuyerKind } from './constants';
import { FieldErrorText, fieldErrorProps } from './field-error-text';

/**
 * Faktura do paragonu (krok 1.2 planu kompletnej aplikacji): pole wyboru na
 * końcu nagłówka dokumentu, a po zaznaczeniu pola paragonu. Decyzja D1: te same
 * komponenty co reszta nagłówka (`DocumentHeaderRow`, `Input`, pole wyboru jak
 * przy MPP), dołożone pod istniejącymi polami, bez przestawiania ich.
 *
 * Pola paragonu: art. 106h ust. 1 ustawy o VAT (numer dokumentu i numer
 * unikatowy kasy), data paragonu (zarazem data sprzedaży), dzień żądania
 * (art. 106b ust. 3) i przy firmie potwierdzenie NIP na paragonie (art. 106b
 * ust. 5). Reguły i komunikaty: `lib/invoices/receipt-invoice.ts`.
 *
 * Stan (`useWatch`) i data sprzedaży sprzed zaznaczenia FP są w formularzu,
 * ta część je pokazuje i woła jego obsługę zdarzeń.
 */
export function ReceiptInvoiceFields({
  form,
  enabled,
  buyerKind,
  onToggle,
  onReceiptDateChange,
}: {
  form: UseFormReturn<InvoiceFormValues>;
  enabled: boolean;
  buyerKind: BuyerKind;
  /** Zaznaczenie albo odznaczenie FP (formularz przywraca wtedy datę sprzedaży). */
  onToggle: (checked: boolean) => void;
  /** Data paragonu jest datą sprzedaży na fakturze do paragonu. */
  onReceiptDateChange: (value: string) => void;
}) {
  const errors = form.formState.errors;
  const error = (fieldId: string, message: string | undefined): ReactNode =>
    message ? <FieldErrorText fieldId={fieldId}>{message}</FieldErrorText> : null;
  const receiptInvoiceError = error('receipt-invoice', errors.receiptInvoice?.message);
  const nipOnReceiptError = error('buyer-nip-on-receipt', errors.buyerNipOnReceipt?.message);

  return (
    <div data-testid="pola-faktury-do-paragonu" className="space-y-3">
      <div className="space-y-1.5">
        <label className="flex items-center gap-3 text-sm">
          <input
            id="receipt-invoice"
            type="checkbox"
            {...fieldErrorProps('receipt-invoice', !!errors.receiptInvoice)}
            className="accent-primary h-4 w-4"
            {...form.register('receiptInvoice', {
              onChange: (e: { target: { checked: boolean } }) => onToggle(e.target.checked),
            })}
          />
          Faktura do paragonu
        </label>
        {receiptInvoiceError ?? (
          <p className="text-muted-foreground text-xs">
            Do sprzedaży z kasy rejestrującej. W KSeF faktura dostaje oznaczenie FP.
          </p>
        )}
      </div>
      {enabled ? (
        <>
          <DocumentHeaderRow label="Numer paragonu" htmlFor="receipt-number" error={error('receipt-number', errors.receiptNumber?.message)}>
            <Input id="receipt-number" {...fieldErrorProps('receipt-number', !!errors.receiptNumber)} {...form.register('receiptNumber')} />
          </DocumentHeaderRow>
          <DocumentHeaderRow
            label="Data paragonu"
            htmlFor="receipt-date"
            hint="To także data sprzedaży na fakturze."
            error={error('receipt-date', errors.receiptDate?.message)}
          >
            <Input
              id="receipt-date"
              type="date"
              {...fieldErrorProps('receipt-date', !!errors.receiptDate)}
              {...form.register('receiptDate', {
                onChange: (e: { target: { value: string } }) => onReceiptDateChange(e.target.value),
              })}
            />
          </DocumentHeaderRow>
          <DocumentHeaderRow
            label="Numer unikatowy kasy"
            htmlFor="cash-register-number"
            hint="Na paragonie obok logo fiskalnego, np. ABC1234567890."
            error={error('cash-register-number', errors.cashRegisterNumber?.message)}
          >
            <Input id="cash-register-number" autoCapitalize="characters" {...fieldErrorProps('cash-register-number', !!errors.cashRegisterNumber)} {...form.register('cashRegisterNumber')} />
          </DocumentHeaderRow>
          <DocumentHeaderRow
            label="Data żądania faktury"
            htmlFor="receipt-request-date"
            hint="Opcjonalnie, gdy nabywca poprosił o fakturę przed dniem wystawienia."
            error={error('receipt-request-date', errors.receiptRequestDate?.message)}
          >
            <Input id="receipt-request-date" type="date" {...fieldErrorProps('receipt-request-date', !!errors.receiptRequestDate)} {...form.register('receiptRequestDate')} />
          </DocumentHeaderRow>
          {buyerKind === 'pl' ? (
            <div className="space-y-1.5">
              <label className="flex items-center gap-3 text-sm">
                <input
                  id="buyer-nip-on-receipt"
                  type="checkbox"
                  {...fieldErrorProps('buyer-nip-on-receipt', !!errors.buyerNipOnReceipt)}
                  className="accent-primary h-4 w-4"
                  {...form.register('buyerNipOnReceipt')}
                />
                Paragon ma NIP nabywcy
              </label>
              {nipOnReceiptError ?? (
                <p className="text-muted-foreground text-xs">
                  Fakturę dla firmy wystawia się tylko do paragonu z jej NIP.
                </p>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
