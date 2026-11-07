/**
 * Alarm krytyczny → issue na GitHubie (plan usprawnień 3.5).
 *
 * Monitor alarmów krytycznych zgłasza tu każdy odpalony alarm, OBOK Slacka
 * i Telegrama. Jeden rodzaj błędu = jedno otwarte issue: odcisk (źródło + kod)
 * siedzi w ukrytym znaczniku HTML w treści, a kolejne wystąpienie podbija
 * licznik w treści i co najwyżej raz na godzinę dopisuje komentarz.
 * Etykietę `agent:napraw` (start agenta kodu, `.github/workflows/agent.yml`)
 * dodaje zawsze człowiek — ten moduł nigdy.
 *
 * **Repozytorium jest publiczne, więc issue też.** Treść powstaje wyłącznie
 * z listy dozwolonych pól: kod z `CRITICAL_ISSUE_CODES`, źródło
 * z `CRITICAL_ISSUE_SOURCES`, licznik, czasy ISO, SHA (tylko hex) i stały
 * odnośnik do `/admin/centrum/bledy`. Wejście nie ma pola na opis ani
 * kontekst, a stan z istniejącego issue przechodzi tylko przez ścisłe wzorce.
 * Pilnuje tego `tests/unit/alert-github-issue.test.ts`.
 *
 * Konfiguracja (tylko worker, Coolify id=2):
 *   - `GITHUB_ALERT_ISSUES_TOKEN` — fine-grained token, wyłącznie Issues: write
 *     na to repo. Pusty = moduł nic nie robi.
 *   - `GITHUB_ALERT_ISSUES_REPO` — `właściciel/repo`, domyślnie FaktWay.
 *
 * Fail-soft: żaden błąd GitHuba nie wychodzi poza moduł, a token, adres i treść
 * odpowiedzi nigdy nie trafiają do logów.
 *
 * Ponowienie joba (pg-boss wykonuje cały handler od nowa): przed założeniem
 * issue zawsze czytamy listę otwartych issue alarmów (API listy, nie wyszukiwarki,
 * więc bez opóźnienia indeksu), więc drugie wywołanie trafia w istniejące issue.
 * Najgorszy skutek ponowienia to licznik większy o jeden.
 */

import { PUBLIC_SITE_URL, siteUrl } from '@/lib/site';

/** Kody alarmów monitora z opisem do tytułu. Stałe teksty, bez danych. */
export const CRITICAL_ISSUE_CODES = {
  ksef_down: 'KSeF API niedostępny',
  offline_backlog: 'Kolejka Offline24 rośnie',
  offline_environment_blocked: 'Kolejka offline w innym środowisku KSeF',
  inngest_failures: 'Wiele nieudanych jobów',
  payment_failures: 'Wiele nieudanych płatności',
  stale_refund_operations: 'Zwrot płatności utknął',
  stale_stripe_webhooks: 'Webhook Stripe utknął',
  open_stripe_financial_cases: 'Otwarte sprawy finansowe Stripe',
  stale_stripe_checkout_attempts: 'Próba Checkout utknęła',
  stale_stripe_customer_attempts: 'Tworzenie klienta Stripe utknęło',
  stale_dunning_notifications: 'Powiadomienie o zaległości utknęło',
  stale_ksef_sending_invoices: 'Faktura w wysyłce do KSeF bez wyniku',
  stale_billing_vat_enqueues: 'Faktura VAT abonamentu nie wystartowała',
  paid_without_vat_invoice: 'Opłacone bez faktury VAT',
  ksef_reconciliation: 'Niezgodność stanu KSeF do uzgodnienia',
  ksef_lifecycle_violations: 'Naruszenie cyklu życia faktury',
  stale_backup: 'Kopia bazy jest nieaktualna',
  stale_inbox_sync: 'Skrzynka KSeF zaległa',
  stale_ksef_history_sync: 'Historia KSeF stoi',
  ksef_history_blocked: 'Historia KSeF: faktury do operatora',
  ksef_history_rate_limited: 'Historia KSeF: limit 429 u wielu firm',
} as const satisfies Record<string, string>;

export const CRITICAL_ISSUE_SOURCE_MONITOR = 'cron.critical-alerts-monitor';
const CRITICAL_ISSUE_SOURCES: readonly string[] = [CRITICAL_ISSUE_SOURCE_MONITOR];

export const ALERT_ISSUE_LABEL = 'alert-produkcji';

const DEFAULT_REPO = 'ezior8888-cpu/FaktWay';
const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 5000;
const COMMENT_MIN_INTERVAL_MS = 60 * 60 * 1000;
const MAX_NEW_ISSUES_PER_HOUR = 3;
const MAX_OPEN_ALERT_ISSUES = 15;
const DETAILS_PATH = '/admin/centrum/bledy';

export interface CriticalIssueOccurrence {
  code: string;
  source: string;
}

