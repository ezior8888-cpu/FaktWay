// Klienci usług zewnętrznych bramki: Telegram (long polling), Coolify API,
// GitHub API, rejestr GHCR. Każdy przyjmuje `fetchImpl`, żeby testy działały bez sieci.
// Treści błędów nie zawierają tokenów ani nagłówków.

const TIMEOUT_MS = 30_000;

async function requestJson(fetchImpl, url, { method = 'GET', headers = {}, body, timeoutMs = TIMEOUT_MS, label }) {
  const res = await fetchImpl(url, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    // Komunikat serwisu (np. Coolify „Deployment queue full”) bez nagłówków i tokenów.
    const detail = typeof json?.message === 'string' ? ` (${json.message.slice(0, 200)})` : '';
    const err = new Error(`${label}: HTTP ${res.status}${detail}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ── Telegram ────────────────────────────────────────────────────────────

export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function createTelegram({ token, fetchImpl = fetch }) {
  const base = `https://api.telegram.org/bot${token}`;
  async function call(method, params, timeoutMs) {
    const json = await requestJson(fetchImpl, `${base}/${method}`, {
      method: 'POST', body: params, timeoutMs, label: `Telegram ${method}`,
    });
    if (!json?.ok) throw new Error(`Telegram ${method}: odpowiedź bez ok`);
    return json.result;
  }
  return {
    /** Long polling: czeka do 25 s na nowe wiadomości. */
    getUpdates(offset) {
      return call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 40_000);
    },
    sendMessage(chatId, html) {
      return call('sendMessage', {
        chat_id: chatId, text: html.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true,
      });
    },
    /** Long polling i webhook wykluczają się — usuwamy ewentualny stary webhook. */
    deleteWebhook() {
      return call('deleteWebhook', { drop_pending_updates: false });
    },
  };
}

// ── Coolify ─────────────────────────────────────────────────────────────

export function createCoolify({ baseUrl, token, fetchImpl = fetch }) {
  const call = (method, path, body) => requestJson(fetchImpl, `${baseUrl}${path}`, {
    method, body, headers: { Authorization: `Bearer ${token}` }, label: `Coolify ${method} ${path.split('?')[0]}`,
  });
  return {
    /** Wyzwala wdrożenie aplikacji (zawsze HEAD gałęzi ustawionej w Coolify). */
    async deploy(appUuid) {
      const json = await call('POST', '/deploy', { uuid: appUuid, force: false });
      const dep = json?.deployments?.find((d) => d.resource_uuid === appUuid);
      if (!dep?.deployment_uuid) throw new Error(`Coolify nie przyjął wdrożenia: ${dep?.message ?? 'brak odpowiedzi'}`);
      return dep.deployment_uuid;
    },
    async deployment(deploymentUuid) {
      const d = await call('GET', `/deployments/${encodeURIComponent(deploymentUuid)}`);
      return { status: d?.status ?? 'unknown', commit: d?.commit ?? null };
    },
    /** Commit ostatniego zakończonego wdrożenia aplikacji (albo null). */
    async lastFinishedCommit(appUuid) {
      const json = await call('GET', `/deployments/applications/${encodeURIComponent(appUuid)}?skip=0&take=15`);
      const finished = (json?.deployments ?? []).find((d) => d.status === 'finished' && d.commit && d.commit !== 'HEAD');
      return finished?.commit ?? null;
    },
    /** Wdrożenia w kolejce albo w toku na serwerach zespołu. */
    async running() {
      const list = await call('GET', '/deployments');
      return (Array.isArray(list) ? list : []).map((d) => ({ app: d.application_name ?? '?', status: d.status }));
    },
    async appStatus(appUuid) {
      const a = await call('GET', `/applications/${encodeURIComponent(appUuid)}`);
      return a?.status ?? 'unknown';
    },
    /** Źródło aplikacji: `dockerfile` (build z repo) albo `dockerimage` (obraz z GHCR). */
    async source(appUuid) {
      const a = await call('GET', `/applications/${encodeURIComponent(appUuid)}`);
      return {
        buildPack: a?.build_pack ?? null,
        image: a?.docker_registry_image_name || null,
        tag: a?.docker_registry_image_tag || null,
      };
    },
    /**
     * Wdrożenie obrazu `<obraz>:<sha>` aplikacji `dockerimage`. Endpoint
     * „rollback” Coolify (4.6) kolejkuje wdrożenie z `rollback: true`
     * i `commit: <sha>`: tag obrazu = commit, w kolejce i w SOURCE_COMMIT
     * kontenera jest SHA. Wystarczy uprawnienie `deploy` (bez `write`).
     * Tag zapisany w konfiguracji aplikacji zostaje bez zmian.
     */
    async deployImage(appUuid, sha) {
      const json = await call('POST', `/applications/${encodeURIComponent(appUuid)}/rollback`, { commit: sha });
      if (!json?.deployment_uuid) throw new Error(`Coolify nie przyjął wdrożenia obrazu: ${json?.message ?? 'brak odpowiedzi'}`);
      return json.deployment_uuid;
    },
  };
}

// ── GHCR ────────────────────────────────────────────────────────────────

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',');

