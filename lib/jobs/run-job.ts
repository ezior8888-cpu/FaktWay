/**
 * Obsługa paczki jobów jednej kolejki: walidacja, retry (parytet z Inngest),
 * onExhausted. Wydzielone z `worker.ts`, żeby dało się to przetestować bez
 * startu workera.
 *
 * Każdy job paczki rozliczany jest osobno (`perJobResults` w pg-boss, AUD-35).
 * Dawniej błąd zaplanowania ponowienia (np. chwilowa awaria bazy) wychodził
 * z handlera i oblewał CAŁĄ paczkę — do 25 jobów bez retry i bez onExhausted.
 * Teraz oblewa tylko ten jeden job, a ponowi go pg-boss (retry kolejki,
 * `QUEUE_POLICY` w `boss.ts`).
 */

import type { Job, JobResult } from 'pg-boss';

import { startBoss } from './boss';
import { createJobLogger } from './logger';
import { retryPolicyFor, type JobDefinition } from './registry';
import { ATTEMPT_KEY, decideRetry, readAttempt, readWaits, WAITS_KEY } from './retry';
import { recordJobRun } from './run-log';
import { reportExhaustedJob } from './sentry';
import { createJobStep } from './step-shim';

export function wrapHandler(def: JobDefinition<never>) {
  const policy = retryPolicyFor(def);

  return async (jobs: Job<object>[]): Promise<JobResult[]> => {
    const results: JobResult[] = [];
    for (const job of jobs) {
      results.push(await runOne(def, policy, job));
    }
    return results;
  };
}

async function runOne(
  def: JobDefinition<never>,
  policy: ReturnType<typeof retryPolicyFor>,
  job: Job<object>,
): Promise<JobResult> {
  const attempt = readAttempt(job.data);
  const waits = readWaits(job.data);
  const jobLog = createJobLogger(`${def.queue}#${job.id.slice(0, 8)}`);
  const completed: JobResult = { id: job.id, status: 'completed' };

  // Walidacja payloadu na granicy (bez kluczy technicznych __attempt/__waits).
  let data: unknown = job.data;
  if (def.schema) {
    const cleaned = { ...(job.data as Record<string, unknown>) };
    delete cleaned[ATTEMPT_KEY];
    delete cleaned[WAITS_KEY];
    const parsed = def.schema.safeParse(cleaned);
    if (!parsed.success) {
      jobLog.error('payload nie przeszedł walidacji — onExhausted', {
        issues: parsed.error.issues.slice(0, 3),
      });
      await def.onExhausted?.(
        new Error(`Niepoprawny payload: ${parsed.error.message}`),
        job.data as never,
        { step: createJobStep(jobLog), logger: jobLog, attempt, jobId: job.id },
      );
      return completed;
    }
    data = parsed.data;
  }

  const startedAt = Date.now();
  try {
    await def.handler(data as never, {
      step: createJobStep(jobLog),
      logger: jobLog,
      attempt,
      jobId: job.id,
    });
    await recordJobRun({ queue: def.queue, runId: job.id, status: 'succeeded', durationMs: Date.now() - startedAt });
    return completed;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await recordJobRun({ queue: def.queue, runId: job.id, status: 'failed', durationMs: Date.now() - startedAt, error });
    const decision = decideRetry(error, attempt, policy, waits);

    if (decision.action === 'retry') {
      jobLog.warn(
        decision.nextAttempt === attempt
          ? `próba ${attempt + 1} czeka (odczekanie ${decision.nextWaits}) — ponownie za ${decision.delayMs}ms`
          : `próba ${attempt + 1} padła — retry za ${decision.delayMs}ms`,
        error,
      );
      try {
        const boss = await startBoss();
        await boss.send(
          def.queue,
          {
            ...(job.data as object),
            [ATTEMPT_KEY]: decision.nextAttempt,
            [WAITS_KEY]: decision.nextWaits,
          },
          {
            startAfter: Math.ceil(decision.delayMs / 1000),
            // Bez grupy ponowienie omijało limit per firma/NIP.
            ...(job.groupId ? { group: { id: job.groupId } } : {}),
          },
        );
        return completed;
      } catch (sendErr) {
        jobLog.error('nie udało się zaplanować ponowienia — job wraca do pg-boss', sendErr);
        return { id: job.id, status: 'failed', output: { error: 'retry-schedule-failed' } };
      }
    }

    jobLog.error(`wyczerpane próby (${decision.reason})`, error);
    reportExhaustedJob(def.queue, error, decision.reason);
    try {
      await def.onExhausted?.(error, data as never, {
        step: createJobStep(jobLog),
        logger: jobLog,
        attempt,
        jobId: job.id,
      });
    } catch (exhaustErr) {
      jobLog.error('onExhausted rzucił błąd', exhaustErr);
    }
    // Job kończy się jako "obsłużony" — decyzja co dalej należała do
    // onExhausted (parytet z Inngest).
    return completed;
  }
}
