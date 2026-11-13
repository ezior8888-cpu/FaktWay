'use client';

import { useState, useTransition } from 'react';
import { RiLoader4Line } from '@remixicon/react';
import { toast } from 'sonner';

import {
  createInvoiceSeriesAction,
  deleteInvoiceSeriesAction,
  setDefaultInvoiceSeriesAction,
  setInvoiceSeriesActiveAction,
  type SeriesListResult,
} from '@/app/actions/numeracja';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { InvoiceSeries } from '@/lib/numeracja/baza';
import {
  INVOICE_KIND_LABELS,
  INVOICE_KINDS,
  MAX_FIRST_NUMBER,
  MAX_PATTERN_LENGTH,
  patternPeriod,
  patternProblem,
  patternProblemMessage,
  patternReset,
  renderInvoiceNumber,
  RESET_LABELS,
  type InvoiceKind,
} from '@/lib/numeracja/wzor';

/**
 * Numeracja faktur w ustawieniach firmy (krok 2.5, 00199): serie numerów,
 * seria domyślna każdego rodzaju dokumentu i nowa seria z własnym wzorem.
 * Nowa sekcja na końcu zakładki „Firma” z istniejących komponentów (D1).
 * Zmienia właściciel i administrator (sprawdza też baza); pozostali widzą
 * serie bez przycisków.
 */
export function InvoiceNumberingForm({
  initialSeries,
  canEdit,
  today,
}: {
  /** `null`: serii nie udało się wczytać. */
  initialSeries: InvoiceSeries[] | null;
  canEdit: boolean;
  today: string;
}) {
  const [series, setSeries] = useState(initialSeries);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<SeriesListResult>, done: string) => {
    startTransition(async () => {
      const result = await action().catch(() => ({ success: false as const, error: 'Nie udało się zapisać zmiany numeracji. Sprawdź połączenie i spróbuj ponownie.' }));
      if (result.success) {
        setSeries(result.series);
        toast.success(done);
      } else {
        toast.error(result.error);
      }
    });
  };

  const active = (series ?? []).filter((s) => s.active);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <FieldLabel>Numeracja faktur</FieldLabel>
        <FieldDescription>
          Serie numerów faktur, np. osobna dla faktur w walucie albo dla innego miejsca sprzedaży. Numer z serii FaktWay nadaje
          przy zapisie faktury: kolejny w serii, bez powtórzeń, także gdy kilka osób wystawia naraz. Numer wpisany w formularzu
          ręcznie zostaje bez zmian.
        </FieldDescription>
        {canEdit ? null : <FieldDescription>Serie zmienia właściciel albo administrator firmy.</FieldDescription>}
      </div>

      {series === null ? (
        <p role="alert" className="text-destructive text-sm">
          Nie udało się wczytać serii numeracji. Odśwież stronę za chwilę.
        </p>
      ) : series.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Numeracja jak dotąd: formularz podpowiada kolejny numer po ostatniej fakturze danego rodzaju. Dodaj serię, żeby
          numer nadawał się z licznika według Twojego wzoru.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {series.map((s) => (
            <SeriesItem
              key={s.id}
              series={s}
              canEdit={canEdit}
              pending={pending}
              onArchive={(activeNext) =>
                run(() => setInvoiceSeriesActiveAction(s.id, activeNext), activeNext ? 'Seria przywrócona' : 'Seria ukryta')
              }
              onDelete={() => run(() => deleteInvoiceSeriesAction(s.id), 'Seria usunięta')}
            />
          ))}
        </ul>
      )}

      {series && series.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div>
            <FieldLabel>Seria domyślna</FieldLabel>
            <FieldDescription>Ta seria jest wybrana w formularzu danego rodzaju dokumentu. Można ją zmienić przy fakturze.</FieldDescription>
          </div>
          {INVOICE_KINDS.map((kind) => (
            <DefaultSeriesRow
              key={kind}
              kind={kind}
              series={active}
              canEdit={canEdit}
              pending={pending}
              onChange={(id) => run(() => setDefaultInvoiceSeriesAction(id, kind), 'Seria domyślna zmieniona')}
            />
          ))}
        </div>
      ) : null}

      {canEdit && series !== null ? (
        <NewSeriesForm
          today={today}
          pending={pending}
          onCreate={(input) => run(() => createInvoiceSeriesAction(input), 'Seria dodana')}
        />
      ) : null}
    </div>
  );
}

