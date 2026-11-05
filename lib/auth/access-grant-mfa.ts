import 'server-only';

import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';

/**
 * Drugi krok przy nadawaniu dostępu osobom trzecim: zaproszenie, przyjęcie prośby
 * o dostęp, zmiana roli i link dla księgowej.
 *
 * Bramka panelu wpuszcza sesję po logowaniu biometrią bez kodu (`lib/auth/panel-mfa.ts`),
 * więc sama kontrola roli w `auth-context` nie wystarcza: ktoś z odblokowanym telefonem
 * właściciela mógłby zaprosić siebie, awansować do `owner` i przejąć certyfikat oraz
 * płatności, nie znając kodu. Tu liczy się ścisły `getVerifiedMfaState`, ten sam co
 * przy certyfikacie KSeF (`uploadCertificateAction`), ale tylko dla kont z 2FA:
 * konto bez 2FA działa jak dotąd.
 *
 * Wołaj PO sprawdzeniu roli i PRZED zapisem, limitem, wysyłką albo odczytem, który
 * coś zdradza. Odmowa z `mfaStepUp` musi trafić do formularza jako komunikat z
 * przejściem na ekran kodu (`MfaStepUpNotice`), nigdy jako sam tekst błędu.
 */

export interface CodeStepRefusal {
  success: false;
  error: string;
  /** Konto ma 2FA, a ta sesja kodu nie podała: formularz pokazuje przejście na ekran kodu. */
  mfaStepUp?: true;
}

const SESSION_NOT_CONFIRMED = 'Nie udało się potwierdzić sesji. Spróbuj ponownie za chwilę.';

/** `null`, gdy wolno działać; w przeciwnym razie gotowa odmowa do zwrócenia z akcji. */
export async function requireCodeForAccessGrant(
  supabase: Parameters<typeof getVerifiedMfaState>[0],
  userId: string,
  operation: string,
): Promise<CodeStepRefusal | null> {
  const state = await getVerifiedMfaState(supabase).catch(() => null);
  // Awaria Auth albo cudza tożsamość to odmowa, nie wejście na słowo.
  if (!state || state.status === 'unauthenticated' || state.user.id !== userId) {
    return { success: false, error: SESSION_NOT_CONFIRMED };
  }
  if (state.status === 'challenge_required') {
    return {
      success: false,
      mfaStepUp: true,
      error: `${operation} wymaga potwierdzenia kodem z aplikacji.`,
    };
  }
  return null;
}
