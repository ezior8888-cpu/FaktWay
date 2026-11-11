import { loadBuyerInvoice } from '@/lib/invoice-share/buyer-invoice';
import {
  BUYER_FILE_URL_TTL_SECONDS,
  buyerDownloadName,
  buyerFileNotFound,
  buyerFileRedirect,
  buyerFileRefusal,
  buyerFileUnavailable,
  buyerTokenParam,
} from '@/lib/invoice-share/buyer-files';
import { getSignedInvoiceUrl } from '@/lib/storage/r2';
import { isTenantStoragePath } from '@/lib/storage/tenant-path';

export const dynamic = 'force-dynamic';

/**
 * GET /faktura/<token>/xml: plik XML faktury wysłany do KSeF (krok 2.10).
 * Ten sam odczyt co strona (limit prób, skrót tokenu, funkcja bazy), bez
 * liczenia otwarcia, potem krótki podpisany adres magazynu (303). Ścieżka
 * pliku pochodzi z bazy i musi leżeć w katalogu firmy tej faktury.
 */
export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  const result = await loadBuyerInvoice(buyerTokenParam(token), { countOpen: false });
  if (result.status !== 'ok') return buyerFileRefusal(result);

  const { access, view } = result;
  if (!isTenantStoragePath(access.xmlStoragePath, access.tenantId)) return buyerFileNotFound();

  let signedUrl: string;
  try {
    signedUrl = await getSignedInvoiceUrl(access.xmlStoragePath, access.tenantId, BUYER_FILE_URL_TTL_SECONDS, {
      downloadFilename: buyerDownloadName(view.number, 'xml'),
      contentType: 'application/xml',
    });
  } catch {
    console.error('[buyer-invoice] xml_sign_failed');
    return buyerFileUnavailable();
  }
  return buyerFileRedirect(signedUrl);
}
