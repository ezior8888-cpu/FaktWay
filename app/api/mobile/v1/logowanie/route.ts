import { handleMobilePasswordLogin } from '@/lib/api/mobile/logowanie';

export const dynamic = 'force-dynamic';

/**
 * `POST /api/mobile/v1/logowanie`: logowanie hasłem z telefonu (plan aplikacji
 * mobilnej, M6b, decyzja D16). Bez tokenu w nagłówku: to jest krok, który go
 * daje. Zwraca sesję GoTrue i `wymagaKodu`; kod 2FA, odświeżanie i wylogowanie
 * telefon robi dalej sam w GoTrue. Limity, audyt i odmowy w `lib/api/mobile/logowanie.ts`.
 */
export async function POST(request: Request) {
  return handleMobilePasswordLogin(request);
}
