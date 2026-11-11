'use client';

import { useMemo, useState, useTransition, type ComponentProps } from 'react';
import { useRouter } from 'next/navigation';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { issueCashDocumentAction } from '@/app/actions/kasa';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CashInvoiceOption, CashPaymentOption } from '@/lib/kasa/baza';
import { CASH_LIMITS, CASH_PARTY_LABELS, cashKindTitle, dayPl, formatCashMoney, type CashKind, type CashParty } from '@/lib/kasa/model';
import {
  cashDocumentSchema,
  type CashDocumentField,
  type CashDocumentFields,
  type CashSource,
  type IssueCashDocumentResult,
} from '@/lib/kasa/schemat';
import { CASH_ISSUE_FAILED, alreadyIssuedToast, issuedToast } from '@/lib/kasa/teksty';

const TOUCH_TARGET = 'max-lg:min-h-[44px] max-lg:min-w-[44px]';

const safeIssue = (input: Parameters<typeof issueCashDocumentAction>[0], tenantId: string): Promise<IssueCashDocumentResult> =>
  issueCashDocumentAction(input, tenantId).catch(() => ({ success: false, error: CASH_ISSUE_FAILED }));

const SOURCE_LABELS: Record<CashSource, string> = {
  invoice: 'Zapłata faktury',
  payment: 'Wpłata zapisana przy fakturze',
  none: 'Inna wpłata',
};

/** Kwota do pola: „1234,50” (polski przecinek, bez separatora tysięcy). */
function amountText(value: number): string {
  return value.toFixed(2).replace('.', ',');
}

type Values = Omit<CashDocumentFields, 'kind'>;

function emptyValues(today: string, source: CashSource): Values {
  return {
    source,
    invoiceId: '',
    paymentId: '',
    operationDate: today,
    amount: '',
    title: '',
    counterpartyName: '',
    counterpartyNip: '',
    counterpartyAddressLine1: '',
    counterpartyAddressLine2: '',
    relatedDocument: '',
  };
}

function partyValues(party: CashParty | null): Pick<Values, 'counterpartyName' | 'counterpartyNip' | 'counterpartyAddressLine1' | 'counterpartyAddressLine2'> {
  return {
    counterpartyName: party?.name ?? '',
    counterpartyNip: party?.nip ?? '',
    counterpartyAddressLine1: party?.addressLine1 ?? '',
    counterpartyAddressLine2: party?.addressLine2 ?? '',
  };
}

export interface CashDocumentFormProps {
  /** Firma, dla której strona wyrenderowała formularz: zapis odsyła ją akcji (UX-01). */
  tenantId: string;
  kind: CashKind;
  /** Dziś w Europe/Warsaw (RRRR-MM-DD) z serwera. */
  today: string;
  /** Dzień rozpoczęcia kasy: dolna granica daty operacji. */
  openingDate: string;
  /** Stan kasy dziś (podpowiedź przy wypłacie; ostatnie słowo ma baza). */
  balanceToday: number | null;
  invoices: CashInvoiceOption[];
  payments: CashPaymentOption[];
  /** Faktura wybrana z adresu (`?faktura=`), gdy jest na liście. */
  initialInvoiceId?: string | null;
}

/**
 * Formularz dowodu KP albo KW (krok 3.7). KP przyjmuje gotówkę: za fakturę
 * sprzedaży (wpłata zapisze się przy fakturze razem z dowodem), do wpłaty
 * zapisanej wcześniej („Zapisz wpłatę” przy fakturze) albo bez faktury. KW
 * wydaje gotówkę. Numer nadaje baza przy wystawieniu; klucz idempotencji
 * powstaje przy otwarciu formularza, więc ponowienie po błędzie sieci
 * wystawia dowód raz.
 */
