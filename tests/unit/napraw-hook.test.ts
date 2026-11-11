// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SKRYPT = path.resolve(__dirname, "../../scripts/dev/napraw-hook.sh");
// Bez zmiennych gita z otoczenia: w hooku przed pushem git przekazuje GIT_DIR
// prawdziwego repo i `git init` w katalogu tymczasowym zmieniłby tamto repo
// (11.11.2026: core.bare=true, test `testy-git-izolacja.test.ts`).
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "napraw-hook-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}
function hooksPath(cwd: string): string {
  try {
    return git(cwd, "config", "--get", "core.hooksPath");
  } catch {
    return "";
  }
}
function repo(name: string, zHookiem = true): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  if (zHookiem) {
    fs.mkdirSync(path.join(dir, ".githooks"));
    fs.writeFileSync(path.join(dir, ".githooks/pre-push"), "#!/bin/sh\nexit 0\n");
  }
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}
function uruchom(cwd: string): string {
  return execFileSync("bash", [SKRYPT], { cwd, env, encoding: "utf8" });
}

describe("napraw-hook.sh", () => {
  it("zła ścieżka bezwzględna zamieniona na .githooks", () => {
    const dir = repo("zla");
    git(dir, "config", "core.hooksPath", path.join(tmpRoot, "nie-ma-takiego"));
    const out = uruchom(dir);
    expect(hooksPath(dir)).toBe(".githooks");
    expect(out).toContain("hook przed pushem naprawiony (ścieżka względna)");
  });

  it("worktree z zepsutym nadpisaniem w config.worktree", () => {
    const dir = repo("glowny");
    const wt = path.join(tmpRoot, "wt");
    git(dir, "worktree", "add", "-q", "--detach", wt);
    git(dir, "config", "extensions.worktreeConfig", "true");
    git(dir, "config", "core.hooksPath", path.join(tmpRoot, "nie-ma"));
    git(wt, "config", "--worktree", "core.hooksPath", path.join(tmpRoot, "nie-ma"));
    uruchom(wt);
    expect(hooksPath(wt)).toBe(".githooks");
    const nadpisanie = fs.readFileSync(path.join(dir, ".git/worktrees/wt/config.worktree"), "utf8");
    expect(nadpisanie).not.toContain("hooksPath");
  });

  it("pusta wartość daje .githooks", () => {
    const dir = repo("pusta");
    uruchom(dir);
    expect(hooksPath(dir)).toBe(".githooks");
  });

  it("działająca własna ścieżka zostaje", () => {
    const dir = repo("wlasna");
    fs.mkdirSync(path.join(dir, "moje"));
    fs.writeFileSync(path.join(dir, "moje/pre-push"), "#!/bin/sh\n");
    git(dir, "config", "core.hooksPath", "moje");
    uruchom(dir);
    expect(hooksPath(dir)).toBe("moje");
  });

  it("repo bez .githooks zostaje bez zmian", () => {
    const dir = repo("bez", false);
    git(dir, "config", "core.hooksPath", "/nie/ma");
    uruchom(dir);
    expect(hooksPath(dir)).toBe("/nie/ma");
  });
});
