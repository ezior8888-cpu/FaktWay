import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Plan skalowania, sesja 23 (DBC-10): `scripts/ops/pojemnosc-db.sh` zbiera
 * odczyty pojemności db-1, app-1 i ops-1 jedną linią. Skrypt uruchamia
 * Bartosz na produkcji, więc musi być wyłącznie do odczytu i nie może
 * dociążać bazy w nieskończoność.
 */

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts/ops/pojemnosc-db.sh');

function source(): string {
  return readFileSync(SCRIPT, 'utf8').replace(/\r\n/g, '\n');
}

/** Linie bez komentarzy powłoki (komentarz o „zapisie” nie jest zapisem). */
function codeLines(): string[] {
  return source()
    .split('\n')
    .filter((line) => !/^\s*#/.test(line));
}

const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;

describe('scripts/ops/pojemnosc-db.sh (sesja 23)', () => {
  it('istnieje', () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it('wycinanie komentarzy nie zjada kodu', () => {
    const code = codeLines().join('\n');
    expect(code).toContain('source "$ENV_FILE"');
    expect(code).toContain('pg_stat_statements');
  });

  it('nie zawiera poleceń zapisu w SQL ani na serwerach', () => {
    const code = codeLines().join('\n');
    const forbidden = [
      /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE|VACUUM|REINDEX|CLUSTER|COPY)\b/,
      /pg_(terminate|cancel)_backend|pg_reload_conf|pg_stat_(statements_)?reset/i,
      /docker\s+(restart|stop|start|rm|kill|update|compose|system\s+prune|image\s+prune)/,
      /systemctl\s+(restart|stop|start|reload)/,
      /journalctl\s+--vacuum/,
      /\brm\s+-/,
    ];
    for (const re of forbidden) expect(code, String(re)).not.toMatch(re);
  });

  it('każde zapytanie do Postgresa ma limit czasu i transakcję tylko do odczytu', () => {
    const code = codeLines().join('\n');
    const psqlCalls = code.split('\n').filter((line) => line.includes('psql '));
    expect(psqlCalls.length).toBeGreaterThan(0);
    for (const line of psqlCalls) {
      expect(line).toContain('statement_timeout=');
      expect(line).toContain('default_transaction_read_only=on');
    }
  });

  it('z kontenerów czyta tylko wskazane zmienne (bez sekretów)', () => {
    const code = codeLines().join('\n');
    const inspects = code.split('\n').filter((line) => line.includes('.Config.Env'));
    expect(inspects.length).toBeGreaterThan(0);
    for (const line of inspects) expect(line).toMatch(/grep -E '\^(PGRST|GOTRUE)_/);
  });

  it('sam ładuje .agents/infra.env (jak kontrola-faktur-ksef.sh)', () => {
    const code = codeLines().join('\n');
    expect(code).toContain('FAKTFLOW_INFRA_ENV');
    expect(code).toContain('.agents/infra.env');
  });

  it.skipIf(!hasBash)('składnia bash jest poprawna', () => {
    const res = spawnSync('bash', ['-n'], { input: source(), encoding: 'utf8' });
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
  });
});
