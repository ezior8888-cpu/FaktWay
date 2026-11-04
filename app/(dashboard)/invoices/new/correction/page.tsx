import { CorrectionPageFrame } from '@/components/invoices/finora/correction-page-frame';
import { createClient } from '@/lib/supabase/server';
import { getActiveOrgIdFromCookies } from '@/lib/supabase/active-org';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { CorrectionInvoiceForm } from '@/components/invoices/correction-form';
import { excludeParentsWithOpenCorrection } from '@/lib/invoices/correction-parents';

export default async function NewCorrectionPage({
  searchParams,
}: {
  searchParams: Promise<{ parentId?: string }>;
}) {
  const params = await searchParams;
  const tenantId = await getActiveOrgIdFromCookies();
  const environment = requireConfiguredKsefEnvironment();
  const supabase = await createClient();

  const { data: parentInvoices } = tenantId ? await supabase
    .from('invoices')
    .select('id, internal_number, ksef_number, issue_date, gross_total, buyer_data')
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('ksef_status', 'accepted')
    .eq('invoice_kind', 'regular')
    .eq('ksef_environment', environment)
    .not('ksef_number', 'is', null)
    .order('issue_date', { ascending: false })
    .limit(50) : { data: [] };

  // K4: rodzic z otwartą korektą (każdą poza odrzuconą przez KSeF) nie dostaje
  // drugiej — akcja i wyzwalacz 00133 i tak odmówią, lista nie ma go kusić.
  const { data: corrections } = tenantId ? await supabase
    .from('invoices')
    .select('parent_invoice_id, ksef_status')
    .eq('tenant_id', tenantId)
    .eq('invoice_kind', 'correction')
    .limit(500) : { data: [] };
  const available = excludeParentsWithOpenCorrection(parentInvoices ?? [], corrections ?? []);

  return (
    <CorrectionPageFrame>
      {/* UX-01: firma listy faktur pierwotnych — zapis korekty sprawdzi, że to wciąż aktywna firma;
          `key` montuje formularz od nowa po przełączeniu firmy w tej karcie. */}
      <CorrectionInvoiceForm
        key={tenantId ?? ''}
        parentInvoices={available}
        preselectedParentId={params.parentId}
        tenantId={tenantId ?? ''}
      />
    </CorrectionPageFrame>
  );
}
