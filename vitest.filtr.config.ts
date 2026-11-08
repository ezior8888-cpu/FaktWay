import { defineConfig } from 'vitest/config';

import bazowa from './vitest.config';

// Testy żelaznego filtra (plan docs/koordynacja/PLAN-ZELAZNY-FILTR.md, B5.3
// i B5.4): mapa ryzyka, potem rejestr przepisów, niezmienniki, wyrocznia,
// przykłady urzędowe i złote pliki. Ten sam alias `@/` i ten sam jeden wątek
// co główna konfiguracja (Mac 16 GB). Do kroku F5 testy filtra idą też
// w głównym `pnpm vitest run`; w F5 workflow „Filtr: testy prawne” wywołuje
// tę konfigurację wprost, a główna przestaje je zbierać.
//
// Bez `mergeConfig`: łączy tablice, więc `include` zebrałby wszystkie testy.
export default defineConfig({
  ...bazowa,
  test: {
    ...bazowa.test,
    include: ['tests/filtr/**/*.test.ts'],
    exclude: [],
    // Noc (FILTR_PRZYPADKI=50000): jedna własność potrafi liczyć kilkadziesiąt sekund.
    testTimeout: Number(process.env.FILTR_PRZYPADKI ?? 300) > 1_000 ? 600_000 : 30_000,
  },
});
