/**
 * Jedna ścieżka po zapisie szkicu: kolejka pg-boss (online) lub tryb Offline24,
 * jeśli KSeF jest niedostępny i tenant ma para certyfikat+klucz (XAdES).
 *
 * Przejście stanu faktury (`draft → queued`, przy ponowieniu `failed → queued`)
 * robi RPC z 00131 w TEJ SAMEJ transakcji, w której pg-boss zapisuje
 * zlecenie (`ksef-send-step.ts`). Sesja klienta nigdy nie pisze `ksef_status`
 * (cykl życia faktury, PR 3 — W16/W2 z rewizji 03.10.2026).
 *
 * UWAGA: generacji XML ani uploadu R2 nie robimy w Server Action — robi to
 * `submitInvoiceFullFlow` w jobie wysyłki (spójnie dla VAT / ZAL / ROZ / korekta).
 */

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { sendJobEvent } from '@/lib/jobs/enqueue';
import type { SupabaseClient } from '@supabase/supabase-js';

import { logAudit } from '@/lib/audit/log';
import {
  KsefNotVerifiedError,
  requireKsefVerification,
} from '@/lib/auth/ksef-verification-guard';
import { decryptCredentials } from '@/lib/ksef/credentials-crypto';
import { getGlobalFlagForExecution } from '@/lib/feature-flags/global-flags';
import { createAdminClient } from '@/lib/supabase/admin';
import { assertSensitiveMfa, SensitiveMfaRequiredError, type TokenMfaStatus } from '@/lib/auth/sensitive-mfa';
import { shouldUseOfflineMode } from '@/lib/ksef/health-check';
import { isOffline24Enabled } from '@/lib/ksef/offline24-policy';
import { isRozSubmission, ROZ_SUBMISSION_HOLD_MESSAGE } from '@/lib/ksef/roz-submission-hold';
import { requireConfiguredKsefEnvironment } from '@/lib/ksef/claim-environment';
import { DUPLICATE_DECISION_TEXTS } from '@/lib/ksef/duplicate-decision';
import { addToOfflineQueue } from '@/lib/ksef/offline-queue';
import {
  isCorrectionHeldForEnv,
  isCorrectionSubmission,
  isKsefSubmissionPaused,
  KOR_HOLD_MESSAGE,
  KSEF_PAUSED_MESSAGE,
} from '@/lib/ksef/submission-holds';
import { describeKsefSendError, ksefSendTransactionStep, type KsefSendMode } from '@/lib/invoices/ksef-send-step';
import { recordSendRefusal, type SendRefusalCode } from '@/lib/ksef/send-attempt-ledger';
import {
  resendMissingCredentialsMessage,
  resendPausedMessage,
  resendPauseUnknownMessage,
} from '@/lib/invoices/ksef-send-policy';
import type { AdvanceInvoiceSettlementRow } from '@/lib/ksef/fa3-advance-generator';
import {
  exemptTenantTaxedInvoiceMessage,
  readTenantVatExemption,
  TAXED_VAT_RATES,
  taxedRateUnderSubjectiveExemption,
} from '@/lib/invoices/vat-exemption';
import type { Invoice } from '@/types/invoice';
import type {
  AdvanceInvoiceData,
  CorrectionInvoiceData,
  FinalInvoiceData,
} from '@/types/invoice-types';

export type KsefSubmitEnqueueResult =
  /** `sendAttemptId` — właściciel przejęcia wysyłki tej próby (tylko kolejka online); audyt akcji klienta go zapisuje. */
  | { ok: true; mode: 'online_queued' | 'offline_queued'; sendAttemptId?: string }
  | { ok: false; error: string; code?: 'KSEF_NOT_VERIFIED' | 'MFA_REQUIRED' };

