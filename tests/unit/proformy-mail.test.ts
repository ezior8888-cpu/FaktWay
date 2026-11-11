import { describe, expect, it } from 'vitest';

import {
  quoteEmailHtml,
  quoteEmailIdempotencyKey,
  quoteEmailSubject,
  type QuoteEmailContent,
} from '@/lib/proformy/mail';
import { quoteNotInvoiceNotice } from '@/lib/proformy/teksty';

/**
 * Mail z proformą albo ofertą do kontrahenta (krok 2.4). Klucz idempotencji
 * zależy od zdarzenia (dokument, adres, liczba zapisanych wcześniej wysyłek na
 * ten adres), nie od próby: ponowienie po wysyłce bez zapisu historii daje ten
 * sam klucz, a świadome „Wyślij ponownie” po zapisanej wysyłce nowy.
 */

const ID = '5d0e8a8c-7a3b-4f61-9d2e-1c4b5a6f7e80';
const INNY = '6e1f9b9d-8b4c-4a72-8e3f-2d5c6b7a8f91';

function tresc(zmiany: Partial<QuoteEmailContent> = {}): QuoteEmailContent {
  return {
    kind: 'proforma',
    number: 'PRO/1/2026',
    grossTotal: 15_408,
    paymentDueDate: '2026-11-25',
    validUntil: null,
    issuerName: 'Moja Firma <b>sp. z o.o.</b>',
    ...zmiany,
  };
}

describe('klucz idempotencji maila z proformą albo ofertą', () => {
  it('stały dla tego samego dokumentu, adresu i liczby wcześniejszych wysyłek; bez adresu w kluczu', () => {
    const key = quoteEmailIdempotencyKey(ID, 'jan@firma.pl', 0);
    expect(quoteEmailIdempotencyKey(ID, 'Jan@Firma.pl ', 0)).toBe(key);
    expect(key.startsWith(`sales-quote/${ID}/`)).toBe(true);
    expect(key).not.toMatch(/jan|firma/);
    expect(key.length).toBeLessThanOrEqual(200);
  });

  it('inny dla kolejnej świadomej wysyłki, innego adresu i innego dokumentu', () => {
    const key = quoteEmailIdempotencyKey(ID, 'jan@firma.pl', 0);
    expect(quoteEmailIdempotencyKey(ID, 'jan@firma.pl', 1)).not.toBe(key);
    expect(quoteEmailIdempotencyKey(ID, 'anna@firma.pl', 0)).not.toBe(key);
    expect(quoteEmailIdempotencyKey(INNY, 'jan@firma.pl', 0)).not.toBe(key);
  });
});

describe('treść maila', () => {
  it('temat: rodzaj, numer i wystawca', () => {
    expect(quoteEmailSubject(tresc({ issuerName: 'Moja Firma' }))).toBe('Proforma PRO/1/2026 od Moja Firma');
    expect(quoteEmailSubject(tresc({ kind: 'offer', number: 'OF/2/2026', issuerName: 'Moja Firma' }))).toBe(
      'Oferta OF/2/2026 od Moja Firma',
    );
  });

  it('proforma: numer, kwota brutto, termin zapłaty, adnotacja o KSeF i stopka nadawcy', () => {
    const html = quoteEmailHtml(tresc()).replace(/[  ]/g, ' ');
    expect(html).toContain('PRO/1/2026');
    expect(html).toContain('15 408,00 PLN');
    expect(html).toContain('25.11.2026');
    expect(html).toContain(quoteNotInvoiceNotice('proforma'));
    expect(html).toMatch(/za pośrednictwem serwisu FaktWay/);
  });

  it('oferta: data ważności zamiast terminu zapłaty', () => {
    const html = quoteEmailHtml(tresc({ kind: 'offer', number: 'OF/2/2026', paymentDueDate: null, validUntil: '2026-12-11' }));
    expect(html).toContain('11.12.2026');
    expect(html).toMatch(/Oferta ważna do/);
    expect(html).not.toMatch(/Termin zapłaty/);
    expect(html).toContain(quoteNotInvoiceNotice('offer'));
  });

  it('dane wystawcy w HTML są escapowane', () => {
    const html = quoteEmailHtml(tresc());
    expect(html).not.toContain('<b>sp. z o.o.</b>');
    expect(html).toContain('&lt;b&gt;sp. z o.o.&lt;/b&gt;');
  });

  it('bez długich myślników w temacie i treści', () => {
    for (const t of [tresc(), tresc({ kind: 'offer', number: 'OF/2/2026', paymentDueDate: null, validUntil: '2026-12-11' })]) {
      expect(`${quoteEmailSubject(t)}\n${quoteEmailHtml(t)}`).not.toMatch(/[—–]/);
    }
  });
});
