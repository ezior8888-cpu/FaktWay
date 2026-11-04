'use client';

import { useId, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  RiCheckboxCircleFill,
  RiCheckLine,
  RiErrorWarningLine,
  RiFileDownloadLine,
  RiLoader4Line,
} from '@remixicon/react';
import { toast } from 'sonner';

import { startExportAction } from '@/app/actions/exports';
import { monthOptions } from '@/components/expenses/finora/month-selector';
import { SegmentedControl, type SegmentedOption } from '@/components/reports/segmented-control';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { monthRange, parseExpenseMonth, shiftMonth } from '@/lib/expenses/month';
import { includeReceivedAfterFormatChange, receivedLabelForFormat } from '@/lib/exports/form-defaults';
import { SUSPENDED_EXPORT_FORMATS } from '@/lib/exports/suspended-formats';
import { cn } from '@/lib/utils';

import { friendlyStartError } from './export-fixes';
import {
  ENABLED_EXPORT_FORMATS,
  FORMAT_ICONS,
  FORMAT_PURPOSE,
  formatLabel,
  includesFor,
  SUSPENDED_FORMATS,
  suspendedFormatsInOrder,
  suspendedFormatsSummary,
  type EnabledExportFormat,
  type ExportScopeState,
} from './export-formats';
import {
  describeExportPeriod,
  formatExportRange,
  isIsoDate,
  lastClosedQuarter,
  periodRange,
  quarterOptions,
  type ExportPeriodInit,
  type ExportPeriodMode,
} from './export-period';

/**
 * Karta „Nowy plik” nad historią (poprawka Bartosza 21.10.2026:
 * przeprojektowanie Księgowości). Trzy kroki: format, okres, zakres — zakres
 * pokazuje tylko to, co naprawdę zmienia plik (KPiR zawsze bierze sprzedaż,
 * koszty i korekty, więc tam nie ma pól wyboru). Formularz w karcie, nie
 * w arkuszu: zostaje w SSR, a link „Eksport KPiR” z KPiR wypełnia go propsami.
 *
 * Kafelki formatów to port `account-card` + `export-data-dialog` z Finory:
 * ukryte radio jako `peer`, widoczny kafelek to etykieta (jak przełącznik
 * segmentowy). Formaty wyłączone nie są do wyboru — ich powody leżą w natywnym
 * `<details>`, więc każdy jest w znacznikach dokładnie raz (bez portalu).
 *
 * Na telefonie kroki są zwinięte: widać „Nowy plik / KPiR Excel · Wrzesień
 * 2026”, „Zmień” i „Wygeneruj plik” — domyślny plik jest o jedno stuknięcie.
 *
 * Bez `new Date()` w stanie początkowym: bieżący miesiąc przychodzi z serwera
 * albo z `parseExpenseMonth` (czas polski), więc SSR i hydracja się zgadzają.
 */

export interface NewExportFormProps {
  initialFormat?: EnabledExportFormat;
  initialPeriod?: ExportPeriodInit;
  /** Bieżący miesiąc RRRR-MM (Europe/Warsaw). */
  currentMonth?: string;
  /** Czy firma ma urząd skarbowy; `undefined` = nie wiadomo (nic nie blokujemy). */
  taxOfficeSet?: boolean;
}

const PERIOD_MODES: readonly SegmentedOption<ExportPeriodMode>[] = [
  { value: 'month', label: 'Miesiąc' },
  { value: 'quarter', label: 'Kwartał' },
  { value: 'custom', label: 'Inny' },
];

const STEPS_ID = 'export-steps';
const REASON_ID = 'export-reason';

function StepLegend({ step, children }: { step: number; children: string }) {
  return (
    <FieldLegend className="mb-3 flex items-center gap-2 text-sm font-medium">
      <span className="bg-muted flex size-5 items-center justify-center text-xs tabular-nums" aria-hidden>
        {step}
      </span>
      {children}
    </FieldLegend>
  );
}

