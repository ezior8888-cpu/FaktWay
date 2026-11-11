import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isNoSessionPath, isPublicPath } from '@/lib/supabase/middleware';

/**
 * `GET /api/kalendarz/<token>.ics` (krok 7.3 planu kompletnej aplikacji):
 * publiczna, uwierzytelniona samym niezgadywalnym tokenem. Zły albo cofnięty
 * token to 404 (bez rozróżniania), nadmiar prób to 429, a odpowiedź nie
 * trafia do wspólnego cache'u.
 */

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  rate: vi.fn(),
  zbierz: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.rate, hashIdentifier: (x: string) => x }));
vi.mock('@/lib/kalendarz/zbierz', () => ({ zbierzZdarzenia: mocks.zbierz }));

const TOKEN = 'a'.repeat(43);
const TENANT = '11111111-1111-4111-8111-111111111111';

async function call(plik: string, ip = '203.0.113.7') {
  const { GET } = await import('@/app/api/kalendarz/[plik]/route');
  return GET(new NextRequest(`https://faktway.pl/api/kalendarz/${plik}`, { headers: { 'x-forwarded-for': ip } }), {
    params: Promise.resolve({ plik }),
  });
}

describe('GET /api/kalendarz/[plik]', () => {
  beforeEach(() => {
    mocks.rpc.mockReset().mockResolvedValue({ data: TENANT, error: null });
    mocks.rate.mockReset().mockResolvedValue({ allowed: true, remaining: 10, retryAfter: 0 });
    mocks.zbierz.mockReset().mockResolvedValue([
      { uid: 'faktura-1@faktway.pl', data: '2026-11-20', tytul: 'Płatność: FV/1', opis: 'Kwota 10,00 zł' },
    ]);
  });

  it('dobry token: kalendarz z właściwymi nagłówkami, tenant z funkcji bazy po skrócie tokenu', async () => {
    const res = await call(`${TOKEN}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, max-age=900');
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('UID:faktura-1@faktway.pl');
    const [nazwa, argumenty] = mocks.rpc.mock.calls[0] as [string, { p_token_hash: string }];
    expect(nazwa).toBe('calendar_feed_tenant');
    expect(argumenty.p_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(argumenty)).not.toContain(TOKEN);
    expect(mocks.zbierz).toHaveBeenCalledWith(expect.anything(), TENANT, expect.any(Date));
  });

  it('token nieznany albo cofnięty (baza zwraca null): 404 bez treści kalendarza', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const res = await call(`${TOKEN}.ics`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).not.toContain('VCALENDAR');
    expect(mocks.zbierz).not.toHaveBeenCalled();
  });

  it.each(['abc.ics', `${TOKEN}`, `${TOKEN}.txt`, `${'a'.repeat(200)}.ics`, `${TOKEN.slice(0, 40)}***.ics`])(
    'zły kształt nazwy %s: 404 bez pytania bazy',
    async (plik) => {
      const res = await call(plik);
      expect(res.status).toBe(404);
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it('przekroczony limit prób z adresu IP: 429 z Retry-After, baza nietknięta', async () => {
    mocks.rate.mockResolvedValue({ allowed: false, remaining: 0, retryAfter: 120 });
    const res = await call(`${TOKEN}.ics`);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.rate).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'calendar_feed', identifier: '203.0.113.7' }));
  });

  it('błąd bazy przy sprawdzaniu tokenu: 503, nigdy pusty kalendarz', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'down' } });
    const res = await call(`${TOKEN}.ics`);
    expect(res.status).toBe(503);
  });

  it('proxy: trasa publiczna i bez klienta sesji', () => {
    expect(isPublicPath(`/api/kalendarz/${TOKEN}.ics`)).toBe(true);
    expect(isNoSessionPath(`/api/kalendarz/${TOKEN}.ics`)).toBe(true);
    expect(isPublicPath('/api/kalendarzyk/x')).toBe(false);
  });
});
