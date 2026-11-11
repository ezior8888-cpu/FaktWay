'use server';

import { todayInWarsaw } from '@/lib/format/warsaw-date';
import { formatJobSendError } from '@/lib/jobs/error-message';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import {
  ActionAuthError,
  requireUserAndActiveOrg,
  type AuthContext,
} from '@/lib/supabase/auth-context';
import {
  validateNipCached,
  type CachedValidationResult,
} from '@/lib/validation/cache';
import { checkBankAccountInWhitelist } from '@/lib/validation/whitelist-client';
import { contractorValidationPatch } from '@/lib/validation/contractor-update';
import { extractCountryFromVatNumber } from '@/lib/validation/vies-client';

/**
 * Zalogowany członek aktywnej firmy po drugim kroku MFA (gdy go ma).
 * Do 02.10 akcje sprawdzały tylko `getUser()`, a firmę brały z ciasteczka
 * bez sprawdzenia członkostwa (AUD-58).
 */
async function authorize(): Promise<
  { ok: true; ctx: AuthContext } | { ok: false; error: string }
> {
  try {
    return { ok: true, ctx: await requireUserAndActiveOrg() };
  } catch (e) {
    if (e instanceof ActionAuthError) return { ok: false, error: e.message };
    throw e;
  }
}

// ============================================================================
// Live validation (formularz faktury)
// ============================================================================

export async function validateNipLiveAction(
  vatNumber: string,
): Promise<
  | { success: true; result: CachedValidationResult }
  | { success: false; error: string }
> {
  const auth = await authorize();
  if (!auth.ok) return { success: false, error: auth.error };

  const { countryCode, vatNumber: cleanVat } =
    extractCountryFromVatNumber(vatNumber);

  if (cleanVat.length < 4 || cleanVat.length > 20) {
    return {
      success: false,
      error: 'NIP musi mieć 4-20 znaków',
    };
  }

  try {
    const result = await validateNipCached(cleanVat, countryCode);
    return { success: true, result };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'Błąd walidacji',
    };
  }
}

// ============================================================================
// Validate bank account (czy jest na białej liście)
// ============================================================================

/**
 * `success: true` znaczy „wykaz odpowiedział” (rachunek w nim jest albo go nie
 * ma). Błąd API i rachunek, którego nie da się ocenić (rachunki wirtualne), to
 * `success: false` z opisem: nigdy „poza wykazem” ani „w porządku” bez
 * odpowiedzi wykazu (krok 3.4 planu kompletnej aplikacji, RP-BL-01). Dzień
 * sprawdzenia to dzień w Polsce: wykaz liczy się na dzień zlecenia przelewu.
 */
export async function validateBankAccountAction(
  nip: string,
  bankAccount: string,
): Promise<
  | { success: true; isOnWhitelist: boolean; warning?: string; checkedOn: string }
  | { success: false; error: string }
> {
  const auth = await authorize();
  if (!auth.ok) return { success: false, error: auth.error };

  const cleanAccount = bankAccount.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{0,2}\d{20,28}$/.test(cleanAccount)) {
    return {
      success: false,
      error: 'Niepoprawny format konta',
    };
  }

  try {
    const checkedOn = todayInWarsaw();
    const result = await checkBankAccountInWhitelist(nip, cleanAccount, checkedOn);
    if (result.status === 'unverified') {
      return { success: false, error: result.warning ?? 'Nie udało się sprawdzić rachunku w wykazie podatników VAT' };
    }
    return {
      success: true,
      isOnWhitelist: result.isOnWhitelist,
      warning: result.warning,
      checkedOn,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'Błąd walidacji konta',
    };
  }
}

// ============================================================================
// Bulk validate wszystkich kontrahentów tenanta
// ============================================================================

export async function bulkValidateContractorsAction(
  options: { forceRefresh?: boolean } = {},
): Promise<
  | { success: true; jobId: string; total: number }
  | { success: false; error: string }
> {
  const auth = await authorize();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, user, tenantId } = auth.ctx;

  const { data: contractors } = await supabase
    .from('contractors')
    .select('id, nip')
    .eq('tenant_id', tenantId)
    .not('nip', 'is', null);

  if (!contractors || contractors.length === 0) {
    return { success: false, error: 'Brak kontrahentów do walidacji' };
  }

  try {
    const { validationBulkContractorsRequested } = await import(
      '@/lib/jobs/events'
    );
    const sendResult = await sendJobEvent(
      validationBulkContractorsRequested.create({
        tenantId,
        contractorIds: contractors.map((c) => c.id),
        forceRefresh: options.forceRefresh ?? false,
        triggeredBy: user.id,
      }),
    );

    return {
      success: true,
      jobId: sendResult.ids[0] ?? '',
      total: contractors.length,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? formatJobSendError(e) : 'Błąd kolejki',
    };
  }
}

// ============================================================================
// Pobranie statusu kontrahenta (z cache lub świeży)
// ============================================================================

export async function getContractorVatStatusAction(
  contractorId: string,
): Promise<
  | { success: true; status: CachedValidationResult }
  | { success: false; error: string }
> {
  const auth = await authorize();
  if (!auth.ok) return { success: false, error: auth.error };
  const { supabase, tenantId } = auth.ctx;

  const { data: contractor } = await supabase
    .from('contractors')
    .select('id, nip, tenant_id')
    .eq('id', contractorId)
    .eq('tenant_id', tenantId)
    .single();

  if (!contractor) {
    return { success: false, error: 'Kontrahent nie znaleziony' };
  }

  if (contractor.tenant_id !== tenantId) {
    return { success: false, error: 'Kontrahent nie znaleziony' };
  }

  if (!contractor.nip) {
    return { success: false, error: 'Brak NIP-u kontrahenta' };
  }

  try {
    const { countryCode, vatNumber } = extractCountryFromVatNumber(
      contractor.nip,
    );
    const status = await validateNipCached(vatNumber, countryCode);

    // API niedostępne: nie nadpisujemy ostatniego dobrego statusu ani rachunków.
    const patch = contractorValidationPatch(status);
    if (!patch) {
      return {
        success: false,
        error: `${status.source === 'vies' ? 'VIES' : 'Biała Lista VAT'} chwilowo nie odpowiada — status kontrahenta bez zmian. Spróbuj za kilka minut.`,
      };
    }

    const { error: upErr } = await supabase
      .from('contractors')
      .update(patch)
      .eq('id', contractorId)
      .eq('tenant_id', tenantId);

    if (upErr) {
      return {
        success: false,
        error: upErr.message,
      };
    }

    return { success: true, status };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : 'Błąd walidacji',
    };
  }
}
