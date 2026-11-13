import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { readMobileAccountFirms } from '@/lib/api/mobile/konto';
import type { KontoOdpowiedz } from '@/lib/api/mobile/kontrakt';
import { mobileFailure, mobileJson } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/mobile/v1/konto`: kto jest zalogowany w telefonie, czy konto ma
 * 2FA, jego firmy i firma, od której aplikacja zaczyna (plan aplikacji
 * mobilnej, M6). Tylko odczyt tokenem klienta (RLS), bez wpisu w audycie.
 */
export async function GET(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'none' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    const firms = await readMobileAccountFirms(caller.db, caller.user.id);
    const body: KontoOdpowiedz = {
      konto: { id: caller.user.id, email: caller.user.email },
      dwaEtapy: { wlaczone: caller.mfaEnabled, poziom: caller.session.aal },
      ...firms,
    };
    return mobileJson(body, 200, caller.headers);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
