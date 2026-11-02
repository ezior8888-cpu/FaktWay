/**
 * Stripe Customer Portal (Faza 25 Krok 2).
 *
 * Customer Portal to hosted page Stripe gdzie klient sam może:
 *   - Zmienić plan (upgrade/downgrade z proration)
 *   - Zmienić metodę płatności (kartę albo BLIK; to ścieżka ponowienia po odmowie)
 *   - Anulować subskrypcję
 *   - Zobaczyć historię faktur Stripe + pobrać PDF
 *
 * Konfiguracja portalu (włączone features, branding) — w Stripe Dashboard
 * → Settings → Billing → Customer portal. Bez konfiguracji portal NIE działa,
 * Stripe rzuca błąd "No configuration provided" — udokumentowane w `.env.example`.
 * Metody do wyboru bierze z domyślnej konfiguracji metod płatności konta, więc
 * BLIK pojawia się tu po włączeniu go w Dashboardzie (docs/runbooks/stripe-blik.md).
 */

import { getStripe } from './client';
import { ensureStripeCustomer } from './customer';

export interface CreatePortalInput {
  tenantId: string;
  email: string;
  tenantName?: string;
  nip?: string;
  baseUrl: string;
}

export async function createPortalSession(
  input: CreatePortalInput,
): Promise<{ url: string }> {
  const stripe = getStripe();

  const { customerId } = await ensureStripeCustomer({
    tenantId: input.tenantId,
    email: input.email,
    name: input.tenantName,
    nip: input.nip,
  });

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${input.baseUrl}/settings/billing`,
  });

  return { url: session.url };
}
