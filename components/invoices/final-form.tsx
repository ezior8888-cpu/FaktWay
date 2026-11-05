'use client';

import { useRouter } from 'next/navigation';
import type { Resolver } from 'react-hook-form';
import { useEffect, useMemo, useTransition } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { RiAddLine, RiCloseLine } from '@remixicon/react';
import { toast } from 'sonner';
import type { z } from 'zod';

import { BuyerLookup } from '@/components/invoices/buyer-lookup';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  formatIsoDatePl,
  InvoiceCreateGrid,
  InvoiceCreatePageHeading,
  InvoiceDocumentCard,
  InvoiceDocumentHeader,
} from '@/components/invoices/finora/invoice-document';
import { formatPlMoney } from '@/lib/format/pl';
import { cn } from '@/lib/utils';
import { calculateFinalInvoiceTotals } from '@/lib/invoices/calculator';
import {
  finalInvoiceSchema,
  type FinalInvoiceSchemaIn,
} from '@/lib/validators/invoice-validators';
import { dueDateFrom, todayInWarsaw } from '@/lib/format/warsaw-date';
import { calculateLineItem, roundToCents } from '@/lib/xml/invoice-calculator';
import type { BuyerB2B, InvoiceLine, SellerData } from '@/types/invoice-types';

import { saveFinalAction, saveAndSendFinalAction } from './final-actions';

type FinalFormIn = z.input<typeof finalInvoiceSchema>;

/** P5: etykieta i błąd pola w stylu Finory (`FieldLabel` / `FieldError`). */
const labelClass = 'mb-2';
const errorClass = 'text-destructive mt-1 text-xs';

/** Kolumny wiersza pozycji (Finora `invoice-line-items.tsx`): Nazwa · J.m. · Ilość · Cena netto · VAT · Brutto · usuń. */
const LINE_GRID =
  'grid grid-cols-[minmax(8rem,1fr)_3.5rem_4.5rem_6rem_5.5rem_6.5rem_2rem] gap-2';

const vatSelectClass =
  'border-input bg-background dark:bg-input/30 h-8 w-full min-w-0 rounded-none border px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 aria-invalid:border-destructive [@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:text-[16px]';

const emptyBuyer: BuyerB2B = {
  type: 'b2b',
  idType: 'nip',
  nip: '',
  name: '',
  address: { addressLine1: '', addressLine2: '', countryCode: 'PL' },
};

const defaultLine: FinalInvoiceSchemaIn['lines'][number] = {
  name: '',
  unit: 'szt',
  quantity: 1,
  unitPriceNet: 0,
  vatRate: '23',
};

export interface AdvanceOptionRow {
  id: string;
  internal_number: string | null;
  ksef_number: string | null;
  issue_date: string;
  advance_amount: number | string | null;
  gross_total: number | string | null;
}

export interface FinalInvoiceFormProps {
  initialSeller: SellerData;
  advanceInvoices: AdvanceOptionRow[];
  /** Firma, dla której wyrenderowano formularz, sprzedawcę i zaliczki — zapis odsyła ją jako `expectedTenantId` (UX-01). */
  tenantId: string;
}

// E1: jedno źródło etykiet dla `items` i <SelectItem> (Base UI pokazuje surową wartość bez `items`)
const PAYMENT_METHOD_ITEMS = [
  { value: 'transfer', label: 'Przelew' },
  { value: 'cash', label: 'Gotówka' },
  { value: 'card', label: 'Karta' },
  { value: 'compensation', label: 'Kompensata' },
  { value: 'other', label: 'Inna' },
] as const

function advanceLabel(row: AdvanceOptionRow): string {
  const num = row.internal_number?.trim() || row.ksef_number?.trim() || row.id.slice(0, 8);
  return num;
}