function SeriesItem({
  series,
  canEdit,
  pending,
  onArchive,
  onDelete,
}: {
  series: InvoiceSeries;
  canEdit: boolean;
  pending: boolean;
  onArchive: (active: boolean) => void;
  onDelete: () => void;
}) {
  const isDefault = series.defaultKinds.length > 0;
  return (
    <li className="border-border flex flex-col gap-2 border p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1 text-sm">
        <p className="font-medium">
          {series.name}
          {series.active ? null : <span className="text-muted-foreground font-normal"> (ukryta)</span>}
        </p>
        <p className="text-muted-foreground">
          {series.pattern ? (
            <>
              Wzór <span className="text-foreground font-mono">{series.pattern}</span>, {RESET_LABELS[patternReset(series.pattern)]}
            </>
          ) : (
            'Bez wzoru: numer jak dotąd, kolejny po ostatniej fakturze'
          )}
        </p>
        {series.next ? (
          <p className="text-muted-foreground">
            Następny numer: <span className="text-foreground font-mono">{series.next.number}</span>
          </p>
        ) : null}
        {isDefault ? (
          <p className="text-muted-foreground">
            Domyślna: {series.defaultKinds.map((k) => INVOICE_KIND_LABELS[k].toLowerCase()).join(', ')}
          </p>
        ) : null}
      </div>
      {canEdit && !isDefault ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={() => onArchive(!series.active)} className="max-lg:min-h-[44px]">
            {series.active ? 'Ukryj' : 'Przywróć'}
          </Button>
          {series.used ? null : (
            <Button type="button" variant="ghost" disabled={pending} onClick={onDelete} className="max-lg:min-h-[44px]">
              Usuń
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}

function DefaultSeriesRow({
  kind,
  series,
  canEdit,
  pending,
  onChange,
}: {
  kind: InvoiceKind;
  series: InvoiceSeries[];
  canEdit: boolean;
  pending: boolean;
  onChange: (id: string) => void;
}) {
  const current = series.find((s) => s.defaultKinds.includes(kind)) ?? null;
  const items = series.map((s) => ({ value: s.id, label: s.name }));
  const id = `numeracja-domyslna-${kind}`;
  return (
    <Field orientation="responsive">
      <FieldContent>
        <FieldLabel htmlFor={id}>{INVOICE_KIND_LABELS[kind]}</FieldLabel>
      </FieldContent>
      <div className="w-full sm:w-80">
        {canEdit ? (
          <Select
            value={current?.id ?? null}
            items={items}
            disabled={pending}
            onValueChange={(value) => {
              if (typeof value === 'string' && value !== current?.id) onChange(value);
            }}
          >
            <SelectTrigger id={id} className="w-full max-lg:min-h-[44px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-sm">{current?.name ?? 'Numeracja jak dotąd'}</span>
        )}
      </div>
    </Field>
  );
}

function NewSeriesForm({
  today,
  pending,
  onCreate,
}: {
  today: string;
  pending: boolean;
  onCreate: (input: { name: string; pattern: string; firstNumber: number; defaultKinds: InvoiceKind[] }) => void;
}) {
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('FV/{NNN}/{MM}/{RRRR}');
  const [firstNumber, setFirstNumber] = useState('1');
  const [defaults, setDefaults] = useState<InvoiceKind[]>([]);

  const problem = patternProblem(pattern.trim());
  const first = Number(firstNumber);
  const firstValid = Number.isInteger(first) && first >= 1 && first <= MAX_FIRST_NUMBER;
  const example = !problem && firstValid
    ? renderInvoiceNumber(pattern.trim(), patternPeriod(pattern.trim(), today), first)
    : null;

  const toggle = (kind: InvoiceKind, checked: boolean) =>
    setDefaults((current) => (checked ? [...new Set([...current, kind])] : current.filter((k) => k !== kind)));

  return (
    <form
      className="border-border flex flex-col gap-3 border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || !firstValid || name.trim() === '') return;
        onCreate({ name: name.trim(), pattern: pattern.trim(), firstNumber: first, defaultKinds: defaults });
      }}
    >
      <div>
        <FieldLabel>Nowa seria</FieldLabel>
        <FieldDescription>
          Elementy wzoru: {'{RRRR}'} rok, {'{MM}'} miesiąc z zerem, {'{M}'} miesiąc, {'{N}'} albo {'{NNN}'} licznik (liczba N to
          najmniejsza liczba cyfr). Licznik liczy się od 1 co miesiąc, gdy wzór ma miesiąc, co rok, gdy ma tylko rok.
        </FieldDescription>
      </div>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="numeracja-nazwa">Nazwa serii</FieldLabel>
        </FieldContent>
        <Input
          id="numeracja-nazwa"
          value={name}
          maxLength={60}
          placeholder="np. Faktury w walucie"
          disabled={pending}
          onChange={(e) => setName(e.target.value)}
          className="w-full sm:w-80 max-lg:min-h-[44px]"
        />
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="numeracja-wzor">Wzór numeru</FieldLabel>
          {problem ? (
            <FieldDescription id="numeracja-wzor-blad" role="alert" className="text-destructive">
              {patternProblemMessage(problem)}
            </FieldDescription>
          ) : example ? (
            <FieldDescription>
              Pierwszy numer: <span className="text-foreground font-mono">{example}</span>
            </FieldDescription>
          ) : null}
        </FieldContent>
        <Input
          id="numeracja-wzor"
          value={pattern}
          maxLength={MAX_PATTERN_LENGTH}
          spellCheck={false}
          autoComplete="off"
          disabled={pending}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? 'numeracja-wzor-blad' : undefined}
          onChange={(e) => setPattern(e.target.value)}
          className="w-full font-mono sm:w-80 max-lg:min-h-[44px]"
        />
      </Field>
      <Field orientation="responsive">
        <FieldContent>
          <FieldLabel htmlFor="numeracja-pierwszy">Pierwszy numer licznika</FieldLabel>
          <FieldDescription>Inny niż 1, gdy kontynuujesz numerację z innego programu w tym okresie.</FieldDescription>
        </FieldContent>
        <Input
          id="numeracja-pierwszy"
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_FIRST_NUMBER}
          value={firstNumber}
          disabled={pending}
          onChange={(e) => setFirstNumber(e.target.value)}
          className="w-full sm:w-80 max-lg:min-h-[44px]"
        />
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Ustaw jako domyślną dla</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {INVOICE_KINDS.map((kind) => (
            <label key={kind} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="accent-primary h-4 w-4"
                checked={defaults.includes(kind)}
                disabled={pending}
                onChange={(e) => toggle(kind, e.target.checked)}
              />
              {INVOICE_KIND_LABELS[kind]}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <Button type="submit" disabled={pending || Boolean(problem) || !firstValid || name.trim() === ''} className="max-lg:min-h-[44px]">
          {pending ? <RiLoader4Line className="animate-spin" aria-hidden /> : null}
          Dodaj serię
        </Button>
      </div>
    </form>
  );
}
