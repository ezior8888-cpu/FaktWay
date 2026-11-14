import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { invoicePdfForMobile } from '@/lib/api/mobile/naleznosci';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/mobile/v1/faktury/{id}/pdf` (M10a): ten sam PDF co na stronie, w Base64 w JSON.
 * Logika i ponowienie: `lib/api/mobile/naleznosci.ts`.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    const { id } = await params;
    return await invoicePdfForMobile(caller, id);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
