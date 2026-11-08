import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALERT_ISSUE_LABEL,
  CRITICAL_ISSUE_CODES,
  CRITICAL_ISSUE_SOURCE_MONITOR,
  reportCriticalIssues,
  resetGitHubIssueLimitsForTests,
} from '@/lib/alerts/github-issue';

// Plan usprawnień 3.5: alarm krytyczny zakłada albo aktualizuje issue na
// publicznym repo. Atrapa GitHuba trzyma issue w pamięci, więc testy widzą
// dokładnie to, co poszłoby do API.

const TOKEN = 'github_pat_synthetic_test_token';
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const NOW = new Date('2026-11-07T10:00:00.000Z');
const SOURCE = CRITICAL_ISSUE_SOURCE_MONITOR;

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
  created_at: string;
  state: 'open';
  pull_request?: unknown;
}

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

function fakeGitHub(initial: FakeIssue[] = [], options: { dropLabels?: boolean } = {}) {
  const issues = [...initial];
  const comments: { issue: number; body: string }[] = [];
  const calls: Call[] = [];
  let failWith: number | null = null;
  let next = 100;

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({
      method,
      path: url.pathname + url.search,
      body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (failWith !== null) return new Response('{"message":"boom"}', { status: failWith });

    const m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues(?:\/(\d+)(\/comments)?)?$/);
    if (!m) return new Response('not found', { status: 404 });
    const [, num, isComments] = m;
    if (!num && method === 'GET') {
      const label = url.searchParams.get('labels');
      return Response.json(issues.filter((i) => i.labels.some((l) => l.name === label)));
    }
    if (!num && method === 'POST') {
      const issue: FakeIssue = {
        number: next++,
        title: String(body!.title),
        body: String(body!.body),
        // GitHub po cichu pomija etykiety, których token nie może nadać.
        labels: options.dropLabels ? [] : ((body!.labels as string[]) ?? []).map((name) => ({ name })),
        created_at: NOW.toISOString(),
        state: 'open',
      };
      issues.push(issue);
      return Response.json(issue, { status: 201 });
    }
    const issue = issues.find((i) => i.number === Number(num));
    if (!issue) return new Response('not found', { status: 404 });
    if (isComments && method === 'POST') {
      comments.push({ issue: issue.number, body: String(body!.body) });
      return Response.json({ id: comments.length }, { status: 201 });
    }
    if (method === 'PATCH') {
      issue.body = String(body!.body);
      return Response.json(issue);
    }
    return new Response('unexpected', { status: 405 });
  });

  return {
    issues,
    comments,
    calls,
    fetchMock,
    fail(status: number) {
      failWith = status;
    },
    writes: () => calls.filter((c) => c.method !== 'GET'),
  };
}

function minutesAgo(min: number): Date {
  return new Date(NOW.getTime() - min * 60_000);
}

beforeEach(() => {
  resetGitHubIssueLimitsForTests();
  vi.stubEnv('GITHUB_ALERT_ISSUES_TOKEN', TOKEN);
  vi.stubEnv('GITHUB_ALERT_ISSUES_REPO', 'ezior8888-cpu/FaktWay');
  vi.stubEnv('SOURCE_COMMIT', SHA);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://faktway.pl');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('issue z alarmu: brak tokenu', () => {
  it('bez tokenu nic nie robi, nie woła sieci i nie rzuca', async () => {
    vi.stubEnv('GITHUB_ALERT_ISSUES_TOKEN', '');
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);

    const result = await reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], NOW);

    expect(gh.fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ enabled: false, created: 0, updated: 0 });
  });

  it('pusta lista alarmów nie woła sieci', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    await reportCriticalIssues([], NOW);
    expect(gh.fetchMock).not.toHaveBeenCalled();
  });

  it('awaria GitHuba nie rzuca (Telegram i Slack poszły wcześniej) i nie wypisuje tokenu', async () => {
    const gh = fakeGitHub();
    gh.fail(500);
    vi.stubGlobal('fetch', gh.fetchMock);

    await expect(
      reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], NOW),
    ).resolves.toMatchObject({ failed: 1 });
    const logged = [
      ...vi.mocked(console.error).mock.calls,
      ...vi.mocked(console.warn).mock.calls,
    ].flat().map(String).join('\n');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('boom');
  });

  it('wyjątek sieci (timeout) też nie rzuca', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('aborted');
    }));
    await expect(
      reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], NOW),
    ).resolves.toMatchObject({ failed: 1 });
  });
});

