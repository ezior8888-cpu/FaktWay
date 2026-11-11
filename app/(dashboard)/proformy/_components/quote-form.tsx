'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { RiAddLine, RiDeleteBinLine, RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { addQuoteContractorAction, saveQuoteDraftAction } from '@/app/actions/proformy';
import { vatSelectClass } from '@/components/invoices/invoice-form-parts/constants';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { formatPlMoney } from '@/lib/format/pl';
import {
  QUOTE_KIND_LABELS,
  QUOTE_KINDS,
  QUOTE_LIMITS,
  QUOTE_PAYMENT_METHOD_LABELS,
  QUOTE_PAYMENT_METHODS,
  QUOTE_VAT_RATE_LABELS,
  QUOTE_VAT_RATES,
  quoteItems,
  quoteTotals,
  type QuoteContractorOption,
  type QuoteKind,
  type QuotePaymentMethod,
  type QuoteTotals,
  type QuoteVatRate,
} from '@/lib/proformy/model';
import { quoteDraftSchema, type QuoteDraft, type QuoteDraftInput } from '@/lib/proformy/schemat';
import { quoteNotInvoiceNotice } from '@/lib/proformy/teksty';

export interface QuoteFormProps {
  /** Firma, dla której strona wyrenderowała formularz: zapis odsyła ją akcji (UX-01). */
  tenantId: string;
  contractors: QuoteContractorOption[];
  /** Dziś w Europe/Warsaw (RRRR-MM-DD) z serwera. */
  today: string;
  /** Edycja szkicu; bez niej formularz tworzy nowy szkic. */
  quoteId?: string | null;
  initial?: QuoteDraftInput | null;
  /** Rachunek z ostatniej proformy albo z ustawień firmy (podpowiedź). */
  defaultBankAccount?: string | null;
  /** Firma zwolniona z VAT: nowe pozycje dostają „zw”, jak w formularzu faktury. */
  vatExempt?: boolean;
}

type ItemInput = QuoteDraftInput['items'][number];

function newItem(vatExempt: boolean): ItemInput {
  return { name: '', unit: 'szt', quantity: 1, unitPriceNet: 0, vatRate: vatExempt ? 'zw' : '23' };
}

function emptyValues(today: string, bankAccount: string | null, vatExempt: boolean): QuoteDraftInput {
  return {
    kind: 'proforma',
    contractorId: '',
    issueDate: today,
    validUntil: '',
    items: [newItem(vatExempt)],
    currency: 'PLN',
    paymentMethod: 'transfer',
    paymentDueDate: '',
    bankAccount: bankAccount ?? '',
    notes: '',
  };
}

function contractorLabel(contractor: QuoteContractorOption): string {
  return `${contractor.name} · NIP ${contractor.nip}`;
}

/** Kwoty na żywo z tych samych funkcji co zapis (`quoteItems`, `quoteTotals`); niepełne pozycje to null. */
function liveTotals(items: QuoteDraftInput['items'] | undefined): QuoteTotals | null {
  const rows = items ?? [];
  if (rows.length === 0) return null;
  const parsed = rows.map((item) => ({
    name: String(item?.name ?? ''),
    unit: String(item?.unit ?? ''),
    quantity: Number(item?.quantity),
    unitPriceNet: Number(item?.unitPriceNet),
    vatRate: (item?.vatRate ?? '23') as QuoteVatRate,
  }));
  if (parsed.some((item) => !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.unitPriceNet) || item.unitPriceNet < 0)) {
    return null;
  }
  return quoteTotals(quoteItems(parsed));
}

function lineGross(item: ItemInput | undefined): number | null {
  const quantity = Number(item?.quantity);
  const unitPriceNet = Number(item?.unitPriceNet);
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPriceNet)) return null;
  const [line] = quoteItems([{ name: '', unit: '', quantity, unitPriceNet, vatRate: (item?.vatRate ?? '23') as QuoteVatRate }]);
  return line?.grossAmount ?? null;
}

/**
 * Formularz proformy albo oferty (krok 2.4). Kontrahent wyłącznie z bazy
 * kontrahentów firmy; brakującego dodaje się po NIP tą samą drogą co
 * w formularzu faktury (baza firmy albo GUS). Pozycje jak na fakturze: nazwa,
 * jednostka, ilość, cena netto, stawka; kwoty liczą funkcje faktury. Szkic nie
 * ma numeru: nadaje go baza przy wystawieniu na ekranie podglądu.
 */
