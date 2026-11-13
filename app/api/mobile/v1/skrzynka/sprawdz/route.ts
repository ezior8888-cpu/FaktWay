import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { inboxCheckFromMobile } from '@/lib/api/mobile/naleznosci';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/skrzynka/sprawdz` (M10a): „Sprawdź teraz” w skrzynce KSeF, najwyżej raz na 5 minut.
 * Logika i ponowienie: `lib/api/mobile/naleznosci.ts`.
 */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    return await inboxCheckFromMobile(caller);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
