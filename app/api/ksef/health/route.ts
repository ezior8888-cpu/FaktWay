/**
 * GET /api/ksef/health — zwraca snapshot zdrowia KSeF API z Redis.
 *
 * Konsumowany przez baner KSeF w panelu (`ksef-health-banner-client.tsx`),
 * żeby user widział zmianę statusu bez odświeżania strony. Endpoint jest
 * publiczny: proxy przepuszcza go bez sesji i bez wywołań GoTrue
 * (`isNoSessionPath` w `lib/supabase/middleware.ts`). Stan infrastruktury MF
 * nie jest poufny; pole `error` (tekst dla operatora) nie wychodzi.
 *
 * Cache-Control: private, max-age=15 — karty jednej przeglądarki dzielą
 * odpowiedź. Tyle samo trwa pamięć w procesie (`getPublicKsefHealth`); Redis
 * daje snapshotowi 90 s TTL. Nie `public`: proxy pomija sesję tylko dla
 * dokładnej ścieżki, a alias `/api/ksef/health/` (next.config ma
 * `skipTrailingSlashRedirect`) trafia tu przez pełną bramkę i może nieść
 * odświeżone ciasteczko sesji — tego nie wolno przechować we wspólnym cache.
 */

import { NextResponse } from 'next/server';

import { getPublicKsefHealth } from '@/lib/ksef/health-status';
import type { KsefEnvironment } from '@/types/ksef';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CACHE_HEADERS = { 'Cache-Control': 'private, max-age=15' };

function getCurrentEnv(): KsefEnvironment {
  const env = process.env.KSEF_ENV ?? 'test';
  if (env === 'production' || env === 'test' || env === 'demo') {
    return env;
  }
  return 'test';
}

export async function GET() {
  const env = getCurrentEnv();
  const health = await getPublicKsefHealth(env);

  // null = Redis nieskonfigurowany / cron jeszcze nie pingnął — UI traktuje
  // jako "no banner", a my zwracamy defaultowy operational.
  if (!health) {
    return NextResponse.json(
      {
        level: 'operational',
        lastCheckedAt: null,
        responseTimeMs: null,
        consecutiveFailures: 0,
        isMfOutage: false,
        env,
        stale: true,
      },
      { headers: CACHE_HEADERS },
    );
  }

  return NextResponse.json({ ...health, stale: false }, { headers: CACHE_HEADERS });
}
