import { describe, expect, it } from 'vitest';

import { formatPln } from '@/lib/billing/pricing';

/**
 * S-15 (sygnał z rozpoznania żelaznego filtra, plan B7.1): formatPln gubił
 * minus dla kwot od -0,99 zł do -0,01 zł (Math.trunc daje -0, a „-0” w
 * napisie to „0”), więc zwrot 0,50 zł wyglądał jak należność.
 */
describe('formatPln: znak kwoty', () => {
  it.each([
    [-50, '-0,50 zł'],
    [-1, '-0,01 zł'],
    [-150, '-1,50 zł'],
    [0, '0,00 zł'],
    [50, '0,50 zł'],
    [2999, '29,99 zł'],
  ])('%i gr → %s', (grosze, oczekiwane) => {
    expect(formatPln(grosze)).toBe(oczekiwane);
  });
});
