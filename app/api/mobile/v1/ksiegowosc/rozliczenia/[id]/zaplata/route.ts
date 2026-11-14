import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { settlementPaymentFromMobile } from '@/lib/api/mobile/ksiegowosc';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `POST /api/mobile/v1/ksiegowosc/rozliczenia/{id}/zaplata` (M10b): zapłata rozliczenia albo jej cofnięcie (właściciel, administrator). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    const { id } = await params;
    return await settlementPaymentFromMobile(caller, id, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
