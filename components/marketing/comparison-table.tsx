import { Fragment } from 'react';

export type FeatureStatus = 'yes' | 'no' | 'partial' | 'note';

export interface ComparisonRow {
  feature: string;
  ksefSaas: { status: FeatureStatus; note?: string };
  competitor: { status: FeatureStatus; note?: string };
  category?: string;
}

interface Props {
  competitorName: string;
  rows: ComparisonRow[];
}

/**
 * Tabela porównawcza — ciemny motyw marketingu (BUG-002 fix).
 * Wcześniej używała jasnych kolorów (text-stone-800, bg-emerald-50) na CIEMNYM
 * tle `.marketing-landing` → tekst niewidoczny („za mgłą"). Teraz wszystko
 * korzysta z tokenów --marketing-* i jest czytelne. Kolumna FaktWay
 * podświetlona emerald.
 */
export function ComparisonTable({ competitorName, rows }: Props) {
  const grouped = rows.reduce<Record<string, ComparisonRow[]>>((acc, r) => {
    const cat = r.category ?? 'Inne';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(r);
    return acc;
  }, {});

  return (
    <div className="relative">
      <div
        className="pointer-events-none absolute -inset-6 bg-gradient-to-br from-[var(--marketing-accent)]/10 via-transparent to-[var(--marketing-accent)]/10 opacity-50 blur-2xl"
        aria-hidden
      />
      <div className="marketing-glass-card relative overflow-hidden rounded-2xl">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="w-1/2 border-b border-white/10 px-6 py-6 text-left">
                  <span className="marketing-section-label">Funkcja / Możliwość</span>
                </th>
                <th className="w-1/4 border-b border-white/10 px-6 py-6 text-center">
                  <div className="mx-auto inline-flex flex-col items-center gap-1 px-4 py-2">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--marketing-muted)]">
                      Standardowy soft
                    </span>
                    <span className="text-base font-semibold text-[var(--marketing-text)]">
                      Inne Aplikacje
                    </span>
                  </div>
                </th>
                <th className="relative w-1/4 border-b border-[var(--marketing-accent)]/40 px-6 py-6 text-center">
                  <div
                    className="absolute inset-x-3 inset-y-2 rounded-2xl bg-[color-mix(in_srgb,var(--marketing-accent)_12%,transparent)] ring-1 ring-[color-mix(in_srgb,var(--marketing-accent)_30%,transparent)]"
                    aria-hidden
                  />
                  <div className="relative inline-flex flex-col items-center gap-1">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--marketing-accent)]">
                      Standard jutra
                    </span>
                    <span className="text-base font-bold text-[var(--marketing-accent)]">
                      FaktWay
                    </span>
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(grouped).map(([category, categoryRows]) => (
                <Fragment key={category}>
                  <tr>
                    <td
                      colSpan={3}
                      className="border-b border-white/[0.06] bg-white/[0.03] px-6 py-2.5"
                    >
                      <p className="marketing-section-label">{category}</p>
                    </td>
                  </tr>
                  {categoryRows.map((row, i) => (
                    <tr
                      key={`${category}-${i}`}
                      className="border-b border-white/[0.05] transition-colors hover:bg-white/[0.03] last:border-0"
                    >
                      <td className="px-6 py-4 text-sm text-[var(--marketing-text)]">
                        {row.feature}
                      </td>
                      <FeatureCell status={row.competitor} />
                      <FeatureCell status={row.ksefSaas} highlight />
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <span className="sr-only">Porównanie z {competitorName}</span>
    </div>
  );
}

function FeatureCell({
  status,
  highlight = false,
}: {
  status: { status: FeatureStatus; note?: string };
  highlight?: boolean;
}) {
  const renderIcon = () => {
    if (status.status === 'yes') {
      return (
        <span
          className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${
            highlight
              ? 'bg-[color-mix(in_srgb,var(--marketing-accent)_22%,transparent)] text-[var(--marketing-accent)] ring-1 ring-[color-mix(in_srgb,var(--marketing-accent)_45%,transparent)]'
              : 'bg-[color-mix(in_srgb,var(--marketing-accent)_12%,transparent)] text-[color-mix(in_srgb,var(--marketing-accent)_80%,white)] ring-1 ring-[color-mix(in_srgb,var(--marketing-accent)_25%,transparent)]'
          }`}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="h-3.5 w-3.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
      );
    }
    if (status.status === 'no') {
      return (
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/25">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="h-3.5 w-3.5">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </span>
      );
    }
    if (status.status === 'partial') {
      return (
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/25">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </span>
      );
    }
    return <span className="text-xs text-[var(--marketing-muted)]">·</span>;
  };

  return (
    <td
      className={`relative px-6 py-4 text-center align-middle ${
        highlight ? 'bg-[color-mix(in_srgb,var(--marketing-accent)_6%,transparent)]' : ''
      }`}
    >
      <div className="flex flex-col items-center gap-1.5">
        {renderIcon()}
        {status.note ? (
          <span className="max-w-[8rem] text-[10px] leading-snug text-[var(--marketing-muted)]">
            {status.note}
          </span>
        ) : null}
      </div>
    </td>
  );
}
