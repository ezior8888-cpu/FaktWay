'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import { createRecurringInvoiceAction, updateRecurringInvoiceAction } from '@/app/actions/recurring-invoices';
import { searchRecurringTemplatesAction } from '@/app/actions/recurring-invoice-templates';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatIsoDatePl } from '@/lib/format/iso-date';
import { shortenLegalForm } from '@/lib/format/legal-form';
import { formatPlMoney } from '@/lib/format/pl';
import { dayOfMonthFromDate, previewNextRun } from '@/lib/invoices/recurring/preview';
import type { RecurringInvoiceListItem, RecurringTemplateCandidate } from '@/lib/invoices/recurring/queries';
import { RECURRING_DAY_MAX, RECURRING_DAY_MIN } from '@/lib/invoices/recurring/schedule';
import {
  RECURRING_NAME_MAX,
  recurringInvoiceSchema,
  type RecurringInvoiceFormValues,
} from '@/lib/schemas/recurring-invoice';
import {
  RECURRING_FREQUENCIES,
  RECURRING_FREQUENCY_LABELS,
  type RecurringFrequency,
} from '@/types/recurring-invoice';

/** Opóźnienie wyszukiwania po numerze — jedno zapytanie po przerwie w pisaniu. */
const SEARCH_DEBOUNCE_MS = 300;

export const NO_TEMPLATES_TEXT =
  'Nie masz jeszcze faktury, którą można ustawić jako wzór. Wzorem może być zwykła faktura VAT w złotych, wystawiona w FaktWay i przyjęta przez KSeF.';

/** Podpis kandydata w liście wyboru: numer · kontrahent · brutto · data. */
export function templateLabel(candidate: RecurringTemplateCandidate): string {
  return [
    candidate.internalNumber ?? '(bez numeru)',
    candidate.contractorName ? shortenLegalForm(candidate.contractorName) : 'bez nazwy nabywcy',
    candidate.grossTotal === null ? null : `${formatPlMoney(candidate.grossTotal)} zł`,
    formatIsoDatePl(candidate.issueDate),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Domyślna nazwa pozycji: kontrahent wzoru (skrócona forma prawna), do limitu schematu. */
export function defaultRecurringName(candidate: RecurringTemplateCandidate): string {
  const base = candidate.contractorName
    ? shortenLegalForm(candidate.contractorName)
    : `Faktura ${candidate.internalNumber ?? 'cykliczna'}`;
  return base.slice(0, RECURRING_NAME_MAX);
}

export interface RecurringInvoiceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dziś w Europe/Warsaw (RRRR-MM-DD) z serwera — podgląd „Następne wystawienie”. */
  today: string;
  /** Najnowsze faktury, które mogą być wzorem (lista startowa wyboru). */
  candidates: RecurringTemplateCandidate[];
  /** Odczyt kandydatów nie udał się — komunikat zamiast pustej listy. */
  candidatesError?: string | null;
  /** Wzór wskazany z zewnątrz (`?wzor=<id>`) — wybrany od razu. */
  initialTemplate?: RecurringTemplateCandidate | null;
  /** Edycja istniejącej pozycji; bez niej arkusz tworzy nową. */
  editing?: RecurringInvoiceListItem | null;
  /**
   * `?wzor=<id>` nie dał wzoru (faktura nie spełnia warunków albo jej nie ma) —
   * ten sam komunikat co nad tabelą, bo arkusz otwiera się na nim.
   */
  templateNotice?: string | null;
}

function emptyValues(
  today: string,
  template: RecurringTemplateCandidate | null | undefined,
): RecurringInvoiceFormValues {
  const todayDay = dayOfMonthFromDate(today) ?? RECURRING_DAY_MIN;
  return {
    templateInvoiceId: template?.id ?? '',
    name: template ? defaultRecurringName(template) : '',
    frequency: 'monthly',
    dayOfMonth: (template && dayOfMonthFromDate(template.issueDate)) || todayDay,
  };
}

/**
 * „+ Nowa faktura cykliczna” / „Edytuj” (plan Finora P6, N1) w oprawie
 * `create-recurring-invoice-sheet.tsx` Finory: Sheet z prawej, `FieldGroup`,
 * stopka z przyciskiem głównym i „Anuluj”.
 *
 * Odstępstwa od Finory (arkusz w szablonie niesie całą fakturę: klienta,
 * pozycje, rabat, VAT — 600 linii): u nas faktura cykliczna to tylko
 * wskazanie wzoru i harmonogram. Treść faktury zostaje w fakturze-wzorze
 * i w formularzu wystawiania, więc pól klienta i pozycji tu nie ma i nigdy
 * nie będzie. W zamian: wybór faktury-wzoru (lista 50 najnowszych + szukanie
 * po numerze), nazwa, częstotliwość (co miesiąc / kwartał / rok — bez
 * „weekly” i „custom”), dzień miesiąca 1–28 oraz „Następne wystawienie”
 * tylko do odczytu. Brak daty końca i licznika wystawień (Finora:
 * `endDate`, `occurrenceCount`) — v1 ich nie ma.
 *
 * Błędy akcji (odmowa wzoru, równoległa zmiana) pokazujemy w formularzu,
 * po polsku, nad polami.
 */
export function RecurringInvoiceSheet(props: RecurringInvoiceSheetProps) {
  // Finora: Select mierzy `--anchor-width` z żywego prostokąta wyzwalacza; w trakcie
  // animacji wejścia arkusza rozmiar jest pośredni i popup potrafi rozepchnąć arkusz.
  const [sheetReady, setSheetReady] = useState(false);

  // Treść arkusza (stan formularza) żyje w `SheetContent`, który Base UI odmontowuje
  // po zamknięciu — każde otwarcie startuje z czystym formularzem z props. Finora robi
  // to `reset` w efekcie na `open`; u nas bez setState w efekcie (React Compiler).
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange} onOpenChangeComplete={setSheetReady}>
      <SheetContent className='data-[side=right]:sm:max-w-2xl'>
        {/* `key`: ponowne otwarcie w trakcie animacji zamykania nie zostawia formularza innej pozycji. */}
        <RecurringInvoiceSheetBody
          key={props.editing ? `edytuj:${props.editing.id}` : `nowa:${props.initialTemplate?.id ?? ''}`}
          {...props}
          sheetReady={sheetReady}
        />
      </SheetContent>
    </Sheet>
  );
}

