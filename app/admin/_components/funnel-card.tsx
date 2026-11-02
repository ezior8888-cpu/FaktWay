import { FUNNEL_WEEKS, type FunnelWeekRow } from '@/lib/observability/business-metrics';

/**
 * Lejek firm w /admin: liczby z własnej bazy, bez danych osobowych, niezależne
 * od PostHoga i zgód (`admin_funnel_weekly`, 00161). Każda firma liczy się
 * w tygodniu założenia, więc świeże tygodnie jeszcze dojrzewają.
 *
 * Tabela o stałej szerokości zamiast przewijania w bok: krótkie nagłówki i siedem
 * kolumn mieszczą się przy 390 px.
 */

type StepKey = 'newTenants' | 'ksefConnected' | 'firstInvoice' | 'trialStarted' | 'paying' | 'churned';

const STEPS: ReadonlyArray<{ key: StepKey; label: string; short: string }> = [
  { key: 'newTenants', label: 'Nowe firmy', short: 'Nowe' },
  { key: 'ksefConnected', label: 'Podłączony KSeF', short: 'KSeF' },
  { key: 'firstInvoice', label: 'Pierwsza faktura', short: 'Faktura' },
  { key: 'trialStarted', label: 'Próba', short: 'Próba' },
  { key: 'paying', label: 'Płacący', short: 'Płacą' },
  { key: 'churned', label: 'Odeszli', short: 'Odeszli' },
];

const CHANNEL_LABELS: Record<string, string> = {
  google_ads: 'Reklamy Google',
  organic_search: 'Wyszukiwarka',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  social: 'Social media',
  referral: 'Inne strony',
  direct: 'Bezpośrednio',
  other: 'Inne',
};

const CELL = 'px-0.5 py-1.5 text-right sm:px-2';

function sum(rows: FunnelWeekRow[], key: StepKey): number {
  return rows.reduce((total, row) => total + row[key], 0);
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%';
}

/** „2026-10-26” → „26.10”. Bez `Date`: tydzień z bazy to data, nie chwila. */
function weekLabel(weekStart: string): string {
  const [, month, day] = weekStart.split('-');
  return `${day}.${month}`;
}

function StepHeaders({ first }: { first: string }) {
  return (
    <thead>
      <tr className="border-b border-glass-border text-[10px] text-muted-foreground sm:text-xs">
        <th scope="col" className="py-1.5 pr-1 text-left font-medium">{first}</th>
        {STEPS.map((step) => (
          <th key={step.key} scope="col" className={`${CELL} font-medium`}>{step.short}</th>
        ))}
      </tr>
    </thead>
  );
}

function StepCells({ values }: { values: Record<StepKey, number> }) {
  return (
    <>
      {STEPS.map((step) => (
        <td key={step.key} className={CELL}>{values[step.key]}</td>
      ))}
    </>
  );
}

export function FunnelCard({ rows }: { rows: FunnelWeekRow[] | null }) {
  const shell = 'rounded-3xl border border-glass-border bg-foreground/3 p-5 backdrop-blur-glass';

  if (rows === null) {
    return (
      <section className={shell}>
        <h2 className="text-base font-semibold">Lejek firm</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Lejek chwilowo niedostępny. Pozostałe liczby panelu działają bez niego.
        </p>
      </section>
    );
  }

  const weeks = rows.filter((row) => row.source === 'all');
  const channels = [...new Set(rows.filter((row) => row.source !== 'all').map((row) => row.source))]
    .map((source) => {
      const own = rows.filter((row) => row.source === source);
      const values = Object.fromEntries(STEPS.map((step) => [step.key, sum(own, step.key)])) as Record<StepKey, number>;
      return { source, values };
    })
    .sort((a, b) => b.values.newTenants - a.values.newTenants);
  const newTenants = sum(weeks, 'newTenants');

  return (
    <section className={shell}>
      <h2 className="text-base font-semibold">Lejek firm: ostatnie {FUNNEL_WEEKS} tygodni</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Każda firma liczy się w tygodniu założenia. Liczby z naszej bazy, bez danych osobowych,
        niezależne od PostHoga i zgód na analitykę.
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {STEPS.map((step) => {
          const value = sum(weeks, step.key);
          return (
            <div key={step.key} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{step.label}</dt>
              <dd className="mt-0.5 text-2xl font-semibold">{value}</dd>
              {step.key === 'newTenants' ? null : (
                <dd className="text-xs text-muted-foreground">{percent(value, newTenants)} nowych firm</dd>
              )}
            </div>
          );
        })}
      </dl>

      <table className="mt-5 w-full table-fixed text-xs tabular-nums sm:text-sm">
        <caption className="sr-only">Lejek firm według tygodnia założenia</caption>
        <StepHeaders first="Tydzień" />
        <tbody>
          {weeks.map((week) => (
            <tr key={week.weekStart} className="border-b border-glass-border/50 last:border-0">
              <th scope="row" className="py-1.5 pr-1 text-left font-medium">{weekLabel(week.weekStart)}</th>
              <StepCells values={week} />
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="mt-5 text-sm font-semibold">Źródła</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Suma okresu, tylko firmy, których właściciel zgodził się na analitykę. Reszta jest
        w tabeli wyżej, bez podziału.
      </p>
      {channels.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Żadna firma z tego okresu nie ma jeszcze źródła.</p>
      ) : (
        <table className="mt-2 w-full table-fixed text-xs tabular-nums sm:text-sm">
          <caption className="sr-only">Lejek firm według źródła wejścia</caption>
          <colgroup>
            <col className="w-[28%]" />
          </colgroup>
          <StepHeaders first="Kanał" />
          <tbody>
            {channels.map(({ source, values }) => (
              <tr key={source} className="border-b border-glass-border/50 last:border-0">
                <th scope="row" className="py-1.5 pr-1 text-left font-medium">
                  {CHANNEL_LABELS[source] ?? source}
                </th>
                <StepCells values={values} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
