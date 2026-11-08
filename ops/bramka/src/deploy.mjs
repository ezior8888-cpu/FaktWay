// /wdroz — plan i przebieg wdrożenia obu aplikacji (AGENTS.md „Wdrożenie
// produkcji”, MAN-54/55). Kolejność z AGENTS.md (Niezmienniki, pkt 4) i
// scripts/ops/wdroz-produkcje.sh: najpierw worker (id=2), potem web (id=1),
// nigdy równolegle — dwa buildy naraz zjadają pamięć app-1. Joby muszą być
// na nowym kodzie, zanim strona zacznie wrzucać nowe zdarzenia.
//
// Dwa źródła aplikacji w Coolify (scripts/ops/coolify-zrodlo.sh):
//   repo:  `dockerfile`, Coolify buduje HEAD gałęzi na app-1 (`POST /deploy`);
//   obraz: `dockerimage`, gotowy obraz z GHCR (`.github/workflows/obrazy.yml`)
//          z tagiem = pełny SHA, wdrażany przez endpoint „rollback” z
//          `commit: <sha>` (decyzja B1, docs/runbooks/wdrozenie-produkcji.md).
// Obie aplikacje muszą mieć to samo źródło; inaczej plan blokuje.
//
// Build z repo wdraża HEAD gałęzi, nie wskazany commit. Dlatego (w obu trybach):
//   - człowiek zatwierdza konkretny SHA (pierwsze 8 znaków + TOTP),
//   - przed każdym wyzwoleniem sprawdzamy, że HEAD to nadal ten SHA,
//   - po każdym wdrożeniu sprawdzamy commit zapisany przez Coolify,
//   - gdy `main` się przesunie, zatrzymujemy się PRZED webem.
// W trybie obrazu plan dodatkowo wymaga obu obrazów HEAD w GHCR z etykietą
// rewizji równą HEAD (build po scaleniu trwa kilkanaście minut).
import { escapeHtml, migrationVersions, summarizeChecks } from './clients.mjs';

const POLL_MS = 30_000;
const DEPLOY_TIMEOUT_MS = 35 * 60_000;

const IMAGE_SUFFIX = { web: 'runner', worker: 'worker' };

/** Tryb wdrożenia z konfiguracji obu aplikacji albo powód blokady. */
function sourceMode(sources, prefix) {
  const { web, worker } = sources;
  if (web?.buildPack === 'dockerfile' && worker?.buildPack === 'dockerfile') return { mode: 'repo' };
  if (web?.buildPack === 'dockerimage' && worker?.buildPack === 'dockerimage') {
    for (const [name, src] of Object.entries(sources)) {
      const expected = `${prefix}-${IMAGE_SUFFIX[name]}`;
      if (src.image !== expected) {
        return { mode: null, blocker: `${name === 'web' ? 'Web' : 'Worker'} jest na obrazie ${src.image ?? '?'}, oczekiwany ${expected}. Sprawdź: ./scripts/ops/coolify-zrodlo.sh stan` };
      }
    }
    return { mode: 'obraz' };
  }
  return {
    mode: null,
    blocker: `Źródła aplikacji niespójne albo nieznane (web: ${web?.buildPack ?? '?'}, worker: ${worker?.buildPack ?? '?'}). Sprawdź: ./scripts/ops/coolify-zrodlo.sh stan`,
  };
}

export function createDeployer({ github, coolify, ghcr, db, config, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), fetchImpl = fetch }) {
  let running = false;

  /** Co zostanie wdrożone i czy wolno. Bez skutków ubocznych. */
  async function plan() {
    const head = await github.headSha(config.github.branch);
    if (!head) return { head: null, blockers: ['Nie mogę odczytać HEAD gałęzi z GitHuba.'] };

    const [webCommit, workerCommit, runs, status, inProgress, webSource, workerSource] = await Promise.all([
      coolify.lastFinishedCommit(config.coolify.webUuid),
      coolify.lastFinishedCommit(config.coolify.workerUuid),
      github.checkRuns(head),
      db.status(),
      coolify.running(),
      coolify.source(config.coolify.webUuid),
      coolify.source(config.coolify.workerUuid),
    ]);
    const ci = summarizeChecks(runs, config.requiredChecks);
    const source = sourceMode({ web: webSource, worker: workerSource }, config.ghcrPrefix);

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
    if (source.blocker) blockers.push(source.blocker);
    if (source.mode === 'obraz') {
      const sha8 = head.slice(0, 8);
      const images = Object.values(IMAGE_SUFFIX).map((suffix) => `${config.ghcrPrefix}-${suffix}`);
      const revisions = await Promise.all(images.map((image) => ghcr.revision(image, head).catch(() => undefined)));
      images.forEach((image, i) => {
        const name = `${image.split('/').pop()}:${sha8}`;
        const rev = revisions[i];
        if (rev === undefined) blockers.push(`GHCR nie odpowiada (${name}). Spróbuj /wdroz za chwilę.`);
        else if (rev === null) blockers.push(`Obrazu ${name} jeszcze nie ma w GHCR (build po scaleniu trwa kilkanaście minut). Spróbuj /wdroz później.`);
        else if (rev !== head) blockers.push(`${name} ma etykietę rewizji ${String(rev).slice(0, 8)}, nie ${sha8}. Przebuduj: gh workflow run obrazy.yml -f ref=${head} -f wdroz=false`);
      });
    }
    return { head, webCommit, workerCommit, ci, commits, pendingMigrations, blockers, mode: source.mode };
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

  async function deployOne(label, appUuid, head, mode, notify) {
    const current = await github.headSha(config.github.branch);
    if (current !== head) {
      return { ok: false, message: `${label}: gałąź przesunęła się na ${current?.slice(0, 8)} — przerywam. Uruchom /wdroz ponownie.` };
    }
    let depUuid;
    if (mode === 'obraz') {
      depUuid = await coolify.deployImage(appUuid, head);
      await notify(`⏳ ${label}: pobieranie obrazu ${head.slice(0, 8)} z GHCR i start (kilka minut).`);
    } else {
      depUuid = await coolify.deploy(appUuid);
      await notify(`⏳ ${label}: build ruszył (12–18 min).`);
    }
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
    const mode = p.mode;
    (async () => {
      try {
        await db.log('ops.deploy.started', actor, { sha: head, mode });
        const worker = await deployOne('Worker', config.coolify.workerUuid, head, mode, notify);
        if (!worker.ok) throw new Error(worker.message);
        await notify('✅ Worker wdrożony. Teraz web.');
        const web = await deployOne('Web', config.coolify.webUuid, head, mode, notify);
        if (!web.ok) throw new Error(`${web.message}\n⚠️ Worker jest na ${head.slice(0, 8)}, web na poprzedniej wersji — stan mieszany.`);

        const checks = await verify();
        await db.log('ops.deploy.finished', actor, { sha: head, mode, ...checks });
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
