'use client';

import { useRouter } from 'next/navigation';
import type { Resolver } from 'react-hook-form';
import { useEffect, useMemo, useTransition } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { z } from 'zod';

import { BuyerLookup } from '@/components/invoices/buyer-lookup';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { InvoiceCreateActions } from '@/components/invoices/finora/invoice-create-actions';
import {
  DocumentColumns,
  DocumentHeaderRow,
  DocumentSection,
  DocumentSummary,
  DocumentSummaryRow,
  InvoiceCreateGrid,
  InvoiceCreatePageHeading,
  InvoiceDocumentCard,
  InvoiceDocumentHeader,
} from '@/components/invoices/finora/invoice-document';
import {
  advanceInvoiceSchema,
  type AdvanceInvoiceSchemaIn,
} from '@/lib/validators/invoice-validators';
import { calculateAdvanceTotals } from '@/lib/invoices/calculator';
import { formatPlMoney } from '@/lib/format/pl';
import { dueDateFrom, todayInWarsaw } from '@/lib/format/warsaw-date';
import type { BuyerB2B, SellerData } from '@/types/invoice-types';

import { saveAdvanceAction, saveAndSendAdvanceAction } from './advance-actions';

type AdvanceFormIn = z.input<typeof advanceInvoiceSchema>;

/** P5: etykieta i błąd pola w stylu Finory (`FieldLabel` / `FieldError`). */
const labelClass = 'mb-2';
const errorClass = 'text-destructive mt-1 text-xs';

const emptyBuyer: BuyerB2B = {
  type: 'b2b',
  idType: 'nip',
  nip: '',
  name: '',
  address: { addressLine1: '', addressLine2: '', countryCode: 'PL' },
};

export interface AdvanceInvoiceFormProps {
  initialSeller: SellerData;
  /** Firma, dla której wyrenderowano formularz i sprzedawcę — zapis odsyła ją jako `expectedTenantId` (UX-01). */
  tenantId: string;
}

// E1: jedno źródło etykiet dla `items` i <SelectItem> (Base UI pokazuje surową wartość bez `items`)
const VAT_RATE_ITEMS = (['23', '8', '5', '0'] as const).map((x) => ({ value: x, label: `${x}%` }))

// E1: jedno źródło etykiet dla `items` i <SelectItem> (Base UI pokazuje surową wartość bez `items`)
const PAYMENT_METHOD_ITEMS = [
  { value: 'transfer', label: 'Przelew' },
  { value: 'cash', label: 'Gotówka' },
  { value: 'card', label: 'Karta' },
  { value: 'compensation', label: 'Kompensata' },
  { value: 'other', label: 'Inna' },
] as const

