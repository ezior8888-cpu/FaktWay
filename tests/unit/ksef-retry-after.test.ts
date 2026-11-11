import { afterEach, describe, expect, it, vi } from 'vitest';

import { KsefApiError, ksefFetch, parseRetryAfterMs } from '@/lib/ksef/client';
import { ksefRetryDelayFor } from '@/lib/jobs/retry-schedule';

/**
 * AUD-92: przy 429 KSeF mówi w `Retry-After`, ile czekać. Komentarz w jobie
 * wysyłki obiecywał, że słuchamy — kod brał zawsze własny harmonogram
 * (30 s → 2 min → …), więc przy ostrzejszym limicie MF ponawialiśmy za wcześnie.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Retry-After z KSeF', () => {
  it.each([
    ['120', 120_000],
    ['0', 0],
    ['abc', null],
    [null, null],
  ])('nagłówek %s → %s ms', (header, ms) => {
    expect(parseRetryAfterMs(header as string | null, new Date('2026-10-02T03:00:00Z'))).toBe(ms);
  });

  it('data HTTP → różnica od teraz', () => {
    expect(parseRetryAfterMs('Fri, 02 Oct 2026 03:01:30 GMT', new Date('2026-10-02T03:00:00Z'))).toBe(90_000);
  });

  it('429 z nagłówkiem — błąd niesie czas oczekiwania', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '45' },
    })));

    const err = await ksefFetch('/test', { env: 'test' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(KsefApiError);
    expect((err as KsefApiError).retryAfterMs).toBe(45_000);
  });

  it('opóźnienie ponowienia: pełny Retry-After ma pierwszeństwo przed harmonogramem, bezpiecznik 24 h', () => {
    const tooFast = new KsefApiError(429, 'x', 'x', 300_000);
    expect(ksefRetryDelayFor(tooFast, 0)).toBe('300s');
    // L1a (08.11.2026): bez dawnego obcięcia do 3600 s — krótsze czekanie niż
    // podał MF tylko wydłuża blokadę. 2 h zostaje 2 h.
    const twoHours = new KsefApiError(429, 'x', 'x', 2 * 3600_000);
    expect(ksefRetryDelayFor(twoHours, 0)).toBe('7200s');
    // Absurdalny nagłówek: bezpiecznik `KSEF_PAUSE_MAX_MS` (doba), nie godzina.
    const absurd = new KsefApiError(429, 'x', 'x', 48 * 3600_000);
    expect(ksefRetryDelayFor(absurd, 0)).toBe('86400s');
    // Inne odpowiedzi z Retry-After (503) czekają z fakturą w `sending`: najwyżej godzinę.
    expect(ksefRetryDelayFor(new KsefApiError(503, 'x', 'x', 2 * 3600_000), 0)).toBe('3600s');
    expect(ksefRetryDelayFor(new KsefApiError(503, 'x', 'x'), 1)).toBe('2m');
    expect(ksefRetryDelayFor(new Error('ECONNRESET'), 0)).toBe('30s');
  });
});
