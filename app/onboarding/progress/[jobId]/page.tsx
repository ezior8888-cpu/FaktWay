import { redirect } from 'next/navigation';

import { AuthSplitLayout } from '@/components/auth/finora/auth-split-layout';
import { isInterruptedLegacyImport } from '@/components/import-danych/import-model';
import { ImportProgressView } from '@/components/onboarding/import-progress-view';
import { requireVerifiedUserForPage } from '@/lib/auth/verified-user';
import { getActiveOrgIdFromCookies } from '@/lib/supabase/active-org';

interface Props {
  params: Promise<{ jobId: string }>;
}

export default async function ProgressPage({ params }: Props) {
  const { jobId } = await params;
  const { supabase } = await requireVerifiedUserForPage('/onboarding/progress/' + encodeURIComponent(jobId));
  const tenantId = await getActiveOrgIdFromCookies();
  if (!tenantId) redirect('/onboarding');

  const { data: job } = await supabase.from('import_jobs').select('*').eq('id', jobId).eq('tenant_id', tenantId).single();

  if (!job) redirect('/dashboard');

  // Plan Finora P15 (E10b): układ logowania Finory zamiast pustej ramki.
  // Decyzja Bartosza 22.10.2026: bez obietnicy e-maila — import z pliku go
  // nie wysyła; wynik zostaje w Imporcie danych. Dawny import z KSeF („w toku”
  // albo nieudany) się nie skończy — panel nie obiecuje pracy w tle
  // (poprawka po przeglądzie).
  const legacy = isInterruptedLegacyImport(job);
  return (
    <AuthSplitLayout
      panelTitle={legacy ? 'Historia z KSeF pobiera się sama' : 'Importujemy Twoje dane'}
      panelText={
        legacy
          ? 'Ten import zastąpiło automatyczne pobieranie historii z KSeF — postęp zobaczysz w Imporcie danych.'
          : 'Postęp odświeża się sam. Możesz zamknąć stronę — skończymy w tle, a wynik zobaczysz w Imporcie danych.'
      }
    >
      <ImportProgressView initialJob={job} />
    </AuthSplitLayout>
  );
}
