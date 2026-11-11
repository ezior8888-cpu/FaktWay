'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { RiAddLine, RiDeleteBinLine, RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { addNoteContractorAction, saveNoteDraftAction } from '@/app/actions/noty';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { formatPlMoney } from '@/lib/format/pl';
import {
  NOTE_KIND_LABELS,
  NOTE_KINDS,
  NOTE_LIMITS,
  noteTotal,
  type NoteContractorOption,
  type NoteKind,
} from '@/lib/noty/model';
import { noteDraftSchema, parsePlAmount, type NoteDraft, type NoteDraftInput } from '@/lib/noty/schemat';
import { NOTE_VAT_WARNING } from '@/lib/noty/teksty';

export interface NoteFormProps {
  /** Firma, dla której strona wyrenderowała formularz: zapis odsyła ją akcji (UX-01). */
  tenantId: string;
  contractors: NoteContractorOption[];
  /** Dziś w Europe/Warsaw (RRRR-MM-DD) z serwera. */
  today: string;
  /** Edycja szkicu; bez niej formularz tworzy nowy szkic. */
  noteId?: string | null;
  initial?: NoteDraftInput | null;
  /** Rachunek z ostatniej noty obciążeniowej firmy (podpowiedź). */
  defaultBankAccount?: string | null;
}

const TITLE_SUGGESTIONS = ['Kara umowna', 'Zwrot kosztów', 'Odszkodowanie'];

function emptyValues(today: string, bankAccount: string | null): NoteDraftInput {
  return {
    kind: 'debit',
    contractorId: '',
    issueDate: today,
    title: '',
    items: [{ description: '', amount: '' }],
    currency: 'PLN',
    relatedDocument: '',
    dueDate: '',
    bankAccount: bankAccount ?? '',
  };
}

function contractorLabel(contractor: NoteContractorOption): string {
  return `${contractor.name} · NIP ${contractor.nip}`;
}

/** Suma na żywo z tych samych reguł co zapis (`noteTotal`); niepełne kwoty to null. */
function liveTotal(items: NoteDraftInput['items'] | undefined): number | null {
  const amounts = (items ?? []).map((item) =>
    typeof item?.amount === 'number' ? item.amount : parsePlAmount(String(item?.amount ?? '')),
  );
  if (amounts.length === 0 || amounts.some((amount) => amount === null || !Number.isFinite(amount) || amount <= 0)) {
    return null;
  }
  return noteTotal(amounts.map((amount) => ({ amount: amount as number })));
}

/**
 * Formularz noty obciążeniowej albo uznaniowej (krok 2.9, część 1).
 * Kontrahent wyłącznie z bazy kontrahentów firmy; brakującego dodaje się po
 * NIP tą samą drogą co w formularzu faktury (baza firmy albo GUS). Szkic nie
 * ma numeru: nadaje go baza przy wystawieniu na ekranie podglądu.
 */
