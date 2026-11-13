import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { mobileFailure } from '@/lib/api/mobile/responses';
import { uploadExpenseFromMobile } from '@/lib/api/mobile/wydatki';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/wydatki/zdjecie` (plan aplikacji mobilnej, M9): zdjęcie
 * paragonu albo faktury (albo PDF) ze skanera telefonu, pole `plik`, i zlecenie
 * odczytu (OCR), tą samą funkcją co „Dodaj wydatek” na stronie. Wymaga
 * `X-Active-Org` i `Idempotency-Key`; ponowienie z tym samym kluczem i plikiem
 * oddaje to samo zadanie odczytu (200, `powtorzenie`), bez drugiego kosztu.
 *
 * Trasa jest POZA proxy (`proxy.ts`, AGENTS.md, niezmiennik 7): proxy
 * buforowałoby całe ciało. Rozmiar, odczyt ciała i limity: `lib/uploads/server.ts`,
 * kolejność kroków i ponowienia: `lib/api/mobile/wydatki.ts`.
 */
export async function POST(request: Request) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    return await uploadExpenseFromMobile(caller, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
