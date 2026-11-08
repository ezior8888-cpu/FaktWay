import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Plan usprawnień (08.11.2026): `scripts/ops/kontrola-faktur-ksef.sh` jest na
 * liście poleceń, które agent uruchamia bez pytania (`.claude/settings.json`).
 * Skrypt łączy się z db-1 jako `postgres`, więc „tylko odczyt” nie może
 * zależeć od treści zapytań: każde wywołanie psql dostaje transakcję tylko do
 * odczytu i limit czasu w PGOPTIONS, jak `scripts/ops/pojemnosc-db.sh`.
 */

const ROOT = join(__dirname, '..', '..');

/** Linie bez komentarzy powłoki. */
function codeLines(path: string): string[] {
  return readFileSync(join(ROOT, path), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line));
}

describe('scripts/ops/kontrola-faktur-ksef.sh tylko do odczytu', () => {
  it('każde wywołanie psql ma transakcję tylko do odczytu i limit czasu', () => {
    const psqlCalls = codeLines('scripts/ops/kontrola-faktur-ksef.sh').filter((line) => line.includes('psql '));
    expect(psqlCalls.length).toBeGreaterThanOrEqual(2);
    for (const line of psqlCalls) {
      expect(line).toContain("docker exec -e 'PGOPTIONS=-c statement_timeout=30s -c default_transaction_read_only=on'");
    }
  });

  it('agent uruchamia bez pytania tylko ten skrypt z scripts/ops/', () => {
    const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8')) as {
      permissions: { allow: string[] };
    };
    const ops = settings.permissions.allow.filter((rule) => rule.includes('scripts/ops/'));
    expect(ops).toEqual(['Bash(./scripts/ops/kontrola-faktur-ksef.sh)']);
  });
});
