import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * Plan usprawnień 3.6: harmonogram sprzątania `.next` (launchd, co niedzielę).
 * Główny katalog repo bywa na dowolnej gałęzi (08.11.2026: `claude/roz-warunki`
 * bez tego skryptu), więc harmonogram nie może wskazywać pliku z katalogu
 * roboczego. Uruchamia wersję z `origin/main`, skopiowaną do pliku
 * tymczasowego.
 *
 * Test stawia własne repozytorium z `refs/remotes/origin/main` (checkout w CI
 * go nie ma) i atrapę `launchctl`, a `HOME` wskazuje katalog tymczasowy.
 */

const SCRIPT = join(__dirname, '..', '..', 'scripts/dev/sprzataj-worktree.sh');

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

describe('sprzataj-worktree.sh --zainstaluj-harmonogram', () => {
  it('harmonogram uruchamia skrypt z origin/main, nie z katalogu roboczego', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sprzataj-')));
    const repo = join(dir, 'repo');
    const home = join(dir, 'home');
    const bin = join(dir, 'bin');
    mkdirSync(join(repo, 'scripts/dev'), { recursive: true });
    mkdirSync(home);
    mkdirSync(bin);
    copyFileSync(SCRIPT, join(repo, 'scripts/dev/sprzataj-worktree.sh'));
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'start');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    // Katalog roboczy na innej gałęzi, bez skryptu: harmonogram ma działać mimo to.
    git(repo, 'switch', '-q', '-c', 'inna');
    git(repo, 'rm', '-q', 'scripts/dev/sprzataj-worktree.sh');
    git(repo, 'commit', '-q', '-m', 'bez skryptu');
    writeFileSync(join(bin, 'launchctl'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'launchctl'), 0o755);

    const r = spawnSync('bash', [SCRIPT, '--zainstaluj-harmonogram'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home },
    });
    expect(r.status, r.stderr).toBe(0);

    const plist = readFileSync(join(home, 'Library/LaunchAgents/pl.faktway.sprzataj-worktree.plist'), 'utf8');
    expect(plist).toContain('git show origin/main:scripts/dev/sprzataj-worktree.sh');
    expect(plist).toContain('--usun');
    expect(plist).toContain(`<key>WorkingDirectory</key><string>${repo}</string>`);
    expect(plist).not.toMatch(/<string>[^<]*\/scripts\/dev\/sprzataj-worktree\.sh<\/string>/);
  });
});
