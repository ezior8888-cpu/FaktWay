import {
  OverdueDashboard,
  OverdueDashboardError,
} from '@/components/reminders/overdue-dashboard';
import { createClient } from '@/lib/supabase/server';
import { getDashboardOrgSwitcherProps } from '@/lib/dashboard-shell-data';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { canChangeInvoicePayment } from '@/lib/invoices/manual-payment';
import { loadOverdueOverview } from '@/lib/overdue/load-overdue';

export const dynamic = 'force-dynamic';

export default async function OverduePage() {
  // The dashboard layout already validates membership. Reuse its cached,
  // validated active organization instead of trusting a cookie alone.
  const { activeOrgId: tenantId, memberships } = await getDashboardOrgSwitcherProps();
  // „Ustawienia przypomnień” prowadzą na stronę tylko dla właściciela
  // (`getPageContextWithRole('owner')` w /settings/reminders).
  const activeRole = memberships?.find((membership) => membership.isActive)?.role;
  const isOwner = activeRole === 'owner';
  const supabase = await createClient();
  const environment = requireConfiguredKsefEnvironment();

  // Lista, jej sprawdzenia i stan przypomnień: `lib/overdue/load-overdue.ts`
  // (ta sama dla telefonu, `GET /api/mobile/v1/naleznosci`).
  const overview = await loadOverdueOverview(supabase, tenantId, environment);
  if (!overview.ok) {
    return <OverdueDashboardError message={overview.error} />;
  }
  const { invoices: overdueInvoices, limitReached, sentThisMonth } = overview;

  const totalAmountDue = overdueInvoices.reduce((sum, inv) => sum + inv.amount_due, 0);

  const avgDaysOverdue = overdueInvoices.length
    ? Math.round(
        overdueInvoices.reduce((sum, inv) => sum + inv.days_overdue, 0) /
          overdueInvoices.length,
      )
    : 0;

  return (
    <OverdueDashboard
      overdueInvoices={overdueInvoices}
      stats={{
        totalCount: overdueInvoices.length,
        totalAmount: totalAmountDue,
        avgDaysOverdue,
        pausedCount: overdueInvoices.filter((invoice) => invoice.reminders_paused).length,
        sentThisMonth,
      }}
      limitReached={limitReached}
      canManageSettings={isOwner}
      canMarkPaid={canChangeInvoicePayment(activeRole)}
    />
  );
}
