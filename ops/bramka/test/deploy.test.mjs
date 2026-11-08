import assert from 'node:assert/strict';
import test from 'node:test';

import { createCoolify, createGhcr, migrationVersions, summarizeChecks } from '../src/clients.mjs';
import { createDeployer } from '../src/deploy.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const OLD = '1111111111111111111111111111111111111111';
const GREEN = [
  { id: 1, name: 'Typecheck + Lint + Unit tests', status: 'completed', conclusion: 'success' },
  { id: 2, name: 'Next build', status: 'completed', conclusion: 'success' },
  { id: 3, name: 'Agent guard', status: 'completed', conclusion: 'skipped' },
];

const RUNNER = 'ghcr.io/ezior8888-cpu/faktway-runner';
const WORKER = 'ghcr.io/ezior8888-cpu/faktway-worker';
const REPO_SOURCES = {
  web: { buildPack: 'dockerfile', image: null, tag: null },
  worker: { buildPack: 'dockerfile', image: null, tag: null },
};
const IMAGE_SOURCES = {
  web: { buildPack: 'dockerimage', image: RUNNER, tag: OLD },
  worker: { buildPack: 'dockerimage', image: WORKER, tag: OLD },
};

function setup(over = {}) {
  const calls = { deploy: [], deployImage: [], log: [], notify: [], ghcr: [] };
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
    source: async (uuid) => {
      // `sourcesAfterWorker`: źródło przełączone w trakcie, po wdrożeniu workera.
      const all = calls.deploy.length + calls.deployImage.length > 0 && over.sourcesAfterWorker ? over.sourcesAfterWorker : (over.sources ?? REPO_SOURCES);
      return all[uuid === 'web' ? 'web' : 'worker'];
    },
    deployImage: async (uuid, sha) => {
      if (over.deployImageError?.[uuid]) throw new Error(over.deployImageError[uuid]);
      calls.deployImage.push(`${uuid}:${sha}`);
      const id = `img-${uuid}`;
      state.deployments[id] = over.result?.[uuid] ?? { status: 'finished', commit: sha };
      return id;
    },
  };
  // Etykieta rewizji obrazu w GHCR: domyślnie oba obrazy HEAD są.
  const ghcr = {
    revision: async (image, tag) => {
      calls.ghcr.push(`${image}:${tag}`);
      const labels = over.ghcr ?? { [`${RUNNER}:${HEAD}`]: HEAD, [`${WORKER}:${HEAD}`]: HEAD };
      return labels[`${image}:${tag}`] ?? null;
    },
  };
  const db = {
    status: async () => ({ migration: '00100', migrations_recent: over.applied ?? ['00100', '00099'] }),
    log: async (action, actor, meta) => { calls.log.push({ action, meta }); },
  };
  const config = { github: { branch: 'main' }, coolify: { webUuid: 'web', workerUuid: 'worker' }, ghcrPrefix: 'ghcr.io/ezior8888-cpu/faktway', requiredChecks: ['Typecheck + Lint + Unit tests', 'Next build'], healthUrl: 'https://x/api/health' };
  const deployer = createDeployer({
    github, coolify, ghcr, db, config,
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

// ── Obrazy z GHCR (Coolify `dockerimage`, decyzja B1) ──────────────────

test('plan: build z repo → tryb repo, GHCR nie jest pytany', async () => {
  const { deployer, calls } = setup();
  const p = await deployer.plan();
  assert.equal(p.mode, 'repo');
  assert.deepEqual(p.blockers, []);
  assert.deepEqual(calls.ghcr, []);
});

test('plan: obie aplikacje na obrazach i oba obrazy HEAD w GHCR → tryb obraz, bez blokad', async () => {
  const { deployer } = setup({ sources: IMAGE_SOURCES });
  const p = await deployer.plan();
  assert.equal(p.mode, 'obraz');
  assert.deepEqual(p.blockers, []);
});

test('plan: obrazu HEAD jeszcze nie ma w GHCR → blokada z prośbą o ponowienie', async () => {
  const { deployer } = setup({ sources: IMAGE_SOURCES, ghcr: { [`${WORKER}:${HEAD}`]: HEAD } });
  const p = await deployer.plan();
  assert.match(p.blockers.join(), /faktway-runner:abcdef12.*nie ma w GHCR/);
});

test('plan: obraz z etykietą innego commita → blokada', async () => {
  const { deployer } = setup({ sources: IMAGE_SOURCES, ghcr: { [`${WORKER}:${HEAD}`]: OLD, [`${RUNNER}:${HEAD}`]: HEAD } });
  const p = await deployer.plan();
  assert.match(p.blockers.join(), /etykiet[aę] rewizji 11111111/);
});

test('plan: jedna aplikacja na obrazie, druga z repo → blokada (stan niespójny)', async () => {
  const { deployer } = setup({ sources: { web: IMAGE_SOURCES.web, worker: REPO_SOURCES.worker } });
  const p = await deployer.plan();
  assert.match(p.blockers.join(), /coolify-zrodlo\.sh/);
});

test('plan: obraz spoza naszego GHCR → blokada', async () => {
  const { deployer } = setup({ sources: { ...IMAGE_SOURCES, worker: { buildPack: 'dockerimage', image: 'docker.io/obcy/obraz', tag: 'x' } } });
  const p = await deployer.plan();
  assert.match(p.blockers.join(), /docker\.io\/obcy\/obraz/);
});

test('start: tryb obraz → wdrożenie obrazu SHA, worker przed webem, bez buildu', async () => {
  const { deployer, calls, notify, settle } = setup({ sources: IMAGE_SOURCES });
  const r = await deployer.start('abcdef12', 'tg:1', notify);
  assert.equal(r.started, true);
  await settle();
  assert.deepEqual(calls.deployImage, [`worker:${HEAD}`, `web:${HEAD}`]);
  assert.deepEqual(calls.deploy, []);
  assert.match(calls.notify.at(-1), /Wdrożono abcdef12/);
  assert.equal(calls.log[0].meta.mode, 'obraz');
});

test('start: tryb obraz, Coolify odrzuca wdrożenie webu → komunikat o stanie mieszanym', async () => {
  const { deployer, calls, notify, settle } = setup({ sources: IMAGE_SOURCES, deployImageError: { web: 'Coolify POST /applications/web/rollback: HTTP 400 (Deployment queue full)' } });
  await deployer.start('abcdef12', 'tg:1', notify);
  await settle();
  assert.deepEqual(calls.deployImage, [`worker:${HEAD}`]);
  assert.match(calls.notify.at(-1), /Web: Coolify nie przyjął wdrożenia.*queue full/s);
  assert.match(calls.notify.at(-1), /stan mieszany/);
});

test('start: źródło przełączone po workerze → web nie jest wdrażany', async () => {
  const { deployer, calls, notify, settle } = setup({ sources: IMAGE_SOURCES, sourcesAfterWorker: REPO_SOURCES });
  await deployer.start('abcdef12', 'tg:1', notify);
  await settle();
  assert.deepEqual(calls.deployImage, [`worker:${HEAD}`]);
  assert.deepEqual(calls.deploy, []);
  assert.match(calls.notify.at(-1), /źródło w Coolify zmieniło się na „dockerfile”/);
});

test('start: tryb obraz → po sukcesie ostrzeżenie przed Redeploy w panelu', async () => {
  const { deployer, calls, notify, settle } = setup({ sources: IMAGE_SOURCES });
  await deployer.start('abcdef12', 'tg:1', notify);
  await settle();
  assert.match(calls.notify.at(-1), /Nie klikaj Redeploy/);
});

test('createCoolify: błąd HTTP niesie komunikat Coolify', async () => {
  const f = fakeFetch([[/rollback$/, [400, { message: 'Deployment queue full.' }]]]);
  const coolify = createCoolify({ baseUrl: 'https://coolify.test/api/v1', token: 't', fetchImpl: f.impl });
  await assert.rejects(coolify.deployImage('app-1', HEAD), /HTTP 400 \(Deployment queue full\.\)/);
});

test('start: tryb obraz, nieudany worker → stop przed webem', async () => {
  const { deployer, calls, notify, settle } = setup({ sources: IMAGE_SOURCES, result: { worker: { status: 'failed', commit: HEAD } } });
  await deployer.start('abcdef12', 'tg:1', notify);
  await settle();
  assert.deepEqual(calls.deployImage, [`worker:${HEAD}`]);
  assert.match(calls.notify.at(-1), /Worker: wdrożenie zakończone statusem „failed”/);
});

function fakeFetch(routes) {
  const seen = [];
  const impl = async (url, init = {}) => {
    seen.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} });
    const hit = routes.find(([re]) => re.test(url));
    const [status, body] = hit ? hit[1] : [404, { message: 'nie ma' }];
    return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body };
  };
  return { impl, seen };
}

