import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { monthForMobile } from '@/lib/api/mobile/ksiegowosc';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/ksiegowosc?miesiac=RRRR-MM` (M10b): „Ten miesiąc” jak na stronie. Logika: `lib/api/mobile/ksiegowosc.ts`. */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await monthForMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
