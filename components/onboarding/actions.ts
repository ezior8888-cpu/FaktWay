'use server';

import { lookupCompanyByNip } from '@/lib/gus/client';
import { getVerifiedUserContext } from '@/lib/auth/verified-user';
import { checkRateLimit } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/server';
import { validateNipChecksum } from '@/lib/xml/invoice-calculator';
import { hasConfiguredKsefProof } from '@/lib/ksef/claim-environment';

import {
  createOrganizationAction,
  type OrganizationCompanyInput,
} from '@/app/actions/organizations';

// ═══════════════════════════════════════════════════════════════
// Typy wyników (discriminated unions — wygodne w `if (result.success)`)
// ═══════════════════════════════════════════════════════════════

export interface OnboardingCompanyData {
  nip: string;
  name: string;
  postalCode: string;
  city: string;
  street: string;
  buildingNumber: string;
  localNumber?: string;
}

export type LookupNipResult =
  | { success: true; data: OnboardingCompanyData; existingOrgs: NipMatch[] }
  | { success: false; error: string };

export interface NipMatch {
  organizationId: string;
  name: string;
  ksefVerified: boolean;
}

/**
 * `createOrganizationAction` po sukcesie wykonuje server-side redirect
 * (`/onboarding/import-source`). Tu zwracamy wyłącznie ścieżkę błędu —
 * sukces nigdy nie wraca jako wartość.
 */
export type CompleteOnboardingResult = { success: false; error: string };

// ═══════════════════════════════════════════════════════════════
// Action 1: wyszukaj firmę po NIP (GUS) + zwróć ewentualne istniejące orgs
// ═══════════════════════════════════════════════════════════════

export async function lookupNipAction(nip: string): Promise<LookupNipResult> {
  const context = await getVerifiedUserContext();
  if (!context.ok) return { success: false, error: context.error };

  if (!/^\d{10}$/.test(nip)) {
    return { success: false, error: 'NIP musi zawierać 10 cyfr.' };
  }
  if (!validateNipChecksum(nip)) {
    return { success: false, error: 'Nieprawidłowa suma kontrolna NIP.' };
  }

  // AUD-59: wynik zdradza, które firmy korzystają z FaktWay (potrzebne do
  // „poproś o dostęp”) — limit, żeby nie dało się tego przeglądać seryjnie.
  const budget = await checkRateLimit({
    bucket: 'nip_lookup',
    identifier: context.user.id,
    limit: 20,
    windowSeconds: 60 * 60,
  });
  if (!budget.allowed) {
    return { success: false, error: 'Zbyt wiele wyszukiwań NIP. Spróbuj ponownie za godzinę.' };
  }

  const result = await lookupCompanyByNip(nip);

  if (result.kind === 'not-found') {
    return {
      success: false,
      error: 'Nie znaleziono firmy w bazie GUS. Sprawdź numer NIP.',
    };
  }

  if (result.kind === 'error') {
    // Sandbox GUS bywa niestabilny — komunikat mówi userowi, że to nie jego
    // wina (vs „nie znaleziono", co sugeruje zły NIP).
    return {
      success: false,
      error:
        'GUS chwilowo niedostępny (sandbox). Spróbuj ponownie za chwilę — to nie problem z Twoim NIP-em.',
    };
  }

  // Multi-org: NIP nie jest unikatem na poziomie schematu. Pokazujemy
  // listę istniejących orgs, żeby user mógł wybrać „poproś o dostęp" zamiast
  // tworzyć duplikat — silniejszy sygnał gdy któraś ma `ksef_verified_at`.
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from('tenants')
    .select('id, name, ksef_verified_at, ksef_verified_environment')
    .eq('nip', nip)
    .limit(10);

  return {
    success: true,
    data: {
      nip: result.data.nip,
      name: result.data.name,
      postalCode: result.data.postalCode,
      city: result.data.city,
      street: result.data.street,
      buildingNumber: result.data.buildingNumber,
      localNumber: result.data.localNumber,
    },
    existingOrgs: (existing ?? []).map((t) => ({
      organizationId: t.id,
      name: t.name,
      ksefVerified: hasConfiguredKsefProof(t.ksef_verified_at, t.ksef_verified_environment),
    })),
  };
}

// ═══════════════════════════════════════════════════════════════
// Action 2: utwórz organizację
//
// Zmiana semantyki względem wcześniejszej wersji: NIE doczepiamy już
// nikogo do istniejącej organizacji po samym NIP-ie (NIP jest publiczny —
// to było źródło dziury w autoryzacji). Jeśli inna org używa już tego
// NIP-u, frontend dostaje `nipDuplicate: true` i pokazuje banner ostrzegawczy
// + sugestię „poproś o zaproszenie zamiast tworzyć duplikat".
// ═══════════════════════════════════════════════════════════════

export async function completeOnboardingAction(
  company: OnboardingCompanyData,
): Promise<CompleteOnboardingResult> {
  const input: OrganizationCompanyInput = {
    nip: company.nip,
    name: company.name,
    postalCode: company.postalCode,
    city: company.city,
    street: company.street,
    buildingNumber: company.buildingNumber,
    localNumber: company.localNumber,
  };
  // Po sukcesie createOrganizationAction wywołuje redirect — funkcja nie
  // returnsuje, throw NEXT_REDIRECT przeleci wyżej do Next.js.
  const result = await createOrganizationAction(input);
  return { success: false, error: result.error };
}
