/**
 * Business metrics aggregator (Faza 27).
 *
 * Używane przez Daily summary cron (06:00 PL) + Weekly review cron (Mon 09:00 PL).
 * Każda funkcja przyjmuje period (dni) i zwraca agregat in-memory — żaden cache,
 * cronów jest 2 dziennie/tydzień, freshness > performance.
 */

import { MONTHLY_NET_PLN } from '@/lib/billing/pricing';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { createAdminClient } from '@/lib/supabase/admin';
import { roundToCents } from '@/lib/xml/invoice-calculator';

export interface DailyMetrics {
  /** ISO date range. */
  period: { from: string; to: string };

  // Acquisition
  signups: number;
  newTenants: number;

  // Activation
  onboardingCompletions: number;
  firstInvoiceCount: number;

  // Operations
  invoicesIssued: number;
  invoicesAccepted: number;
  invoicesFailed: number;
  invoicesOfflineQueued: number;
  ocrJobsCompleted: number;

  // KSeF health
  ksefDowntimeMinutes: number;
  ksefMaxConsecutiveFailures: number;

  // Errors
  totalAuditErrors: number;
  totalInngestFailures: number;

  // Billing (Faza 25)
  paymentsSucceeded: number;
  paymentsFailed: number;
  paymentsTotalGrossPln: number;
}

export async function getDailyMetrics(hours = 24): Promise<DailyMetrics> {
  const supabase = createAdminClient();
  const now = new Date();
  const fromIso = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
  const toIso = now.toISOString();

  // Wszystkie liczniki paralel — nie czekamy 10 zapytań sekwencyjnie.
  const [
    tenantsRes,
    invoicesRes,
    acceptedRes,
    failedRes,
    offlineRes,
    ocrRes,
    healthRes,
    inngestFailRes,
    paymentsRes,
    paymentsFailedRes,
  ] = await Promise.all([
    supabase
      .from('tenants')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', fromIso),
    // Faktury wystawione W FaktWay: bez sprzedaży pobranej z historii KSeF
    // (`origin = ksef_import`, decyzja Bartosza 22.10.2026). `origin` jest
    // NOT NULL (00065), więc `neq` niczego nie gubi.
    supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('direction', 'outgoing')
      .neq('origin', 'ksef_import')
      .gte('created_at', fromIso),
    supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('direction', 'outgoing')
      .neq('origin', 'ksef_import')
      .eq('ksef_status', 'accepted')
      .gte('created_at', fromIso),
    supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .in('ksef_status', ['failed', 'rejected'])
      .gte('created_at', fromIso),
    supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('ksef_status', 'offline_queued'),
    supabase
      .from('ocr_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('created_at', fromIso),
    supabase
      .from('ksef_health_log')
      .select('level, response_time_ms, consecutive_failures, recorded_at')
      .gte('recorded_at', fromIso)
      .order('recorded_at', { ascending: true }),
    supabase
      .from('inngest_run_log')
      .select('id', { count: 'exact', head: true })
      .in('status', ['error', 'failed'])
      .gte('created_at', fromIso),
    supabase
      .from('stripe_payments')
      .select('amount_cents, status')
      .eq('status', 'succeeded')
      .gte('paid_at', fromIso),
    supabase
      .from('stripe_payments')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed')
      .gte('created_at', fromIso),
  ]);

  // KSeF downtime — sumujemy minuty spędzone w `down` level.
  const healthRows = (healthRes.data ?? []) as Array<{
    level: 'operational' | 'degraded' | 'down';
    response_time_ms: number | null;
    consecutive_failures: number;
    recorded_at: string;
  }>;

  let ksefDowntimeMs = 0;
  let maxConsecutiveFailures = 0;
  for (let i = 0; i < healthRows.length; i++) {
    const cur = healthRows[i]!;
    if (cur.consecutive_failures > maxConsecutiveFailures) {
      maxConsecutiveFailures = cur.consecutive_failures;
    }
    if (cur.level === 'down') {
      const next = healthRows[i + 1];
      const endMs = next ? new Date(next.recorded_at).getTime() : Date.now();
      ksefDowntimeMs += endMs - new Date(cur.recorded_at).getTime();
    }
  }

  // Sumuj gross w PLN (cents → PLN).
  const payments = (paymentsRes.data ?? []) as Array<{ amount_cents: number }>;
  const totalGrossCents = payments.reduce((s, p) => s + (p.amount_cents ?? 0), 0);

  // Signups: liczba nowych userów = approximation z nowych tenantów (każdy
  // onboarding kończy się tenant). `auth.users.created_at` wymagałoby
  // pełnego listUsers — w MVP wystarczy proxy.
  const newTenants = tenantsRes.count ?? 0;
  const signups = newTenants;

  return {
    period: { from: fromIso, to: toIso },
    signups,
    newTenants,
    // Onboarding completion = same value bo create org JEST ukończeniem onboardingu.
    onboardingCompletions: newTenants,
    // First invoice — proxy: tenants którzy mają invoice po onboardingu.
    // Pełna logika "first ever invoice for tenant" wymagałaby JOIN — pomijamy.
    firstInvoiceCount: 0,
    invoicesIssued: invoicesRes.count ?? 0,
    invoicesAccepted: acceptedRes.count ?? 0,
    invoicesFailed: failedRes.count ?? 0,
    invoicesOfflineQueued: offlineRes.count ?? 0,
    ocrJobsCompleted: ocrRes.count ?? 0,
    ksefDowntimeMinutes: Math.round(ksefDowntimeMs / 60000),
    ksefMaxConsecutiveFailures: maxConsecutiveFailures,
    totalAuditErrors: 0, // Reserved — będzie z Sentry API w Faza 27 follow-up
    totalInngestFailures: inngestFailRes.count ?? 0,
    paymentsSucceeded: payments.length,
    paymentsFailed: paymentsFailedRes.count ?? 0,
    paymentsTotalGrossPln: Math.round(totalGrossCents / 100),
  };
}

// ─── Weekly metrics ────────────────────────────────────────────────

export interface WeeklyMetrics extends DailyMetrics {
  // Business
  mrrPln: number;
  activeSubscriptions: number;
  trialingSubscriptions: number;
  churnedSubscriptions: number;
  arpu: number; // Average Revenue Per User w PLN
}

export async function getWeeklyMetrics(): Promise<WeeklyMetrics> {
  const daily = await getDailyMetrics(7 * 24);

  const supabase = createAdminClient();

  // Liczby subskrypcji liczy baza (AUD-106) — wcześniej wszystkie wiersze
  // active/trialing trafiały do pamięci, bez limitu.
  const { active, trialing, monthlyCount, annualCount } = await readSubscriptionCounts(supabase);

  // MRR netto z jednej ceny (lib/billing/pricing.ts). Plan roczny wycofany —
  // ewentualne starsze subskrypcje roczne liczymy po tej samej stawce.
  const mrrPln = roundToCents((monthlyCount + annualCount) * MONTHLY_NET_PLN);

  // Churn — canceled w ostatnich 7 dniach.
  const fromIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const churnRes = (await (supabase as unknown as {
    from: (n: string) => {
      select: (c: string, opts: { count: 'exact'; head: true }) => {
        eq: (k: string, v: string) => {
          gte: (k: string, v: string) => Promise<{ count: number | null }>;
        };
      };
    };
  })
    .from('subscriptions')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'canceled')
    .gte('canceled_at', fromIso));

  const churnedSubscriptions = churnRes.count ?? 0;

  const arpu = active > 0 ? Math.round(mrrPln / active) : 0;

  return {
    ...daily,
    mrrPln,
    activeSubscriptions: active,
    trialingSubscriptions: trialing,
    churnedSubscriptions,
    arpu,
  };
}

