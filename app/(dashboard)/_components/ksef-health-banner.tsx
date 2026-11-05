import { getKsefHealthSnapshot, toPublicKsefHealth } from '@/lib/ksef/health-status';
import type { KsefEnvironment } from '@/types/ksef';

import { KsefHealthBannerClient } from './ksef-health-banner-client';

function getCurrentEnv(): KsefEnvironment {
  const env = process.env.KSEF_ENV ?? 'test';
  if (env === 'production' || env === 'test' || env === 'demo') {
    return env;
  }
  return 'test';
}

/**
 * Server Component renderowany w dashboard layout. Pobiera initial snapshot
 * z Redisa (zero JS dla pierwszego paint), client component bierze stąd
 * `initialSnapshot` i odświeża go przez `/api/ksef/health`, gdy karta jest
 * widoczna. Do przeglądarki idzie snapshot bez `error` (tekst dla operatora).
 *
 * Banner jest schowany przy `level === 'operational'` — przy zdrowym
 * KSeFie user nie widzi nic.
 */
export async function KsefHealthBanner() {
  const env = getCurrentEnv();
  const initialSnapshot = await getKsefHealthSnapshot(env);

  return (
    <KsefHealthBannerClient
      initial={initialSnapshot ? toPublicKsefHealth(initialSnapshot) : null}
    />
  );
}
