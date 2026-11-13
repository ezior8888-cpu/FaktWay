import { CorrectionPageFrame } from '@/components/invoices/finora/correction-page-frame';
import { createClient } from '@/lib/supabase/server';
import { getActiveOrgIdFromCookies } from '@/lib/supabase/active-org';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { CorrectionInvoiceForm } from '@/components/invoices/correction-form';
import { sanitizeSearch } from '@/lib/invoices/list-query';
import { loadCorrectionPicker, type CorrectionPicker } from '@/lib/invoices/correction-picker';
import { loadNumberingForForm } from '@/lib/numeracja/strona';

export default async function NewCorrectionPage({
  searchParams,
}: {
  searchParams: Promise<{ parentId?: string; q?: string }>;
}) {
  const params = await searchParams;
  const tenantId = await getActiveOrgIdFromCookies();
  const environment = requireConfiguredKsefEnvironment();
  const supabase = await createClient();
  const q = sanitizeSearch(params.q ?? '');

  // F-005: `parentId` spoza 50 najnowszych czyta loader osobno, a gdy faktura
  // nie przyjmie korekty — formularz pokazuje dlaczego, zamiast pustego wyboru.
  const picker: CorrectionPicker = tenantId
    ? await loadCorrectionPicker(supabase, { tenantId, environment, parentId: params.parentId, q })
    : { parentInvoices: [], truncated: false, preselectRefusal: null };
  // Krok 2.5: seria domyślna korekty i podpowiedź numeru; błąd = formularz bez podpowiedzi.
  const numbering = tenantId ? await loadNumberingForForm(supabase, tenantId, 'correction') : null;

  return (
    <CorrectionPageFrame>
      {/* UX-01: firma listy faktur pierwotnych — zapis korekty sprawdzi, że to wciąż aktywna firma;
          `key` montuje formularz od nowa po przełączeniu firmy w tej karcie. */}
      <CorrectionInvoiceForm
        key={tenantId ?? ''}
        parentInvoices={picker.parentInvoices}
        preselectedParentId={params.parentId}
        preselectRefusal={picker.preselectRefusal}
        searchQuery={q}
        truncated={picker.truncated}
        tenantId={tenantId ?? ''}
        {...(numbering ? { numbering } : {})}
      />
    </CorrectionPageFrame>
  );
}
