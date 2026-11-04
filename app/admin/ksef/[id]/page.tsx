import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { requireAdmin } from '@/lib/auth/admin-guard';
import { listInvoiceAttempts } from '@/lib/admin/centrum/attempts';
import { attemptMessage, effectiveStatus, STAGE_LABELS, STATUS_LABELS } from '@/lib/admin/centrum/send-errors';
import { getInvoiceLifecycle, type InvoiceLifecycle } from '@/lib/admin/ksef-lifecycle';
import {
  gateProblemsText,
  OPERATOR_DUPLICATE_MESSAGES,
  operatorDuplicateRefusalReason,
} from '@/lib/admin/ksef-operator-policy';

import { OperatorActions } from '../_components/operator-actions';

export const dynamic = 'force-dynamic';

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pl-PL', {
    timeZone: 'Europe/Warsaw', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function Field({ label, value, mono = false }: { label: string; value: string | number | null | undefined; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono text-sm break-all' : 'text-sm'}>{value === null || value === undefined || value === '' ? '—' : String(value)}</dd>
    </div>
  );
}

/**
 * Co karta mówi o ofercie i blokadzie decyzji (widok polityki, actor operator): oferta i tryb, przegląd pliku
 * z wynikiem suchego przebiegu, powód odmowy albo zapisana decyzja. Teksty operatora z `OPERATOR_DUPLICATE_MESSAGES`.
 */
function offerSummary(data: InvoiceLifecycle): string | null {
  const view = data.duplicateDecision;
  if (!view) return null;
  switch (view.kind) {
    case 'decidable':
      return `oferta ${view.offer ?? 'powód PR B'} · tryb ${view.mode ?? 'decide_ksef_duplicate (9 argumentów)'}`;
    case 'review': {
      const recordable = data.originalRecordable;
      const record = recordable?.ok === true
        ? 'plik da się zapisać'
        : OPERATOR_DUPLICATE_MESSAGES.notBuildable(recordable?.ok === false ? recordable.detail : 'plik nie został sprawdzony');
      return `oferta ${view.offer} (przegląd pliku, I5R) · ${record}`;
    }
    case 'refused':
      return `odmowa ${view.refusal}: ${operatorDuplicateRefusalReason(view.refusal, view.detail)}`;
    case 'decided':
      return `decyzja zapisana${view.mode ? ` · tryb ${view.mode}` : ''}${view.offer ? ` · oferta ${view.offer}` : ''}`;
  }
}

