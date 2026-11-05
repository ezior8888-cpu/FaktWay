import { describe, expect, it } from 'vitest';

import { suggestsSplitPayment } from '@/lib/invoices/annotations';
import { VAT_EXEMPTION_PRESETS } from '@/lib/invoices/vat-exemption';
import { limitZwolnieniaVat } from '@/lib/ksiegowosc/parametry';

/**
 * AUD-96: MPP — art. 108a ust. 1a ustawy o VAT: kwota należności ogółem
 * „przekracza” 15 000 zł (tak też XSD FA(3)); podpowiedź pojawiała się już
 * przy równych 15 000 zł.
 * AUD-129: limit zwolnienia podmiotowego (art. 113 ust. 1) od 1.01.2026
 * wynosi 240 000 zł; aplikacja pokazywała 200 000 zł.
 */

describe('próg MPP', () => {
  it('dokładnie 15 000 zł — bez podpowiedzi', () => {
    expect(suggestsSplitPayment(15_000, false)).toBe(false);
  });
  it('15 000,01 zł — podpowiedź', () => {
    expect(suggestsSplitPayment(15_000.01, false)).toBe(true);
  });
  it('konsument — nigdy', () => {
    expect(suggestsSplitPayment(50_000, true)).toBe(false);
  });
});

describe('limit zwolnienia podmiotowego z VAT', () => {
  it('etykieta art. 113 ust. 1 podaje 240 000 zł', () => {
    expect(VAT_EXEMPTION_PRESETS[0].label).toContain('240 000 zł');
  });
  it('parametry podatkowe od 2026 — 240 000 zł (moduł księgowości, w groszach)', () => {
    expect(limitZwolnieniaVat('2026-01-01')).toBe(24_000_000);
    expect(limitZwolnieniaVat('2027-12-31')).toBe(24_000_000);
  });
});
