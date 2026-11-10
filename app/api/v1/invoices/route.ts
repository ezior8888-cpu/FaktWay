import { authenticateApiRequest } from '@/lib/api/v1/auth';
import { listInvoices, parseInvoiceListQuery } from '@/lib/api/v1/invoices';
import { apiError, apiOk } from '@/lib/api/v1/responses';
import { apiFailure } from '@/lib/api/v1/route-helpers';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/invoices`: faktury firmy klucza (zakres `invoices:read`),
 * filtr kierunku, statusu KSeF i dat wystawienia, strony kursorem.
 * Opis: `lib/api/v1/openapi.json`, strona `/api/docs`.
 */
export async function GET(request: Request) {
  const auth = await authenticateApiRequest(request, { scope: 'invoices:read' });
  if (!auth.ok) return auth.response;

  const query = parseInvoiceListQuery(new URL(request.url).searchParams);
  if (!query.ok) return apiError(400, 'invalid_parameter', query.message, auth.headers);

  try {
    return apiOk(await listInvoices(auth.db, auth.key.tenantId, query.value), auth.headers);
  } catch (error) {
    return apiFailure(error, auth.requestId, auth.headers);
  }
}
