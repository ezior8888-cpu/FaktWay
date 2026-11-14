import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { overdueForMobile } from '@/lib/api/mobile/naleznosci';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/mobile/v1/naleznosci` (M10a): faktury po terminie jak strona „Po terminie”, ze stanem przypomnień i tym, na co rola pozwala.
 * Logika i ponowienie: `lib/api/mobile/naleznosci.ts`.
 */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    return await overdueForMobile(caller);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