export function QuoteForm({
  tenantId,
  contractors,
  today,
  quoteId = null,
  initial = null,
  defaultBankAccount = null,
  vatExempt = false,
}: QuoteFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [nip, setNip] = useState('');
  const [nipError, setNipError] = useState<string | null>(null);
  const [isLookingUp, startLookup] = useTransition();
  const [added, setAdded] = useState<QuoteContractorOption[]>([]);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = useForm<QuoteDraftInput, unknown, QuoteDraft>({
    resolver: zodResolver(quoteDraftSchema),
    defaultValues: initial ?? emptyValues(today, defaultBankAccount, vatExempt),
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'items' });
  const kind = useWatch({ control, name: 'kind' });
  const items = useWatch({ control, name: 'items' });
  const contractorId = useWatch({ control, name: 'contractorId' });
  const paymentMethod = useWatch({ control, name: 'paymentMethod' });
  const totals = liveTotals(items);
  // Błąd całej listy (brak pozycji, ponad limit, kwota): resolver wpisuje go w `items.root` albo w `items`.
  const itemsError = errors.items?.root?.message ?? (errors.items as { message?: string } | undefined)?.message;

  const options = useMemo(() => {
    const all = [...added.filter((a) => !contractors.some((c) => c.id === a.id)), ...contractors];
    return all.map((contractor) => ({ value: contractor.id, label: contractorLabel(contractor) }));
  }, [added, contractors]);

  const formId = 'quote-form';
  const offer = kind === 'offer';

  const findByNip = () => {
    setNipError(null);
    startLookup(async () => {
      const result = await addQuoteContractorAction(nip);
      if (!result.success) {
        setNipError(result.error);
        return;
      }
      setAdded((prev) => [result.contractor, ...prev.filter((c) => c.id !== result.contractor.id)]);
      setValue('contractorId', result.contractor.id, { shouldValidate: true });
      setNip('');
      toast.success(`Kontrahent ${result.contractor.name} jest w bazie i wybrany do dokumentu.`);
    });
  };

  const onSubmit = (values: QuoteDraft) => {
    setServerError(null);
    startTransition(async () => {
      const result = await saveQuoteDraftAction(values, tenantId, quoteId);
      if (!result.success) {
        setServerError(result.error);
        return;
      }
      toast.success(quoteId ? 'Zapisano zmiany w szkicu.' : 'Zapisano szkic.');
      router.push(`/proformy/${result.id}`);
    });
  };

  return (
    <Card className='shadow-none'>
      <CardContent>
        <form id={formId} onSubmit={handleSubmit(onSubmit)} className='flex flex-col gap-6' noValidate>
          <FieldGroup>
            {serverError ? (
              <Alert variant='destructive'>
                <AlertDescription>{serverError}</AlertDescription>
              </Alert>
            ) : null}

            <Alert>
              <AlertDescription>{quoteNotInvoiceNotice(offer ? 'offer' : 'proforma')}</AlertDescription>
            </Alert>

            <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
              <Field data-invalid={!!errors.kind}>
                <FieldLabel htmlFor={`${formId}-kind`}>Rodzaj dokumentu</FieldLabel>
                <FieldContent>
                  <Controller
                    control={control}
                    name='kind'
                    render={({ field }) => (
                      <Select
                        items={QUOTE_KINDS.map((value) => ({ value, label: QUOTE_KIND_LABELS[value] }))}
                        value={field.value}
                        onValueChange={(value) => field.onChange((value ?? 'proforma') as QuoteKind)}
                      >
                        <SelectTrigger id={`${formId}-kind`} className='w-full'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent alignItemWithTrigger={false}>
                          <SelectGroup>
                            {QUOTE_KINDS.map((value) => (
                              <SelectItem key={value} value={value}>
                                {QUOTE_KIND_LABELS[value]}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <FieldDescription>
                    {offer
                      ? 'Oferta: wycena dla kontrahenta z terminem ważności, bez wezwania do zapłaty.'
                      : 'Proforma: dokument do zapłaty z góry. Po wpłacie zamienisz ją w fakturę albo fakturę zaliczkową.'}
                  </FieldDescription>
                  <FieldError errors={[errors.kind]} />
                </FieldContent>
              </Field>

              <Field data-invalid={!!errors.issueDate}>
                <FieldLabel htmlFor={`${formId}-issue-date`}>Data wystawienia</FieldLabel>
                <FieldContent>
                  <Input id={`${formId}-issue-date`} type='date' max={today} aria-invalid={!!errors.issueDate} {...register('issueDate')} />
                  <FieldError errors={[errors.issueDate]} />
                </FieldContent>
              </Field>
            </div>

            {offer ? (
              <Field data-invalid={!!errors.validUntil} className='sm:max-w-[calc(50%-0.5rem)]'>
                <FieldLabel htmlFor={`${formId}-valid-until`}>Oferta ważna do</FieldLabel>
                <FieldContent>
                  <Input id={`${formId}-valid-until`} type='date' min={today} aria-invalid={!!errors.validUntil} {...register('validUntil')} />
                  <FieldError errors={[errors.validUntil]} />
                </FieldContent>
              </Field>
            ) : null}

            <Field data-invalid={!!errors.contractorId}>
              <FieldLabel htmlFor={`${formId}-contractor`}>Kontrahent</FieldLabel>
              <FieldContent>
                {options.length > 0 ? (
                  <Select
                    items={options}
                    value={contractorId || null}
                    onValueChange={(value) => setValue('contractorId', value ?? '', { shouldValidate: true })}
                  >
                    <SelectTrigger id={`${formId}-contractor`} className='w-full' aria-invalid={!!errors.contractorId}>
                      <SelectValue placeholder='Wybierz kontrahenta z bazy' />
                    </SelectTrigger>
                    <SelectContent alignItemWithTrigger={false}>
                      <SelectGroup>
                        {options.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : (
                  <FieldDescription role='status'>
                    Nie masz jeszcze kontrahentów w bazie. Wpisz NIP kontrahenta poniżej: dane pobierzemy z bazy GUS
                    i zapiszemy kontrahenta w bazie firmy.
                  </FieldDescription>
                )}
                <FieldError errors={[errors.contractorId]} />
                <div className='flex flex-col gap-2 sm:flex-row'>
                  <Input
                    aria-label='NIP kontrahenta spoza listy'
                    inputMode='numeric'
                    placeholder='NIP kontrahenta spoza listy'
                    value={nip}
                    onChange={(e) => setNip(e.target.value)}
                    className='sm:max-w-60'
                  />
                  <Button type='button' variant='outline' onClick={findByNip} disabled={isLookingUp || nip.trim() === ''}>
                    {isLookingUp ? <RiLoader4Line className='animate-spin' /> : null}
                    Dodaj po NIP
                  </Button>
                </div>
                {nipError ? <FieldDescription role='status'>{nipError}</FieldDescription> : null}
              </FieldContent>
            </Field>

            <Separator />

            <h3 className='font-medium'>Pozycje</h3>
            <div className='flex flex-col gap-3'>
              <div className='text-muted-foreground hidden gap-2 text-xs font-medium lg:grid lg:grid-cols-[minmax(8rem,1fr)_4rem_5rem_6.5rem_5.5rem_6.5rem_2.25rem]'>
                <span>Nazwa</span>
                <span>J.m.</span>
                <span>Ilość</span>
                <span>Cena netto</span>
                <span>VAT</span>
                <span className='text-right'>Brutto</span>
                <span />
              </div>
              {fields.map((field, index) => {
                const gross = lineGross(items?.[index]);
                const itemErrors = errors.items?.[index];
                return (
                  <div
                    key={field.id}
                    className='grid grid-cols-2 gap-2 rounded-md border p-3 lg:grid-cols-[minmax(8rem,1fr)_4rem_5rem_6.5rem_5.5rem_6.5rem_2.25rem] lg:items-start lg:border-0 lg:p-0'
                  >
                    <Field data-invalid={!!itemErrors?.name} className='col-span-2 lg:col-span-1'>
                      <FieldLabel htmlFor={`${formId}-item-${index}-name`} className='lg:sr-only'>
                        Nazwa pozycji {index + 1}
                      </FieldLabel>
                      <FieldContent>
                        <Input
                          id={`${formId}-item-${index}-name`}
                          maxLength={512}
                          aria-invalid={!!itemErrors?.name}
                          {...register(`items.${index}.name`)}
                        />
                        <FieldError errors={[itemErrors?.name]} />
                      </FieldContent>
                    </Field>
                    <Field data-invalid={!!itemErrors?.unit}>
                      <FieldLabel htmlFor={`${formId}-item-${index}-unit`} className='lg:sr-only'>
                        Jednostka pozycji {index + 1}
                      </FieldLabel>
                      <FieldContent>
                        <Input
                          id={`${formId}-item-${index}-unit`}
                          maxLength={50}
                          aria-invalid={!!itemErrors?.unit}
                          {...register(`items.${index}.unit`)}
                        />
                        <FieldError errors={[itemErrors?.unit]} />
                      </FieldContent>
                    </Field>
                    <Field data-invalid={!!itemErrors?.quantity}>
                      <FieldLabel htmlFor={`${formId}-item-${index}-quantity`} className='lg:sr-only'>
                        Ilość pozycji {index + 1}
                      </FieldLabel>
                      <FieldContent>
                        <Input
                          id={`${formId}-item-${index}-quantity`}
                          type='number'
                          step='0.0001'
                          inputMode='decimal'
                          className='text-right tabular-nums'
                          aria-invalid={!!itemErrors?.quantity}
                          {...register(`items.${index}.quantity`, { valueAsNumber: true })}
                        />
                        <FieldError errors={[itemErrors?.quantity]} />
                      </FieldContent>
                    </Field>
                    <Field data-invalid={!!itemErrors?.unitPriceNet}>
                      <FieldLabel htmlFor={`${formId}-item-${index}-price`} className='lg:sr-only'>
                        Cena netto pozycji {index + 1}
                      </FieldLabel>
                      <FieldContent>
                        <Input
                          id={`${formId}-item-${index}-price`}
                          type='number'
                          step='0.01'
                          inputMode='decimal'
                          className='text-right tabular-nums'
                          aria-invalid={!!itemErrors?.unitPriceNet}
                          {...register(`items.${index}.unitPriceNet`, { valueAsNumber: true })}
                        />
                        <FieldError errors={[itemErrors?.unitPriceNet]} />
                      </FieldContent>
                    </Field>
                    <Field data-invalid={!!itemErrors?.vatRate}>
                      <FieldLabel htmlFor={`${formId}-item-${index}-vat`} className='lg:sr-only'>
                        Stawka VAT pozycji {index + 1}
                      </FieldLabel>
                      <FieldContent>
                        <select
                          id={`${formId}-item-${index}-vat`}
                          className={vatSelectClass}
                          aria-invalid={itemErrors?.vatRate ? true : undefined}
                          {...register(`items.${index}.vatRate`)}
                        >
                          {QUOTE_VAT_RATES.map((rate) => (
                            <option key={rate} value={rate}>
                              {QUOTE_VAT_RATE_LABELS[rate]}
                            </option>
                          ))}
                        </select>
                        <FieldError errors={[itemErrors?.vatRate]} />
                      </FieldContent>
                    </Field>
                    <p className='self-center text-right text-sm font-medium tabular-nums lg:mt-1.5 lg:self-start'>
                      <span className='text-muted-foreground mr-1 lg:hidden'>Brutto</span>
                      {gross === null ? '' : `${formatPlMoney(gross)} zł`}
                    </p>
                    <Button
                      type='button'
                      variant='ghost'
                      size='icon'
                      className='justify-self-end'
                      aria-label={`Usuń pozycję ${index + 1}`}
                      onClick={() => remove(index)}
                      disabled={fields.length <= 1}
                    >
                      <RiDeleteBinLine />
                    </Button>
                  </div>
                );
              })}
              <FieldError errors={[itemsError ? { message: itemsError } : undefined]} />
              <div className='flex flex-wrap items-start justify-between gap-2'>
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => append(newItem(vatExempt))}
                  disabled={fields.length >= QUOTE_LIMITS.items}
                >
                  <RiAddLine />
                  Dodaj pozycję
                </Button>
                <dl className='flex min-w-56 flex-col gap-1 text-sm tabular-nums' aria-live='polite'>
                  {totals === null ? (
                    <div className='text-muted-foreground'>Uzupełnij ilość i cenę pozycji, żeby zobaczyć sumy.</div>
                  ) : (
                    <>
                      <div className='flex justify-between gap-4'>
                        <dt className='text-muted-foreground'>Razem netto</dt>
                        <dd>{formatPlMoney(totals.netTotal)} PLN</dd>
                      </div>
                      <div className='flex justify-between gap-4'>
                        <dt className='text-muted-foreground'>Razem VAT</dt>
                        <dd>{formatPlMoney(totals.vatTotal)} PLN</dd>
                      </div>
                      <div className='flex justify-between gap-4 font-medium'>
                        <dt>Razem brutto</dt>
                        <dd>{formatPlMoney(totals.grossTotal)} PLN</dd>
                      </div>
                    </>
                  )}
                </dl>
              </div>
            </div>

            <Separator />

            {offer ? null : (
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-3'>
                <Field data-invalid={!!errors.paymentMethod}>
                  <FieldLabel htmlFor={`${formId}-payment-method`}>Sposób zapłaty</FieldLabel>
                  <FieldContent>
                    <Controller
                      control={control}
                      name='paymentMethod'
                      render={({ field }) => (
                        <Select
                          items={QUOTE_PAYMENT_METHODS.map((value) => ({ value, label: QUOTE_PAYMENT_METHOD_LABELS[value] }))}
                          value={field.value ?? 'transfer'}
                          onValueChange={(value) => field.onChange((value ?? 'transfer') as QuotePaymentMethod)}
                        >
                          <SelectTrigger id={`${formId}-payment-method`} className='w-full'>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent alignItemWithTrigger={false}>
                            <SelectGroup>
                              {QUOTE_PAYMENT_METHODS.map((value) => (
                                <SelectItem key={value} value={value}>
                                  {QUOTE_PAYMENT_METHOD_LABELS[value]}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      )}
                    />
                    <FieldError errors={[errors.paymentMethod]} />
                  </FieldContent>
                </Field>
                <Field data-invalid={!!errors.paymentDueDate}>
                  <FieldLabel htmlFor={`${formId}-due-date`}>Termin zapłaty (opcjonalnie)</FieldLabel>
                  <FieldContent>
                    <Input id={`${formId}-due-date`} type='date' aria-invalid={!!errors.paymentDueDate} {...register('paymentDueDate')} />
                    <FieldError errors={[errors.paymentDueDate]} />
                  </FieldContent>
                </Field>
                <Field data-invalid={!!errors.bankAccount}>
                  <FieldLabel htmlFor={`${formId}-bank`}>
                    Numer rachunku{paymentMethod === 'transfer' ? '' : ' (opcjonalnie)'}
                  </FieldLabel>
                  <FieldContent>
                    <Input
                      id={`${formId}-bank`}
                      inputMode='numeric'
                      placeholder='26 cyfr rachunku'
                      aria-invalid={!!errors.bankAccount}
                      {...register('bankAccount')}
                    />
                    <FieldError errors={[errors.bankAccount]} />
                  </FieldContent>
                </Field>
              </div>
            )}

            <div className='grid grid-cols-1 gap-4 sm:grid-cols-[1fr_12rem]'>
              <Field data-invalid={!!errors.notes}>
                <FieldLabel htmlFor={`${formId}-notes`}>Uwagi (opcjonalnie)</FieldLabel>
                <FieldContent>
                  <Textarea
                    id={`${formId}-notes`}
                    rows={3}
                    maxLength={QUOTE_LIMITS.notes}
                    placeholder={offer ? 'Na przykład termin realizacji albo warunki dostawy' : 'Na przykład: realizacja po wpłacie'}
                    aria-invalid={!!errors.notes}
                    {...register('notes')}
                  />
                  <FieldError errors={[errors.notes]} />
                </FieldContent>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${formId}-currency`}>Waluta</FieldLabel>
                <FieldContent>
                  <Input id={`${formId}-currency`} value='PLN' readOnly aria-readonly />
                  <input type='hidden' {...register('currency')} />
                  <FieldDescription>Na razie tylko w złotych.</FieldDescription>
                </FieldContent>
              </Field>
            </div>
          </FieldGroup>

          <div className='flex flex-wrap gap-2'>
            <Button type='submit' disabled={isPending}>
              {isPending ? <RiLoader4Line className='animate-spin' /> : null}
              Zapisz szkic
            </Button>
            <Link href={quoteId ? `/proformy/${quoteId}` : '/proformy'} className={buttonVariants({ variant: 'outline' })}>
              Anuluj
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
