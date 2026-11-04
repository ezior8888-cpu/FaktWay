/**
 * Stripe SDK client (Faza 25).
 *
 * Lazy init — bez tego `next build` padałby przy importowaniu łańcucha
 * (np. server action → billing helper → ...), nawet gdy build nie woła
 * Stripe API. W Coolify trzeba ustawić `STRIPE_SECRET_KEY` w env projektu.
 *
 * `apiVersion` przypięty explicit — bez tego `stripe-node` używa "latest"
 * i odpowiedzi się zmieniają cicho. Pinujemy `2024-11-20.acacia` (stabilny
 * pod typy SDK v18) + override w env gdyby kiedyś trzeba upgrade.
 */

import Stripe from 'stripe';

let cachedClient: Stripe | null = null;

/** Stripe v22 typ `apiVersion` w options to luźny string — pinujemy stabilną
 *  wersję ręcznie. Override przez env gdyby trzeba upgrade'ować bez deployu. */
const DEFAULT_API_VERSION = '2024-11-20.acacia';

export function isStripeConfigured(): boolean {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return false;
  if (key.startsWith('sk_test_xxxx') || key === 'sk_test_placeholder') return false;
  return true;
}

export function getStripe(): Stripe {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'STRIPE_SECRET_KEY missing — billing nie skonfigurowany w env',
    );
  }
  // Cast — Stripe v22 typuje `apiVersion` jako konkretny literal z najnowszej
  // wersji SDK. Pinujemy starszą stabilną dzięki czemu odpowiedzi nie zmieniają
  // się przy upgrade SDK; cast jest celowy.
  const apiVersionEnv = process.env.STRIPE_API_VERSION ?? DEFAULT_API_VERSION;
  cachedClient = new Stripe(apiKey, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiVersion: apiVersionEnv as any,
    // Sentry breadcrumbs zachowują kontekst per request — bez `appInfo` Stripe
    // dashboard pokazałby tylko "Node.js" bez wskazania że to FaktWay.
    appInfo: {
      name: 'FaktWay',
      version: '0.1.0',
      url: process.env.NEXT_PUBLIC_APP_URL,
    },
  });
  return cachedClient;
}
