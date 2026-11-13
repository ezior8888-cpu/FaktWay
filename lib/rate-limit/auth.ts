import { checkRateLimit, type RateLimitResult } from './index';

/**
 * Limity dobrane konserwatywnie z myślą o legalnym ruchu mikrofirm.
 *
 * Login: 5/15min/(IP+email). Per-(IP+email) zamiast samego IP — chroni
 * przed credential stuffing (atakujący próbuje listę haseł na jeden email),
 * ale nie blokuje całego biura za jednym NAT-em po jednym ludziku.
 *
 * Register: 3/15min/IP. Per-IP, bo register tworzy nowe konta — per-email
 * nie ma sensu (każdy register ma inny email). Spam signup mitigation,
 * komplementarny do Turnstile (Krok 4).
 *
 * Password reset: 5/h/email. Anti-email-bombing — ktoś nie może zalać
 * twojej skrzynki linkami resetowymi. Per-email, bo IP może być różne
 * (np. zapomniałem hasła i piszę z domu/biura/kawiarni).
 */
export async function checkLoginRateLimit(
  ip: string,
  email: string,
): Promise<RateLimitResult> {
  return checkRateLimit({
    bucket: 'login',
    identifier: `${ip}:${email}`,
    limit: 5,
    windowSeconds: 15 * 60,
  });
}

export async function checkRegisterRateLimit(
  ip: string,
): Promise<RateLimitResult> {
  return checkRateLimit({
    bucket: 'register',
    identifier: ip,
    limit: 3,
    windowSeconds: 15 * 60,
  });
}

export async function checkPasswordResetRateLimit(
  email: string,
): Promise<RateLimitResult> {
  return checkRateLimit({
    bucket: 'password_reset',
    identifier: email,
    limit: 5,
    windowSeconds: 60 * 60,
  });
}

/**
 * Logowanie hasłem z telefonu (`POST /api/mobile/v1/logowanie`, plan aplikacji
 * mobilnej M6b, decyzja D16). Na stronie przed GoTrue stoi Turnstile, a trasa
 * telefonu nie ma captchy (loguje kluczem serwisowym), więc oprócz limitu strony
 * (`checkLoginRateLimit`, wspólny kubełek: próby z telefonu i z formularza liczą
 * się razem) ma dwa własne:
 *
 * - na adres IP: 20 na 15 minut. Zastępuje captchę przy credential stuffing
 *   (wiele kont z jednego adresu); kilka telefonów biura za jednym NAT-em mieści się z zapasem.
 * - na e-mail: 10 na 15 minut z dowolnych adresów. Hamuje rozproszone zgadywanie
 *   hasła jednego konta. Koszt: ktoś, kto zna adres, może na 15 minut zablokować
 *   logowanie tego konta w aplikacji; strona (z Turnstile) działa wtedy dalej.
 *
 * Każde wywołanie liczy się w oknie, także odmowa (jak `login` strony).
 */
export const MOBILE_LOGIN_RATE_LIMITS = {
  ip: { limit: 20, windowSeconds: 15 * 60 },
  email: { limit: 10, windowSeconds: 15 * 60 },
} as const;

/**
 * Trzy limity po kolei (adres, e-mail, wspólny ze stroną); pierwsza odmowa
 * kończy sprawdzanie, więc dalsze kubełki jej nie liczą. Wynik z `fallback: true`
 * (bez Redisa limit liczy pamięć procesu) wywołujący traktuje jak odmowę.
 */
export async function checkMobileLoginRateLimits(ip: string, email: string): Promise<RateLimitResult> {
  const byIp = await checkRateLimit({ bucket: 'mobile_login_ip', identifier: ip, ...MOBILE_LOGIN_RATE_LIMITS.ip });
  if (!byIp.allowed || byIp.fallback) return byIp;
  const byEmail = await checkRateLimit({ bucket: 'mobile_login_email', identifier: email, ...MOBILE_LOGIN_RATE_LIMITS.email });
  if (!byEmail.allowed || byEmail.fallback) return byEmail;
  return checkLoginRateLimit(ip, email);
}
