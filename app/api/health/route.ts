import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { getRedis, isRedisConfigured } from '@/lib/cache/redis';
import { resolveJobsBackend } from '@/lib/jobs/config';
import { createAdminClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/**
 * Health check endpoint.
 * Sprawdza: Supabase DB, environment variables.
 *
 * Wywołuje np. UptimeRobot co kilka minut.
 *
 * UWAGA: zwracamy WYŁĄCZNIE { status: 'ok' | 'fail' } per check.
 * Dawniej zwracaliśmy `error.message` z Postgres / Supabase, co dla
 * niezalogowanego użytkownika dawało enumerację schematu bazy
 * (np. „relation \"tenants\" does not exist"). Detale lecą do Sentry.
 */
export async function GET() {
  const checks: Record<string, { status: 'ok' | 'fail' }> = {};

  // Zlecenia jobów idą do pg-boss w naszym Postgresie — bez DATABASE_URL
  // aplikacja nie przekaże żadnej wysyłki do KSeF (Inngest odpięty, etap 10).
  const jobsBackend = resolveJobsBackend();
  const requiredEnvs = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'KSEF_CREDENTIALS_ENCRYPTION_KEY',
    'DATABASE_URL',
  ];
  const missing = requiredEnvs.filter((env) => !process.env[env]);
  if (!jobsBackend) missing.push('JOBS_BACKEND');
  checks.env = missing.length === 0 ? { status: 'ok' } : { status: 'fail' };
  if (missing.length > 0) {
    Sentry.captureMessage('health.env.missing', {
      level: 'error',
      extra: { missing },
    });
  }

  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from('tenants').select('id').limit(1);
    if (error) {
      Sentry.captureMessage('health.database.fail', {
        level: 'error',
        extra: { code: error.code, hint: error.hint, message: error.message },
      });
      checks.database = { status: 'fail' };
    } else {
      checks.database = { status: 'ok' };
    }
  } catch (error) {
    Sentry.captureException(error, { tags: { check: 'health.database' } });
    checks.database = { status: 'fail' };
  }

  // ROB-1: Redis check — informacyjny, NIE bramkuje ogólnego statusu.
  // Celowo: /api/health odpytuje healthcheck kontenera — HEALTHCHECK
  // z Dockerfile (5xx = unhealthy) i healthcheck Coolify, jeśli ma tę ścieżkę
  // w ustawieniach — więc 5xx przy awarii Redisa wycofałby wdrożenie albo
  // oznaczył zdrowy kontener jako unhealthy. Awaria Redisa to jednak NIE tylko
  // wolniejszy cache: limitery MFA i hasła są fail-closed, więc m.in. logowanie
  // z 2FA i operacje na haśle staną (lista w `lib/cache/redis.ts`). Kod HTTP
  // tego nie pokaże. Ślad: `informational.redis` ≠ ok w treści (skrypty ops
  // i monitor HTTP dziś jej nie czytają, patrzą na kod) oraz wyjątek w Sentry
  // z tagiem `check: health.redis`, gdy ping rzuci. Gdy nieskonfigurowany —
  // pomijamy (graceful).
  const informational: Record<string, { status: 'ok' | 'fail' | 'skipped' }> = {};
  if (isRedisConfigured()) {
    try {
      const pong = await getRedis().ping();
      informational.redis = { status: pong === 'PONG' ? 'ok' : 'fail' };
    } catch (error) {
      Sentry.captureException(error, { tags: { check: 'health.redis' } });
      informational.redis = { status: 'fail' };
    }
  } else {
    informational.redis = { status: 'skipped' };
  }

  // Status ogólny zależy WYŁĄCZNIE od checków krytycznych (env + database).
  const allOk = Object.values(checks).every((c) => c.status === 'ok');

  return NextResponse.json(
    {
      status: allOk ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      checks,
      informational,
    },
    { status: allOk ? 200 : 503 },
  );
}
