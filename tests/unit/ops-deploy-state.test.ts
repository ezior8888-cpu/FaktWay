import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /api/ops/deploy-state` (plan usprawnień 3.1): stan wdrożenia dla
 * workflowu `obrazy.yml`. Bez tokenu w env i z błędnym tokenem trasa udaje,
 * że jej nie ma; błąd bazy to 503, nigdy pusta lista (pusta lista
 * przepuściłaby blokadę migracji).
 */

const mocks = vi.hoisted(() => ({
  executeSql: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.captureException }));
vi.mock('@/lib/jobs/boss', () => ({
  startBoss: async () => ({ getDb: () => ({ executeSql: mocks.executeSql }) }),
}));

const TOKEN = 'a'.repeat(40);
const SHA = '0123456789abcdef0123456789abcdef01234567';

async function call(authorization?: string) {
  const { GET } = await import('@/app/api/ops/deploy-state/route');
  const headers = authorization ? { authorization } : undefined;
  return GET(new NextRequest('https://faktflow.pl/api/ops/deploy-state', { headers }));
}

describe('GET /api/ops/deploy-state', () => {
  beforeEach(() => {
    mocks.executeSql.mockReset().mockResolvedValue({ rows: [{ version: '00166' }, { version: '00167' }] });
    mocks.captureException.mockReset();
    vi.stubEnv('DEPLOY_STATE_TOKEN', TOKEN);
    vi.stubEnv('APP_COMMIT_SHA', SHA);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('z dobrym tokenem: SHA obrazu i wgrane migracje, bez cache', async () => {
    const res = await call(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ commit: SHA, migrations: ['00166', '00167'] });
    expect(mocks.executeSql.mock.calls[0]?.[0]).toMatch(/FROM supabase_migrations\.schema_migrations/);
  });

  it.each([
    ['bez nagłówka', undefined],
    ['zły token', `Bearer ${'b'.repeat(40)}`],
    ['token bez Bearer', TOKEN],
  ])('%s → 404 bez dotykania bazy', async (_name, authorization) => {
    const res = await call(authorization);
    expect(res.status).toBe(404);
    expect(mocks.executeSql).not.toHaveBeenCalled();
  });

  it.each([
    ['bez tokenu w env', ''],
    ['za krótki token w env', 'krotki'],
  ])('%s trasa jest wyłączona', async (_name, envToken) => {
    vi.stubEnv('DEPLOY_STATE_TOKEN', envToken);
    const res = await call(`Bearer ${envToken}`);
    expect(res.status).toBe(404);
    expect(mocks.executeSql).not.toHaveBeenCalled();
  });

  it('błąd bazy → 503 i Sentry, nie pusta lista', async () => {
    mocks.executeSql.mockRejectedValue(new Error('permission denied for schema supabase_migrations'));
    const res = await call(`Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'database' });
    expect(mocks.captureException).toHaveBeenCalledOnce();
  });

  it('obraz bez APP_COMMIT_SHA (build w Coolify) → commit null', async () => {
    vi.stubEnv('APP_COMMIT_SHA', '');
    const res = await call(`Bearer ${TOKEN}`);
    expect((await res.json()).commit).toBeNull();
  });
});

describe('proxy', () => {
  it('trasa nie czyta sesji (token sprawdza sama), sąsiednie /api/ops zostają za bramką', async () => {
    const { isNoSessionPath, isPublicPath } = await import('@/lib/supabase/middleware');
    expect(isNoSessionPath('/api/ops/deploy-state')).toBe(true);
    expect(isPublicPath('/api/ops/inne')).toBe(false);
    expect(isNoSessionPath('/api/ops/deploy-state/x')).toBe(false);
  });
});
