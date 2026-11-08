/**
 * Dziennik prób wysyłki do KSeF (`ksef_send_attempts`, migracja 00150) —
 * sesja A5 planu „zero zgubionych faktur”, kontrakt danych centrum
 * dowodzenia (brief, sekcja 5).
 *
 * Po co: porażka PRZED wysłaniem pliku (poświadczenia, XML, przejęcie,
 * hamulce) nie zostawia wiersza w `ksef_submissions`, a na fakturze zostaje
 * tylko ostatni błąd (`last_error*` — kolejna próba go nadpisuje). Bez tego
 * dziennika nie widać, ile razy i na czym faktura padła.
 *
 * Jeden wiersz = jedno wykonanie joba wysyłki (job pg-boss). Ponowienie to
 * nowy job, więc nowy wiersz — wcześniejsza porażka zostaje w historii obok
 * późniejszego sukcesu. Dlatego osobna tabela, a nie kolumny
 * `ksef_submissions` z `UNIQUE (send_attempt_id)` z briefu: po A2 jedna
 * próba (`sendAttemptId`) ma kilka sesji KSeF (zamiar porzucony → nowa
 * sesja) i kilka wykonań, a statusy `ksef_submissions` są dowodem kontaktu
 * z KSeF (`ksef_has_contact_evidence`, I5, duplikaty) — wiersze porażek
 * sprzed POST nie mogą tam trafić.
 *
 * Dziennik tylko opisuje: nie zmienia stanu faktury, nie decyduje
 * o ponowieniu. Każdy zapis jest fail-open — awaria dziennika nie zatrzymuje
 * wysyłki (ostrzeżenie w logu i w Sentry, raz na wykonanie) — i ma limit
 * czasu (`LEDGER_TIMEOUT_MS`): zawieszony zapis (np. blokada tabeli przy
 * migracji) nie trzyma wysyłki, także między przyjęciem pliku przez KSeF
 * a zapisem numeru.
 *
 * Etap bierzemy z nazw kroków runnera (`step.run('load-credentials-meta')`
 * itd.), więc runner wysyłki zostaje nietknięty. Odmowy PRZED kolejką
 * (hamulce, MFA, certyfikat — `ksef-submit-enqueue.ts`) zapisuje
 * `recordSendRefusal` jako `refused`; nie wchodzą do skuteczności wysyłki.
 *
 * Tylko service_role (00150) — wywołania z workera i z akcji serwera.
 */

import * as Sentry from '@sentry/nextjs';

import type { JobContext } from '@/lib/jobs/registry';
import { MAX_WAIT_RETRIES, readWaits } from '@/lib/jobs/retry';
import type { JobStep } from '@/lib/jobs/step-shim';
import { KsefApiError } from '@/lib/ksef/client';
import { configuredKsefEnvironment } from '@/lib/ksef/claim-environment';
import type { SendRefusalCode } from '@/lib/ksef/send-error-classes';
import { classifySendError, sendErrorClassOf } from '@/lib/ksef/send-error-codes';
import { KsefInvoiceRejectedError } from '@/lib/ksef/submit';
import { scrubTelemetryText } from '@/lib/observability/scrub';
import { createAdminClient } from '@/lib/supabase/server';
import { InvoiceValidationError } from '@/lib/xml/fa3-generator';
import { InvoiceXmlSchemaError } from '@/lib/xml/validator';

export const SEND_ATTEMPT_STAGES = [
  'start',
  'guard',
  'offline',
  'credentials',
  'health',
  'claim',
  'reconcile',
  'submit',
  'xml',
  'ksef',
  'save',
  'finalize',
  'enqueue',
] as const;
export type SendAttemptStage = (typeof SEND_ATTEMPT_STAGES)[number];

export type SendAttemptStatus = 'started' | 'succeeded' | 'failed' | 'waiting' | 'refused';

