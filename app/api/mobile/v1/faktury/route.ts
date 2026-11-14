import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { issueInvoiceFromMobile } from '@/lib/api/mobile/faktury';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/faktury` (plan aplikacji mobilnej, M8): szybka faktura
 * z telefonu, szkic albo „Wyślij do KSeF” (`wyslij: true`), tymi samymi
 * funkcjami co formularz strony. Wymaga `X-Active-Org` i `Idempotency-Key`;
 * ponowienie z tym samym kluczem oddaje tę samą fakturę (200, `powtorzenie`).
 * Logika i kolejność kroków: `lib/api/mobile/faktury.ts`.
 */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    return await issueInvoiceFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
