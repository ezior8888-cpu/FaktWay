import 'server-only';

import { requireAdmin } from '@/lib/auth/admin-guard';
import { collectPlatformOverviewMetrics, type PlatformOverviewMetrics } from '@/lib/analytics/platform-metrics';
import { getFunnelWeekly, type FunnelWeekRow } from '@/lib/observability/business-metrics';

export type AdminOverviewMetrics = PlatformOverviewMetrics;

/** Odczyt dla panelu admina: autoryzacja przed dostępem do metryk wszystkich firm. */
export async function getAdminOverviewMetrics(): Promise<AdminOverviewMetrics> {
  await requireAdmin();
  return collectPlatformOverviewMetrics();
}

/** Lejek firm dla panelu admina: autoryzacja przed odczytem kluczem serwisowym. */
export async function getAdminFunnelWeekly(): Promise<FunnelWeekRow[]> {
  await requireAdmin();
  return getFunnelWeekly();
}