export function NoteForm({ tenantId, contractors, today, noteId = null, initial = null, defaultBankAccount = null }: NoteFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  const [nip, setNip] = useState('');
  const [nipError, setNipError] = useState<string | null>(null);
  const [isLookingUp, startLookup] = useTransition();
  const [added, setAdded] = useState<NoteContractorOption[]>([]);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors },
  } = useForm<NoteDraftInput, unknown, NoteDraft>({
    resolver: zodResolver(noteDraftSchema),
    defaultValues: initial ?? emptyValues(today, defaultBankAccount),
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'items' });
  const kind = useWatch({ control, name: 'kind' });
  const items = useWatch({ control, name: 'items' });
  const contractorId = useWatch({ control, name: 'contractorId' });
  const total = liveTotal(items);
  // Błąd całej listy (brak pozycji, ponad limit): resolver wpisuje go w `items.root` albo w `items`.
  const itemsError = errors.items?.root?.message ?? (errors.items as { message?: string } | undefined)?.message;

  const options = useMemo(() => {
    const all = [...added.filter((a) => !contractors.some((c) => c.id === a.id)), ...contractors];
    return all.map((contractor) => ({ value: contractor.id, label: contractorLabel(contractor) }));
  }, [added, contractors]);

  const formId = 'note-form';

  const findByNip = () => {
    setNipError(null);
    startLookup(async () => {
      const result = await addNoteContractorAction(nip);
      if (!result.success) {
        setNipError(result.error);
        return;
      }
      setAdded((prev) => [result.contractor, ...prev.filter((c) => c.id !== result.contractor.id)]);
      setValue('contractorId', result.contractor.id, { shouldValidate: true });
      setNip('');
      toast.success(`Kontrahent ${result.contractor.name} jest w bazie i wybrany do noty.`);
    });
  };

  const onSubmit = (values: NoteDraft) => {
    setServerError(null);
    startTransition(async () => {
      const result = await saveNoteDraftAction(values, tenantId, noteId);
      if (!result.success) {
        setServerError(result.error);
        return;
      }
      toast.success(noteId ? 'Zapisano zmiany w szkicu noty.' : 'Zapisano szkic noty.');
      router.push(`/noty/${result.id}`);
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
              <AlertDescription>{NOTE_VAT_WARNING}</AlertDescription>
            </Alert>

            <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
              <Field data-invalid={!!errors.kind}>
                <FieldLabel htmlFor={`${formId}-kind`}>Rodzaj noty</FieldLabel>
                <FieldContent>
                  <Controller
                    control={control}
                    name='kind'
                    render={({ field }) => (
                      <Select
                        items={NOTE_KINDS.map((value) => ({ value, label: NOTE_KIND_LABELS[value] }))}
                        value={field.value}
                        onValueChange={(value) => field.onChange((value ?? 'debit') as NoteKind)}
                      >
                        <SelectTrigger id={`${formId}-kind`} className='w-full'>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent alignItemWithTrigger={false}>
                          <SelectGroup>
                            {NOTE_KINDS.map((value) => (
                              <SelectItem key={value} value={value}>
                                {NOTE_KIND_LABELS[value]}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <FieldDescription>
                    {kind === 'credit'
                      ? 'Nota uznaniowa: uznajesz kontrahenta kwotą, którą jesteś mu winien.'
                      : 'Nota obciążeniowa: obciążasz kontrahenta kwotą, którą jest Ci winien, na przykład karą umowną.'}
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

            <Field data-invalid={!!errors.title}>
              <FieldLabel htmlFor={`${formId}-title`}>Tytuł</FieldLabel>
              <FieldContent>
                <Input
                  id={`${formId}-title`}
                  list={`${formId}-titles`}
                  maxLength={NOTE_LIMITS.title}
                  placeholder='Na przykład kara umowna'
                  aria-invalid={!!errors.title}
                  {...register('title')}
                />
                <datalist id={`${formId}-titles`}>
                  {TITLE_SUGGESTIONS.map((title) => (
                    <option key={title} value={title} />
                  ))}
                </datalist>
                <FieldError errors={[errors.title]} />
              </FieldContent>
            </Field>

            <Separator />

            <h3 className='font-medium'>Pozycje</h3>
            <div className='flex flex-col gap-3'>
              {fields.map((field, index) => (
                <div key={field.id} className='grid grid-cols-1 gap-2 sm:grid-cols-[1fr_10rem_auto] sm:items-start'>
                  <Field data-invalid={!!errors.items?.[index]?.description}>
                    <FieldLabel htmlFor={`${formId}-item-${index}-description`} className='sr-only'>
                      Opis pozycji {index + 1}
                    </FieldLabel>
                    <FieldContent>
                      <Input
                        id={`${formId}-item-${index}-description`}
                        placeholder={`Opis pozycji ${index + 1}`}
                        maxLength={NOTE_LIMITS.description}
                        aria-invalid={!!errors.items?.[index]?.description}
                        {...register(`items.${index}.description`)}
                      />
                      <FieldError errors={[errors.items?.[index]?.description]} />
                    </FieldContent>
                  </Field>
                  <Field data-invalid={!!errors.items?.[index]?.amount}>
                    <FieldLabel htmlFor={`${formId}-item-${index}-amount`} className='sr-only'>
                      Kwota pozycji {index + 1} w PLN
                    </FieldLabel>
                    <FieldContent>
                      <Input
                        id={`${formId}-item-${index}-amount`}
                        inputMode='decimal'
                        placeholder='0,00'
                        className='text-right tabular-nums'
                        aria-invalid={!!errors.items?.[index]?.amount}
                        {...register(`items.${index}.amount`)}
                      />
                      <FieldError errors={[errors.items?.[index]?.amount]} />
                    </FieldContent>
                  </Field>
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon'
                    aria-label={`Usuń pozycję ${index + 1}`}
                    onClick={() => remove(index)}
                    disabled={fields.length <= 1}
                  >
                    <RiDeleteBinLine />
                  </Button>
                </div>
              ))}
              <FieldError errors={[itemsError ? { message: itemsError } : undefined]} />
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <Button
                  type='button'
                  variant='outline'
                  onClick={() => append({ description: '', amount: '' })}
                  disabled={fields.length >= NOTE_LIMITS.items}
                >
                  <RiAddLine />
                  Dodaj pozycję
                </Button>
                <p className='text-sm font-medium tabular-nums' aria-live='polite'>
                  Razem: {total === null ? 'uzupełnij kwoty pozycji' : `${formatPlMoney(total)} PLN`}
                </p>
              </div>
            </div>

            <Separator />

            <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
              <Field>
                <FieldLabel htmlFor={`${formId}-currency`}>Waluta</FieldLabel>
                <FieldContent>
                  <Input id={`${formId}-currency`} value='PLN' readOnly aria-readonly />
                  <input type='hidden' {...register('currency')} />
                  <FieldDescription>Notę można na razie wystawić tylko w złotych.</FieldDescription>
                </FieldContent>
              </Field>

              <Field data-invalid={!!errors.relatedDocument}>
                <FieldLabel htmlFor={`${formId}-related`}>Odniesienie do faktury (opcjonalnie)</FieldLabel>
                <FieldContent>
                  <Input
                    id={`${formId}-related`}
                    maxLength={NOTE_LIMITS.related}
                    placeholder='Na przykład FV/2026/11/3 z 3.11.2026'
                    aria-invalid={!!errors.relatedDocument}
                    {...register('relatedDocument')}
                  />
                  <FieldError errors={[errors.relatedDocument]} />
                </FieldContent>
              </Field>
            </div>

            {kind === 'debit' ? (
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                <Field data-invalid={!!errors.dueDate}>
                  <FieldLabel htmlFor={`${formId}-due-date`}>Termin zapłaty (opcjonalnie)</FieldLabel>
                  <FieldContent>
                    <Input id={`${formId}-due-date`} type='date' aria-invalid={!!errors.dueDate} {...register('dueDate')} />
                    <FieldError errors={[errors.dueDate]} />
                  </FieldContent>
                </Field>
                <Field data-invalid={!!errors.bankAccount}>
                  <FieldLabel htmlFor={`${formId}-bank`}>Numer rachunku (opcjonalnie)</FieldLabel>
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
            ) : null}
          </FieldGroup>

          <div className='flex flex-wrap gap-2'>
            <Button type='submit' disabled={isPending}>
              {isPending ? <RiLoader4Line className='animate-spin' /> : null}
              Zapisz szkic
            </Button>
            <Link href={noteId ? `/noty/${noteId}` : '/noty'} className={buttonVariants({ variant: 'outline' })}>
              Anuluj
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
