/**
 * Stan kreatora podłączenia KSeF liczony na SERWERZE z tego, co wiemy o firmie
 * i koncie, żeby po powrocie (inna karta, odświeżenie, link z maila) klient
 * trafiał do właściwego kroku. Jedyne, czego serwer nie wie, to czy klient ma
 * już pliki z Aplikacji Podatnika: to jest `?krok=` w adresie (przycisk „Dalej”
 * to zwykły link, więc działa też Wstecz przeglądarki).
 */

export type WizardStepId = 'warunki' | 'certyfikat' | 'pliki' | 'polaczono';
export type WizardMfa = 'verified' | 'challenge_required' | 'enrollment_required' | 'unknown';

/** Pięć kroków z opisu: czwarty („Sprawdzamy w KSeF”) to stan oczekiwania na trzecim ekranie. */
export const WIZARD_STEPS = [
  { number: 1, title: 'Sprawdzenie warunków' },
  { number: 2, title: 'Pobierz certyfikat z KSeF' },
  { number: 3, title: 'Wgraj pliki' },
  { number: 4, title: 'Sprawdzamy w KSeF' },
  { number: 5, title: 'Połączono' },
] as const;

export const WIZARD_PATH = '/settings/ksef';
export const WIZARD_CERTIFICATE_HREF = `${WIZARD_PATH}?krok=certyfikat`;
export const WIZARD_FILES_HREF = `${WIZARD_PATH}?krok=pliki`;
/** Po zalogowaniu kodem z aplikacji klient wraca prosto do kreatora. */
export const WIZARD_TWO_FACTOR_HREF = `/login/two-factor?redirect=${WIZARD_PATH}`;

export interface WizardInput {
  hasNip: boolean;
  isOwner: boolean;
  mfa: WizardMfa;
  hasCredentials: boolean;
  /** Wartość `?krok=` z adresu (nieufna: tylko dwie wartości mają znaczenie). */
  requested?: string | null;
}

export function conditionsMet(input: Pick<WizardInput, 'hasNip' | 'isOwner' | 'mfa'>): boolean {
  return input.hasNip && input.isOwner && input.mfa === 'verified';
}

export function deriveWizardStep(input: WizardInput): WizardStepId {
  const reconnecting = input.requested === 'certyfikat' || input.requested === 'pliki';
  // Połączona firma widzi podsumowanie, chyba że świadomie odnawia certyfikat.
  if (input.hasCredentials && !reconnecting) return 'polaczono';
  if (!conditionsMet(input)) return 'warunki';
  return input.requested === 'pliki' ? 'pliki' : 'certyfikat';
}

export function stepNumber(step: WizardStepId): number {
  return { warunki: 1, certyfikat: 2, pliki: 3, polaczono: 5 }[step];
}

/** Po tych odmowach te same pliki już nie pomogą: trzeba pobrać inny certyfikat (krok 2). */
const NEEDS_NEW_CERTIFICATE = new Set([
  'no_permission',
  'not_owner',
  'revoked',
  'untrusted_issuer',
  'invalid_certificate',
  'cert_expired',
  'cert_not_yet_valid',
  'cert_offline',
  'key_unsupported',
  'key_unreadable',
]);

export function failureNeedsNewCertificate(reason: string): boolean {
  return NEEDS_NEW_CERTIFICATE.has(reason);
}

/** Powody, przy których pytamy o hasło albo je poprawiamy, bez ruszania plików. */
export function failureIsPassword(reason: string): boolean {
  return reason === 'password_required' || reason === 'password_wrong';
}
