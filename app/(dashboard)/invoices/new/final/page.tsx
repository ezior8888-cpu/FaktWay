import { FinalInvoiceForm } from '@/components/invoices/final-form';
import { SellerProfileBlock } from '@/components/invoices/seller-profile-block';
import { createClient } from '@/lib/supabase/server';
import { loadTenantSellerForForms } from '@/lib/invoices/load-tenant-seller';
import { findAdvancesAlreadySettled } from '@/lib/invoices/settled-advances';

export default async function NewFinalInvoicePage() {
  const loaded = await loadTenantSellerForForms();
  if (!loaded) return <SellerProfileBlock />;

  // UX-01: sprzedawca, lista zaliczek i firma odsyłana przy zapisie — jedna firma.
  const { seller, tenantId } = loaded;
  const supabase = await createClient();
  const { data: advances } = await supabase
    .from('invoices')
    .select('id, internal_number, ksef_number, issue_date, advance_amount, gross_total')
    .eq('tenant_id', tenantId)
    .eq('direction', 'outgoing')
    .eq('ksef_status', 'accepted')
    .eq('invoice_kind', 'advance')
    .order('issue_date', { ascending: false })
    .limit(120);

  // AUD-67: zaliczki już wskazane w innej ROZ nie trafiają na listę. Gdy
  // odczyt się nie uda, lista zostaje pełna — zapis i tak sprawdza akcja
  // oraz wyzwalacz bazy (00125).
  let available = advances ?? [];
  try {
    const settled = await findAdvancesAlreadySettled(
      supabase,
      tenantId,
      available.map((a) => a.id as string),
    );
    available = available.filter((a) => !settled.has(a.id as string));
  } catch {
    // celowo: patrz komentarz wyżej
  }

  // P5: szerokość daje siatka Finory w formularzu (dokument + kolumna 18rem).
  // `key` montuje formularz od nowa po przełączeniu firmy w tej karcie (UX-01).
  return <FinalInvoiceForm key={tenantId} initialSeller={seller} advanceInvoices={available} tenantId={tenantId} />;
}
