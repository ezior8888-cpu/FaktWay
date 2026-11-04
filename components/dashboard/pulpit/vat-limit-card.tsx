'use client';

import Link from 'next/link';
import { Line, LineChart, ReferenceLine, XAxis, YAxis } from 'recharts';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { formatPlCompactMoney, formatPlMoney } from '@/lib/format/pl';
import { cn } from '@/lib/utils';

import { PULPIT_EMPTY, PulpitEmptyState } from './card-states';

/**
 * Karta „Limit zwolnienia z VAT” (art. 113). Sprzedaż netto narastająco od
 * 1 stycznia na tle limitu liczonego funkcjami z `lib/flo/functions/vat-limit.ts`
 * (proporcja dla firmy założonej w trakcie roku, prognoza przekroczenia).
 * Bez daty rozpoczęcia działalności procentu nie pokazujemy — zaniżyłby go
 * firmie z tego roku — tylko link do ustawień. Wzór: Finora
 * `statistics-impression-card.tsx`.
 */

const config = {
  // chart-5 na ciemnej karcie ma ok. 1,8:1 (WCAG 1.4.11 wymaga 3:1) — w ciemnym motywie chart-1.
  sales: { label: 'Sprzedaż narastająco', theme: { light: 'var(--chart-5)', dark: 'var(--chart-1)' } },
} satisfies ChartConfig;

type VatLimitLevel = 'ok' | 60 | 80 | 90 | 100;

/** Strukturalnie zgodne z `VatLimitOverview` (limit liczony przez FLO). */
export interface VatLimitCardProps {
  months: { key: string; label: string }[];
  /** Sprzedaż netto narastająco po każdym miesiącu od stycznia. */
  cumulative: number[];
  used: number;
  annualLimit: number;
  startedOn: string | null;
  limit: null | {
    effectiveLimit: number;
    prorated: boolean;
    activeDays: number;
    daysInYear: number;
    pct: number;
    remaining: number;
    level: VatLimitLevel;
    formula: string;
    crossesOn: string | null;
  };
  /**
   * Gdy `limit === null`: wykorzystanie względem PEŁNEGO limitu rocznego
   * (dolna granica — firma z tego roku ma limit mniejszy).
   */
  lowerBound?: null | { pct: number; level: VatLimitLevel; remaining: number };
  className?: string;
}

const DISCLAIMER = 'Sprzedaż bez faktury (np. z kasy fiskalnej) i z faktur spoza FaktWay dolicz sam.';

/** „2026-03-05” → „05.03.2026” (bez Date, więc bez strefy czasowej). */
function formatPlDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

function levelTone(level: VatLimitLevel): string {
  if (level === 'ok') return 'text-muted-foreground';
  if (level === 60 || level === 80) return 'text-amber-700 dark:text-amber-400';
  return 'text-destructive';
}

