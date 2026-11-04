import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AUD-115 (decyzja I7): ~5 tys. linii agenta FLO nie ma importera w kodzie
 * produkcyjnym — m.in. `llm.ts` z bezpiecznikiem kosztowym, `weekly-review.ts`
 * i funkcje z `lib/flo/functions/`. Wyglądały na działające. Każdy taki moduł
 * ma teraz na początku znacznik NIEAKTYWNE, a ten test pilnuje dwóch rzeczy:
 * moduł ze znacznikiem naprawdę jest nieosiągalny z kodu produkcyjnego,
 * a lista oznaczonych jest kompletna. Podpięcie modułu = zdjęcie znacznika
 * (inaczej test padnie) i przegląd przed włączeniem.
 *
 * S14 (rewizja 03.10.2026): `lib/flo/functions/index.ts` i
 * `payment-chase-handler.ts` są AKTYWNE — worker (`flo-tick.ts`) i akcje
 * (`app/actions/flo.ts`) importują rejestr wykonawców dla skutku ubocznego
 * (`import '…'` bez `from`), czego dawny wzorzec nie widział. Zatwierdzona
 * karta ponaglenia realnie wysyła wiadomość. Znaczniki zdjęte, lista skrócona.
 *
 * 19.10.2026 (plan Finora E4, decyzja Bartosza „opcja A”): `vat-limit.ts`
 * AKTYWNY — czyste funkcje limitu zwolnienia z VAT (`vatLimitState`,
 * `proratedLimit`, `forecast`) liczą kartę „Limit zwolnienia z VAT” na
 * Pulpicie (`lib/dashboard/vat-limit.ts`). Propozycja agenta `tax.limit`
 * zostaje za flagą i bramką M12 (D7). Przegląd modułu w PR limitu VAT.
 */

const ROOT = process.cwd();
const MARKER = 'NIEAKTYWNE (AUD-115)';
const INACTIVE = [
  'lib/flo/functions/accountant-format.ts',
  'lib/flo/functions/contractor-check.ts',
  'lib/flo/functions/contractor-foreign.ts',
  'lib/flo/functions/feature-hint.ts',
  'lib/flo/functions/invoice-final.ts',
  'lib/flo/functions/milestone.ts',
  'lib/flo/functions/month-close.ts',
  'lib/flo/functions/payment-score.ts',
  'lib/flo/functions/rate-raise.ts',
  'lib/flo/functions/tax-deadline.ts',
  'lib/flo/functions/tax-relief.ts',
  'lib/flo/functions/tax-setaside.ts',
  'lib/flo/interest.ts',
  'lib/flo/llm.ts',
  'lib/flo/redact.ts',
  'lib/flo/weekly-review.ts',
];

function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) return name === 'node_modules' ? [] : walk(rel);
    return /\.(ts|tsx)$/.test(name) ? [rel] : [];
  });
}

const sources = ['app', 'lib', 'components'].flatMap(walk).concat(['proxy.ts', 'instrumentation.ts'].filter((f) => existsSync(join(ROOT, f))));
const known = new Set(sources);

function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? spec.slice(2) : spec.startsWith('.') ? relative(ROOT, normalize(join(ROOT, dirname(from), spec))) : null;
  if (base === null) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/** Moduły osiągalne z punktów wejścia produkcji: strony i akcje (`app/`), proxy, worker. */
function reachableFromProduction(): Set<string> {
  const imports = new Map<string, string[]>();
  for (const file of sources) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    // S14 (rewizja 03.10.2026): dawny wzorzec nie widział importów dla skutku
    // ubocznego (`import '@/lib/flo/functions'`) — przez to moduły realnie
    // podpięte pod worker i akcje uchodziły za nieaktywne.
    const specs = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
    imports.set(file, specs.map((s) => resolve(file, s)).filter((r): r is string => r !== null));
  }
  const roots = sources.filter((f) => f.startsWith('app/') || f === 'proxy.ts' || f === 'instrumentation.ts'
    || f === 'lib/jobs/worker.ts' || f.startsWith('lib/jobs/handlers/'));
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    stack.push(...(imports.get(file) ?? []));
  }
  return seen;
}

describe('nieaktywne moduły agenta FLO', () => {
  const reachable = reachableFromProduction();

  it.each(INACTIVE)('%s ma znacznik i nie ma importera produkcyjnego', (file) => {
    expect(readFileSync(join(ROOT, file), 'utf8').slice(0, 400)).toContain(MARKER);
    expect(reachable.has(file)).toBe(false);
  });

  it('żaden inny plik nie nosi znacznika', () => {
    const marked = sources.filter((f) => readFileSync(join(ROOT, f), 'utf8').slice(0, 400).includes(MARKER));
    expect(marked.sort()).toEqual([...INACTIVE].sort());
  });
});
