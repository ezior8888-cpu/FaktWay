/**
 * Cron job: ping KSeF API co 30s, zapis wyniku w Redis (Faza 23 sekcja 1).
 *
 * Inngest natywnie wspiera tylko cron o granularności 1 minuta (cron syntax).
 * Dla 30s używamy fanout: jedna iteracja crona robi dwa pingi z `step.sleep(30s)`
 * pomiędzy. Concurrency: 1 — żeby dwie iteracje nie nadpisywały sobie nawzajem
 * statusu w Redis.
 *
 * Zakaz wpływu na dane i logikę faktur: cron tylko sonduje KSeF
 * (`KSEF_HEALTH_PROBE_PATH` w `lib/ksef/health-check.ts` — KSeF 2.0 nie ma `/health`)
 * i zapisuje snapshot w Redis, a przy zmianie poziomu i co 5 min także wiersz
 * w `ksef_health_log` (`recordKsefPing`). Nigdy nie pisze do `invoices`,
 * `audit_logs` ani innych tabel. Sygnał dla UI baner + sygnał dla `submit-invoice`
 * (decyzja "czy spróbować vs offline queue").
 */

import * as Sentry from '@sentry/nextjs';

import type { JobContext } from '@/lib/jobs/registry';
import { checkKsefAvailability } from '@/lib/ksef/health-check';
import { recordKsefPing } from '@/lib/ksef/health-status';
import { fetchKsefOfficialStatus } from '@/lib/ksef/latarnia';
import type { KsefEnvironment } from '@/types/ksef';

function getCurrentEnv(): KsefEnvironment {
  const env = process.env.KSEF_ENV ?? 'test';
  if (env === 'production' || env === 'test' || env === 'demo') {
    return env;
  }
  return 'test';
}

async function pingAndRecord(env: KsefEnvironment): Promise<void> {
  // Sonda mierzy odpowiedź KSeF, Latarnia mówi, co ogłosiło MF. Oba pytania nie rzucają.
  const [result, official] = await Promise.all([checkKsefAvailability(env), fetchKsefOfficialStatus(env)]);
  await recordKsefPing(env, {
    available: result.available,
    responseTimeMs: result.responseTime ?? null,
    isMfOutage: result.isMfOutage ?? false,
    error: result.error ?? null,
    official,
  });

  // Sentry breadcrumb na każde wykrycie down — operator widzi w UI Sentry
  // historię degradacji bez explicit'nego eventu (zbyt szumno).
  if (!result.available) {
    Sentry.addBreadcrumb({
      category: 'ksef.health',
      level: 'warning',
      message: 'KSeF ping failed',
      data: {
        env,
        responseTimeMs: result.responseTime,
        error: result.error,
        isMfOutage: result.isMfOutage,
        officialStatus: official?.status ?? null,
      },
    });
  }
}

/**
 * Runner joba (worker pg-boss).
 * Rejestracja pg-boss: lib/jobs/handlers/package-a.ts (kolejka cron.ksef-health-check).
 */
export async function runKsefHealthCheck({ step }: JobContext) {
    const env = getCurrentEnv();

    // Pierwszy ping — natychmiast na starcie minuty.
    await step.run('ping-1', () => pingAndRecord(env));

    // Sleep 30s — Inngest serializuje step state, więc nawet jeśli runner
    // padnie w połowie, replay jest deterministyczny i nie zrobi się
    // ekstra pingu.
    await step.sleep('wait-30s', '30s');

    // Drugi ping — w połowie minuty.
    await step.run('ping-2', () => pingAndRecord(env));

    return { env, pingedAt: new Date().toISOString() };
}

