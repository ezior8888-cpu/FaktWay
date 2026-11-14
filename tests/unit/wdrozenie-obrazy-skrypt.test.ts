import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Wdrożenia z gotowych obrazów GHCR (decyzja B1, 08.11.2026):
 * `scripts/ops/wdroz-produkcje.sh` (tryb `--obraz`) i `scripts/ops/coolify-zrodlo.sh`.
 *
 * Uruchamiamy PRAWDZIWE skrypty (kopia w katalogu tymczasowym, żeby
 * `kontrola-faktur-ksef.sh` był atrapą) z atrapami `ssh`, `docker` (tinker
 * Coolify ze stanem aplikacji w plikach), `curl` (rejestr GHCR), `git`, `df`
 * i `sleep`. Pilnujemy: kolejności worker → aplikacja, tego, że na
 * produkcję idzie tylko SHA z main z obrazem o tej samej etykiecie, cofnięcia
 * tagu przy porażce, wolnego miejsca na app-1 i pułapki Coolify, w której
 * zmiana `build_pack` przez model czyści cel `Dockerfile`.
 */

const SRC = resolve(__dirname, '../../scripts/ops');
const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const FOREIGN = 'c'.repeat(40);
const RUNNER = 'ghcr.io/ezior8888-cpu/faktway-runner';
const WORKER = 'ghcr.io/ezior8888-cpu/faktway-worker';

/**
 * `jq` jest prawdziwy, bez atrapy: `ghcr_rewizja` (coolify-wspolne.sh) czyta
 * nim odpowiedzi GHCR, a jego filtry to część tego, co sprawdzamy. Brak `jq`
 * skrypt połyka (`ghcr_rewizja … 2>/dev/null || true` w `czekaj_na_obrazy`):
 * nie widzi żadnego obrazu, czeka do limitu i kończy „Brak obrazów”.
 * Na Windowsie bez `jq` (14.11.2026) padało tak 13 testów GHCR, z mylącą
 * asercją, a 10 z nich trwało po ok. 41 s.
 *
 * Dlatego testy, w których skrypt odpytuje GHCR, idą przez `itGhcr`. Bez `jq`:
 * - lokalnie są pominięte, z powodem przy teście i w ostrzeżeniu pliku;
 * - na CI są czerwone z komunikatem „brak jq”, bo zmiana obrazu CI nie może
 *   po cichu wyłączyć tych testów.
 * Podział sprawdza `afterEach`: atrapa `curl` zapisuje każdy adres do
 * `curl.log`, a adres `ghcr.io/` znaczy, że skrypt odpytał GHCR.
 *
 * `jq` sprawdzamy tak, jak widzi go skrypt: w bashu, z tym samym PATH. Natywny
 * `jq.exe` na Windowsie bez `--binary` kończy linie CRLF, a `$(jq -r …)`
 * zostawia wtedy `\r` w tokenie i skrótach, więc taki `jq` też się nie nadaje.
 */
const jqProbe = spawnSync('bash', ['-c', `printf '{"a":1}' | jq -r .a`], { encoding: 'utf8' });
const hasJq = jqProbe.status === 0 && jqProbe.stdout === '1\n';
const onCi = !['', '0', 'false'].includes(process.env.CI ?? '');
const NO_JQ_MESSAGE =
  'brak jq w bashu (albo jq wypisuje CRLF), a ghcr_rewizja (scripts/ops/coolify-wspolne.sh) czyta nim odpowiedzi GHCR';
if (!hasJq && !onCi) console.warn(`${NO_JQ_MESSAGE}: testy GHCR w tym pliku są pominięte. Zainstaluj jq, żeby je uruchomić.`);

let ghcrTest = false;

function itGhcr(name: string, fn: () => void | Promise<void>) {
  it(name, (ctx) => {
    if (!hasJq) {
      if (onCi) throw new Error(`${NO_JQ_MESSAGE}. Na CI to błąd obrazu runnera, a nie powód do pominięcia testu.`);
      ctx.skip(NO_JQ_MESSAGE);
    }
    ghcrTest = true;
    return fn();
  });
}

