import 'server-only';

import type { NextResponse } from 'next/server';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import type { FirmaZapisanaOdpowiedz } from '@/lib/api/mobile/kontrakt';
import { mobileJson } from '@/lib/api/mobile/responses';
import { rememberLastActiveOrganization } from '@/lib/organizations/last-active';

/**
 * `POST /api/mobile/v1/firma` (plan aplikacji mobilnej, M10b): firma wybrana w
 * telefonie zapisana jako ostatnio używana, ta sama funkcja co przełącznik firm
 * na stronie. Członkostwo w firmie z `X-Active-Org` sprawdziła bramka (tokenem
 * klienta); zapis tylko własnego wiersza (RLS). Ponowienie zapisuje to samo.
 */
export async function rememberFirmFromMobile(caller: MobileCaller): Promise<NextResponse> {
  if (!caller.org) throw new Error('Trasa firmy bez firmy (org: required)');
  const zapisane = await rememberLastActiveOrganization(caller.db, caller.user.id, caller.org.tenantId);
  const odpowiedz: FirmaZapisanaOdpowiedz = { aktywnaFirma: caller.org.tenantId, zapisane };
  return mobileJson(odpowiedz, 200, caller.headers);
}
