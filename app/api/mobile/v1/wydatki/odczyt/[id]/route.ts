import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { mobileFailure } from '@/lib/api/mobile/responses';
import { ocrStatusForMobile } from '@/lib/api/mobile/wydatki';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/mobile/v1/wydatki/odczyt/{id}` (M9): stan odczytu zdjęcia kosztu,
 * jak odpytywanie przycisku „Dodaj wydatek” na stronie (`readOcrJobStatus`).
 * 404: zadania nie ma; 503: stan nieznany, telefon pyta dalej.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    const { id } = await params;
    return await ocrStatusForMobile(caller, id);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
