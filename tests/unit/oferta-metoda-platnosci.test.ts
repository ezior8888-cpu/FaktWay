import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TRIAL_DAYS } from '@/lib/billing/pricing';
import { trialPaymentMethodLabel } from '@/lib/billing/trial-payment';

/**
 * `METODA_PLATNOSCI` (lib/marketing/oferta.ts) to jedyny tekst o metodzie płatności na stronach
 * publicznych. Komentarz w pliku czekał na gałąź zbiorczą, która dopisze BLIK-a. Tekst ma pochodzić
 * z `trialPaymentMethodLabel()` (lib/billing/trial-payment.ts), czyli z tej samej odpowiedzi co panel
 * i Checkout: przełącznik wyłączony daje dokładnie "karta przy starcie", włączony mówi o karcie albo
 * BLIK-u. Moduł jest stałą liczoną przy ładowaniu, więc testy ładują go od nowa.
 */

const ROOT = join(__dirname, '..', '..');

async function loadOferta() {
  vi.resetModules();
  return import('@/lib/marketing/oferta');
}

afterEach(() => vi.unstubAllEnvs());

describe('METODA_PLATNOSCI: tekst z lib/billing/trial-payment.ts', () => {
  it.each(['', '  ', 'off', 'true', '1', 'ON'])('przełącznik %j: dokładnie "karta przy starcie"', async (value) => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', value);

    const { METODA_PLATNOSCI, PROBA } = await loadOferta();

    expect(METODA_PLATNOSCI).toBe('karta przy starcie');
    expect(PROBA).toBe(`${TRIAL_DAYS} dni za darmo, karta przy starcie`);
  });

  it('brak zmiennej: dokładnie "karta przy starcie"', async () => {
    delete process.env.STRIPE_BLIK_RECURRING;

    const { METODA_PLATNOSCI, PROBA } = await loadOferta();

    expect(METODA_PLATNOSCI).toBe('karta przy starcie');
    expect(PROBA).toBe(`${TRIAL_DAYS} dni za darmo, karta przy starcie`);
  });

  it.each(['on', ' on '])('przełącznik %j: karta albo BLIK, tak samo jak w panelu', async (value) => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', value);

    const { METODA_PLATNOSCI, PROBA } = await loadOferta();

    expect(trialPaymentMethodLabel()).toBe('karta albo BLIK');
    expect(METODA_PLATNOSCI).toBe(`${trialPaymentMethodLabel()} przy starcie`);
    expect(METODA_PLATNOSCI).toBe('karta albo BLIK przy starcie');
    expect(PROBA).toBe(`${TRIAL_DAYS} dni za darmo, karta albo BLIK przy starcie`);
    expect(`${METODA_PLATNOSCI}${PROBA}`).not.toMatch(/[—–]/);
  });

  it('zdanie oferty nie zależy od przełącznika', async () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', '');
    const wylaczony = await loadOferta();
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    const wlaczony = await loadOferta();

    expect(wlaczony.OFERTA).toBe(wylaczony.OFERTA);
    expect(wlaczony.OFERTA_TEKST).toBe(wylaczony.OFERTA_TEKST);
  });
});

describe('oferta.ts zostaje po stronie serwera', () => {
  // W przeglądarce `process.env.STRIPE_BLIK_RECURRING` nie istnieje, więc komponent kliencki z tym
  // modułem pokazałby "karta przy starcie" tam, gdzie serwer napisał "karta albo BLIK". Dziś importują go
  // wyłącznie strony, układ, manifest i obrazek do udostępniania (sprawdzone), a `server-only` zamienia
  // ewentualny import z komponentu klienckiego w błąd budowania zamiast po cichu rozjechanego tekstu.
  const source = readFileSync(join(ROOT, 'lib/marketing/oferta.ts'), 'utf8');

  it("ma import 'server-only'", () => {
    expect(source).toMatch(/^import 'server-only';$/m);
  });

  it('nie czyta zmiennej środowiska sam, tylko przez trial-payment', () => {
    expect(source).not.toContain('process.env');
    expect(source).toContain("from '@/lib/billing/trial-payment'");
  });
});