type CountQuery = {
  eq(column: string, value: string): CountQuery;
} & PromiseLike<{ count: number | null; error: { message: string } | null }>;

/** Liczby subskrypcji zapytaniami `count` — bez pobierania wierszy (AUD-106). */
export async function readSubscriptionCounts(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<{ active: number; trialing: number; monthlyCount: number; annualCount: number }> {
  const count = async (status: string, plan?: string): Promise<number> => {
    let query = (supabase as unknown as {
      from(table: string): { select(columns: string, options: { count: 'exact'; head: true }): CountQuery };
    })
      .from('subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('status', status);
    if (plan) query = query.eq('plan', plan);
    const { count: n, error } = await query;
    if (error || n === null) throw new Error(`Liczba subskrypcji niedostępna: ${error?.message ?? 'brak'}`);
    return n;
  };
  const [monthlyCount, annualCount, trialing] = await Promise.all([
    count('active', 'monthly'),
    count('active', 'annual'),
    count('trialing'),
  ]);
  return { active: monthlyCount + annualCount, trialing, monthlyCount, annualCount };
}

// ─── Lejek firm ────────────────────────────────────────────────────

/** Jeden wiersz `admin_funnel_weekly` (00161): `source` to `all` albo kanał z listy. */
export interface FunnelWeekRow {
  /** Poniedziałek tygodnia założenia firmy (RRRR-MM-DD, czas Warszawy). */
  weekStart: string;
  source: string;
  newTenants: number;
  ksefConnected: number;
  firstInvoice: number;
  trialStarted: number;
  paying: number;
  churned: number;
}

export const FUNNEL_WEEKS = 12;

/**
 * Lejek z własnej bazy, niezależny od PostHoga i zgód. Liczy SQL, bo produkcja
 * ucina odpowiedzi do 1000 wierszy, a firm będzie więcej. Bez sesji: odczyt dla
 * człowieka idzie przez `getAdminFunnelWeekly` z lib/admin/metrics.
 */
export async function getFunnelWeekly(weeks = FUNNEL_WEEKS): Promise<FunnelWeekRow[]> {
  // „KSeF podłączony” liczy się w środowisku aplikacji, tak jak hasConfiguredKsefProof.
  const { data, error } = await createAdminClient().rpc('admin_funnel_weekly', {
    p_weeks: weeks,
    p_environment: configuredKsefEnvironment(),
  });
  if (error) throw new Error(`Lejek niedostępny: ${error.message}`);
  const rows = (data ?? []) as Array<{
    week_start: string;
    source: string;
    new_tenants: number;
    ksef_connected: number;
    first_invoice: number;
    trial_started: number;
    paying: number;
    churned: number;
  }>;
  return rows.map((row) => ({
    weekStart: row.week_start,
    source: row.source,
    newTenants: row.new_tenants,
    ksefConnected: row.ksef_connected,
    firstInvoice: row.first_invoice,
    trialStarted: row.trial_started,
    paying: row.paying,
    churned: row.churned,
  }));
}