export function NewExportForm({
  initialFormat = 'kpir_excel',
  initialPeriod,
  currentMonth: currentMonthProp,
  taxOfficeSet,
}: NewExportFormProps = {}) {
  const router = useRouter();
  const id = useId();
  // Raz na życie formularza: bez propsa liczymy miesiąc w czasie polskim, a nie przy każdym renderze.
  const [currentMonth] = useState(() => currentMonthProp ?? parseExpenseMonth(undefined));
  const defaultMonth = shiftMonth(currentMonth, -1);
  const initialRange = periodRange(initialPeriod ?? { mode: 'month', month: defaultMonth });

  const [format, setFormat] = useState<EnabledExportFormat>(initialFormat);
  const [periodMode, setPeriodMode] = useState<ExportPeriodMode>(initialPeriod?.mode ?? 'month');
  const [month, setMonth] = useState(initialPeriod?.mode === 'month' ? initialPeriod.month : defaultMonth);
  const [quarter, setQuarter] = useState(
    initialPeriod?.mode === 'quarter' ? initialPeriod.quarter : lastClosedQuarter(currentMonth),
  );
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [csv, setCsv] = useState<ExportScopeState['csv']>({ issued: true, received: false, corrections: true });
  const [jpkCorrections, setJpkCorrections] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [isStarting, startExport] = useTransition();

  const months = useMemo(() => monthOptions(currentMonth, month), [currentMonth, month]);
  const quarters = useMemo(() => quarterOptions(currentMonth, 8, quarter), [currentMonth, quarter]);

  const range =
    periodMode === 'month'
      ? monthRange(month)
      : periodMode === 'quarter'
        ? periodRange({ mode: 'quarter', quarter })
        : { from, to };
  const datesValid = isIsoDate(range.from) && isIsoDate(range.to) && range.from <= range.to;
  const rangeReversed = periodMode === 'custom' && isIsoDate(from) && isIsoDate(to) && to < from;
  const periodText = datesValid ? describeExportPeriod(range.from, range.to) : 'popraw daty';
  // Pole z aria-invalid wskazuje powód (poprawka Bartosza 21.10.2026: przeprojektowanie
  // Księgowości): odwrócony zakres → komunikat pod polami, puste pole → linia „Wybierz
  // obie daty.”. Inaczej czytnik mówił tylko „nieprawidłowe”, a powód był pod wyłączonym
  // przyciskiem, do którego klawiaturą się nie dojdzie.
  const rangeErrorId = `${id}-zakres-blad`;
  const rangeLineId = `${id}-zakres`;
  const dateDescribedBy = (value: string) =>
    rangeReversed ? rangeErrorId : !isIsoDate(value) ? rangeLineId : undefined;

  const reason =
    format === 'csv_universal' && !csv.issued && !csv.received
      ? 'Zaznacz faktury wystawione albo otrzymane.'
      : !datesValid
        ? 'Popraw daty okresu.'
        : format === 'jpk_fa' && taxOfficeSet === false
          ? 'Najpierw ustaw urząd skarbowy.'
          : null;

  // KPiR bez kosztów to księga z samymi przychodami (F-058) — reguła z `lib/` zostaje.
  const chooseFormat = (value: unknown) => {
    const next = ENABLED_EXPORT_FORMATS.find((candidate) => candidate === value);
    if (!next) return;
    setFormat(next);
    setCsv((current) => ({ ...current, received: includeReceivedAfterFormatChange(next, current.received) }));
    setStartError(null);
  };

  // „Inny” startuje od zakresu, który był wybrany, a nie od pustych pól.
  const chooseMode = (mode: ExportPeriodMode) => {
    if (mode === 'custom' && periodMode !== 'custom') {
      setFrom(range.from);
      setTo(range.to);
    }
    setPeriodMode(mode);
  };

  const start = () => {
    if (reason) return;
    setStartError(null);
    startExport(async () => {
      // Zerwane połączenie z akcją serwera rzuca — klient ma dostać prośbę o ponowienie, nie ekran błędu.
      const result = await startExportAction({
        format,
        periodStart: range.from,
        periodEnd: range.to,
        ...includesFor(format, { csv, jpkCorrections }),
      }).catch(() => ({ success: false as const, error: '' }));
      if (result.success) {
        toast.success('Generujemy plik');
        // Od razu: nowy wiersz „Oczekuje” w historii, dalej odświeża ją sama historia.
        router.refresh();
      } else {
        const message = friendlyStartError(result.error);
        toast.error(message);
        setStartError(message);
      }
    });
  };

  return (
    <Card className="shadow-none">
      <CardContent className="flex flex-col gap-6">
        <div className="flex items-center justify-between gap-3 sm:hidden">
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs">Nowy plik</p>
            <p className="truncate text-sm font-medium">
              {formatLabel(format)} · {periodText}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            type="button"
            aria-expanded={expanded}
            aria-controls={STEPS_ID}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? 'Gotowe' : 'Zmień'}
          </Button>
        </div>

        <div
          id={STEPS_ID}
          className={cn(
            'grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-[minmax(0,6fr)_minmax(0,3fr)_minmax(0,3fr)]',
            !expanded && 'max-sm:hidden',
          )}
        >
          <FieldSet className="min-w-0 gap-0 md:col-span-2 xl:col-span-1">
            <StepLegend step={1}>Format</StepLegend>
            <RadioGroup
              value={format}
              onValueChange={chooseFormat}
              aria-label="Format pliku"
              className="grid gap-2 sm:grid-cols-3 sm:gap-3"
            >
              {ENABLED_EXPORT_FORMATS.map((value) => {
                const Icon = FORMAT_ICONS[value];
                const itemId = `${id}-format-${value}`;
                return (
                  <div key={value} className="relative">
                    <RadioGroupItem value={value} id={itemId} className="peer sr-only absolute" />
                    <Label
                      htmlFor={itemId}
                      className="border-input hover:bg-muted/50 peer-data-checked:border-primary peer-data-checked:ring-primary/30 peer-focus-visible:ring-ring/50 relative flex h-full cursor-pointer items-center gap-3 border p-3 peer-focus-visible:ring-[3px] peer-data-checked:ring-1 sm:flex-col sm:items-start sm:p-4"
                    >
                      <span className="bg-muted flex size-9 shrink-0 items-center justify-center">
                        <Icon className="size-5" aria-hidden />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{formatLabel(value)}</span>
                        <span className="text-muted-foreground block text-xs leading-snug">{FORMAT_PURPOSE[value]}</span>
                      </span>
                      {format === value ? (
                        <RiCheckboxCircleFill
                          className="text-primary ml-auto size-4 shrink-0 sm:absolute sm:top-3 sm:right-3"
                          aria-hidden
                        />
                      ) : null}
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>
            {SUSPENDED_FORMATS.length > 0 ? (
              // Natywne <details> zamiast podpowiedzi w portalu: powody są w SSR, każdy raz.
              <details className="text-muted-foreground mt-3 text-xs">
                <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                  Wyłączone: {suspendedFormatsSummary()}.{' '}
                  <span className="hover:text-foreground underline underline-offset-4">Dlaczego?</span>
                </summary>
                <ul className="mt-2 space-y-1">
                  {suspendedFormatsInOrder().map((suspended) => (
                    <li key={suspended}>{SUSPENDED_EXPORT_FORMATS[suspended]}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </FieldSet>

          <FieldSet className="min-w-0 gap-0">
            <StepLegend step={2}>Okres</StepLegend>
            {/* Na całą szerokość kolumny, jak pole miesiąca pod nim — w wąskiej kolumnie (xl) `w-fit` wychodził poza nią. */}
            <SegmentedControl
              ariaLabel="Rodzaj okresu"
              value={periodMode}
              onValueChange={chooseMode}
              options={PERIOD_MODES}
              className="sm:w-full"
            />
            <div className="mt-3">
              {periodMode === 'month' ? (
                <Select
                  items={months}
                  value={month}
                  onValueChange={(value: string | null) => {
                    if (value) setMonth(value);
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Miesiąc eksportu">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} className="p-1">
                    <SelectGroup>
                      {months.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : periodMode === 'quarter' ? (
                <Select
                  items={quarters.map((option) => ({ label: option.label, value: option.value }))}
                  value={quarter}
                  onValueChange={(value: string | null) => {
                    if (value) setQuarter(value);
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Kwartał eksportu">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false} className="p-1">
                    <SelectGroup>
                      {quarters.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <Field className="gap-1.5">
                    <FieldLabel htmlFor={`${id}-od`}>Od</FieldLabel>
                    <Input
                      id={`${id}-od`}
                      type="date"
                      value={from}
                      aria-invalid={rangeReversed || !isIsoDate(from) || undefined}
                      aria-describedby={dateDescribedBy(from)}
                      onChange={(event) => setFrom(event.target.value)}
                    />
                  </Field>
                  <Field className="gap-1.5">
                    <FieldLabel htmlFor={`${id}-do`}>Do</FieldLabel>
                    <Input
                      id={`${id}-do`}
                      type="date"
                      value={to}
                      aria-invalid={rangeReversed || !isIsoDate(to) || undefined}
                      aria-describedby={dateDescribedBy(to)}
                      onChange={(event) => setTo(event.target.value)}
                    />
                  </Field>
                  {rangeReversed ? (
                    <p id={rangeErrorId} className="text-destructive col-span-2 text-xs">
                      Koniec okresu jest przed początkiem.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
            <p id={rangeLineId} className="text-muted-foreground mt-2 text-xs tabular-nums">
              {isIsoDate(range.from) && isIsoDate(range.to) ? formatExportRange(range.from, range.to) : 'Wybierz obie daty.'}
            </p>
          </FieldSet>

          <FieldSet className="min-w-0 gap-3">
            <StepLegend step={3}>Zakres</StepLegend>
            {format === 'kpir_excel' ? (
              <ul className="space-y-2 text-sm">
                {['Sprzedaż', receivedLabelForFormat('kpir_excel'), 'Korekty'].map((item) => (
                  <li key={item} className="flex items-center gap-2">
                    <RiCheckLine className="text-muted-foreground size-4 shrink-0" aria-hidden />
                    {item}
                  </li>
                ))}
              </ul>
            ) : format === 'jpk_fa' ? (
              <>
                <Field orientation="horizontal">
                  <Checkbox
                    id={`${id}-jpk-korekty`}
                    checked={jpkCorrections}
                    onCheckedChange={(checked) => setJpkCorrections(checked === true)}
                  />
                  <FieldLabel htmlFor={`${id}-jpk-korekty`} className="font-normal">
                    Korekty
                  </FieldLabel>
                </Field>
                <p className="text-muted-foreground text-xs">Tylko faktury wystawione.</p>
                {taxOfficeSet === false ? (
                  <div className="bg-muted flex items-center gap-3 p-3">
                    <RiErrorWarningLine className="size-5 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden />
                    <p className="flex-1 text-sm">Brak urzędu skarbowego</p>
                    <Button variant="outline" size="sm" render={<Link href="/settings/accountant" />} nativeButton={false}>
                      Ustaw
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              (
                [
                  ['issued', 'Faktury wystawione'],
                  ['received', 'Faktury otrzymane'],
                  ['corrections', 'Korekty'],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} orientation="horizontal">
                  <Checkbox
                    id={`${id}-csv-${key}`}
                    checked={csv[key]}
                    onCheckedChange={(checked) => setCsv((current) => ({ ...current, [key]: checked === true }))}
                  />
                  <FieldLabel htmlFor={`${id}-csv-${key}`} className="font-normal">
                    {label}
                  </FieldLabel>
                </Field>
              ))
            )}
          </FieldSet>
        </div>

        <div className="flex items-center justify-between gap-4 border-t pt-4 max-sm:flex-col max-sm:items-stretch">
          <p className="text-sm max-sm:hidden">
            <span className="font-medium">{formatLabel(format)}</span>
            <span className="text-muted-foreground"> · {periodText}</span>
          </p>
          <div className="flex flex-col items-end gap-1 max-sm:items-stretch">
            {startError ? (
              <p role="alert" className="text-destructive text-xs">
                {startError}
              </p>
            ) : null}
            <Button
              size="lg"
              type="button"
              onClick={start}
              disabled={!!reason || isStarting}
              aria-describedby={reason ? REASON_ID : undefined}
            >
              {isStarting ? <RiLoader4Line className="animate-spin" aria-hidden /> : <RiFileDownloadLine aria-hidden />}
              Wygeneruj plik
            </Button>
            {reason ? (
              <p id={REASON_ID} className="text-muted-foreground text-xs">
                {reason}
              </p>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
