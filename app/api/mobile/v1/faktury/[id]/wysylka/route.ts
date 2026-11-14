import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { sendDraftFromMobile } from '@/lib/api/mobile/faktury';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/faktury/{id}/wysylka` (M8): szkic zwykłej faktury do
 * KSeF, jak „Wyślij” przy szkicu na stronie (`sendRegularDraft`). Faktura już
 * w kolejce albo przyjęta daje 200 z `juzZlecona: true`, bez drugiej wysyłki.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    const { id } = await params;
    return await sendDraftFromMobile(caller, id);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
