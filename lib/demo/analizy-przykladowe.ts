// Atrapa bazy z danymi przykładowymi (poprawka Bartosza 21.10.2026: firma przed
// weryfikacją KSeF ma zobaczyć „pełną okazałość” aplikacji). Zestaw tabel żyje
// w `dane-przykladowe.ts` (PLAN-PRAWDZIWE-DANE E2: Pulpit, Przepływy i Analizy
// czytają go tymi samymi loaderami co prawdziwą bazę); ten moduł zostaje
// wejściem dla `tryb-danych.ts` i testów.
import type { PageContext } from '@/lib/supabase/page-context';
import type { KsefEnvironment } from '@/types/ksef';

import { danePrzykladowe, type OpcjePrzykladu } from './dane-przykladowe';
import { fakePostgrest } from './fake-postgrest';

export { DEMO_TENANT } from './dane-przykladowe';

/** Klient bazy z danymi przykładowymi; `env` = skonfigurowane środowisko KSeF (filtry loaderów). */
export function analizyDemoSupabase(
  now: Date,
  env: KsefEnvironment,
  opcje: OpcjePrzykladu = {},
): PageContext['supabase'] {
  return fakePostgrest(danePrzykladowe(now, env, opcje));
}
