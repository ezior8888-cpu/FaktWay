import 'server-only';

import { getRedis, isRedisConfigured } from '@/lib/cache/redis';
import { hashIdentifier } from '@/lib/rate-limit';

export interface PasswordRateLimitResult {
  allowed: boolean;
  retryAfter: number;
  unavailable: boolean;
}

// Independent of the MFA keys: password operations must not exhaust TOTP attempts.
const POLICIES = {
  attempt: { limit: 5, windowSeconds: 300 },
  send: { limit: 1, windowSeconds: 60 },
  resetEmail: { limit: 5, windowSeconds: 3600 },
  resetIp: { limit: 10, windowSeconds: 3600 },
  recoveryUse: { limit: 1, windowSeconds: 16 * 60 },
} as const;

const PASSWORD_ATTEMPT_SCRIPT = `
local limit = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], 1, 'PX', windowMs)
  return {1, 1, windowMs}
end
local count = tonumber(current)
local ttl = redis.call('PTTL', KEYS[1])
if not count or count < 1 or count > limit or count ~= math.floor(count)
  or ttl < 0 or ttl > windowMs then
  return redis.error_reply('Invalid password rate-limit state')
end
if count >= limit then
  return {0, count, ttl}
end
count = redis.call('INCR', KEYS[1])
return {1, count, ttl}
`;

async function checkPasswordLimit(
  userId: string,
  kind: keyof typeof POLICIES,
): Promise<PasswordRateLimitResult> {
  const { limit, windowSeconds } = POLICIES[kind];
  const windowMs = windowSeconds * 1000;
  const unavailable = { allowed: false, retryAfter: windowSeconds, unavailable: true };
  try {
    if (typeof userId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(userId) || !isRedisConfigured()) {
      return unavailable;
    }
    const rawUrl = process.env.UPSTASH_REDIS_REST_URL!;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
    if (/\s/.test(rawUrl) || /\s/.test(token)) return unavailable;
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
        url.username || url.password || url.search || url.hash) return unavailable;

    // Limit 2 s: przerwanie nie cofa skryptu, a ten zużywa próbę albo jednorazowe
    // potwierdzenie resetu (lib/cache/redis.ts).
    const reply: unknown = await getRedis('failClosedLimiter').eval(
      PASSWORD_ATTEMPT_SCRIPT,
      [`rl:password:${kind}:account:${hashIdentifier(userId)}`],
      [limit, windowMs],
    );
    if (!Array.isArray(reply) || reply.length !== 3) return unavailable;
    const [allowed, count, ttl] = reply as unknown[];
    if ((allowed !== 0 && allowed !== 1) ||
        typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > limit ||
        typeof ttl !== 'number' || !Number.isSafeInteger(ttl) || ttl < 0 || ttl > windowMs ||
        (allowed === 0 && count !== limit)) return unavailable;

    return {
      allowed: allowed === 1,
      retryAfter: allowed === 1 ? 0 : Math.max(1, Math.ceil(ttl / 1000)),
      unavailable: false,
    };
  } catch {
    // Redis transport errors can include credentials. Never return or log them.
    return unavailable;
  }
}

/** Every password change or nonce-send attempt shares this fixed account window. */
export async function checkPasswordOperationRateLimit(userId: string): Promise<PasswordRateLimitResult> {
  return checkPasswordLimit(userId, 'attempt');
}

/** Additional cooldown before sending an email/SMS nonce, including retries. */
export async function checkPasswordNonceSendRateLimit(userId: string): Promise<PasswordRateLimitResult> {
  return checkPasswordLimit(userId, 'send');
}

/** Email and IP budgets independent of authenticated password attempts. */
export async function checkPasswordRecoveryRequestRateLimit(
  email: string, ip: string,
): Promise<PasswordRateLimitResult> {
  if (!email || email.length > 254 || !ip || ip.length > 128) {
    return { allowed: false, retryAfter: 3600, unavailable: true };
  }
  const ipLimit = await checkPasswordLimit(hashIdentifier(ip), 'resetIp');
  if (!ipLimit.allowed) return ipLimit;
  return checkPasswordLimit(hashIdentifier(email), 'resetEmail');
}

/**
 * One attempt per verified recovery session, atomically before password update.
 * 16 minutes exceeds the guard's 15-minute AMR lifetime + 30s clock tolerance.
 * Do not release this claim after a failed/uncertain Auth call.
 */
export async function claimPasswordRecoverySession(sessionId: string): Promise<PasswordRateLimitResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return { allowed: false, retryAfter: 16 * 60, unavailable: true };
  }
  return checkPasswordLimit(sessionId.toLowerCase(), 'recoveryUse');
}