const FAKE_SSH = `#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -i|-o|-p|-l|-F) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
exec bash -c "$*"
`;

// Tinker: odbija wejście z „> ” (jak prawdziwy), potem odpowiada znacznikiem.
// Stan aplikacji: $FAKE_DIR/app-<id> = „build_pack|obraz|tag|lokalizacja|cel”.
const FAKE_DOCKER = `#!/usr/bin/env bash
case "$1" in
  exec)
    php=$(cat)
    printf '%s\\n' "$php" >> "$FAKE_DIR/tinker.log"
    printf '%s\\n' "$php" | sed 's/^/> /'
    case "$php" in
      *'"ZRODLO="'*)
        id=$(printf '%s' "$php" | sed -n 's/.*Application::find(\\([0-9]*\\)).*/\\1/p' | head -n 1)
        echo "WD_ZRODLO=$(cat "$FAKE_DIR/app-$id")" ;;
      *'"ZMIANA="'*)
        id=$(printf '%s' "$php" | sed -n 's/.*whereKey(\\([0-9]*\\)).*/\\1/p' | head -n 1)
        IFS='|' read -r bp img tag loc tgt < "$FAKE_DIR/app-$id"
        pairs=$(printf '%s' "$php" | grep -oE "'[a-z_]+' => ('[^']*'|null)")
        while IFS= read -r pair; do
          key=$(printf '%s' "$pair" | sed "s/^'\\([a-z_]*\\)'.*/\\1/")
          val=$(printf '%s' "$pair" | sed "s/^'[a-z_]*' => //; s/^'//; s/'$//; s/^null$//")
          case "$key" in
            build_pack) bp=$val ;;
            docker_registry_image_name) img=$val ;;
            docker_registry_image_tag) tag=$val ;;
            dockerfile_location) loc=$val ;;
            dockerfile_target_build) tgt=$val ;;
          esac
        done <<< "$pairs"
        echo "$bp|$img|$tag|$loc|$tgt" > "$FAKE_DIR/app-$id"
        echo "zmiana $id $bp|$img|$tag|$loc|$tgt" >> "$FAKE_DIR/log"
        echo "WD_ZMIANA=1" ;;
      *queue_application_deployment*)
        id=$(printf '%s' "$php" | sed -n 's/.*Application::find(\\([0-9]*\\)).*/\\1/p' | head -n 1)
        commit=$(printf '%s' "$php" | sed -n "s/.*commit: '\\([^']*\\)'.*/\\1/p")
        echo "wdrozenie $id $commit" >> "$FAKE_DIR/log"
        status=finished; [ -f "$FAKE_DIR/status-$id" ] && status=$(cat "$FAKE_DIR/status-$id")
        if [ "$status" = finished ]; then
          IFS='|' read -r bp img tag _ _ < "$FAKE_DIR/app-$id"
          if [ "$id" = 2 ]; then prefix=workertest; else prefix=apptest; fi
          if [ "$bp" = dockerimage ]; then echo "$img:$tag" > "$FAKE_DIR/running-$id"
          else echo "$prefix:$commit" > "$FAKE_DIR/running-$id"; fi
        fi
        echo "WD_UUID=dep$id" ;;
      *'"STATUS="'*)
        id=$(printf '%s' "$php" | sed -n "s/.*'dep\\([0-9]*\\)'.*/\\1/p")
        status=finished; [ -f "$FAKE_DIR/status-$id" ] && status=$(cat "$FAKE_DIR/status-$id")
        echo "WD_STATUS=$status" ;;
      *'$logs'*) echo "ostatnia linia logu buildu" ;;
    esac ;;
  ps)
    [ -f "$FAKE_DIR/running-2" ] && echo "workertest-20261108 $(cat "$FAKE_DIR/running-2")"
    [ -f "$FAKE_DIR/running-1" ] && echo "apptest-20261108 $(cat "$FAKE_DIR/running-1")"
    echo "coolify-proxy traefik:v3.6" ;;
esac
`;

