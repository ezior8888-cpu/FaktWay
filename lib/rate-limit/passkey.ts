import { checkRateLimit, type RateLimitResult } from './index';

/**
 * Logowanie biometrią nie ma Turnstile: asercji nie podrobi bot bez klucza
 * z uwierzytelniacza. Limity chronią przed zalewem tabeli wyzwań i kosztem
 * weryfikacji, a nie przed zgadywaniem.
 *
 * Opcje: pole e-mail prosi o nie przy każdym wejściu na `/login` (podpowiedź
 * przeglądarki), a jedno biuro to często jeden adres IP, więc limit jest luźny.
 */
export function checkPasskeyLoginOptionsRateLimit(ip: string): Promise<RateLimitResult> {
  return checkRateLimit({ bucket: 'passkey_login_options', identifier: ip, limit: 60, windowSeconds: 5 * 60 });
}

export function checkPasskeyLoginVerifyRateLimit(ip: string): Promise<RateLimitResult> {
  return checkRateLimit({ bucket: 'passkey_login_verify', identifier: ip, limit: 30, windowSeconds: 5 * 60 });
}

/** Dodawanie i usuwanie urządzeń: na konto, nie na adres. */
export function checkPasskeyManageRateLimit(userId: string): Promise<RateLimitResult> {
  return checkRateLimit({ bucket: 'passkey_manage', identifier: userId, limit: 20, windowSeconds: 15 * 60 });
}
