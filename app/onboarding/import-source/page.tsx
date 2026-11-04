import { redirect } from 'next/navigation';

import { AuthSplitLayout } from '@/components/auth/finora/auth-split-layout';
import { ImportSourceSelector } from '@/components/onboarding/import-source-selector';
import { createAdminClient } from '@/lib/supabase/server';
import { requireVerifiedUserForPage } from '@/lib/auth/verified-user';
import { getActiveOrgIdFromCookies } from '@/lib/supabase/active-org';

/**
 * Krok onboardingu: wybór źródła importu danych po założeniu organizacji.
 * Decyzja Bartosza 22.10.2026: historię z KSeF FaktWay pobiera sam po
 * wgraniu certyfikatu (bez Magicznego importu), więc tu zostaje informacja
 * o KSeF, import pliku CSV z czterech programów i „Pomiń”.
 *
 * Membership/tenant query przez admin client (deterministyczne, omija RLS) —
 * bez tego zaraz po `createOrganizationAction` zdarzała się sytuacja, gdy
 * RLS odpowiadał `null` ze względu na propagację cache PostgREST → redirect
 * z powrotem na /onboarding (pętla).
 */
export default async function ImportSourcePage() {
  const { user } = await requireVerifiedUserForPage('/onboarding/import-source');

  const tenantId = await getActiveOrgIdFromCookies();
  if (!tenantId) redirect('/onboarding');

  const admin = createAdminClient();

  const { data: membership } = await admin
    .from('memberships')
    .select('id')
    .eq('user_id', user.id)
    .eq('organization_id', tenantId)
    .eq('status', 'active')
    .maybeSingle();

  if (!membership) redirect('/onboarding');

  const { data: tenant } = await admin
    .from('tenants')
    .select('name, nip, has_ksef_credentials')
    .eq('id', tenantId)
    .maybeSingle();

  if (!tenant) redirect('/onboarding');

  const hasCertificate = !!tenant.has_ksef_credentials;

  // Plan Finora P15 (E10b): układ logowania Finory zamiast szkła.
  return (
    <AuthSplitLayout
      panelTitle="Przenieś historię faktur"
      panelText="Historię faktur z KSeF pobierzemy sami po wgraniu certyfikatu. Z poprzedniego programu przeniesiesz ją plikiem CSV — albo zacznij od zera."
    >
      <ImportSourceSelector
        tenantId={tenantId}
        tenantName={tenant.name ?? ''}
        hasCertificate={hasCertificate}
      />
    </AuthSplitLayout>
  );
}
