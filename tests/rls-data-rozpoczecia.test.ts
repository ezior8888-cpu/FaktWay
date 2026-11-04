import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { readTenantBusinessStart } from '@/lib/invoices/business-start';

import { getRlsTestEnvironment } from './helpers/rls-environment';

/**
 * 00153 na prawdziwej bazie: `tenants.business_started_on` (data rozpoczęcia
 * działalności, limit zwolnienia z VAT proporcjonalnie).
 *
 * Od 00112 rola `authenticated` czyta kolumny `tenants` tylko po jawnym
 * GRANT SELECT (AUD-103). Bez grantu w 00153 Pulpit i ustawienia dostałyby
 * 42501 i karta limitu zawsze prosiłaby o datę, choć klient ją podał.
 * Do tego CHECK z dolną granicą i izolacja firm (RLS wiersza bez zmian).
 */

const hasDatabase = Boolean(
  process.env.RLS_TEST_SUPABASE_URL?.trim() &&
    process.env.RLS_TEST_SUPABASE_ANON_KEY?.trim() &&
    process.env.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY?.trim(),
);
const environment = hasDatabase ? getRlsTestEnvironment() : null;
const admin: SupabaseClient = environment
  ? createClient(environment.url, environment.serviceRoleKey)
  : (null as unknown as SupabaseClient);

const ORG = '00153153-0000-4000-8000-000000000001';
const OTHER_ORG = '00153153-0000-4000-8000-000000000002';
const OWNER_EMAIL = 'rls-start-owner@ksef-saas.test';
const OTHER_EMAIL = 'rls-start-other@ksef-saas.test';
const PASS = 'RlsStartPass2026Aa!';

function anonClient(activeOrg: string) {
  return createClient(environment!.url, environment!.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-active-org': activeOrg } },
  });
}

async function userId(email: string): Promise<string> {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 1000) break;
  }
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASS, email_confirm: true });
  if (error || !data.user) throw error ?? new Error('createUser');
  return data.user.id;
}

async function signedIn(email: string, org: string): Promise<SupabaseClient> {
  const client = anonClient(org);
  const { error } = await client.auth.signInWithPassword({ email, password: PASS });
  if (error) throw error;
  return client;
}

describe.skipIf(!hasDatabase)('00153: data rozpoczęcia działalności na prawdziwym PostgREST', () => {
  beforeAll(async () => {
    const ownerId = await userId(OWNER_EMAIL);
    const otherId = await userId(OTHER_EMAIL);
    for (const org of [ORG, OTHER_ORG]) {
      await admin.from('memberships').delete().eq('organization_id', org);
      await admin.from('tenants').delete().eq('id', org);
    }
    const { error: tErr } = await admin.from('tenants').insert([
      { id: ORG, nip: '9480000014', name: 'Firma Start 00153' },
      { id: OTHER_ORG, nip: '9480000021', name: 'Inna firma 00153' },
    ]);
    if (tErr) throw tErr;
    await admin.from('users').upsert(
      [{ id: ownerId, name: 'Owner' }, { id: otherId, name: 'Other' }],
      { onConflict: 'id' },
    );
    const { error: mErr } = await admin.from('memberships').insert([
      { organization_id: ORG, user_id: ownerId, role: 'owner', status: 'active' },
      { organization_id: OTHER_ORG, user_id: otherId, role: 'owner', status: 'active' },
    ]);
    if (mErr) throw mErr;
    const { error: uErr } = await admin.from('tenants')
      .update({ business_started_on: '2026-07-01' })
      .eq('id', ORG);
    if (uErr) throw uErr;
  });

  afterAll(async () => {
    if (!hasDatabase) return;
    for (const org of [ORG, OTHER_ORG]) {
      await admin.from('memberships').delete().eq('organization_id', org);
      await admin.from('tenants').delete().eq('id', org);
    }
  });

  it('członek firmy czyta kolumnę kluczem użytkownika (GRANT SELECT z 00153)', async () => {
    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect(await readTenantBusinessStart(owner, ORG)).toBe('2026-07-01');
  });

  it('członek innej firmy nie widzi wiersza (RLS wiersza bez zmian)', async () => {
    const other = await signedIn(OTHER_EMAIL, OTHER_ORG);
    expect(await readTenantBusinessStart(other, ORG)).toBeNull();
  });

  it('CHECK odrzuca datę sprzed 1900 roku, NULL przechodzi', async () => {
    const bad = await admin.from('tenants')
      .update({ business_started_on: '1899-12-31' })
      .eq('id', ORG);
    expect(bad.error?.code).toBe('23514');

    const cleared = await admin.from('tenants')
      .update({ business_started_on: null })
      .eq('id', ORG);
    expect(cleared.error).toBeNull();
    const owner = await signedIn(OWNER_EMAIL, ORG);
    expect(await readTenantBusinessStart(owner, ORG)).toBeNull();
  });
});
