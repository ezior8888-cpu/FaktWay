'use server';

import { X509Certificate } from 'node:crypto';

import { recordKsefConfigured } from '@/lib/analytics/funnel';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { authenticateWithXades } from '@/lib/ksef/auth';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { clearKsefHistoryCertificateErrors } from '@/lib/ksef/history-sync/client-pause';
import { hasFreshKsefOwnerProof } from '@/lib/ksef/owner-claim';
import { encryptCredentials } from '@/lib/ksef/credentials-crypto';
import { checkRateLimit } from '@/lib/rate-limit';
import { ActionAuthError, requireOwner } from '@/lib/supabase/auth-context';
import { bufferToByteaLiteral } from '@/lib/supabase/bytea';
import { createAdminClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { SUPPORT_EMAIL } from '@/lib/site';

/** Wynik wgrywania certyfikatu KSeF. Claim, poświadczenia i audyt zapisuje jedno RPC. */
export type UploadCertificateResult =
  | {
      success: true;
      wasFirstClaim: boolean;
      message: string;
    }
  | {
      success: false;
      error: string;
      code?: 'NIP_ALREADY_CLAIMED';
    };

const MAX_PEM_BYTES = 128 * 1024;
const GENERIC_KSEF_ERROR =
  'Nie udało się bezpiecznie zapisać certyfikatu. Spróbuj później lub skontaktuj się z obsługą.';


export async function uploadCertificateAction(data: {
  certPem: string;
  keyPem: string;
}): Promise<UploadCertificateResult> {
  try {
    // A Server Action can be POSTed directly. The page layout is not its guard.
    const { supabase, tenantId, user } = await requireOwner();
    const mfa = await getVerifiedMfaState(supabase).catch(() => null);
    if (!mfa || mfa.status !== 'verified' || mfa.user.id !== user.id) {
      return {
        success: false,
        error: 'Przed zmianą certyfikatu KSeF włącz i potwierdź logowanie dwuetapowe.',
      };
    }

    if (
      !data ||
      typeof data.certPem !== 'string' ||
      typeof data.keyPem !== 'string' ||
      data.certPem.length === 0 ||
      data.keyPem.length === 0 ||
      Buffer.byteLength(data.certPem, 'utf8') > MAX_PEM_BYTES ||
      Buffer.byteLength(data.keyPem, 'utf8') > MAX_PEM_BYTES
    ) {
      return { success: false, error: 'Podaj poprawne pliki certyfikatu i klucza PEM.' };
    }

    const budget = await checkRateLimit({
      bucket: 'ksef_certificate',
      identifier: `${tenantId}:${user.id}`,
      limit: 5,
      windowSeconds: 60 * 60,
    });
    if (!budget.allowed || budget.fallback) {
      return { success: false, error: 'Weryfikacja jest chwilowo niedostępna. Spróbuj później.' };
    }

    const { data: tenantRow, error: tenantError } = await supabase
      .from('tenants')
      .select('nip')
      .eq('id', tenantId)
      .single();
    if (tenantError || !tenantRow?.nip) {
      return { success: false, error: 'Brak NIP aktywnej organizacji.' };
    }
    const nip = tenantRow.nip;
    const env = configuredKsefEnvironment();
    if (!env) return { success: false, error: GENERIC_KSEF_ERROR };

    try {
      const session = await authenticateWithXades(
        {
          type: 'xades',
          nip,
          certificatePem: data.certPem,
          privateKeyPem: data.keyPem,
        },
        env,
      );
      if (!hasFreshKsefOwnerProof(session, nip)) {
        return {
          success: false,
          error: 'Certyfikat nie potwierdza uprawnień właścicielskich do NIP firmy.',
        };
      }
    } catch {
      // KSeF exceptions may contain request details. Never return them to the client.
      return { success: false, error: 'KSeF nie potwierdził tego certyfikatu dla NIP firmy.' };
    }

    let expiryDate: Date | null = null;
    try {
      const cert = new X509Certificate(data.certPem);
      expiryDate = new Date(cert.validTo);
      if (Number.isNaN(expiryDate.getTime())) expiryDate = null;
    } catch {
      expiryDate = null;
    }

    const encrypted = encryptCredentials(
      {
        type: 'xades',
        nip,
        certificatePem: data.certPem,
        privateKeyPem: data.keyPem,
      },
      tenantId,
    );
    const admin = createAdminClient();
    const { data: claimResult, error: claimError } = await admin.rpc(
      'finalize_ksef_certificate_claim',
      {
        p_tenant_id: tenantId,
        p_actor_user_id: user.id,
        p_expected_nip: nip,
        p_encrypted_credentials: bufferToByteaLiteral(encrypted),
        p_certificate_expiry: expiryDate?.toISOString() ?? null,
        p_environment: env,
      },
    );
    if (claimError) return { success: false, error: GENERIC_KSEF_ERROR };

    if (claimResult === 'already_claimed_by_other') {
      return {
        success: false,
        code: 'NIP_ALREADY_CLAIMED',
        error:
          `Ten NIP jest już zweryfikowany przez inną organizację w FaktWay. Jeśli uważasz, że to błąd, napisz na ${SUPPORT_EMAIL}`,
      };
    }
    if (claimResult !== 'claimed' && claimResult !== 'already_claimed_by_self') {
      return { success: false, error: GENERIC_KSEF_ERROR };
    }

    // Z11: klient właśnie naprawił certyfikat — zapisany błąd historii (wygasł,
    // brak poświadczeń, brak uprawnień) znika od razu, a nie po najbliższym
    // cronie. Błąd czyszczenia nie cofa wgrania: nic tu nie rzuca, tylko logujemy.
    try {
      const cleared = await clearKsefHistoryCertificateErrors({ tenantId, environment: env });
      if (!cleared.ok) console.error('[uploadCertificateAction] nie wyczyszczono błędu certyfikatu historii');
    } catch (error) {
      console.error('[uploadCertificateAction] czyszczenie błędu certyfikatu historii:', error);
    }

    revalidatePath('/settings/ksef');
    const wasFirstClaim = claimResult === 'claimed';
    if (wasFirstClaim) await recordKsefConfigured({ tenantId, environment: env });
    // Decyzja Bartosza 22.10.2026: historię z KSeF pobiera cron
    // `cron.ksef-history-sync` (sam znajduje zweryfikowaną firmę) — tu bez
    // zdarzenia joba, tylko informacja dla klienta.
    return {
      success: true,
      wasFirstClaim,
      message: wasFirstClaim
        ? 'Certyfikat zapisany. Twoja organizacja jest teraz zweryfikowanym właścicielem tego NIP-u w FaktWay (claim KSeF). W ciągu 30 minut zaczniemy pobierać historię faktur z KSeF — postęp zobaczysz w Imporcie danych.'
        : 'Certyfikat zaktualizowany.',
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof ActionAuthError ? error.message : GENERIC_KSEF_ERROR,
    };
  }
}