/**
 * Krok runnera → etap. Kroki bez wpisu nie zmieniają etapu (np. zapis
 * porażki w `onExhausted`). `submit-to-ksef` doprecyzowuje błąd
 * (`refineStage`): XML/walidacja albo odpowiedź KSeF.
 */
const STEP_STAGE: Readonly<Record<string, SendAttemptStage>> = {
  'idempotency-guard': 'guard',
  'check-ksef-health': 'offline',
  'try-redirect-offline-queue': 'offline',
  'audit-redirect-offline': 'offline',
  'load-credentials-meta': 'credentials',
  'verify-ksef-claimed': 'credentials',
  'health-check': 'health',
  'mark-as-sending': 'claim',
  'audit-start': 'claim',
  'resolve-submission-intents': 'reconcile',
  'reconcile-previous-submission': 'reconcile',
  'submit-to-ksef': 'submit',
  'save-ksef-number': 'save',
  'analytics-invoice-accepted': 'finalize',
  'audit-success': 'finalize',
};

export function stageForStep(name: string): SendAttemptStage | null {
  return STEP_STAGE[name] ?? null;
}

/** Błąd i jego przyczyny (`cause`), od wierzchu w dół; bez pętli. */
function chain(error: unknown): Error[] {
  const out: Error[] = [];
  let current: unknown = error;
  while (current instanceof Error && out.length < 8 && !out.includes(current)) {
    out.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return out;
}

/** `instanceof` albo nazwa — błąd mógł przejść przez inną kopię modułu (jak w `send-error-codes.ts`). */
function isNamed<T extends Error>(e: Error, cls: abstract new (...args: never[]) => T, name: string): e is T {
  return e instanceof cls || e.name === name;
}

/** Etap `submit` doprecyzowany po błędzie: XML (generator, XSD) albo odpowiedź KSeF. */
export function refineStage(stage: SendAttemptStage, error: unknown): SendAttemptStage {
  if (stage !== 'submit') return stage;
  for (const e of chain(error)) {
    if (isNamed(e, InvoiceXmlSchemaError, 'InvoiceXmlSchemaError') || isNamed(e, InvoiceValidationError, 'InvoiceValidationError')) {
      return 'xml';
    }
    if (isNamed(e, KsefApiError, 'KsefApiError') || isNamed(e, KsefInvoiceRejectedError, 'KsefInvoiceRejectedError')) {
      return 'ksef';
    }
  }
  return stage;
}

const MAX_MESSAGE = 500;

/**
 * Treść błędu do dziennika bez danych klienta (brief C-22 §5, reguła 4):
 * bez sekretów z adresów i tokenów (`scrubTelemetryText`), bez NIP-ów,
 * numerów rachunków i VAT-UE, kwot i innych liczb oraz wartości pól
 * w cudzysłowach (walidator i XSD powtarzają treść dokumentu). Zostają
 * nazwy pól (`P_15`), klasa błędu i opis — HTTP i kod KSeF mają własne
 * kolumny. Najwyżej 500 znaków. Pełny ostatni błąd jest na fakturze.
 */
export function sendAttemptMessage(message: string): string {
  return scrubTelemetryText(message)
    .replace(/\b\d{10}\b/g, '[NIP]')
    .replace(/"[^"]*"|'[^']*'|„[^”]*”/g, '"…"')
    .replace(/\b[A-Z]{2}\d[\d ]{7,}\d\b/g, '<rachunek>')
    .replace(/(?<![\w])\d+(?:[ .,]\d+)*/g, '<n>')
    .slice(0, MAX_MESSAGE);
}

export interface SendAttemptFailure {
  status: 'failed' | 'waiting';
  stage: SendAttemptStage;
  error_code: string | null;
  error_class: string | null;
  error_message: string;
  ksef_http_status: number | null;
  ksef_code: number | null;
  retryable: boolean;
}

/**
 * Opis porażki wykonania. Kod i klasa z tej samej klasyfikacji co stan
 * faktury po wyczerpaniu prób (`classifySendError`) — zapisane w chwili
 * zdarzenia, więc późniejsza zmiana katalogu nie zmienia historii.
 * Oczekiwanie (`RetryAfterError` bez zużycia próby: dzierżawa innej próby,
 * KSeF nadal przetwarza) to `waiting` bez kodu — nie porażka. Po wyczerpaniu
 * limitu odczekań (`decideRetry`) to samo oczekiwanie zużywa próbę i może
 * zakończyć job — wtedy jest zwykłą porażką z kodem.
 */
export function describeSendAttemptFailure(
  error: unknown,
  stage: SendAttemptStage,
  /** Licznik odczekań joba (`__waits`); po `MAX_WAIT_RETRIES` pg-boss liczy oczekiwanie jako próbę. */
  waits = 0,
): SendAttemptFailure {
  const errors = chain(error);
  const top = errors[0];
  const waiting =
    top !== undefined &&
    top.name === 'RetryAfterError' &&
    (top as { countsAsAttempt?: unknown }).countsAsAttempt === false &&
    waits < MAX_WAIT_RETRIES;
  const retryable = !(top !== undefined && top.name === 'NonRetriableError');
  let httpStatus: number | null = null;
  let ksefCode: number | null = null;
  for (const e of errors) {
    if (httpStatus === null && isNamed(e, KsefApiError, 'KsefApiError')) {
      const api = e;
      httpStatus = typeof api.status === 'number' ? api.status : null;
      ksefCode = ksefCode ?? (typeof api.ksefCode === 'number' ? api.ksefCode : null);
    }
    if (ksefCode === null && isNamed(e, KsefInvoiceRejectedError, 'KsefInvoiceRejectedError')) {
      const rejected = e;
      ksefCode = typeof rejected.code === 'number' ? rejected.code : null;
    }
  }
  const classified = waiting ? null : classifySendError(error);
  return {
    status: waiting ? 'waiting' : 'failed',
    stage: refineStage(stage, error),
    error_code: classified?.code ?? null,
    error_class: classified?.class ?? null,
    error_message: sendAttemptMessage(top ? `${top.name}: ${top.message}` : String(error)),
    ksef_http_status: httpStatus,
    ksef_code: ksefCode,
    retryable,
  };
}

/** Wynik udanego wykonania z wartości zwróconej przez runner. */
export function sendAttemptResult(value: unknown): string {
  if (typeof value !== 'object' || value === null) return 'completed';
  const v = value as Record<string, unknown>;
  if (v.alreadyAccepted === true) return 'already_accepted';
  if (v.retired === true) return 'retired';
  if (v.redirected === 'offline') return 'offline_redirect';
  if (v.success === true && typeof v.ksefNumber === 'string') return 'accepted';
  return 'completed';
}

/** SHA obrazu workera, jeśli platforma go podaje (Coolify: `SOURCE_COMMIT`). */
export function workerRevision(): string | null {
  const raw = process.env.SOURCE_COMMIT || process.env.GIT_COMMIT_SHA || '';
  const sha = raw.trim();
  return sha ? sha.slice(0, 64) : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

interface AttemptIdentity {
  tenantId: string;
  invoiceId: string;
  sendAttemptId: string | null;
  environment: string | null;
}

function identityOf(data: unknown): AttemptIdentity | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const tenantId = uuidOrNull(d.tenantId);
  const invoiceId = uuidOrNull(d.invoiceId);
  if (!tenantId || !invoiceId) return null;
  return {
    tenantId,
    invoiceId,
    sendAttemptId: uuidOrNull(d.sendAttemptId),
    environment: typeof d.environment === 'string' ? d.environment.slice(0, 20) : null,
  };
}

type Row = Record<string, unknown>;

/** Limit czasu jednego zapisu dziennika; po nim zapis jest przerywany (fail-open). */
export const LEDGER_TIMEOUT_MS = 3000;

/** Sygnał przerwania po `ms`; `clear` zwalnia zegar po zakończeniu zapisu. */
function deadline(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`zapis dziennika przekroczył ${ms} ms`)), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Zapis jednego wykonania. Każda operacja fail-open i z limitem czasu;
 * pierwszy błąd zapisu zgłaszany raz (log + Sentry), kolejne tylko w logu.
 */
