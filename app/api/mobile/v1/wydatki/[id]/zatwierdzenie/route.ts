import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { mobileFailure } from '@/lib/api/mobile/responses';
import { reviewExpenseFromMobile } from '@/lib/api/mobile/wydatki';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/wydatki/{id}/zatwierdzenie` (M9): opis i akceptacja
 * kosztu ze zdjęcia, tą samą funkcją co formularz kosztu na stronie
 * (`reviewExpense`). Koszt z KSeF odsyła na faktway.pl (422 `expense_invalid`).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    const { id } = await params;
    return await reviewExpenseFromMobile(caller, id, request);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
