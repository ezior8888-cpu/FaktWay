/**
 * Operator (spółka prowadząca FaktWay) — konfiguracja dla self-invoicing (Faza 25 Krok 4).
 *
 * Self-invoicing: nasza apka używa swojego własnego KSeF pipeline'u żeby
 * wystawić fakturę VAT klientowi za jego subskrypcję. Wymaga:
 *   1. `FAKTFLOW_OPERATOR_TENANT_ID` — UUID naszego tenanta w `tenants` table.
 *   2. Ten tenant ma skonfigurowane KSeF credentials (cert produkcyjny).
 *   3. NIP operatora = NIP naszej firmy (z REGON).
 *
 * Bez tych env vars cron `self-invoice-payment` skip'uje payment'y —
 * Stripe nadal działa, ale klient nie dostaje faktury VAT przez KSeF
 * (dostaje Stripe receipt PDF jako fallback).
 */

import { createAdminClient } from '@/lib/supabase/admin';

export interface OperatorTenantInfo {
  tenantId: string;
  nip: string;
  name: string;
  /** Adres operatora — używany jako `seller.address` w fakturze. */
  address: {
    countryCode: string;
    addressLine1: string;
    addressLine2: string;
  };
  bankAccount: string | null;
}

export function isSelfInvoicingConfigured(): boolean {
  const id = process.env.FAKTFLOW_OPERATOR_TENANT_ID?.trim();
  if (!id) return false;
  return /^[0-9a-fA-F-]{36}$/.test(id);
}

/**
 * Loaduje dane operatora z DB. Cache'owane in-process (tenants snapshot
 * rzadko się zmienia — name/nip stałe po rejestracji w CEIDG).
 */
let cachedOperator: OperatorTenantInfo | null = null;

export async function getOperatorTenant(): Promise<OperatorTenantInfo | null> {
  if (cachedOperator) return cachedOperator;
  if (!isSelfInvoicingConfigured()) return null;

  const operatorId = process.env.FAKTFLOW_OPERATOR_TENANT_ID!.trim();
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('tenants')
    .select('id, nip, name, address_json')
    .eq('id', operatorId)
    .maybeSingle();

  if (error || !data) return null;

  // address_json shape z `00035_organizations_extend` — `{ countryCode, addressLine1, addressLine2 }`
  // ale bywa NULL dla starych tenantów. Defensywne narrowing.
  const addr =
    typeof data.address_json === 'object' && data.address_json !== null
      ? (data.address_json as {
          countryCode?: string;
          addressLine1?: string;
          addressLine2?: string;
        })
      : null;

  cachedOperator = {
    tenantId: data.id,
    nip: data.nip,
    name: data.name,
    address: {
      countryCode: addr?.countryCode ?? 'PL',
      addressLine1: addr?.addressLine1 ?? '',
      addressLine2: addr?.addressLine2 ?? '',
    },
    // Numer konta bankowego operatora pobierany z env (nie z tenants, bo
    // tenants nie ma takiej kolumny w MVP — księgowa wpisuje raz na deployu).
    bankAccount: process.env.FAKTFLOW_OPERATOR_BANK_ACCOUNT ?? null,
  };

  return cachedOperator;
}

/** Test/admin: reset cache (np. po update'cie tenanta operatora). */
export function clearOperatorCache(): void {
  cachedOperator = null;
}
