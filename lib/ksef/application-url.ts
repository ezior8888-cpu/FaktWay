import type { KsefEnvironment } from '@/types/ksef';

/**
 * Adres Aplikacji Podatnika KSeF dla środowiska, do którego jest podłączony
 * FaktWay (`KSEF_ENV`). Certyfikat z innego środowiska nie zadziała, więc
 * kreator linkuje do właściwego. Adresy sprawdzone 02.11.2026: wszystkie trzy
 * odpowiadają (200), a prod to ten sam host, który podaje pomoc wFirma.
 */
export const KSEF_APPLICATION_URLS: Record<KsefEnvironment, string> = {
  production: 'https://ap.ksef.mf.gov.pl/',
  demo: 'https://ap-demo.ksef.mf.gov.pl/',
  test: 'https://ap-test.ksef.mf.gov.pl/',
};

export function ksefApplicationUrl(env: KsefEnvironment | null): string {
  return KSEF_APPLICATION_URLS[env ?? 'production'];
}

export const KSEF_ENVIRONMENT_LABELS: Record<KsefEnvironment, string> = {
  production: 'produkcyjne',
  demo: 'przedprodukcyjne (demo)',
  test: 'testowe',
};
