import type { UseFormReturn } from 'react-hook-form';

import { DocumentSection } from '@/components/invoices/finora/invoice-document';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';

import { labelClass, PAYMENT_METHOD_ITEMS } from './constants';

/** Sekcja „Płatność”: metoda, rachunek, MPP z podpowiedzią progu. */
export function PaymentSection({
  form,
  paymentMethod,
  podpowiedzMpp,
}: {
  form: UseFormReturn<InvoiceFormValues>;
  paymentMethod: InvoiceFormValues['paymentMethod'];
  podpowiedzMpp: boolean;
}) {
  return (
    <DocumentSection title="Płatność" testId="sekcja-platnosc" description="Sposób zapłaty i rachunek">
      <div>
        <Label htmlFor="payment-method" className={labelClass}>Metoda płatności</Label>
        <Select
          value={paymentMethod}
          items={PAYMENT_METHOD_ITEMS}
          onValueChange={(v) => {
            if (v == null) return
            form.setValue(
              'paymentMethod',
              v as InvoiceFormValues['paymentMethod']
            )
          }}
        >
          <SelectTrigger id="payment-method" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAYMENT_METHOD_ITEMS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="bank-account" className={labelClass}>Numer rachunku (dla przelewu)</Label>
        <Input
          id="bank-account"
          {...form.register('bankAccount')}
          placeholder="12 3456 7890 ..."
        />
      </div>
      <div className="space-y-1.5">
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" className="accent-primary h-4 w-4" {...form.register('splitPayment')} />
          Mechanizm podzielonej płatności (MPP)
        </label>
        {podpowiedzMpp ? (
          <p className="text-muted-foreground text-xs">
            Faktura dla firmy na ponad 15 000 zł brutto. Jeśli sprzedajesz towary lub usługi z załącznika 15
            do ustawy o VAT (np. roboty budowlane, elektronika, paliwa), MPP jest obowiązkowy.
          </p>
        ) : null}
        {form.formState.errors.splitPayment ? (
          <p className="text-destructive text-xs">{form.formState.errors.splitPayment.message}</p>
        ) : null}
      </div>
    </DocumentSection>
  );
}
