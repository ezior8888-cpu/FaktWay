import { afterEach, describe, expect, it, vi } from 'vitest';

import { getJobsSchema, getWorkerCronAllowlist } from '@/lib/jobs/config';

/**
 * Test obciążenia skrzynki (`load-tests/ksef-inbox/`) uruchamia prawdziwy worker
 * na wspólnej lokalnej bazie, więc potrzebuje własnej kolejki i jednego crona.
 * Na produkcji żadna z tych zmiennych nie może zadziałać: worker bez cronów albo
 * z kolejką w innym schemacie zatrzymałby wysyłkę faktur bez błędu.
 */

afterEach(() => vi.unstubAllEnvs());

describe('schemat pg-boss', () => {
  it('domyślnie zawsze pgboss', () => {
    expect(getJobsSchema({})).toBe('pgboss');
    expect(getJobsSchema({ JOBS_PGBOSS_SCHEMA: '  ' })).toBe('pgboss');
  });

  it('poza produkcją osobny schemat z prefiksem', () => {
    expect(getJobsSchema({ JOBS_PGBOSS_SCHEMA: 'pgboss_load_abc1', NODE_ENV: 'test' })).toBe('pgboss_load_abc1');
  });

  it.each(['public', 'pgboss', 'pgboss_"; DROP', 'PGBOSS_X', 'pgboss_'])('odrzuca nazwę %s', (name) => {
    expect(() => getJobsSchema({ JOBS_PGBOSS_SCHEMA: name, NODE_ENV: 'test' })).toThrow('tylko dla testów');
  });

  it('build produkcyjny odrzuca zmienną, także bez znacznika środowiska', () => {
    expect(() => getJobsSchema({ JOBS_PGBOSS_SCHEMA: 'pgboss_load_x', NODE_ENV: 'production' })).toThrow('tylko dla testów');
  });

  it('znacznik produkcji odrzuca zmienną przy każdym NODE_ENV', () => {
    vi.stubEnv('APP_ENV', 'production');
    expect(() => getJobsSchema({ JOBS_PGBOSS_SCHEMA: 'pgboss_load_x', NODE_ENV: 'test' })).toThrow('tylko dla testów');
  });
});

describe('lista cronów workera', () => {
  it('domyślnie wszystkie crony', () => {
    expect(getWorkerCronAllowlist({})).toBeNull();
  });

  it('poza produkcją tylko wskazane', () => {
    expect(getWorkerCronAllowlist({ WORKER_ONLY_CRONS: 'cron.inbox-polling, cron.x', NODE_ENV: 'test' }))
      .toEqual(new Set(['cron.inbox-polling', 'cron.x']));
  });

  it('na produkcji zmienna kończy się błędem startu, nie cichym wyłączeniem cronów', () => {
    expect(() => getWorkerCronAllowlist({ WORKER_ONLY_CRONS: 'cron.inbox-polling', NODE_ENV: 'production' })).toThrow('tylko dla testów');
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
    expect(() => getWorkerCronAllowlist({ WORKER_ONLY_CRONS: 'cron.inbox-polling', NODE_ENV: 'test' })).toThrow('tylko dla testów');
  });
});
