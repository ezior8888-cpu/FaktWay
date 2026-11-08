'use client';

import { useId, useMemo, useState } from 'react';
import { ArrowRight } from 'lucide-react';

import { MONTHLY_PRICE_GROSS_GROSZE, PRICE_PER_MONTH, formatPln } from '@/lib/billing/pricing';
import { cn } from '@/lib/utils';
import { ButtonLink } from '@/components/site/ui';

/**
 * Kalkulator oszczędności: dwie kolumny (suwaki / wynik) w jednej karcie.
 * Od 23.10.2026 na tokenach aplikacji, w wyglądzie strony głównej
 * (wcześniej ciemny motyw ze szmaragdową poświatą).
 *
 * Abonament z `lib/billing/pricing` (do 23.10.2026 było tu na sztywno
 * 49 zł miesięcznie, a do „zysku” doliczana była różnica względem
 * założonej ceny konkurencji 79 zł i wiersz „Przewaga rynkowa: Wysoka”;
 * niczego z tego nie mogliśmy wykazać).
 */
const SUBSCRIPTION_YEAR_GROSZE = MONTHLY_PRICE_GROSS_GROSZE * 12;

/**
 * Odczyt ze zdjęcia ma twardy limit miesięczny na firmę: 3 zł budżetu, przy
 * obecnych cenach około 55 rozpoznań (lib/ai/tenant-ai-budget.ts). Po jego
 * wyczerpaniu dokument czeka na odnowienie limitu i trzeba go wgrać ponownie,
 * więc z dokumentów ponad limit nie liczymy oszczędności. Wartość jest tu na
 * sztywno, bo plik jest kliencki.
 */
const LIMIT_ODCZYTOW_MIESIECZNIE = 55;

export function SavingsCalculatorPreview() {
  const [invoicesPerMonth, setInvoicesPerMonth] = useState(20);
  const [hourlyRate, setHourlyRate] = useState(150);
  const invoicesInputId = useId();
  const hourlyRateInputId = useId();

  const calc = useMemo(() => {
    const minutesPerInvoiceManual = 8;
    const minutesPerInvoiceWithOcr = 1.5;
    const savedMinutesPerInvoice =
      minutesPerInvoiceManual - minutesPerInvoiceWithOcr;

    const invoicesPerYear = Math.min(invoicesPerMonth, LIMIT_ODCZYTOW_MIESIECZNIE) * 12;
    const minutesSavedPerYear = invoicesPerYear * savedMinutesPerInvoice;
    const hoursSavedPerYear = minutesSavedPerYear / 60;
    const moneySavedPerYear = hoursSavedPerYear * hourlyRate;

    const netSaving = moneySavedPerYear - SUBSCRIPTION_YEAR_GROSZE / 100;

    return {
      hoursSavedPerYear,
      moneySavedPerYear,
      netSaving,
    };
  }, [invoicesPerMonth, hourlyRate]);

  return (
    <div className="overflow-hidden rounded-3xl bg-card text-card-foreground shadow-xl shadow-primary/5 ring-1 ring-border">
      <div className="grid grid-cols-1 lg:grid-cols-2">
        {/* LEWA: suwaki */}
        <div className="space-y-10 border-b border-border p-8 lg:border-r lg:border-b-0 lg:p-10">
          <RangeField
            id={invoicesInputId}
            label="Faktury miesięcznie"
            value={invoicesPerMonth}
            min={5}
            max={200}
            step={5}
            onChange={setInvoicesPerMonth}
          />
          <RangeField
            id={hourlyRateInputId}
            label="Stawka godzinowa (zł)"
            value={hourlyRate}
            min={30}
            max={500}
            step={10}
            onChange={setHourlyRate}
          />
        </div>

        {/* PRAWA: zysk netto */}
        <div className="bg-muted/50 p-8 lg:p-10">
          <p className="text-sm font-medium text-muted-foreground">Zysk netto rocznie</p>
          <p className="mt-3 flex items-baseline gap-2">
            <span className="text-6xl font-semibold tracking-tight text-primary tabular-nums lg:text-7xl">
              {calc.netSaving.toFixed(0)}
            </span>
            <span className="text-2xl font-semibold text-muted-foreground">zł</span>
          </p>

          <div className="mt-8 space-y-3 text-sm">
            <BreakdownRow
              label="Czas wolny"
              value={`${calc.hoursSavedPerYear.toFixed(0)} h / rok`}
            />
            <BreakdownRow
              label="Wartość czasu"
              value={`+${calc.moneySavedPerYear.toFixed(0)} zł`}
              positive
            />
            <BreakdownRow
              label="Abonament FaktWay"
              value={`−${formatPln(SUBSCRIPTION_YEAR_GROSZE)}`}
              isLast
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border p-6 lg:px-10">
        <p className="max-w-md text-xs text-muted-foreground">
          Szacunek przy założeniu: 8 min na dokument ręcznie i 1,5 min
          z odczytem ze zdjęcia w FaktWay, abonament {PRICE_PER_MONTH}. Odczyt ze zdjęcia ma limit, około{' '}
          {LIMIT_ODCZYTOW_MIESIECZNIE} dokumentów miesięcznie na firmę, więc ponad limit oszczędności nie
          liczymy. Twój wynik może być inny.
        </p>
        <ButtonLink href="/register">
          Zacznij oszczędzać teraz
          <ArrowRight className="size-4" aria-hidden />
        </ButtonLink>
      </div>
    </div>
  );
}

function RangeField({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        <span className="text-2xl font-semibold text-primary tabular-nums">{value}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full cursor-pointer accent-primary"
      />
    </div>
  );
}

function BreakdownRow({
  label,
  value,
  positive = false,
  isLast = false,
}: {
  label: string;
  value: string;
  positive?: boolean;
  isLast?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-4',
        !isLast && 'border-b border-border pb-3',
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'tabular-nums',
          positive ? 'font-semibold text-primary' : 'text-foreground',
        )}
      >
        {value}
      </span>
    </div>
  );
}
