import type { SupabaseClient } from '@supabase/supabase-js';
import type { KsefEnvironment } from '@/types/ksef';

/** Stały stan (są przyjęte faktury bez środowiska), nie awaria odczytu: wołający pokazuje komunikat z wyjściem. */
export class AcceptedInvoiceEnvironmentIncompleteError extends Error {
  constructor() {
    super('Accepted invoices require KSeF environment reconciliation');
    this.name = 'AcceptedInvoiceEnvironmentIncompleteError';
  }
}

/**
 * An environment filter alone could silently omit historical production
 * invoices whose provenance is NULL. Block a legal read until the whole
 * requested period has a verified environment, then apply the filter.
 * The caller supplies either a tenant-scoped session client or a trusted
 * admin client with an explicit tenant filter.
 */
export async function assertAcceptedInvoiceEnvironmentComplete(
  client: SupabaseClient,
  params: {
    tenantId: string;
    periodStart: string;
    periodEnd: string;
    direction: 'outgoing' | 'incoming' | 'both';
    environment: KsefEnvironment;
  },
): Promise<void> {
  let query = client.from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', params.tenantId)
    .eq('ksef_status', 'accepted')
    .or(`ksef_environment.is.null,ksef_environment.neq.${params.environment}`)
    .gte('issue_date', params.periodStart)
    .lte('issue_date', params.periodEnd);
  if (params.direction !== 'both') query = query.eq('direction', params.direction);

  const { count, error } = await query;
  if (error || typeof count !== 'number') {
    throw new Error('KSeF environment reconciliation check is unavailable');
  }
  if (count > 0) {
    throw new AcceptedInvoiceEnvironmentIncompleteError();
  }
}
