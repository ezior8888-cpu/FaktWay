// /wdroz — plan i przebieg wdrożenia obu aplikacji (AGENTS.md „Wdrożenie
// produkcji”, MAN-54/55). Kolejność z AGENTS.md (Niezmienniki, pkt 4) i
// scripts/ops/wdroz-produkcje.sh: najpierw worker (id=2), potem web (id=1),
// nigdy równolegle — dwa buildy naraz zjadają pamięć app-1. Joby muszą być
// na nowym kodzie, zanim strona zacznie wrzucać nowe zdarzenia.
//
// API Coolify wdraża HEAD gałęzi, nie wskazany commit. Dlatego:
//   - człowiek zatwierdza konkretny SHA (pierwsze 8 znaków + TOTP),
//   - przed każdym wyzwoleniem sprawdzamy, że HEAD to nadal ten SHA,
//   - po każdym wdrożeniu sprawdzamy commit zapisany przez Coolify,
//   - gdy `main` się przesunie, zatrzymujemy się PRZED webem.
import { escapeHtml, migrationVersions, summarizeChecks } from './clients.mjs';

const POLL_MS = 30_000;
const DEPLOY_TIMEOUT_MS = 35 * 60_000;

export function createDeployer({ github, coolify, db, config, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), fetchImpl = fetch }) {
  let running = false;

  /** Co zostanie wdrożone i czy wolno. Bez skutków ubocznych. */
  async function plan() {
    const head = await github.headSha(config.github.branch);
    if (!head) return { head: null, blockers: ['Nie mogę odczytać HEAD gałęzi z GitHuba.'] };

    const [webCommit, workerCommit, runs, status, inProgress] = await Promise.all([
      coolify.lastFinishedCommit(config.coolify.webUuid),
      coolify.lastFinishedCommit(config.coolify.workerUuid),
      github.checkRuns(head),
      db.status(),
      coolify.running(),
    ]);
    const ci = summarizeChecks(runs, config.requiredChecks);

    // Migracje: nowe w zakresie od wdrożonego web do HEAD, których nie ma w bazie.
    const applied = new Set((status?.migrations_recent ?? []).map(String));
    let candidates;
    let commits = [];
    if (webCommit) {
      const cmp = await github.compare(webCommit, head);
      candidates = migrationVersions(cmp.files);
      commits = cmp.commits;
    } else {
      // Nie wiemy, co jest wdrożone — sprawdzamy wszystko powyżej najnowszej wgranej.
      const max = String(status?.migration ?? '');
      candidates = (await github.migrationsAt(head)).filter((v) => v > max);
    }
    const pendingMigrations = candidates.filter((v) => !applied.has(v));

    const blockers = [];
    if (!ci.ok) {
      if (ci.failed.length) blockers.push(`CI czerwone: ${ci.failed.join(', ')}`);
      if (ci.pending.length) blockers.push(`CI w toku: ${ci.pending.join(', ')}`);
      if (ci.missing.length) blockers.push(`Brak kontroli: ${ci.missing.join(', ')}`);
      if (ci.total === 0) blockers.push('Brak jakichkolwiek kontroli CI dla tego commita.');
    }
    if (pendingMigrations.length) {
      blockers.push(`Migracje niewgrane na db-1: ${pendingMigrations.join(', ')} — wgraj je według AGENTS.md, potem /wdroz.`);
    }
    if (inProgress.length) {
      blockers.push(`W Coolify trwa wdrożenie: ${inProgress.map((d) => `${d.app} (${d.status})`).join(', ')}.`);
    }
    if (webCommit && workerCommit && webCommit === head && workerCommit === head) {
      blockers.push('Obie aplikacje są już na tym commicie.');
    }
    return { head, webCommit, workerCommit, ci, commits, pendingMigrations, blockers };
  }

  async function waitFor(deploymentUuid) {
    const deadline = now() + DEPLOY_TIMEOUT_MS;
    for (;;) {
      await sleep(POLL_MS);
      const d = await coolify.deployment(deploymentUuid);
      if (['finished', 'failed', 'cancelled-by-user', 'cancelled'].includes(d.status)) return d;
      if (now() > deadline) return { status: 'timeout', commit: d.commit };
    }
  }

  async function deployOne(label, appUuid, head, notify) {
    const current = await github.headSha(config.github.branch);
    if (current !== head) {
      return { ok: false, message: `${label}: gałąź przesunęła się na ${current?.slice(0, 8)} — przerywam. Uruchom /wdroz ponownie.` };
    }
    const depUuid = await coolify.deploy(appUuid);
    await notify(`⏳ ${label}: build ruszył (12–18 min).`);
    const d = await waitFor(depUuid);
    if (d.status !== 'finished') {
      return { ok: false, message: `${label}: wdrożenie zakończone statusem „${d.status}”. Coolify zostawia poprzednią wersję — sprawdź logi wdrożenia.` };
    }
    if (!d.commit || !String(d.commit).startsWith(head.slice(0, 7))) {
      return { ok: false, message: `${label}: Coolify wdrożył ${String(d.commit).slice(0, 8)} zamiast ${head.slice(0, 8)}.` };
    }
    return { ok: true };
  }

  /**
   * Uruchamia wdrożenie w tle. `notify` wysyła postęp do Telegrama.
   * Zwraca od razu: { started: true } albo powód odmowy.
   */
  async function start(sha8, actor, notify) {
    if (running) return { started: false, reason: 'Wdrożenie już trwa.' };
    // Blokada od razu, przed pierwszym await — dwa szybkie /wdroz nie mogą
    // obu przejść tej kontroli.
    running = true;
    let p;
    try {
      p = await plan();
    } catch (err) {
      running = false;
      throw err;
    }
    const refuse = (reason) => { running = false; return { started: false, reason }; };
    if (!p.head) return refuse(p.blockers[0]);
    if (!p.head.startsWith(sha8)) {
      return refuse(`HEAD gałęzi to ${p.head.slice(0, 8)}, nie ${sha8}. Sprawdź /wdroz jeszcze raz.`);
    }
    if (p.blockers.length) return refuse(p.blockers.join('\n'));

    const head = p.head;
    (async () => {
      try {
        await db.log('ops.deploy.started', actor, { sha: head });
        const worker = await deployOne('Worker', config.coolify.workerUuid, head, notify);
        if (!worker.ok) throw new Error(worker.message);
        await notify('✅ Worker wdrożony. Teraz web.');
        const web = await deployOne('Web', config.coolify.webUuid, head, notify);
        if (!web.ok) throw new Error(`${web.message}\n⚠️ Worker jest na ${head.slice(0, 8)}, web na poprzedniej wersji — stan mieszany.`);

        const checks = await verify();
        await db.log('ops.deploy.finished', actor, { sha: head, ...checks });
        await notify([
          `✅ Wdrożono ${head.slice(0, 8)} (worker i web).`,
          `/api/health: ${escapeHtml(checks.health)}`,
          `Web: ${escapeHtml(checks.web)} · Worker: ${escapeHtml(checks.worker)}`,
          checks.ok ? '' : '⚠️ Coś nie wygląda zdrowo — sprawdź ręcznie (AGENTS.md „Weryfikacja po wdrożeniu”).',
        ].filter(Boolean).join('\n'));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'nieznany błąd';
        await db.log('ops.deploy.failed', actor, { sha: head, error: message.slice(0, 300) }).catch(() => {});
        await notify(`❌ ${escapeHtml(message)}`);
      } finally {
        running = false;
      }
    })();
    return { started: true, head };
  }

  async function verify() {
    let health = 'brak odpowiedzi';
    try {
      const res = await fetchImpl(config.healthUrl, { signal: AbortSignal.timeout(15_000) });
      const body = await res.json().catch(() => null);
      health = `HTTP ${res.status}${body?.status ? ` (${body.status})` : ''}`;
    } catch { /* zostaje „brak odpowiedzi” */ }
    // Kontener potrzebuje chwili na healthcheck po starcie.
    await sleep(60_000);
    const [web, worker] = await Promise.all([
      coolify.appStatus(config.coolify.webUuid).catch(() => 'nieznany'),
      coolify.appStatus(config.coolify.workerUuid).catch(() => 'nieznany'),
    ]);
    const ok = health.startsWith('HTTP 200') && String(web).includes('running') && String(worker).includes('running');
    return { health, web, worker, ok };
  }

  return { plan, start, isRunning: () => running };
}
