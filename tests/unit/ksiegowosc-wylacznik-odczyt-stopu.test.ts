import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

/**
 * F11-B6 (przegląd wsteczny K1/K5, RP-WYL-01: „nie wiem” to nie „nie”):
 * domyślny odczyt globalnego stopu w `czyKsiegowoscWlaczona` szedł przez
 * `getGlobalFlag`, który przy awarii bazy albo Redisa zwraca „wyłączona”,
 * więc przy `killKsiegowosc = true` i chwilowym błędzie odczytu przypomnienia
 * z kwotami i tak wychodziły. Odczyt przed działaniem ma być rozstrzygający
 * (`getGlobalFlagForExecution`, jak FLO przed efektami): błąd rzuca.
 */
vi.mock('@/lib/feature-flags/global-flags', async (orig) => ({
  ...(await orig<typeof import('@/lib/feature-flags/global-flags')>()),
  // Tak zachowuje się `getGlobalFlag` przy awarii odczytu: flaga „wyłączona”.
  getGlobalFlag: async () => false,
  getGlobalFlagForExecution: async () => {
    throw new Error('Nie udało się sprawdzić wyłącznika funkcji');
  },
}));

const { czyKsiegowoscWlaczona } = await import('@/lib/ksiegowosc/wylacznik');

function klient(odpowiedz: { data: unknown; error: { code?: string; message: string } | null }) {
  const maybeSingle = vi.fn().mockResolvedValue(odpowiedz);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  return { from: vi.fn(() => ({ select })) } as unknown as SupabaseClient;
}

describe('F11-B6: globalny stop księgowości przy błędzie odczytu', () => {
  it('awaria odczytu flagi globalnej: odrzucenie, a nie „moduł działa” (przypomnienia nie wychodzą)', async () => {
    const firmaWPilotazu = klient({ data: { ksiegowosc_enabled: true }, error: null });
    await expect(czyKsiegowoscWlaczona(firmaWPilotazu, 'firma-1', 'terminy')).rejects.toThrow(/wyłącznika/);
  });
});