export function FinalInvoiceForm({ initialSeller, advanceInvoices, tenantId }: FinalInvoiceFormProps) {
  const router = useRouter();
  const [saving, startSave] = useTransition();
  const [sending, startSend] = useTransition();

  // Daty w czasie polskim, nie UTC (F-013).
  const today = todayInWarsaw();
  const due = dueDateFrom(today, 14);

  // Bez domyślnego MPP — użytkownik odpowiada świadomie (AUD-23).
  const defaults = {
    invoiceType: 'final',
    internalNumber: '',
    issueDate: today,
    paymentMethod: 'transfer',
    paymentDueDate: due,
    bankAccount: '',
    notes: '',
    seller: initialSeller as FinalFormIn['seller'],
    buyer: emptyBuyer as FinalFormIn['buyer'],
    advanceInvoiceIds: [],
    totalAdvances: 0,
    lines: [{ ...defaultLine }],
  } satisfies Omit<FinalFormIn, 'splitPayment'>;

  const form = useForm<FinalFormIn, unknown, FinalInvoiceSchemaIn>({
    resolver: zodResolver(finalInvoiceSchema) as Resolver<
      FinalFormIn,
      unknown,
      FinalInvoiceSchemaIn
    >,
    defaultValues: defaults,
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'lines',
  });

  useEffect(() => {
    form.setValue('seller', initialSeller as FinalFormIn['seller']);
  }, [form, initialSeller]);

  const advanceById = useMemo(
    () => new Map(advanceInvoices.map((r) => [r.id, r])),
    [advanceInvoices],
  );

  const selectedIds = useWatch({ control: form.control, name: 'advanceInvoiceIds' }) ?? [];
  const watchedLines =
    useWatch({ control: form.control, name: 'lines' }) ??
    ([] as FinalInvoiceSchemaIn['lines']);

  const totalAdvancesRounded = useMemo(() => {
    let sum = 0;
    const ids = selectedIds ?? [];
    for (const id of ids) {
      const row = advanceById.get(id);
      if (!row) continue;
      const raw = Number(row.advance_amount ?? row.gross_total ?? 0);
      sum += roundToCents(raw);
    }
    return sum;
  }, [selectedIds, advanceById]);

  useEffect(() => {
    form.setValue('totalAdvances', totalAdvancesRounded, {
      shouldDirty: false,
      shouldValidate: true,
    });
  }, [totalAdvancesRounded, form]);

  const normalizedLines = (watchedLines as FinalInvoiceSchemaIn['lines']).map((l) => ({
    name: l?.name ?? '',
    unit: l?.unit ?? 'szt',
    quantity: Number(l?.quantity) || 0,
    unitPriceNet: Number(l?.unitPriceNet) || 0,
    vatRate: (l?.vatRate ?? '23') as InvoiceLine['vatRate'],
    pkwiuCode: l?.pkwiuCode,
    gtuCode: l?.gtuCode,
  }));

  const finalTotals = calculateFinalInvoiceTotals(normalizedLines, totalAdvancesRounded);

  function toggleAdvance(id: string, checked: boolean) {
    const cur = form.getValues('advanceInvoiceIds') ?? [];
    const next = checked ? [...new Set([...cur, id])] : cur.filter((x) => x !== id);
    form.setValue('advanceInvoiceIds', next, { shouldDirty: true, shouldValidate: true });
  }

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
    form.setValue('buyer', next as FinalFormIn['buyer'], {
      shouldValidate: true,
      shouldDirty: true,
    });
  }

  const nipDisplay = currentBuyer().nip.replace(/\D/g, '');
  const paymentMethodWatch = useWatch({ control: form.control, name: 'paymentMethod' });
  const splitPaymentWatch = useWatch({ control: form.control, name: 'splitPayment' });

  const onSave = form.handleSubmit(
    (data) =>
      startSave(async () => {
        const r = await saveFinalAction(data, tenantId);
        if (r.success) {
          toast.success('Zapisano szkic faktury rozliczającej');
          router.push(`/invoices/${r.invoiceId}`);
        } else toast.error(r.error);
      }),
    () => toast.error('Popraw błędy formularza'),
  );

  const onSend = form.handleSubmit(
    (data) =>
      startSend(async () => {
        const r = await saveAndSendFinalAction(data, tenantId);
        if (r.success) {
          toast.success('Faktura rozliczająca w kolejce KSeF');
          router.push(`/invoices/${r.invoiceId}`);
        } else toast.error(r.error);
      }),
    () => toast.error('Popraw błędy formularza'),
  );

  const busy = saving || sending;

  return (
    <form className="space-y-6 pb-32 lg:pb-10" onSubmit={(e) => e.preventDefault()}>
      <InvoiceCreatePageHeading
        title="Faktura rozliczająca"
        description={
          <>
            Dokument FA(3){' '}
            <span className="font-mono text-xs">RodzajFaktury=ROZ</span> — rozliczenie wcześniejszych
            zaliczek
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
              description="Zwykle ten sam podmiot co na fakturach zaliczkowych"
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
                  <Label htmlFor="final-buyer-name" className={labelClass}>Nazwa podmiotu</Label>
                  <Input
                    id="final-buyer-name"
                    value={currentBuyer().name}
                    onChange={(e) => patchBuyer({ name: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="final-buyer-address-1" className={labelClass}>Adres — linia 1</Label>
                  <Input
                    id="final-buyer-address-1"
                    value={currentBuyer().address.addressLine1}
                    onChange={(e) =>
                      patchBuyer({
                        address: { ...currentBuyer().address, addressLine1: e.target.value },
                      })
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="final-buyer-address-2" className={labelClass}>Adres — linia 2</Label>
                  <Input
                    id="final-buyer-address-2"
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
                <Label htmlFor="final-payment-method" className={labelClass}>Metoda</Label>
                <Select
                  value={paymentMethodWatch}
                  items={PAYMENT_METHOD_ITEMS}
                  onValueChange={(v) => {
                    if (v == null) return
                    form.setValue('paymentMethod', v as FinalFormIn['paymentMethod'])
                  }}
                >
                  <SelectTrigger id="final-payment-method" className="w-full">
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
                <Label htmlFor="final-bank-account" className={labelClass}>Numer rachunku (26 cyfr, opcja)</Label>
                <Input id="final-bank-account" {...form.register('bankAccount')} />
                {form.formState.errors.bankAccount ? (
                  <p className={errorClass}>{String(form.formState.errors.bankAccount.message)}</p>
                ) : null}
              </div>
              <fieldset className="space-y-2">
                <legend className={labelClass}>Czy do tej faktury stosuje się mechanizm podzielonej płatności (MPP)?</legend>
                <div className="flex flex-wrap gap-5 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="final-split-payment"
                      className="accent-primary"
                      checked={splitPaymentWatch === true}
                      onChange={() => form.setValue('splitPayment', true, { shouldValidate: true, shouldDirty: true })}
                    />
                    Tak, MPP
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="final-split-payment"
                      className="accent-primary"
                      checked={splitPaymentWatch === false}
                      onChange={() => form.setValue('splitPayment', false, { shouldValidate: true, shouldDirty: true })}
                    />
                    Nie dotyczy
                  </label>
                </div>
                {form.formState.errors.splitPayment ? (
                  <p className={errorClass}>{form.formState.errors.splitPayment.message}</p>
                ) : null}
              </fieldset>
            </DocumentSection>
          </DocumentColumns>

          <Separator />

          <DocumentSection
            title="Faktury zaliczkowe do rozliczenia"
            testId="sekcja-zaliczki"
            description="Tylko zaakceptowane w KSeF zaliczki z tej firmy. Suma jest przeliczana automatycznie."
          >
            {advanceInvoices.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Brak zaliczek do wyboru. Wystaw i zaakceptuj najpierw fakturę zaliczkową.
              </p>
            ) : (
              <ul className="border-border max-h-64 divide-y overflow-y-auto border">
                {advanceInvoices.map((row) => {
                  const checked = selectedIds.includes(row.id);
                  const amt = roundToCents(Number(row.advance_amount ?? row.gross_total ?? 0));
                  return (
                    <li
                      key={row.id}
                      className="hover:bg-muted/50 flex flex-wrap items-center gap-3 px-3 py-2"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(c) => toggleAdvance(row.id, c === true)}
                        aria-label={`Zaliczka ${advanceLabel(row)}`}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={advanceLabel(row)}>
                        {advanceLabel(row)}
                      </span>
                      <span className="text-muted-foreground text-xs tabular-nums">{formatIsoDatePl(row.issue_date)}</span>
                      <span className="text-sm font-medium tabular-nums">{formatPlMoney(amt)} zł</span>
                    </li>
                  );
                })}
              </ul>
            )}
            {form.formState.errors.advanceInvoiceIds ? (
              <p className={errorClass}>
                {String(form.formState.errors.advanceInvoiceIds.message ?? '')}
              </p>
            ) : null}
          </DocumentSection>

          <Separator />

          {/* POZYCJE (Finora: `invoice-line-items.tsx`) — wiersze siatki; na wąskim
              ekranie przewijają się w bok wewnątrz karty, jak w Finorze i jak
              tabela przed P5. */}
          <DocumentSection title="Pozycje" testId="sekcja-pozycje" description="Pełna realizacja zamówienia / usługi">
            <div className="-mx-1 overflow-x-auto px-1">
              <div className="min-w-[38rem] space-y-3">
                <div className={cn(LINE_GRID, 'text-muted-foreground text-xs font-medium')}>
                  <span>Nazwa</span>
                  <span>J.m.</span>
                  <span>Ilość</span>
                  <span>Cena netto</span>
                  <span>VAT</span>
                  <span className="text-right">Brutto</span>
                  <span />
                </div>
                {fields.map((field, index) => {
                  const watched = watchedLines[index];
                  const calc = calculateLineItem({
                    quantity: Number(watched?.quantity) || 0,
                    unitPriceNet: Number(watched?.unitPriceNet) || 0,
                    vatRate: (watched?.vatRate ?? '23') as InvoiceLine['vatRate'],
                  });
                  return (
                    <div key={field.id} className={cn(LINE_GRID, 'items-start')}>
                      <Input aria-label={`Nazwa pozycji ${index + 1}`} {...form.register(`lines.${index}.name`)} />
                      <Input aria-label={`Jednostka pozycji ${index + 1}`} {...form.register(`lines.${index}.unit`)} />
                      <Input
                        type="number"
                        step="0.0001"
                        aria-label={`Ilość pozycji ${index + 1}`}
                        className="text-right tabular-nums"
                        {...form.register(`lines.${index}.quantity`, { valueAsNumber: true })}
                      />
                      <Input
                        type="number"
                        step="0.01"
                        aria-label={`Cena netto pozycji ${index + 1}`}
                        className="text-right tabular-nums"
                        {...form.register(`lines.${index}.unitPriceNet`, { valueAsNumber: true })}
                      />
                      <select
                        className={vatSelectClass}
                        aria-label={`Stawka VAT pozycji ${index + 1}`}
                        {...form.register(`lines.${index}.vatRate`)}
                      >
                        <option value="23">23%</option>
                        <option value="8">8%</option>
                        <option value="5">5%</option>
                        <option value="0">0%</option>
                        <option value="oo">oo</option>
                        <option value="np">np</option>
                      </select>
                      <span className="mt-1.5 text-right text-sm tabular-nums">
                        <span className="block font-medium">{formatPlMoney(calc.grossAmount)} zł</span>
                        <span className="text-muted-foreground block text-xs">
                          netto {formatPlMoney(calc.netAmount)} zł
                        </span>
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Usuń pozycję ${index + 1}`}
                        disabled={fields.length === 1}
                        onClick={() => remove(index)}
                        className="hover:text-destructive"
                      >
                        <RiCloseLine className="size-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
            {form.formState.errors.lines ? (
              <p className={errorClass}>Sprawdź pozycje (nazwa, ilość, ceny).</p>
            ) : null}
            <Button type="button" variant="secondary" size="sm" onClick={() => append({ ...defaultLine })}>
              <RiAddLine />
              Dodaj pozycję
            </Button>
          </DocumentSection>

          <Separator />

          {/* Podsumowanie po prawej (Finora: Subtotal / Tax / Total). */}
          <DocumentSummary label="Podsumowanie faktury rozliczającej">
            <DocumentSummaryRow label="Razem brutto pozycji" value={`${formatPlMoney(finalTotals.totalGross)} zł`} />
            <DocumentSummaryRow
              label="Suma wybranych zaliczek (brutto)"
              value={`${formatPlMoney(totalAdvancesRounded)} zł`}
            />
            <Separator className="my-2" />
            <DocumentSummaryRow
              strong
              label="Do zapłaty po odliczeniu zaliczek"
              value={`${formatPlMoney(finalTotals.amountDue)} zł`}
            />
          </DocumentSummary>

          <Separator />

          <div>
            <Label htmlFor="final-notes" className={labelClass}>
              Uwagi
            </Label>
            <Textarea id="final-notes" rows={2} {...form.register('notes')} />
          </div>
        </InvoiceDocumentCard>

        <InvoiceCreateActions
          onSend={onSend}
          onSave={onSave}
          sending={sending}
          saving={saving}
          disabled={busy}
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
            Wyślij do KSeF
          </Button>
        </div>
      </div>
    </form>
  );
}
