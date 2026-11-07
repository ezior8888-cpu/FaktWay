import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(process.cwd(), '.env.local') });

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const IS_CI = Boolean(process.env.CI);
// Testy wizualne mają własne dwa projekty (niżej), reszta projektów ich nie
// uruchamia: każdy projekt to osobny komplet wzorcowych zrzutów.
const WIZUALNE = /wizualne\.spec\.ts/;
// Przebieg wizualny (`pnpm test:wizualne`, `--project=wizualne-*`) nie bierze
// cudzego serwera z portu: tylko serwer postawiony tutaj liczy limity prób
// w pamięci (env niżej), a obcy `pnpm dev` liczyłby logowania we wspólnym
// Redisie i po 5 przebiegach w 15 minut zablokował konto dev.
const WIZUALNE_W_PRZEBIEGU = process.argv.some((arg) => arg.includes('wizualne'));

export default defineConfig({
  testDir: './e2e',
  fullyParallel: !IS_CI,
  forbidOnly: IS_CI,
  retries: IS_CI ? 2 : 0,
  workers: IS_CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },

  reporter: IS_CI
    ? [
        ['github'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['json', { outputFile: 'playwright-report/results.json' }],
      ]
    : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],

  outputDir: 'test-results',

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: IS_CI ? 'retain-on-failure' : 'off',
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    testIdAttribute: 'data-testid',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },

    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: WIZUALNE,
      dependencies: ['setup'],
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testIgnore: WIZUALNE,
      dependencies: ['setup'],
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testIgnore: WIZUALNE,
      dependencies: ['setup'],
    },

    {
      name: 'mobile-iphone',
      use: { ...devices['iPhone 14'] },
      testIgnore: WIZUALNE,
      dependencies: ['setup'],
    },
    {
      name: 'mobile-pixel',
      use: { ...devices['Pixel 7'] },
      testIgnore: WIZUALNE,
      dependencies: ['setup'],
    },

    // Testy wizualne (`pnpm test:wizualne`): zamrożony wygląd Maca i telefonu.
    {
      name: 'wizualne-logowanie',
      testMatch: /wizualne-logowanie\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'wizualne-iphone',
      testMatch: WIZUALNE,
      use: { ...devices['iPhone 13'], contextOptions: { reducedMotion: 'reduce' } },
      dependencies: ['wizualne-logowanie'],
    },
    {
      name: 'wizualne-desktop',
      testMatch: WIZUALNE,
      dependencies: ['wizualne-logowanie'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        contextOptions: { reducedMotion: 'reduce' },
      },
    },
  ],

  webServer: process.env.E2E_SKIP_WEBSERVER
    ? undefined
    : {
        command: `pnpm dev --port ${PORT}`,
        url: BASE_URL,
        reuseExistingServer: !IS_CI && !WIZUALNE_W_PRZEBIEGU,
        timeout: 180_000,
        stdout: 'ignore',
        stderr: 'pipe',
        env: {
          NODE_ENV: 'test',
          KSEF_ENV: 'test',
          // Logowanie biometrią: RP ID i dozwolony origin bierzemy z tego adresu
          // (`lib/auth/passkey/config.ts`), a http działa tylko przy tym środowisku.
          NEXT_PUBLIC_APP_URL: BASE_URL,
          NEXT_PUBLIC_APP_ENV: 'development',
          E2E_MOCK_KSEF: '1',
          E2E_MOCK_ANTHROPIC: '1',
          E2E_MOCK_RESEND: '1',
          E2E_MOCK_GUS: '1',
          // Limity prób (np. logowania) w pamięci serwera testowego, nie we
          // wspólnym Redisie z `.env.local`: restart serwera je zeruje.
          UPSTASH_REDIS_REST_URL: '',
          UPSTASH_REDIS_REST_TOKEN: '',
        },
      },
});
