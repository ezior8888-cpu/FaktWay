import { assertJobIdentity, requireInvoiceTenant } from './tenant-boundary';
import { NonRetriableError, RetryAfterError } from '../errors';
import type { JobContext } from '@/lib/jobs/registry';
import { ANALYTICS_EVENTS } from '@/lib/analytics/events';
import { recordFirstInvoiceAccepted } from '@/lib/analytics/funnel';
import { trackServer } from '@/lib/analytics/server';
import { logAuditSystem } from '@/lib/audit/log-system';
import { invoiceSubmitRequested } from '../events';
import { assertSubmitReferences } from '@/lib/ksef/submit-reference-boundary';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import {
  KsefNotVerifiedError,
  requireKsefVerificationForBackgroundJob,
} from '@/lib/auth/ksef-verification-guard';
import { getTenantKsefCredentials } from '@/lib/supabase/admin-queries';
import { createAdminClient } from '@/lib/supabase/server';
import {
  findKsefNumberTaken,
  findOpenKsefSubmission,
  findOpenKsefSubmissionIntents,
} from '@/lib/ksef/submission-log';
import { shouldUseOfflineMode } from '@/lib/ksef/health-check';
import { isOffline24Enabled } from '@/lib/ksef/offline24-policy';
import { ROZ_SUBMISSION_HOLD_MESSAGE } from '@/lib/ksef/roz-submission-hold';
import { addToOfflineQueue } from '@/lib/ksef/offline-queue';
import {
  KSEF_SEND_BRAKE_RETRY_MS,
  ksefPausedUntil,
  ksefPauseRetryError,
  ksefSendBrakeActive,
  ksefSendBrakeAllows,
} from '@/lib/ksef/rate-limit-pause';
import { KsefSendVerdictError, SEND_ERROR_CODES } from '@/lib/ksef/send-error-codes';
import { getKsefRetryDelay, KSEF_MAX_RETRIES } from '../retry-schedule';
import {
  assertSubmissionNotHeld,
  credentialsFailure,
  currentSubmissionState,
  isHeldRozSubmission,
  KSEF_SEND_CLAIM_RETRY_MS,
  KSEF_SEND_LEASE_SECONDS,
  reconcileAcceptedOfflineQueue,
  reportRetiredExit,
  type RetiredOutcome,
  type SubmitOutcome,
  type SubmitRunContext,
} from './submit-invoice/shared';
import { resolveSubmissionIntents } from './submit-invoice/intents';
import { reconcilePreviousSubmission } from './submit-invoice/reconcile';
import { submitToKsef } from './submit-invoice/send';
import { saveAcceptedInvoice } from './submit-invoice/save-accepted';
import {
  KSEF_RATE_LIMIT_PAUSE,
  releaseOwnClaimBeforeWait,
  reportSendBrake,
} from './submit-invoice/rate-limit';

// Publiczne API modułu (handlery pg-boss i testy): bez zmian po podziale 3.7a.
export {
  KSEF_DUPLICATE_RECONCILE,
  KSEF_INTENT_NOT_IN_SESSION_CODE,
  KSEF_SEND_CLAIM_RETRY_MS,
  KSEF_SEND_LEASE_SECONDS,
  KSEF_SUBMISSION_STALE_CODE,
  KSEF_SUBMISSION_STALE_MS,
} from './submit-invoice/shared';
export { onSubmitInvoiceExhausted } from './submit-invoice/exhausted';

