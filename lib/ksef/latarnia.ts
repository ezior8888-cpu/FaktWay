/**
 * Latarnia: publiczne API MF o stanie KSeF, bez autoryzacji (CIRFMF/ksef-latarnia).
 * Publikuje przerwy i awarie, o których mowa w art. 106ne ustawy o VAT.
 *
 * Nasza sonda (`health-check.ts`) mierzy, czy KSeF odpowiada. Tylko Latarnia mówi, czy
 * MF ogłosiło awarię, a od tego zależą tryb prawny i termin dosłania faktur.
 *
 * Fail-open: brak odpowiedzi to brak wiedzy (`null`), nigdy wyjątek ani „awaria”.
 */

import { z } from 'zod';

import type { KsefEnvironment } from '@/types/ksef';

const LATARNIA_URLS: Partial<Record<KsefEnvironment, string>> = {
  production: 'https://api-latarnia.ksef.mf.gov.pl',
  test: 'https://api-latarnia-test.ksef.mf.gov.pl',
};

const TIMEOUT_MS = 5000;

const statusSchema = z.object({
  status: z.enum(['AVAILABLE', 'MAINTENANCE', 'FAILURE', 'TOTAL_FAILURE']),
  messages: z
    .array(z.object({ category: z.string(), end: z.string().nullish() }))
    .nullish(),
});

export type KsefOfficialStatusCode = z.infer<typeof statusSchema>['status'];

export interface KsefOfficialStatus {
  status: KsefOfficialStatusCode;
  /** Koniec z komunikatu tej samej kategorii; `null`, gdy MF go nie podało. */
  end: string | null;
}

export async function fetchKsefOfficialStatus(env: KsefEnvironment): Promise<KsefOfficialStatus | null> {
  const baseUrl = LATARNIA_URLS[env];
  if (!baseUrl) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/status`, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      redirect: 'error',
    });
    if (!response.ok) return null;
    const parsed = statusSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    const { status, messages } = parsed.data;
    const end = messages?.find((message) => message.category === status)?.end ?? null;
    return { status, end };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