export function CashDocumentForm({
  tenantId,
  kind,
  today,
  openingDate,
  balanceToday,
  invoices,
  payments,
  initialInvoiceId = null,
}: CashDocumentFormProps) {
  const router = useRouter();
  const [key] = useState(() => crypto.randomUUID());
  const initialInvoice = invoices.find((invoice) => invoice.id === initialInvoiceId) ?? null;
  const [values, setValues] = useState<Values>(() => {
    if (kind === 'KP' && initialInvoice) {
      return {
        ...emptyValues(today, 'invoice'),
        invoiceId: initialInvoice.id,
        amount: amountText(initialInvoice.remaining),
        title: `Zapłata za fakturę ${initialInvoice.number}`,
        ...partyValues(initialInvoice.buyer),
      };
    }
    return emptyValues(today, kind === 'KP' && invoices.length > 0 ? 'invoice' : 'none');
  });
  const [errors, setErrors] = useState<Partial<Record<CashDocumentField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formId = `kasa-${kind.toLowerCase()}`;
  const fromPayment = kind === 'KP' && values.source === 'payment';

  const invoiceOptions = useMemo(
    () => invoices.map((invoice) => ({
      value: invoice.id,
      label: `${invoice.number}${invoice.buyer ? ` · ${invoice.buyer.name}` : ''} · pozostało ${formatCashMoney(invoice.remaining)}`,
    })),
    [invoices],
  );
  const paymentOptions = useMemo(
    () => payments.map((payment) => ({
      value: payment.paymentId,
      label: `${payment.invoiceNumber} · ${formatCashMoney(payment.amount)} z ${dayPl(payment.paidOn)}${payment.buyer ? ` · ${payment.buyer.name}` : ''}`,
    })),
    [payments],
  );

  const set = <K extends keyof Values>(field: K, value: Values[K]) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!(field in current)) return current;
      const rest = { ...current };
      delete rest[field as CashDocumentField];
      return rest;
    });
  };

  const chooseSource = (source: CashSource) => {
    setErrors({});
    setValues((current) => ({ ...current, source, invoiceId: '', paymentId: '' }));
  };

  const chooseInvoice = (id: string) => {
    const invoice = invoices.find((option) => option.id === id);
    setErrors({});
    setValues((current) => ({
      ...current,
      invoiceId: id,
      ...(invoice
        ? { amount: amountText(invoice.remaining), title: `Zapłata za fakturę ${invoice.number}`, ...partyValues(invoice.buyer) }
        : {}),
    }));
  };

  const choosePayment = (id: string) => {
    const payment = payments.find((option) => option.paymentId === id);
    setErrors({});
    setValues((current) => ({
      ...current,
      paymentId: id,
      ...(payment
        ? {
            amount: amountText(payment.amount),
            operationDate: payment.paidOn,
            title: `Zapłata za fakturę ${payment.invoiceNumber}`,
            ...partyValues(payment.buyer),
          }
        : {}),
    }));
  };

  const submit = () => {
    setFormError(null);
    const input = { ...values, kind };
    const parsed = cashDocumentSchema({ today, openingDate }).safeParse(input);
    if (!parsed.success) {
      const next: Partial<Record<CashDocumentField, string>> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === 'string') next[field as CashDocumentField] ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    startTransition(async () => {
      const result = await safeIssue({ ...parsed.data, idempotencyKey: key }, tenantId);
      if (!result.success) {
        // Ten sam klucz zostaje: ponowienie po błędzie sieci to ten sam dowód.
        if (result.field && result.field !== 'kind') setErrors({ [result.field]: result.error });
        else setFormError(result.error);
        return;
      }
      toast.success(
        result.status === 'already_issued' ? alreadyIssuedToast(result.number) : issuedToast(result.number, result.paymentRecorded, result.invoiceNumber),
      );
      router.push(`/kasa/${result.documentId}`);
    });
  };

  const fieldId = (field: CashDocumentField) => `${formId}-${field}`;
  const errorId = (field: CashDocumentField) => (errors[field] ? `${formId}-${field}-blad` : undefined);
  const errorText = (field: CashDocumentField) =>
    errors[field] ? (
      <p id={`${formId}-${field}-blad`} role='alert' className='text-destructive text-xs'>
        {errors[field]}
      </p>
    ) : null;
  const input = (field: Exclude<keyof Values, 'source' | 'invoiceId' | 'paymentId'>, extra: ComponentProps<typeof Input> = {}) => (
    <Input
      id={fieldId(field)}
      name={field}
      value={values[field]}
      disabled={pending || extra.readOnly === true}
      onChange={(event) => set(field, event.target.value)}
      aria-invalid={errors[field] ? true : undefined}
      aria-describedby={errorId(field)}
      className={TOUCH_TARGET}
      {...extra}
    />
  );

  return (
    <Card className='shadow-none'>
      <CardContent>
        <form
          id={formId}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className='flex flex-col gap-6'
        >
          <FieldGroup>
            {formError ? (
              <Alert variant='destructive'>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}

            {kind === 'KP' ? (
              <Field>
                <FieldLabel id={`${formId}-zrodlo`}>Za co jest wpłata</FieldLabel>
                <RadioGroup
                  aria-labelledby={`${formId}-zrodlo`}
                  value={values.source}
                  disabled={pending}
                  onValueChange={(value) => chooseSource(value as CashSource)}
                  className='sm:flex sm:flex-wrap sm:gap-6'
                >
                  {(['invoice', 'payment', 'none'] as const).map((source) => (
                    <label key={source} className='flex min-h-[44px] items-center gap-2 text-sm lg:min-h-0'>
                      <RadioGroupItem value={source} />
                      {SOURCE_LABELS[source]}
                    </label>
                  ))}
                </RadioGroup>
                <FieldDescription>
                  {values.source === 'invoice'
                    ? 'Wpłata zapisze się przy fakturze razem z dowodem, a faktura będzie opłacona w całości albo w części.'
                    : values.source === 'payment'
                      ? 'Wpłatę zapisano już przy fakturze („Zapisz wpłatę”). KP ją potwierdzi, bez drugiej wpłaty.'
                      : 'Gotówka bez faktury w FaktWay, np. wpłata własna albo zaliczka. Numer dokumentu możesz wpisać w polu „Dotyczy”.'}
                </FieldDescription>
                {errorText('source')}
              </Field>
            ) : null}

            {kind === 'KP' && values.source === 'invoice' ? (
              <Field>
                <FieldLabel htmlFor={fieldId('invoiceId')}>Faktura</FieldLabel>
                {invoiceOptions.length > 0 ? (
                  <Select
                    items={invoiceOptions}
                    value={values.invoiceId || null}
                    disabled={pending}
                    onValueChange={(value) => chooseInvoice(typeof value === 'string' ? value : '')}
                  >
                    <SelectTrigger id={fieldId('invoiceId')} className={`w-full ${TOUCH_TARGET}`} aria-describedby={errorId('invoiceId')}>
                      <SelectValue placeholder='Wybierz fakturę sprzedaży' />
                    </SelectTrigger>
                    <SelectContent className='p-1' alignItemWithTrigger={false}>
                      <SelectGroup>
                        {invoiceOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : (
                  <FieldDescription role='status'>
                    Nie ma faktur sprzedaży przyjętych w KSeF z kwotą do zapłaty. Wybierz „Inna wpłata” i wpisz numer faktury w polu „Dotyczy”.
                  </FieldDescription>
                )}
                {errorText('invoiceId')}
              </Field>
            ) : null}

            {kind === 'KP' && values.source === 'payment' ? (
              <Field>
                <FieldLabel htmlFor={fieldId('paymentId')}>Wpłata przy fakturze</FieldLabel>
                {paymentOptions.length > 0 ? (
                  <Select
                    items={paymentOptions}
                    value={values.paymentId || null}
                    disabled={pending}
                    onValueChange={(value) => choosePayment(typeof value === 'string' ? value : '')}
                  >
                    <SelectTrigger id={fieldId('paymentId')} className={`w-full ${TOUCH_TARGET}`} aria-describedby={errorId('paymentId')}>
                      <SelectValue placeholder='Wybierz wpłatę' />
                    </SelectTrigger>
                    <SelectContent className='p-1' alignItemWithTrigger={false}>
                      <SelectGroup>
                        {paymentOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                ) : (
                  <FieldDescription role='status'>
                    Nie ma wpłat wpisanych przy fakturach bez dowodu KP. Wybierz „Zapłata faktury”: wpłata zapisze się razem z dowodem.
                  </FieldDescription>
                )}
                {errorText('paymentId')}
              </Field>
            ) : null}

            <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
              <Field>
                <FieldLabel htmlFor={fieldId('operationDate')}>Data operacji</FieldLabel>
                {input('operationDate', { type: 'date', max: today, min: openingDate, readOnly: fromPayment })}
                <FieldDescription>
                  {fromPayment ? 'Dzień wpłaty zapisanej przy fakturze.' : 'Dzień, w którym gotówka przeszła z ręki do ręki. Data wystawienia to dziś.'}
                </FieldDescription>
                {errorText('operationDate')}
              </Field>
              <Field>
                <FieldLabel htmlFor={fieldId('amount')}>Kwota (zł)</FieldLabel>
                {input('amount', { inputMode: 'decimal', autoComplete: 'off', placeholder: 'np. 300,00', readOnly: fromPayment })}
                {kind === 'KW' && balanceToday !== null ? (
                  <FieldDescription>W kasie dziś: {formatCashMoney(balanceToday)}. Stan kasy nie może zejść poniżej zera.</FieldDescription>
                ) : null}
                {errorText('amount')}
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor={fieldId('title')}>Tytułem</FieldLabel>
              {input('title', {
                maxLength: CASH_LIMITS.title,
                placeholder: kind === 'KP' ? 'np. Zapłata za fakturę FV/1/2026' : 'np. Zakup materiałów biurowych',
              })}
              {errorText('title')}
            </Field>

            <Field>
              <FieldLabel htmlFor={fieldId('counterpartyName')}>{CASH_PARTY_LABELS[kind]}: nazwa firmy albo imię i nazwisko</FieldLabel>
              {input('counterpartyName', { maxLength: CASH_LIMITS.partyName, autoComplete: 'off' })}
              {errorText('counterpartyName')}
            </Field>
            <div className='grid grid-cols-1 gap-4 sm:grid-cols-3'>
              <Field>
                <FieldLabel htmlFor={fieldId('counterpartyNip')}>NIP (jeśli jest)</FieldLabel>
                {input('counterpartyNip', { maxLength: CASH_LIMITS.partyNip, inputMode: 'numeric', autoComplete: 'off' })}
                {errorText('counterpartyNip')}
              </Field>
              <Field>
                <FieldLabel htmlFor={fieldId('counterpartyAddressLine1')}>Ulica i numer</FieldLabel>
                {input('counterpartyAddressLine1', { maxLength: CASH_LIMITS.partyAddress })}
                {errorText('counterpartyAddressLine1')}
              </Field>
              <Field>
                <FieldLabel htmlFor={fieldId('counterpartyAddressLine2')}>Kod pocztowy i miejscowość</FieldLabel>
                {input('counterpartyAddressLine2', { maxLength: CASH_LIMITS.partyAddress })}
                {errorText('counterpartyAddressLine2')}
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor={fieldId('relatedDocument')}>Dotyczy (nieobowiązkowo)</FieldLabel>
              {input('relatedDocument', {
                maxLength: CASH_LIMITS.relatedDocument,
                placeholder: kind === 'KP' ? 'np. umowa 7/2026' : 'np. paragon nr 123 albo faktura od dostawcy',
              })}
              {errorText('relatedDocument')}
            </Field>
          </FieldGroup>

          <div className='flex flex-col gap-3 sm:flex-row sm:items-center'>
            <Button type='submit' className={TOUCH_TARGET} disabled={pending}>
              {pending ? <RiLoader4Line className='animate-spin' aria-hidden /> : null}
              Wystaw {kind}
            </Button>
            <p className='text-muted-foreground text-xs'>
              {cashKindTitle(kind)} dostanie numer z serii przy wystawieniu. Wystawionego dowodu nie zmienia się: błąd poprawia korekta.
            </p>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
