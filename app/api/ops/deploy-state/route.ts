import * as Sentry from '@sentry/nextjs';
import { NextResponse, type NextRequest } from 'next/server';

import { deployedCommit, isDeployStateAuthorized, readAppliedMigrations } from '@/lib/ops/deploy-state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Stan wdrożenia dla workflowu `obrazy.yml`: SHA obrazu i wgrane migracje.
 * Opis i zasady dostępu: `lib/ops/deploy-state.ts`.
 */
export async function GET(request: NextRequest) {
  if (!isDeployStateAuthorized(request.headers.get('authorization'), process.env.DEPLOY_STATE_TOKEN)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
  }

  try {
    const migrations = await readAppliedMigrations();
    return NextResponse.json({ commit: deployedCommit(), migrations }, { headers: NO_STORE });
  } catch (error) {
    Sentry.captureException(error, { tags: { check: 'ops.deploy-state' } });
    return NextResponse.json({ error: 'database' }, { status: 503, headers: NO_STORE });
  }
}
