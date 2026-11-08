import Link from 'next/link';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

import { requireAdmin } from '@/lib/auth/admin-guard';
import { ATTEMPTS_SCAN_LIMIT, loadSendErrorsView } from '@/lib/admin/centrum/attempts';
import { INVARIANT_LABELS } from '@/lib/admin/ksef-lifecycle';
import {
  attemptMessage,
  CLASS_LABELS,
  cronFreshness,
  effectiveStatus,
  ERROR_PERIODS,
  groupIncidents,
  parseSendErrorFilters,
  RECOVERY_LABELS,
  STAGE_LABELS,
  STATUS_FILTER_LABELS,
  STATUS_FILTERS,
  STATUS_LABELS,
  STUCK_HINTS,
  type RecoveryState,
  type SendErrorFilters,
} from '@/lib/admin/centrum/send-errors';
import type { SendErrorClass } from '@/lib/ksef/send-error-classes';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const TABLE = 'overflow-x-auto rounded-2xl border border-glass-border bg-foreground/3 backdrop-blur-glass';
const TH = 'px-4 py-2.5 font-medium';
const TD = 'px-4 py-2.5 align-top';
const ROWS_SHOWN = 200;

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pl-PL', {
    timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function ago(ms: number | null): string {
  if (ms === null) return 'brak przebiegu';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'przed chwilą';
  if (min < 120) return `${min} min temu`;
  return `${Math.round(min / 60)} h temu`;
}

function classLabel(value: string | null): string {
  return value && value in CLASS_LABELS ? CLASS_LABELS[value as SendErrorClass] : '—';
}

function stageLabel(value: string): string {
  return STAGE_LABELS[value] ?? value;
}

function filterHref(filters: SendErrorFilters, patch: Partial<SendErrorFilters>): string {
  const next = { ...filters, ...patch };
  const params = new URLSearchParams();
  params.set('period', next.period);
  params.set('status', next.status);
  if (next.code) params.set('code', next.code);
  if (next.errorClass) params.set('class', next.errorClass);
  if (next.stage) params.set('stage', next.stage);
  return `/admin/centrum/bledy?${params.toString()}`;
}

function recoverySummary(recovery: Record<RecoveryState, number>): string {
  return (Object.keys(recovery) as RecoveryState[])
    .filter((state) => recovery[state] > 0)
    .map((state) => `${RECOVERY_LABELS[state]}: ${recovery[state]}`)
    .join(' · ');
}

function Counter({ label, value, warn, note }: { label: string; value: number | null | 'n/a'; warn?: boolean; note?: string }) {
  return (
    <div className="rounded-2xl border border-glass-border bg-foreground/3 px-4 py-3">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('mt-1 font-display text-2xl font-semibold', warn && typeof value === 'number' && value > 0 ? 'text-red-600' : '')}>
        {value === null ? 'nie wiadomo' : value === 'n/a' ? '—' : value}
      </div>
      {note && <div className="text-xs text-muted-foreground">{note}</div>}
    </div>
  );
}

/**
 * Centrum dowodzenia — błędy wysyłki do KSeF (brief C-22, faza 3; plan A5).
 *
 * Każda nieudana próba z dziennika `ksef_send_attempts` (00150): porażki
 * wykonania (także przed wysłaniem pliku), odmowy przed kolejką i wykonania
 * przerwane przez padnięty worker — z incydentami według odcisku, bieżącym
 * stanem faktur (odzyskane / nadal z błędem), świeżością cronów i fakturami,
 * które utknęły w wysyłce teraz (strażnik I1/I2 — także bez wiersza w dzienniku). Widok
 * tylko czyta; akcje na fakturach są w `/admin/ksef/[id]`.
 */
