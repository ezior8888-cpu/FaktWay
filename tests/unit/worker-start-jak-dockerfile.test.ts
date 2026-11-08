import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RUN-01: worker startował z globalnym `--conditions=react-server`, żeby
 * `import 'server-only'` nie rzucał. Ten warunek przełączał też `react-dom/server`
 * na wersję, która rzuca przy imporcie, więc każdy e-mail z szablonu React
 * renderowany w workerze padał. Vitest tego nie widział: ma własny stub
 * `server-only` i nie ustawia warunków Node.
 *
 * Ten test uruchamia sondę w osobnym procesie Node z TYMI SAMYMI flagami co CMD
 * etapu `worker` w Dockerfile: ładuje handlery jobów i renderuje szablony maili.
 */

const root = process.cwd();
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
const workerStage = dockerfile.split(/^FROM /m).find((stage) => /^\S+ AS worker\b/.test(stage));
const cmdLine = workerStage?.match(/^CMD (\[.*\])$/m)?.[1];
const cmd: string[] = cmdLine ? JSON.parse(cmdLine) : [];
const ENTRY = 'lib/jobs/worker.ts';

/** Flagi Node z CMD workera, bez `node` i bez pliku wejściowego. */
const nodeFlags = cmd.slice(1, cmd.indexOf(ENTRY));

describe('worker uruchamiany jak w Dockerfile', () => {
  it('CMD etapu worker to node z flagami i lib/jobs/worker.ts', () => {
    expect(cmd[0]).toBe('node');
    expect(cmd.at(-1)).toBe(ENTRY);
    expect(nodeFlags).toContain('tsx');
  });

  it('pnpm worker:dev startuje z tymi samymi flagami co obraz', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['worker:dev']).toBe(cmd.join(' '));
  });

  it('nie włącza globalnie warunku react-server (łamie react-dom/server)', () => {
    expect(nodeFlags.join(' ')).not.toMatch(/react-server/);
  });

  it('ładuje wszystkie handlery i renderuje maile wysyłane przez worker', () => {
    const run = runNode([...nodeFlags, 'tests/fixtures/worker-sonda.ts']);
    expect(run.output).toMatch(/SONDA_OK handlery=\d+ maile=6/);
    expect(run).toMatchObject({ status: 0, signal: null });
  }, 180_000);

  it('prawdziwy lib/jobs/worker.ts ładuje cały graf modułów i dochodzi do main()', () => {
    // Nieobsługiwany backend zatrzymuje worker w main(), zanim połączy się z bazą.
    // Ten komunikat da się zobaczyć tylko wtedy, gdy wszystkie importy się udały.
    const run = runNode(cmd.slice(1), { JOBS_BACKEND: 'nieobslugiwany' });
    expect(run.output).toContain('JOBS_BACKEND ma nieobsługiwaną wartość');
    expect(run).toMatchObject({ status: 1, signal: null });
  }, 180_000);
});

/** Proces Node jak w obrazie workera: NODE_ENV=production, bez NODE_OPTIONS z vitest. */
function runNode(args: string[], env: Record<string, string> = {}) {
  try {
    const output = execFileSync(process.execPath, args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'production', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 170_000,
    });
    return { output, status: 0, signal: null };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; status?: number | null; signal?: string | null };
    return { output: `${failed.stdout ?? ''}${failed.stderr ?? ''}`, status: failed.status ?? null, signal: failed.signal ?? null };
  }
}
