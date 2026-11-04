import { AdvanceInvoiceForm } from '@/components/invoices/advance-form';
import { SellerProfileBlock } from '@/components/invoices/seller-profile-block';
import { loadTenantSellerForForms } from '@/lib/invoices/load-tenant-seller';

export default async function NewAdvanceInvoicePage() {
  const loaded = await loadTenantSellerForForms();
  if (!loaded) return <SellerProfileBlock />;

  // P5: szerokość daje siatka Finory w formularzu (dokument + kolumna 18rem).
  // UX-01: firma sprzedawcy idzie do formularza — zapis sprawdzi, że to wciąż aktywna firma;
  // `key` montuje formularz od nowa po przełączeniu firmy w tej karcie.
  return <AdvanceInvoiceForm key={loaded.tenantId} initialSeller={loaded.seller} tenantId={loaded.tenantId} />;
}
