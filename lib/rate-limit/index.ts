import { createHash } from 'crypto';
import { getRedis, isRedisConfigured } from '@/lib/cache/redis';

export type RateLimitBucket =
  | 'login'
  | 'register'
  | 'password_reset'
  | 'two_factor_challenge'
  | 'gdpr_request'
  | 'support_chat'
  | 'newsletter'
  | 'reminder_preview'
  | 'nip_lookup'
  | 'ai_ocr'
  | 'ai_classify'
  | 'invoice_email'
  | 'invitation'
  // Portal księgowej: strony i pliki (`lib/rate-limit/accountant-portal.ts`, krok 6.2).
  | 'accountant_portal'
  | 'batch_pdf'
  | 'ksef_certificate'
  | 'passkey_login_options'
  | 'passkey_login_verify'
  | 'passkey_manage'
  | 'ksef_inbox_check';

export interface RateLimitConfig {
  /** Logiczny kubełek — jednoczęściowy prefix klucza Redis. */
  bucket: RateLimitBucket;
  /** Unikalny identyfikator (np. IP, email, IP+email). Hashowany przed zapisem. */
  identifier: string;
  /** Maksymalna liczba żądań w oknie. */
  limit: number;
  /** Długość okna w sekundach. */
  windowSeconds: number;
  /**
   * Czy odmowa też dopisuje znacznik do okna. Domyślnie tak (dla większości kubełków odmowa ma
   * kosztować, żeby brute-force nie opłacał się dalej). Przy `false` odmowa niczego nie dopisuje:
   * kliknięcie w trakcie blokady jej nie wydłuża, a `retryAfter` jest czasem, po którym próba
   * naprawdę przejdzie. Dla kubełków, w których klient jest uczciwym człowiekiem, a nie atakiem.
   */
  countDenied?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Sekund do najbliższej dozwolonej próby (0 gdy allowed=true). */
  retryAfter: number;
  /**
   * Gdy Redis nieskonfigurowany lub padł — limit liczony w pamięci procesu
   * (AUD-62). Jedna instancja web, więc działa; przy kilku instancjach każda
   * liczyłaby osobno. Kto potrzebuje limitu wspólnego, traktuje flagę jak odmowę.
   */
  fallback?: boolean;
  /**
   * Tylko przy `allowed: true`. Zwraca tę jedną próbę do limitu, np. gdy nie powiodła się z winy
   * kogoś innego niż klient (KSeF zwrócił 5xx). Idempotentny, nie rzuca: gdy zwrot się nie uda,
   * próba zostaje zużyta, tak jak przed jego dodaniem.
   */
  refund?: () => Promise<void>;
}

/**
 * Sliding window rate limiter na Redisie (sorted set per identifier; klient
 * HTTP z `lib/cache/redis.ts` — na produkcji własny Redis na app-1).
 *
 * Pipeline atomowo: usuń poza-oknem → dodaj teraz → zlicz → ustaw TTL.
 * Gdy count > limit — odrzucamy bieżący request (został już zapisany, ale
 * to OK, sliding window i tak go wymiotę po `windowSeconds`).
 *
 * Bez Redisa (lokalnie albo przy jego awarii) limit liczy pamięć procesu
 * (AUD-62). Wcześniej był wtedy fail-open, czyli logowanie, rejestracja
 * i reset hasła bez żadnego limitu prób.
 */