// GHCR: obraz istnieje, gdy jest plik $FAKE_DIR/ghcr-<nazwa>-<tag> z etykietą rewizji.
const FAKE_CURL = `#!/usr/bin/env bash
url=""
for a in "$@"; do url=$a; done
echo "$url" >> "$FAKE_DIR/curl.log"
name=$(printf '%s' "$url" | sed -n 's#.*/v2/ezior8888-cpu/\\([^/]*\\)/.*#\\1#p')
case "$url" in
  *ghcr.io/token*) echo '{"token":"anonimowy"}' ;;
  */manifests/sha256:amd64-*)
    tag=\${url##*sha256:amd64-}
    echo "{\\"config\\":{\\"digest\\":\\"sha256:cfg-$tag\\"}}" ;;
  */manifests/*)
    tag=\${url##*/}
    [ -f "$FAKE_DIR/ghcr-$name-$tag" ] || exit 22
    echo "{\\"manifests\\":[{\\"digest\\":\\"sha256:att\\",\\"platform\\":{\\"os\\":\\"unknown\\",\\"architecture\\":\\"unknown\\"}},{\\"digest\\":\\"sha256:amd64-$tag\\",\\"platform\\":{\\"os\\":\\"linux\\",\\"architecture\\":\\"amd64\\"}}]}" ;;
  */blobs/sha256:cfg-*)
    tag=\${url##*sha256:cfg-}
    echo "{\\"config\\":{\\"Labels\\":{\\"org.opencontainers.image.revision\\":\\"$(cat "$FAKE_DIR/ghcr-$name-$tag")\\"}}}" ;;
  *) exit 22 ;;
esac
`;

const FAKE_GIT = `#!/usr/bin/env bash
[ "$1" = -C ] && shift 2
case "$1" in
  rev-parse)
    case "$2" in
      origin/main) cat "$FAKE_DIR/main-sha" ;;
      *) exit 1 ;;
    esac ;;
  fetch) [ -f "$FAKE_DIR/fetch-fail" ] && exit 1; exit 0 ;;
  merge-base) grep -qx "$3" "$FAKE_DIR/main-history" ;;
  *) exit 1 ;;
esac
`;

const FAKE_DF = `#!/usr/bin/env bash
echo "Filesystem 1G-blocks Used Available Capacity Mounted"
echo "/dev/sda1 38G 26G $(cat "$FAKE_DIR/free")G 72% /"
`;

// Po czekaniu wykonuje $FAKE_DIR/po-sleep (np. „obraz się pojawia”); usuwa go,
// gdy skończy się kodem 0 (kod 1 = „jeszcze nie teraz”).
const FAKE_SLEEP = `#!/usr/bin/env bash
echo "sleep $1" >> "$FAKE_DIR/sleep.log"
if [ -f "$FAKE_DIR/po-sleep" ] && bash "$FAKE_DIR/po-sleep"; then rm -f "$FAKE_DIR/po-sleep"; fi
`;

let dir: string;
let fakeDir: string;

function write(path: string, content: string, mode = 0o644) {
  writeFileSync(path, content);
  chmodSync(path, mode);
}

const fake = (name: string) => join(fakeDir, name);
const state = (id: 1 | 2) => readFileSync(fake(`app-${id}`), 'utf8').trim();
const log = () => (existsSync(fake('log')) ? readFileSync(fake('log'), 'utf8').trim().split('\n') : []);
const tinkerLog = () => (existsSync(fake('tinker.log')) ? readFileSync(fake('tinker.log'), 'utf8') : '');

function setApp(id: 1 | 2, value: string) {
  write(fake(`app-${id}`), `${value}\n`);
}

function repoMode() {
  setApp(2, 'dockerfile|||/Dockerfile|worker');
  setApp(1, 'dockerfile|||/Dockerfile|runner');
}

function imageMode(tag = OLD) {
  setApp(2, `dockerimage|${WORKER}|${tag}|/Dockerfile|worker`);
  setApp(1, `dockerimage|${RUNNER}|${tag}|/Dockerfile|runner`);
}

function publish(sha: string, label = sha) {
  write(fake(`ghcr-faktway-worker-${sha}`), label);
  write(fake(`ghcr-faktway-runner-${sha}`), label);
}

