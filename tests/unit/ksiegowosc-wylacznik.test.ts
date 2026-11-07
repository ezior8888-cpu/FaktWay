import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { GLOBAL_FLAGS } from '@/lib/feature-flags/global-flags';
import {
  czyKsiegowoscWlaczona,
  czytajFlageFirmy,
  rozstrzygnij,
  statusObszaru,
  type ObszarModulu,
} from '@/lib/ksiegowosc/wylacznik';

/**
 * Wyłącznik modułu księgowości (K1, D10): globalny stop, blokada w kodzie,
 * włączenie dla firmy. Każda kolejna warstwa może tylko zabrać.
 */

/** Od K2 kod puszcza `ustawienia`, od K3 `ewidencja`, od K4 `ten_miesiac`; reszta czeka na swoje kroki. */
const ZABLOKOWANE: ObszarModulu[] = ['terminy', 'vat', 'wysylka_jpk', 'kpir'];
const WLACZONY = { wlaczony: true } as const;

/** Atrapa łańcucha `from().select().eq().maybeSingle()` z jedną odpowiedzią. */
function klient(odpowiedz: { data: unknown; error: { code?: string; message: string } | null }) {
  const maybeSingle = vi.fn().mockResolvedValue(odpowiedz);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from } as unknown as SupabaseClient, from, select, eq };
}

describe('blokada w kodzie', () => {
  it('ustawienia: od K2 puszczone w kodzie, decyduje flaga firmy', () => {
    expect(statusObszaru('ustawienia').wlaczony).toBe(true);
  });

  it('ewidencja: od K3 puszczona w kodzie, decyduje flaga firmy', () => {
    expect(statusObszaru('ewidencja').wlaczony).toBe(true);
  });

  it('ten_miesiac: od K4 puszczony w kodzie, decyduje flaga firmy', () => {
    expect(statusObszaru('ten_miesiac').wlaczony).toBe(true);
  });

  it.each(ZABLOKOWANE)('%s: wyłączony w kodzie, z notatką', (obszar) => {
    const status = statusObszaru(obszar);
    expect(status.wlaczony).toBe(false);
    expect(status.notatka?.length ?? 0).toBeGreaterThan(10);
  });

  it('wysyłka JPK czeka na prawnika (D9), a nie tylko na kod', () => {
    expect(statusObszaru('wysylka_jpk').powod).toBe('prawnik');
  });

  it('flaga killKsiegowosc jest na liście flag globalnych', () => {
    expect(GLOBAL_FLAGS).toContain('killKsiegowosc');
  });
});

describe('kolejność warstw', () => {
  it('globalny stop wygrywa ze wszystkim', () => {
    expect(rozstrzygnij({ globalnyStop: true, kod: WLACZONY, firmaWlaczona: true })).toMatchObject({
      wlaczony: false,
      rozstrzygnela: 'globalny_stop',
    });
  });

  it('wpis firmy NIE odwraca blokady w kodzie', () => {
    expect(
      rozstrzygnij({ globalnyStop: false, kod: { wlaczony: false, notatka: 'K2' }, firmaWlaczona: true }),
    ).toMatchObject({ wlaczony: false, rozstrzygnela: 'blokada_w_kodzie', notatka: 'K2' });
  });

  it('firma poza pilotażem nie widzi modułu, firma w pilotażu widzi', () => {
    expect(rozstrzygnij({ globalnyStop: false, kod: WLACZONY, firmaWlaczona: false })).toMatchObject({
      wlaczony: false,
      rozstrzygnela: 'firma',
    });
    expect(rozstrzygnij({ globalnyStop: false, kod: WLACZONY, firmaWlaczona: true })).toMatchObject({
      wlaczony: true,
      rozstrzygnela: 'firma',
    });
  });
});

describe('odczyt', () => {
  it('obszar zablokowany w kodzie nie pyta ani bazy, ani flagi globalnej', async () => {
    const { client, from } = klient({ data: { ksiegowosc_enabled: true }, error: null });
    const globalny = vi.fn().mockResolvedValue(false);
    const werdykt = await czyKsiegowoscWlaczona(client, 'firma-1', 'terminy', globalny);
    expect(werdykt).toMatchObject({ wlaczony: false, rozstrzygnela: 'blokada_w_kodzie' });
    expect(from).not.toHaveBeenCalled();
    expect(globalny).not.toHaveBeenCalled();
  });

  it('flaga firmy: wiersz z true, brak wiersza, brak kolumny przed 00165', async () => {
    const tak = klient({ data: { ksiegowosc_enabled: true }, error: null });
    expect(await czytajFlageFirmy(tak.client, 'firma-1')).toBe(true);
    expect(tak.from).toHaveBeenCalledWith('tenant_feature_flags');
    expect(tak.select).toHaveBeenCalledWith('ksiegowosc_enabled');
    expect(tak.eq).toHaveBeenCalledWith('tenant_id', 'firma-1');

    expect(await czytajFlageFirmy(klient({ data: null, error: null }).client, 'firma-1')).toBe(false);
    const przedMigracja = klient({ data: null, error: { code: '42703', message: 'column does not exist' } });
    expect(await czytajFlageFirmy(przedMigracja.client, 'firma-1')).toBe(false);
  });

  it('ustawienia: globalny stop, firma poza pilotażem, firma w pilotażu', async () => {
    const wPilotazu = klient({ data: { ksiegowosc_enabled: true }, error: null });
    expect(await czyKsiegowoscWlaczona(wPilotazu.client, 'firma-1', 'ustawienia', async () => true)).toMatchObject({
      wlaczony: false,
      rozstrzygnela: 'globalny_stop',
    });
    expect(wPilotazu.from).not.toHaveBeenCalled();
    expect(await czyKsiegowoscWlaczona(wPilotazu.client, 'firma-1', 'ustawienia', async () => false)).toMatchObject({
      wlaczony: true,
      rozstrzygnela: 'firma',
    });
    const poza = klient({ data: { ksiegowosc_enabled: false }, error: null });
    expect(await czyKsiegowoscWlaczona(poza.client, 'firma-1', 'ustawienia', async () => false)).toMatchObject({
      wlaczony: false,
      rozstrzygnela: 'firma',
    });
  });

  it('inny błąd odczytu rzuca: „nie wiem” to nie „nie”', async () => {
    const awaria = klient({ data: null, error: { code: '57014', message: 'timeout' } });
    await expect(czytajFlageFirmy(awaria.client, 'firma-1')).rejects.toThrow('wyłącznika księgowości');
  });
});