function RecurringInvoiceSheetBody({
  onOpenChange,
  today,
  candidates,
  candidatesError = null,
  initialTemplate = null,
  editing = null,
  templateNotice = null,
  sheetReady,
}: RecurringInvoiceSheetProps & { sheetReady: boolean }) {
  const router = useRouter();
  const isEditing = editing !== null;
  const [isPending, startTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);

  // Wybór wzoru: lista startowa albo wynik szukania; wybrany wzór zostaje na liście.
  const [selected, setSelected] = useState<RecurringTemplateCandidate | null>(initialTemplate);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RecurringTemplateCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const needle = query.trim();
  const options = needle === '' ? candidates : (searchResults ?? candidates);

  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors, dirtyFields },
  } = useForm<RecurringInvoiceFormValues>({
    resolver: zodResolver(recurringInvoiceSchema),
    defaultValues: editing
      ? {
          templateInvoiceId: editing.template_invoice_id,
          name: editing.name,
          frequency: editing.frequency,
          dayOfMonth: editing.day_of_month,
        }
      : emptyValues(today, initialTemplate),
  });

  const frequency = useWatch({ control, name: 'frequency' });
  const dayOfMonth = useWatch({ control, name: 'dayOfMonth' });

  // Szukanie starszych wzorów po fragmencie numeru (po przerwie w pisaniu).
  // Odpowiedź starsza niż ostatnia zmiana pola (`requestSeq`) przepada.
  const requestSeq = useRef(0);
  const onQueryChange = (value: string) => {
    setQuery(value);
    if (value.trim() === '') {
      requestSeq.current += 1;
      setSearching(false);
      setSearchError(null);
      setSearchResults(null);
    } else {
      setSearching(true);
    }
  };
  useEffect(() => {
    if (isEditing || needle === '') return;
    const seq = ++requestSeq.current;
    const timer = setTimeout(async () => {
      const result = await searchRecurringTemplatesAction(needle).catch(() => null);
      if (seq !== requestSeq.current) return;
      setSearching(false);
      if (!result || !result.success) {
        setSearchError(result?.error ?? 'Nie udało się wyszukać faktur. Spróbuj ponownie za chwilę.');
        return;
      }
      setSearchError(null);
      setSearchResults(result.candidates);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [needle, isEditing]);

  const items = useMemo(() => {
    const all = selected && !options.some((o) => o.id === selected.id) ? [selected, ...options] : options;
    return all.map((candidate) => ({ value: candidate.id, label: templateLabel(candidate), candidate }));
  }, [options, selected]);

  const templateId = useWatch({ control, name: 'templateInvoiceId' });

  // Data wzoru: pierwszy termin nie wypada w okresie, który wzór już pokrywa —
  // ta sama funkcja co w akcji zapisu (podgląd = zapis). Edycja liczy z
  // `editing.coveredThrough` z listy.
  const preview = previewNextRun({ today, frequency, dayOfMonth, editing, templateIssueDate: selected?.issueDate ?? null });

  const chooseTemplate = (id: string | null) => {
    const candidate = items.find((item) => item.value === id)?.candidate ?? null;
    setSelected(candidate);
    setValue('templateInvoiceId', candidate?.id ?? '', { shouldValidate: true });
    if (!candidate) return;
    // Nazwa i dzień z wzoru tylko dopóki klient ich sam nie zmienił.
    if (!dirtyFields.name) setValue('name', defaultRecurringName(candidate));
    const day = dayOfMonthFromDate(candidate.issueDate);
    if (!dirtyFields.dayOfMonth && day !== null) setValue('dayOfMonth', day);
  };

  const onSubmit = (values: RecurringInvoiceFormValues) => {
    setServerError(null);
    startTransition(async () => {
      const result = editing
        ? await updateRecurringInvoiceAction(editing.id, values)
        : await createRecurringInvoiceAction(values);
      if (!result.success) {
        setServerError(result.error);
        return;
      }
      const next = formatIsoDatePl(result.recurringInvoice.next_run_date);
      toast.success(
        isEditing
          ? `Zapisano „${result.recurringInvoice.name}”. Następne wystawienie: ${next}.`
          : `Dodano „${result.recurringInvoice.name}”. Następne wystawienie: ${next}.`,
      );
      onOpenChange(false);
      router.refresh();
    });
  };

  const formId = 'recurring-invoice-form';

  return (
    <>
      <SheetHeader>
        <SheetTitle>{isEditing ? 'Edytuj fakturę cykliczną' : 'Nowa faktura cykliczna'}</SheetTitle>
        <SheetDescription>
          Faktura nie wystawia się sama. W wybranym dniu FaktWay przypomni o wystawieniu i wypełni formularz
          danymi z faktury-wzoru — sprawdzasz je i wysyłasz do KSeF.
        </SheetDescription>
      </SheetHeader>
      <form
        id={formId}
        onSubmit={handleSubmit(onSubmit)}
        className='flex flex-1 flex-col gap-6 overflow-y-auto px-4'
        noValidate
      >
        <FieldGroup>
          {serverError ? (
            <Alert variant='destructive'>
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          ) : null}

          {!isEditing && templateNotice && !selected ? (
            <Alert>
              <AlertDescription>{templateNotice}</AlertDescription>
            </Alert>
          ) : null}

          {isEditing ? (
            <Field>
              <FieldLabel htmlFor={`${formId}-template-readonly`}>Faktura-wzór</FieldLabel>
              <FieldContent>
                <Input
                  id={`${formId}-template-readonly`}
                  readOnly
                  value={[
                    editing.templateNumber ?? '(bez numeru)',
                    editing.contractorName ? shortenLegalForm(editing.contractorName) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
                <FieldDescription>
                  Wzoru nie zmieniasz tutaj. Treść faktury poprawisz w formularzu przy wystawianiu.
                </FieldDescription>
              </FieldContent>
            </Field>
          ) : (
            <Field data-invalid={!!errors.templateInvoiceId}>
              <FieldLabel htmlFor={`${formId}-template`}>Faktura-wzór</FieldLabel>
              <FieldContent>
                <Input
                  id={`${formId}-search`}
                  type='search'
                  value={query}
                  onChange={(e) => onQueryChange(e.target.value)}
                  placeholder='Szukaj po numerze faktury'
                  aria-label='Szukaj faktury-wzoru po numerze'
                />
                <Select
                  items={items.map(({ value, label }) => ({ value, label }))}
                  value={templateId || null}
                  onValueChange={chooseTemplate}
                >
                  <SelectTrigger
                    id={`${formId}-template`}
                    className='w-full'
                    disabled={!sheetReady}
                    aria-invalid={!!errors.templateInvoiceId}
                  >
                    <SelectValue placeholder={items.length === 0 ? 'Brak faktur do wyboru' : 'Wybierz fakturę'} />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {items.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldError errors={[errors.templateInvoiceId]} />
                {candidatesError ? (
                  <FieldDescription role='status'>{candidatesError}</FieldDescription>
                ) : searchError ? (
                  <FieldDescription role='status'>{searchError}</FieldDescription>
                ) : searching ? (
                  <FieldDescription role='status'>Szukam…</FieldDescription>
                ) : items.length === 0 ? (
                  <FieldDescription role='status'>
                    {needle ? 'Żadna faktura nie pasuje do tego numeru.' : NO_TEMPLATES_TEXT}
                  </FieldDescription>
                ) : (
                  <FieldDescription>
                    Pokazujemy najnowsze faktury, które mogą być wzorem. Starszą znajdziesz po numerze.
                  </FieldDescription>
                )}
              </FieldContent>
            </Field>
          )}

          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor={`${formId}-name`}>Nazwa</FieldLabel>
            <FieldContent>
              <Input
                id={`${formId}-name`}
                maxLength={RECURRING_NAME_MAX}
                aria-invalid={!!errors.name}
                {...register('name')}
              />
              <FieldError errors={[errors.name]} />
            </FieldContent>
          </Field>

          {/* Finora: `<Separator />` + `<h6>Schedule</h6>`; u nas h3 pod tytułem arkusza (h2), żeby nie przeskakiwać poziomów. */}
          <Separator />

          <h3 className='font-medium'>Harmonogram</h3>

          <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
            <Field data-invalid={!!errors.frequency}>
              <FieldLabel htmlFor={`${formId}-frequency`}>Częstotliwość</FieldLabel>
              <FieldContent>
                <Controller
                  control={control}
                  name='frequency'
                  render={({ field }) => (
                    <Select
                      items={RECURRING_FREQUENCIES.map((value) => ({
                        value,
                        label: RECURRING_FREQUENCY_LABELS[value],
                      }))}
                      value={field.value}
                      onValueChange={(value) => field.onChange((value ?? 'monthly') as RecurringFrequency)}
                    >
                      <SelectTrigger id={`${formId}-frequency`} className='w-full' disabled={!sheetReady}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent alignItemWithTrigger={false}>
                        <SelectGroup>
                          {RECURRING_FREQUENCIES.map((value) => (
                            <SelectItem key={value} value={value}>
                              {RECURRING_FREQUENCY_LABELS[value]}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldError errors={[errors.frequency]} />
              </FieldContent>
            </Field>

            <Field data-invalid={!!errors.dayOfMonth}>
              <FieldLabel htmlFor={`${formId}-day`}>Dzień miesiąca</FieldLabel>
              <FieldContent>
                <Input
                  id={`${formId}-day`}
                  type='number'
                  inputMode='numeric'
                  min={RECURRING_DAY_MIN}
                  max={RECURRING_DAY_MAX}
                  step={1}
                  aria-invalid={!!errors.dayOfMonth}
                  {...register('dayOfMonth', { valueAsNumber: true })}
                />
                <FieldError errors={[errors.dayOfMonth]} />
              </FieldContent>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor={`${formId}-next`}>Następne wystawienie</FieldLabel>
            <FieldContent>
              <Input
                id={`${formId}-next`}
                readOnly
                value={preview ? formatIsoDatePl(preview.date) : '—'}
              />
              <FieldDescription>
                {preview
                  ? `Faktura za ${preview.periodLabel}. Dni 29–31 są niedostępne, bo nie ma ich w każdym miesiącu.`
                  : `Podaj dzień miesiąca od ${RECURRING_DAY_MIN} do ${RECURRING_DAY_MAX}.`}
              </FieldDescription>
            </FieldContent>
          </Field>
        </FieldGroup>
      </form>
      <SheetFooter className='flex-row'>
        <Button type='submit' form={formId} disabled={isPending}>
          {isPending ? <RiLoader4Line className='animate-spin' /> : null}
          {isEditing ? 'Zapisz zmiany' : 'Dodaj fakturę cykliczną'}
        </Button>
        <Button type='button' variant='outline' onClick={() => onOpenChange(false)} disabled={isPending}>
          Anuluj
        </Button>
      </SheetFooter>
    </>
  );
}