test('createCoolify.deployImage: POST /applications/<uuid>/rollback z commitem = SHA', async () => {
  const f = fakeFetch([[/\/applications\/app-1\/rollback$/, [200, { message: 'Rollback deployment queued.', deployment_uuid: 'd-1' }]]]);
  const coolify = createCoolify({ baseUrl: 'https://coolify.test/api/v1', token: 't', fetchImpl: f.impl });
  assert.equal(await coolify.deployImage('app-1', HEAD), 'd-1');
  assert.equal(f.seen[0].method, 'POST');
  assert.deepEqual(f.seen[0].body, { commit: HEAD });
});

test('createCoolify.deployImage: Coolify pominął wdrożenie → błąd z jego komunikatem', async () => {
  const f = fakeFetch([[/rollback$/, [200, { message: 'Deployment already queued for this commit.' }]]]);
  const coolify = createCoolify({ baseUrl: 'https://coolify.test/api/v1', token: 't', fetchImpl: f.impl });
  await assert.rejects(coolify.deployImage('app-1', HEAD), /already queued/);
});

test('createCoolify.source: build_pack, nazwa i tag obrazu', async () => {
  const f = fakeFetch([[/\/applications\/app-1$/, [200, { status: 'running:healthy', build_pack: 'dockerimage', docker_registry_image_name: RUNNER, docker_registry_image_tag: OLD }]]]);
  const coolify = createCoolify({ baseUrl: 'https://coolify.test/api/v1', token: 't', fetchImpl: f.impl });
  assert.deepEqual(await coolify.source('app-1'), { buildPack: 'dockerimage', image: RUNNER, tag: OLD });
});