export async function checkRateLimit(
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  if (!isRedisConfigured()) {
    return checkInMemory(config);
  }

  const key = `rl:${config.bucket}:${hashIdentifier(config.identifier)}`;
  const now = Date.now();
  const windowStart = now - config.windowSeconds * 1000;
  const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    const redis = getRedis();
    const pipe = redis.pipeline();
    pipe.zremrangebyscore(key, 0, windowStart);
    pipe.zadd(key, { score: now, member });
    pipe.zcard(key);
    pipe.expire(key, config.windowSeconds);
    const results = await pipe.exec<[number, number, number, number]>();
    const count = results[2] ?? 0;

    const allowed = count <= config.limit;
    const remaining = Math.max(0, config.limit - count);

    if (allowed) {
      return { allowed: true, remaining, retryAfter: 0, refund: () => removeRedisHit(key, member) };
    }

    // Kubełek bez liczenia odmów: znacznik tej odmowy znika od razu. Gdy usunięcie się nie uda,
    // zostaje jak zawsze (odmowa liczy się do okna), a limit dalej działa.
    if (config.countDenied === false) await removeRedisHit(key, member);

    // Najstarszy timestamp w oknie wyznacza moment, w którym slot się zwolni.
    const oldest = (await redis.zrange(key, 0, 0, {
      withScores: true,
    })) as Array<string | number>;
    let retryAfter = config.windowSeconds;
    if (oldest.length >= 2) {
      const oldestTs = Number(oldest[1]);
      retryAfter = Math.max(
        1,
        Math.ceil((oldestTs + config.windowSeconds * 1000 - now) / 1000),
      );
    }

    return { allowed: false, remaining: 0, retryAfter };
  } catch (err) {
    console.error('[rate-limit] Redis error — limit w pamięci procesu:', err);
    return checkInMemory(config);
  }
}

/** Usuwa jeden znacznik z okna w Redisie. Nie rzuca: wywołuje się go po fakcie, a limit ma działać dalej. */
async function removeRedisHit(key: string, member: string): Promise<void> {
  try {
    await getRedis().zrem(key, member);
  } catch (err) {
    console.error('[rate-limit] Redis error przy zwrocie próby:', err);
  }
}

/** Okna w pamięci procesu: klucz → znaczniki czasu żądań w oknie. */
const memoryWindows = new Map<string, number[]>();
/** Górna granica kluczy — przy zalewie unikalnych IP najstarsze wypadają. */
const MAX_MEMORY_KEYS = 20_000;

function checkInMemory(config: RateLimitConfig): RateLimitResult {
  const key = `${config.bucket}:${hashIdentifier(config.identifier)}`;
  const now = Date.now();
  const windowStart = now - config.windowSeconds * 1000;
  const hits = (memoryWindows.get(key) ?? []).filter((t) => t > windowStart);
  const full = hits.length >= config.limit;
  // Odmowa bez liczenia: okno zostaje takie, jakie było (tylko odświeżamy jego miejsce w kolejce kluczy).
  const record = !(full && config.countDenied === false);
  if (record) hits.push(now);
  memoryWindows.delete(key);
  memoryWindows.set(key, hits);
  if (memoryWindows.size > MAX_MEMORY_KEYS) {
    const oldest = memoryWindows.keys().next().value;
    if (oldest !== undefined) memoryWindows.delete(oldest);
  }

  if (!full) {
    let refunded = false;
    const refund = async () => {
      if (refunded) return;
      refunded = true;
      const current = memoryWindows.get(key);
      const index = current?.lastIndexOf(now) ?? -1;
      if (index >= 0) current!.splice(index, 1);
    };
    return { allowed: true, remaining: config.limit - hits.length, retryAfter: 0, fallback: true, refund };
  }
  // Domyślnie czekamy do wygaśnięcia najstarszego znacznika (jak zawsze). Bez liczenia odmów okno
  // ma dokładnie `limit` znaczników, a miejsce zwalnia ten, po którego wygaśnięciu zostaje ich `limit - 1`.
  const unlocking = (record ? hits[0] : hits[Math.max(0, hits.length - config.limit)]) ?? now;
  const retryAfter = Math.max(1, Math.ceil((unlocking + config.windowSeconds * 1000 - now) / 1000));
  return { allowed: false, remaining: 0, retryAfter, fallback: true };
}

/**
 * SHA-256 truncated do 32 znaków — nie trzymamy plaintext IP/email w Redis.
 * Drobna ochrona w razie wycieku snapshotu cache'a.
 */
export function hashIdentifier(id: string): string {
  return createHash('sha256').update(id.toLowerCase()).digest('hex').slice(0, 32);
}
