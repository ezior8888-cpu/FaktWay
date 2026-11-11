import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ProgOssKarta } from '@/components/analizy/prog-oss-karta';
import { licznikOss, type SprzedazDlaOss } from '@/lib/oss/prog';

/**
 * Krok 9.4 planu kompletnej aplikacji (licznik progu OSS, decyzja P5, R2).
 * Ustawa o VAT art. 22a ust. 1 pkt 3 i art. 28k ust. 2 pkt 3: suma wartości
 * pomniejszona o podatek "nie przekroczyła" 10 000 euro, dla polskiego
 * sprzedawcy 42 000 zł, w roku bieżącym ani w poprzednim.
 */
const faktura = (id: string, f: Partial<SprzedazDlaOss> = {}): SprzedazDlaOss => ({
  id, issueDate: '2026-03-10', net: 1000, kind: 'regular', currency: 'PLN', rateToPln: null,
  countryCode: 'DE', isB2c: true, buyerNip: null, vatUe: null, ...f,
});
const rok = { year: 2026 };

describe('licznikOss', () => {
  it('sumuje netto faktur dla konsumentów z innych państw UE', () => {
    const r = licznikOss([faktura('a', { net: 10000 }), faktura('b', { net: 5000, countryCode: 'FR' })], rok);
    expect(r).toMatchObject({ sum: 15000, limit: 42000, state: 'below', previousYearExceeded: false });
  });
  it('granice: 80 % blisko, próg dokładnie jeszcze nie przekroczony, grosz powyżej tak', () => {
    expect(licznikOss([faktura('a', { net: 33599.99 })], rok).state).toBe('below');
    expect(licznikOss([faktura('a', { net: 33600 })], rok).state).toBe('near');
    expect(licznikOss([faktura('a', { net: 42000 })], rok).state).toBe('near');
    expect(licznikOss([faktura('a', { net: 42000.01 })], rok).state).toBe('exceeded');
  });
  it('miesiąc przekroczenia liczony narastająco', () => {
    const r = licznikOss(
      [faktura('a', { net: 40000, issueDate: '2026-02-01' }), faktura('b', { net: 3000, issueDate: '2026-05-15' })],
      rok,
    );
    expect(r.exceededMonth).toBe('2026-05');
  });
  it('rok poprzedni ponad progiem: stan przekroczony mimo małej sumy bieżącej', () => {
    const r = licznikOss([faktura('a', { net: 42000.01, issueDate: '2025-06-01' }), faktura('b', { net: 100 })], rok);
    expect(r).toMatchObject({ sum: 100, sumPrevYear: 42000.01, previousYearExceeded: true, state: 'exceeded', exceededMonth: null });
  });
  it('rok poprzedni dokładnie na progu nie przekracza', () => {
    expect(licznikOss([faktura('a', { net: 42000, issueDate: '2025-06-01' })], rok).previousYearExceeded).toBe(false);
  });
  it('faktura do Polski i do kraju spoza UE się nie liczy', () => {
    const r = licznikOss([faktura('a', { countryCode: 'PL' }), faktura('b', { countryCode: 'US' }), faktura('c', { countryCode: 'GB' }), faktura('d', { countryCode: null })], rok);
    expect(r.sum).toBe(0);
  });
  it('Grecja (GR) i kod małymi literami są z UE', () => {
    expect(licznikOss([faktura('a', { countryCode: 'gr' })], rok).sum).toBe(1000);
  });
  it('firma z UE z NIP lub numerem VAT-UE się nie liczy', () => {
    const r = licznikOss([faktura('a', { buyerNip: '1234567890' }), faktura('b', { vatUe: 'DE123456789' }), faktura('c', { isB2c: false })], rok);
    expect(r.sum).toBe(0);
  });
  it('korekta zmniejszająca jest różnicą', () => {
    const r = licznikOss([faktura('a', { net: 5000 }), faktura('k', { net: -2000, kind: 'correction' })], rok);
    expect(r.sum).toBe(3000);
  });
  it('suma nie spada poniżej zera', () => {
    expect(licznikOss([faktura('k', { net: -50, kind: 'correction' })], rok).sum).toBe(0);
  });
  it('waluta obca z kursem: netto razy kurs, przez roundToCents', () => {
    const r = licznikOss([faktura('a', { net: 1000.5, currency: 'EUR', rateToPln: 4.2517 })], rok);
    expect(r.sum).toBe(4253.83);
    expect(r.withoutRate).toEqual({ count: 0, currencies: [] });
  });
  it('waluta obca bez kursu albo bez waluty: nie wlicza się i jest policzona', () => {
    const r = licznikOss([
      faktura('a', { net: 1000, currency: 'EUR', rateToPln: null }),
      faktura('b', { net: 1000, currency: 'EUR', rateToPln: null }),
      faktura('c', { net: 1000, currency: null }),
    ], rok);
    expect(r.sum).toBe(0);
    expect(r.withoutRate).toEqual({ count: 3, currencies: ['EUR'] });
  });
  it('faktura końcowa (ROZ) liczona wg netto po zaliczkach, tak jak dostaje ją czytnik', () => {
    expect(licznikOss([faktura('f', { kind: 'final', net: 700 })], rok).sum).toBe(700);
  });
});

describe('ProgOssKarta', () => {
  it('pokazuje sumę, próg, procent i źródło; bez długich myślników', () => {
    const html = renderToStaticMarkup(<ProgOssKarta wynik={licznikOss([faktura('a', { net: 36000 })], rok)} />);
    expect(html).toContain('36 000 zł');
    expect(html).toContain('42 000 zł');
    expect(html).toContain('86 %');
    expect(html).toContain('isap.sejm.gov.pl');
    expect(html).toContain('księgow');
    expect(html).not.toMatch(/[—–]/);
  });
  it('po przekroczeniu mówi o miesiącu, a przy walucie bez kursu o pominięciu', () => {
    const wynik = licznikOss([faktura('a', { net: 43000, issueDate: '2026-04-01' }), faktura('b', { currency: 'EUR' })], rok);
    const html = renderToStaticMarkup(<ProgOssKarta wynik={wynik} />);
    expect(html).toContain('kwietniu 2026');
    expect(html).toContain('bez kursu');
    expect(html).toContain('EUR');
  });
});
