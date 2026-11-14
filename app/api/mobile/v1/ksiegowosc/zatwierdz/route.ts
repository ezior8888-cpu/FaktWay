import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { approveMonthFromMobile } from '@/lib/api/mobile/ksiegowosc';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `POST /api/mobile/v1/ksiegowosc/zatwierdz` (M10b): zatwierdzenie miesiąca ze skrótami z widoku (właściciel, administrator). */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await approveMonthFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
