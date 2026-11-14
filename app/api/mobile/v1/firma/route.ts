import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { rememberFirmFromMobile } from '@/lib/api/mobile/konto-usuniecie';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/firma` (M10b): firma wybrana w telefonie zapisana jako
 * ostatnio używana (`users.last_active_tenant_id`), wspólna ze stroną.
 * Członkostwo w firmie z `X-Active-Org` sprawdza bramka. Logika: `lib/api/mobile/konto-usuniecie.ts`.
 */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await rememberFirmFromMobile(caller);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