/**
 * Rejestr GHCR, pakiety publiczne (token anonimowy). `revision` zwraca
 * etykietę `org.opencontainers.image.revision` obrazu `<obraz>:<tag>`
 * (platforma linux/amd64) albo null, gdy tagu nie ma.
 */
export function createGhcr({ fetchImpl = fetch } = {}) {
  return {
    async revision(image, tag) {
      const repo = String(image).replace(/^ghcr\.io\//, '');
      const { token } = await requestJson(fetchImpl, `https://ghcr.io/token?scope=repository:${repo}:pull`, { label: 'GHCR token' });
      const headers = { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT };
      const manifestAt = (ref) => requestJson(fetchImpl, `https://ghcr.io/v2/${repo}/manifests/${ref}`, { headers, label: 'GHCR manifest' });
      let manifest;
      try {
        manifest = await manifestAt(tag);
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
      // buildx z atestacjami wypycha indeks; bierzemy z niego obraz linux/amd64.
      const amd64 = manifest?.manifests?.find((m) => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64');
      if (amd64) manifest = await manifestAt(amd64.digest);
      const configDigest = manifest?.config?.digest;
      if (!configDigest) return null;
      // Blob przekierowuje na podpisany adres innego hosta; fetch nie przenosi
      // tam nagłówka Authorization.
      const config = await requestJson(fetchImpl, `https://ghcr.io/v2/${repo}/blobs/${configDigest}`, {
        headers: { Authorization: `Bearer ${token}` }, label: 'GHCR config',
      });
      return config?.config?.Labels?.['org.opencontainers.image.revision'] ?? null;
    },
  };
}

// ── GitHub ──────────────────────────────────────────────────────────────

const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

/** Podsumowanie kontroli dla commita (czysta funkcja — testowana osobno). */
export function summarizeChecks(runs, required) {
  const byName = new Map();
  for (const r of runs) {
    // Ponowione joby: liczy się najnowszy przebieg o danej nazwie.
    const prev = byName.get(r.name);
    if (!prev || (r.id ?? 0) > (prev.id ?? 0)) byName.set(r.name, r);
  }
  const all = [...byName.values()];
  const failed = all.filter((r) => r.status === 'completed' && FAILED_CONCLUSIONS.has(r.conclusion)).map((r) => r.name);
  const pending = all.filter((r) => r.status !== 'completed').map((r) => r.name);
  const missing = required.filter((name) => !byName.has(name));
  return {
    total: all.length,
    passed: all.length - failed.length - pending.length,
    failed,
    pending,
    missing,
    ok: all.length > 0 && failed.length === 0 && pending.length === 0 && missing.length === 0,
  };
}

/** Numery migracji dodanych/zmienionych w porównaniu commitów. */
export function migrationVersions(files) {
  return files
    .map((f) => /^supabase\/migrations\/(\d{5})_[^/]+\.sql$/.exec(f.filename ?? f))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
}

export function createGithub({ repo, token, fetchImpl = fetch }) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const call = (path) => requestJson(fetchImpl, `https://api.github.com/repos/${repo}${path}`, {
    headers: { ...headers, 'X-GitHub-Api-Version': '2022-11-28' }, label: `GitHub ${path.split('?')[0]}`,
  });
  return {
    async headSha(branch) {
      const b = await call(`/branches/${encodeURIComponent(branch)}`);
      return b?.commit?.sha ?? null;
    },
    async checkRuns(sha) {
      const json = await call(`/commits/${sha}/check-runs?per_page=100`);
      return json?.check_runs ?? [];
    },
    async compare(base, head) {
      const json = await call(`/compare/${base}...${head}`);
      return { aheadBy: json?.ahead_by ?? 0, files: json?.files ?? [], commits: (json?.commits ?? []).map((c) => c.commit?.message?.split('\n')[0] ?? '') };
    },
    async migrationsAt(sha) {
      const list = await call(`/contents/supabase/migrations?ref=${sha}`);
      return migrationVersions((Array.isArray(list) ? list : []).map((f) => ({ filename: `supabase/migrations/${f.name}` })));
    },
  };
}
