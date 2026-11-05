/**
 * Hak Node dla workera: `server-only` → pusty moduł, nic więcej (RUN-01).
 *
 * Moduły serwerowe mają `import 'server-only'`. Pakiet rzuca wyjątek, chyba że
 * działa pod warunkiem eksportu `react-server` (Next ustawia go sam w warstwie
 * serwera). Worker ustawiał ten warunek globalnie flagą `--conditions=react-server`,
 * ale wtedy także `react-dom/server` dostaje wersję, która rzuca przy imporcie,
 * i padał render każdego e-maila z szablonu React.
 *
 * Ten hak podmienia TYLKO specyfikator `server-only` na jego własny `empty.js`
 * (ten sam plik, który wybrałby warunek `react-server`). Pozostałe pakiety
 * rozwiązują się zwykłymi warunkami Node. Ładowany PRZED tsx:
 *
 *   node --import ./lib/jobs/server-only-hook.mjs --import tsx lib/jobs/worker.ts
 *
 * `registerHooks` działa w tym samym wątku i obejmuje zarówno `import`, jak
 * i `require` (tsx kompiluje lib/** do CommonJS). Wymaga Node ≥ 22.15.
 */
// Domyślny import, nie nazwany: na starszym Node brak eksportu `registerHooks`
// wywróciłby import nieczytelnym SyntaxError, zanim zadziała sprawdzenie niżej.
import nodeModule from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { createRequire, registerHooks } = nodeModule;
if (typeof registerHooks !== 'function') {
  throw new Error(`Worker wymaga Node >= 22.15 (module.registerHooks); jest ${process.version}.`);
}

const require = createRequire(import.meta.url);
// `server-only/empty.js` nie jest w `exports` pakietu, więc składamy ścieżkę
// obok wejścia głównego (samo rozwiązanie ścieżki nie wykonuje index.js).
const SERVER_ONLY_EMPTY = pathToFileURL(join(dirname(require.resolve('server-only')), 'empty.js')).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: SERVER_ONLY_EMPTY, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
