import { authenticateApiRequest } from '@/lib/api/v1/auth';
import { readInvoice } from '@/lib/api/v1/invoices';
import { isUuid } from '@/lib/api/v1/pagination';
import { apiError, apiOk } from '@/lib/api/v1/responses';
import { apiFailure } from '@/lib/api/v1/route-helpers';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/v1/invoices/{id}`: faktura firmy klucza z pozycjami, numerem
 * i statusem KSeF. Faktura innej firmy wygląda jak nieistniejąca (404).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiRequest(request, { scope: 'invoices:read' });
  if (!auth.ok) return auth.response;

  const { id: rawId } = await params;
  const id = rawId.toLowerCase();
  if (!isUuid(id)) return apiError(400, 'invalid_parameter', 'Parametr id to identyfikator faktury (UUID).', auth.headers);

  try {
    const invoice = await readInvoice(auth.db, auth.key.tenantId, id);
    if (!invoice) return apiError(404, 'not_found', 'Nie ma takiej faktury w firmie tego klucza API.', auth.headers);
    return apiOk({ data: invoice }, auth.headers);
  } catch (error) {
    return apiFailure(error, auth.requestId, auth.headers);
  }
}