describe('issue z alarmu: deduplikacja', () => {
  it('pierwsze wystąpienie zakłada jedno issue z etykietą alarmu, bez agent:napraw', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);

    const result = await reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], NOW);

    expect(result).toMatchObject({ enabled: true, created: 1, updated: 0 });
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]!.labels.map((l) => l.name)).toEqual([ALERT_ISSUE_LABEL]);
    for (const call of gh.writes()) {
      expect(JSON.stringify(call.body)).not.toContain('agent:napraw"');
      expect(call.body?.labels ?? []).not.toContain('agent:napraw');
    }
    expect(gh.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(gh.calls[0]!.path).toContain(`labels=${encodeURIComponent(ALERT_ISSUE_LABEL)}`);
    expect(gh.calls[0]!.path).toContain('state=open');
  });

  it('kolejne wystąpienie aktualizuje to samo issue: licznik i czas, bez nowego issue', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    await reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], minutesAgo(120));
    const result = await reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], NOW);

    expect(result).toMatchObject({ created: 0, updated: 1, commented: 1 });
    expect(gh.issues).toHaveLength(1);
    expect(gh.issues[0]!.body).toContain('| Liczba wystąpień | 2 |');
    expect(gh.issues[0]!.body).toContain(`| Ostatnie wystąpienie | ${NOW.toISOString()} |`);
    expect(gh.issues[0]!.body).toContain(`| Pierwsze wystąpienie | ${minutesAgo(120).toISOString()} |`);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain('nr 2');
    expect(gh.comments[0]!.body).toContain(NOW.toISOString());
  });

  it('ponowienie joba (to samo wywołanie dwa razy) nie zakłada drugiego issue', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    await reportCriticalIssues([{ code: 'stale_backup', source: SOURCE }], NOW);
    await reportCriticalIssues([{ code: 'stale_backup', source: SOURCE }], NOW);
    expect(gh.issues).toHaveLength(1);
  });

  it('różne kody to różne issue; ten sam kod dwa razy w jednym przebiegu to jedno', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    await reportCriticalIssues(
      [
        { code: 'ksef_down', source: SOURCE },
        { code: 'stale_backup', source: SOURCE },
        { code: 'ksef_down', source: SOURCE },
      ],
      NOW,
    );
    expect(gh.issues.map((i) => i.title)).toHaveLength(2);
  });

  it('issue bez etykiety alarmu (np. założone przez obcego z tym samym znacznikiem) nie jest brane pod uwagę', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    await reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], minutesAgo(120));
    const forged = { ...gh.issues[0]!, number: 7, labels: [] };
    gh.issues.splice(0, 1, forged);

    await reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], NOW);

    expect(gh.issues.filter((i) => i.labels.length > 0)).toHaveLength(1);
    expect(gh.writes().some((c) => c.method === 'PATCH' && c.path.endsWith('/issues/7'))).toBe(false);
  });

  it('pull request z etykietą i znacznikiem nie jest traktowany jak issue', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    await reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], minutesAgo(120));
    gh.issues[0]!.pull_request = { url: 'x' };

    await reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], NOW);

    expect(gh.writes().filter((c) => c.method === 'POST' && c.path.endsWith('/issues'))).toHaveLength(2);
  });
});

