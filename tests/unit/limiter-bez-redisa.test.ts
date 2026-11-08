import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AUD-62 (decyzja B6): limiter bez Redisa przepuszczał wszystko — logowanie,
 * rejestracja i reset hasła bez limitu prób. (Audyt zakładał, że Redisa na
 * produkcji nie ma; stan 23.10.2026: jest — własny, na app-1. Test pilnuje
 * ścieżki awaryjnej.) Teraz bez Redisa limit liczony jest w pamięci procesu
 * (web to jedna instancja). IP: najpierw `X-Real-Ip` ustawiany przez
 * Traefika, potem OSTATNI wpis `X-Forwarded-For` (dopisany przez nasze proxy);
 * pierwszy wpis może podać sam klient.
 */

const hdr = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock('next/headers', () => ({ headers: async () => new Headers(hdr.values) }));
vi.mock('@/lib/cache/redis', () => ({ isRedisConfigured: () => false, getRedis: () => { throw new Error('brak'); } }));

import { getClientIp } from '@/lib/auth/get-client-ip';
import { checkRateLimit } from '@/lib/rate-limit';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('limiter bez Redisa', () => {
  it('egzekwuje limit w pamięci procesu', async () => {
    const cfg = { bucket: 'login' as const, identifier: 'ip:203.0.113.7', limit: 3, windowSeconds: 60 };
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await checkRateLimit(cfg));
    expect(results.slice(0, 3).every((r) => r.allowed)).toBe(true);
    expect(results[3]).toMatchObject({ allowed: false, remaining: 0 });
    expect(results[3]!.retryAfter).toBeGreaterThan(0);
    expect(results[3]!.fallback).toBe(true);
  });

  it('różne identyfikatory i kubełki liczą się osobno', async () => {
    const base = { limit: 1, windowSeconds: 60 };
    expect((await checkRateLimit({ ...base, bucket: 'register', identifier: 'a' })).allowed).toBe(true);
    expect((await checkRateLimit({ ...base, bucket: 'register', identifier: 'b' })).allowed).toBe(true);
    expect((await checkRateLimit({ ...base, bucket: 'password_reset', identifier: 'a' })).allowed).toBe(true);
    expect((await checkRateLimit({ ...base, bucket: 'register', identifier: 'a' })).allowed).toBe(false);
  });

  it('po upływie okna znowu wpuszcza', async () => {
    const cfg = { bucket: 'two_factor_challenge' as const, identifier: 'u1', limit: 1, windowSeconds: 60 };
    expect((await checkRateLimit(cfg)).allowed).toBe(true);
    expect((await checkRateLimit(cfg)).allowed).toBe(false);
    vi.setSystemTime(new Date('2026-10-02T12:01:01Z'));
    expect((await checkRateLimit(cfg)).allowed).toBe(true);
  });
});

describe('IP klienta', () => {
  it('X-Real-Ip od naszego proxy ma pierwszeństwo', async () => {
    hdr.values = { 'x-real-ip': '198.51.100.20', 'x-forwarded-for': '1.2.3.4, 198.51.100.20' };
    expect(await getClientIp()).toBe('198.51.100.20');
  });

  it('bez X-Real-Ip — ostatni wpis X-Forwarded-For, nie podany przez klienta pierwszy', async () => {
    hdr.values = { 'x-forwarded-for': '1.2.3.4, 198.51.100.20' };
    expect(await getClientIp()).toBe('198.51.100.20');
  });
});
