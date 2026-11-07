import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { test as setup } from '@playwright/test';

import { loginViaUI } from './helpers/auth';
import { devCredentials, isLocalBaseUrl, isLocalDatabase, SESJA_KONTA_DEV } from './helpers/konto-dev';

/**
 * Jedno logowanie konta dev na cały przebieg testów wizualnych (projekt
 * `wizualne-logowanie`). Logowanie ma limit 5 prób na 15 minut, więc testy
 * pulpitu i listy faktur biorą zapisaną sesję zamiast logować się same.
 */
setup('logowanie konta dev', async ({ page, baseURL }) => {
  setup.skip(
    !isLocalBaseUrl(baseURL) || !isLocalDatabase() || process.platform !== 'darwin',
    'Tylko lokalne konto dev (pnpm db:local) na Macu.',
  );
  const { email, password } = devCredentials();
  // Formularz wpisany przed hydratacją Reacta się zeruje; najpierw strona w spoczynku.
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await loginViaUI(page, email, password);
  mkdirSync(dirname(SESJA_KONTA_DEV), { recursive: true });
  await page.context().storageState({ path: SESJA_KONTA_DEV });
});
