import Link from 'next/link';
import {
  ActivitySquare,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  CloudOff,
  FileText,
  Inbox,
  LifeBuoy,
  type LucideIcon,
  Mail,
  Send,
  ShieldCheck,
  Users,
} from 'lucide-react';

import { countLifecycleViolations } from '@/lib/admin/ksef-lifecycle';
import { getAdminFunnelWeekly, getAdminOverviewMetrics } from '@/lib/admin/metrics';
import { cn } from '@/lib/utils';

import { FunnelCard } from './_components/funnel-card';

export const dynamic = 'force-dynamic';

function fmt(n: number): string {
  return n.toLocaleString('pl-PL');
}

export default async function AdminDashboardPage() {
  const metrics = await getAdminOverviewMetrics();
  // Strażnik cyklu życia (00131) — brak funkcji na starej bazie nie może wyłączyć panelu.
  const lifecycleViolations = await countLifecycleViolations().catch(() => null);
  // To samo dla lejka (00161): brak funkcji albo błąd bazy nie wyłącza panelu.
  const funnel = await getAdminFunnelWeekly().catch(() => null);

  const ksef = metrics.ksefHealth;
  const ksefLevel = ksef?.level ?? 'unknown';

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl font-semibold tracking-tighter-display">
          Operations Center
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Stan platformy w czasie rzeczywistym. Kliknij sekcję żeby zejść w
          szczegóły.
        </p>
      </header>

      {/* Hero KPIs — najczęstsze pytania operatora */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          icon={Users}
          label="Userzy"
          value={fmt(metrics.totalUsers)}
          sublabel={`+${fmt(metrics.signups24h)} w ostatnich 24h`}
          tone="default"
        />
        <Kpi
          icon={ShieldCheck}
          label="Aktywne organizacje"
          value={fmt(metrics.activeTenants)}
          // Firm z flagą `deleted_at` nic nie usuwa ani nie blokuje (przegląd 15.10.2026) —
          // te firmy działają dalej, a ich właściciele mogą myśleć, że je usunęli.
          sublabel={`${fmt(metrics.deletedTenants)} z flagą „usunięta” — działają dalej`}
          tone="default"
        />
        <Kpi
          icon={Send}
          label="Faktury wysłane 24h"
          value={fmt(metrics.invoicesIssued24h)}
          sublabel={`${fmt(metrics.invoicesAccepted24h)} zaakceptowanych przez KSeF`}
          tone="default"
        />
        <Kpi
          icon={CloudOff}
          label="Offline24 queue"
          value={fmt(metrics.offlineQueued)}
          sublabel={
            metrics.offlineQueued > 0
              ? 'Czekają na recovery — sprawdź KSeF health'
              : 'Wszystko płynie do KSeF'
          }
          tone={metrics.offlineQueued > 0 ? 'warning' : 'success'}
        />
      </section>

      {/* KSeF health — istotne na pierwszy rzut oka */}
      <KsefHealthCard
        level={ksefLevel}
        responseTimeMs={ksef?.responseTimeMs ?? null}
        consecutiveFailures={ksef?.consecutiveFailures ?? 0}
        isMfOutage={ksef?.isMfOutage ?? false}
        lastCheckedAt={ksef?.lastCheckedAt ?? null}
      />

      <FunnelCard rows={funnel} />

      {/* Quick navigation tiles */}
      <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <NavTile
          href="/admin/users"
          icon={Users}
          title="Użytkownicy"
          description="Lista, search po email/NIP, suspend/reset, notatki."
          metric={`${fmt(metrics.totalUsers)} kont`}
        />
        <NavTile
          href="/admin/system"
          icon={ActivitySquare}
          title="System"
          description="KSeF health 24h, Inngest jobs, R2, DB stats."
          metric={ksefLevel}
        />
        <NavTile
          href="/admin/ksef"
          icon={Send}
          title="KSeF — cykl życia"
          description="Naruszenia I1–I9, faktury failed per kod, ponowna wysyłka, uzgodnienie, powrót do szkicu."
          metric={
            lifecycleViolations === null
              ? 'strażnik niedostępny'
              : lifecycleViolations > 0
                ? `${fmt(lifecycleViolations)} naruszeń`
                : 'Brak naruszeń'
          }
          tone={lifecycleViolations ? 'warning' : 'default'}
        />
        <NavTile
          href="/admin/centrum/bledy"
          icon={CircleAlert}
          title="Błędy wysyłki"
          description="Każda nieudana próba wysyłki do KSeF (dziennik prób A5): incydenty, odmowy przed kolejką, przerwane wykonania, UPO."
        />
        <NavTile
          href="/admin/support"
          icon={LifeBuoy}
          title="Support"
          description="Nowi (24h), trial endings, inactive users."
          metric={`${fmt(metrics.signups24h)} nowych dziś`}
        />
        <NavTile
          href="/admin/audit"
          icon={FileText}
          title="Audit log"
          description="Wszystkie akcje w systemie. Search po user/akcji/dacie."
        />
        <NavTile
          href="/admin/flags"
          icon={Mail}
          title="Feature flags"
          description="Per-tenant toggle modułów (Co-Pilot, Magic Import, exports)."
        />
        <NavTile
          href="/admin/users?filter=pending-join"
          icon={Inbox}
          title="Prośby o dostęp"
          description="Userzy oczekujący na zatwierdzenie do organizacji."
          metric={
            metrics.pendingJoinRequests > 0
              ? `${fmt(metrics.pendingJoinRequests)} oczekuje`
              : 'Brak'
          }
          tone={metrics.pendingJoinRequests > 0 ? 'warning' : 'default'}
        />
      </section>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────

const TONES = {
  default: '',
  success: 'border-emerald-500/30 bg-emerald-500/5',
  warning: 'border-amber-500/30 bg-amber-500/5',
  danger: 'border-red-500/30 bg-red-500/5',
} as const;

type Tone = keyof typeof TONES;

function Kpi({
  icon: Icon,
  label,
  value,
  sublabel,
  tone = 'default',
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sublabel?: string;
  tone?: Tone;
}) {
  return (
    <div
      className={cn(
        'rounded-3xl border border-glass-border bg-foreground/3 p-5 backdrop-blur-glass',
        TONES[tone],
      )}
    >
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
      </div>
      <p className="mt-2 font-display text-3xl font-semibold tracking-tighter-display">
        {value}
      </p>
      {sublabel ? (
        <p className="mt-1 text-xs text-muted-foreground">{sublabel}</p>
      ) : null}
    </div>
  );
}

function KsefHealthCard({
  level,
  responseTimeMs,
  consecutiveFailures,
  isMfOutage,
  lastCheckedAt,
}: {
  level: string;
  responseTimeMs: number | null;
  consecutiveFailures: number;
  isMfOutage: boolean;
  lastCheckedAt: string | null;
}) {
  const tone: Tone =
    level === 'operational' ? 'success' : level === 'down' ? 'danger' : 'warning';

  const Icon =
    level === 'operational'
      ? CheckCircle2
      : level === 'down'
        ? CloudOff
        : AlertTriangle;

  const label =
    level === 'operational'
      ? 'KSeF działa normalnie'
      : level === 'down'
        ? isMfOutage
          ? 'KSeF zgłasza globalną awarię (MF Outage)'
          : 'KSeF niedostępne (≥3 kolejne pingi padły)'
        : level === 'degraded'
          ? 'KSeF działa wolno lub pojedyncze pingi padają'
          : 'Brak danych — cron health monitor jeszcze nie zaktualizował';

  return (
    <section
      className={cn(
        'rounded-3xl border p-5 backdrop-blur-glass',
        TONES[tone] || 'border-glass-border bg-foreground/3',
      )}
    >
      <div className="flex items-start gap-3">
        <Icon className="h-6 w-6 shrink-0" aria-hidden />
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold">{label}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {responseTimeMs !== null ? `Ostatni ping: ${responseTimeMs}ms · ` : ''}
            {consecutiveFailures > 0
              ? `Consecutive failures: ${consecutiveFailures} · `
              : ''}
            {lastCheckedAt
              ? `Sprawdzono: ${new Date(lastCheckedAt).toLocaleTimeString('pl-PL')}`
              : 'brak pinga'}
          </p>
        </div>
      </div>
    </section>
  );
}

function NavTile({
  href,
  icon: Icon,
  title,
  description,
  metric,
  tone = 'default',
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
  metric?: string;
  tone?: Tone;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'group block rounded-3xl border border-glass-border bg-foreground/3 p-5 backdrop-blur-glass transition-colors hover:bg-foreground/5',
        TONES[tone],
      )}
    >
      <div className="flex items-center justify-between">
        <Icon className="h-5 w-5 text-muted-foreground" aria-hidden />
        <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
      <h3 className="mt-3 font-semibold text-base">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
        {description}
      </p>
      {metric ? (
        <p className="mt-3 text-xs font-medium text-foreground">{metric}</p>
      ) : null}
    </Link>
  );
}
