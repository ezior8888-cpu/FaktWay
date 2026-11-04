/**
 * Rejestr handlerów workera. Paczki A-D (Etapy 3-6 planu) rejestrują tu
 * swoje joby; worker uruchamia TYLKO zarejestrowane kolejki i TYLKO ich
 * crony — dzięki temu częściowy stan migracji jest bezpieczny.
 */

import type { ZodType } from 'zod';

import type { JobLogger } from './logger';
import type { JobStep } from './step-shim';
import { defaultRetryDelayMs, type RetryPolicy } from './retry';

export interface JobContext {
  step: JobStep;
  logger: JobLogger;
  /** 0-based numer wykonania (parytet z `attempt` w Inngest). */
  attempt: number;
  /**
   * Id joba pg-boss tego wykonania (= `inngest_run_log.run_id`). Każde
   * ponowienie to nowy job, więc nowe id. Brak poza workerem (testy, skrypty).
   */
  jobId?: string;
}

export interface JobDefinition<TData = unknown> {
  /** Nazwa kolejki (z lib/jobs/queues.ts — eventowa albo cron.*). */
  queue: string;
  /** Walidacja payloadu na granicy kolejki (parytet: zodEvent safeParse). */
  schema?: ZodType<TData>;
  /** Liczba PONOWNYCH prób (Inngest `retries`). Default 0 = bez retry. */
  maxRetries?: number;
  /** Custom schedule opóźnień (default: defaultRetryDelayMs). */
  getDelayMs?: (attempt: number) => number;
  /**
   * Odpowiednik Inngest `onFailure` — po wyczerpaniu prób / NonRetriable.
   * Dostaje pełny kontekst, bo część handlerów robi jeszcze realną pracę
   * (submit-invoice: parkowanie w Offline24, audyt, emisja eventu).
   */
  onExhausted?: (
    error: Error,
    data: TData,
    ctx: JobContext,
  ) => Promise<unknown>;
  /** pg-boss work: ile jobów naraz (globalna równoległość kolejki). Default 1. */
  batchSize?: number;
  /**
   * pg-boss 12: ilu workerów pobiera z kolejki naraz w tym procesie.
   * Default 1 = kolejka szeregowa dla wszystkich firm (AUD-36).
   */
  localConcurrency?: number;
  /** pg-boss 12: limit równoległości per grupa (np. per tenant). */
  groupConcurrency?: number;
  handler: (data: TData, ctx: JobContext) => Promise<unknown>;
}

const registry = new Map<string, JobDefinition<never>>();

export function registerJob<TData>(def: JobDefinition<TData>): void {
  if (registry.has(def.queue)) {
    throw new Error(`Podwójna rejestracja kolejki: ${def.queue}`);
  }
  // Cast przez unknown: rejestr przechowuje definicje z wymazanym typem danych
  // (schema/handler są kowariantno-kontrawariantne — bezpieczne, bo worker
  // ZAWSZE waliduje payload schematem przed wywołaniem handlera).
  registry.set(def.queue, def as unknown as JobDefinition<never>);
}

export function getRegisteredJobs(): JobDefinition<never>[] {
  return [...registry.values()];
}

export function retryPolicyFor(def: JobDefinition<never>): RetryPolicy {
  return {
    maxRetries: def.maxRetries ?? 0,
    getDelayMs: def.getDelayMs ?? defaultRetryDelayMs,
  };
}
