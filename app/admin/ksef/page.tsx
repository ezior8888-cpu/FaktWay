import Link from 'next/link';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

import { requireAdmin } from '@/lib/auth/admin-guard';
import {
  clientDecisionRows,
  listFailedInvoices,
  listLifecycleViolations,
  NO_CODE_FILTER,
  splitClientDecisionPending,
  summarizeViolations,
} from '@/lib/admin/ksef-lifecycle';
import { OPERATOR_DUPLICATE_MESSAGES } from '@/lib/admin/ksef-operator-policy';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { findDuplicateNoticesBatch, type DuplicateNotices } from '@/lib/ksef/duplicate-decision-notice';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

interface SearchParams {
  code?: string;
}

const CLASS_LABEL: Record<string, string> = {
  terminal: 'treść',
  transient: 'przejściowy',
  hold: 'hamulec',
  reconcile: 'uzgodnienie',
  setup: 'ustawienia',
};

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * Ślady „Faktura … czeka na Twoją decyzję” dla wszystkich wierszy I5D jednym
 * odczytem (`findDuplicateNoticesBatch`, ten sam filtr co karta faktury).
 * Automat wysyła powiadomienie raz i niedostarczonego nie ponawia (przegląd
 * PR B, #1/#4), więc „nie” to sygnał dla operatora: „Przypomnij klientowi”.
 * `null` — błąd odczytu albo wynik obcięty limitem: „nie wiadomo”, nigdy „nie”.
 */
async function loadI5dNotices(
  rows: ReadonlyArray<{ invoiceId: string; tenantId: string | null; ksefNumber: string | null }>,
): Promise<Map<string, DuplicateNotices> | null> {
  const wanted = rows.filter((r): r is { invoiceId: string; tenantId: string; ksefNumber: string } =>
    r.tenantId !== null && r.ksefNumber !== null);
  try {
    return await findDuplicateNoticesBatch(wanted);
  } catch {
    return null;
  }
}

/** Komórka „Powiadomienie klienta” tabeli I5D. */
function noticeCell(
  notices: DuplicateNotices | null | undefined,
  row: { originalKsefNumber: string | null; envMatches: boolean },
): { text: string; warn: boolean; title?: string } {
  if (!row.originalKsefNumber) return { text: '—', warn: false };
  if (!notices) {
    return { text: 'nie wiadomo (błąd odczytu śladu)', warn: true, title: 'Sprawdź „Powiadomienie klienta” w karcie faktury.' };
  }
  if (notices.count === 0) {
    // I5D-env: klient i tak nie zapisze decyzji — przypomnienie nic nie da, alarm jest osobno.
    return row.envMatches
      ? { text: 'nie', warn: true, title: 'Klient nie dostał powiadomienia o tym numerze KSeF oryginału — „Przypomnij klientowi” w karcie faktury.' }
      : { text: 'nie', warn: false };
  }
  return { text: `tak, ${notices.count} × · ostatnie ${when(notices.lastAt)}`, warn: false };
}

/**
 * Panel operatora cyklu życia faktury (PR 3c): naruszenia inwariantów
 * I1–I5, I9 ze strażnika 00131, faktury `failed`/`rejected` per kod
 * z katalogu, wejście do karty faktury z akcjami. Od 00148 (D-A4-1b-3 PR B,
 * decyzja 4) faktury czekające na decyzję klienta (I5D) mają osobną sekcję
 * i nie liczą się do naruszeń; kolumna „Powiadomienie klienta” mówi, czy
 * klient dostał e-mail albo push o bieżącym numerze KSeF oryginału.
 */
export default async function AdminKsefPage(props: { searchParams: Promise<SearchParams> }) {
  await requireAdmin();
  const params = await props.searchParams;
  const code = params.code?.trim() || null;

  const [allViolations, failed] = await Promise.all([
    listLifecycleViolations(),
    listFailedInvoices({ code, limit: 100 }),
  ]);
  const { violations, clientPending } = splitClientDecisionPending(allViolations);
  const summary = summarizeViolations(violations);
  const waiting = clientDecisionRows(clientPending, configuredKsefEnvironment());
  const tenantOf = new Map(clientPending.map((v) => [v.invoiceId, v.tenantId]));
  const notices = await loadI5dNotices(
    waiting.map((w) => ({ invoiceId: w.invoiceId, tenantId: tenantOf.get(w.invoiceId) ?? null, ksefNumber: w.originalKsefNumber })),
  );

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tighter-display">KSeF — cykl życia faktury</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Strażnik inwariantów (00131), faktury z błędem wysyłki per kod z katalogu i akcje operatora:
          ponowna wysyłka, uzgodnienie po referencji, powrót do szkicu. Każda akcja trafia do <code>audit_logs</code>.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="font-semibold text-lg flex items-center gap-2">
          {violations.length > 0 ? (
            <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden />
          )}
          Naruszenia inwariantów: {violations.length}
        </h2>
        {violations.length === 0 ? (
          <p className="text-sm text-muted-foreground">Brak naruszeń I1–I5 i I9. Strażnik przechodzi czysto.</p>
        ) : (
          <>
            <ul className="flex flex-wrap gap-2 text-xs">
              {summary.map((s) => (
                <li key={s.invariant} className="rounded-xl border border-glass-border bg-foreground/3 px-3 py-1.5">
                  <span className="font-mono font-semibold">{s.invariant}</span> · {s.count} · {s.label}
                </li>
              ))}
            </ul>
            <div className="overflow-x-auto rounded-2xl border border-glass-border bg-foreground/3 backdrop-blur-glass">
              <table className="w-full text-sm">
                <thead className="border-b border-glass-border">
                  <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Inwariant</th>
                    <th className="px-4 py-2.5 font-medium">Faktura</th>
                    <th className="px-4 py-2.5 font-medium">Firma</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Szczegóły</th>
                  </tr>
                </thead>
                <tbody>
                  {violations.map((v) => (
                    <tr key={`${v.invariant}-${v.invoiceId}`} className="border-b border-glass-border last:border-0">
                      <td className="px-4 py-2.5 font-mono text-xs" title={v.label}>{v.invariant}</td>
                      <td className="px-4 py-2.5">
                        <Link href={`/admin/ksef/${v.invoiceId}`} className="font-medium hover:underline">
                          {v.internalNumber ?? v.invoiceId}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{v.tenantName ?? v.tenantId}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{v.ksefStatus ?? '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground break-all">
                        {JSON.stringify(v.detail)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Czekają na decyzję klienta (I5D): {waiting.length}</h2>
        {waiting.length === 0 ? (
          <p className="text-sm text-muted-foreground">Brak faktur czekających na decyzję klienta.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-glass-border bg-foreground/3 backdrop-blur-glass">
            <table className="w-full text-sm">
              <thead className="border-b border-glass-border">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Faktura</th>
                  <th className="px-4 py-2.5 font-medium">Firma</th>
                  <th className="px-4 py-2.5 font-medium">Numer KSeF oryginału</th>
                  <th className="px-4 py-2.5 font-medium">Powód</th>
                  <th className="px-4 py-2.5 font-medium">Środowisko</th>
                  <th className="px-4 py-2.5 font-medium">Od</th>
                  <th className="px-4 py-2.5 font-medium">Powiadomienie klienta</th>
                </tr>
              </thead>
              <tbody>
                {waiting.map((w) => {
                  const notice = noticeCell(notices ? notices.get(w.invoiceId) : null, w);
                  return (
                    <tr key={w.invoiceId} className="border-b border-glass-border last:border-0">
                      <td className="px-4 py-2.5">
                        <Link href={`/admin/ksef/${w.invoiceId}`} className="font-medium hover:underline">
                          {w.internalNumber ?? w.invoiceId}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{w.tenantName ?? '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs break-all">{w.originalKsefNumber ?? '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">{w.reason ?? '—'}</td>
                      <td
                        className={cn('px-4 py-2.5 font-mono text-xs', w.envMatches ? '' : 'bg-red-500/10 font-semibold text-red-700 dark:text-red-400')}
                        title={w.envMatches ? undefined : OPERATOR_DUPLICATE_MESSAGES.i5dEnv}
                      >
                        {w.env ?? '(brak)'}
                        {w.envMatches ? null : <span className="block">I5D-env</span>}
                      </td>
                      <td className="px-4 py-2.5 text-xs tabular-nums">{when(w.attemptedAt)}</td>
                      <td
                        className={cn('px-4 py-2.5 text-xs tabular-nums', notice.warn ? 'bg-amber-500/10 font-semibold text-amber-800 dark:text-amber-300' : '')}
                        title={notice.title}
                      >
                        {notice.text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Faktury failed / rejected per kod</h2>
        <ul className="flex flex-wrap gap-2 text-xs">
          <li>
            <Link
              href="/admin/ksef"
              className={cn('inline-block rounded-xl border border-glass-border px-3 py-1.5', !code ? 'bg-background shadow-glass-sm' : 'bg-foreground/3')}
            >
              wszystkie
            </Link>
          </li>
          {failed.counts.map((c) => (
            <li key={c.code}>
              <Link
                href={`/admin/ksef?code=${encodeURIComponent(c.code)}`}
                className={cn('inline-block rounded-xl border border-glass-border px-3 py-1.5', code === c.code ? 'bg-background shadow-glass-sm' : 'bg-foreground/3')}
                title={c.errorClass ? `klasa: ${c.errorClass}` : 'kod spoza katalogu albo brak kodu'}
              >
                <span className="font-mono">{c.code === NO_CODE_FILTER ? '(brak kodu)' : c.code}</span>
                {c.errorClass ? <span className="text-muted-foreground"> · {CLASS_LABEL[c.errorClass] ?? c.errorClass}</span> : null}
                <span className="ml-1 font-semibold">{c.total}</span>
              </Link>
            </li>
          ))}
        </ul>
        {failed.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Brak faktur w tym stanie.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-glass-border bg-foreground/3 backdrop-blur-glass">
            <table className="w-full text-sm">
              <thead className="border-b border-glass-border">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Faktura</th>
                  <th className="px-4 py-2.5 font-medium">Firma</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Kod</th>
                  <th className="px-4 py-2.5 font-medium">Błąd</th>
                  <th className="px-4 py-2.5 font-medium">Zmiana</th>
                </tr>
              </thead>
              <tbody>
                {failed.rows.map((r) => (
                  <tr key={r.id} className={cn('border-b border-glass-border last:border-0', r.sendOwner ? 'bg-amber-500/5' : '')}>
                    <td className="px-4 py-2.5">
                      <Link href={`/admin/ksef/${r.id}`} className="font-medium hover:underline">
                        {r.internalNumber ?? r.id}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {r.tenantName ?? r.tenantId}
                      {r.tenantNip ? <span className="block font-mono text-xs">{r.tenantNip}</span> : null}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">{r.ksefStatus}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {r.errorCode ?? '—'}
                      {r.errorClass ? <span className="block text-muted-foreground">{CLASS_LABEL[r.errorClass] ?? r.errorClass}</span> : null}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-md truncate" title={r.lastError ?? undefined}>
                      {r.lastError ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs tabular-nums">{when(r.updatedAt)}</td>
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
