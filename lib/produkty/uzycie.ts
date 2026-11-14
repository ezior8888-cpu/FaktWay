/**
 * Licznik użyć produktu z katalogu przy zapisie faktury (plan kompletnej
 * aplikacji, krok 2.6; funkcja `product_usage_record` z migracji 00204).
 *
 * `products.use_count` i `last_used_at` ustalają kolejność podpowiedzi
 * produktów i blokują usunięcie produktu użytego na fakturach
 * (`deleteProductAction`). Do 00204 zwiększał je tylko import.
 *
 * Wołający przekazuje pozycje zapisanej faktury. Moduł wysyła pary nazwa +
 * jednostka bez powtórzeń, dokładnie tak, jak są w pozycjach. Który produkt
 * jest „ten sam” (wielkość liter, odstępy), rozstrzyga tylko baza, tymi
 * samymi wyrażeniami co unikalny klucz katalogu z 00186: aplikacja nie może
 * się z nią rozjechać, a para różniąca się tylko zapisem i tak liczy produkt
 * raz na wywołanie. Funkcja przyjmuje najwyżej 1000 par, więc faktura
 * z większą liczbą różnych pozycji idzie w kilku wywołaniach; ten sam produkt
 * zapisany na dwa sposoby w dwóch różnych paczkach doliczy się wtedy dwa
 * razy (nadmiar, nigdy brak).
 *
 * Błąd nigdy nie zatrzymuje zapisu faktury: brak funkcji przed wgraniem
 * 00204 (PGRST202), odmowa albo zerwane połączenie to tylko ostrzeżenie
 * w logu serwera (`[produkty] licznik użyć`). Faktura zostaje zapisana,
 * a licznik tego jednego zapisu przepada (to kolejność podpowiedzi i ochrona
 * przed usunięciem, nie dane faktury).
 *
 * Ponowienie: moduł niczego nie ponawia. Woła go zapis faktury raz, po udanym
 * zapisie pozycji; drugi zapis z tego samego otwarcia formularza baza
 * odrzuca wcześniej (`request_done`, 00199), więc nie dolicza drugi raz.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { logger } from '@/lib/observability/logger';

/** Najwyżej tyle par w jednym wywołaniu (granica funkcji w 00204). */
const PRODUCT_USAGE_BATCH = 1000;

export interface ProductUsagePair {
  name: string;
  unit: string;
}

/** Pary nazwa + jednostka bez powtórzeń (te same napisy), w kolejności pozycji. */
function productUsagePairs(lines: ReadonlyArray<ProductUsagePair>): ProductUsagePair[] {
  const seen = new Set<string>();
  const pairs: ProductUsagePair[] = [];
  for (const { name, unit } of lines) {
    const key = JSON.stringify([name, unit]);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ name, unit });
  }
  return pairs;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return [code, message].filter((part) => typeof part === 'string' && part !== '').join(' ');
  }
  return String(error);
}

/**
 * Zwiększa licznik użyć produktów z pozycji zapisanej faktury. Klient z sesji
 * (firma z nagłówka aktywnej firmy, RLS). Nigdy nie rzuca.
 */
export async function recordProductUsage(
  client: SupabaseClient,
  lines: ReadonlyArray<ProductUsagePair>,
): Promise<void> {
  const pairs = productUsagePairs(lines);
  try {
    for (let start = 0; start < pairs.length; start += PRODUCT_USAGE_BATCH) {
      const { error } = await client.rpc('product_usage_record', {
        p_lines: pairs.slice(start, start + PRODUCT_USAGE_BATCH),
      });
      if (error) {
        logger.warn('[produkty] licznik użyć:', errorText(error));
        return;
      }
    }
  } catch (error) {
    logger.warn('[produkty] licznik użyć:', errorText(error));
  }
}