/** Sekcja „Zapis oryginału” (PR C, 6.6): ocena pliku, oferta, oddanie, znacznik „sprawdź ponownie”, K po decyzji i I3K. */
function OriginalImportSection({ data }: { data: InvoiceLifecycle }) {
  const { submissions, importedOriginal } = data;
  const rows = submissions.filter((s) => s.originalCheck?.reason === 'faktflow-original');
  if (rows.length === 0) return null;
  const M = OPERATOR_DUPLICATE_MESSAGES;
  // `{nrK}` w tekstach I3K: numer faktury z KSeF — numer, który przeszedł z dokumentu na K (`retiredInternalNumber`).
  const nrK = rows.find((s) => s.originalDecision?.importedInvoiceId)?.originalDecision?.retiredInternalNumber
    ?? importedOriginal?.ksefNumber
    ?? data.invoice.id;
  return (
    <section className="space-y-3">
      <h2 className="font-semibold text-lg">Zapis oryginału z oznaczeniem FaktWay</h2>
      {rows.map((s) => {
        const c = s.originalCheck!;
        const open = s.status === 'sent' || s.status === 'intent';
        const gate = c.importGate ?? null;
        const decision = s.originalDecision;
        const fields: Array<[string, string | null]> = [
          ['Wpis próby', `${s.status ?? '—'}${open ? ' (otwarty — bieżący)' : ' (zamknięty — historyczny)'}`],
          ['Ocena pliku', gate
            ? `${gate.kind} · reguły v${gate.rules}${gate.problems.length > 0 ? ` · ${gateProblemsText(gate.problems)}` : ''}`
            : 'brak oceny pliku (znacznik sprzed 00156 — recheck-needed)'],
          ['Podgląd pliku', gate?.preview
            ? `okres ${gate.preview.period} · pozycji ${gate.preview.lineCount} · brutto ${gate.preview.totals.gross} · nabywca: ${gate.preview.buyerIdKind}`
            : null],
          ['Oddanie decyzji klientowi', gate?.release
            ? `${when(gate.release.at)} · ${gate.release.actorUserId ? `user ${gate.release.actorUserId.slice(0, 8)}…` : 'operator'} · ${gate.release.note ?? ''}`
            : null],
          ['Do ponownego sprawdzenia', c.recheckNeeded ? M.recheckPending(c.recheckNeeded.kind, when(c.recheckNeeded.at)) : null],
          ['Oferta i blokada', open ? offerSummary(data) : null],
          ['Decyzja (tryb, oferta)', decision ? `tryb ${decision.mode ?? '—'} · oferta ${decision.offer ?? '—'}` : null],
          ['Dawny numer dokumentu', decision?.retiredInternalNumber ?? null],
        ];
        return (
          <dl key={s.id} className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 rounded-2xl border border-glass-border bg-foreground/3 p-4 text-sm">
            {fields.filter(([, v]) => v).map(([label, value]) => (
              <div key={label} className="flex gap-2">
                <dt className="text-muted-foreground">{label}:</dt>
                <dd className="font-mono text-xs break-all">{value}</dd>
              </div>
            ))}
            {decision?.importedInvoiceId ? (
              <div className="flex gap-2 md:col-span-2">
                <dt className="text-muted-foreground">Faktura z KSeF zapisana w FaktWay:</dt>
                <dd className="font-mono text-xs break-all">
                  <Link href={`/admin/ksef/${decision.importedInvoiceId}`} className="hover:underline">{decision.importedInvoiceId}</Link>
                </dd>
              </div>
            ) : null}
          </dl>
        );
      })}
      {importedOriginal && (importedOriginal.noSession || importedOriginal.noDate) ? (
        <div className="space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          {importedOriginal.noSession ? <p>{M.noSession(nrK)}</p> : null}
          {importedOriginal.noDate ? <p>{M.noDate(nrK)}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Karta faktury dla operatora: stan, historia wysyłek, ślad audytu, akcje (PR 3c).
 * D-A4-1b-3 PR B: decyzja klienta przy 440 i ślad powiadomień w sekcji `original_check`.
 * PR C: sekcja „Zapis oryginału” (ocena pliku, oferta, oddanie, I3K) i przyciski przeglądu pliku.
 */
export default async function AdminKsefInvoicePage(props: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await props.params;
  const data = await getInvoiceLifecycle(id);
  if (!data) notFound();
  // A5 (00150): każde wykonanie joba wysyłki i odmowa przed kolejką — także porażki sprzed wysłania pliku.
  const attempts = await listInvoiceAttempts(id);
  const { invoice, submissions, audit, openSent, evidence, resendFacts, environment, duplicateDecision, duplicateNotice, originalRecordable } = data;
  // Chwila odczytu dla reguły 24 h „Przypomnij klientowi” — ta sama w renderze serwera i klienta.
  const now = new Date();

  return (
    <div className="space-y-8">
      <div>
        <Link href="/admin/ksef" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Cykl życia
        </Link>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tighter-display">
          {invoice.internalNumber ?? invoice.id}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {invoice.tenantName ?? invoice.tenantId}
          {invoice.tenantNip ? ` · NIP ${invoice.tenantNip}` : ''}
          {' · '}
          <Link href={`/invoices/${invoice.id}`} className="hover:underline">widok klienta</Link>
        </p>
      </div>

      <section className="rounded-2xl border border-glass-border bg-foreground/3 p-5 backdrop-blur-glass">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Status" value={invoice.ksefStatus} mono />
          <Field label="Kod błędu" value={invoice.errorCode ? `${invoice.errorCode}${invoice.errorClass ? ` (${invoice.errorClass})` : ''}` : null} mono />
          <Field label="Rodzaj" value={`${invoice.invoiceType ?? '—'} / ${invoice.invoiceKind ?? 'regular'} / ${invoice.direction ?? '—'}`} mono />
          <Field label="Data wystawienia" value={invoice.issueDate} />
          <Field label="Numer KSeF" value={invoice.ksefNumber} mono />
          <Field label="Środowisko" value={invoice.ksefEnvironment} mono />
          <Field label="Przejęcie (owner)" value={invoice.sendOwner} mono />
          <Field label="Prób wysyłki" value={invoice.submissionAttempts} />
          <Field label="Wysłana do KSeF" value={when(invoice.submittedToKsefAt)} />
          <Field label="Ostatnia próba" value={when(invoice.lastAttemptAt)} />
          <Field label="Zmiana wiersza" value={when(invoice.updatedAt)} />
          <Field label="Plik XML" value={invoice.xmlStoragePath} mono />
        </dl>
        {invoice.lastError ? (
          <p className="mt-4 rounded-xl bg-red-500/5 border border-red-500/20 p-3 text-sm">{invoice.lastError}</p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>dowód kontaktu z KSeF: <strong>{evidence ? 'TAK' : 'nie'}</strong></span>
          <span>otwarty wpis sent / zamiar intent: <strong>{openSent ? 'TAK' : 'nie'}</strong></span>
          <span>dane do ponownej wysyłki: <strong>{resendFacts.sendData === 'stored' ? 'zapisane' : 'brak'}</strong></span>
          <span>rodzaj wstrzymany w tym środowisku: <strong>{resendFacts.kindHeld ? 'TAK' : 'nie'}</strong></span>
          <span>data wystawienia minęła (dokument specjalny): <strong>{resendFacts.issueDatePassed ? 'TAK' : 'nie'}</strong></span>
          <span>KSEF_ENV aplikacji: <strong>{environment ?? 'nieustawione'}</strong></span>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Akcje operatora</h2>
        <OperatorActions
          invoiceId={invoice.id}
          internalNumber={invoice.internalNumber}
          direction={invoice.direction}
          status={invoice.ksefStatus}
          errorCode={invoice.errorCode}
          invoiceKind={invoice.invoiceKind}
          openSent={openSent}
          evidence={evidence}
          facts={resendFacts}
          environmentKnown={environment !== null}
          environment={environment}
          duplicateDecision={duplicateDecision}
          duplicateNotice={duplicateNotice}
          originalRecordable={originalRecordable}
          now={now}
        />
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold text-lg">
          Próby wysyłki (dziennik prób)
          {attempts.total !== null && attempts.total > attempts.rows.length
            ? ` — ${attempts.rows.length} najnowszych z ${attempts.total}`
            : ''}
        </h2>
        <p className="text-xs text-muted-foreground">
          Każde wykonanie joba wysyłki i każda odmowa przed kolejką, także błędy sprzed wysłania pliku do KSeF.
          Dziennik działa od migracji 00150 — wcześniejsze próby są tylko w historii niżej i w audycie.
        </p>
        {attempts.problem ? (
          <p className="text-sm text-red-700 dark:text-red-400">{attempts.problem}</p>
        ) : attempts.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Brak wpisów w dzienniku prób.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-glass-border bg-foreground/3 backdrop-blur-glass">
            <table className="w-full text-sm">
              <thead className="border-b border-glass-border">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Start</th>
                  <th className="px-4 py-2.5 font-medium">Rodzaj</th>
                  <th className="px-4 py-2.5 font-medium">Etap</th>
                  <th className="px-4 py-2.5 font-medium">Kod</th>
                  <th className="px-4 py-2.5 font-medium">Wykonanie</th>
                  <th className="px-4 py-2.5 font-medium">Komunikat</th>
                  <th className="px-4 py-2.5 font-medium">Próba / job</th>
                </tr>
              </thead>
              <tbody>
                {attempts.rows.map((a) => (
                  <tr key={a.id} className="border-b border-glass-border last:border-0">
                    <td className="px-4 py-2.5 text-xs tabular-nums">{when(a.startedAt)}</td>
                    <td className="px-4 py-2.5 text-xs">
                      {STATUS_LABELS[effectiveStatus(a, now)]}
                      {a.result ? <div className="font-mono text-muted-foreground">{a.result}</div> : null}
                    </td>
                    <td className="px-4 py-2.5 text-xs">{STAGE_LABELS[a.stage] ?? a.stage}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {a.errorCode ?? '—'}
                      {a.httpStatus ? <div className="text-muted-foreground">HTTP {a.httpStatus}</div> : null}
                    </td>
                    <td className="px-4 py-2.5 text-xs">{a.status === 'refused' ? '—' : `#${a.execution + 1}`}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground break-words">{attemptMessage(a, now) ?? ''}</td>
                    <td className="px-4 py-2.5 font-mono text-xs break-all">
                      {a.sendAttemptId ? a.sendAttemptId.slice(0, 8) : '—'}
                      {a.jobId ? <div className="text-muted-foreground">{a.jobId.slice(0, 8)}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Historia wysyłek (ksef_submissions)</h2>
        {submissions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Brak wpisów — żadna wysyłka nie dotarła do KSeF.</p>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-glass-border bg-foreground/3 backdrop-blur-glass">
            <table className="w-full text-sm">
              <thead className="border-b border-glass-border">
                <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Próba</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Sesja</th>
                  <th className="px-4 py-2.5 font-medium">Referencja</th>
                  <th className="px-4 py-2.5 font-medium">Błąd</th>
                  <th className="px-4 py-2.5 font-medium">Zamknięta</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((s) => (
                  <tr key={s.id} className="border-b border-glass-border last:border-0">
                    <td className="px-4 py-2.5 text-xs tabular-nums">{when(s.attemptedAt)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{s.status ?? '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs break-all">{s.sessionReferenceNumber ?? '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs break-all">{s.invoiceReferenceNumber ?? '—'}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {s.errorCode ? <span className="font-mono">{s.errorCode} </span> : null}
                      {s.errorMessage ?? ''}
                    </td>
                    <td className="px-4 py-2.5 text-xs tabular-nums">{when(s.completedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <OriginalImportSection data={data} />

      {submissions.some((s) => s.originalCheck) && (
        <section className="space-y-3">
          <h2 className="font-semibold text-lg">Oryginał z KSeF przy duplikacie 440 (original_check)</h2>
          {submissions.filter((s) => s.originalCheck).map((s) => {
            const c = s.originalCheck!;
            const open = s.status === 'sent' || s.status === 'intent';
            const fields: Array<[string, string | null]> = [
              ['Numer KSeF oryginału', s.originalKsefNumber],
              ['Wpis próby', `${s.status ?? '—'}${open ? ' (otwarty — bieżący)' : ' (zamknięty — historyczny)'}`],
              ['Powód', c.reason],
              // D-A4-1b-3 PR B (00148): decyzja klienta na zamkniętym wpisie number_taken.
              ['Decyzja', c.decision
                ? `${c.decision.choice === 'same_sale' ? 'ta sama sprzedaż' : 'inna sprzedaż'} · ${c.decision.via === 'operator' ? 'zapisał operator' : 'klient'} · ${when(c.decision.at)}`
                : null],
              // Powiadomienie „czeka na Twoją decyzję” dla otwartego znacznika tego numeru KSeF.
              ['Powiadomienie klienta', open && duplicateNotice && s.originalKsefNumber === duplicateNotice.ksefNumber
                ? `${duplicateNotice.count} × · ostatnie: ${when(duplicateNotice.lastAt)}`
                : null],
              ['Ostatnie nieudane sprawdzenie', c.recheck ? `${c.recheck.reason}${c.recheck.httpStatus ? ` (HTTP ${c.recheck.httpStatus})` : ''}, ${when(c.recheck.checkedAt)}` : null],
              ['Środowisko', c.env],
              ['Sprawdzono', when(c.checkedAt)],
              ['Numer faktury (P_2)', c.summary?.number ?? null],
              ['Data wystawienia (P_1)', c.summary?.issueDate ?? null],
              ['Nabywca', [c.summary?.buyerName, c.summary?.buyerNip].filter(Boolean).join(', ') || null],
              ['Brutto', c.summary?.gross ? `${c.summary.gross} ${c.summary.currency ?? ''}` : null],
              ['Program', c.summary?.systemInfo ?? null],
              ['Data nadania numeru', c.acquiredAt],
              ['Treść jak nasza (poza nagłówkiem)', c.sameContentExceptHeader === null ? null : c.sameContentExceptHeader ? 'tak' : 'nie'],
              ['W historii tej faktury', c.ownHistory === null ? null : c.ownHistory ? 'tak' : 'nie'],
              ['HTTP odmowy pobrania', c.httpStatus === null ? null : String(c.httpStatus)],
              ['Faktura w FaktWay z tym numerem KSeF', c.knownInvoice ? `${c.knownInvoice.internalNumber ?? 'bez numeru'} (${c.knownInvoice.id})` : null],
              ['SHA-256 oryginału', c.sha256],
              ['Archiwum', c.archivePath],
            ];
            return (
              <dl key={s.id} className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 rounded-2xl border border-glass-border bg-foreground/3 p-4 text-sm">
                {fields.filter(([, v]) => v).map(([label, value]) => (
                  <div key={label} className="flex gap-2">
                    <dt className="text-muted-foreground">{label}:</dt>
                    <dd className="font-mono text-xs break-all">{value}</dd>
                  </div>
                ))}
              </dl>
            );
          })}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-semibold text-lg">Ślad audytu (ostatnie 50)</h2>
        {audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">Brak wpisów.</p>
        ) : (
          <ul className="space-y-2">
            {audit.map((a) => (
              <li key={a.id} className="rounded-xl border border-glass-border bg-foreground/3 px-4 py-2.5 text-sm">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-mono text-xs">{a.action}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{when(a.createdAt)}</span>
                  <span className="text-xs text-muted-foreground font-mono">{a.userId ? `user ${a.userId.slice(0, 8)}…` : 'system'}</span>
                </div>
                {a.details ? (
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
                    {JSON.stringify(a.details)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
