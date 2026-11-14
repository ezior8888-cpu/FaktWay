import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NextResponse } from 'next/server';
import { z } from 'zod';

import type { MobileCaller } from '@/lib/api/mobile/auth';
import { createMobileLoginClient } from '@/lib/api/mobile/db';
import type {
  AnulowanieUsunieciaOdpowiedz,
  UsuniecieKontaOdpowiedz,
  UsuniecieZaplanowaneOdpowiedz,
} from '@/lib/api/mobile/kontrakt';
import { MOBILE_UNAVAILABLE, MobileUpstreamError, mobileError, mobileJson } from '@/lib/api/mobile/responses';
import { readJsonBody } from '@/lib/api/mobile/tresc';
import { clientIpFromHeaders } from '@/lib/auth/client-ip';
import { confirmAccountPassword } from '@/lib/auth/password-check';
import { cancelAccountDeletion, scheduleAccountDeletion } from '@/lib/gdpr/account-deletion';
import { getActiveGdprRequest } from '@/lib/gdpr/deletion';

/**
 * Usunięcie konta z telefonu (plan aplikacji mobilnej, M10b; RODO, 14 dni na
 * rezygnację, ADR 0006) tymi samymi funkcjami z `lib/` co strona.
 *
 * Potwierdzenie usunięcia i anulowania (decyzja M10b, opis w planie):
 *  - 2FA: konto z TOTP przechodzi bramkę tylko po kodzie (AAL2), jak
 *    `mfa_required` w akcjach strony;
 *  - konto z hasłem (`email` w `app_metadata.providers` z GoTrue): aktualne
 *    hasło, sprawdzone w GoTrue klientem logowania z kluczem serwisowym (bez
 *    captchy, jak `POST /logowanie`, D16) i ze wspólnym ze stroną limitem prób;
 *  - konto bez hasła (tylko Google; strona nie ma dla niego drogi, a Apple
 *    wymaga usuwania konta w aplikacji): logowanie w tej sesji nie starsze niż
 *    10 minut (claim `amr` sprawdzonego tokenu). Metoda pochodzi z serwera,
 *    nigdy z telefonu.
 *
 * Ponowienie: istniejące żądanie oddaje `juzBylo` bez maila i audytu; brak
 * żądania przy anulowaniu to `juzBylo`.
 */

/** Ile wystarcza świeże logowanie przy koncie bez hasła. */
export const SWIEZE_LOGOWANIE_SEKUND = 10 * 60;

const MAX_BODY_BYTES = 10_000;
const potwierdzenieSchema = z.object({ haslo: z.string().max(1024).optional() }).strict();

function maHaslo(caller: MobileCaller): boolean {
  return caller.user.providers.includes('email');
}

/** Do kiedy świeże logowanie wystarcza (ms); `null`, gdy już nie wystarcza albo nie wiadomo. */
function swiezeDo(caller: MobileCaller, teraz = Date.now()): number | null {
  const o = caller.session.potwierdzonoO;
  if (o === null) return null;
  const koniec = (o + SWIEZE_LOGOWANIE_SEKUND) * 1000;
  return koniec > teraz ? koniec : null;
}

// ─── Usunięcie konta ──────────────────────────────────────────────────

async function activeRequest(caller: MobileCaller) {
  try {
    // RLS `gdpr_deletion_own_select` (00051): klient widzi tylko własne żądanie.
    return await getActiveGdprRequest(caller.db as unknown as Parameters<typeof getActiveGdprRequest>[0], caller.user.id);
  } catch {
    throw new MobileUpstreamError('gdpr_deletion_requests.read');
  }
}

/** `GET /api/mobile/v1/konto/usuniecie`. */
export async function deletionStateForMobile(caller: MobileCaller): Promise<NextResponse> {
  const active = await activeRequest(caller);
  const haslo = maHaslo(caller);
  const swieze = haslo ? null : swiezeDo(caller);
  const odpowiedz: UsuniecieKontaOdpowiedz = {
    zaplanowane: active ? new Date(active.scheduled_for).toISOString() : null,
    potwierdzenie: haslo ? 'haslo' : 'swieze_logowanie',
    swiezeDo: swieze === null ? null : new Date(swieze).toISOString(),
  };
  return mobileJson(odpowiedz, 200, caller.headers);
}

type Potwierdzenie = { ok: true; sposob: 'password' | 'recent_login' } | { ok: false; response: NextResponse };