function run(script: 'wdroz-produkcje.sh' | 'coolify-zrodlo.sh', args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync('bash', [join(dir, 'scripts/ops', script), ...args], {
    encoding: 'utf8',
    env: {
      NODE_ENV: 'test',
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      HOME: dir,
      FAKE_DIR: fakeDir,
      FAKTFLOW_INFRA_ENV: join(dir, 'infra.env'),
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wdroz-obrazy-'));
  fakeDir = join(dir, 'fake');
  mkdirSync(fakeDir);
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'scripts/ops'), { recursive: true });
  for (const f of ['coolify-wspolne.sh', 'wdroz-produkcje.sh', 'coolify-zrodlo.sh']) {
    copyFileSync(join(SRC, f), join(dir, 'scripts/ops', f));
    chmodSync(join(dir, 'scripts/ops', f), 0o755);
  }
  write(join(dir, 'scripts/ops/kontrola-faktur-ksef.sh'), '#!/usr/bin/env bash\necho kontrola >> "$FAKE_DIR/log"\n', 0o755);
  write(join(dir, 'bin/ssh'), FAKE_SSH, 0o755);
  write(join(dir, 'bin/docker'), FAKE_DOCKER, 0o755);
  write(join(dir, 'bin/curl'), FAKE_CURL, 0o755);
  write(join(dir, 'bin/git'), FAKE_GIT, 0o755);
  write(join(dir, 'bin/df'), FAKE_DF, 0o755);
  write(join(dir, 'bin/sleep'), FAKE_SLEEP, 0o755);
  write(
    join(dir, 'infra.env'),
    'K=/brak/klucza\nOPS=ops.example.test\nAPP=app.example.test\nAPP_PREFIX=apptest\nWORKER_PREFIX=workertest\n',
  );
  write(fake('main-sha'), `${SHA}\n`);
  write(fake('main-history'), `${SHA}\n${OLD}\n`);
  write(fake('free'), '10');
  write(fake('running-2'), `workertest:${OLD}\n`);
  write(fake('running-1'), `apptest:${OLD}\n`);
});

afterEach(() => {
  const queriedGhcr = existsSync(fake('curl.log')) && readFileSync(fake('curl.log'), 'utf8').includes('ghcr.io/');
  const markedGhcr = ghcrTest;
  ghcrTest = false;
  rmSync(dir, { recursive: true, force: true });
  if (queriedGhcr && !markedGhcr) {
    throw new Error('Skrypt odpytał GHCR (atrapa curl), więc ten test musi iść przez itGhcr: bez jq czeka i pada z mylącą asercją.');
  }
  if (!queriedGhcr && markedGhcr) {
    throw new Error(
      'Test idzie przez itGhcr, a skrypt nie odpytał GHCR. Jeśli test padł już wcześniej, zacznij od tamtego błędu (skrypt pewnie odmówił przed GHCR); inaczej test nie potrzebuje itGhcr.',
    );
  }
});

describe('wdroz-produkcje.sh: build z repo (bez argumentów)', () => {
  it('wdraża worker, potem aplikację, z commitem HEAD, i uruchamia kontrolę', () => {
    repoMode();
    const r = run('wdroz-produkcje.sh');
    expect(r.code, r.out).toBe(0);
    expect(log()).toEqual(['wdrozenie 2 HEAD', 'wdrozenie 1 HEAD', 'kontrola']);
  });

  it('odmawia, gdy aplikacja jest już na obrazie z GHCR, i podpowiada --obraz', () => {
    imageMode();
    const r = run('wdroz-produkcje.sh');
    expect(r.code).toBe(1);
    expect(r.out).toContain('--obraz <sha>');
    expect(log()).toEqual([]);
  });

  it('odmawia buildu z pustym celem Dockerfile (ostatni etap zamiast workera)', () => {
    setApp(2, 'dockerfile||||');
    setApp(1, 'dockerfile|||/Dockerfile|runner');
    const r = run('wdroz-produkcje.sh');
    expect(r.code).toBe(1);
    expect(r.out).toContain('coolify-zrodlo.sh repo');
    expect(log()).toEqual([]);
  });
});