export interface EnqueueKsefSubmitParams {
  /**
   * Klient sesji — tylko do odczytów wołającego; status faktury zmienia RPC serwera.
   * Przy kluczu API (`companyKey`) klient z tokenem klucza: z niego czytamy
   * weryfikację KSeF firmy (RLS, 00184).
   */
  supabase: SupabaseClient;
  tenantId: string;
  /** Konto, które zleca wysyłkę; `null` tylko przy kluczu API (`companyKey`). */
  userId: string | null;
  invoiceId: string;
  /** NIP tenanta (jak w dotychczasowych eventach Inngest). */
  nip: string;
  invoice: Invoice;
  correctionData?: CorrectionInvoiceData;
  advanceData?: AdvanceInvoiceData;
  finalData?: FinalInvoiceData;
  finalAdvanceSettlementRows?: AdvanceInvoiceSettlementRow[];
  auditKind: 'regular' | 'correction' | 'advance' | 'final';
  internalNumberForAudit?: string;
  /** Domyślnie pierwsza wysyłka szkicu; `requeue` = ponowna wysyłka z `failed` (K3). */
  mode?: KsefSendMode;
  /**
   * Klucz API firmy zamiast konta (krok 7.1, część 2): wysyłka bez sesji
   * użytkownika. Audyt ma `user_id` NULL i identyfikator klucza, a 2FA
   * (`requireMfaForSensitive`) klucz nie przejdzie, więc wtedy odmowa.
   */
  companyKey?: CompanyKeySendActor;
  /**
   * Konto zlecające z tokenu sesji, nie z ciasteczek strony (aplikacja na
   * telefon, `/api/mobile/v1`, M8). `supabase` to wtedy klient z tym tokenem:
   * z niego czytamy znacznik weryfikacji KSeF, a 2FA (AUD-65) sprawdzamy na
   * stanie tokenu. Bez tego obie kontrole czytałyby puste ciasteczka i
   * odmawiały każdemu telefonowi.
   */
  tokenSession?: TokenSessionSendActor;
}

/** Sesja telefonu: stan 2FA tokenu z `authenticateMobileRequest` (konto z TOTP bez kodu tam już dostało 403). */
export interface TokenSessionSendActor {
  mfa: TokenMfaStatus;
}

/** Klucz API, którym program klienta zleca wysyłkę (`POST /api/v1/invoices`). */
export interface CompanyKeySendActor {
  id: string;
  prefix: string;
  /** `X-Request-Id` żądania API: łączy wpis z `api_key.used` i `invoice.draft_created`. */
  requestId: string;
}

/** Odmowa wysyłki kluczem API, gdy FaktWay wymaga 2FA przy wysyłce (AUD-65, flaga `requireMfaForSensitive`). */
export const COMPANY_KEY_MFA_REFUSAL_MESSAGE =
  'FaktWay wymaga teraz weryfikacji dwuetapowej przy wysyłce do KSeF, a klucz API jej nie przejdzie. Szkic jest zapisany: wyślij go w aplikacji FaktWay.';

/** Metadane audytu zlecenia kluczem API (puste przy koncie). */
function companyKeyAudit(companyKey: CompanyKeySendActor | undefined): Record<string, unknown> {
  return companyKey
    ? { source: 'api_v1', api_key_id: companyKey.id, key_prefix: companyKey.prefix, request_id: companyKey.requestId }
    : {};
}

/**
 * Czy klucz API ma odmówić wysyłki z powodu 2FA. Ta sama flaga i ta sama reguła
 * błędu odczytu co `assertSensitiveMfa`: to dodatkowa warstwa, nie wyłącznik.
 */
async function companyKeyNeedsMfa(): Promise<boolean> {
  try {
    return await getGlobalFlagForExecution('requireMfaForSensitive');
  } catch {
    return false;
  }
}

function credentialsBuffer(raw: unknown): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  if (typeof raw === 'string') {
    if (raw.startsWith('\\x')) return Buffer.from(raw.slice(2), 'hex');
    return Buffer.from(raw, 'base64');
  }
  throw new Error('Niepoprawny typ kolumny credentials KSeF');
}

/** Komunikat gdy nie ma żadnego bloba credentials (różnice copy per typ). */
function missingCredentialsMessage(kind: EnqueueKsefSubmitParams['auditKind']): string {
  if (kind === 'regular') {
    return 'Najpierw wgraj certyfikat KSeF w Ustawienia KSeF — bez niego wysyłka nie jest możliwa. Faktura została zapisana jako szkic.';
  }
  return 'Brak certyfikatu KSeF — najpierw wgraj go w Ustawieniach. Dokument zapisany jako szkic.';
}

/**
 * Wynik decyzji z kodem odmowy (`refusal`) do dziennika prób. Kod nie
 * wychodzi do wołającego — odpowiedź dla klienta jest ta sama co dotąd.
 */
type EnqueueDecision =
  | { ok: true; mode: 'online_queued' | 'offline_queued'; sendAttemptId?: string }
  | { ok: false; error: string; code?: 'KSEF_NOT_VERIFIED' | 'MFA_REQUIRED'; refusal: SendRefusalCode };

