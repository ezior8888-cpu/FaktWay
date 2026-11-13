import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { findActiveMembership } from '@/lib/api/mobile/auth';
import type { FirmaKonta, KontoOdpowiedz, RolaWFirmie } from '@/lib/api/mobile/kontrakt';
import { MobileUpstreamError } from '@/lib/api/mobile/responses';

/**
 * Konto zalogowanego w telefonie: firmy z aktywnym członkostwem i ta, od
 * której aplikacja zaczyna (plan aplikacji mobilnej, M6; z tego M7 bierze
 * firmę do nagłówka `X-Active-Org` i do karty konta w Więcej).
 *
 * Czyta token klienta (RLS): `memberships_select_self_or_org` (00058) daje
 * jego członkostwa, `tenants_select_member_of` (00037) nazwy jego firm,
 * `users_select_self_or_org_member` jego `last_active_tenant_id`.
 */

/** Najwięcej firm na liście; biuro rachunkowe z większą liczbą wybierze resztę na stronie. */
export const MOBILE_FIRM_LIMIT = 500;

/**
 * Kolejność jak wybór firmy w proxy strony (najpóźniej dołączona pierwsza),
 * `wszystkie: false` ponad `MOBILE_FIRM_LIMIT`.
 */
export type MobileAccountFirms = Pick<KontoOdpowiedz, 'firmy' | 'wszystkie' | 'aktywnaFirma'>;

interface MembershipRow {
  organization_id: string;
  role: string;
  tenants: { name: string | null; nip: string | null } | Array<{ name: string | null; nip: string | null }> | null;
}

export async function readMobileAccountFirms(db: SupabaseClient, userId: string): Promise<MobileAccountFirms> {
  const [memberships, profile] = await Promise.all([
    db
      .from('memberships')
      .select('organization_id, role, joined_at, tenants:organization_id(name, nip)')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('joined_at', { ascending: false })
      .order('organization_id', { ascending: true })
      .limit(MOBILE_FIRM_LIMIT + 1),
    db.from('users').select('last_active_tenant_id').eq('id', userId).maybeSingle(),
  ]);
  if (memberships.error) throw new MobileUpstreamError('memberships');
  if (profile.error) throw new MobileUpstreamError('users');

  const rows = (memberships.data ?? []) as MembershipRow[];
  const firmy = rows.slice(0, MOBILE_FIRM_LIMIT).map((row): FirmaKonta => {
    const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
    return {
      id: row.organization_id,
      nazwa: tenant?.name?.trim() || '(bez nazwy)',
      nip: tenant?.nip ?? '',
      rola: row.role as RolaWFirmie,
    };
  });

  const lastActive = (profile.data as { last_active_tenant_id?: unknown } | null)?.last_active_tenant_id;
  const preferred = typeof lastActive === 'string' ? firmy.find((firma) => firma.id === lastActive) : undefined;
  return {
    firmy,
    wszystkie: rows.length <= MOBILE_FIRM_LIMIT,
    aktywnaFirma: preferred?.id ?? firmy[0]?.id ?? null,
  };
}

/**
 * Sama firma, od której aplikacja zaczyna (ta sama reguła co `aktywnaFirma`
 * wyżej), bez całej listy: wpis logowania (`lib/api/mobile/sesja.ts`)
 * potrzebuje tylko jej identyfikatora, a biuro rachunkowe ma setki firm.
 */
export async function readMobileActiveFirm(db: SupabaseClient, userId: string): Promise<string | null> {
  const [profile, newest] = await Promise.all([
    db.from('users').select('last_active_tenant_id').eq('id', userId).maybeSingle(),
    db
      .from('memberships')
      .select('organization_id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('joined_at', { ascending: false })
      .order('organization_id', { ascending: true })
      .limit(1),
  ]);
  if (profile.error) throw new MobileUpstreamError('users');
  if (newest.error) throw new MobileUpstreamError('memberships');
  const lastActive = (profile.data as { last_active_tenant_id?: unknown } | null)?.last_active_tenant_id;
  if (typeof lastActive === 'string' && (await findActiveMembership(db, userId, lastActive))) return lastActive;
  const row = (newest.data ?? [])[0] as { organization_id?: unknown } | undefined;
  return typeof row?.organization_id === 'string' ? row.organization_id : null;
}
