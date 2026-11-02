import { afterEach, describe, expect, it, vi } from 'vitest';
import localConfig from '../../vitest.config';
import rlsConfig from '../../vitest.rls.config';
import { getRlsTestEnvironment } from '../helpers/rls-environment';
import { createUserScopedClient } from '../helpers/tenant-client';

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@supabase/supabase-js', () => mocks);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

const testEnv = {
  RLS_TEST_SUPABASE_URL: 'http://127.0.0.1:54321',
  RLS_TEST_SUPABASE_ANON_KEY: 'test-anon-placeholder',
  RLS_TEST_SUPABASE_SERVICE_ROLE_KEY: 'test-service-placeholder',
  RLS_TEST_ALLOW_DESTRUCTIVE: 'isolated-local-database',
};

const applicationEnv = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://application.example.test',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'application-anon-placeholder',
  SUPABASE_SERVICE_ROLE_KEY: 'application-service-placeholder',
};

describe('separate RLS test configuration', () => {
  it('excludes RLS from the default run and disables automatic .env loading', () => {
    expect(localConfig.envDir).toBe(false);
    expect(localConfig.test?.exclude).toContain('tests/rls-isolation.test.ts');
    expect(localConfig.test?.exclude).toContain('tests/rls-uprawnienia.test.ts');
    expect(localConfig.test?.setupFiles).toEqual(['./tests/setup.ts']);
  });

  it('the explicit config runs only RLS and preserves server module aliases', () => {
    expect(rlsConfig.envDir).toBe(false);
    // Od 00103/00104 także testy uprawnień funkcji i ról (AUD-29/30/64).
    expect(rlsConfig.test?.include).toEqual([
      'tests/rls-isolation.test.ts',
      'tests/rls-uprawnienia.test.ts',
      // 00131: cykl życia faktury (RPC przejść, dowód kontaktu, strażnik).
      'tests/rls-cykl-faktury.test.ts',
      // PR 3 cyklu życia: RPC w jednej transakcji ze zleceniem pg-boss.
      'tests/rls-kolejkowanie-wysylki.test.ts',
      // 00132: wyzwalacze po zacieśnieniu — klient nigdy nie pisze ksef_status.
      'tests/rls-cykl-wyzwalacze.test.ts',
      // Sekcja 4a skryptu kontroli (zaległości Offline24) na schemacie po wszystkich migracjach.
      'tests/rls-kontrola-offline24.test.ts',
      // 00133 (K4): jedna otwarta korekta na fakturę pierwotną.
      'tests/rls-korekta-jedna-otwarta.test.ts',
      // 00137 (A4b): special_data — kształt, zapis jednorazowy, przejścia 00131.
      'tests/rls-dane-specjalne.test.ts',
      // 00148 (D-A4-1b-3 PR B): decyzja klienta przy cudzym 440, wycofany szkic, I5D.
      'tests/rls-decyzja-duplikatu.test.ts',
      // 00156 (D-A4-1b-3 PR C, dawniej rezerwacja 00149): zapis oryginału z oznaczeniem FaktWay, przegląd, oddanie, I5R/I3K.
      'tests/rls-zapis-oryginalu.test.ts',
      // 00156: procedura „Brak daty nadania” (I3K no_date) — skrypt SQL przez psql, jedna transakcja z audytem.
      'tests/rls-oryginal-data-nadania.test.ts',
      // 00150 (A5): dziennik prób wysyłki — tylko serwis, bez DELETE, nie jest dowodem kontaktu.
      'tests/rls-dziennik-prob-wysylki.test.ts',
      // Sekcja 12 skryptu kontroli (dziennik prób z 00150) liczy jak /admin/centrum/bledy.
      'tests/rls-kontrola-dziennik-prob.test.ts',
      // A5: procedura operatora dla faktury, która utknęła w wysyłce (I2/I1) — skrypt SQL przez psql.
      'tests/rls-zwolnij-utknieta-wysylke.test.ts',
      // 00152: faktura za abonament w obu nazwach produktu (FaktFlow, FaktWay).
      'tests/rls-faktura-abonamentu-faktway.test.ts',
      // Plan Finora E3: dzieci faktur (korekta, ROZ) przez prawdziwy PostgREST.
      'tests/rls-dzieci-faktur.test.ts',
      // Plan Finora E3 / C1: filtr płatności listy faktur (kilka or()) przez PostgREST.
      'tests/rls-lista-faktur-platnosc.test.ts',
      // 00153 (plan Finora E4, limit VAT): GRANT SELECT nowej kolumny tenants, CHECK, izolacja.
      'tests/rls-data-rozpoczecia.test.ts',
      // 00154 (plan Finora E9, N1): faktury cykliczne — izolacja firm, jeden okres, CHECK-i, SET NULL.
      'tests/rls-faktury-cykliczne.test.ts',
      // 00155 (synchronizacja historii KSeF, decyzja Bartosza 22.10.2026): izolacja,
      // CHECK-i, ksef_upo_expected i filtr osadzenia `invoices!inner` przez PostgREST.
      'tests/rls-historia-ksef.test.ts',
      // 00157 (plan skalowania, sesja 20): sprzątanie dzienników paczkami.
      'tests/rls-sprzatanie-dziennikow.test.ts',
    ]);
    expect(rlsConfig.test?.exclude).toEqual([]);
    expect(rlsConfig.test?.setupFiles).toEqual(['./tests/setup-rls.ts']);
    expect(rlsConfig.resolve?.alias).toEqual(localConfig.resolve?.alias);
  });

  it('never uses application database credentials as a fallback', () => {
    expect(() => getRlsTestEnvironment(applicationEnv)).toThrow(
      'RLS_TEST_SUPABASE_URL, RLS_TEST_SUPABASE_ANON_KEY, RLS_TEST_SUPABASE_SERVICE_ROLE_KEY',
    );
  });

  it('rejects each missing or whitespace-only explicit parameter', () => {
    for (const key of Object.keys(testEnv)) {
      expect(() => getRlsTestEnvironment({ ...testEnv, [key]: undefined })).toThrow(key);
      expect(() => getRlsTestEnvironment({ ...testEnv, [key]: '   ' })).toThrow(key);
    }
  });

  it.each(['true', '1', 'production', 'isolated-local-database '])(
    'rejects a non-matching destructive-test acknowledgement: %s',
    (acknowledgement) => {
      expect(() => getRlsTestEnvironment({
        ...testEnv,
        RLS_TEST_ALLOW_DESTRUCTIVE: acknowledgement,
      })).toThrow('RLS_TEST_ALLOW_DESTRUCTIVE');
    },
  );

  it.each(['http://127.0.0.1:54321', 'http://[::1]:54321'])(
    'accepts an acknowledged local test database with separate keys: %s',
    (url) => {
      expect(getRlsTestEnvironment({
        ...applicationEnv,
        ...testEnv,
        RLS_TEST_SUPABASE_URL: url,
      })).toEqual({
        url,
        anonKey: testEnv.RLS_TEST_SUPABASE_ANON_KEY,
        serviceRoleKey: testEnv.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY,
      });
    },
  );

  it.each([
    'https://production.example.test',
    'https://staging.example.test',
    'http://192.168.1.10:54321',
    'http://localhost:54321',
    'http://127.0.0.1.example.test:54321',
    'http://[::ffff:127.0.0.1]:54321',
  ])('rejects remote, DNS-based and unsupported targets even with acknowledgement: %s', (url) => {
    expect(() => getRlsTestEnvironment({
      ...testEnv,
      RLS_TEST_SUPABASE_URL: url,
    })).toThrow('numeryczny loopback');
  });

  it('rejects malformed or decorated URLs without reflecting credentials in errors', () => {
    for (const url of [
      'not-a-url',
      'file:///tmp/db',
      'https://user:secret@127.0.0.1:54321',
      'https://127.0.0.1:54321/?key=secret',
      'https://127.0.0.1:54321/#secret',
      'https://127.0.0.1:54321/proxy/secret',
    ]) {
      let message = '';
      try { getRlsTestEnvironment({ ...testEnv, RLS_TEST_SUPABASE_URL: url }); }
      catch (error) { message = (error as Error).message; }
      expect(message).toContain('RLS_TEST_SUPABASE_URL');
      expect(message).not.toContain('secret');
    }
  });

  it.each([
    'http://127.0.0.1:54321/',
    'https://127.0.0.1:54321/app-path',
    'http://localhost:54321',
    'http://[::1]:54321',
  ])('rejects the application target even through local URL variations: %s', (url) => {
    expect(() => getRlsTestEnvironment({
      ...testEnv,
      NEXT_PUBLIC_SUPABASE_URL: url,
    })).toThrow('pokrywa się z bazą aplikacji');
  });

  it('rejects an invalid application URL instead of skipping the comparison', () => {
    expect(() => getRlsTestEnvironment({
      ...testEnv,
      NEXT_PUBLIC_SUPABASE_URL: 'malformed-secret',
    })).toThrow('NEXT_PUBLIC_SUPABASE_URL ma niepoprawny format');
  });

  it.each([
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'RLS_TEST_SUPABASE_ANON_KEY'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'RLS_TEST_SUPABASE_SERVICE_ROLE_KEY'],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'RLS_TEST_SUPABASE_SERVICE_ROLE_KEY'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'RLS_TEST_SUPABASE_ANON_KEY'],
  ] as const)('rejects application credentials reused across %s and %s', (applicationKey, testKey) => {
    expect(() => getRlsTestEnvironment({
      ...applicationEnv,
      ...testEnv,
      [applicationKey]: `  ${testEnv[testKey]}  `,
    })).toThrow('Wymagane są osobne klucze testowe');
  });

  it('a missing RLS environment fails before a helper creates any Supabase client', async () => {
    for (const key of Object.keys(testEnv)) vi.stubEnv(key, undefined);
    for (const [key, value] of Object.entries(applicationEnv)) vi.stubEnv(key, value);
    await expect(createUserScopedClient('user-id')).rejects.toThrow('RLS_TEST_SUPABASE_URL');
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it.each([
    { RLS_TEST_ALLOW_DESTRUCTIVE: 'true' },
    { RLS_TEST_SUPABASE_URL: 'https://production.example.test' },
    { NEXT_PUBLIC_SUPABASE_URL: testEnv.RLS_TEST_SUPABASE_URL },
    { SUPABASE_SERVICE_ROLE_KEY: testEnv.RLS_TEST_SUPABASE_SERVICE_ROLE_KEY },
  ])('an unsafe configuration fails before a helper creates any Supabase client: %j', async (overrides) => {
    for (const [key, value] of Object.entries({ ...applicationEnv, ...testEnv, ...overrides })) {
      vi.stubEnv(key, value);
    }
    await expect(createUserScopedClient('user-id')).rejects.toThrow();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