/**
 * Job wysyłki faktury do KSeF.
 *
 * Trigger: event 'invoice/submit.requested' (publikowany z Server Action
 * po kliknięciu "Wyślij do KSeF" w UI).
 *
 * Ponowienia (Faza 23 sekcja 2, stan 08.11.2026 po L1a):
 * - Harmonogram 30s → 2min → 5min → 15min → 1h przez `RetryAfterError`,
 *   z rozrzutem do +20% (`ksefRetryDelayMs`), żeby faktury, które padły
 *   razem, nie wracały razem.
 * - 5xx i timeout — ponowienie z opóźnieniem; `Retry-After` z KSeF (np. przy
 *   503) ma pierwszeństwo, najwyżej godzinę, bo czekanie trwa z fakturą
 *   w `sending` (`ksefRetryDelayMsFor`).
 * - 429 = PAUZA FIRMY (L1a, `lib/ksef/rate-limit-pause.ts`): MF liczy limity
 *   na parę (NIP, adres IP), a cała platforma wysyła z jednego adresu. Po 429
 *   żadne żądanie KSeF tej firmy nie wychodzi do końca `Retry-After` (bramka
 *   w `ksefFetch`); job czeka z rozrzutem, nie zużywa ani próby, ani odczekań
 *   (`RetryAfterError` z `pause: true`). Czekanie wypada przed przejęciem
 *   wysyłki (krok `ksef-rate-limit-pause`) albo po jego zwolnieniu
 *   (`releaseSendClaimForPause`) — nigdy z fakturą w `sending`. Kod w logach:
 *   `KSEF_RATE_LIMIT_PAUSE` (nie `KSEF_PAUSED` — to wyłącznik operatora).
 *   Hamulec 429: od kilku firm z 429 w 10 minut przechodzi ok. co czwarte
 *   zadanie (sygnał, że MF ogranicza nasz adres, M11).
 * - Błędy treści (XSD, odrzucenie przez KSeF) — `NonRetriableError`, po
 *   `onExhausted` faktura `rejected`; inne błędy bez ponowień (strażnik
 *   dokumentu, brak certyfikatu) kończą jako `failed` z kodem z katalogu
 *   `ksef_error_codes` (`lib/ksef/send-error-codes.ts`).
 *
 * Równoległość (`lib/jobs/handlers/package-d.ts`):
 * - `groupConcurrency` 2 na firmę w aplikacji (`KSEF_TENANT_CONCURRENCY_LIMIT`,
 *   L1a; wcześniej 100, czyli bez limitu), 5 slotów razem.
 * - Nie ma throttle'a „60 wysyłek/min” (był w Inngest, odpięty 02.10.2026)
 *   ani limitera per NIP liczącego żądania: `ksefRateLimiter` liczy zadania
 *   i niesie NIP do pauzy. Budżet na żądanie według grup MF to karta L1b.
 */

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-d.ts
 */