test('createGhcr.revision: indeks z atestacją → obraz linux/amd64 → etykieta rewizji', async () => {
  const f = fakeFetch([
    [/ghcr\.io\/token/, [200, { token: 'anon' }]],
    [/manifests\/sha256:amd64$/, [200, { config: { digest: 'sha256:cfg' } }]],
    [/manifests\/abcdef/, [200, { manifests: [
      { digest: 'sha256:att', platform: { os: 'unknown', architecture: 'unknown' } },
      { digest: 'sha256:amd64', platform: { os: 'linux', architecture: 'amd64' } },
    ] }]],
    [/blobs\/sha256:cfg$/, [200, { config: { Labels: { 'org.opencontainers.image.revision': HEAD } } }]],
  ]);
  const ghcr = createGhcr({ fetchImpl: f.impl });
  assert.equal(await ghcr.revision(RUNNER, HEAD), HEAD);
  assert.match(f.seen[0].url, /scope=repository:ezior8888-cpu\/faktway-runner:pull/);
  assert.equal(f.seen[1].headers.Authorization, 'Bearer anon');
});

test('createGhcr.revision: brak tagu (404) → null', async () => {
  const f = fakeFetch([[/ghcr\.io\/token/, [200, { token: 'anon' }]]]);
  assert.equal(await createGhcr({ fetchImpl: f.impl }).revision(RUNNER, HEAD), null);
});