export default async function AdminSendErrorsPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const filters = parseSendErrorFilters(await props.searchParams);
  const now = new Date();
  const view = await loadSendErrorsView(filters, now);
  const incidents = groupIncidents(view.rows, now);
  const crons = cronFreshness(view.crons, now);
  const staleCrons = crons.filter((c) => c.stale);
  const failingCrons = crons.filter((c) => c.failing && !c.stale);
  const rowsTotal = view.matching ?? view.rows.length;
  const rowsShown = Math.min(ROWS_SHOWN, view.rows.length);
  // Filtr kodu, klasy albo etapu wycina udane wykonania (nie mają kodu, kończą na „po przyjęciu”) —
  // licznik sukcesów i udział błędów nie miałyby wtedy sensu (zawsze 0 i 100 %).
  const narrowed = Boolean(filters.code || filters.errorClass || filters.stage);
  const executions =
    !narrowed && view.counts.succeeded !== null && view.counts.failed !== null && view.counts.interrupted !== null
      ? view.counts.succeeded + view.counts.failed + view.counts.interrupted
      : null;
  const failedShare =
    executions && view.counts.failed !== null && view.counts.interrupted !== null
      ? ((view.counts.failed + view.counts.interrupted) / executions) * 100
      : null;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tighter-display">Błędy wysyłki do KSeF</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Każda nieudana próba z dziennika prób (A5): błędy przed wysłaniem pliku i po nim, odmowy przed kolejką
          i wykonania przerwane przez worker. Ponowienie to osobny wiersz — błąd odzyskanej faktury zostaje
          w historii. Akcje na fakturach: <Link href="/admin/ksef" className="underline">KSeF — cykl życia</Link>.
        </p>
      </header>

      {view.problems.length > 0 && (
        <section className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm">
          <p className="flex items-center gap-2 font-semibold text-red-700 dark:text-red-400">
            <AlertTriangle className="h-4 w-4" aria-hidden /> Odczyt niepełny — liczby i listy poniżej mogą zaniżać błędy
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {view.problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-semibold text-lg flex items-center gap-2">
          {staleCrons.length > 0 || failingCrons.length > 0 ? (
            <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
          )}
          Czy worker działa
        </h2>
        <ul className="flex flex-wrap gap-2 text-xs">
          {crons.map((c) => (
            <li
              key={c.queue}
              className={cn(
                'rounded-xl border px-3 py-1.5',
                c.stale || c.failing ? 'border-amber-500/50 bg-amber-500/10' : 'border-glass-border bg-foreground/3',
              )}
              title={c.queue}
            >
              {c.label}: {c.failing ? `ostatni przebieg z błędem ${ago(c.ageMs)}` : ago(c.ageMs)}
            </li>
          ))}
        </ul>
        {staleCrons.length > 0 && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            Część cronów nie przebiegła w terminie — worker mógł stanąć. Pusta lista błędów nie znaczy wtedy, że wysyłka działa.
          </p>
        )}
        {failingCrons.length > 0 && (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            Ostatni przebieg {failingCrons.map((c) => `„${c.label}”`).join(', ')} zakończył się błędem — cron działa, ale nie wykonuje
            swojej pracy (szczegóły: <Link href="/admin/system" className="underline">System</Link>, Sentry).
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {view.ledgerSince === undefined
            ? <>Początek dziennika prób nieznany — odczyt nieudany (wyżej). </>
            : view.ledgerSince
              ? <>Dziennik prób od {when(view.ledgerSince)}. </>
              : <>Dziennik prób jest pusty. </>}
          Wcześniejsze błędy znamy tylko jako ostatni błąd faktury.
          {' '}Faktury wychodzące z błędem teraz (wszystkie, także z dziennika):{' '}
          {view.invoicesWithErrorNow === null ? 'nie wiadomo' : view.invoicesWithErrorNow}
          {' '}(<Link href="/admin/ksef" className="underline">lista w cyklu życia</Link>).
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold text-lg flex items-center gap-2">
          {view.stuckNow === null || view.stuckNow.length > 0 ? (
            <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
          )}
          Utknięte w wysyłce teraz ({view.stuckNow === null ? 'nie wiadomo' : view.stuckNow.length})
        </h2>
        <p className="text-xs text-muted-foreground">
          Strażnik cyklu życia (I1, I2) — stan faktur teraz, niezależnie od okresu i filtrów. Zgubione zlecenie nie
          zostawia wiersza w dzienniku prób, więc takiej faktury może nie być w incydentach niżej. Pozostałe naruszenia
          strażnika: <Link href="/admin/ksef" className="underline">KSeF — cykl życia</Link>.
        </p>
        {view.stuckNow === null ? (
          <p className="text-sm text-amber-700 dark:text-amber-400">
            Nie wiadomo — odczyt strażnika nieudany (wyżej). To nie znaczy, że nic nie utknęło.
          </p>
        ) : view.stuckNow.length === 0 ? (
          <p className="text-sm text-muted-foreground">Brak faktur w queued bez zlecenia ani w sending ponad dzierżawę.</p>
        ) : (
          <div className={TABLE}>
            <table className="w-full text-sm">
              <thead className="border-b border-glass-border">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className={TH}>Strażnik</th>
                  <th className={TH}>Faktura</th>
                  <th className={TH}>Firma</th>
                  <th className={TH}>Stan</th>
                  <th className={TH} title="I1: ostatnia zmiana wiersza faktury (updated_at); I2: znacznik przejęcia wysyłki">Od (zegar strażnika)</th>
                  <th className={TH}>Co dalej</th>
                </tr>
              </thead>
              <tbody>
                {view.stuckNow.map((s) => (
                  <tr key={`${s.invariant}:${s.invoiceId}`} className="border-b border-glass-border/60 last:border-0">
                    <td className={TD}>
                      <span className="font-mono">{s.invariant}</span>
                      <div className="text-xs text-muted-foreground">{INVARIANT_LABELS[s.invariant]}</div>
                    </td>
                    <td className={TD}>
                      <Link href={`/admin/ksef/${s.invoiceId}`} className="underline">{s.internalNumber ?? s.invoiceId.slice(0, 8)}</Link>
                    </td>
                    <td className={TD}>{s.tenantName ?? '—'}</td>
                    <td className={cn(TD, 'font-mono text-xs')}>{s.ksefStatus ?? '—'}</td>
                    <td className={cn(TD, 'whitespace-nowrap text-xs')}>{s.since ? when(s.since) : 'brak znacznika'}</td>
                    <td className={cn(TD, 'max-w-md text-xs', s.automatOverdue && 'text-red-600')}>
                      {s.automatOverdue && <strong>Automat nie zadziałał. </strong>}
                      {STUCK_HINTS[s.invariant]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Okres</span>
          <select name="period" defaultValue={filters.period} className="rounded-lg border border-glass-border bg-background px-2 py-1.5">
            {(Object.keys(ERROR_PERIODS) as Array<keyof typeof ERROR_PERIODS>).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Rodzaj</span>
          <select name="status" defaultValue={filters.status} className="rounded-lg border border-glass-border bg-background px-2 py-1.5">
            {STATUS_FILTERS.map((s) => <option key={s} value={s}>{STATUS_FILTER_LABELS[s]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Klasa</span>
          <select name="class" defaultValue={filters.errorClass ?? ''} className="rounded-lg border border-glass-border bg-background px-2 py-1.5">
            <option value="">wszystkie</option>
            {(Object.keys(CLASS_LABELS) as SendErrorClass[]).map((c) => <option key={c} value={c}>{CLASS_LABELS[c]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Etap</span>
          <select name="stage" defaultValue={filters.stage ?? ''} className="rounded-lg border border-glass-border bg-background px-2 py-1.5">
            <option value="">wszystkie</option>
            {Object.entries(STAGE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Kod</span>
          <input name="code" defaultValue={filters.code ?? ''} placeholder="np. KSEF_UNAVAILABLE" className="rounded-lg border border-glass-border bg-background px-2 py-1.5 font-mono" />
        </label>
        <button type="submit" className="rounded-lg border border-glass-border bg-foreground/5 px-3 py-1.5 font-medium hover:bg-foreground/10">
          Filtruj
        </button>
        <Link href="/admin/centrum/bledy" className="px-1 py-1.5 text-xs text-muted-foreground underline">wyczyść</Link>
      </form>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Counter label="Błędy wykonania" value={view.counts.failed} warn />
        <Counter label="Przerwane" value={view.counts.interrupted} warn />
        <Counter label="Odmowy przed kolejką" value={view.counts.refused} />
        <Counter label="Oczekiwania" value={view.counts.waiting} />
        <Counter
          label="Udane wykonania"
          value={narrowed ? 'n/a' : view.counts.succeeded}
          note={narrowed ? 'nie dotyczy przy filtrze kodu, klasy lub etapu' : undefined}
        />
        <div className="rounded-2xl border border-glass-border bg-foreground/3 px-4 py-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Wykonania z błędem</div>
          <div className="mt-1 font-display text-2xl font-semibold">
            {failedShare === null ? '—' : `${failedShare.toFixed(1)} %`}
          </div>
          <div className="text-xs text-muted-foreground">
            {narrowed ? 'nie dotyczy przy filtrze kodu, klasy lub etapu' : 'informacyjnie, nie SLI faktur'}
          </div>
        </div>
      </section>

      {view.truncated && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          Wynik obcięty: {view.matching !== null ? `${view.matching} pasujących wierszy, ` : ''}pokazujemy i grupujemy
          {' '}{view.rows.length} najnowszych (limit {ATTEMPTS_SCAN_LIMIT}). Liczniki wyżej są pełne; incydenty — nie. Zawęź okres albo filtr.
        </p>
      )}

      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Incydenty ({incidents.length})</h2>
        <p className="text-xs text-muted-foreground">
          Wiersze zgrupowane po kodzie, etapie, odpowiedzi KSeF i szablonie komunikatu. „Stan teraz” pokazuje, co się
          stało z dotkniętymi fakturami (każda liczona raz).
        </p>
        {incidents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {view.problems.length > 0 ? 'Brak danych — odczyt nieudany (wyżej).' : 'Brak błędów w wybranym okresie i filtrze.'}
          </p>
        ) : (
          <div className={TABLE}>
            <table className="w-full text-sm">
              <thead className="border-b border-glass-border">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className={TH}>Rodzaj</th>
                  <th className={TH}>Kod · klasa</th>
                  <th className={TH}>Etap</th>
                  <th className={TH}>KSeF</th>
                  <th className={TH}>Wystąpienia</th>
                  <th className={TH}>Faktury · firmy</th>
                  <th className={TH}>Pierwsze → ostatnie</th>
                  <th className={TH}>Stan teraz</th>
                  <th className={TH}>Przykład</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((i) => (
                  <tr key={i.key} className="border-b border-glass-border/60 last:border-0">
                    <td className={TD}>{STATUS_LABELS[i.status]}</td>
                    <td className={TD}>
                      {i.errorCode ? (
                        <Link href={filterHref(filters, { code: i.errorCode })} className="font-mono underline">{i.errorCode}</Link>
                      ) : '—'}
                      <div className="text-xs text-muted-foreground">{classLabel(i.errorClass)}</div>
                    </td>
                    <td className={TD}>
                      <Link href={filterHref(filters, { stage: i.stage })} className="underline">{stageLabel(i.stage)}</Link>
                    </td>
                    <td className={cn(TD, 'font-mono text-xs')}>
                      {i.httpStatus ? `HTTP ${i.httpStatus}` : ''}{i.httpStatus && i.ksefCode ? ' · ' : ''}{i.ksefCode ?? ''}
                      {!i.httpStatus && !i.ksefCode ? '—' : ''}
                    </td>
                    <td className={cn(TD, 'font-semibold')}>{i.count}</td>
                    <td className={TD}>{i.invoices} · {i.tenants}</td>
                    <td className={cn(TD, 'whitespace-nowrap text-xs')}>{when(i.firstAt)} → {when(i.lastAt)}</td>
                    <td className={cn(TD, 'text-xs')}>{recoverySummary(i.recovery)}</td>
                    <td className={cn(TD, 'max-w-md text-xs')}>
                      <Link href={`/admin/ksef/${i.sampleInvoiceId}`} className="underline">karta faktury</Link>
                      {i.sampleMessage && <div className="mt-1 break-words text-muted-foreground">{i.sampleMessage}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold text-lg">
          Próby (
          {view.rows.length === 0 && view.problems.length > 0
            ? 'nie wiadomo'
            : rowsShown < rowsTotal
              ? `${rowsShown} najnowszych z ${rowsTotal}`
              : rowsTotal}
          )
        </h2>
        {view.rows.length === 0 && view.problems.length > 0 && (
          <p className="text-sm text-muted-foreground">Brak danych — odczyt nieudany (wyżej).</p>
        )}
        {view.rows.length > 0 && (
          <div className={TABLE}>
            <table className="w-full text-sm">
              <thead className="border-b border-glass-border">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className={TH}>Kiedy</th>
                  <th className={TH}>Faktura</th>
                  <th className={TH}>Firma</th>
                  <th className={TH}>Rodzaj</th>
                  <th className={TH}>Etap</th>
                  <th className={TH}>Kod</th>
                  <th className={TH}>Wykonanie</th>
                  <th className={TH}>Komunikat</th>
                  <th className={TH}>Worker</th>
                </tr>
              </thead>
              <tbody>
                {view.rows.slice(0, ROWS_SHOWN).map((r) => (
                  <tr key={r.id} className="border-b border-glass-border/60 last:border-0">
                    <td className={cn(TD, 'whitespace-nowrap text-xs')}>{when(r.startedAt)}</td>
                    <td className={TD}>
                      <Link href={`/admin/ksef/${r.invoiceId}`} className="underline">{r.internalNumber ?? r.invoiceId.slice(0, 8)}</Link>
                      <div className="text-xs text-muted-foreground">teraz: {r.invoiceStatus ?? '—'}</div>
                    </td>
                    <td className={cn(TD, 'text-xs')}>{r.tenantName ?? r.tenantId.slice(0, 8)}</td>
                    <td className={TD}>{STATUS_LABELS[effectiveStatus(r, now)]}</td>
                    <td className={TD}>{stageLabel(r.stage)}</td>
                    <td className={cn(TD, 'font-mono text-xs')}>
                      {r.errorCode ?? '—'}
                      {r.httpStatus ? <div className="text-muted-foreground">HTTP {r.httpStatus}</div> : null}
                    </td>
                    <td className={cn(TD, 'text-xs')}>
                      {r.status === 'refused' ? '—' : `#${r.execution + 1}`}
                      {r.retryable === false && r.status === 'failed' ? <div className="text-muted-foreground">bez ponowień</div> : null}
                    </td>
                    <td className={cn(TD, 'max-w-md break-words text-xs text-muted-foreground')}>{attemptMessage(r, now) ?? '—'}</td>
                    <td className={cn(TD, 'font-mono text-xs')}>{r.workerSha ? r.workerSha.slice(0, 7) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold text-lg">
          UPO nieudane teraz{view.upoFailuresTotal !== null ? ` (${view.upoFailuresTotal})` : ''}
        </h2>
        <p className="text-xs text-muted-foreground">
          Po przyjęciu faktury: pobranie UPO odrzucone (<code>failed</code>) albo bez wyniku ponad godzinę
          (<code>pending</code> — np. zapis do magazynu po pobraniu padł). Niezależnie od wybranego okresu.
        </p>
        {view.upoFailures.length === 0 ? (
          <p className="text-sm text-muted-foreground">{view.upoFailuresTotal === null ? 'Nie wiadomo — odczyt nieudany.' : 'Brak.'}</p>
        ) : (
          <div className={TABLE}>
            <table className="w-full text-sm">
              <thead className="border-b border-glass-border">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className={TH}>Faktura</th>
                  <th className={TH}>Firma</th>
                  <th className={TH}>Stan</th>
                  <th className={TH}>Próby</th>
                  <th className={TH}>Ostatni błąd</th>
                  <th className={TH}>Od</th>
                </tr>
              </thead>
              <tbody>
                {view.upoFailures.map((u) => (
                  <tr key={u.invoiceId} className="border-b border-glass-border/60 last:border-0">
                    <td className={TD}>
                      <Link href={`/admin/ksef/${u.invoiceId}`} className="underline">{u.internalNumber ?? u.invoiceId.slice(0, 8)}</Link>
                    </td>
                    <td className={cn(TD, 'text-xs')}>{u.tenantName ?? '—'}</td>
                    <td className={cn(TD, 'font-mono text-xs')}>{u.status === 'pending' ? 'pending (bez wyniku)' : u.status}</td>
                    <td className={TD}>{u.attempts}</td>
                    <td className={cn(TD, 'max-w-md break-words text-xs text-muted-foreground')}>{u.lastError ?? '—'}</td>
                    <td className={cn(TD, 'whitespace-nowrap text-xs')}>{when(u.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
