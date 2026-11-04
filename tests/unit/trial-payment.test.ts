import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PRICE_GROSS, TRIAL_DAYS } from '@/lib/billing/pricing';
import {
  BLIK_RECURRING_BANKS,
  buildBlikDisclosure,
  firstChargeDateLabel,
  isBlikAvailable,
  trialPaymentHint,
  trialPaymentMethodLabel,
  trialPaymentRetryHint,
} from '@/lib/billing/trial-payment';
import { BLIK_RECURRING_STATEMENT } from '@/lib/legal/versions';

/**
 * BLIK przy próbie (FAKTWAY-1-0, sekcja 3 pkt 5). Moduł mówi, czy BLIK jest
 * dostępny i jak nazwać metodę płatności; strony panelu i (osobny PR) strony
 * marketingowe biorą to stąd, żeby nie obiecywać innej metody, niż pokaże Checkout.
 */

const LONG_DASH = /[–—]/;

afterEach(() => vi.unstubAllEnvs());

describe('isBlikAvailable: przełącznik serwerowy STRIPE_BLIK_RECURRING', () => {
  it('domyślnie wyłączony', () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', '');
    expect(isBlikAvailable()).toBe(false);
  });

  it('włącza tylko dokładne „on” (spacje z panelu Coolify nie przeszkadzają)', () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    expect(isBlikAvailable()).toBe(true);
    vi.stubEnv('STRIPE_BLIK_RECURRING', ' on ');
    expect(isBlikAvailable()).toBe(true);
    for (const value of ['ON', 'true', '1', 'yes', 'off']) {
      vi.stubEnv('STRIPE_BLIK_RECURRING', value);
      expect(isBlikAvailable(), value).toBe(false);
    }
  });
});

describe('napisy metody płatności', () => {
  it('wyłączony: karta, także w tekście pod przyciskiem (brzmienie jak dotąd)', () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', '');
    expect(trialPaymentMethodLabel()).toBe('karta');
    expect(trialPaymentMethodLabel('biernik')).toBe('kartę');
    expect(trialPaymentMethodLabel('narzednik')).toBe('kartą');
    expect(trialPaymentHint()).toBe(`Kartę podajesz teraz, pierwsza płatność po ${TRIAL_DAYS} dniach.`);
    expect(trialPaymentRetryHint()).toBe('');
  });

  it('włączony: karta albo BLIK', () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    expect(trialPaymentMethodLabel()).toBe('karta albo BLIK');
    expect(trialPaymentMethodLabel('biernik')).toBe('kartę albo BLIK');
    expect(trialPaymentMethodLabel('narzednik')).toBe('kartą albo BLIK-iem');
    expect(trialPaymentHint()).toBe(`Kartę albo BLIK podajesz teraz, pierwsza płatność po ${TRIAL_DAYS} dniach.`);
  });

  it('ścieżka ponowienia wymaga innej metody albo banku (wymóg Stripe)', () => {
    vi.stubEnv('STRIPE_BLIK_RECURRING', 'on');
    const hint = trialPaymentRetryHint();
    expect(hint).toMatch(/kartę/);
    expect(hint).toMatch(/innym banku|innego banku/);
    expect(hint).not.toMatch(LONG_DASH);
  });
});

describe('data pierwszego obciążenia: TRIAL_DAYS w czasie polskim', () => {
  it('zwykły dzień', () => {
    expect(firstChargeDateLabel(new Date('2026-11-02T10:00:00.000Z'))).toBe('2 grudnia 2026');
  });

  it('po północy w Polsce, ale jeszcze poprzedniego dnia w UTC', () => {
    // 1 grudnia 00:30 w Warszawie + 30 dni = 31 grudnia 00:30, nie 30 grudnia.
    expect(firstChargeDateLabel(new Date('2026-11-30T23:30:00.000Z'))).toBe('31 grudnia 2026');
  });

  it('przez zmianę czasu: tak jak Stripe, 30 × 24 h od chwili startu', () => {
    // 10 października 00:30 czasu letniego; koniec próby to 8 listopada 23:30 czasu zimowego.
    expect(firstChargeDateLabel(new Date('2026-10-09T22:30:00.000Z'))).toBe('8 listopada 2026');
  });
});