describe('issue z alarmu: limit częstotliwości', () => {
  it('komentarz najwyżej raz na godzinę; licznik w treści rośnie zawsze', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    await reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], minutesAgo(40));
    const result = await reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], NOW);

    expect(result).toMatchObject({ updated: 1, commented: 0 });
    expect(gh.comments).toHaveLength(0);
    expect(gh.issues[0]!.body).toContain('| Liczba wystąpień | 2 |');
  });

  it('najwyżej 3 nowe issue na godzinę, reszta czeka (nie zalewa repo)', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    const codes = Object.keys(CRITICAL_ISSUE_CODES).slice(0, 6);

    const result = await reportCriticalIssues(codes.map((code) => ({ code, source: SOURCE })), NOW);

    expect(gh.issues).toHaveLength(3);
    expect(result).toMatchObject({ created: 3, skipped: 3 });
  });

  it('limit liczy też issue założone w poprzednich przebiegach w ostatniej godzinie', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    const codes = Object.keys(CRITICAL_ISSUE_CODES);
    await reportCriticalIssues(codes.slice(0, 3).map((code) => ({ code, source: SOURCE })), NOW);
    await reportCriticalIssues([{ code: codes[3]!, source: SOURCE }], NOW);
    expect(gh.issues).toHaveLength(3);
  });

  it('gdy GitHub zgubi etykietę, nie zakłada issue co przebieg (limit w pamięci procesu)', async () => {
    const gh = fakeGitHub([], { dropLabels: true });
    vi.stubGlobal('fetch', gh.fetchMock);
    for (let run = 0; run < 6; run++) {
      await reportCriticalIssues([{ code: 'stale_backup', source: SOURCE }], new Date(NOW.getTime() + run * 30 * 60_000));
    }
    expect(gh.issues).toHaveLength(1);
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join('\n');
    expect(logged).toContain(ALERT_ISSUE_LABEL);
  });

  it('zamknięte w ciągu godziny issue nadal liczą się do limitu nowych', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    const codes = Object.keys(CRITICAL_ISSUE_CODES);
    await reportCriticalIssues(codes.slice(0, 3).map((code) => ({ code, source: SOURCE })), NOW);
    gh.issues.splice(0); // człowiek zamknął wszystkie
    await reportCriticalIssues(codes.slice(3, 6).map((code) => ({ code, source: SOURCE })), new Date(NOW.getTime() + 10 * 60_000));
    expect(gh.writes().filter((c) => c.method === 'POST' && c.path.endsWith('/issues'))).toHaveLength(3);
  });

  it('po pierwszym timeoucie przerywa przebieg zamiast czekać na każde issue', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    const codes = Object.keys(CRITICAL_ISSUE_CODES).slice(0, 3);
    await reportCriticalIssues(codes.map((code) => ({ code, source: SOURCE })), minutesAgo(120));
    let writes = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') return gh.fetchMock(input, init);
      writes++;
      throw new Error('aborted');
    }));

    const result = await reportCriticalIssues(codes.map((code) => ({ code, source: SOURCE })), NOW);

    expect(writes).toBe(1);
    expect(result).toMatchObject({ failed: 3, updated: 0 });
  });

  it('przy 15 otwartych issue alarmów nie zakłada nowych', async () => {
    const old = new Date('2026-10-01T00:00:00.000Z').toISOString();
    const gh = fakeGitHub(
      Array.from({ length: 15 }, (_, i) => ({
        number: i + 1,
        title: `stare ${i}`,
        body: `<!-- faktway-alert v1 fp=cron.critical-alerts-monitor:inny_${i} -->`,
        labels: [{ name: ALERT_ISSUE_LABEL }],
        created_at: old,
        state: 'open' as const,
      })),
    );
    vi.stubGlobal('fetch', gh.fetchMock);
    const result = await reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], NOW);
    expect(result).toMatchObject({ created: 0, skipped: 1 });
    expect(gh.writes()).toHaveLength(0);
  });
});

