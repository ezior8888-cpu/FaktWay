import * as Sentry from '@sentry/nextjs';

import { loadBuyerInvoice } from '@/lib/invoice-share/buyer-invoice';
import {
  BUYER_FILE_URL_TTL_SECONDS,
  buyerFileNotFound,
  buyerFileRedirect,
  buyerFileRefusal,
  buyerFileText,
  buyerFileUnavailable,
  buyerTokenParam,
} from '@/lib/invoice-share/buyer-files';
import { generateInvoicePdf } from '@/lib/pdf/invoice-pdf';
import { invoicePdfExists } from '@/lib/pdf/pdf-storage';
import { getSignedInvoiceUrl } from '@/lib/storage/r2';

export const dynamic = 'force-dynamic';

const PDF_REFUSED =
  'PDF tej faktury jest chwilowo niedostępny. Plik XML z KSeF jest na stronie faktury; możesz też poprosić sprzedawcę o fakturę e-mailem.';

/**
 * GET /faktura/<token>/pdf: PDF faktury dla nabywcy (krok 2.10). Ten sam
 * odczyt co strona, bez liczenia otwarcia. PDF tworzy i odkłada do magazynu
 * `generateInvoicePdf` (ten sam co w panelu i w mailu do nabywcy, z kodem QR
 * KSeF), a trasa przekierowuje (303) na krótki podpisany adres tego pliku.
 * PDF bez kodu QR nie idzie do nabywcy (ta sama reguła co e-mail, B14).
 */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const result = await loadBuyerInvoice(buyerTokenParam(token), { countOpen: false });
  if (result.status !== 'ok') return buyerFileRefusal(result);

  const { access } = result;
  try {
    const pdf = await generateInvoicePdf(access.invoiceId, access.tenantId);
    if (!pdf.success) {
      return pdf.code === 'NOT_FOUND' || pdf.code === 'FORBIDDEN' ? buyerFileNotFound() : buyerFileText(409, PDF_REFUSED);
    }
    if (pdf.missingKodI) return buyerFileText(409, PDF_REFUSED);
    // Zapis PDF do magazynu bywa pominięty po błędzie (generator i tak oddaje plik w panelu).
    // Bez pliku w magazynie nie ma czego podpisać: następne kliknięcie zapisze go ponownie.
    if (!(await invoicePdfExists(pdf.qrStateKey))) return buyerFileUnavailable();

    const signedUrl = await getSignedInvoiceUrl(pdf.qrStateKey, access.tenantId, BUYER_FILE_URL_TTL_SECONDS, {
      downloadFilename: pdf.filename,
      contentType: 'application/pdf',
    });
    return buyerFileRedirect(signedUrl);
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'faktura/pdf' } });
    return buyerFileUnavailable();
  }
}
