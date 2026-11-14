import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { mobileFailure } from '@/lib/api/mobile/responses';
import { settingsForMobile } from '@/lib/api/mobile/ustawienia';

export const dynamic = 'force-dynamic';

/** `GET /api/mobile/v1/ustawienia` (M10b): karty Firma, KSeF i Przypomnienia do odczytu. Logika: `lib/api/mobile/ustawienia.ts`. */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;
  try {
    return await settingsForMobile(caller);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
