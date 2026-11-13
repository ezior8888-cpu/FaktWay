import { describe, expect, it } from 'vitest';

import { vatRateEnum } from '@/lib/schemas/invoice-form';
import {
  GTU_CODES,
  PRODUCT_VAT_RATES,
  duplicateProductMessage,
  productFormSchema,
} from '@/lib/produkty/model';

/**
 * Katalog produktów i usług (plan kompletnej aplikacji, krok 2.6, część 1):
 * jeden schemat dla formularza (klient) i akcji zapisu (serwer). Stawki VAT
 * to te same wartości co w formularzu faktury (`vatRateEnum`), nie nowa lista.
 */

const OK = {
  name: 'Wdrożenie systemu',
  unit: 'szt.',
  priceNet: '1 250,50',
  vatRate: '23',
  pkwiu: '62.01.11.0',
  gtu: 'GTU_12',
  description: 'Etap pierwszy',
};

describe('productFormSchema', () => {
  it('przyjmuje poprawny produkt, cenę z przecinkiem zamienia na liczbę z groszami', () => {
    const r = productFormSchema.safeParse(OK);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual({
        name: 'Wdrożenie systemu',
        unit: 'szt.',
        defaultPriceNet: 1250.5,
        defaultVatRate: '23',
        pkwiuCode: '62.01.11.0',
        gtuCode: 'GTU_12',
        description: 'Etap pierwszy',
      });
    }
  });

  it('cena, PKWiU, GTU i opis są opcjonalne (puste to null)', () => {
    const r = productFormSchema.safeParse({ name: 'Usługa doradcza', unit: 'godz.', vatRate: '23', priceNet: '', pkwiu: '', gtu: '', description: '' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.defaultPriceNet).toBeNull();
      expect(r.data.pkwiuCode).toBeNull();
      expect(r.data.gtuCode).toBeNull();
      expect(r.data.description).toBeNull();
    }
  });

  it('nazwa i jednostka: przycinane i wymagane', () => {
    const r = productFormSchema.safeParse({ ...OK, name: '  Szkolenie  ', unit: ' godz. ' });
    expect(r.success && r.data.name).toBe('Szkolenie');
    expect(r.success && r.data.unit).toBe('godz.');
    expect(productFormSchema.safeParse({ ...OK, name: '   ' }).success).toBe(false);
    expect(productFormSchema.safeParse({ ...OK, unit: '' }).success).toBe(false);
  });

  it('cena: nie ujemna, najwyżej dwa miejsca, nie tekst, w granicach NUMERIC(15,2)', () => {
    for (const priceNet of ['-1', '1,234', 'abc', '1e3', '9999999999999,99']) {
      expect(productFormSchema.safeParse({ ...OK, priceNet }).success, priceNet).toBe(false);
    }
    expect(productFormSchema.safeParse({ ...OK, priceNet: '0' }).success).toBe(true);
    expect(productFormSchema.safeParse({ ...OK, priceNet: 99.9 }).success).toBe(true);
  });

  it('stawka VAT: tylko wartości z formularza faktury', () => {
    expect([...PRODUCT_VAT_RATES]).toEqual([...vatRateEnum.options]);
    expect(productFormSchema.safeParse({ ...OK, vatRate: '7' }).success).toBe(false);
    for (const v of vatRateEnum.options) {
      expect(productFormSchema.safeParse({ ...OK, vatRate: v }).success, v).toBe(true);
    }
  });

  it('GTU: tylko kod z listy, PKWiU: tylko cyfry i kropki w rozsądnej długości', () => {
    expect(GTU_CODES).toHaveLength(13);
    expect(productFormSchema.safeParse({ ...OK, gtu: 'GTU_99' }).success).toBe(false);
    expect(productFormSchema.safeParse({ ...OK, pkwiu: '62.01 abc' }).success).toBe(false);
    expect(productFormSchema.safeParse({ ...OK, pkwiu: '1'.repeat(40) }).success).toBe(false);
    expect(productFormSchema.safeParse({ ...OK, pkwiu: '62' }).success).toBe(true);
  });

  it('długości: nazwa i opis mają górną granicę', () => {
    expect(productFormSchema.safeParse({ ...OK, name: 'a'.repeat(300) }).success).toBe(false);
    expect(productFormSchema.safeParse({ ...OK, description: 'a'.repeat(3000) }).success).toBe(false);
  });
});

describe('duplicateProductMessage', () => {
  it('nazywa produkt i jednostkę po polsku', () => {
    const msg = duplicateProductMessage('Szkolenie', 'godz.');
    expect(msg).toContain('Szkolenie');
    expect(msg).toContain('godz.');
    expect(msg).toMatch(/już jest/);
  });
});
