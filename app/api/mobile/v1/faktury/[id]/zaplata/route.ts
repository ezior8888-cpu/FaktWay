import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { markPaidFromMobile } from '@/lib/api/mobile/naleznosci';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/faktury/{id}/zaplata` (M10a): „Zapłacona” jak na stronie (RPC 00158); opcjonalny dzień w treści.
 * Logika i ponowienie: `lib/api/mobile/naleznosci.ts`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    const { id } = await params;
    return await markPaidFromMobile(caller, id, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
