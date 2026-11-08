import assert from 'node:assert/strict';
import test from 'node:test';

import { migrationVersions, summarizeChecks } from '../src/clients.mjs';
import { createDeployer } from '../src/deploy.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const OLD = '1111111111111111111111111111111111111111';
const GREEN = [
  { id: 1, name: 'Typecheck + Lint + Unit tests', status: 'completed', conclusion: 'success' },
  { id: 2, name: 'Next build', status: 'completed', conclusion: 'success' },
  { id: 3, name: 'Agent guard', status: 'completed', conclusion: 'skipped' },
];

function setup(over = {}) {
  const calls = { deploy: [], log: [], notify: [] };
  let headSeq = over.headSeq ?? [HEAD];
  const state = { deployments: {} };
  const github = {
    headSha: async () => (headSeq.length > 1 ? headSeq.shift() : headSeq[0]),
    checkRuns: async () => over.runs ?? GREEN,
    compare: async () => ({ files: over.files ?? [{ filename: 'lib/x.ts' }], commits: ['fix: y'] }),
    migrationsAt: async () => over.migrationsAt ?? ['00099', '00100'],
  };
  const coolify = {
    lastFinishedCommit: async (uuid) => (over.deployed ?? { web: OLD, worker: OLD })[uuid === 'web' ? 'web' : 'worker'],
    running: async () => over.running ?? [],
    deploy: async (uuid) => { calls.deploy.push(uuid); const id = `dep-${uuid}`; state.deployments[id] = over.result?.[uuid] ?? { status: 'finished', commit: HEAD }; return id; },
    deployment: async (id) => state.deployments[id],
    appStatus: async () => 'running:healthy',
  };
  const db = {
    status: async () => ({ migration: '00100', migrations_recent: over.applied ?? ['00100', '00099'] }),
    log: async (action, actor, meta) => { calls.log.push({ action, meta }); },
  };
  const config = { github: { branch: 'main' }, coolify: { webUuid: 'web', workerUuid: 'worker' }, requiredChecks: ['Typecheck + Lint + Unit tests', 'Next build'], healthUrl: 'https://x/api/health' };
  const deployer = createDeployer({
    github, coolify, db, config,
    sleep: async () => {},
    fetchImpl: async () => ({ status: 200, json: async () => ({ status: 'healthy' }) }),
  });
  const notify = async (m) => { calls.notify.push(m); };
  const settle = async () => { for (let i = 0; i < 50 && deployer.isRunning(); i++) await new Promise((r) => setImmediate(r)); };
  return { deployer, calls, notify, settle };
}

test('summarizeChecks: ponowiony job liczy się po najnowszym przebiegu; brakujące wymagane blokują', () => {
  const runs = [
    { id: 1, name: 'Next build', status: 'completed', conclusion: 'failure' },
    { id: 5, name: 'Next build', status: 'completed', conclusion: 'success' },
  ];
  const s = summarizeChecks(runs, ['Next build', 'Typecheck + Lint + Unit tests']);
  assert.deepEqual(s.failed, []);
  assert.deepEqual(s.missing, ['Typecheck + Lint + Unit tests']);
  assert.equal(s.ok, false);
  assert.equal(summarizeChecks(GREEN, ['Next build']).ok, true);
  assert.equal(summarizeChecks([], []).ok, false);
});

test('migrationVersions: tylko pliki migracji', () => {
  assert.deepEqual(migrationVersions([
    { filename: 'supabase/migrations/00101_x.sql' }, { filename: 'lib/a.ts' }, { filename: 'supabase/migrations/README.md' },
  ]), ['00101']);
});

test('plan: zielone CI, migracje wgrane → brak blokad', async () => {
  const { deployer } = setup();
  const p = await deployer.plan();
  assert.equal(p.head, HEAD);
  assert.deepEqual(p.blockers, []);
});

test('plan: niewgrana migracja w zakresie blokuje', async () => {
  const { deployer } = setup({ files: [{ filename: 'supabase/migrations/00101_nowa.sql' }] });
  const p = await deployer.plan();
  assert.deepEqual(p.pendingMigrations, ['00101']);
  assert.match(p.blockers.join(), /00101/);
});

test('plan: czerwone albo trwające CI blokuje', async () => {
  const red = setup({ runs: [...GREEN.slice(0, 1), { id: 9, name: 'Next build', status: 'completed', conclusion: 'failure' }] });
  assert.match((await red.deployer.plan()).blockers.join(), /CI czerwone: Next build/);
  const pending = setup({ runs: [...GREEN.slice(0, 1), { id: 9, name: 'Next build', status: 'in_progress', conclusion: null }] });
  assert.match((await pending.deployer.plan()).blockers.join(), /CI w toku/);
});