export interface CriticalIssueReport {
  enabled: boolean;
  created: number;
  updated: number;
  commented: number;
  /** Pominięte przez limit nowych albo otwartych issue. */
  skipped: number;
  /** Kod albo źródło spoza listy dozwolonych. */
  rejected: number;
  failed: number;
}

interface IssueState {
  first: string;
  last: string;
  commented: string;
  count: number;
}

interface OpenAlertIssue {
  number: number;
  fingerprint: string;
  state: IssueState | null;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const FINGERPRINT_RE = /^[a-z0-9._-]+:[a-z0-9_]+$/;
const MARKER_FP_RE = /<!-- faktway-alert v1 fp=([a-z0-9._:-]+)[ -]/;
const MARKER_STATE_RE =
  /<!-- faktway-alert v1 fp=[a-z0-9._:-]+ first=(\S+) last=(\S+) commented=(\S+) count=(\d{1,9}) -->/;

function config(): { token: string; repo: string } | null {
  const token = process.env.GITHUB_ALERT_ISSUES_TOKEN?.trim();
  if (!token) return null;
  const repo = process.env.GITHUB_ALERT_ISSUES_REPO?.trim() || DEFAULT_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  return { token, repo };
}

function isAllowedCode(code: string): code is keyof typeof CRITICAL_ISSUE_CODES {
  return Object.hasOwn(CRITICAL_ISSUE_CODES, code);
}

/** SHA wdrożenia (Coolify: `SOURCE_COMMIT`), tylko gdy wygląda na hex. */
function deploymentSha(): string | null {
  const raw = (process.env.SOURCE_COMMIT || process.env.GIT_COMMIT_SHA || '').trim();
  return /^[0-9a-f]{7,40}$/i.test(raw) ? raw.slice(0, 12).toLowerCase() : null;
}

/** Sam origin aplikacji (https), bez ścieżki i parametrów ze zmiennej. */
function detailsUrl(): string {
  let origin = PUBLIC_SITE_URL;
  try {
    const url = new URL(siteUrl());
    if (url.protocol === 'https:' && !url.username && !url.password) origin = url.origin;
  } catch {
    // zostaje adres publiczny
  }
  return origin + DETAILS_PATH;
}

function parseState(body: string): IssueState | null {
  const m = body.match(MARKER_STATE_RE);
  if (!m) return null;
  const [, first, last, commented, count] = m;
  if (![first, last, commented].every((v) => ISO_RE.test(v!))) return null;
  return { first: first!, last: last!, commented: commented!, count: Number(count) };
}

function renderTitle(code: keyof typeof CRITICAL_ISSUE_CODES): string {
  return `Alarm produkcji: ${CRITICAL_ISSUE_CODES[code]} (${code})`;
}

function renderBody(
  code: keyof typeof CRITICAL_ISSUE_CODES,
  source: string,
  state: IssueState,
): string {
  const sha = deploymentSha();
  return [
    `<!-- faktway-alert v1 fp=${source}:${code} first=${state.first} last=${state.last} commented=${state.commented} count=${state.count} -->`,
    `**Alarm krytyczny z produkcji: ${CRITICAL_ISSUE_CODES[code]}**`,
    '',
    '| Pole | Wartość |',
    '|---|---|',
    `| Kod błędu | \`${code}\` |`,
    `| Źródło | \`${source}\` |`,
    `| Liczba wystąpień | ${state.count} |`,
    `| Pierwsze wystąpienie | ${state.first} |`,
    `| Ostatnie wystąpienie | ${state.last} |`,
    `| Wdrożenie (SHA) | ${sha ? `\`${sha}\`` : 'nieznane'} |`,
    '',
    `Szczegóły (tylko operator, logowanie z 2FA): ${detailsUrl()}`,
    '',
    'Issue zakłada i aktualizuje automat (`lib/alerts/github-issue.ts`) z listy dozwolonych pól. Repozytorium jest publiczne: nie dopisuj tu danych klientów, odpowiedzi KSeF ani logów 1:1.',
    'Etykietę `agent:napraw` dodaje człowiek, gdy to błąd w kodzie. Po naprawie zamknij issue; kolejne wystąpienie założy nowe.',
  ].join('\n');
}

function renderComment(state: IssueState): string {
  const sha = deploymentSha();
  return `Kolejne wystąpienie: nr ${state.count}, ${state.last}, wdrożenie ${sha ? `\`${sha}\`` : 'nieznane'}.`;
}

class GitHubRequestError extends Error {}

async function github<T>(
  cfg: { token: string; repo: string },
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${GITHUB_API}/repos/${cfg.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'faktway-alerts',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    // Bez treści odpowiedzi w wyjątku: może zawierać szczegóły tokenu.
    if (!response.ok) throw new GitHubRequestError(`GitHub ${method} HTTP ${response.status}`);
    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof GitHubRequestError) throw err;
    throw new GitHubRequestError(`GitHub ${method} not completed`);
  } finally {
    clearTimeout(timeout);
  }
}

interface ListedIssue {
  number: number;
  body?: string | null;
  created_at: string;
  pull_request?: unknown;
}

async function listOpenAlertIssues(cfg: { token: string; repo: string }) {
  const listed = await github<ListedIssue[]>(
    cfg,
    'GET',
    `/issues?state=open&labels=${encodeURIComponent(ALERT_ISSUE_LABEL)}&per_page=100`,
  );
  return listed.filter((issue) => !issue.pull_request);
}

/**
 * Zakłada albo aktualizuje issue dla każdego odpalonego alarmu. Nigdy nie
 * rzuca; wynik służy tylko do logu joba.
 */
export async function reportCriticalIssues(
  occurrences: readonly CriticalIssueOccurrence[],
  now: Date = new Date(),
): Promise<CriticalIssueReport> {
  const report: CriticalIssueReport = {
    enabled: false, created: 0, updated: 0, commented: 0, skipped: 0, rejected: 0, failed: 0,
  };

  // Tylko pola z listy dozwolonych; reszta obiektu wejścia nie istnieje.
  const accepted: { code: keyof typeof CRITICAL_ISSUE_CODES; source: string }[] = [];
  for (const { code, source } of occurrences) {
    if (!isAllowedCode(code) || !CRITICAL_ISSUE_SOURCES.includes(source)) {
      report.rejected++;
      continue;
    }
    if (!accepted.some((a) => a.code === code && a.source === source)) accepted.push({ code, source });
  }
  if (report.rejected > 0) {
    console.warn(`[github-issue] ${report.rejected} alarm(y) spoza listy dozwolonych kodów pominięte`);
  }

  const cfg = config();
  if (!cfg || accepted.length === 0) return report;
  report.enabled = true;

  const nowIso = now.toISOString();
  let open: OpenAlertIssue[];
  let createdLastHour: number;
  let pageFull: boolean;
  try {
    const listed = await listOpenAlertIssues(cfg);
    open = listed.flatMap((issue) => {
      const fp = (issue.body ?? '').match(MARKER_FP_RE)?.[1];
      if (!fp || !FINGERPRINT_RE.test(fp)) return [];
      return [{ number: issue.number, fingerprint: fp, state: parseState(issue.body ?? '') }];
    });
    createdLastHour = listed.filter(
      (issue) => now.getTime() - Date.parse(issue.created_at) < 60 * 60 * 1000,
    ).length;
    // Strona ma 100 pozycji; pełna strona = na pewno ponad limit otwartych.
    pageFull = listed.length >= 100;
  } catch (err) {
    report.failed += accepted.length;
    console.error(`[github-issue] lista issue niedostępna: ${(err as Error).message}`);
    return report;
  }
  let openCount = open.length;

  for (const { code, source } of accepted) {
    const fingerprint = `${source}:${code}`;
    const existing = open.find((issue) => issue.fingerprint === fingerprint);
    try {
      if (existing) {
        const prev = existing.state;
        const shouldComment =
          !prev || now.getTime() - Date.parse(prev.commented) >= COMMENT_MIN_INTERVAL_MS;
        const state: IssueState = {
          first: prev?.first ?? nowIso,
          last: nowIso,
          commented: shouldComment ? nowIso : prev!.commented,
          count: (prev?.count ?? 1) + 1,
        };
        // Najpierw licznik w treści, potem komentarz: ponowienie po komentarzu
        // widzi już nowy czas komentarza i nie dubluje go.
        await github(cfg, 'PATCH', `/issues/${existing.number}`, {
          body: renderBody(code, source, state),
        });
        existing.state = state;
        report.updated++;
        if (shouldComment) {
          await github(cfg, 'POST', `/issues/${existing.number}/comments`, {
            body: renderComment(state),
          });
          report.commented++;
        }
        continue;
      }

      if (
        pageFull ||
        createdLastHour >= MAX_NEW_ISSUES_PER_HOUR ||
        openCount >= MAX_OPEN_ALERT_ISSUES
      ) {
        report.skipped++;
        continue;
      }
      const state: IssueState = { first: nowIso, last: nowIso, commented: nowIso, count: 1 };
      const created = await github<{ number: number }>(cfg, 'POST', '/issues', {
        title: renderTitle(code),
        body: renderBody(code, source, state),
        labels: [ALERT_ISSUE_LABEL],
      });
      open.push({ number: created.number, fingerprint, state });
      openCount++;
      createdLastHour++;
      report.created++;
    } catch (err) {
      report.failed++;
      console.error(`[github-issue] ${code}: ${(err as Error).message}`);
    }
  }

  if (report.skipped > 0) {
    console.warn(`[github-issue] limit issue alarmów: ${report.skipped} pominięte`);
  }
  return report;
}
