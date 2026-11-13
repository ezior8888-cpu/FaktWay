import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import type { SesjaOdpowiedz } from '@/lib/api/mobile/kontrakt';
import { mobileFailure, mobileJson } from '@/lib/api/mobile/responses';
import { recordMobileLogin } from '@/lib/api/mobile/sesja';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/sesja`: wpis `auth.login` dla sesji telefonu (historia
 * logowań, lista urządzeń, mail o nowym urządzeniu), raz na sesję. Aplikacja
 * woła ją po pełnym logowaniu; szczegóły i ponowienie w `lib/api/mobile/sesja.ts`.
 * 201 `{ zapisane: true }` przy pierwszym wywołaniu, potem 200 `{ zapisane: false }`.
 */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'none' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    const zapisane = (await recordMobileLogin(caller)) === 'recorded';
    const body: SesjaOdpowiedz = { zapisane };
    return mobileJson(body, zapisane ? 201 : 200, caller.headers);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
