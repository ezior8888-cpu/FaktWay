import { Fragment } from 'react';
import { AlertCircle, CheckCircle2, XCircle } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { ComparisonRow, FeatureStatus } from '@/components/marketing/comparison-table';

interface Props {
  competitorName: string;
  productName?: string;
  rows: ComparisonRow[];
}

function StatusIcon({ status }: { status: FeatureStatus }) {
  switch (status) {
    case 'yes':
      return (
        <CheckCircle2
          className="ff-vs-icon-success h-5 w-5 text-[var(--color-status-success)]"
          aria-hidden
        />
      );
    case 'no':
      return (
        <XCircle
          className="ff-vs-icon-error h-5 w-5 text-[var(--color-status-error)]"
          aria-hidden
        />
      );
    case 'partial':
      return (
        <AlertCircle
          className="ff-vs-icon-warn h-5 w-5 text-orange-400"
          aria-hidden
        />
      );
    case 'note':
      return (
        <AlertCircle
          className="h-5 w-5 text-[var(--cmp-on-surface-variant)] opacity-70"
          aria-hidden
        />
      );
    default:
      return null;
  }
}

function faktflowCellBg(status: FeatureStatus): string {
  switch (status) {
    case 'yes':
      return 'bg-[var(--color-status-success-bg)]';
    case 'partial':
      return 'bg-[color-mix(in_srgb,var(--color-status-success)_12%,transparent)]';
    case 'no':
      return 'bg-[color-mix(in_srgb,var(--color-status-error)_8%,transparent)]';
    case 'note':
      return 'bg-white/[0.03]';
    default:
      return '';
  }
}

function competitorCellBg(status: FeatureStatus): string {
  switch (status) {
    case 'yes':
      return 'bg-white/[0.02]';
    case 'partial':
      return 'bg-orange-500/5';
    case 'no':
      return 'bg-[var(--color-status-error-bg)]/40';
    case 'note':
      return 'bg-white/[0.02]';
    default:
      return '';
  }
}

export function VsComparisonTableEmerald({
  competitorName,
  productName = 'FaktWay',
  rows,
}: Props) {
  const grouped = rows.reduce<Record<string, ComparisonRow[]>>((acc, r) => {
    const cat = r.category ?? 'Inne';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(r);
    return acc;
  }, {});

  return (
    <div className="ff-vs-glass-card max-w-6xl overflow-x-auto rounded-2xl p-4 md:p-5">
      <div className="w-full min-w-[34rem] sm:min-w-[36rem]">
        {/* nagłówek — gęstość jak ComparisonTable (px-6 py-5 / text-sm) */}
        <div className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-[var(--cmp-outline)] px-4 py-4 md:px-5 md:py-5">
          <div className="flex items-end text-left text-xs font-medium uppercase tracking-wider text-[var(--cmp-on-surface-variant)]">
            Funkcja
          </div>
          <div className="flex justify-center px-1">
            <div className="ff-vs-glass-card w-full max-w-[200px] rounded-lg border border-[var(--color-comparison-border)] bg-[color-mix(in_srgb,var(--color-comparison-surface)_80%,transparent)] px-3 py-3 text-center md:max-w-[220px] md:px-4 md:py-3.5">
              <p className="mb-0.5 text-[10px] font-bold uppercase tracking-widest text-[var(--cmp-on-surface-variant)]">
                Standardowy soft
              </p>
              <p className="text-sm font-semibold leading-tight text-[var(--cmp-on-surface)]">{competitorName}</p>
            </div>
          </div>
          <div className="flex justify-center px-1">
            <div
              className={cn(
                'ff-vs-emerald-glow relative w-full max-w-[200px] overflow-hidden rounded-lg border border-[var(--cmp-primary)]/40 bg-[var(--cmp-primary)]/10 px-3 py-3 text-center md:max-w-[220px] md:px-4 md:py-3.5',
              )}
            >
              <div className="pointer-events-none absolute inset-0 bg-[var(--cmp-primary)]/5 transition-colors group-hover:bg-[var(--cmp-primary)]/10" />
              <div className="relative z-10">
                <p className="mb-0.5 text-[10px] font-bold uppercase tracking-widest text-[var(--cmp-primary)]">
                  Rekomendowany wybór
                </p>
                <p className="text-base font-bold leading-tight tracking-tight text-[var(--cmp-primary)] md:text-lg">
                  {productName}
                </p>
              </div>
            </div>
          </div>
        </div>

        {Object.entries(grouped).map(([category, categoryRows]) => (
          <Fragment key={category}>
            <div
              className="border-b border-[var(--cmp-outline)] px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-[var(--cmp-on-surface-variant)] md:px-5"
              style={{ background: 'var(--table-header-bg)' }}
            >
              {category}
            </div>
            {categoryRows.map((row, i) => (
              <div
                key={`${category}-${row.feature}-${i}`}
                className="grid grid-cols-[1fr_auto_auto] gap-3 border-b border-[var(--color-comparison-border)] px-4 py-3 transition-colors last:border-0 hover:bg-[var(--table-row-hover)] md:px-5 md:py-4"
              >
                <div className="min-w-0 pr-2 text-left">
                  <p className="text-sm leading-snug text-[var(--cmp-on-surface)]">{row.feature}</p>
                </div>
                <div
                  className={cn(
                    'flex min-w-[7rem] max-w-[220px] flex-col items-center justify-center rounded-lg px-2 py-2.5 text-center md:min-w-[7.5rem] md:px-3 md:py-3',
                    competitorCellBg(row.competitor.status),
                  )}
                >
                  {row.competitor.status === 'note' ? (
                    <span className="text-xs font-semibold tabular-nums text-[var(--cmp-on-surface)]">
                      {row.competitor.note}
                    </span>
                  ) : (
                    <>
                      <StatusIcon status={row.competitor.status} />
                      {row.competitor.note ? (
                        <span className="mt-1 max-w-[11rem] text-center text-[11px] leading-tight text-[var(--cmp-on-surface-variant)]">
                          {row.competitor.note}
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
                <div
                  className={cn(
                    'flex min-w-[7rem] max-w-[220px] flex-col items-center justify-center rounded-lg px-2 py-2.5 text-center text-[var(--cmp-primary)] md:min-w-[7.5rem] md:px-3 md:py-3',
                    faktflowCellBg(row.ksefSaas.status),
                  )}
                >
                  {row.ksefSaas.status === 'note' ? (
                    <span className="text-xs font-semibold tabular-nums text-[var(--cmp-on-surface)]">
                      {row.ksefSaas.note}
                    </span>
                  ) : (
                    <>
                      <StatusIcon status={row.ksefSaas.status} />
                      {row.ksefSaas.note ? (
                        <span className="mt-1 max-w-[11rem] text-center text-[11px] font-medium leading-tight text-[var(--cmp-primary)]/90">
                          {row.ksefSaas.note}
                        </span>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
