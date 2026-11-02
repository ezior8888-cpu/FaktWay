import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

loadEnv({ path: resolve(process.cwd(), '.env.local') });

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const IS_CI = Boolean(process.env.CI);

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
      dependencies: ['setup'],
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      dependencies: ['setup'],
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      dependencies: ['setup'],
    },

    {
      name: 'mobile-iphone',
      use: { ...devices['iPhone 14'] },
      dependencies: ['setup'],
    },
    {
      name: 'mobile-pixel',
      use: { ...devices['Pixel 7'] },
      dependencies: ['setup'],
    },
  ],

  webServer: process.env.E2E_SKIP_WEBSERVER
    ? undefined
    : {
        command: `pnpm dev --port ${PORT}`,
        url: BASE_URL,
        reuseExistingServer: !IS_CI,
        timeout: 180_000,
        stdout: 'ignore',
        stderr: 'pipe',
        env: {
          NODE_ENV: 'test',
          KSEF_ENV: 'test',
          E2E_MOCK_KSEF: '1',
          E2E_MOCK_ANTHROPIC: '1',
          E2E_MOCK_RESEND: '1',
          E2E_MOCK_GUS: '1',
        },
      },
});
