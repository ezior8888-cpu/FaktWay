import 'server-only';

import { isLocalDevEnv } from './environment';
import { isTurnstileBypassActive, verifyTurnstile, type VerifyTurnstileOptions } from './turnstile';

/**
 * Przełącznik kroku 2 (docs/runbooks/captcha-w-gotrue.md): token sprawdza
 * GoTrue, nie aplikacja. Token działa tylko raz, więc przy włączonym
 * przełączniku aplikacja nie pyta Cloudflare sama, tylko przekazuje token
 * do GoTrue. Włączać razem z `GOTRUE_SECURITY_CAPTCHA_ENABLED`: najpierw
 * ten przełącznik, potem GoTrue.
 */
export function isCaptchaCheckedByGoTrue(): boolean {
  return process.env.AUTH_CAPTCHA_IN_GOTRUE?.trim() === 'true';
}

export type BotCheckResult =
  | { ok: true; /** Do przekazania GoTrue (`captchaToken`). */ captchaToken?: string }
  | { ok: false };

/** Token Turnstile z formularza, jeśli wygląda na token (nie plik, nie śmieć). */
export function readTurnstileToken(formData: FormData): string | undefined {
  const value = formData.get('cf-turnstile-response');
  return typeof value === 'string' && value.length >= 10 && value.length <= 2048 ? value : undefined;
}

/**
 * Sprawdzenie bota w akcjach, które potem wołają GoTrue (logowanie,
 * rejestracja, reset hasła). Przy wyłączonym przełączniku jak dotąd:
 * `verifyTurnstile`. Przy włączonym: tylko obecność tokenu, a sam token
 * idzie do GoTrue. Lokalnie (bez widżetu) i w teście obciążeniowym bez zmian.
 * Test: `tests/unit/captcha-w-gotrue.test.ts`.
 */
export async function checkBotBeforeGoTrue(
  formData: FormData,
  ip?: string,
  options?: VerifyTurnstileOptions,
): Promise<BotCheckResult> {
  if (isCaptchaCheckedByGoTrue() && !isLocalDevEnv()) {
    if (options?.allowLoadTestBypass === true && (await isTurnstileBypassActive())) return { ok: true };
    const captchaToken = readTurnstileToken(formData);
    return captchaToken ? { ok: true, captchaToken } : { ok: false };
  }
  const raw = formData.get('cf-turnstile-response');
  const result = await verifyTurnstile(typeof raw === 'string' ? raw : null, ip, options);
  return result.success ? { ok: true } : { ok: false };
}

/**
 * Czy GoTrue odmówił z powodu captcha. Zły token: 400 `captcha_failed`.
 * Brak tokenu albo błąd po stronie Cloudflare: 500 „captcha verification
 * process failed” (GoTrue v2.186, `internal/api/middleware.go`).
 */
export function isGoTrueCaptchaRejection(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === 'captcha_failed') return true;
  return typeof error.message === 'string' && /captcha/i.test(error.message);
}
