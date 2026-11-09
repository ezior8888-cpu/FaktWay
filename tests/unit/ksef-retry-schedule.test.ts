import { describe, expect, it } from 'vitest';

import {
  getKsefRetryDelay,
  KSEF_MAX_RETRIES,
  KSEF_TENANT_CONCURRENCY_LIMIT,
} from '@/lib/jobs/retry-schedule';

/**
 * TEST-2 (audyt przedlaunchowy): schedule retry KSeF. Jeśli to się rozjedzie,
 * faktury albo bombardują MF (za szybko), albo za późno trafiają do Offline24.
 * Spec Fazy 23: 30s → 2m → 5m → 15m → 1h, po wyczerpaniu → Offline24.
 */

describe('getKsefRetryDelay — sekwencja backoff', () => {
  it('dokładna sekwencja dla prób 0-4', () => {
    expect(getKsefRetryDelay(0)).toBe('30s');
    expect(getKsefRetryDelay(1)).toBe('2m');
    expect(getKsefRetryDelay(2)).toBe('5m');
    expect(getKsefRetryDelay(3)).toBe('15m');
    expect(getKsefRetryDelay(4)).toBe('1h');
  });

  it('rosnące opóźnienia (monotoniczność intencji)', () => {
    const toSeconds = (t: string): number => {
      const n = parseInt(t, 10);
      if (t.endsWith('h')) return n * 3600;
      if (t.endsWith('m')) return n * 60;
      return n;
    };
    const seq = [0, 1, 2, 3, 4].map((i) => toSeconds(getKsefRetryDelay(i)));
    for (let i = 1; i < seq.length; i += 1) {
      expect(seq[i]).toBeGreaterThan(seq[i - 1]!);
    }
  });

  it('attempt ponad zakres ⇒ fallback do max (1h), bez crasha', () => {
    expect(getKsefRetryDelay(5)).toBe('1h');
    expect(getKsefRetryDelay(99)).toBe('1h');
  });

  it('ujemny attempt ⇒ pierwsze opóźnienie (defensive)', () => {
    expect(getKsefRetryDelay(-1)).toBe('30s');
    expect(getKsefRetryDelay(-100)).toBe('30s');
  });
});

describe('stałe limitów', () => {
  it('5 retries = 6 prób = 5 opóźnień w schedule', () => {
    expect(KSEF_MAX_RETRIES).toBe(5);
    // każda z prób 0..4 ma zdefiniowane opóźnienie
    for (let i = 0; i < KSEF_MAX_RETRIES; i += 1) {
      expect(typeof getKsefRetryDelay(i)).toBe('string');
    }
  });

  it('limit wysyłek naraz na firmę: 2 (L1a)', () => {
    // L1a (08.11.2026): MF liczy limity na parę (NIP, IP), a cała platforma
    // wysyła z jednego adresu. Dawne 100 ze spec Fazy 23 oznaczało brak limitu:
    // jedna firma zajmowała wszystkie 5 slotów wysyłki. 2 wysyłki naraz to do
    // ok. 60 zapytań o status na minutę przy limicie MF 120 (`invoiceStatus`).
    expect(KSEF_TENANT_CONCURRENCY_LIMIT).toBe(2);
  });
});
