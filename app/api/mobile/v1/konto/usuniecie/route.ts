import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { deletionStateForMobile, requestDeletionFromMobile } from '@/lib/api/mobile/konto-usuniecie';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/mobile/v1/konto/usuniecie` (M10b): stan usunięcia konta i sposób potwierdzenia z serwera.
 * `POST`: usunięcie konta z 14 dniami na rezygnację (RODO, ADR 0006), to samo co na stronie.
 * Reguła potwierdzenia i ponowienie: `lib/api/mobile/konto-usuniecie.ts`.
 */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'none' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await deletionStateForMobile(caller);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}

export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'none' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await requestDeletionFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