export async function runSubmitInvoice(
  data: Parameters<typeof invoiceSubmitRequested.create>[0],
  { step, logger, attempt }: JobContext,
) {
    // Runtime walidacja Zod — bramka między event store a transakcją KSeF.
    // Zła paczka (np. brak NIP-u po replay'u eventu ze starego kodu) zostaje
    // odrzucona PRZED jakąkolwiek operacją w DB / R2 / KSeF. NonRetriableError
    // zatrzymuje retry i woła `onFailure`, który oznacza fakturę jako rejected.
    const parsed = invoiceSubmitRequested.safeParse(data);
    if (!parsed.success) {
      throw new NonRetriableError(
        `Niepoprawny payload eventu invoice/submit.requested: ${parsed.error.message}`,
        { cause: parsed.error },
      );
    }
    const { tenantId, invoiceId, invoice, nip } = parsed.data;
    // Zdarzenie musi pochodzić z tego samego środowiska KSeF, które jest
    // skonfigurowane — inaczej faktura trafiłaby do innego KSeF (#63, Codex).
    const env = configuredKsefEnvironment();
    if (!env || parsed.data.environment !== env) {
      throw new NonRetriableError('KSeF submit event environment does not match configured environment');
    }
    // Automatyczny Offline24 wstrzymany (decyzja 02.10.2026, #71): zdarzenie
    // z kolejki offline to stary wpis — tylko ręczne uzgodnienie.
    if (parsed.data.fromOfflineQueue) {
      throw new NonRetriableError('Offline24 automatic replay requires manual reconciliation');
    }
    await requireInvoiceTenant(invoiceId, tenantId);
    const fromOfflineQueue = Boolean(parsed.data.fromOfflineQueue);
    if (fromOfflineQueue) {
      assertJobIdentity(parsed.data.offlineQueueId, tenantId);
      const { data: queueRow, error: queueError } = await (await createAdminClient())
        .from('ksef_offline_queue')
        .select('id')
        .eq('id', parsed.data.offlineQueueId!)
        .eq('tenant_id', tenantId)
        .eq('invoice_id', invoiceId)
        .eq('ksef_environment', env)
        .eq('status', 'sending')
        .maybeSingle();
      if (queueError || !queueRow) {
        throw new NonRetriableError('Offline24 queue reference requires reconciliation');
      }
    }

    // IDEMPOTENCJA (audyt przedlaunchowy): backstop przeciw podwójnej wysyłce.
    // Gdyby ten sam event przyszedł dwa razy (double-click „Wyślij", replay
    // eventu, równoległy enqueue z dwóch instancji), NIE wysyłamy faktury do
    // KSeF drugi raz — jeśli ma już numer KSeF i status 'accepted', zwracamy
    // istniejący wynik. To uzupełnia: deterministyczny generator FA(3) (ten sam
    // XML), idempotencję R2 (HEAD + IfNoneMatch) oraz unikalność numeru P_2 po
    // stronie MF. Trzy niezależne warstwy ochrony przed duplikatem w KSeF.
    const alreadyDone = await step.run('idempotency-guard', async () => {
      const supabase = await createAdminClient();
      const { data, error } = await supabase
        .from('invoices')
        .select('ksef_status, ksef_number, ksef_environment')
        .eq('id', invoiceId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (error || !data) throw new Error('Nie można sprawdzić statusu faktury');
      return data;
    });
    if (alreadyDone?.ksef_status === 'accepted' && alreadyDone.ksef_number &&
        alreadyDone.ksef_environment === env) {
      logger.info('Faktura już zaakceptowana w KSeF — pomijam ponowną wysyłkę', {
        invoiceId,
        ksefNumber: alreadyDone.ksef_number,
      });
      await reconcileAcceptedOfflineQueue(parsed.data);
      // Ponowienie po awarii tuż po zapisie akceptacji: kroki niżej już się nie wykonają,
      // a pierwszej faktury firmy nie wolno zgubić (powtórka ma ten sam uuid).
      await recordFirstInvoiceAccepted({ tenantId, invoiceId });
      return {
        alreadyAccepted: true as const,
        ksefNumber: alreadyDone.ksef_number,
      };
    }

    // Fresh, non-memoized read: an older Inngest idempotency step can be
    // restored after deployment. Check the stored kind as well as the event.
    const current = await currentSubmissionState(parsed.data);
    if (current.direction === 'incoming') {
      throw new NonRetriableError('KSeF incoming invoice requires manual reconciliation');
    }
    if (current.ksef_status === 'accepted' && current.ksef_environment !== env) {
      logger.error('KSeF accepted invoice environment requires manual reconciliation', {
        invoiceId,
        environment: env,
        storedEnvironment: current.ksef_environment ?? null,
      });
      throw new NonRetriableError('KSeF accepted invoice environment requires manual reconciliation');
    }
    if (current.ksef_status === 'accepted' && current.ksef_number) {
      await reconcileAcceptedOfflineQueue(parsed.data);
      return { alreadyAccepted: true as const, ksefNumber: current.ksef_number };
    }
    // D-A4-1b-3 PR B (§2.7.2): szkic wycofany (wpis `number_taken`) — przed
    // blokadą ROZ i hamulcami. Inaczej stare zlecenie pod hamulcem skończyłoby
    // się `failed KSEF_PAUSED`, a I7 wznowiłby potem pełną wysyłkę (440).
    // Błąd odczytu rzuca zwykły Error — ponowienie, nic nie wysłane.
    if (current.ksef_status === 'draft') {
      const taken = await findKsefNumberTaken(tenantId, invoiceId);
      if (taken) {
        reportRetiredExit(logger, 'run', {
          tenantId,
          invoiceId,
          originalKsefNumber: taken.originalKsefNumber,
          reconcileOnly: parsed.data.reconcileOnly === true,
        });
        return { retired: true as const, originalKsefNumber: taken.originalKsefNumber };
      }
    }
    if (isHeldRozSubmission(parsed.data, current)) {
      throw new NonRetriableError(ROZ_SUBMISSION_HOLD_MESSAGE);
    }
    // Przed sondą zdrowia i Offline24 — wstrzymanej faktury nie wolno też zaparkować.
    await assertSubmissionNotHeld(parsed.data, current, env);

    // Wspólny kontekst kroków (3.7a). Od tego miejsca wszystkie pola są ustalone.
    const ctx: SubmitRunContext = { parsed, tenantId, invoiceId, invoice, nip, env, attempt, logger };

    // L1a: pauza firmy po 429 z KSeF i hamulec 429 — przed odwołaniami,
    // poświadczeniami, sondą zdrowia i przejęciem wysyłki („po każdym powrocie
    // zadanie najpierw sprawdza pauzę”, karta L1a pkt 2). Firma bez pauzy przy
    // wyłączonym hamulcu: tylko pamięć procesu i Redis, bez odczytu bazy.
    // Przyczyna `KSEF_RATE_LIMIT` — gdyby łańcuch pauz przekroczył dobę
    // (`MAX_PAUSE_CHAIN_MS`), `onExhausted` zapisze limit KSeF (klasa
    // transient, I6), a nie awarię infrastruktury.
    await step.run('ksef-rate-limit-pause', async () => {
      const pausedUntil = await ksefPausedUntil(env, nip);
      if (pausedUntil !== null) {
        await releaseOwnClaimBeforeWait(ctx);
        const remaining = pausedUntil - Date.now();
        logger.warn('Firma w pauzie po 429 z KSeF: wysyłka czeka przed przejęciem', {
          code: KSEF_RATE_LIMIT_PAUSE,
          tenantId,
          invoiceId,
          attempt,
          remainingMs: remaining,
        });
        const message = `Firma w pauzie po 429 z KSeF: wysyłka czeka do końca blokady MF (jeszcze ${Math.ceil(Math.max(0, remaining) / 1000)} s)`;
        throw ksefPauseRetryError(message, remaining, invoiceId,
          new KsefSendVerdictError(SEND_ERROR_CODES.KSEF_RATE_LIMIT, message));
      }
      // Hamulec 429 (wiele firm z 429 naraz, sygnał ograniczenia naszego adresu
      // IP): przechodzi ok. co czwarte zadanie na minutę, reszta czeka minutę
      // z rozrzutem i losuje od nowa — bez zużycia próby.
      if (await ksefSendBrakeActive(env) && !ksefSendBrakeAllows(invoiceId, Date.now())) {
        await releaseOwnClaimBeforeWait(ctx);
        reportSendBrake(env, { tenantId, invoiceId });
        logger.warn('Hamulec 429 (wiele firm z 429 naraz): wysyłka czeka', {
          code: KSEF_RATE_LIMIT_PAUSE,
          tenantId,
          invoiceId,
          attempt,
        });
        const message = 'Hamulec 429: KSeF ogranicza wiele firm naraz, wysyłka czeka, żeby nie wydłużać blokady';
        throw ksefPauseRetryError(message, KSEF_SEND_BRAKE_RETRY_MS, invoiceId,
          new KsefSendVerdictError(SEND_ERROR_CODES.KSEF_RATE_LIMIT, message));
      }
    });

    // Odwołania dokumentu specjalnego (rodzic korekty, zaliczki ROZ) muszą
    // wskazywać faktury tej firmy przyjęte w tym środowisku KSeF (#63, Codex).
    const documentKind = await assertSubmitReferences({
      supabase: await createAdminClient(),
      tenantId,
      invoiceId,
      invoice,
      environment: env,
      correctionData: parsed.data.correctionData,
      advanceData: parsed.data.advanceData,
      finalData: parsed.data.finalData,
      finalAdvanceSettlementRows: parsed.data.finalAdvanceSettlementRows,
      // A4b PR2a: przed uzgodnieniem bez porównania z bieżącym profilem firmy —
      // tylko gdy będzie co uzgadniać. Granica przed POST sprawdza go zawsze.
      skipLiveTenantSeller: async () => parsed.data.reconcileOnly === true
        || (await findOpenKsefSubmission(tenantId, invoiceId)) !== null
        || (await findOpenKsefSubmissionIntents(tenantId, invoiceId)).length > 0,
    });

    logger.info('Rozpoczynam wysyłkę faktury', {
      tenantId,
      invoiceId,
      nip,
      internalNumber: invoice.internalNumber,
      fromOfflineQueue,
      attempt,
    });

    // Re-emisja po odebraniu z kolejki offline — nie blokuj kolejną sondą zdrowia KSeF,
    // tylko idź klasyczną ścieżką online submit.
    // AUD-14: na KSeF produkcyjnym bez automatycznego Offline24
    // (`offline24-policy.ts`) — gdy KSeF nie odpowiada, zadziała zwykłe
    // ponowienie po sondzie zdrowia przed wysyłką.
    if (!fromOfflineQueue && isOffline24Enabled(env)) {
      const health = await step.run('check-ksef-health', async () =>
        shouldUseOfflineMode(env),
      );

      if (health.offline) {
        if (documentKind !== 'regular') {
          throw new RetryAfterError(
            'KSeF unavailable; special invoice cannot be replayed from Offline24',
            getKsefRetryDelay(attempt),
          );
        }
        const redirected = await step.run(
          'try-redirect-offline-queue',
          async (): Promise<boolean> => {
            try {
              await requireKsefVerificationForBackgroundJob(tenantId);
            } catch (e) {
              if (e instanceof KsefNotVerifiedError) {
                throw new NonRetriableError(
                  'Organizacja nie ma zweryfikowanego certyfikatu KSeF — tryb offline nie jest dostępny.',
                  { cause: e },
                );
              }
              throw e;
            }

            const creds = await getTenantKsefCredentials(tenantId);
            if (creds.type !== 'xades') {
              logger.warn('KSeF offline — pomijam kolejkę offline (brak PEM / token)', {
                tenantId,
                invoiceId,
                authType: creds.type,
              });
              return false;
            }

            const current = await currentSubmissionState(parsed.data);
            if ((current.ksef_status === 'accepted' && current.ksef_number) ||
                isHeldRozSubmission(parsed.data, current)) {
              throw new NonRetriableError(ROZ_SUBMISSION_HOLD_MESSAGE);
            }
            await addToOfflineQueue({
              tenantId,
              invoiceId,
              isMfOutage: health.isMfOutage,
            });
            return true;
          },
        );

        if (redirected) {
          await step.run('audit-redirect-offline', async () => {
            await logAuditSystem({
              action: 'invoice.submit_redirected_offline',
              tenantId,
              entityType: 'invoice',
              entityId: invoiceId,
              metadata: {
                reason: health.reason,
                isMfOutage: health.isMfOutage,
                internalNumber: invoice.internalNumber,
              },
            });
          });

          logger.info('KSeF niedostępny — faktura przekierowana do trybu Offline24', {
            invoiceId,
            reason: health.reason,
          });

          return {
            redirected: 'offline',
            reason: health.reason,
            isMfOutage: health.isMfOutage,
          };
        }
      }
    }

    // Krok 1: walidacja credentials PRZED `sending` — brak certyfikatu kończy
    // bez ponowień (`failed NO_CERTIFICATE`), błąd bazy albo klucza jest
    // ponawiany (W1) — zanim status przejdzie na `sending`.
    //
    // UWAGA SECOPS: ten step CELOWO zwraca tylko `{ type, nip }` zamiast
    // pełnych credentials. Inngest serializuje return-value każdego `step.run`
    // do swojego event store'u (memoization na potrzeby retry) — gdybyśmy
    // wracali pełny `KsefAuth`, odszyfrowany PEM klucza prywatnego XAdES /
    // long-lived token KSeF lądował-by w cudzej bazie z retencją >1d.
    // Faktyczne credentials wczytujemy ponownie wewnątrz kroku `submit-to-ksef`
    // (świeży decrypt z naszej DB, bez serializacji do Inngest).
    await step.run('load-credentials-meta', async () => {
      try {
        const c = await getTenantKsefCredentials(tenantId);
        return { type: c.type, nip: c.nip };
      } catch (e) {
        throw credentialsFailure(e, { tenantId, invoiceId, attempt });
      }
    });

    await step.run('verify-ksef-claimed', async () => {
      try {
        await requireKsefVerificationForBackgroundJob(tenantId);
      } catch (e) {
        if (e instanceof KsefNotVerifiedError) {
          throw new NonRetriableError(
            'Organizacja nie ma zweryfikowanego certyfikatu KSeF (Ustawienia → KSeF). Wysyłka do KSeF jest zablokowana.',
            { cause: e },
          );
        }
        throw e;
      }
    });

    // Krok 1.5: pre-flight check KSeF health (Faza 23 sekcja 1+2).
    // Jeśli health monitor wcześniej zaobserwował `down` (3+ consecutive
    // failures lub HTTP 503 z MF), nie spalamy retry-budgetu na zapowiedzianą
    // porażkę — od razu rzucamy RetryAfterError z naszego schedule'a.
    //
    // Dla `attempt === 0` skip — pierwsza próba zawsze powinna sięgnąć
    // KSeF, żeby zweryfikować że monitor nie był stale (TTL Redis 90s).
    if (attempt > 0) {
      const { isKsefHealthy } = await import('@/lib/ksef/health-status');
      const healthy = await step.run('health-check', () => isKsefHealthy(env));
      if (!healthy) {
        const delay = getKsefRetryDelay(attempt);
        logger.warn('KSeF zgłaszany jako down — odkładam próbę', {
          tenantId,
          invoiceId,
          attempt,
          retryAfter: delay,
        });
        throw new RetryAfterError(
          'KSeF health monitor zgłasza down — odkładam wysyłkę',
          delay,
        );
      }
    }

    // Krok 2: przejęcie wysyłki (AUD-10, 00124) — `sending` z wyłącznością.
    // Wygrywa, gdy faktura jest wolna, gdy trzyma ją ta sama próba (ponowienie
    // tego samego zdarzenia) albo gdy dzierżawa innej próby wygasła. Ponowienie
    // najpierw uzgadnia poprzednią wysyłkę po numerze referencyjnym (C-18).
    const claimed = await step.run('mark-as-sending', async (): Promise<boolean | RetiredOutcome> => {
      const { data, error: claimError } = await (await createAdminClient()).rpc('claim_ksef_send', {
        p_invoice_id: invoiceId,
        p_tenant_id: tenantId,
        p_owner: parsed.data.sendAttemptId ?? null,
        p_lease_seconds: KSEF_SEND_LEASE_SECONDS,
      });
      if (claimError) {
        // D-A4-1b-3 PR B (§2.7.2, wyścig): decyzja klienta zapadła między
        // odczytem stanu a przejęciem — wyzwalacz c_guard_ksef_retired_draft
        // (00148) odmawia P0001. Szkic wycofany kończy job bez zapisu;
        // inna odmowa (albo błąd odczytu historii) — zwykłe ponowienie.
        if (claimError.code === 'P0001') {
          const taken = await findKsefNumberTaken(tenantId, invoiceId);
          if (taken) return { retired: true, originalKsefNumber: taken.originalKsefNumber };
        }
        throw new Error('Nie można przejąć wysyłki faktury');
      }
      return typeof data === 'string' && data.length > 0;
    });
    if (typeof claimed === 'object' && claimed !== null && claimed.retired) {
      reportRetiredExit(logger, 'claim', {
        tenantId,
        invoiceId,
        originalKsefNumber: claimed.originalKsefNumber,
        reconcileOnly: parsed.data.reconcileOnly === true,
      });
      return { retired: true as const, originalKsefNumber: claimed.originalKsefNumber };
    }
    // Starsze punkty kontrolne Inngest zapisały tu `undefined` — tylko jawne
    // `false` oznacza, że wysyłkę trzyma inna próba.
    if (claimed === false) {
      const latest = await currentSubmissionState(parsed.data);
      if (latest.ksef_status === 'accepted' && latest.ksef_number) {
        await reconcileAcceptedOfflineQueue(parsed.data);
        return { alreadyAccepted: true as const, ksefNumber: latest.ksef_number };
      }
      logger.warn('Wysyłkę faktury prowadzi inna próba — czekam na jej wynik albo koniec dzierżawy', {
        invoiceId,
        attempt,
      });
      // S22: to oczekiwanie, nie porażka — nie zużywa próby z `maxRetries`.
      throw new RetryAfterError(
        'Wysyłkę tej faktury prowadzi inna próba — ponowię po jej wyniku',
        KSEF_SEND_CLAIM_RETRY_MS,
        { countsAsAttempt: false },
      );
    }

    await step.run('audit-start', async () => {
      await logAuditSystem({
        action: 'invoice.submit_requested',
        tenantId,
        entityType: 'invoice',
        entityId: invoiceId,
        metadata: { attempt: attempt + 1, maxAttempts: KSEF_MAX_RETRIES + 1 },
      });
    });

    // Krok 3: pełny flow (generuj XML → waliduj XSD → R2 → KSeF).
    // Credentials wczytujemy świeżo wewnątrz tego kroku, a wynik kroku to
    // same meta-dane (ksefNumber, hash, path) — bez PEM-a i tokenu.
    //
    // Ponowienie (pg-boss) wykonuje CAŁY handler od nowa, bez pamięci kroków:
    // strażnik idempotencji, krok pauzy po 429 (przed przejęciem), przejęcie
    // tym samym właścicielem, potem uzgodnienie wcześniejszej próby (zamiar,
    // wpis `sent`) zamiast drugiej wysyłki. 429 w trakcie wysyłki zwalnia
    // przejęcie (`sending` → `queued`, `releaseSendClaimForPause`), więc
    // czekanie na koniec pauzy nie trzyma faktury w `sending`.
    // Krok 2.5 (AUD-01): jeśli wcześniejsza próba dotarła do KSeF (mamy jej
    // numery referencyjne), pytamy o status TEJ wysyłki zamiast wysyłać fakturę
    // drugi raz. Bez tego timeout pollingu, 5xx albo padnięty worker kończyły
    // się ponowną wysyłką, odpowiedzią 440 i fałszywym „odrzucona”.
    // Krok 2.4 (A2): zamiar wysyłki bez numeru referencyjnego faktury — KSeF
    // mógł przyjąć plik, a odpowiedź nie dotarła (timeout, padnięty worker,
    // błąd zapisu). Zamykamy tamtą sesję i pytamy KSeF o jej faktury: plik
    // jest → wpis `sent` i zwykłe uzgodnienie po referencji niżej; sesja
    // pusta → zamiar porzucony i wysyłka od nowa. Każda niepewność to
    // ponowienie uzgadniania, nigdy druga wysyłka.
    await step.run('resolve-submission-intents', () => resolveSubmissionIntents(ctx));

    // A2b, D-A4-1: uzgodnienie bez otwartej wysyłki i werdykt duplikatu 440
    // opisane w `./submit-invoice/reconcile.ts` i `./submit-invoice/duplicate.ts`.
    const reconciled = await step.run(
      'reconcile-previous-submission',
      (): Promise<SubmitOutcome | null> => reconcilePreviousSubmission(ctx),
    );

    const result: SubmitOutcome = reconciled ?? await step.run(
      'submit-to-ksef',
      (): Promise<SubmitOutcome> => submitToKsef(ctx),
    );

    // Krok 4: zapisz numer KSeF i timestamp akceptacji do bazy.
    await step.run('save-ksef-number', () => saveAcceptedInvoice(ctx, result));


    await step.run('analytics-invoice-accepted', async () => {
      await trackServer({
        tenantId,
        event: ANALYTICS_EVENTS.invoiceAccepted,
        properties: { ksef_env: env },
        dedupeKey: invoiceId,
        timestamp: result.acquisitionTimestamp,
      });
      await recordFirstInvoiceAccepted({ tenantId, invoiceId });
    });

    await step.sendEvent('trigger-upo-download', {
      name: 'invoice/upo.requested',
      // Limit „3 naraz per NIP” w pg-boss działa tylko z grupą (AUD-92).
      groupId: nip,
      data: {
        invoiceId,
        tenantId,
        // `nip` powędruje do `downloadUpoJob` jako klucz concurrency
        // (`{ key: 'data.nip', limit: 3 }`) — limit per-tenant zapobiega
        // zalaniu KSeF /upo żądaniami z jednego podmiotu.
        nip,
        ksefNumber: result.ksefNumber,
        environment: env,
        // KSeF 2.0 trzyma UPO w zasobach sesji (AUD-17).
        sessionReferenceNumber: result.sessionReferenceNumber,
      },
    });

    await step.run('audit-success', async () => {
      await logAuditSystem({
        action: 'invoice.submit_succeeded',
        tenantId,
        entityType: 'invoice',
        entityId: invoiceId,
        metadata: { ksefNumber: result.ksefNumber, via: result.via },
      });
    });

    await step.sendEvent('emit-success', {
      name: 'invoice/submit.succeeded',
      data: {
        invoiceId,
        tenantId,
        ksefNumber: result.ksefNumber,
        environment: env,
        fromOfflineQueue: data.fromOfflineQueue,
        offlineQueueId: parsed.data.offlineQueueId,
      },
    });

    logger.info('Faktura wysłana', {
      invoiceId,
      ksefNumber: result.ksefNumber,
    });

    return {
      success: true,
      ksefNumber: result.ksefNumber,
    };
}
