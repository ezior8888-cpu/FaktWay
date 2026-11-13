import { handleMobileMfaCode } from '@/lib/api/mobile/kod';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/kod`: kod 2FA z telefonu (plan aplikacji mobilnej, M6c).
 * Token sesji AAL1 w `Authorization: Bearer`, treść `{ kod }`. Zwraca sesję AAL2
 * dla `setSession`. Limit prób wspólny ze stroną, audyt i odmowy w `lib/api/mobile/kod.ts`.
 */
export async function POST(request: Request) {
  return handleMobileMfaCode(request);
}