class AttemptWriter {
  private rowId: string | null = null;
  private reported = false;

  constructor(
    private readonly base: Row,
    private readonly logger: JobContext['logger'],
    private readonly timeoutMs: number,
  ) {}

  private report(op: string, detail: string): void {
    this.logger.warn('Dziennik prób wysyłki KSeF: zapis nieudany (wysyłka trwa dalej)', { op, detail });
    if (this.reported) return;
    this.reported = true;
    Sentry.captureMessage('KSeF: dziennik prób wysyłki — zapis nieudany', {
      level: 'warning',
      tags: { area: 'ksef.send-attempts', op },
      extra: { invoiceId: this.base.invoice_id, jobId: this.base.job_id },
    });
  }

  async start(): Promise<void> {
    const limit = deadline(this.timeoutMs);
    try {
      const { data, error } = await (await createAdminClient())
        .from('ksef_send_attempts')
        .insert({ ...this.base, status: 'started' satisfies SendAttemptStatus, stage: 'start' satisfies SendAttemptStage })
        .select('id')
        .abortSignal(limit.signal)
        .single();
      if (error || !data) {
        this.report('start', error?.message ?? 'brak id wiersza');
        return;
      }
      this.rowId = String((data as { id: unknown }).id);
    } catch (e) {
      this.report('start', e instanceof Error ? e.message : String(e));
    } finally {
      limit.clear();
    }
  }