/**
 * Kolejka wysyłki po zapisie szkicu. Odmowa przed kolejką (hamulce, MFA,
 * certyfikat, wyłącznik, błąd kolejkowania) zostawia wiersz `refused`
 * w dzienniku prób (`ksef_send_attempts`, 00150) — osobny licznik w centrum
 * dowodzenia, poza skutecznością wysyłki (decyzja 13.10.2026). Zapis
 * fail-open: awaria dziennika nie zmienia odpowiedzi dla klienta.
 */
export async function enqueueKsefSubmitAfterDraft(
  params: EnqueueKsefSubmitParams,
): Promise<KsefSubmitEnqueueResult> {
  const refusal = (code: SendRefusalCode, message: string) =>
    recordSendRefusal({
      tenantId: params.tenantId,
      invoiceId: params.invoiceId,
      userId: params.userId,
      code,
      message,
    });
  let decision: EnqueueDecision;
  try {
    decision = await decideKsefSubmitEnqueue(params);
  } catch (e) {
    await refusal('ENQUEUE_ERROR', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    throw e;
  }
  if (decision.ok) return decision;
  const { refusal: code, ...result } = decision;
  await refusal(code, result.error);
  return result;
}

async function decideKsefSubmitEnqueue(
  params: EnqueueKsefSubmitParams,
): Promise<EnqueueDecision> {
  const {
    tenantId,
    userId,
    invoiceId,
    nip,
    invoice,
    correctionData,
    advanceData,
    finalData,
    finalAdvanceSettlementRows,
    auditKind,
    internalNumberForAudit,
  } = params;
  // Ponowna wysyłka z `failed` (K3, A4b PR2b): odmowa zostawia fakturę z błędem wysyłki, nie szkicem.
  const resend = params.mode?.kind === 'requeue';
  // D-A4-1b-3 PR D: „Sprawdź ponownie” — uzgodnienie bez wysyłki (`requeue_ksef_send(p_reconcile_only)`).
  // Odmowy mówią wtedy o sprawdzaniu, nie o wysyłce, i nazywają dokument; Offline24 jest pominięty (wysyłałby).
  const reconcileOnly = params.mode?.kind === 'requeue' && params.mode.reconcileOnly === true;
  const documentNumber = internalNumberForAudit ?? invoice.internalNumber ?? '(bez numeru)';

  // Covers existing ROZ drafts and callers that bypass the final invoice action.
  // Do this before both online and Offline24 enqueue paths.
  if (isRozSubmission({
    invoiceType: invoice.type,
    auditKind,
    finalData,
    finalAdvanceSettlementRows,
  })) {
    return { ok: false, refusal: 'ROZ_HOLD_RECONCILE', error: ROZ_SUBMISSION_HOLD_MESSAGE };
  }

  // Krok 5: korekty wstrzymane na KSeF produkcyjnym (AUD-03/04) i globalny
  // wyłącznik operatora (AUD-63) — przed kolejką i przed Offline24.
  const ksefEnv = (process.env.KSEF_ENV as 'test' | 'demo' | 'production' | undefined) ?? 'test';
  if (
    isCorrectionHeldForEnv(ksefEnv) &&
    isCorrectionSubmission({ invoiceType: invoice.type, auditKind, correctionData })
  ) {
    return { ok: false, refusal: 'KOR_HOLD', error: KOR_HOLD_MESSAGE };
  }
  // F12-G6b: firma zwolniona podmiotowo (art. 113) nie wysyła faktury ze
  // stawką z podatkiem, bo podatek wykazany na fakturze trzeba zapłacić
  // (art. 108 ust. 1). Jedno miejsce dla formularza, szkicu, zaliczki, strony
  // faktury i API. Korekta poprawia fakturę pierwotną, a „Sprawdź ponownie”
  // nic nie wysyła, więc obie zostają poza odmową. Ustawienia czytamy tylko
  // przy stawce z podatkiem; błąd odczytu rzuca (wyżej ENQUEUE_ERROR, bez wysyłki).
  if (!reconcileOnly && !isCorrectionSubmission({ invoiceType: invoice.type, auditKind, correctionData })) {
    const rates = (invoice.lines ?? []).map((l) => l.vatRate);
    if (rates.some((r) => TAXED_VAT_RATES.includes(r))) {
      const taxed = taxedRateUnderSubjectiveExemption(await readTenantVatExemption(params.supabase, tenantId), rates);
      if (taxed) {
        return { ok: false, refusal: 'INVALID_DOCUMENT', error: exemptTenantTaxedInvoiceMessage(documentNumber, taxed) };
      }
    }
  }
  try {
    if (await isKsefSubmissionPaused()) {
      return {
        ok: false,
        refusal: 'KSEF_PAUSED',
        error: reconcileOnly
          ? DUPLICATE_DECISION_TEXTS.RECHECK.PAUSED(documentNumber)
          : resend ? resendPausedMessage(auditKind) : KSEF_PAUSED_MESSAGE,
      };
    }
  } catch {
    // Bez pewności, że wyłącznik jest zdjęty, nie kolejkujemy (fail-closed).
    return {
      ok: false,
      refusal: 'PAUSE_UNKNOWN',
      error: reconcileOnly
        ? DUPLICATE_DECISION_TEXTS.RECHECK.PAUSE_UNKNOWN(documentNumber)
        : resend
        ? resendPauseUnknownMessage(auditKind)
        : 'Nie można sprawdzić, czy wysyłka do KSeF jest dostępna. Faktura została zapisana — spróbuj ponownie za chwilę.',
    };
  }

  // AAL2 właściciela/admina, gdy flaga `requireMfaForSensitive` jest włączona (AUD-65).
  // Klucz API nie ma sesji ani kodu: przy włączonej fladze odmawia (szkic zostaje).
  if (params.companyKey) {
    if (await companyKeyNeedsMfa()) {
      return { ok: false, code: 'MFA_REQUIRED', refusal: 'MFA_REQUIRED', error: COMPANY_KEY_MFA_REFUSAL_MESSAGE };
    }
  } else {
    if (!userId) throw new Error('Wysyłka do KSeF bez konta i bez klucza API');
    try {
      await assertSensitiveMfa({ tenantId, userId }, 'ksef_submit', params.tokenSession?.mfa);
    } catch (e) {
      if (e instanceof SensitiveMfaRequiredError) {
        return { ok: false, code: 'MFA_REQUIRED', refusal: 'MFA_REQUIRED', error: e.message };
      }
      throw e;
    }
  }

  const nipNorm = nip.replace(/\s+/g, '');

  try {
    // Klucz API: znacznik czyta token klucza (tylko jego firma, 00184), nie sesja z ciasteczek.
    // Telefon: token sesji klienta (RLS jak na stronie).
    await requireKsefVerification(tenantId, params.companyKey || params.tokenSession ? params.supabase : undefined);
  } catch (e) {
    if (e instanceof KsefNotVerifiedError) {
      return {
        ok: false,
        refusal: 'NOT_VERIFIED',
        code: 'KSEF_NOT_VERIFIED',
        error:
          'Twoja organizacja musi najpierw zweryfikować certyfikat KSeF w Ustawieniach → KSeF.',
      };
    }
    throw e;
  }

  // Blob czytamy kluczem serwisowym — rola kliencka nie ma do niego SELECT
  // (00112, AUD-103). Firma jest już zweryfikowana przez akcję wołającą.
  const { data: tenantKsef, error: tenantErr } = await createAdminClient()
    .from('tenants')
    .select('ksef_credentials_encrypted')
    .eq('id', tenantId)
    .single();

  if (tenantErr) {
    return {
      ok: false,
      refusal: 'INFRA',
      error: `Nie można sprawdzić ustawień KSeF: ${tenantErr.message}`,
    };
  }

  if (!tenantKsef?.ksef_credentials_encrypted) {
    return {
      ok: false,
      refusal: 'NO_CERTIFICATE',
      error: reconcileOnly
        ? DUPLICATE_DECISION_TEXTS.RECHECK.NO_CERTIFICATE(documentNumber)
        : resend ? resendMissingCredentialsMessage(auditKind) : missingCredentialsMessage(auditKind),
    };
  }

  let decrypted: ReturnType<typeof decryptCredentials>;
  try {
    decrypted = decryptCredentials(credentialsBuffer(tenantKsef.ksef_credentials_encrypted), tenantId);
  } catch {
    return { ok: false, refusal: 'CREDENTIALS_UNAVAILABLE', error: 'Nie można odczytać credentials KSeF.' };
  }

  const env = requireConfiguredKsefEnvironment();
  if (auditKind === 'correction' && env === 'production') {
    return {
      ok: false,
      refusal: 'KOR_HOLD',
      error: 'Wysyłka korekt w PROD jest wstrzymana do uzgodnienia oryginału i wcześniejszych korekt. Dokument zapisano jako szkic.',
    };
  }
  if (auditKind === 'final' && env === 'production') {
    return {
      ok: false,
      refusal: 'ROZ_HOLD_RECONCILE',
      error: 'Wysyłka faktury rozliczającej w PROD jest wstrzymana do czasu atomowego rozliczania zaliczek. Dokument zapisano jako szkic.',
    };
  }

  // AUD-14: na KSeF produkcyjnym bez automatycznego Offline24 (`offline24-policy.ts`).
  // PR D: uzgodnienie nigdy nie idzie ścieżką Offline24 (ta wysyła fakturę); zdrowia KSeF nie pytamy.
  const health = !reconcileOnly && isOffline24Enabled(env)
    ? await shouldUseOfflineMode(env)
    : { offline: false as const, isMfOutage: false };

  if (health.offline && env === 'production') {
    return {
      ok: false,
      refusal: 'KSEF_UNAVAILABLE',
      error: 'KSeF jest niedostępny. Offline24 w PROD jest wstrzymany do zgodności kodów QR z MF; dokument zapisano jako szkic.',
    };
  }

  // The Offline24 row stores only an invoice id. Its replay cannot reconstruct
  // KOR/ZAL/ROZ-specific legal XML, so never report those drafts as queued.
  if (health.offline && auditKind !== 'regular') {
    return {
      ok: false,
      refusal: 'KSEF_UNAVAILABLE',
      error: 'KSeF jest niedostępny. Dokument specjalny zapisano jako szkic; ponów wysyłkę po przywróceniu KSeF.',
    };
  }

  if (health.offline && decrypted.type === 'xades') {
    try {
      await addToOfflineQueue({
        tenantId,
        invoiceId,
        isMfOutage: health.isMfOutage,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Nie udało się dodać do kolejki offline';
      return { ok: false, refusal: 'OFFLINE_QUEUE_ERROR', error: msg };
    }

    await logAudit({
      action: 'invoice.submit_requested',
      tenantId,
      userId,
      entityType: 'invoice',
      entityId: invoiceId,
      metadata: {
        nip: nipNorm,
        kind: auditKind,
        mode: 'offline_queued',
        internalNumber: internalNumberForAudit ?? invoice.internalNumber,
        ...companyKeyAudit(params.companyKey),
      },
    });

    revalidatePath('/invoices');
    revalidatePath(`/invoices/${invoiceId}`);
    return { ok: true, mode: 'offline_queued' };
  }

  // Jedna transakcja (W16/W2): RPC przestawia status po stronie serwera, pg-boss
  // zapisuje zlecenie na tym samym połączeniu. Błąd zapisu zlecenia cofa status;
  // odmowa RPC (drugie kliknięcie, błąd treści przy ponowieniu) nie tworzy
  // zlecenia. To RPC chroni przed drugim zleceniem; `singletonKey` = faktura jest
  // tylko etykietą (`lib/jobs/enqueue.ts`).
  const mode: KsefSendMode = params.mode ?? { kind: 'enqueue' };
  // Właściciel przejęcia wysyłki (AUD-10): każde kolejkowanie to nowa próba.
  const sendAttemptId = randomUUID();
  try {
    await sendJobEvent(
      {
        // Grupa per tenant — limit równoległych wysyłek jednej organizacji.
        groupId: tenantId,
        singletonKey: invoiceId,
        name: 'invoice/submit.requested',
        data: {
          tenantId,
          invoiceId,
          invoice,
          nip: nipNorm,
          environment: env,
          correctionData,
          advanceData,
          finalData,
          finalAdvanceSettlementRows,
          sendAttemptId,
          // Runner czyta tryb ze zdarzenia: bez tego „Sprawdź ponownie” wysłałoby fakturę od nowa (PR D).
          // Klucz tylko w trybie uzgodnienia — zwykłe zdarzenia wyglądają jak dotąd.
          ...(reconcileOnly ? { reconcileOnly: true } : {}),
        },
      },
      { inTransaction: ksefSendTransactionStep(mode, { invoiceId, tenantId, attemptId: sendAttemptId }) },
    );
  } catch (e) {
    return { ok: false, refusal: 'ENQUEUE_REFUSED', error: describeKsefSendError(e, mode) };
  }

  await logAudit({
    action: 'invoice.submit_requested',
    tenantId,
    userId,
    entityType: 'invoice',
    entityId: invoiceId,
    metadata: {
      nip: nipNorm,
      kind: auditKind,
      mode: 'online_queued',
      send: mode.kind,
      sendAttemptId,
      internalNumber: internalNumberForAudit ?? invoice.internalNumber,
      ...companyKeyAudit(params.companyKey),
    },
  });

  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoiceId}`);
  return { ok: true, mode: 'online_queued', sendAttemptId };
}
