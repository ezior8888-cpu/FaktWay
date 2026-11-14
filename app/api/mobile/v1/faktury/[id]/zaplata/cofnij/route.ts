import { authenticateMobileRequest } from '@/lib/api/mobile/auth';
import { undoPaidFromMobile } from '@/lib/api/mobile/naleznosci';
import { mobileFailure } from '@/lib/api/mobile/responses';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/faktury/{id}/zaplata/cofnij` (M10a): cofnięcie zapłaty oznaczonej „Zapłacona”.
 * Logika i ponowienie: `lib/api/mobile/naleznosci.ts`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateMobileRequest(request, { org: 'required' });
  if (!auth.ok) return auth.response;
  const { caller } = auth;

  try {
    const { id } = await params;
    return await undoPaidFromMobile(caller, id);
  } catch (error) {
    return mobileFailure(error, caller.requestId, caller.headers);
  }
}