test('plan: trwające wdrożenie w Coolify blokuje', async () => {
  const { deployer } = setup({ running: [{ app: 'ksef-saas-worker', status: 'in_progress' }] });
  assert.match((await deployer.plan()).blockers.join(), /trwa wdrożenie/);
});

test('plan: nieznany stan wdrożenia → porównanie z najnowszą wgraną migracją', async () => {
  const { deployer } = setup({ deployed: { web: null, worker: null }, migrationsAt: ['00099', '00100', '00101'] });
  assert.deepEqual((await deployer.plan()).pendingMigrations, ['00101']);
});

test('start: zły SHA → odmowa bez wdrożenia', async () => {
  const { deployer, calls, notify } = setup();
  const r = await deployer.start('00000000', 'tg:1', notify);
  assert.equal(r.started, false);
  assert.match(r.reason, /HEAD gałęzi to abcdef12/);
  assert.equal(calls.deploy.length, 0);
  assert.equal(deployer.isRunning(), false);
});

test('start: pełny przebieg — najpierw worker, potem web, weryfikacja i dziennik', async () => {
  const { deployer, calls, notify, settle } = setup();
  const r = await deployer.start('abcdef12', 'tg:1', notify);
  assert.equal(r.started, true);
  await settle();
  assert.deepEqual(calls.deploy, ['worker', 'web']);
  assert.deepEqual(calls.log.map((l) => l.action), ['ops.deploy.started', 'ops.deploy.finished']);
  assert.match(calls.notify.at(-1), /Wdrożono abcdef12/);
});

test('start: gałąź przesunęła się po workerze → web NIE jest wdrażany, ostrzeżenie o stanie mieszanym', async () => {
  // plan() → HEAD, deployOne(worker) → HEAD, deployOne(web) → NOWY
  const { deployer, calls, notify, settle } = setup({ headSeq: [HEAD, HEAD, 'ffffffff00000000'] });
  await deployer.start('abcdef12', 'tg:1', notify);
  await settle();
  assert.deepEqual(calls.deploy, ['worker']);
  assert.match(calls.notify.at(-1), /Web: gałąź przesunęła się.*Worker jest na abcdef12, web na poprzedniej wersji — stan mieszany/s);
  assert.equal(calls.log.at(-1).action, 'ops.deploy.failed');
});

test('start: Coolify wdrożył inny commit workera → stop przed webem', async () => {
  const { deployer, calls, notify, settle } = setup({ result: { worker: { status: 'finished', commit: 'ffffffff' } } });
  await deployer.start('abcdef12', 'tg:1', notify);
  await settle();
  assert.deepEqual(calls.deploy, ['worker']);
  assert.match(calls.notify.at(-1), /Worker: Coolify wdrożył ffffffff zamiast abcdef12/);
  assert.doesNotMatch(calls.notify.at(-1), /stan mieszany/);
});

test('start: nieudany build workera → stop, web nietknięty, informacja o wycofaniu w Coolify', async () => {
  const { deployer, calls, notify, settle } = setup({ result: { worker: { status: 'failed', commit: HEAD } } });
  await deployer.start('abcdef12', 'tg:1', notify);
  await settle();
  assert.deepEqual(calls.deploy, ['worker']);
  assert.match(calls.notify.at(-1), /Worker: wdrożenie zakończone statusem „failed”/);
  assert.doesNotMatch(calls.notify.at(-1), /stan mieszany/);
  assert.equal(calls.log.at(-1).action, 'ops.deploy.failed');
});

test('start: worker przeszedł, build webu padł → stan mieszany odwrotny: worker nowy, web stary', async () => {
  const { deployer, calls, notify, settle } = setup({ result: { web: { status: 'failed', commit: HEAD } } });
  await deployer.start('abcdef12', 'tg:1', notify);
  await settle();
  assert.deepEqual(calls.deploy, ['worker', 'web']);
  assert.match(calls.notify.at(-1), /Web: wdrożenie zakończone statusem „failed”/);
  assert.match(calls.notify.at(-1), /Worker jest na abcdef12, web na poprzedniej wersji — stan mieszany/);
  assert.equal(calls.log.at(-1).action, 'ops.deploy.failed');
});

test('start: komunikat po workerze zapowiada web', async () => {
  const { deployer, calls, notify, settle } = setup();
  await deployer.start('abcdef12', 'tg:1', notify);
  await settle();
  assert.ok(calls.notify.some((m) => /Worker wdrożony\. Teraz web\./.test(m)));
});

test('start: dwa szybkie /wdroz — drugie odrzucone, jedno wdrożenie', async () => {
  const { deployer, calls, notify, settle } = setup();
  const [a, b] = await Promise.all([
    deployer.start('abcdef12', 'tg:1', notify),
    deployer.start('abcdef12', 'tg:2', notify),
  ]);
  assert.deepEqual([a.started, b.started].sort(), [false, true]);
  await settle();
  assert.deepEqual(calls.deploy, ['worker', 'web']);
});
