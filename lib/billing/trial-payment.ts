/**
 * Czym klient płaci przy starcie próby: karta, a po włączeniu także BLIK cykliczny.
 *
 * `isBlikAvailable()` i `trialPaymentMethodLabel()` to jedyne źródło odpowiedzi
 * dla panelu i stron marketingowych, żeby żaden tekst nie obiecał metody, której
 * Checkout nie pokaże. Przełącznik `STRIPE_BLIK_RECURRING` czyta tylko serwer:
 * w komponencie klienckim zmienna jest pusta, więc klient dostaje gotowe napisy
 * przez właściwości (`PlanCards`). Strona renderowana statycznie zamroziłaby
 * wartość z chwili budowania, dlatego strona z tym napisem musi być dynamiczna
 * albo wdrażana po każdej zmianie zmiennej. Procedura: docs/runbooks/stripe-blik.md.
 */

import { BLIK_RECURRING_STATEMENT } from '@/lib/legal/versions';

import { PRICE_GROSS, TRIAL_DAYS } from './pricing';

/** Czy przy starcie próby oferujemy BLIK cykliczny obok karty. Domyślnie nie. */
export function isBlikAvailable(): boolean {
  return process.env.STRIPE_BLIK_RECURRING?.trim() === 'on';
}

export type TrialPaymentMethodForm = 'mianownik' | 'biernik' | 'narzednik';

const METHOD_LABEL: Record<TrialPaymentMethodForm, { card: string; blik: string }> = {
  mianownik: { card: 'karta', blik: 'karta albo BLIK' },
  biernik: { card: 'kartę', blik: 'kartę albo BLIK' },
  narzednik: { card: 'kartą', blik: 'kartą albo BLIK-iem' },
};

/**
 * Napis metody płatności przy próbie: „karta”, a po włączeniu „karta albo BLIK”.
 * Odmiana do zdania: „Podajesz {biernik}”, „30 dni próby z {narzednik}”.
 */
export function trialPaymentMethodLabel(form: TrialPaymentMethodForm = 'mianownik'): string {
  return METHOD_LABEL[form][isBlikAvailable() ? 'blik' : 'card'];
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Zdanie pod przyciskiem startu próby. */
export function trialPaymentHint(): string {
  return `${capitalized(trialPaymentMethodLabel('biernik'))} podajesz teraz, pierwsza płatność po ${TRIAL_DAYS} dniach.`;
}

/**
 * Ścieżka ponowienia po nieudanym Checkout. Stripe wymaga jej przy BLIK-u:
 * bank spoza listy kończy się `recurring_not_supported_by_bank`, a klient musi
 * móc wybrać inne konto albo inną metodę. Przy samej karcie nie ma czego dodać.
 */
export function trialPaymentRetryHint(): string {
  return isBlikAvailable()
    ? 'Jeśli Twój bank nie obsługuje BLIK-a cyklicznego, wybierz kartę albo BLIK w innym banku.'
    : '';
}

/** Banki z BLIK-iem cyklicznym, lista z dokumentacji Stripe (02.11.2026). */
export const BLIK_RECURRING_BANKS = [
  'Alior Bank',
  'Credit Agricole',
  'ING Bank Śląski',
  'Millennium Bank',
  'mBank',
  'Nest Bank',
  'PKO Bank Polski',
  'Santander Bank Polska',
  'banki spółdzielcze SGB',
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Data pierwszego obciążenia po polsku. Stripe liczy `trial_period_days` jako
 * 24 h × dni od startu subskrypcji, więc tu też dodajemy dokładnie tyle godzin
 * i dopiero wynik pokazujemy w czasie polskim (zmiana czasu i północ w Polsce).
 */
export function firstChargeDateLabel(now: Date = new Date()): string {
  return new Date(now.getTime() + TRIAL_DAYS * DAY_MS).toLocaleDateString('pl-PL', {
    timeZone: 'Europe/Warsaw',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Ujawnienia przed kodem BLIK, gotowe do pokazania w komponencie klienckim. */
export interface BlikDisclosure {
  /** Wersja brzmienia zgody: wraca do serwera, a potem do audytu. */
  version: string;
  consent: string;
  dueToday: string;
  firstCharge: string;
  cycle: string;
  banks: readonly string[];
}

export function buildBlikDisclosure(now: Date = new Date()): BlikDisclosure {
  return {
    version: BLIK_RECURRING_STATEMENT.version,
    consent: BLIK_RECURRING_STATEMENT.text,
    dueToday: '0 zł',
    firstCharge: firstChargeDateLabel(now),
    cycle: `${PRICE_GROSS} z VAT co miesiąc, aż anulujesz`,
    banks: BLIK_RECURRING_BANKS,
  };
}
