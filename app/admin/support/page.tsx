import { requireAdmin } from '@/lib/auth/admin-guard';
import Link from 'next/link';
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Inbox,
  MessagesSquare,
  Moon,
  UserPlus,
  UserRound,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import {
  getEscalatedConversations,
  getInactiveUsers,
  getPendingJoinRequests,
  getRecentlyFailedInvoices,
  getRecentSignups,
  getSupportConversations,
  type AdminSupportConversation,
  type FailedInvoice,
  type InactiveUser,
  type PendingJoinRequest,
  type RecentSignup,
} from '@/lib/admin/support';

export const dynamic = 'force-dynamic';

const SIGNUPS_WINDOW_HOURS = 24;
const INACTIVE_DAYS = 14;
const FAILED_WINDOW_HOURS = 24;

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pl-PL', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtRelative(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m temu`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h temu`;
  const d = Math.floor(h / 24);
  return `${d}d temu`;
}

export default async function AdminSupportPage() {
  await requireAdmin();

  const [signups, inactive, failed, pendingJoins, conversations, escalated] =
    await Promise.all([
      getRecentSignups(SIGNUPS_WINDOW_HOURS),
      getInactiveUsers(INACTIVE_DAYS),
      getRecentlyFailedInvoices(FAILED_WINDOW_HOURS),
      getPendingJoinRequests(),
      getSupportConversations(25),
      getEscalatedConversations(),
    ]);

  // Onboarding completion rate (z 24h signups)
  const completionPct =
    signups.length > 0
      ? Math.round(
          (signups.filter((s) => s.hasOrganization).length / signups.length) * 100,
        )
      : null;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tighter-display">
          Support
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Codzienne operacje. Każdy widget pokazuje rzeczy wymagające uwagi
          w ostatnich godzinach.
        </p>
      </header>

      {/* Summary KPIs */}
      <section className="grid gap-3 sm:grid-cols-4">
        <Kpi
          icon={UserPlus}
          label={`Rejestracje ${SIGNUPS_WINDOW_HOURS}h`}
          value={String(signups.length)}
          sublabel={
            completionPct !== null
              ? `${completionPct}% ukończyło onboarding`
              : 'Brak nowych w tym oknie'
          }
        />
        <Kpi
          icon={Moon}
          label={`Nieaktywni ${INACTIVE_DAYS}d`}
          value={String(inactive.length)}
          sublabel="Kandydaci do re-engagement"
          tone={inactive.length > 0 ? 'warning' : 'default'}
        />
        <Kpi
          icon={XCircle}
          label={`Faktury z błędem ${FAILED_WINDOW_HOURS}h`}
          value={String(failed.length)}
          sublabel={
            failed.length > 0
              ? 'Wymagają ręcznej diagnozy'
              : 'Wszystko idzie do KSeF'
          }
          tone={failed.length > 0 ? 'warning' : 'success'}
        />
        <Kpi
          icon={Inbox}
          label="Prośby o dostęp"
          value={String(pendingJoins.length)}
          sublabel="Userzy czekają na zatwierdzenie"
          tone={pendingJoins.length > 0 ? 'warning' : 'default'}
        />
      </section>

      {/* Recent signups */}
      <Section
        icon={UserPlus}
        title={`Rejestracje w ostatnich ${SIGNUPS_WINDOW_HOURS}h`}
        count={signups.length}
        emptyHint="Brak nowych rejestracji w tym oknie."
      >
        {signups.length > 0 && <SignupsTable signups={signups} />}
      </Section>

      {/* Recently failed invoices */}
      <Section
        icon={AlertCircle}
        title={`Faktury z błędem (${FAILED_WINDOW_HOURS}h)`}
        count={failed.length}
        emptyHint="Zero błędów KSeF w ostatnich 24h."
      >
        {failed.length > 0 && <FailedInvoicesTable items={failed} />}
      </Section>

      {/* Pending join requests */}
      <Section
        icon={Inbox}
        title="Pending join requests"
        count={pendingJoins.length}
        emptyHint="Wszystko zatwierdzone."
      >
        {pendingJoins.length > 0 && <JoinRequestsTable items={pendingJoins} />}
      </Section>

      {/* Inactive users */}
      <Section
        icon={Moon}
        title={`Nieaktywni > ${INACTIVE_DAYS} dni`}
        count={inactive.length}
        emptyHint="Wszyscy aktywni klienci logowali się ostatnio."
      >
        {inactive.length > 0 && <InactiveTable items={inactive} />}
      </Section>

      {/* Czekają na człowieka: klient widział „Odezwiemy się mailem” */}
      <Section
        icon={UserRound}
        title="Prośby o kontakt i eskalacje czatu"
        count={escalated.length}
        emptyHint="Nikt nie czeka na odpowiedź człowieka."
      >
        {escalated.length > 0 && <SupportConversationsTable items={escalated} />}
      </Section>

      {/* AI support conversations */}
      <Section
        icon={MessagesSquare}
        title="Konwersacje AI support"
        count={conversations.length}
        emptyHint="Brak konwersacji z asystentem AI."
      >
        {conversations.length > 0 && (
          <SupportConversationsTable items={conversations} />
        )}
      </Section>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────

function Kpi({
  icon: Icon,
  label,
  value,
  sublabel,
  tone = 'default',
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sublabel?: string;
  tone?: 'default' | 'warning' | 'success';
}) {
  const toneClass =
    tone === 'warning'
      ? 'border-amber-500/30 bg-amber-500/5'
      : tone === 'success'
        ? 'border-emerald-500/30 bg-emerald-500/5'
        : '';
  return (
    <div
      className={`rounded-2xl border border-glass-border bg-foreground/3 p-4 backdrop-blur-glass ${toneClass}`}
    >
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <p className="mt-1 font-display text-2xl font-semibold tracking-tighter-display tabular-nums">
        {value}
      </p>
      {sublabel ? (
        <p className="mt-1 text-xs text-muted-foreground">{sublabel}</p>
      ) : null}
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  count,
  emptyHint,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  count: number;
  emptyHint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="font-semibold text-lg flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}{' '}
        <span className="text-xs font-normal text-muted-foreground">({count})</span>
      </h2>
      {count === 0 ? (
        <EmptyState icon={CheckCircle2} title="Czysto" description={emptyHint} />
      ) : (
        children
      )}
    </section>
  );
}

function SignupsTable({ signups }: { signups: RecentSignup[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-glass-border bg-foreground/3 backdrop-blur-glass">
      <table className="w-full text-sm">
        <thead className="border-b border-glass-border">
          <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">Email</th>
            <th className="px-4 py-2.5 font-medium">Email confirmed</th>
            <th className="px-4 py-2.5 font-medium">Onboarding</th>
            <th className="px-4 py-2.5 font-medium">Zarejestrowany</th>
          </tr>
        </thead>
        <tbody>
          {signups.map((u) => (
            <tr
              key={u.userId}
              className="border-b border-glass-border last:border-0 hover:bg-foreground/5"
            >
              <td className="px-4 py-2.5">
                <Link
                  href={`/admin/users/${u.userId}`}
                  className="text-foreground hover:underline"
                >
                  {u.email ?? '(brak)'}
                </Link>
              </td>
              <td className="px-4 py-2.5">
                {u.emailConfirmed ? (
                  <Badge variant="secondary" className="gap-1 text-xs">
                    <CheckCircle2 className="h-3 w-3" />
                    Tak
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs">
                    Pending
                  </Badge>
                )}
              </td>
              <td className="px-4 py-2.5">
                {u.hasOrganization ? (
                  <span className="text-xs text-emerald-700 dark:text-emerald-400">
                    {u.primaryOrgName ?? 'Org utworzona'}
                  </span>
                ) : (
                  <span className="text-xs text-amber-700 dark:text-amber-400">
                    Zaciął się — bez org
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {fmtRelative(u.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FailedInvoicesTable({ items }: { items: FailedInvoice[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-glass-border bg-foreground/3 backdrop-blur-glass">
      <table className="w-full text-sm">
        <thead className="border-b border-glass-border">
          <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">Numer</th>
            <th className="px-4 py-2.5 font-medium">Organizacja</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Błąd</th>
            <th className="px-4 py-2.5 font-medium">Ostatnia próba</th>
          </tr>
        </thead>
        <tbody>
          {items.map((inv) => (
            <tr
              key={inv.invoiceId}
              className="border-b border-glass-border last:border-0 hover:bg-foreground/5"
            >
              <td className="px-4 py-2.5 font-mono text-xs">
                {inv.internalNumber ?? '—'}
              </td>
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-1.5">
                  <Building2 className="h-3 w-3 text-muted-foreground" />
                  <span className="text-xs">{inv.tenantName ?? '—'}</span>
                  <span className="text-xs text-muted-foreground font-mono">
                    {inv.tenantNip}
                  </span>
                </div>
              </td>
              <td className="px-4 py-2.5">
                <Badge variant="destructive" className="text-xs">
                  {inv.ksefStatus ?? '—'}
                </Badge>
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-md truncate">
                {inv.lastError ?? '—'}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {fmtRelative(inv.lastAttemptAt ?? inv.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JoinRequestsTable({ items }: { items: PendingJoinRequest[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-glass-border bg-foreground/3 backdrop-blur-glass">
      <table className="w-full text-sm">
        <thead className="border-b border-glass-border">
          <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">Wnioskujący</th>
            <th className="px-4 py-2.5 font-medium">Organizacja</th>
            <th className="px-4 py-2.5 font-medium">Wiadomość</th>
            <th className="px-4 py-2.5 font-medium">Czeka od</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr
              key={r.id}
              className="border-b border-glass-border last:border-0 hover:bg-foreground/5"
            >
              <td className="px-4 py-2.5">
                <Link
                  href={`/admin/users/${r.requesterUserId}`}
                  className="text-xs text-foreground hover:underline"
                >
                  user:{r.requesterUserId.slice(0, 8)}…
                </Link>
              </td>
              <td className="px-4 py-2.5">
                <span className="text-xs">{r.organizationName ?? '—'}</span>{' '}
                <span className="text-xs text-muted-foreground font-mono">
                  {r.organizationNip}
                </span>
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground max-w-md truncate">
                {r.message ?? <em>(brak)</em>}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {fmtRelative(r.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InactiveTable({ items }: { items: InactiveUser[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-glass-border bg-foreground/3 backdrop-blur-glass">
      <table className="w-full text-sm">
        <thead className="border-b border-glass-border">
          <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">Email</th>
            <th className="px-4 py-2.5 font-medium text-right">Dni nieaktywności</th>
            <th className="px-4 py-2.5 font-medium">Ostatnie logowanie</th>
            <th className="px-4 py-2.5 font-medium">Zarejestrowany</th>
          </tr>
        </thead>
        <tbody>
          {items.map((u) => (
            <tr
              key={u.userId}
              className="border-b border-glass-border last:border-0 hover:bg-foreground/5"
            >
              <td className="px-4 py-2.5">
                <Link
                  href={`/admin/users/${u.userId}`}
                  className="text-foreground hover:underline"
                >
                  {u.email ?? '(brak)'}
                </Link>
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {u.daysInactive}d
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {u.lastSignInAt ? fmtDate(u.lastSignInAt) : 'nigdy'}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {fmtDate(u.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SUPPORT_CATEGORY_LABELS: Record<string, string> = {
  onboarding: 'Onboarding',
  ksef: 'KSeF',
  invoicing: 'Faktury',
  ocr_kpir: 'OCR / KPiR',
  billing: 'Rozliczenia',
  team: 'Zespół',
  security: 'Bezpieczeństwo',
  other: 'Inne',
};

const ESCALATION_REASON_LABELS: Record<string, string> = {
  user_requested: 'Klient poprosił o człowieka',
  ai_uncertain: 'Czat nie znał odpowiedzi',
};

function SupportConversationsTable({
  items,
}: {
  items: AdminSupportConversation[];
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-glass-border bg-foreground/3 backdrop-blur-glass">
      <table className="w-full text-sm">
        <thead className="border-b border-glass-border">
          <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">Klient</th>
            <th className="px-4 py-2.5 font-medium">Temat</th>
            <th className="px-4 py-2.5 font-medium">Kategoria</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Powód eskalacji</th>
            <th className="px-4 py-2.5 font-medium">Ocena</th>
            <th className="px-4 py-2.5 font-medium">Rozpoczęto</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr
              key={c.id}
              className="border-b border-glass-border last:border-0 hover:bg-foreground/5"
            >
              <td className="px-4 py-2.5 text-xs">
                {c.userEmail ? (
                  <a href={`mailto:${c.userEmail}`} className="underline underline-offset-2">
                    {c.userEmail}
                  </a>
                ) : (
                  '—'
                )}
              </td>
              <td className="max-w-xs truncate px-4 py-2.5">
                {c.subject ?? '(bez tematu)'}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {c.category
                  ? (SUPPORT_CATEGORY_LABELS[c.category] ?? c.category)
                  : '—'}
              </td>
              <td className="px-4 py-2.5">
                {c.status === 'escalated' ? (
                  <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300">
                    Eskalowane
                  </Badge>
                ) : c.status === 'resolved' ? (
                  <Badge variant="outline" className="border-emerald-500/40 text-emerald-700 dark:text-emerald-300">
                    Rozwiązane
                  </Badge>
                ) : c.status === 'closed' ? (
                  <Badge variant="outline">Zamknięte</Badge>
                ) : (
                  <Badge variant="outline">Otwarte</Badge>
                )}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {c.escalationReason
                  ? (ESCALATION_REASON_LABELS[c.escalationReason] ?? c.escalationReason)
                  : '—'}
              </td>
              <td className="px-4 py-2.5">
                {c.csatPositive === null
                  ? '—'
                  : c.csatPositive
                    ? '👍'
                    : '👎'}
              </td>
              <td className="px-4 py-2.5 text-xs text-muted-foreground">
                {fmtRelative(c.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