describe('issue z alarmu: brak danych osobowych (lista dozwolonych pól)', () => {
  const PII = [
    '1234567890', // NIP
    'jan.kowalski@example.com',
    'Firma Testowa Sp. z o.o.',
    '12 345,67 zł',
    'FV/2026/11/001',
    '0f4e9d2a-1b3c-4d5e-8f70-123456789abc', // identyfikator firmy
    'Error: at /app/lib/ksef/submit.ts',
    '<ksef>odpowiedź</ksef>',
  ];

  function allOutgoingText(gh: ReturnType<typeof fakeGitHub>): string {
    return gh.calls.map((c) => c.path + JSON.stringify(c.body ?? {})).join('\n');
  }

  it('treść issue to dokładnie szablon z dozwolonymi polami', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    await reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], NOW);

    expect(gh.issues[0]!.title).toBe('Alarm produkcji: KSeF API niedostępny (ksef_down)');
    expect(gh.issues[0]!.body).toBe(
      [
        `<!-- faktway-alert v1 fp=cron.critical-alerts-monitor:ksef_down first=${NOW.toISOString()} last=${NOW.toISOString()} commented=${NOW.toISOString()} count=1 -->`,
        '**Alarm krytyczny z produkcji: KSeF API niedostępny**',
        '',
        '| Pole | Wartość |',
        '|---|---|',
        '| Kod błędu | `ksef_down` |',
        '| Źródło | `cron.critical-alerts-monitor` |',
        '| Liczba wystąpień | 1 |',
        `| Pierwsze wystąpienie | ${NOW.toISOString()} |`,
        `| Ostatnie wystąpienie | ${NOW.toISOString()} |`,
        '| Wdrożenie (SHA) | `abcdef012345` |',
        '',
        'Szczegóły (tylko operator, logowanie z 2FA): https://faktway.pl/admin/centrum/bledy',
        '',
        'Issue zakłada i aktualizuje automat (`lib/alerts/github-issue.ts`) z listy dozwolonych pól. Repozytorium jest publiczne: nie dopisuj tu danych klientów, odpowiedzi KSeF ani logów 1:1.',
        'Etykietę `agent:napraw` dodaje człowiek, gdy to błąd w kodzie. Po naprawie zamknij issue; kolejne wystąpienie założy nowe.',
      ].join('\n'),
    );
  });

  it('dodatkowe pola wejścia (np. przekazane przez pomyłkę) nie trafiają do GitHuba', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    const leaky = {
      code: 'ksef_down',
      source: SOURCE,
      nip: PII[0],
      email: PII[1],
      companyName: PII[2],
      amount: PII[3],
      invoiceNumber: PII[4],
      tenantId: PII[5],
      stack: PII[6],
      ksefResponse: PII[7],
      message: PII.join(' '),
    } as unknown as { code: string; source: string };

    await reportCriticalIssues([leaky], minutesAgo(120));
    await reportCriticalIssues([leaky], NOW);

    const text = allOutgoingText(gh);
    for (const value of PII) expect(text).not.toContain(JSON.stringify(value).slice(1, -1));
    expect(gh.comments).toHaveLength(1);
  });

  it('kod lub źródło spoza listy dozwolonych są odrzucane, nie wklejane', async () => {
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    const result = await reportCriticalIssues(
      [
        { code: '1234567890', source: SOURCE },
        { code: 'ksef_down', source: 'jan.kowalski@example.com' },
        { code: 'ksef_down jan.kowalski@example.com', source: SOURCE },
      ],
      NOW,
    );
    expect(result).toMatchObject({ created: 0, rejected: 3 });
    expect(gh.fetchMock).not.toHaveBeenCalled();
    const logged = vi.mocked(console.warn).mock.calls.flat().map(String).join('\n');
    expect(logged).not.toContain('1234567890');
    expect(logged).not.toContain('jan.kowalski');
  });

  it('SHA i adres aplikacji ze środowiska przechodzą tylko w dozwolonym kształcie', async () => {
    vi.stubEnv('SOURCE_COMMIT', 'jan.kowalski@example.com 1234567890');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://faktway.pl/x?nip=1234567890');
    const gh = fakeGitHub();
    vi.stubGlobal('fetch', gh.fetchMock);
    await reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], NOW);

    const text = allOutgoingText(gh);
    expect(text).not.toContain('1234567890');
    expect(text).not.toContain('jan.kowalski');
    expect(gh.issues[0]!.body).toContain('| Wdrożenie (SHA) | nieznane |');
    expect(gh.issues[0]!.body).toContain('https://faktway.pl/admin/centrum/bledy');
  });

  it('podrobiony stan w znaczniku istniejącego issue nie przecieka do nowej treści', async () => {
    const gh = fakeGitHub([
      {
        number: 1,
        title: 'x',
        body: '<!-- faktway-alert v1 fp=cron.critical-alerts-monitor:ksef_down first=jan@example.com last=1234567890 commented=x count=9 -->\nNIP 1234567890',
        labels: [{ name: ALERT_ISSUE_LABEL }],
        created_at: '2026-10-01T00:00:00.000Z',
        state: 'open',
      },
    ]);
    vi.stubGlobal('fetch', gh.fetchMock);
    await reportCriticalIssues([{ code: 'ksef_down', source: SOURCE }], NOW);

    const text = gh.writes().map((c) => JSON.stringify(c.body)).join('\n');
    expect(text).not.toContain('1234567890');
    expect(text).not.toContain('jan@example.com');
    expect(gh.issues).toHaveLength(1);
  });

  it('każdy typ alarmu monitora ma wpis na liście dozwolonych kodów', () => {
    const source = readFileSync(
      resolve(__dirname, '../../lib/jobs/runners/critical-alerts-monitor.ts'),
      'utf8',
    );
    const types = [...source.matchAll(/captureAndReturn\('([a-z0-9_]+)'\)/g)].map((m) => m[1]!);
    expect(types.length).toBeGreaterThanOrEqual(21);
    for (const type of types) expect(Object.keys(CRITICAL_ISSUE_CODES)).toContain(type);
    for (const description of Object.values(CRITICAL_ISSUE_CODES)) {
      expect(description).not.toMatch(/\d{10}|@/);
    }
  });
});
