// Domyślny zestaw: wyłącznie lokalne testy i atrapy usług.
// Nie ładujemy .env.local ani innych plików ze środowiskiem aplikacji.
// Testy RLS mają osobny config, setup i jawne zmienne RLS_TEST_SUPABASE_*.
import { afterAll, afterEach } from 'vitest';
import { sprawdzBlokadeSieci, zainstalujBlokadeSieci } from './helpers/blokada-sieci';

// TST-SIEC: żaden test nie wychodzi do prawdziwej sieci (fetch, node:http,
// node:https, gniazda TCP/TLS poza 127.0.0.1, localhost i ::1). Próba pada od
// razu, a połknięta przez kod pod testem i tak oblewa test w afterEach.
// Opis, wyjątki i flaga VITEST_PRAWDZIWA_SIEC: tests/helpers/blokada-sieci.ts.
if (zainstalujBlokadeSieci()) {
  afterEach(() => sprawdzBlokadeSieci());
  // Próby z beforeAll/afterAll i spóźnione po ostatnim teście pliku.
  afterAll(() => sprawdzBlokadeSieci());
}