  async stage(stage: SendAttemptStage): Promise<void> {
    if (!this.rowId) return;
    const limit = deadline(this.timeoutMs);
    try {
      const { error } = await (await createAdminClient())
        .from('ksef_send_attempts')
        .update({ stage })
        .eq('id', this.rowId)
        .abortSignal(limit.signal);
      if (error) this.report('stage', error.message);
    } catch (e) {
      this.report('stage', e instanceof Error ? e.message : String(e));
    } finally {
      limit.clear();
    }
  }

  /** Wynik wykonania. Bez wiersza startowego (awaria przy starcie) — pełny wiersz od nowa. */
  async finish(outcome: Row): Promise<void> {
    const finished = { ...outcome, finished_at: new Date().toISOString() };
    const limit = deadline(this.timeoutMs);
    try {
      const client = await createAdminClient();
      const { error } = this.rowId
        ? await client.from('ksef_send_attempts').update(finished).eq('id', this.rowId).abortSignal(limit.signal)
        : await client.from('ksef_send_attempts').insert({ ...this.base, ...finished }).abortSignal(limit.signal);
      if (error) this.report('finish', error.message);
    } catch (e) {
      this.report('finish', e instanceof Error ? e.message : String(e));
    } finally {
      limit.clear();
    }
  }
}

/**
 * Handler joba wysyłki z dziennikiem prób: wiersz `started` przed runnerem,
 * etap przy każdym kroku zmieniającym etap, wynik po runnerze. Wynik
 * i wyjątek runnera przechodzą bez zmian — retry i `onExhausted` decydują
 * jak dotąd.
 */
