import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LimitKasyKarta } from '@/components/analizy/limit-kasy-karta';
import { limitKasy, type SprzedazDlaLimitu } from '@/lib/kasa-fiskalna/limit';

/**
 * Krok 9.3 planu kompletnej aplikacji, część 1 (licznik, R2). Rozporządzenie MF
 * z 17.12.2024 (Dz.U. 2024 poz. 1902) § 3 ust. 1 pkt 1-2, § 5 ust. 1 pkt 1-2:
 * limit 20 000 zł, w roku rozpoczęcia proporcjonalnie do okresu.
 */
const faktura = (id: string, f: Partial<SprzedazDlaLimitu> = {}): SprzedazDlaLimitu => ({
  id, issueDate: '2026-03-10', gross: 1000, kind: 'regular', isB2c: true, buyerNip: null, ...f,
});
const bezStartu = { year: 2026, businessStartedOn: null };

describe('limitKasy', () => {
  it('sumuje brutto sprzedaży dla osób prywatnych w roku i podaje stan', () => {
    const r = limitKasy([faktura('a', { gross: 14300 })], bezStartu);
    expect(r).toMatchObject({ sum: 14300, limit: 20000, state: 'below', proportional: false, startUnknown: true });
  });
  it('stan "blisko" od 80 % (włącznie)', () => {
    expect(limitKasy([faktura('a', { gross: 15999.99 })], bezStartu).state).toBe('below');
    expect(limitKasy([faktura('a', { gross: 16000 })], bezStartu).state).toBe('near');
  });
  it('stan "przekroczony" dopiero powyżej limitu (przepis: przekroczyła kwotę)', () => {
    expect(limitKasy([faktura('a', { gross: 20000 })], bezStartu).state).toBe('near');
    expect(limitKasy([faktura('a', { gross: 20000.01 })], bezStartu).state).toBe('exceeded');
  });
  it('miesiąc przekroczenia: liczony narastająco po dacie', () => {
    const r = limitKasy(
      [faktura('a', { gross: 15000, issueDate: '2026-02-01' }), faktura('b', { gross: 6000, issueDate: '2026-04-15' })],
      bezStartu,
    );
    expect(r.exceededMonth).toBe('2026-04');
  });
  it('rok rozpoczęcia: limit proporcjonalny do dni działalności', () => {
    // od 1.07.2026 = 184 z 365 dni
    const r = limitKasy([faktura('a')], { year: 2026, businessStartedOn: '2026-07-01' });
    expect(r.proportional).toBe(true);
    expect(r.limit).toBe(10082.19);
    expect(r.startUnknown).toBe(false);
  });
  it('start w innym roku lub 1 stycznia: pełny limit', () => {
    expect(limitKasy([], { year: 2026, businessStartedOn: '2025-07-01' }).limit).toBe(20000);
    expect(limitKasy([], { year: 2026, businessStartedOn: '2026-01-01' }).proportional).toBe(false);
  });
  it('faktura firmowa (NIP, nie konsument) się nie liczy; bez NIP i bez oznaczenia liczy się', () => {
    const r = limitKasy(
      [
        faktura('b2b', { isB2c: false, buyerNip: '1234567890', gross: 5000 }),
        faktura('nip', { isB2c: null, buyerNip: '1234567890', gross: 700 }),
        faktura('bez', { isB2c: null, buyerNip: null, gross: 300 }),
        faktura('b2c', { gross: 100 }),
      ],
      bezStartu,
    );
    expect(r.sum).toBe(400);
  });
  it('korekta zmniejsza sumę, inny rok się nie liczy, suma nie spada poniżej zera', () => {
    const r = limitKasy(
      [faktura('a', { gross: 1000 }), faktura('k', { gross: -400, kind: 'correction' }), faktura('stary', { issueDate: '2025-12-31', gross: 9000 })],
      bezStartu,
    );
    expect(r.sum).toBe(600);
    expect(limitKasy([faktura('k', { gross: -400, kind: 'correction' })], bezStartu).sum).toBe(0);
  });
});

describe('LimitKasyKarta', () => {
  const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node).replace(/<!-- -->/g, '');
  it('pokazuje licznik, termin z przepisu, link do źródła i bez długich myślników', () => {
    const out = html(<LimitKasyKarta wynik={limitKasy([faktura('a', { gross: 14300 })], bezStartu)} />);
    expect(out).toContain('Sprzedaż dla osób prywatnych w 2026 r.');
    expect(out).toContain('14 300');
    expect(out).toContain('20 000');
    expect(out).toContain('dwóch miesięcy następujących po miesiącu');
    expect(out).toContain('isap.sejm.gov.pl');
    expect(out).not.toMatch(/[—–]/);
  });
  it('po przekroczeniu podaje miesiąc przekroczenia, a w roku rozpoczęcia notkę o proporcji', () => {
    const wynik = limitKasy([faktura('a', { gross: 11000, issueDate: '2026-08-20' })], { year: 2026, businessStartedOn: '2026-07-01' });
    const out = html(<LimitKasyKarta wynik={wynik} />);
    expect(out).toContain('Limit został przekroczony w sierpniu 2026');
    expect(out).toContain('proporcjonalny');
  });
  it('bez daty rozpoczęcia pisze, że liczy pełny limit', () => {
    const out = html(<LimitKasyKarta wynik={limitKasy([], bezStartu)} />);
    expect(out).toContain('pełny limit');
  });
});
