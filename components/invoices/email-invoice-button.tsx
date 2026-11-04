'use client';

import { useEffect, useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { RiAttachment2, RiLoader4Line, RiSendPlaneLine } from '@remixicon/react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { emailInvoiceAction } from './actions-detail';

/**
 * Pole „Do” — ta sama reguła co po stronie serwera (`emailInvoiceAction`
 * sprawdza adres jeszcze raz; tu tylko podpowiedź przed wysyłką).
 */
export const sendInvoiceSchema = z.object({
  to: z
    .string()
    .trim()
    .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Podaj poprawny adres e-mail.'),
});

export type SendInvoiceFormValues = z.infer<typeof sendInvoiceSchema>;

/**
 * „Wyślij e-mailem” (Faza 33 Krok 8) w oprawie Finory: przycisk główny karty
 * akcji otwiera arkusz `send-invoice-sheet.tsx` (Sheet z prawej, `sm:max-w-md`,
 * formularz w `FieldGroup`, plakietka „Invoice Attached”, stopka Wyślij /
 * Anuluj).
 *
 * Odstępstwo od Finory: arkusz ma tylko pole „Do”. Finora pozwala zmienić
 * nadawcę, temat i treść, a nasza akcja wysyła stały szablon z domeny FaktWay
 * (nadawca, temat i treść są po stronie serwera) — pola, które niczego nie
 * zmieniają, byłyby nieprawdą. Adres podpowiadamy z danych nabywcy na fakturze.
 */
export function EmailInvoiceButton({
  invoiceId,
  defaultEmail = null,
  className,
}: {
  invoiceId: string;
  /** Adres nabywcy z dokumentu (Finora: `to: invoice.email`). */
  defaultEmail?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [isPending, start] = useTransition();
  const form = useForm<SendInvoiceFormValues>({
    resolver: zodResolver(sendInvoiceSchema),
    defaultValues: { to: defaultEmail ?? '' },
  });

  // Jak Finora: każde otwarcie zaczyna od adresu z dokumentu.
  useEffect(() => {
    if (open) form.reset({ to: defaultEmail ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultEmail]);

  const onSubmit = (values: SendInvoiceFormValues) => {
    start(async () => {
      const result = await emailInvoiceAction(invoiceId, values.to);
      if (result.success) {
        toast.success('Faktura wysłana.');
        setOpen(false);
      } else {
        toast.error(result.error);
      }
    });
  };

  const formId = `send-invoice-form-${invoiceId}`;

  return (
    <>
      <Button className={className} onClick={() => setOpen(true)}>
        <RiSendPlaneLine />
        Wyślij e-mailem
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Wyślij e-mailem</SheetTitle>
          </SheetHeader>
          <form
            id={formId}
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-1 flex-col overflow-y-auto px-4"
            noValidate
          >
            <FieldGroup>
              <Field data-invalid={!!form.formState.errors.to}>
                <FieldLabel htmlFor={`${formId}-to`}>Do</FieldLabel>
                <FieldContent>
                  <Input
                    id={`${formId}-to`}
                    type="email"
                    autoComplete="email"
                    placeholder="e-mail nabywcy"
                    aria-invalid={!!form.formState.errors.to}
                    {...form.register('to')}
                  />
                  <FieldError errors={[form.formState.errors.to]} />
                  <FieldDescription>
                    Wyślemy wiadomość FaktWay z fakturą w PDF. Treść i temat są stałe.
                  </FieldDescription>
                </FieldContent>
              </Field>

              <Badge variant="secondary" className="w-fit gap-1.5">
                <RiAttachment2 className="size-3.5" />
                Faktura w załączniku (PDF)
              </Badge>
            </FieldGroup>
          </form>
          <SheetFooter className="flex-row">
            <Button type="submit" form={formId} disabled={isPending}>
              {isPending ? <RiLoader4Line className="animate-spin" /> : null}
              Wyślij
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              Anuluj
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