/** Hasło (konto z hasłem) albo świeże logowanie (konto bez hasła); 2FA sprawdziła bramka. */
async function confirmIdentity(caller: MobileCaller, request: Request): Promise<Potwierdzenie> {
  const headers = caller.headers;
  const raw = await readJsonBody(request, headers, { maxBytes: MAX_BODY_BYTES, tooLarge: 'Treść jest za długa.', optional: true });
  if (!raw.ok) return raw;
  const parsed = potwierdzenieSchema.safeParse(raw.value);
  if (!parsed.success) {
    return { ok: false, response: mobileError(400, 'invalid_request', 'Treść żądania nie pasuje do kontraktu. Zaktualizuj aplikację FaktWay.', headers) };
  }

  if (!maHaslo(caller)) {
    if (swiezeDo(caller) !== null) return { ok: true, sposob: 'recent_login' };
    return {
      ok: false,
      response: mobileError(403, 'reauth_required', 'Ze względów bezpieczeństwa zaloguj się ponownie przez Google, a potem od razu potwierdź usunięcie konta.', headers),
    };
  }

  const haslo = parsed.data.haslo;
  if (!haslo) return { ok: false, response: mobileError(400, 'invalid_request', 'Wpisz aktualne hasło, żeby potwierdzić.', headers) };
  if (!caller.user.email) return { ok: false, response: mobileError(400, 'invalid_request', 'Konto nie ma adresu e-mail. Napisz do nas z faktway.pl.', headers) };
  const wynik = await confirmAccountPassword({
    userId: caller.user.id,
    email: caller.user.email,
    password: haslo,
    // Klucz serwisowy: logowanie hasłem bez tokenu captchy (D16); sesja tymczasowa jest od razu zamykana.
    verifier: () => createMobileLoginClient() as SupabaseClient,
  });
  if (wynik.ok) return { ok: true, sposob: 'password' };
  if (wynik.error === 'rate_limited') {
    const retryAfter = String(Math.max(1, wynik.retryAfter ?? 60));
    return { ok: false, response: mobileError(429, 'rate_limited', `Za dużo prób hasła. Spróbuj ponownie za ${retryAfter} s.`, { ...headers, 'Retry-After': retryAfter }) };
  }
  if (wynik.error === 'invalid_password') {
    return { ok: false, response: mobileError(400, 'invalid_credentials', 'Hasło jest nieprawidłowe. Sprawdź je i spróbuj ponownie.', headers) };
  }
  return { ok: false, response: mobileError(503, 'service_unavailable', 'Nie możemy teraz sprawdzić hasła. Spróbuj ponownie za chwilę.', headers) };
}

/** `POST /api/mobile/v1/konto/usuniecie`. */
export async function requestDeletionFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const potwierdzenie = await confirmIdentity(caller, request);
  if (!potwierdzenie.ok) return potwierdzenie.response;
  if (!caller.user.email) return mobileError(400, 'invalid_request', 'Konto nie ma adresu e-mail. Napisz do nas z faktway.pl.', headers);

  const wynik = await scheduleAccountDeletion({
    userId: caller.user.id,
    userEmail: caller.user.email,
    ipAddress: clientIpFromHeaders(request.headers) ?? undefined,
    userAgent: request.headers.get('user-agent') ?? undefined,
    // Jak akcja strony (nagłówek Origin): bez adresu w zmiennych adres serwera z żądania, nigdy sama ścieżka w mailu.
    origin: process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin,
    auditMetadata: { client: 'mobile', confirmation: potwierdzenie.sposob },
  });
  if (!wynik.ok) {
    if (wynik.error === 'active_subscription') {
      const firmy = wynik.organizations.join(', ');
      return mobileError(409, 'deletion_blocked', `Konta nie usuniemy, bo ${firmy ? `firma ${firmy}` : 'Twoja firma'} ma aktywny abonament. Anuluj abonament na faktway.pl (Ustawienia, Abonament) i spróbuj ponownie.`, headers);
    }
    return mobileError(503, 'service_unavailable', MOBILE_UNAVAILABLE, headers);
  }
  const odpowiedz: UsuniecieZaplanowaneOdpowiedz = {
    zaplanowane: wynik.scheduledAt.toISOString(),
    juzBylo: wynik.alreadyScheduled,
    mailWyslany: wynik.emailSent,
  };
  return mobileJson(odpowiedz, 200, headers);
}

/** `POST /api/mobile/v1/konto/usuniecie/anuluj`. */
export async function cancelDeletionFromMobile(caller: MobileCaller, request: Request): Promise<NextResponse> {
  const headers = caller.headers;
  const potwierdzenie = await confirmIdentity(caller, request);
  if (!potwierdzenie.ok) return potwierdzenie.response;

  const active = await activeRequest(caller);
  if (!active) {
    const odpowiedz: AnulowanieUsunieciaOdpowiedz = { anulowane: true, juzBylo: true };
    return mobileJson(odpowiedz, 200, headers);
  }
  if (active.status !== 'pending') {
    return mobileError(409, 'deletion_in_progress', 'Usuwanie konta już trwa i nie da się go anulować. Napisz do nas z faktway.pl.', headers);
  }
  const wynik = await cancelAccountDeletion({
    userId: caller.user.id,
    method: potwierdzenie.sposob === 'password' ? 'authenticated_password_confirmation' : 'recent_login',
    auditMetadata: { client: 'mobile' },
  });
  if (!wynik.ok && wynik.error === 'request_failed') return mobileError(503, 'service_unavailable', MOBILE_UNAVAILABLE, headers);
  // `not_pending` po odczycie: żądanie zniknęło w międzyczasie (ponowienie z innego urządzenia).
  const odpowiedz: AnulowanieUsunieciaOdpowiedz = { anulowane: true, juzBylo: !wynik.ok };
  return mobileJson(odpowiedz, 200, headers);
}
