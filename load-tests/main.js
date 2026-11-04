import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, standaloneOptions } from './config.js';
import { assertCredentials } from './lib/auth.js';
import { journey as dashboardJourney } from './scenarios/dashboard-viewer.js';
import { journey as invoiceJourney } from './scenarios/invoice-issuer.js';
import { journey as ocrJourney } from './scenarios/ocr-scanner.js';
import { journey as bulkJourney } from './scenarios/bulk-importer.js';

// Orkiestrator obciążenia Fazy 34 — uruchamia 4 scenariusze user-journey
// w jednym, realistycznym miksie. Liczba równoległych VU = cel profilu
// (`-e PROFILE=target` → 1000 użytkowników), więc test wprost odwzorowuje
// "N concurrent users" z Definition of Done.
//
//   k6 run load-tests/main.js -e PROFILE=target \
//     -e BASE_URL=https://test.faktway.pl \
//     -e LOAD_TEST_PASSWORD=... -e TURNSTILE_BYPASS_TOKEN=...

export const options = standaloneOptions();

export function setup() {
  assertCredentials();

  const health = http.get(`${BASE_URL}/api/health`, { tags: { name: 'setup_health' } });
  const ok = check(health, {
    'setup: health 2xx': (r) => r.status >= 200 && r.status < 300,
  });
  if (!ok) {
    throw new Error(
      `Serwer pod ${BASE_URL} nie odpowiada na /api/health — uruchom pnpm dev lub sprawdź BASE_URL`,
    );
  }
}

// Rozkład ruchu — większość użytkowników przegląda dashboard, część wystawia
// faktury, mniejszość skanuje paragony lub importuje masowo. Suma wag = 100.
const MIX = [
  { weight: 60, run: dashboardJourney },
  { weight: 25, run: invoiceJourney },
  { weight: 10, run: ocrJourney },
  { weight: 5, run: bulkJourney },
];

export default function () {
  const roll = Math.random() * 100;
  let acc = 0;
  for (const entry of MIX) {
    acc += entry.weight;
    if (roll < acc) {
      entry.run();
      return;
    }
  }
  // Fallback (zaokrąglenia) — najczęstszy scenariusz.
  MIX[0].run();
}
