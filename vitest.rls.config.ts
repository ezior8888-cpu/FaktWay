import { defineConfig } from 'vitest/config';
import localConfig from './vitest.config';

/** Jawne uruchomienie na osobnej bazie testowej; testy tworzą i usuwają dane. */
export default defineConfig({
  ...localConfig,
  test: {
    ...localConfig.test,
    include: [
      'tests/rls-isolation.test.ts',
      'tests/rls-uprawnienia.test.ts',
      'tests/rls-cykl-faktury.test.ts',
      'tests/rls-kolejkowanie-wysylki.test.ts',
      'tests/rls-cykl-wyzwalacze.test.ts',
      'tests/rls-kontrola-offline24.test.ts',
      'tests/rls-korekta-jedna-otwarta.test.ts',
      'tests/rls-dane-specjalne.test.ts',
      'tests/rls-decyzja-duplikatu.test.ts',
      'tests/rls-zapis-oryginalu.test.ts',
      'tests/rls-oryginal-data-nadania.test.ts',
      'tests/rls-dziennik-prob-wysylki.test.ts',
      'tests/rls-kontrola-dziennik-prob.test.ts',
      'tests/rls-zwolnij-utknieta-wysylke.test.ts',
      'tests/rls-faktura-abonamentu-faktway.test.ts',
      'tests/rls-dzieci-faktur.test.ts',
      'tests/rls-lista-faktur-platnosc.test.ts',
      'tests/rls-data-rozpoczecia.test.ts',
      'tests/rls-faktury-cykliczne.test.ts',
      // 00155 (synchronizacja historii KSeF, decyzja Bartosza 22.10.2026): izolacja,
      // CHECK-i, ksef_upo_expected i filtr osadzenia przez PostgREST.
      'tests/rls-historia-ksef.test.ts',
    ],
    exclude: [],
    setupFiles: ['./tests/setup-rls.ts'],
  },
});
