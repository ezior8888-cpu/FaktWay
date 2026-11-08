import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * Plan usprawnień 3.6: harmonogram sprzątania `.next` (launchd, co niedzielę).
 * Główny katalog repo bywa na dowolnej gałęzi (08.11.2026: `claude/roz-warunki`
 * bez tego skryptu), więc harmonogram nie może wskazywać pliku z katalogu
 * roboczego. Uruchamia wersję z `origin/main`, skopiowaną do pliku
 * tymczasowego.
 */

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts/dev/sprzataj-worktree.sh');
const hasLaunchdLayout = process.platform === 'darwin' || process.platform === 'linux';

let home = '';
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = '';
});

describe('sprzataj-worktree.sh --zainstaluj-harmonogram', () => {
  it.runIf(hasLaunchdLayout)('harmonogram uruchamia skrypt z origin/main, nie z katalogu roboczego', () => {
    home = mkdtempSync(join(tmpdir(), 'sprzataj-'));
    const bin = join(home, 'bin');
    spawnSync('mkdir', ['-p', bin]);
    writeFileSync(join(bin, 'launchctl'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'launchctl'), 0o755);

    const r = spawnSync('bash', [SCRIPT, '--zainstaluj-harmonogram'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home },
    });
    expect(r.status, r.stderr).toBe(0);

    const plist = readFileSync(join(home, 'Library/LaunchAgents/pl.faktway.sprzataj-worktree.plist'), 'utf8');
    expect(plist).toContain('git show origin/main:scripts/dev/sprzataj-worktree.sh');
    expect(plist).toContain('--usun');
    expect(plist).not.toMatch(/<string>[^<]*\/scripts\/dev\/sprzataj-worktree\.sh<\/string>/);
  });
});
