import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { cancelDeletionFromMobile } from '@/lib/api/mobile/konto-usuniecie';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/konto/usuniecie/anuluj` (M10b): rezygnacja z usunięcia konta
 * w ciągu 14 dni, z tym samym potwierdzeniem co usunięcie. Logika: `lib/api/mobile/konto-usuniecie.ts`.
 */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'none' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await cancelDeletionFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
