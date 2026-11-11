import { notFound } from 'next/navigation';

import { buyerTokenParam } from '@/lib/invoice-share/buyer-files';
import { loadBuyerInvoice } from '@/lib/invoice-share/buyer-invoice';
import { buyerInvoicePath } from '@/lib/invoice-share/policy';

import { BuyerInvoiceDocument } from './_components/buyer-invoice-document';
import { BuyerNotice } from './_components/buyer-notice';

export const dynamic = 'force-dynamic';

/**
 * Strona faktury dla nabywcy (plan kompletnej aplikacji, krok 2.10): bez
 * logowania, po tokenie z adresu. Nabywca widzi podgląd tej jednej faktury,
 * numer KSeF, dane do przelewu oraz PDF i XML z KSeF do pobrania. Odczyt
 * (limit prób, skrót tokenu, funkcja bazy) robi `loadBuyerInvoice`; strona
 * dostaje tylko `view`, a identyfikatory i ścieżki zostają na serwerze.
 * Nagłówki (bez cache, bez indeksowania, bez Referer) dokłada proxy.
 */
export default async function BuyerInvoicePage({ params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const token = buyerTokenParam(raw);
  const result = await loadBuyerInvoice(token, { countOpen: true });

  if (result.status === 'not_found') notFound();
  if (result.status === 'limited') {
    return (
      <BuyerNotice
        title="Za dużo otwarć z tego adresu"
        text="Spróbuj ponownie za kilka minut. Link do faktury dalej działa."
      />
    );
  }
  if (result.status === 'unavailable') {
    return (
      <BuyerNotice
        title="Strona faktury jest chwilowo niedostępna"
        text="Spróbuj ponownie za kilka minut. Jeśli to się powtórzy, poproś sprzedawcę o fakturę e-mailem."
      />
    );
  }

  const path = buyerInvoicePath(token);
  return <BuyerInvoiceDocument view={result.view} pdfHref={`${path}/pdf`} xmlHref={`${path}/xml`} />;
}
