import { SUPPORT_EMAIL } from '@/lib/site';
import type { KsefEnvironment } from '@/types/ksef';

import { ksefApplicationUrl, KSEF_ENVIRONMENT_LABELS } from './application-url';
import { KsefAuthRejectedError } from './auth-errors';
import { KsefApiError } from './client';
import type { CredentialProblem } from './connect-credentials';

/**
 * Komunikaty kreatora podłączenia KSeF. Każda blokada mówi, CO ZROBIĆ, a treść
 * wyjątków KSeF nigdy nie wraca do klienta: z odpowiedzi bierzemy tylko kod
 * i szczegóły z dokumentacji MF (tabela statusów uwierzytelnienia) i zamieniamy
 * je na jedno z poniższych zdań. Ostatnia deska ratunku to zawsze adres pomocy.
 */

/** Powód odmowy KSeF przy próbnym logowaniu (kreator wraca wtedy do właściwego kroku). */
export type KsefFailureReason =
  | 'no_permission'
  | 'not_owner'
  | 'revoked'
  | 'untrusted_issuer'
  | 'invalid_certificate'
  | 'blocked'
  | 'unavailable'
  | 'rejected';

export function classifyKsefAuthFailure(error: unknown): KsefFailureReason {
  if (error instanceof KsefAuthRejectedError) {
    const text = [error.description, ...error.details].join(' ').toLowerCase();
    if (error.code === 415) return 'no_permission';
    if (error.code === 425) return 'revoked';
    if (error.code === 460) {
      if (/odwołan|zawieszon/.test(text)) return 'revoked';
      if (/łańcuch|niezaufan/.test(text)) return 'untrusted_issuer';
      return 'invalid_certificate';
    }
    if (error.code === 470 || error.code === 480) return 'blocked';
    if (error.code >= 500) return 'unavailable';
    return 'rejected';
  }
  if (error instanceof KsefApiError) {
    // 408, 429 i 5xx to chwilowe kłopoty po stronie KSeF albo sieci, nie wina certyfikatu.
    return error.isRetryable || error.status === 0 ? 'unavailable' : 'rejected';
  }
  // Błąd sieci (fetch failed, ECONNRESET) i przekroczony czas oczekiwania na status.
  if (error instanceof Error && /timed out|fetch failed|econn|enotfound|network|socket/i.test(error.message)) {
    return 'unavailable';
  }
  return 'rejected';
}

function formatDate(date: Date | undefined): string {
  if (!date) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()}`;
}

export function credentialProblemMessage(
  problem: CredentialProblem,
  details: { validFrom?: Date; validTo?: Date } = {},
): string {
  switch (problem) {
    case 'cert_unreadable':
      return 'Nie możemy odczytać pliku certyfikatu. Wybierz plik z końcówką .crt pobrany z Aplikacji Podatnika (nie klucz prywatny i nie plik .pfx).';
    case 'key_unreadable':
      return 'Nie możemy odczytać pliku klucza prywatnego. Wybierz plik z końcówką .key, który pobrał się przy tworzeniu certyfikatu. Jeśli go nie masz, wygeneruj nowy certyfikat, bo klucza nie da się pobrać po raz drugi.';
    case 'password_required':
      return 'Ten klucz jest chroniony hasłem. Wpisz hasło ustawione przy tworzeniu certyfikatu w Aplikacji Podatnika.';
    case 'password_wrong':
      return 'To hasło nie pasuje do klucza. Wpisz hasło ustawione przy tworzeniu certyfikatu. Jeśli go nie pamiętasz, wygeneruj nowy certyfikat, bo hasła nie da się odzyskać.';
    case 'key_unsupported':
      return 'FaktWay obsługuje klucze RSA 2048 oraz EC P-256, takie jak w certyfikatach z Aplikacji Podatnika. Ten klucz jest innego rodzaju albo za krótki. Wygeneruj certyfikat w Aplikacji Podatnika.';
    case 'key_mismatch':
      return 'Ten klucz nie pasuje do tego certyfikatu. Wybierz certyfikat i klucz z tego samego wniosku (mają tę samą nazwę).';
    case 'cert_expired':
      return `Ten certyfikat wygasł${details.validTo ? ` ${formatDate(details.validTo)}` : ''}. Wygeneruj nowy w Aplikacji Podatnika.`;
    case 'cert_not_yet_valid':
      return `Ten certyfikat zacznie obowiązywać dopiero ${formatDate(details.validFrom) || 'w przyszłości'}. Wróć po tej dacie albo wygeneruj certyfikat z wcześniejszą datą rozpoczęcia ważności.`;
    case 'cert_offline':
      return 'To certyfikat typu Offline (do podpisywania linku weryfikującego wystawcę), a nie do logowania do KSeF. Wygeneruj certyfikat z przeznaczeniem „Uwierzytelnienie w systemie KSeF”.';
  }
}

export function ksefFailureMessage(
  reason: KsefFailureReason,
  context: { nip: string; env: KsefEnvironment },
): string {
  const app = `Aplikacji Podatnika (${ksefApplicationUrl(context.env)})`;
  switch (reason) {
    case 'no_permission':
      return `KSeF nie przypisał tego certyfikatu do firmy z NIP ${context.nip}. Certyfikat musi być wystawiony w ${app} po zalogowaniu na tę właśnie firmę. Sprawdź, na którą firmę się logujesz.`;
    case 'not_owner':
      return `Certyfikat jest poprawny, ale nie daje uprawnień właścicielskich do NIP ${context.nip}. Połączyć FaktWay z KSeF może tylko właściciel firmy w KSeF. Poproś właściciela o wygenerowanie certyfikatu w ${app}.`;
    case 'revoked':
      return `KSeF informuje, że ten certyfikat został unieważniony albo zawieszony. Wygeneruj nowy w ${app} i wgraj go tutaj.`;
    case 'untrusted_issuer':
      return `KSeF nie rozpoznaje wystawcy tego certyfikatu. Zwykle to certyfikat z innego środowiska KSeF niż to, do którego podłączony jest FaktWay (środowisko ${KSEF_ENVIRONMENT_LABELS[context.env]}). Pobierz go z ${app}.`;
    case 'invalid_certificate':
      return `KSeF uznał ten certyfikat za nieważny. Sprawdź datę ważności w ${app} albo wygeneruj nowy certyfikat.`;
    case 'blocked':
      return `KSeF zablokował uwierzytelnienie dla tego podmiotu. Skontaktuj się z Ministerstwem Finansów przez formularz zgłoszeniowy KSeF albo napisz do nas: ${SUPPORT_EMAIL}.`;
    case 'unavailable':
      return 'KSeF jest chwilowo niedostępny albo przeciążony. Niczego nie zapisaliśmy, a Twoje pliki są nadal wybrane. Spróbuj ponownie za kilka minut.';
    case 'rejected':
      return `KSeF nie potwierdził tego certyfikatu. Sprawdź, czy to certyfikat z przeznaczeniem „Uwierzytelnienie w systemie KSeF” i czy wybrano klucz z tego samego wniosku. Jeśli to się powtarza, napisz do nas: ${SUPPORT_EMAIL}.`;
  }
}