describe('ujawnienia przed kodem BLIK (wymóg Stripe przy hostowanym Checkout)', () => {
  const NOW = new Date('2026-11-02T10:00:00.000Z');

  it('kwota dziś, data pierwszego obciążenia, cykl, banki i zgoda', () => {
    const disclosure = buildBlikDisclosure(NOW);
    expect(disclosure.dueToday).toBe('0 zł');
    expect(disclosure.firstCharge).toBe('2 grudnia 2026');
    expect(disclosure.cycle).toContain(PRICE_GROSS);
    expect(disclosure.cycle).toMatch(/co miesiąc/);
    expect(disclosure.banks).toBe(BLIK_RECURRING_BANKS);
    expect(disclosure.consent).toBe(BLIK_RECURRING_STATEMENT.text);
    expect(disclosure.version).toBe(BLIK_RECURRING_STATEMENT.version);
  });

  it('zgoda mówi wprost o cyklicznych płatnościach bez ponownego kodu', () => {
    expect(BLIK_RECURRING_STATEMENT.text).toMatch(/cykliczn/);
    expect(BLIK_RECURRING_STATEMENT.text).toMatch(/bez ponownego kodu/);
    expect(BLIK_RECURRING_STATEMENT.text).toMatch(/FaktWay/);
    expect(BLIK_RECURRING_STATEMENT.text).not.toMatch(LONG_DASH);
  });

  it('zgoda nie obiecuje, że anulowanie cofa upoważnienie: kończy je bank albo odpięcie metody', () => {
    // docs.stripe.com/payments/blik, „Cancel mandates”. Kod niczego nie odpina, więc
    // anulowanie kończy pobrania, a alias zostaje w aplikacji banku klienta.
    expect(BLIK_RECURRING_STATEMENT.text).not.toMatch(/wycofam, anulując/);
    expect(BLIK_RECURRING_STATEMENT.text).toContain(
      'Pobrania zakończę, anulując subskrypcję albo zmieniając metodę płatności.',
    );
    expect(BLIK_RECURRING_STATEMENT.text).toContain('Upoważnienie mogę też cofnąć w aplikacji banku.');
  });

  it('lista banków z dokumentacji Stripe', () => {
    expect([...BLIK_RECURRING_BANKS]).toEqual([
      'Alior Bank',
      'Credit Agricole',
      'ING Bank Śląski',
      'Millennium Bank',
      'mBank',
      'Nest Bank',
      'PKO Bank Polski',
      'Santander Bank Polska',
      'banki spółdzielcze SGB',
    ]);
  });

  it('teksty bez długich myślników', () => {
    const disclosure = buildBlikDisclosure(NOW);
    for (const text of [disclosure.dueToday, disclosure.firstCharge, disclosure.cycle, disclosure.consent]) {
      expect(text).not.toMatch(LONG_DASH);
    }
  });
});

describe('konfiguracja: .env.example i scripts/check-env.ts', () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

  it('przełącznik jest opisany i nie jest wymagany', () => {
    expect(read('.env.example')).toMatch(/^STRIPE_BLIK_RECURRING=$/m);
    expect(read('scripts/check-env.ts')).toMatch(
      /\{ name: 'STRIPE_BLIK_RECURRING', feature: '[^']*', level: 'optional'/,
    );
  });

  it('runbook opisuje włączenie, sprawdzenie, symulacje i wycofanie', () => {
    const runbook = read('docs/runbooks/stripe-blik.md');
    expect(runbook).toContain('STRIPE_BLIK_RECURRING=on');
    expect(runbook).toContain('blik_recurring_payments');
    expect(runbook).toContain('recurring_not_supported');
    expect(runbook).toContain('billing.checkout.blik_unavailable');
    expect(runbook).toMatch(/Wycofanie/);
    expect(runbook).toContain('./scripts/ops/stripe-blik-sprawdz.sh');
  });

  it('runbook mówi o wersji zdarzeń webhooka i o tym, że `stripe listen` jej nie bierze z endpointu', () => {
    const runbook = read('docs/runbooks/stripe-blik.md');
    expect(runbook).toContain('docs/security/STRIPE-PARA-PI-CHARGE-ODBIOR-2026-09-25.md');
    expect(runbook).toContain('api_version=2024-11-20.acacia');
    expect(runbook).toContain('You are using Stripe API Version');
  });

  it('runbook: wygaszanie otwartych Session skryptem, a nie w Dashboardzie', () => {
    const runbook = read('docs/runbooks/stripe-blik.md');
    expect(runbook).toContain('./scripts/ops/stripe-blik-wygas-sesje.sh');
    expect(runbook).not.toContain('wygaś je w Dashboardzie');
  });

  it('runbook: zwrot BLIK-a z panelu kończy się uzgodnieniem i ma opisane wyjście', () => {
    const runbook = read('docs/runbooks/stripe-blik.md');
    expect(runbook).toContain('stripe_status_pending');
    expect(runbook).toContain('settle_admin_refund_case');
    expect(runbook).not.toContain('Obsługa bez zmian');
  });

  it('runbook: warunki BLIK-a przy portalu i mandat po anulowaniu', () => {
    const runbook = read('docs/runbooks/stripe-blik.md');
    expect(runbook).not.toContain('są tylko przed startem próby');
    expect(runbook).toContain('Zmieniasz metodę płatności na BLIK?');
    expect(runbook).toContain('Anulowanie subskrypcji kończy pobrania, ale nie mandat');
  });

  it('skrypt dla operatora: jedna linia, sam ładuje infra.env, nie wypisuje klucza', () => {
    const script = read('scripts/ops/stripe-blik-sprawdz.sh');
    expect(script).toContain('source "$ENV_FILE"');
    expect(script).toContain('blik_recurring_payments');
    expect(statSync(join(process.cwd(), 'scripts/ops/stripe-blik-sprawdz.sh')).mode & 0o100).toBeTruthy();
    // Klucz wolno użyć w nagłówku, ale żaden console.log go nie dotyka.
    const prints = script.split('\n').filter((line) => line.includes('console.log'));
    expect(prints.length).toBeGreaterThan(0);
    for (const line of prints) expect(line).not.toMatch(/\$\{key\}|\(key\)|[( ]key[ ,)]/);
  });
});