describe('wdroz-produkcje.sh --obraz', () => {
  itGhcr('ustawia tag SHA i wdraża worker, potem aplikację, z commitem SHA', () => {
    imageMode();
    publish(SHA);
    const r = run('wdroz-produkcje.sh', ['--obraz', SHA]);
    expect(r.code, r.out).toBe(0);
    expect(log()).toEqual([
      `zmiana 2 dockerimage|${WORKER}|${SHA}|/Dockerfile|worker`,
      `wdrozenie 2 ${SHA}`,
      `zmiana 1 dockerimage|${RUNNER}|${SHA}|/Dockerfile|runner`,
      `wdrozenie 1 ${SHA}`,
      'kontrola',
    ]);
    expect(tinkerLog()).not.toContain('->save(');
  });

  itGhcr('bez SHA bierze origin/main', () => {
    imageMode();
    publish(SHA);
    const r = run('wdroz-produkcje.sh', ['--obraz']);
    expect(r.code, r.out).toBe(0);
    expect(log()).toContain(`wdrozenie 2 ${SHA}`);
  });

  it('odmawia SHA spoza main i niczego nie zmienia', () => {
    imageMode();
    publish(FOREIGN);
    const r = run('wdroz-produkcje.sh', ['--obraz', FOREIGN]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('nie jest na origin/main');
    expect(log()).toEqual([]);
  });

  it('odmawia skróconego SHA', () => {
    imageMode();
    const r = run('wdroz-produkcje.sh', ['--obraz', SHA.slice(0, 8)]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('40 znaków');
    expect(log()).toEqual([]);
  });

  itGhcr('czeka, aż obrazy pojawią się w GHCR, i dopiero wtedy wdraża', () => {
    imageMode();
    write(
      fake('po-sleep'),
      `echo -n ${SHA} > "$FAKE_DIR/ghcr-faktway-worker-${SHA}"; echo -n ${SHA} > "$FAKE_DIR/ghcr-faktway-runner-${SHA}"\n`,
    );
    const r = run('wdroz-produkcje.sh', ['--obraz', SHA]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('jeszcze nie ma w GHCR');
    expect(readFileSync(fake('sleep.log'), 'utf8')).toContain('sleep 30');
    expect(log()).toContain(`wdrozenie 1 ${SHA}`);
  });

  itGhcr('po limicie czekania na obrazy kończy się kodem 1 bez wdrożenia', () => {
    imageMode();
    const r = run('wdroz-produkcje.sh', ['--obraz', SHA], { WDROZ_CZEKAJ_MIN: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('gh workflow run obrazy.yml');
    expect(log()).toEqual([]);
  });

  itGhcr('obraz z etykietą innego commita zatrzymuje wdrożenie od razu', () => {
    imageMode();
    publish(SHA, OLD);
    const r = run('wdroz-produkcje.sh', ['--obraz', SHA]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`etykietę rewizji ${OLD}`);
    expect(log()).toEqual([]);
  });

  itGhcr('za mało miejsca na app-1: nic nie wdraża', () => {
    imageMode();
    publish(SHA);
    write(fake('free'), '2');
    const r = run('wdroz-produkcje.sh', ['--obraz', SHA]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('wolne tylko 2 GB');
    expect(log()).toEqual([]);
  });

  itGhcr('nieudany worker: tag wraca na poprzedni, aplikacja nietknięta', () => {
    imageMode(OLD);
    publish(SHA);
    write(fake('status-2'), 'failed');
    const r = run('wdroz-produkcje.sh', ['--obraz', SHA]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ostatnia linia logu buildu');
    expect(state(2)).toBe(`dockerimage|${WORKER}|${OLD}|/Dockerfile|worker`);
    expect(state(1)).toBe(`dockerimage|${RUNNER}|${OLD}|/Dockerfile|runner`);
    expect(log().filter((l) => l.startsWith('wdrozenie'))).toEqual([`wdrozenie 2 ${SHA}`]);
  });

  itGhcr('nieudana aplikacja po workerze: tag aplikacji wraca, komunikat o stanie mieszanym', () => {
    imageMode(OLD);
    publish(SHA);
    write(fake('status-1'), 'failed');
    const r = run('wdroz-produkcje.sh', ['--obraz', SHA]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('stan mieszany');
    expect(r.out).toContain(`--obraz ${OLD}`);
    expect(state(2)).toBe(`dockerimage|${WORKER}|${SHA}|/Dockerfile|worker`);
    expect(state(1)).toBe(`dockerimage|${RUNNER}|${OLD}|/Dockerfile|runner`);
    expect(log()).not.toContain('kontrola');
  });

  itGhcr('finished, ale kontener na innym obrazie: kod 1 i bez aplikacji', () => {
    imageMode(OLD);
    publish(SHA);
    // Coolify zgłasza finished, ale nie podmienia kontenera.
    write(join(dir, 'bin/docker'), FAKE_DOCKER.replace('echo "$img:$tag" > "$FAKE_DIR/running-$id"', ':'), 0o755);
    const r = run('wdroz-produkcje.sh', ['--obraz', SHA]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('kontener na app-1 działa na');
    expect(log().filter((l) => l.startsWith('wdrozenie'))).toEqual([`wdrozenie 2 ${SHA}`]);
  });

  itGhcr('brak stanu z Coolify (SSH/tinker milczy): stan nieznany, tag zostaje na SHA', () => {
    imageMode(OLD);
    publish(SHA);
    write(fake('status-2'), '');
    const r = run('wdroz-produkcje.sh', ['--obraz', SHA]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Stan nieznany');
    expect(r.out).not.toContain('przywracam tag');
    expect(state(2)).toBe(`dockerimage|${WORKER}|${SHA}|/Dockerfile|worker`);
    expect(log().filter((l) => l.startsWith('wdrozenie'))).toEqual([`wdrozenie 2 ${SHA}`]);
  });

  itGhcr('stary kontener chwilę na liście: czeka, aż zostanie tylko nowy', () => {
    imageMode(OLD);
    publish(SHA);
    // Po wdrożeniu workera stary kontener jeszcze widać; znika po pierwszym czekaniu.
    write(
      join(dir, 'bin/docker'),
      FAKE_DOCKER.replace(
        '[ -f "$FAKE_DIR/running-2" ] && echo "workertest-20261108 $(cat "$FAKE_DIR/running-2")"',
        '[ -f "$FAKE_DIR/running-2" ] && echo "workertest-20261108 $(cat "$FAKE_DIR/running-2")"\n    [ -f "$FAKE_DIR/stary-2" ] && echo "workertest-20261101 workertest:' + OLD + '"',
      ),
      0o755,
    );
    write(fake('stary-2'), '1');
    // Pierwsze czekanie to odpytywanie kolejki; stary znika dopiero przy drugim.
    write(fake('po-sleep'), '[ "$(wc -l < "$FAKE_DIR/sleep.log")" -ge 2 ] || exit 1\nrm -f "$FAKE_DIR/stary-2"\n');
    const r = run('wdroz-produkcje.sh', ['--obraz', SHA]);
    expect(r.code, r.out).toBe(0);
    expect(log()).toContain('kontrola');
  });

  it('aplikacje na buildzie z repo: odmawia i podpowiada coolify-zrodlo.sh obraz', () => {
    repoMode();
    publish(SHA);
    const r = run('wdroz-produkcje.sh', ['--obraz', SHA]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('coolify-zrodlo.sh obraz');
    expect(log()).toEqual([]);
  });
});

describe('coolify-zrodlo.sh', () => {
  itGhcr('obraz bez SHA: bierze SHA działających kontenerów, worker przed aplikacją, bez wdrożenia', () => {
    repoMode();
    publish(OLD);
    const r = run('coolify-zrodlo.sh', ['obraz']);
    expect(r.code, r.out).toBe(0);
    expect(log()).toEqual([
      `zmiana 2 dockerimage|${WORKER}|${OLD}|/Dockerfile|worker`,
      `zmiana 1 dockerimage|${RUNNER}|${OLD}|/Dockerfile|runner`,
    ]);
    expect(r.out).toContain(`wdroz-produkcje.sh --obraz ${OLD}`);
    expect(r.out).toContain('Bramka /wdroz');
    expect(tinkerLog()).toContain('whereKey(2)->update(');
    expect(tinkerLog()).not.toContain('->save(');
  });

  it('repo: przywraca Dockerfile i jawny cel, czyści obraz i tag (inaczej Coolify pchałby build do GHCR)', () => {
    imageMode(SHA);
    const r = run('coolify-zrodlo.sh', ['repo']);
    expect(r.code, r.out).toBe(0);
    expect(state(2)).toBe('dockerfile|||/Dockerfile|worker');
    expect(state(1)).toBe('dockerfile|||/Dockerfile|runner');
    expect(log()[0]).toMatch(/^zmiana 2 /);
    expect(log().filter((l) => l.startsWith('wdrozenie'))).toEqual([]);
  });

  it('repo naprawia też wyczyszczony cel (zmiana build_pack w panelu Coolify)', () => {
    setApp(2, 'dockerfile||||');
    setApp(1, `dockerimage|${RUNNER}|${SHA}||`);
    const r = run('coolify-zrodlo.sh', ['repo']);
    expect(r.code, r.out).toBe(0);
    expect(state(2)).toBe('dockerfile|||/Dockerfile|worker');
    expect(state(1)).toBe('dockerfile|||/Dockerfile|runner');
  });

  it('obraz odmawia, gdy cel aplikacji nie pasuje do id (rozjazd przypisania)', () => {
    setApp(2, 'dockerfile|||/Dockerfile|runner');
    setApp(1, 'dockerfile|||/Dockerfile|runner');
    publish(OLD);
    const r = run('coolify-zrodlo.sh', ['obraz', OLD]);
    expect(r.code).toBe(1);
    expect(log()).toEqual([]);
  });

  itGhcr('obraz odmawia bez obrazów w GHCR i niczego nie zmienia', () => {
    repoMode();
    const r = run('coolify-zrodlo.sh', ['obraz', OLD]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Brak obrazów');
    expect(log()).toEqual([]);
    expect(existsSync(fake('sleep.log'))).toBe(false);
  });

  it('obraz odmawia, gdy kontenery działają na różnych SHA, a SHA nie podano', () => {
    repoMode();
    write(fake('running-1'), `apptest:${SHA}\n`);
    const r = run('coolify-zrodlo.sh', ['obraz']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('podaj SHA wprost');
    expect(log()).toEqual([]);
  });

  it('stan tylko czyta', () => {
    imageMode(SHA);
    const r = run('coolify-zrodlo.sh', ['stan']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`obraz z GHCR: ${WORKER}:${SHA}`);
    expect(r.out).toContain(`kontener na app-1: ${OLD}`);
    expect(tinkerLog()).not.toContain('ZMIANA');
    expect(log()).toEqual([]);
  });

  itGhcr('obraz --wdroz przełącza i od razu wdraża ten sam SHA', () => {
    repoMode();
    publish(OLD);
    const r = run('coolify-zrodlo.sh', ['obraz', OLD, '--wdroz']);
    expect(r.code, r.out).toBe(0);
    expect(log().filter((l) => !l.startsWith('zmiana'))).toEqual([`wdrozenie 2 ${OLD}`, `wdrozenie 1 ${OLD}`, 'kontrola']);
  });

  itGhcr('obraz --wdroz przy braku miejsca na app-1 niczego nie przełącza', () => {
    repoMode();
    publish(OLD);
    write(fake('free'), '2');
    const r = run('coolify-zrodlo.sh', ['obraz', OLD, '--wdroz']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('wolne tylko 2 GB');
    expect(log()).toEqual([]);
    expect(state(2)).toBe('dockerfile|||/Dockerfile|worker');
  });

  it('repo --wdroz wraca i wdraża buildem z repo', () => {
    imageMode(SHA);
    const r = run('coolify-zrodlo.sh', ['repo', '--wdroz']);
    expect(r.code, r.out).toBe(0);
    expect(log().filter((l) => !l.startsWith('zmiana'))).toEqual(['wdrozenie 2 HEAD', 'wdrozenie 1 HEAD', 'kontrola']);
  });
});