export function AdvanceInvoiceForm({ initialSeller, tenantId }: AdvanceInvoiceFormProps) {
  const router = useRouter();
  const [saving, startSave] = useTransition();
  const [sending, startSend] = useTransition();

  // Daty w czasie polskim, nie UTC (F-013, A1) — wysyłka przyjmuje tylko
  // dzisiejszą datę w Polsce. useMemo([]) — liczone raz przy mount.
  const { today, due } = useMemo(() => {
    const todayPl = todayInWarsaw();
    return { today: todayPl, due: dueDateFrom(todayPl, 14) };
  }, []);

  const defaults = {
    invoiceType: 'advance',
    internalNumber: '',
    issueDate: today,
    paymentMethod: 'transfer',
    paymentDueDate: due,
    bankAccount: '',
    notes: '',
    seller: initialSeller as AdvanceFormIn['seller'],
    buyer: emptyBuyer as AdvanceFormIn['buyer'],
    advanceAmount: 100,
    totalContractAmount: 1000,
    expectedDeliveryDate: undefined,
    vatRate: '23',
    description: 'Zaliczka na poczet przyszłej realizacji.',
  } satisfies Omit<AdvanceFormIn, 'splitPayment'>;

  const form = useForm<AdvanceFormIn, unknown, AdvanceInvoiceSchemaIn>({
    resolver: zodResolver(advanceInvoiceSchema) as Resolver<
      AdvanceFormIn,
      unknown,
      AdvanceInvoiceSchemaIn
    >,
    defaultValues: defaults,
  });

  useEffect(() => {
    form.setValue('seller', initialSeller as AdvanceFormIn['seller']);
  }, [form, initialSeller]);

  const totalContract =
    Number(useWatch({ control: form.control, name: 'totalContractAmount' })) || 0;
  const advanceAmt = Number(useWatch({ control: form.control, name: 'advanceAmount' })) || 0;
  const vatWatch = useWatch({ control: form.control, name: 'vatRate' }) ?? '23';
  const paymentMethodWatch = useWatch({ control: form.control, name: 'paymentMethod' });
  const splitPaymentWatch = useWatch({ control: form.control, name: 'splitPayment' });

  const preview = calculateAdvanceTotals({
    advanceAmount: advanceAmt,
    totalContractAmount: totalContract,
    vatRate: vatWatch as AdvanceInvoiceSchemaIn['vatRate'],
  });

  function currentBuyer(): BuyerB2B {
    const raw = form.getValues('buyer');
    if (raw?.type !== 'b2b') return { ...emptyBuyer };
    const b = raw as BuyerB2B;
    return {
      ...emptyBuyer,
      ...b,
      address: {
        ...emptyBuyer.address,
        ...b.address,
        countryCode: b.address?.countryCode || 'PL',
      },
    };
  }

  function patchBuyer(patch: Partial<BuyerB2B>) {
    const cur = currentBuyer();
    const next: BuyerB2B = {
      ...cur,
      ...patch,
      address: {
        ...cur.address,
        ...(patch.address ?? {}),
        countryCode: patch.address?.countryCode ?? cur.address.countryCode ?? 'PL',
      },
    };
    form.setValue('buyer', next as AdvanceFormIn['buyer'], {
      shouldValidate: true,
      shouldDirty: true,
    });
  }

  const nipDisplay = currentBuyer().nip.replace(/\D/g, '');

  const onSave = form.handleSubmit(
    (data) =>
      startSave(async () => {
        const r = await saveAdvanceAction(data, tenantId);
        if (r.success) {
          toast.success('Zapisano szkic zaliczki');
          router.push(`/invoices/${r.invoiceId}`);
        } else toast.error(r.error);
      }),
    () => toast.error('Popraw błędy formularza'),
  );

  const onSend = form.handleSubmit(
    (data) =>
      startSend(async () => {
        const r = await saveAndSendAdvanceAction(data, tenantId);
        if (r.success) {
          toast.success('Zaliczka w kolejce KSeF');
          router.push(`/invoices/${r.invoiceId}`);
        } else toast.error(r.error);
      }),
    () => toast.error('Popraw błędy formularza'),
  );

  const busy = saving || sending;

  return (
    <form className="space-y-6 pb-32 lg:pb-10" onSubmit={(e) => e.preventDefault()}>
      <InvoiceCreatePageHeading
        title="Faktura zaliczkowa"
        description={
          <>
            Dokument FA(3) z <span className="font-mono text-xs">RodzajFaktury=ZAL</span>
          </>
        }
      />

      <InvoiceCreateGrid>
        <InvoiceDocumentCard
          header={
            <InvoiceDocumentHeader seller={initialSeller}>
              <DocumentHeaderRow
                label="Numer"
                htmlFor="internalNumber"
                error={
                  form.formState.errors.internalNumber ? (
                    <p className={errorClass}>{form.formState.errors.internalNumber.message}</p>
                  ) : null
                }
              >
                <Input id="internalNumber" {...form.register('internalNumber')} />
              </DocumentHeaderRow>
              <DocumentHeaderRow label="Data wystawienia" htmlFor="issue-date">
                <Input id="issue-date" type="date" {...form.register('issueDate')} />
              </DocumentHeaderRow>
              <DocumentHeaderRow
                label="Termin płatności"
                htmlFor="payment-due-date"
                error={
                  form.formState.errors.paymentDueDate ? (
                    <p className={errorClass}>{form.formState.errors.paymentDueDate.message}</p>
                  ) : null
                }
              >
                <Input id="payment-due-date" type="date" {...form.register('paymentDueDate')} />
              </DocumentHeaderRow>
            </InvoiceDocumentHeader>
          }
        >
          <DocumentColumns>
            <DocumentSection
              title="Nabywca (B2B)"
              testId="sekcja-nabywca"
              description="Wyszukaj kontrahenta po NIP lub uzupełnij pola ręcznie"
            >
              <BuyerLookup
                nip={nipDisplay}
                onNipChange={(d) => patchBuyer({ nip: d })}
                onSelected={(data) =>
                  patchBuyer({
                    nip: data.nip,
                    name: data.name,
                    address: {
                      ...currentBuyer().address,
                      addressLine1: data.addressLine1,
                      addressLine2: data.addressLine2,
                      countryCode: 'PL',
                    },
                  })
                }
              />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
                <div className="sm:col-span-2 xl:col-span-1">
                  <Label htmlFor="advance-buyer-name" className={labelClass}>Nazwa podmiotu</Label>
                  <Input
                    id="advance-buyer-name"
                    value={currentBuyer().name}
                    onChange={(e) => patchBuyer({ name: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="advance-buyer-address-1" className={labelClass}>Adres — linia 1</Label>
                  <Input
                    id="advance-buyer-address-1"
                    value={currentBuyer().address.addressLine1}
                    onChange={(e) =>
                      patchBuyer({
                        address: { ...currentBuyer().address, addressLine1: e.target.value },
                      })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="advance-buyer-address-2" className={labelClass}>Adres — linia 2</Label>
                  <Input
                    id="advance-buyer-address-2"
                    value={currentBuyer().address.addressLine2}
                    onChange={(e) =>
                      patchBuyer({
                        address: { ...currentBuyer().address, addressLine2: e.target.value },
                      })
                    }
                  />
                </div>
              </div>
              {form.formState.errors.buyer?.message ? (
                <p className={errorClass}>{String(form.formState.errors.buyer.message)}</p>
              ) : null}
            </DocumentSection>

            <DocumentSection title="Płatność" testId="sekcja-platnosc" description="Sposób zapłaty i rachunek">
              <div>
                <Label htmlFor="advance-payment-method" className={labelClass}>Metoda</Label>
                <Select
                  value={paymentMethodWatch}
                  items={PAYMENT_METHOD_ITEMS}
                  onValueChange={(v) => {
                    if (v == null) return
                    form.setValue('paymentMethod', v as AdvanceFormIn['paymentMethod'])
                  }}
                >
                  <SelectTrigger id="advance-payment-method" className="w-full">
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
                <Label htmlFor="advance-bank-account" className={labelClass}>Numer rachunku (26 cyfr, opcja)</Label>
                <Input id="advance-bank-account" {...form.register('bankAccount')} />
                {form.formState.errors.bankAccount ? (
                  <p className={errorClass}>{String(form.formState.errors.bankAccount.message)}</p>
                ) : null}
              </div>
              <fieldset className="space-y-2">
                <legend className={labelClass}>Czy do tej zaliczki stosuje się mechanizm podzielonej płatności (MPP)?</legend>
                <div className="flex flex-wrap gap-5 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="advance-split-payment"
                      className="accent-primary"
                      checked={splitPaymentWatch === true}
                      onChange={() => form.setValue('splitPayment', true, { shouldValidate: true, shouldDirty: true })}
                    />
                    Tak, MPP
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="advance-split-payment"
                      className="accent-primary"
                      checked={splitPaymentWatch === false}
                      onChange={() => form.setValue('splitPayment', false, { shouldValidate: true, shouldDirty: true })}
                    />
                    Nie dotyczy
                  </label>
                </div>
                <p className="text-muted-foreground text-xs">Wybierz świadomie dla tej transakcji; sama kwota zaliczki nie rozstrzyga o MPP.</p>
                {form.formState.errors.splitPayment ? (
                  <p className={errorClass}>{form.formState.errors.splitPayment.message}</p>
                ) : null}
              </fieldset>
            </DocumentSection>
          </DocumentColumns>

          <Separator />

          {/* ZALICZKA — w miejscu pozycji Finory: wartość umowy, kwota, stawka, opis. */}
          <DocumentSection title="Zaliczka" testId="sekcja-zaliczka" description="Wartość umowy, kwota zaliczki i jej stawka VAT">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="total-contract-amount" className={labelClass}>
                  Wartość umowy (brutto)
                </Label>
                <Input
                  id="total-contract-amount"
                  type="number"
                  step="0.01"
                  className="text-right tabular-nums"
                  {...form.register('totalContractAmount', { valueAsNumber: true })}
                />
                <p className="text-muted-foreground mt-1.5 text-xs">Łączna wartość kontraktu / dostaw</p>
              </div>
              <div>
                <Label htmlFor="advance-amount" className={labelClass}>
                  Kwota zaliczki (brutto)
                </Label>
                <Input
                  id="advance-amount"
                  type="number"
                  step="0.01"
                  className="text-right tabular-nums"
                  {...form.register('advanceAmount', { valueAsNumber: true })}
                />
                <p className="text-muted-foreground mt-1.5 text-xs">
                  Wartość umowy po tej zaliczce (bez wcześniejszych zaliczek):{' '}
                  <strong className="text-foreground tabular-nums">{formatPlMoney(preview.remainingAmount)} zł</strong>
                </p>
                {form.formState.errors.advanceAmount ? (
                  <p className={errorClass}>{form.formState.errors.advanceAmount.message}</p>
                ) : null}
              </div>
              <div>
                <Label htmlFor="advance-vat-rate" className={labelClass}>Stawka VAT zaliczki</Label>
                <Select
                  value={vatWatch}
                  items={VAT_RATE_ITEMS}
                  onValueChange={(v) => {
                    if (v == null) return
                    form.setValue('vatRate', v as AdvanceInvoiceSchemaIn['vatRate'], {
                      shouldDirty: true,
                    })
                  }}
                >
                  <SelectTrigger id="advance-vat-rate" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VAT_RATE_ITEMS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="expected-delivery-date" className={labelClass}>
                  Planowana data realizacji
                </Label>
                <Input id="expected-delivery-date" type="date" {...form.register('expectedDeliveryDate')} />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="advance-description" className={labelClass}>
                  Opis
                </Label>
                <Textarea id="advance-description" rows={2} {...form.register('description')} />
                {form.formState.errors.description ? (
                  <p className={errorClass}>{form.formState.errors.description.message}</p>
                ) : null}
              </div>
            </div>
          </DocumentSection>

          <Separator />

          {/* Podsumowanie po prawej (Finora: Subtotal / Tax / Total) — z tej samej
              funkcji `calculateAdvanceTotals`, której używa generator XML ZAL. */}
          <DocumentSummary label="Podsumowanie zaliczki">
            <DocumentSummaryRow label="Zaliczka netto" value={`${formatPlMoney(preview.advanceNet)} zł`} />
            <DocumentSummaryRow label={`VAT ${vatWatch}%`} value={`${formatPlMoney(preview.advanceVat)} zł`} />
            <Separator className="my-2" />
            <DocumentSummaryRow strong label="Do zapłaty" value={`${formatPlMoney(preview.advanceGross)} zł`} />
          </DocumentSummary>

          <Separator />

          <div>
            <Label htmlFor="advance-notes" className={labelClass}>
              Uwagi
            </Label>
            <Textarea id="advance-notes" rows={2} {...form.register('notes')} />
          </div>
        </InvoiceDocumentCard>

        <InvoiceCreateActions
          onSend={onSend}
          onSave={onSave}
          sending={sending}
          saving={saving}
          disabled={busy}
          sendLabel="Wystaw i wyślij zaliczkę do KSeF"
        />
      </InvoiceCreateGrid>

      {/* Telefon i tablet: pasek przyklejony do dołu; od `lg` akcje są w prawej kolumnie. */}
      <div className="ff-sticky-actions pointer-events-none lg:hidden">
        <div className="mx-auto flex max-w-7xl justify-end gap-3 pointer-events-auto">
          <Button type="button" variant="outline" disabled={busy} size="lg" onClick={onSave}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Zapisz szkic
          </Button>
          <Button type="button" size="lg" disabled={busy} onClick={onSend}>
            {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Wyślij zaliczkę do KSeF
          </Button>
        </div>
      </div>
    </form>
  );
}
