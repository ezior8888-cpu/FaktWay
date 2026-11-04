'use server';

import { recordKsefConfigured } from '@/lib/analytics/funnel';
import { getVerifiedMfaState } from '@/lib/auth/verified-mfa';
import { authenticateWithXades } from '@/lib/ksef/auth';
import { MAX_KSEF_FILE_BYTES } from '@/lib/ksef/certificate-files';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { prepareKsefCredentials, type CredentialProblem } from '@/lib/ksef/connect-credentials';
import {
  classifyKsefAuthFailure,
  credentialProblemMessage,
  describeFailureForLog,
  ksefFailureMessage,
  type KsefFailureReason,
} from '@/lib/ksef/connect-messages';
import { clearKsefHistoryCertificateErrors } from '@/lib/ksef/history-sync/client-pause';
import { hasFreshKsefOwnerProof } from '@/lib/ksef/owner-claim';
import { encryptCredentials } from '@/lib/ksef/credentials-crypto';
import { checkRateLimit } from '@/lib/rate-limit';
import { ActionAuthError, requireOwner } from '@/lib/supabase/auth-context';
import { bufferToByteaLiteral } from '@/lib/supabase/bytea';
import { createAdminClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { SUPPORT_EMAIL } from '@/lib/site';

/** Dlaczego podłączenie się nie udało. Kreator po tym wybiera krok, do którego wraca klient. */
export type ConnectFailureReason =
  | CredentialProblem
  | KsefFailureReason
  | 'forbidden'
  | 'mfa_required'
  | 'invalid_input'
  | 'files_too_large'
  | 'no_nip'
  | 'rate_limited'
  | 'nip_taken'
  | 'save_failed';

/** Wynik podłączenia KSeF. Claim, poświadczenia i audyt zapisuje jedno RPC. */
export type UploadCertificateResult =
  | {
      success: true;
      wasFirstClaim: boolean;
      message: string;
      /** Koniec ważności certyfikatu (ISO), do ekranu „Połączono”. */
      validTo: string;
    }
  | {
      success: false;
      error: string;
      reason: ConnectFailureReason;
      code?: 'NIP_ALREADY_CLAIMED';
      /** Sesja po biometrii: konto ma 2FA, trzeba podać kod. Kreator wraca wtedy do kroku 1 (`reason: 'mfa_required'`). */
      mfaStepUp?: true;
    };

/**
 * Pliki przychodzą jako base64 surowych bajtów (PEM albo DER), nie jako tekst:
 * odczyt tekstem psuje DER. Limit 64 KB na plik daje ~88 KB base64, czyli
 * z zapasem mieści się w domyślnym limicie Server Action (1 MB), więc
 * `bodySizeLimit` w next.config.ts zostaje bez zmian.
 */
const MAX_BASE64_CHARS = Math.ceil((MAX_KSEF_FILE_BYTES * 4) / 3) + 4;
const MAX_PASSWORD_CHARS = 256;
const GENERIC_ERROR =
  'Nie udało się bezpiecznie zapisać certyfikatu. Spróbuj później lub skontaktuj się z obsługą.';
const FILES_MISSING = 'Wybierz oba pliki z KSeF: certyfikat (.crt) i klucz prywatny (.key).';

function fail(reason: ConnectFailureReason, error: string): UploadCertificateResult {
  return { success: false, reason, error };
}

/**
 * Ślad po porażce, której klient nie spowodował. Do logu idą wyłącznie etap, powód, nazwa klasy
 * błędu i kod (a przy odmowie KSeF jej opis, zob. `describeFailureForLog`). Nigdy treść wyjątku
 * ani żądania, klucz, hasło czy certyfikat: komunikat wyjątku potrafi zawierać wszystkie cztery.
 */
function logFailure(stage: string, reason: ConnectFailureReason, detail: object = {}): void {
  console.error('[uploadCertificateAction] nie udało się podłączyć KSeF', { stage, reason, ...detail });
}

function decodeFile(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE64_CHARS) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= MAX_KSEF_FILE_BYTES ? bytes : null;
}