export function withSendAttemptLedger<TData, TResult>(
  handler: (data: TData, ctx: JobContext) => Promise<TResult>,
  options: { timeoutMs?: number } = {},
): (data: TData, ctx: JobContext) => Promise<TResult> {
  const timeoutMs = options.timeoutMs ?? LEDGER_TIMEOUT_MS;
  return async (data, ctx) => {
    const identity = identityOf(data);
    if (!identity) return handler(data, ctx);

    const writer = new AttemptWriter(
      {
        tenant_id: identity.tenantId,
        invoice_id: identity.invoiceId,
        send_attempt_id: identity.sendAttemptId,
        job_id: uuidOrNull(ctx.jobId),
        execution: ctx.attempt,
        // Zegar workera dla startu i końca: wiersz bez wyniku (zapis końca padł)
        // nie dostaje znacznika późniejszego niż jego koniec.
        started_at: new Date().toISOString(),
        ksef_environment: identity.environment,
        worker_sha: workerRevision(),
      },
      ctx.logger,
      timeoutMs,
    );
    await writer.start();

    let stage: SendAttemptStage = 'start';
    const startedAt = Date.now();
    const step: JobStep = {
      ...ctx.step,
      run: async (name, fn) => {
        const next = stageForStep(name);
        if (next && next !== stage) {
          stage = next;
          await writer.stage(stage);
        }
        return ctx.step.run(name, fn);
      },
    };

    try {
      const result = await handler(data, { ...ctx, step });
      const outcome = { status: 'succeeded' satisfies SendAttemptStatus, stage, result: sendAttemptResult(result) };
      await writer.finish(outcome);
      ctx.logger.info('ksef.send.attempt', {
        invoiceId: identity.invoiceId,
        sendAttemptId: identity.sendAttemptId,
        ...outcome,
        ms: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      // Opis porażki nie może zastąpić błędu runnera — ten zawsze wychodzi bez zmian.
      try {
        const failure = describeSendAttemptFailure(error, stage, readWaits(data));
        await writer.finish({ ...failure });
        ctx.logger.info('ksef.send.attempt', {
          invoiceId: identity.invoiceId,
          sendAttemptId: identity.sendAttemptId,
          status: failure.status,
          stage: failure.stage,
          code: failure.error_code,
          ms: Date.now() - startedAt,
        });
      } catch (ledgerError) {
        ctx.logger.warn('Dziennik prób wysyłki KSeF: opis porażki nieudany (wysyłka bez zmian)', {
          error: ledgerError instanceof Error ? ledgerError.message : String(ledgerError),
        });
      }
      throw error;
    }
  };
}

/**
 * Kod odmowy wysyłki PRZED kolejką — typ w czystym katalogu kodów
 * (`send-error-classes.ts`), żeby polityka operatora (komponent kliencki,
 * importowana także przez crony) nie sięgała do tego modułu.
 */
export type { SendRefusalCode };

/**
 * Odmowa wysyłki przed kolejką → wiersz `refused` / `enqueue`. Fail-open:
 * błąd zapisu kończy się ostrzeżeniem, odpowiedź dla klienta się nie zmienia.
 */
export async function recordSendRefusal(params: {
  tenantId: string;
  invoiceId: string;
  userId: string | null;
  code: SendRefusalCode;
  message: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const limit = deadline(LEDGER_TIMEOUT_MS);
  try {
    const { error } = await (await createAdminClient()).from('ksef_send_attempts').insert({
      tenant_id: params.tenantId,
      invoice_id: params.invoiceId,
      user_id: uuidOrNull(params.userId),
      ksef_environment: configuredKsefEnvironment(),
      status: 'refused' satisfies SendAttemptStatus,
      stage: 'enqueue' satisfies SendAttemptStage,
      error_code: params.code,
      error_class: sendErrorClassOf(params.code),
      error_message: sendAttemptMessage(params.message),
      retryable: false,
      started_at: now,
      finished_at: now,
    }).abortSignal(limit.signal);
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn('[ksef.send-attempts] zapis odmowy przed kolejką nieudany', {
      invoiceId: params.invoiceId,
      code: params.code,
      error: e instanceof Error ? e.message : String(e),
    });
    Sentry.captureMessage('KSeF: dziennik prób wysyłki — zapis odmowy nieudany', {
      level: 'warning',
      tags: { area: 'ksef.send-attempts', op: 'refusal' },
      extra: { invoiceId: params.invoiceId, code: params.code },
    });
  } finally {
    limit.clear();
  }
}