export function VatLimitCard({
  months,
  cumulative,
  used,
  annualLimit,
  startedOn,
  limit,
  lowerBound = null,
  className,
}: VatLimitCardProps) {
  const data = months.map((m, i) => ({ month: m.label, sales: cumulative[i] ?? 0 }));
  const noSales = cumulative.every((v) => v === 0);
  const peak = Math.max(0, ...cumulative);
  // Sama korekta in minus na początku roku daje sprzedaż ujemną — oś musi ją
  // pokazać, a procent wykorzystania nie schodzi poniżej zera.
  const floor = Math.min(0, ...cumulative);
  const yMax = limit ? Math.max(limit.effectiveLimit, peak) : undefined;
  const shownPct = (pct: number) => Math.max(0, Math.floor(pct));

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Limit zwolnienia z VAT</CardTitle>
        <CardDescription className="text-muted-foreground text-base">Sprzedaż z faktur w KSeF od 1 stycznia</CardDescription>
      </CardHeader>
      {noSales ? (
        <CardContent className="flex flex-1 flex-col">
          <PulpitEmptyState message={PULPIT_EMPTY.noInvoices} action={PULPIT_EMPTY.issueInvoice} />
          {limit ? (
            <p className="text-muted-foreground text-center text-xs">
              Limit na ten rok: {formatPlMoney(limit.effectiveLimit)} zł
            </p>
          ) : (
            <div className="space-y-1 text-center">
              <p className="text-muted-foreground text-xs">
                Pełny limit roczny: {formatPlMoney(annualLimit)} zł — mniejszy, jeśli działalność ruszyła w tym roku
              </p>
              <Link
                href="/settings#data-rozpoczecia"
                className="text-primary text-sm underline-offset-4 hover:underline"
              >
                Uzupełnij datę rozpoczęcia działalności
              </Link>
            </div>
          )}
          <p className="text-muted-foreground mt-2 text-center text-xs">{DISCLAIMER}</p>
        </CardContent>
      ) : (
        <>
          <CardContent>
            {months.length >= 2 ? (
              <ChartContainer config={config} className="h-21 w-full">
                <LineChart accessibilityLayer data={data} margin={{ left: 4, right: 4 }}>
                  <XAxis dataKey="month" hide />
                  {yMax !== undefined ? <YAxis hide domain={[floor, yMax]} /> : null}
                  <ChartTooltip
                    cursor={false}
                    content={
                      <ChartTooltipContent
                        formatter={(value) => `Narastająco: ${formatPlMoney(Number(value))} zł`}
                      />
                    }
                  />
                  {limit ? (
                    <ReferenceLine
                      y={limit.effectiveLimit}
                      stroke="var(--muted-foreground)"
                      strokeDasharray="4 4"
                      label={{ value: 'Limit', position: 'insideTopRight', fill: 'var(--muted-foreground)', fontSize: 11 }}
                    />
                  ) : null}
                  <Line dataKey="sales" type="linear" dot={false} stroke="var(--color-sales)" strokeWidth={3} />
                </LineChart>
              </ChartContainer>
            ) : (
              <p className="text-muted-foreground text-sm">{PULPIT_EMPTY.trendAfterSecondMonth}</p>
            )}
          </CardContent>
          <CardContent className="flex items-center justify-between gap-2">
            {limit ? (
              <>
                <span
                  className="text-xl font-semibold"
                  title={`${formatPlMoney(used)} zł z ${formatPlMoney(limit.effectiveLimit)} zł`}
                >
                  {formatPlCompactMoney(used)} z {formatPlCompactMoney(limit.effectiveLimit)}
                </span>
                <span className={cn('text-base font-semibold', levelTone(limit.level))}>
                  {shownPct(limit.pct)}%
                </span>
              </>
            ) : (
              <span className="text-xl font-semibold" title={`${formatPlMoney(used)} zł`}>
                {formatPlCompactMoney(used)}
              </span>
            )}
          </CardContent>
          <CardContent className="space-y-1">
            {limit ? (
              <>
                {limit.level === 100 ? (
                  <p className="text-destructive text-sm">
                    Limit przekroczony. Sprawdź z księgową rejestrację do VAT.
                  </p>
                ) : limit.remaining === 0 ? (
                  <p className="text-destructive text-sm">
                    Limit wykorzystany w całości — kolejna sprzedaż go przekroczy. Sprawdź z księgową rejestrację do VAT.
                  </p>
                ) : limit.crossesOn ? (
                  <p className="text-muted-foreground text-sm">
                    Przy obecnym tempie limit skończy się ok. {formatPlDate(limit.crossesOn)}
                  </p>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    Przy obecnym tempie limit wystarczy do końca roku
                  </p>
                )}
                {limit.prorated && startedOn ? (
                  <p className="text-muted-foreground text-xs" title={limit.formula}>
                    Limit proporcjonalny: działalność od {formatPlDate(startedOn)}
                  </p>
                ) : null}
                <p className="text-muted-foreground text-xs">Wzór: {limit.formula}</p>
              </>
            ) : (
              <>
                {lowerBound?.level === 100 ? (
                  <p className="text-destructive text-sm">
                    Sprzedaż przekroczyła pełny roczny limit {formatPlMoney(annualLimit)} zł. Sprawdź z księgową rejestrację do VAT.
                  </p>
                ) : lowerBound && lowerBound.level !== 'ok' ? (
                  <p className={cn('text-sm', levelTone(lowerBound.level))}>
                    Co najmniej {shownPct(lowerBound.pct)}% pełnego limitu — podaj datę rozpoczęcia, jeśli firma ruszyła w tym roku.
                  </p>
                ) : null}
                <p className="text-muted-foreground text-sm">
                  Podaj datę rozpoczęcia działalności, a policzymy wykorzystanie limitu.
                </p>
                <Link
                  href="/settings#data-rozpoczecia"
                  className="text-primary text-sm underline-offset-4 hover:underline"
                >
                  Uzupełnij w ustawieniach
                </Link>
              </>
            )}
            <p className="text-muted-foreground text-xs">{DISCLAIMER}</p>
          </CardContent>
        </>
      )}
    </Card>
  );
}