export async function uploadCertificateAction(data: {
  /** Plik certyfikatu (.crt), bajty w base64. */
  certificate: string;
  /** Plik klucza prywatnego (.key), bajty w base64. */
  privateKey: string;
  /** Hasło do klucza, tylko gdy klucz jest zaszyfrowany. Nigdzie nie jest zapisywane. */
  password?: string;
}): Promise<UploadCertificateResult> {
  try {
    // A Server Action can be POSTed directly. The page layout is not its guard.
    const { supabase, tenantId, user } = await requireOwner();
    const mfa = await getVerifiedMfaState(supabase).catch(() => null);
    if (mfa?.status === 'challenge_required' && mfa.user.id === user.id) {
      return {
        success: false,
        reason: 'mfa_required',
        mfaStepUp: true,
        error: 'Zmiana certyfikatu KSeF wymaga potwierdzenia kodem z aplikacji.',
      };
    }
    if (!mfa || mfa.status !== 'verified' || mfa.user.id !== user.id) {
      return fail('mfa_required', 'Przed zmianą certyfikatu KSeF włącz i potwierdź logowanie dwuetapowe.');
    }

    // Akcję da się wywołać z dowolnym ciałem, także null, stąd `?.` mimo typu parametru.
    if (typeof data?.certificate !== 'string' || typeof data?.privateKey !== 'string') {
      return fail('invalid_input', FILES_MISSING);
    }
    const password = typeof data.password === 'string' ? data.password : undefined;
    if (password !== undefined && password.length > MAX_PASSWORD_CHARS) {
      return fail('password_wrong', credentialProblemMessage('password_wrong'));
    }
    const certificate = decodeFile(data.certificate);
    const privateKey = decodeFile(data.privateKey);
    if (!certificate || !privateKey) {
      const tooLarge = data.certificate.length > MAX_BASE64_CHARS || data.privateKey.length > MAX_BASE64_CHARS;
      return tooLarge
        ? fail('files_too_large', 'Któryś z plików jest za duży jak na certyfikat KSeF. Wybierz pliki pobrane z Aplikacji Podatnika (mają po kilka kilobajtów).')
        : fail('invalid_input', FILES_MISSING);
    }

    // Sprawdzenia lokalne PRZED limitem i KSeF: zły plik ani literówka w haśle
    // nie zużywają prób i nie obciążają KSeF.
    const prepared = prepareKsefCredentials({ certificate, privateKey, password });
    if (!prepared.ok) {
      return fail(
        prepared.problem,
        credentialProblemMessage(prepared.problem, { validFrom: prepared.validFrom, validTo: prepared.validTo }),
      );
    }

    const { data: tenantRow, error: tenantError } = await supabase
      .from('tenants')
      .select('nip')
      .eq('id', tenantId)
      .single();
    if (tenantError || !tenantRow?.nip) {
      return fail('no_nip', 'Najpierw uzupełnij NIP firmy, bo certyfikat KSeF jest przypisany do NIP-u.');
    }
    const nip = tenantRow.nip;
    const env = configuredKsefEnvironment();
    if (!env) {
      logFailure('environment', 'save_failed');
      return fail('save_failed', GENERIC_ERROR);
    }

    // Limit 5 prób na godzinę liczy tylko próby, które dochodzą do KSeF. Bez Redisa (produkcja ma
    // wyłączony Upstash) limiter liczy w pamięci procesu: aplikacja to jeden proces, więc limit jest
    // realny. Dawniej każdy `fallback` był odmową, czyli upload certyfikatu nie działał w ogóle.
    // `countDenied: false`: kliknięcie w trakcie blokady jej nie wydłuża, więc "za około N min"
    // jest prawdą. Próba nieudana z winy KSeF wraca do limitu niżej (`budget.refund`).
    const budget = await checkRateLimit({
      bucket: 'ksef_certificate',
      identifier: `${tenantId}:${user.id}`,
      limit: 5,
      windowSeconds: 60 * 60,
      countDenied: false,
    });
    if (!budget.allowed) {
      const minutes = Math.max(1, Math.ceil(budget.retryAfter / 60));
      return fail('rate_limited', `Zbyt wiele prób połączenia z KSeF w ciągu godziny. Spróbuj ponownie za około ${minutes} min.`);
    }

    try {
      const session = await authenticateWithXades(
        {
          type: 'xades',
          nip,
          certificatePem: prepared.certificatePem,
          privateKeyPem: prepared.privateKeyPem,
        },
        env,
      );
      if (!hasFreshKsefOwnerProof(session, nip)) {
        return fail('not_owner', ksefFailureMessage('not_owner', { nip, env }));
      }
    } catch (error) {
      // Treść wyjątku może zawierać szczegóły żądania: do klienta idzie tylko gotowe zdanie,
      // a w logu zostaje etap, powód, klasa błędu i kod (zob. `logFailure`).
      const reason = classifyKsefAuthFailure(error);
      logFailure('ksef_login', reason, describeFailureForLog(error));
      // 5xx, 429, timeout i błąd sieci to awaria po stronie KSeF, nie próba klienta: nie zużywa limitu.
      // Zwrot jest dodatkiem, więc jego błąd nie zmienia odpowiedzi dla klienta.
      if (reason === 'unavailable') {
        try {
          await budget.refund?.();
        } catch {
          // próba zostaje zużyta, jak przed dodaniem zwrotu
        }
      }
      return fail(reason, ksefFailureMessage(reason, { nip, env }));
    }

    const encrypted = encryptCredentials(
      {
        type: 'xades',
        nip,
        certificatePem: prepared.certificatePem,
        privateKeyPem: prepared.privateKeyPem,
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
        p_certificate_expiry: prepared.validTo.toISOString(),
        p_environment: env,
      },
    );
    if (claimError) {
      logFailure('finalize_rpc', 'save_failed', describeFailureForLog(claimError));
      return fail('save_failed', GENERIC_ERROR);
    }

    if (claimResult === 'already_claimed_by_other') {
      return {
        success: false,
        code: 'NIP_ALREADY_CLAIMED',
        reason: 'nip_taken',
        error:
          `Ten NIP jest już zweryfikowany przez inną organizację w FaktWay. Jeśli uważasz, że to błąd, napisz na ${SUPPORT_EMAIL}`,
      };
    }
    if (claimResult !== 'claimed' && claimResult !== 'already_claimed_by_self') {
      logFailure('finalize_rpc', 'save_failed', { result: typeof claimResult === 'string' ? claimResult.slice(0, 40) : typeof claimResult });
      return fail('save_failed', GENERIC_ERROR);
    }

    // Z11: klient właśnie naprawił certyfikat: zapisany błąd historii (wygasł,
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
      validTo: prepared.validTo.toISOString(),
      message: wasFirstClaim
        ? 'Połączono z KSeF. Twoja organizacja jest teraz zweryfikowanym właścicielem tego NIP-u w FaktWay. W ciągu 30 minut zaczniemy pobierać historię faktur z KSeF, a postęp zobaczysz w Imporcie danych.'
        : 'Certyfikat zaktualizowany.',
    };
  } catch (error) {
    if (error instanceof ActionAuthError) return fail('forbidden', error.message);
    logFailure('unexpected', 'save_failed', describeFailureForLog(error));
    return fail('save_failed', GENERIC_ERROR);
  }
}
