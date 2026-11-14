import type { ChangeEvent } from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { AlertCircle } from 'lucide-react';

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
import { VatStatusBadge } from '@/components/validation/vat-status-badge';
import { addressCountryForKodUE, parseVatUe } from '@/lib/invoices/vat-ue';
import type { InvoiceFormValues } from '@/lib/schemas/invoice-form';
import { cn } from '@/lib/utils';
import type { CachedValidationResult } from '@/lib/validation/cache';

import { BuyerLookup } from '../buyer-lookup';
import { buildVatUeHint } from './calculations';
import {
  BUYER_ID_TYPE_ITEMS,
  BUYER_KINDS,
  EU_COUNTRY_ITEMS,
  errorTextClass,
  labelClass,
  type BuyerKind,
} from './constants';
import { FieldErrorText, fieldErrorProps } from './field-error-text';

/**
 * Sekcja „Nabywca” (Finora: „Invoice To:”): rodzaj nabywcy (AUD-70), pola
 * identyfikatora danego rodzaju, nazwa, adres i e-mail. Wartości z
 * `useWatch` i stan białej listy trzyma formularz — ta sekcja je pokazuje
 * i zmienia.
 */
export function BuyerSection({
  form,
  buyerKind,
  buyerNipWatch,
  buyerConsumerIdType,
  buyerVatUeWatch,
  buyerCountryCode,
  buyerVatStatus,
  setBuyerVatStatus,
  wyslanoRaz,
}: {
  form: UseFormReturn<InvoiceFormValues>;
  buyerKind: BuyerKind;
  buyerNipWatch: string | undefined;
  buyerConsumerIdType: InvoiceFormValues['buyerConsumerIdType'];
  buyerVatUeWatch: string;
  buyerCountryCode: string;
  buyerVatStatus: CachedValidationResult | null;
  setBuyerVatStatus: (status: CachedValidationResult | null) => void;
  /** Po pierwszej próbie zapisu (`formState.isSubmitted`) — zmiany sprawdzają formularz od nowa. */
  wyslanoRaz: boolean;
}) {
  const vatUeHint = buildVatUeHint(buyerVatUeWatch);

  const handleBuyerSelected = (data: {
    nip: string;
    name: string;
    addressLine1: string;
    addressLine2: string;
  }) => {
    form.setValue('buyerNip', data.nip);
    form.setValue('buyerName', data.name);
    form.setValue('buyerAddressLine1', data.addressLine1);
    form.setValue('buyerAddressLine2', data.addressLine2);
  };

  /**
   * Zmiana rodzaju nabywcy czyści identyfikatory pozostałych dwóch rodzajów
   * (NIP, PESEL/dokument, VAT-UE i kraj) — inaczej zostałyby w danych faktury.
   * Nazwa, adres i e-mail zostają: to częsta poprawka „pomyliłem rodzaj”.
   */
  const zmienRodzajNabywcy = (kind: BuyerKind) => {
    const opts = { shouldDirty: true } as const;
    setBuyerVatStatus(null);
    form.setValue('buyerIsConsumer', kind === 'consumer', opts);
    form.setValue('buyerIsEu', kind === 'eu', opts);
    if (kind !== 'pl') form.setValue('buyerNip', '', opts);
    if (kind === 'consumer') {
      form.setValue('buyerConsumerIdType', 'pesel', opts);
    } else {
      form.setValue('buyerConsumerIdType', undefined, opts);
      form.setValue('buyerPesel', '', opts);
      form.setValue('buyerIdDocument', '', opts);
    }
    if (kind !== 'eu') {
      form.setValue('buyerVatUe', '', opts);
      form.setValue('buyerCountryCode', '', opts);
    }
    // Błędy poprzedniego rodzaju znikają od razu. Po pierwszej próbie zapisu
    // sprawdzamy całość jeszcze raz — np. pozycja „np. II” staje się poprawna,
    // gdy nabywcą zostaje firma z UE.
    form.clearErrors([
      'buyerNip',
      'buyerIsEu',
      'buyerVatUe',
      'buyerCountryCode',
      'buyerConsumerIdType',
      'buyerPesel',
      'buyerIdDocument',
    ]);
    if (wyslanoRaz) void form.trigger();
  };

  /**
   * Kraj adresu podpowiadamy z prefiksu numeru VAT-UE (Grecja: `EL` → `GR`),
   * ale tylko gdy prefiks się zmienił — kraju wybranego ręcznie nie
   * nadpisujemy przy poprawianiu cyfr numeru.
   */
  const onVatUeChange = (previous: string, next: string) => {
    const before = parseVatUe(previous)?.kodUE;
    const after = parseVatUe(next)?.kodUE;
    if (after && after !== 'PL' && after !== before) {
      form.setValue('buyerCountryCode', addressCountryForKodUE(after), {
        shouldDirty: true,
        shouldValidate: wyslanoRaz,
      });
    }
  };

  return (
    <DocumentSection
      title="Nabywca"
      testId="sekcja-nabywca"
      description={
        buyerKind === 'consumer'
          ? 'Dane osoby fizycznej (bez NIP podatnika)'
          : buyerKind === 'eu'
            ? 'Firma z innego kraju UE — identyfikuje ją numer VAT-UE'
            : 'Wyszukaj po NIP w bazie GUS lub wprowadź ręcznie'
      }
    >
      {/* Rodzaj nabywcy — trzy wykluczające się opcje (AUD-70). Natywne
          pola radio: grupa z klawiatury (strzałki) i czytnik ekranu bez
          dodatkowej biblioteki; kółko zostaje widoczne, bo klika w nie e2e. */}
      <fieldset {...fieldErrorProps('buyer-kind', !!form.formState.errors.buyerIsEu)}>
        <legend className={cn(labelClass, 'text-muted-foreground')}>Rodzaj nabywcy</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1">
          {BUYER_KINDS.map((opcja) => {
            const wybrana = buyerKind === opcja.kind;
            return (
              <label
                key={opcja.kind}
                htmlFor={opcja.id}
                className={cn(
                  'flex cursor-pointer items-start gap-3 border p-3 transition-colors has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
                  wybrana
                    ? 'border-primary/40 bg-primary/5 dark:bg-primary/10'
                    : 'border-border hover:bg-muted/50',
                )}
              >
                <input
                  type="radio"
                  id={opcja.id}
                  name="buyerKind"
                  value={opcja.kind}
                  checked={wybrana}
                  onChange={() => zmienRodzajNabywcy(opcja.kind)}
                  className="accent-primary mt-0.5 size-4 shrink-0"
                />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="block text-sm font-medium leading-none">{opcja.label}</span>
                  <span className="text-muted-foreground block text-xs">{opcja.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        {form.formState.errors.buyerIsEu ? (
          <FieldErrorText fieldId="buyer-kind">
            {form.formState.errors.buyerIsEu.message}
          </FieldErrorText>
        ) : null}
      </fieldset>
      {buyerKind === 'eu' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <div>
            <Label htmlFor="buyer-vat-ue" className={labelClass}>
              Numer VAT-UE nabywcy
            </Label>
            <Input
              id="buyer-vat-ue"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="DE123456789"
              className="uppercase"
              aria-invalid={form.formState.errors.buyerVatUe ? true : undefined}
              aria-describedby="buyer-vat-ue-hint"
              {...form.register('buyerVatUe', {
                onChange: (e: ChangeEvent<HTMLInputElement>) =>
                  onVatUeChange(buyerVatUeWatch, e.target.value),
              })}
            />
            {form.formState.errors.buyerVatUe ? (
              <p id="buyer-vat-ue-hint" role="alert" className={errorTextClass}>
                <AlertCircle aria-hidden="true" className="h-3 w-3" />
                {form.formState.errors.buyerVatUe.message}
              </p>
            ) : (
              <p
                id="buyer-vat-ue-hint"
                aria-live="polite"
                className={cn(
                  'mt-1.5 text-xs',
                  vatUeHint.tone === 'warn'
                    ? 'text-amber-700 dark:text-amber-400'
                    : vatUeHint.tone === 'ok'
                      ? 'text-foreground'
                      : 'text-muted-foreground',
                )}
              >
                {vatUeHint.text}
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="buyer-country" className={labelClass}>
              Kraj nabywcy
            </Label>
            <Select
              value={buyerCountryCode}
              items={EU_COUNTRY_ITEMS}
              onValueChange={(v) => {
                if (v == null) return
                form.setValue('buyerCountryCode', v, {
                  shouldDirty: true,
                  shouldValidate: wyslanoRaz,
                })
              }}
            >
              <SelectTrigger
                id="buyer-country"
                className="w-full"
                {...fieldErrorProps('buyer-country', !!form.formState.errors.buyerCountryCode)}
              >
                <SelectValue placeholder="Wybierz kraj UE" />
              </SelectTrigger>
              <SelectContent>
                {EU_COUNTRY_ITEMS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {form.formState.errors.buyerCountryCode ? (
              <FieldErrorText fieldId="buyer-country">
                {form.formState.errors.buyerCountryCode.message}
              </FieldErrorText>
            ) : (
              <p className="text-muted-foreground mt-1.5 text-xs">
                Ustawiamy go z prefiksu numeru — zmień, jeśli adres jest w innym kraju UE.
              </p>
            )}
          </div>
        </div>
      ) : null}
      {buyerKind === 'pl' ? (
        <div className="space-y-2">
          <Label htmlFor="buyer-nip" className={labelClass}>NIP nabywcy</Label>
          <BuyerLookup
            inputId="buyer-nip"
            nip={buyerNipWatch ?? ''}
            onNipChange={(digits) => {
              form.setValue('buyerNip', digits, { shouldDirty: true });
              if (digits.length === 10) void form.trigger('buyerNip');
            }}
            onSelected={handleBuyerSelected}
            nipError={form.formState.errors.buyerNip?.message}
            onValidationComplete={(result) => {
              setBuyerVatStatus(result);
              if (
                result?.legalName &&
                !form.getValues('buyerName')?.trim()
              ) {
                form.setValue('buyerName', result.legalName, {
                  shouldDirty: true,
                });
              }
            }}
          />
          {buyerVatStatus ? (
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <VatStatusBadge
                status={buyerVatStatus.vatStatus}
                source={buyerVatStatus.source}
                fromCache={buyerVatStatus.fromCache}
                warning={buyerVatStatus.warning ?? null}
                size="sm"
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {buyerKind === 'consumer' ? (
        <div className="space-y-2">
          <Label htmlFor="buyer-id-type" className={labelClass}>Typ identyfikatora</Label>
          <Select
            value={buyerConsumerIdType ?? 'pesel'}
            items={BUYER_ID_TYPE_ITEMS}
            onValueChange={(v) => {
              if (v == null) return
              form.setValue(
                'buyerConsumerIdType',
                v as InvoiceFormValues['buyerConsumerIdType'],
                { shouldDirty: true },
              );
              form.setValue('buyerPesel', '', { shouldDirty: true });
              form.setValue('buyerIdDocument', '', { shouldDirty: true });
              void form.trigger(['buyerConsumerIdType', 'buyerPesel', 'buyerIdDocument']);
            }}
          >
            <SelectTrigger
              id="buyer-id-type"
              className="w-full"
              {...fieldErrorProps('buyer-id-type', !!form.formState.errors.buyerConsumerIdType)}
            >
              <SelectValue placeholder="Wybierz typ" />
            </SelectTrigger>
            <SelectContent>
              {BUYER_ID_TYPE_ITEMS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {form.formState.errors.buyerConsumerIdType ? (
            <FieldErrorText fieldId="buyer-id-type">
              {form.formState.errors.buyerConsumerIdType.message}
            </FieldErrorText>
          ) : null}
        </div>
      ) : null}
      {buyerKind === 'consumer' && buyerConsumerIdType === 'pesel' ? (
        <div>
          <Label htmlFor="buyer-pesel" className={labelClass}>PESEL</Label>
          <Input
            id="buyer-pesel"
            inputMode="numeric"
            autoComplete="off"
            placeholder="11 cyfr"
            {...fieldErrorProps('buyer-pesel', !!form.formState.errors.buyerPesel)}
            {...form.register('buyerPesel')}
          />
          {form.formState.errors.buyerPesel ? (
            <FieldErrorText fieldId="buyer-pesel">
              {form.formState.errors.buyerPesel.message}
            </FieldErrorText>
          ) : null}
        </div>
      ) : null}
      {buyerKind === 'consumer' &&
      (buyerConsumerIdType === 'id_card' || buyerConsumerIdType === 'passport') ? (
        <div>
          <Label htmlFor="buyer-id-document" className={labelClass}>Numer dokumentu</Label>
          <Input
            id="buyer-id-document"
            autoComplete="off"
            placeholder={
              buyerConsumerIdType === 'id_card' ? 'Seria i numer dowodu' : 'Numer paszportu'
            }
            {...fieldErrorProps('buyer-id-document', !!form.formState.errors.buyerIdDocument)}
            {...form.register('buyerIdDocument')}
          />
          {form.formState.errors.buyerIdDocument ? (
            <FieldErrorText fieldId="buyer-id-document">
              {form.formState.errors.buyerIdDocument.message}
            </FieldErrorText>
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-1">
        <div className="sm:col-span-2 xl:col-span-1">
          <Label htmlFor="buyer-name" className={labelClass}>Nazwa firmy</Label>
          <Input id="buyer-name" {...form.register('buyerName')} />
        </div>
        <div>
          <Label htmlFor="buyer-address-1" className={labelClass}>Adres (linia 1)</Label>
          <Input id="buyer-address-1" {...form.register('buyerAddressLine1')} />
        </div>
        <div>
          <Label htmlFor="buyer-address-2" className={labelClass}>Adres (linia 2)</Label>
          <Input id="buyer-address-2" {...form.register('buyerAddressLine2')} />
        </div>
        <div className="sm:col-span-2 xl:col-span-1">
          <Label htmlFor="buyer-email" className={labelClass}>Email (opcjonalnie)</Label>
          <Input
            id="buyer-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            {...form.register('buyerEmail')}
          />
        </div>
      </div>
    </DocumentSection>
  );
}
