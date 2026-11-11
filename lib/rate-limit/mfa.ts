import 'server-only';

import { getRedis, isRedisConfigured } from '@/lib/cache/redis';
import { hashIdentifier } from '@/lib/rate-limit';

const ATTEMPT_LIMIT = 5;
const WINDOW_SECONDS = 300;
const WINDOW_MS = WINDOW_SECONDS * 1000;

export interface MfaRateLimitResult {
  allowed: boolean;
  /** Seconds until another attempt; zero only when allowed. */
  retryAfter: number;
  /** Invalid input/configuration, a Redis error, or an untrusted Redis reply. */
  unavailable: boolean;
}

/**
 * One Redis EVAL makes the read, decision and write atomic across app instances.
 * A fixed window starts with the first attempt. INCR preserves its original TTL;
 * denied attempts neither increment beyond five nor prolong the window.
 * Only one expiring, hashed account key is stored (no per-attempt members).
 */
const MFA_ATTEMPT_SCRIPT = `
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
  return redis.error_reply('Invalid MFA rate-limit state')
end

if count >= limit then
  return {0, count, ttl}
end

count = redis.call('INCR', KEYS[1])
return {1, count, ttl}
`;

function unavailable(): MfaRateLimitResult {
  return { allowed: false, retryAfter: WINDOW_SECONDS, unavailable: true };
}

function hasValidRedisConfiguration(): boolean {
  if (!isRedisConfigured()) return false;

  const rawUrl = process.env.UPSTASH_REDIS_REST_URL!;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!;
  if (/\s/.test(rawUrl) || /\s/.test(token)) return false;

  const url = new URL(rawUrl);
  return (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.hostname.length > 0 &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}

function isValidReply(reply: unknown): reply is [number, number, number] {
  if (!Array.isArray(reply) || reply.length !== 3) return false;
  const [allowed, count, ttl] = reply as unknown[];
  return (
    (allowed === 0 || allowed === 1) &&
    typeof count === 'number' &&
    Number.isSafeInteger(count) &&
    count >= 1 &&
    count <= ATTEMPT_LIMIT &&
    typeof ttl === 'number' &&
    Number.isSafeInteger(ttl) &&
    ttl >= 0 &&
    ttl <= WINDOW_MS &&
    (allowed === 1 || count === ATTEMPT_LIMIT)
  );
}

/**
 * Call only with the authoritative user ID returned by Supabase auth.getUser().
 * Every MFA verification path shares this account limit, independently of IP.
 * Unlike the general limiter, MFA fails closed in every environment.
 */
export async function checkMfaRateLimit(userId: string): Promise<MfaRateLimitResult> {
  try {
    if (
      typeof userId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(userId) ||
      !hasValidRedisConfiguration()
    ) {
      return unavailable();
    }

    const key = `rl:mfa:account:${hashIdentifier(userId)}`;
    // Limit 2 s: przerwanie nie cofa skryptu, a ten zużywa próbę (lib/cache/redis.ts).
    const reply: unknown = await getRedis('failClosedLimiter').eval(
      MFA_ATTEMPT_SCRIPT,
      [key],
      [ATTEMPT_LIMIT, WINDOW_MS],
    );
    if (!isValidReply(reply)) return unavailable();

    const [allowed, , ttl] = reply;
    return {
      allowed: allowed === 1,
      retryAfter: allowed === 1 ? 0 : Math.max(1, Math.ceil(ttl / 1000)),
      unavailable: false,
    };
  } catch {
    // Redis errors can contain credentials or request data. Do not log them.
    return unavailable();
  }
}
