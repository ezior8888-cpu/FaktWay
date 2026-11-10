/**
 * Enforcement gate: akcje wymagające potwierdzonej weryfikacji KSeF dla org
 * (`tenants.ksef_verified_at` i środowisko ustawiane atomowo przez trusted RPC).
 *
 * Odczyt przez `createClient()` (sesja użytkownika) — respektuje RLS
 * (`is_member_of`); nie używamy service_role, żeby nie odczytywać metadanych
 * cudzych tenantów po samym UUID.
 *
 * Dla Inngest / skryptów bez sesji użytkownika: {@link requireKsefVerificationForBackgroundJob}.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { createAdminClient, createClient } from '@/lib/supabase/server';
import { isUuid } from '@/lib/supabase/active-org';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';

export class KsefNotVerifiedError extends Error {
  constructor(message = 'KSeF_NOT_VERIFIED') {
    super(message);
    this.name = 'KsefNotVerifiedError';
  }
}

export interface KsefVerificationStatus {
  isVerified: boolean;
  verifiedAt: string | null;
  authorityUserId: string | null;
  nip: string | null;
  name: string | null;
}

/**
 * Sprawdź, czy organizacja ma aktywną weryfikację KSeF.
 * Rzuca {@link KsefNotVerifiedError}, jeśli nie ma.
 *
 * Wywołuj PRZED m.in.:
 * - wysłaniem faktury do KSeF,
 * - generowaniem oficjalnego PDF z danymi firmy,
 * - wysłaniem faktury e-mailem do kontrahenta.
 */
export async function requireKsefVerification(
  tenantId: string,
  /**
   * Klient z RLS zamiast sesji z ciasteczek: publiczne API (krok 7.1) czyta
   * znacznik tokenem klucza, który widzi tylko swoją firmę (00184).
   */
  client?: SupabaseClient,
): Promise<void> {
  if (!isUuid(tenantId)) {
    throw new KsefNotVerifiedError('INVALID_TENANT_ID');
  }

  const supabase = client ?? await createClient();
  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('ksef_verified_at, ksef_verified_environment')
    .eq('id', tenantId)
    .maybeSingle();

  const env = configuredKsefEnvironment();
  if (error || !tenant?.ksef_verified_at || !env ||
      tenant.ksef_verified_environment !== env) {
    throw new KsefNotVerifiedError();
  }
}

/**
 * Bez rzucania — zwraca status weryfikacji (np. badge / banner w UI).
 */
export async function getKsefVerificationStatus(
  tenantId: string,
): Promise<KsefVerificationStatus> {
  if (!isUuid(tenantId)) {
    return {
      isVerified: false,
      verifiedAt: null,
      authorityUserId: null,
      nip: null,
      name: null,
    };
  }

  const supabase = await createClient();
  const { data: tenant } = await supabase
    .from('tenants')
    .select('ksef_verified_at, ksef_verified_environment, ksef_authority_user_id, nip, name')
    .eq('id', tenantId)
    .maybeSingle();

  const env = configuredKsefEnvironment();
  const verified = Boolean(
    env && tenant?.ksef_verified_at && tenant.ksef_verified_environment === env,
  );
  return {
    isVerified: verified,
    verifiedAt: verified ? tenant?.ksef_verified_at ?? null : null,
    authorityUserId: verified ? tenant?.ksef_authority_user_id ?? null : null,
    nip: tenant?.nip ?? null,
    name: tenant?.name ?? null,
  };
}

/**
 * Weryfikacja KSeF dla jobów w tle (Inngest, worker) — brak `auth.uid()` w
 * kontekście HTTP; odczyt znacznika i środowiska przez service_role.
 * Używaj tylko po wcześniejszym ustaleniu `tenantId` z zaufanego źródła (event).
 */
export async function requireKsefVerificationForBackgroundJob(
  tenantId: string,
): Promise<void> {
  if (!isUuid(tenantId)) {
    throw new KsefNotVerifiedError('INVALID_TENANT_ID');
  }

  const admin = createAdminClient();
  const { data: tenant, error } = await admin
    .from('tenants')
    .select('ksef_verified_at, ksef_verified_environment')
    .eq('id', tenantId)
    .maybeSingle();

  const env = configuredKsefEnvironment();
  if (error || !tenant?.ksef_verified_at || !env ||
      tenant.ksef_verified_environment !== env) {
    throw new KsefNotVerifiedError();
  }
}
