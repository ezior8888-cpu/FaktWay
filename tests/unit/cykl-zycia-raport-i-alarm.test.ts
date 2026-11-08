import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';
import { OPERATOR_DUPLICATE_MESSAGES } from '@/lib/admin/ksef-operator-policy';

/**
 * Cykl życia faktury, PR 4b: raport dzienny (`cron.ksef-lifecycle-report`)
 * i alarm strażnika w monitorze alarmów (`checkKsefLifecycleViolations`, W3).
 */

const m = vi.hoisted(() => ({
  // D-A4-1b-3 PR B: wiersze strażnika niosą `detail` (I5D — środowisko sprawdzenia oryginału).
  violations: [] as Array<{ invariant: string; detail?: unknown }>,
  counts: {} as Record<string, number>,
  // 00155: przyjęte faktury pobrane z historii KSeF (bez naszej wysyłki, bez UPO).
  acceptedFromHistory: 0,
  audit: [] as Array<{ action: string; user_id: string | null }>,
  slack: vi.fn(),
  alertCritical: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (fn: string) => (fn === 'ksef_lifecycle_violations' ? { data: m.violations, error: null } : { data: null, error: { message: fn } }),
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      // `in('action', …)` filtruje ślad jak PostgREST — raport liczy tylko akcje ze swojej listy.
      let actions: unknown[] | null = null;
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        filter: (k: string, op: string, v: unknown) => { filters.push([`filter:${k}:${op}`, v]); return q; },
        in: (k: string, vs: unknown[]) => { if (k === 'action') actions = vs; return q; },
        gte: () => q,
        limit: () => q,
        then: (ok: (v: unknown) => unknown) => {
          if (table === 'audit_logs') {
            const allowed = actions;
            return ok({ data: allowed ? m.audit.filter((r) => allowed.includes(r.action)) : m.audit, error: null });
          }
          const status = filters.find(([k]) => k === 'ksef_status')?.[1] as string | undefined;
          const upoExpectedOnly = filters.some(([k, v]) => k === 'filter:ksef_upo_expected:eq' && v === 'true');
          const history = status === 'accepted' && !upoExpectedOnly ? m.acceptedFromHistory : 0;
          return ok({ data: null, error: null, count: (m.counts[status ?? ''] ?? 0) + history });
        },
      };
      return q;
    },
  }),
}));
vi.mock('@/lib/alerts/slack', () => ({ sendSlackAlert: m.slack, alertCritical: m.alertCritical }));
vi.mock('@/lib/cache', () => ({ cacheGet: m.cacheGet, cacheSet: m.cacheSet }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { formatLifecycleReport, LIFECYCLE_REPORT_ACTIONS, runKsefLifecycleReport } from '@/lib/jobs/runners/ksef-lifecycle-report';
import { checkKsefLifecycleViolations } from '@/lib/jobs/runners/critical-alerts-monitor';

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

beforeEach(() => {
  vi.clearAllMocks();
  m.violations = [];
  m.counts = {};
  m.acceptedFromHistory = 0;
  m.audit = [];
  m.cacheGet.mockResolvedValue(null);
  m.cacheSet.mockResolvedValue(true);
});

describe('raport dzienny', () => {
  it('00155: „Przyjęte w 24 h” liczy tylko faktury z UPO (bez historii z KSeF) — ten sam predykat co I3', async () => {
    m.counts = { accepted: 9 };
    m.acceptedFromHistory = 4;
    const result = await runKsefLifecycleReport(ctx);
    expect(result.accepted24h).toBe(9);
  });

  it('formatLifecycleReport: stany, przyjęte, naruszenia, akcje, ponowienia automatu', () => {
    const text = formatLifecycleReport({
      statuses: { draft: 3, failed: 2, queued: 0, sending: 0, offline_queued: 0, rejected: 1 },
      accepted24h: 17,
      violations: { I4: 1, I1: 2 },
      actions24h: { 'invoice.send_requeued': 5, 'invoice.operator_reset': 1, 'invoice.send_reset': 0 },
      autoRequeues24h: 4,
    });
    expect(text).toContain('draft 3 · queued 0 · sending 0 · offline_queued 0 · failed 2 · rejected 1');
    expect(text).toContain('Przyjęte w 24 h: 17');
    expect(text).toContain('Naruszenia strażnika: I1 2 · I4 1');
    expect(text).toContain('Akcje w 24 h: operator_reset 1 · send_requeued 5');
    expect(text).toContain('Ponowienia automatu w 24 h: 4');
  });

  it('runner zbiera liczby i wysyła na kanał metrics; brak naruszeń = „brak”', async () => {
    m.counts = { failed: 2, accepted: 9 };
    m.audit = [
      { action: 'invoice.send_requeued', user_id: null },
      { action: 'invoice.send_requeued', user_id: 'user' },
      { action: 'invoice.operator_reset', user_id: 'op' },
    ];

    const result = await runKsefLifecycleReport(ctx);

    expect(result).toMatchObject({ accepted24h: 9, autoRequeues24h: 1, actions24h: { 'invoice.send_requeued': 2, 'invoice.operator_reset': 1 } });
    expect(result.statuses.failed).toBe(2);
    expect(m.slack).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'metrics',
      text: expect.stringContaining('Naruszenia strażnika: brak'),
      context: expect.objectContaining({ failed: 2, naruszenia: 0 }),
    }));
  });
});

describe('alarm strażnika w monitorze (W3)', () => {
  it('bez naruszeń nic nie wysyła', async () => {
    await expect(checkKsefLifecycleViolations()).resolves.toEqual({ type: 'ksef_lifecycle_violations', fired: false });
    expect(m.alertCritical).not.toHaveBeenCalled();
  });

  it('naruszenia → alertCritical z liczbą per inwariant i linkiem do /admin/ksef, potem dedup', async () => {
    m.violations = [{ invariant: 'I1' }, { invariant: 'I1' }, { invariant: 'I9' }];

    await expect(checkKsefLifecycleViolations()).resolves.toEqual({ type: 'ksef_lifecycle_violations', fired: true });
    expect(m.alertCritical).toHaveBeenCalledWith(
      expect.stringContaining('Strażnik cyklu życia'),
      expect.any(String),
      expect.objectContaining({
        fields: [{ label: 'I1', value: '2' }, { label: 'I9', value: '1' }],
        link: expect.objectContaining({ url: expect.stringContaining('/admin/ksef') }),
      }),
    );
    expect(m.cacheSet).toHaveBeenCalledWith(expect.stringContaining('ksef_lifecycle_violations:I1+I9'), expect.any(String), expect.any(Number));

    m.cacheGet.mockResolvedValue('2026-10-03T12:00:00.000Z');
    await expect(checkKsefLifecycleViolations()).resolves.toMatchObject({ fired: false, reason: 'dedup' });
  });
});

/**
 * D-A4-1b-3 PR B (decyzja 4, 07.10.2026): I5D — faktura czeka na decyzję
 * klienta przy nierozstrzygniętym 440 (00148). Nie alarm krytyczny (e-mail
 * idzie raz i nie jest ponawiany; gdy nie doszedł — operator: „Przypomnij
 * klientowi”; widzi fakturę w raporcie i /admin/ksef) — chyba że dane
 * oryginału sprawdzono w innym środowisku KSeF niż obecne (I5D-env: klient
 * nie zapisze decyzji). W raporcie osobny wiersz, nie „Naruszenia strażnika”.
 */
const i5d = (env: string | null, attemptedAt = '2026-10-01T10:00:00.000Z') => ({
  invariant: 'I5D',
  detail: { original_ksef_number: '1234567890-20261001-0100A0B0C0D0-1A', reason: 'no-own-file', env, attempted_at: attemptedAt },
});

describe('D-A4-1b-3 PR B: I5D w monitorze alarmów', () => {
  beforeEach(() => {
    vi.stubEnv('KSEF_ENV', 'test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('U19a: samo I5D w bieżącym środowisku — bez alarmu krytycznego', async () => {
    m.violations = [i5d('test'), i5d('test', '2026-10-02T10:00:00.000Z')];
    await expect(checkKsefLifecycleViolations()).resolves.toEqual({ type: 'ksef_lifecycle_violations', fired: false });
    expect(m.alertCritical).not.toHaveBeenCalled();
    expect(m.cacheSet).not.toHaveBeenCalled();
  });

  it('U19b: I5D z innego (albo nieznanego) środowiska — alarm jako I5D-env, z kluczem i zdaniem w treści', async () => {
    m.violations = [i5d('production'), i5d(null)];
    await expect(checkKsefLifecycleViolations()).resolves.toEqual({ type: 'ksef_lifecycle_violations', fired: true });
    expect(m.alertCritical).toHaveBeenCalledWith(
      expect.stringContaining('Strażnik cyklu życia'),
      expect.stringContaining('I5D-env: faktura czeka na decyzję klienta, ale dane oryginału sprawdzono w innym środowisku KSeF niż obecne — klient nie zapisze decyzji (runbook KSEF_DUPLICATE_RECONCILE, przełączenie środowiska).'),
      expect.objectContaining({ fields: [{ label: 'I5D-env', value: '2' }] }),
    );
    expect(m.cacheSet).toHaveBeenCalledWith(expect.stringMatching(/ksef_lifecycle_violations:I5D-env$/), expect.any(String), expect.any(Number));
  });

  it('U19b: I1 obok I5D w bieżącym środowisku — alarm tylko o I1 (klucz bez I5D)', async () => {
    m.violations = [{ invariant: 'I1' }, i5d('test')];
    await expect(checkKsefLifecycleViolations()).resolves.toEqual({ type: 'ksef_lifecycle_violations', fired: true });
    expect(m.alertCritical).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ fields: [{ label: 'I1', value: '1' }] }),
    );
    expect(m.cacheSet).toHaveBeenCalledWith(expect.stringMatching(/ksef_lifecycle_violations:I1$/), expect.any(String), expect.any(Number));
  });

  it('U19b: KSEF_ENV nieustawione — I5D nie da się zapisać w żadnym środowisku: I5D-env', async () => {
    vi.stubEnv('KSEF_ENV', '');
    m.violations = [i5d('test')];
    await expect(checkKsefLifecycleViolations()).resolves.toEqual({ type: 'ksef_lifecycle_violations', fired: true });
    expect(m.alertCritical).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ fields: [{ label: 'I5D-env', value: '1' }] }),
    );
  });
});

describe('D-A4-1b-3 PR B: I5D w raporcie dziennym', () => {
  beforeEach(() => {
    vi.stubEnv('KSEF_ENV', 'test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('U19c: I5D osobnym wierszem (z innym środowiskiem), poza „Naruszeniami strażnika”; decyzje w akcjach doby', async () => {
    m.violations = [{ invariant: 'I1' }, i5d('test', '2026-10-02T10:00:00.000Z'), i5d('production', '2026-10-01T10:00:00.000Z')];
    m.audit = [
      { action: 'invoice.ksef_duplicate_decided', user_id: 'owner' },
      { action: 'invoice.operator_duplicate_decision', user_id: null },
      { action: 'invoice.ksef_duplicate_decision_notified', user_id: null },
    ];

    const result = await runKsefLifecycleReport(ctx);

    expect(result.violations).toEqual({ I1: 1 });
    const text = String((m.slack.mock.calls[0]?.[0] as { text?: string } | undefined)?.text);
    expect(text).toContain('Naruszenia strażnika: I1 1\n');
    expect(text).toMatch(/Czekają na decyzję klienta \(I5D\): 2 · w innym środowisku KSeF: 1 · najdłużej od .+/);
    expect(text).toContain('ksef_duplicate_decided 1');
    expect(text).toContain('operator_duplicate_decision 1');
    expect(text).toContain('ksef_duplicate_decision_notified 1');
    expect(m.slack).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ naruszenia: 1, czekaNaKlienta: 2 }),
    }));
  });

  it('U19c: same I5D — „Naruszenia strażnika: brak”, wiersz czekających bez innego środowiska', async () => {
    m.violations = [i5d('test')];
    await runKsefLifecycleReport(ctx);
    const text = String((m.slack.mock.calls[0]?.[0] as { text?: string } | undefined)?.text);
    expect(text).toContain('Naruszenia strażnika: brak');
    expect(text).toMatch(/Czekają na decyzję klienta \(I5D\): 1(?! · w innym)/);
    expect(m.slack).toHaveBeenCalledWith(expect.objectContaining({ context: expect.objectContaining({ naruszenia: 0, czekaNaKlienta: 1 }) }));
  });

  it('U19c: formatLifecycleReport — wiersz CLIENT_PENDING_LINE po naruszeniach; bez pola — bez wiersza', () => {
    const base = {
      statuses: { draft: 0, failed: 1 },
      accepted24h: 0,
      violations: {},
      actions24h: {},
      autoRequeues24h: 0,
    };
    const lines = formatLifecycleReport({ ...base, clientDecisionPending: { count: 3, otherEnv: 0, oldestAttemptAt: null } }).split('\n');
    const at = lines.indexOf('Naruszenia strażnika: brak');
    expect(lines[at + 1]).toBe('Czekają na decyzję klienta (I5D): 3');
    expect(formatLifecycleReport(base)).not.toContain('Czekają na decyzję klienta');
  });
});

/**
 * D-A4-1b-3 PR C (00149, spec v3 5.8 i 7.2): dwa nowe inwarianty strażnika.
 *  - I5R — przegląd pliku z oznaczeniem FaktFlow przez operatora (blokada
 *    `provenance-review`): klient usłyszał „damy znać”. Alarm krytyczny dopiero
 *    po 72 h od ostatniego udanego sprawdzenia (`detail.checked_at`); brak albo
 *    nieczytelna wartość — alarm od razu (fail-closed). Etykieta alarmu: `I5R-72h`.
 *  - I3K — K zapisana decyzją bez sesji UPO albo bez daty nadania: trwały sygnał
 *    w raporcie i KPI, alarm idzie z akcji (Sentry), nie z monitora.
 * W raporcie dziennym oba idą do „Naruszeń strażnika” (nie są I5D).
 * Na HEAD monitor alarmuje oba jako zwykłe naruszenie (etykiety `I5R` i `I3K`).
 */
const K_ORYGINALU = '1234567890-20261001-0100A0B0C0D0-1A';
const HOUR_MS = 60 * 60 * 1000;
const NOW_PR_C = new Date('2026-10-08T12:00:00.000Z');
const agoIso = (ms: number) => new Date(NOW_PR_C.getTime() - ms).toISOString();

const i5r = (checkedAt: unknown, extra: Record<string, unknown> = {}) => ({
  invariant: 'I5R',
  detail: {
    original_ksef_number: K_ORYGINALU, reason: 'faktflow-original', env: 'test', checked_at: checkedAt,
    attempted_at: '2026-10-01T10:00:00.000Z', last_attempt_at: '2026-10-01T10:00:00.000Z', problems: ['rates'], ...extra,
  },
});
const i3k = (extra: Record<string, unknown> = {}) => ({
  invariant: 'I3K',
  detail: { ksef_number: K_ORYGINALU, no_session: true, no_date: false, upo_status: 'failed', ...extra },
});

describe('D-A4-1b-3 PR C: I5R i I3K w monitorze alarmów', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_PR_C);
    vi.stubEnv('KSEF_ENV', 'test');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('I3K nie alarmuje z monitora (sygnał trwały w raporcie i KPI; alarm Sentry idzie z akcji)', async () => {
    m.violations = [i3k(), i3k({ no_session: false, no_date: true })];

    await expect(checkKsefLifecycleViolations()).resolves.toEqual({ type: 'ksef_lifecycle_violations', fired: false });

    expect(m.alertCritical).not.toHaveBeenCalled();
    expect(m.cacheSet).not.toHaveBeenCalled();
  });

  it.each([
    ['1 h', HOUR_MS],
    ['71 h 59 min', 72 * HOUR_MS - 60_000],
  ])('I5R sprawdzone %s temu (młodsze niż 72 h) — bez alarmu', async (_label, age) => {
    m.violations = [i5r(agoIso(age))];

    await expect(checkKsefLifecycleViolations()).resolves.toEqual({ type: 'ksef_lifecycle_violations', fired: false });

    expect(m.alertCritical).not.toHaveBeenCalled();
    expect(m.cacheSet).not.toHaveBeenCalled();
  });

  it.each([
    ['dokładnie 72 h', 72 * HOUR_MS],
    ['100 h', 100 * HOUR_MS],
  ])('I5R sprawdzone %s temu (≥ 72 h) — alarm krytyczny I5R-72h z opisem „damy znać” i kluczem dedup', async (_label, age) => {
    m.violations = [i5r(agoIso(age))];

    await expect(checkKsefLifecycleViolations()).resolves.toEqual({ type: 'ksef_lifecycle_violations', fired: true });

    expect(m.alertCritical).toHaveBeenCalledWith(
      expect.stringContaining('Strażnik cyklu życia'),
      expect.stringContaining(OPERATOR_DUPLICATE_MESSAGES.i5r72h),
      expect.objectContaining({
        fields: [{ label: 'I5R-72h', value: '1' }],
        link: expect.objectContaining({ url: expect.stringContaining('/admin/ksef') }),
      }),
    );
    expect(m.cacheSet).toHaveBeenCalledWith(expect.stringMatching(/ksef_lifecycle_violations:I5R-72h$/), expect.any(String), expect.any(Number));
  });

  it.each([
    ['brak klucza checked_at', undefined],
    ['checked_at = null', null],
    ['checked_at = pusty napis', ''],
    ['checked_at nieczytelne', 'wczoraj po południu'],
  ])('I5R: %s — alarm I5R-72h od razu (fail-closed: nie wiemy, od kiedy klient czeka)', async (_label, checkedAt) => {
    const row = i5r(checkedAt);
    if (checkedAt === undefined) delete (row.detail as Record<string, unknown>).checked_at;
    m.violations = [row];

    await expect(checkKsefLifecycleViolations()).resolves.toEqual({ type: 'ksef_lifecycle_violations', fired: true });

    expect(m.alertCritical).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining(OPERATOR_DUPLICATE_MESSAGES.i5r72h),
      expect.objectContaining({ fields: [{ label: 'I5R-72h', value: '1' }] }),
    );
  });

  it('I5R: liczy się każdy wiersz osobno — jeden stary, jeden świeży = I5R-72h × 1', async () => {
    m.violations = [i5r(agoIso(80 * HOUR_MS)), i5r(agoIso(2 * HOUR_MS))];

    await checkKsefLifecycleViolations();

    expect(m.alertCritical).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ fields: [{ label: 'I5R-72h', value: '1' }] }),
    );
  });

  it('świeże I5R i I3K obok I1 — alarm tylko o I1 (klucz dedup bez I5R i I3K)', async () => {
    m.violations = [{ invariant: 'I1' }, i5r(agoIso(3 * HOUR_MS)), i3k()];

    await expect(checkKsefLifecycleViolations()).resolves.toEqual({ type: 'ksef_lifecycle_violations', fired: true });

    expect(m.alertCritical).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ fields: [{ label: 'I1', value: '1' }] }),
    );
    expect(m.cacheSet).toHaveBeenCalledWith(expect.stringMatching(/ksef_lifecycle_violations:I1$/), expect.any(String), expect.any(Number));
  });

  it('strażnik (zielony na HEAD z założenia — „bez zmian kodu monitora”): I5 z recheck-needed alarmuje jak każde I5', async () => {
    m.violations = [{
      invariant: 'I5',
      detail: { original_ksef_number: K_ORYGINALU, reason: 'faktflow-original', blocker: 'recheck-needed', attempted_at: agoIso(60 * HOUR_MS) },
    }];

    await expect(checkKsefLifecycleViolations()).resolves.toEqual({ type: 'ksef_lifecycle_violations', fired: true });

    expect(m.alertCritical).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ fields: [{ label: 'I5', value: '1' }] }),
    );
  });
});

describe('D-A4-1b-3 PR C: I5R i I3K w raporcie dziennym', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_PR_C);
    vi.stubEnv('KSEF_ENV', 'test');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('strażnik (zielony na HEAD z założenia — „bez zmian kodu raportu”): I5R i I3K w „Naruszeniach strażnika”, nie w wierszu I5D', async () => {
    m.violations = [{ invariant: 'I1' }, i5r(agoIso(5 * HOUR_MS)), i3k()];

    const result = await runKsefLifecycleReport(ctx);

    expect(result.violations).toEqual({ I1: 1, I3K: 1, I5R: 1 });
    expect(result.clientDecisionPending).toEqual({ count: 0, otherEnv: 0, oldestAttemptAt: null });
    const text = String((m.slack.mock.calls[0]?.[0] as { text?: string } | undefined)?.text);
    expect(text).toContain('Naruszenia strażnika: I1 1 · I3K 1 · I5R 1');
    expect(m.slack).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ naruszenia: 3, czekaNaKlienta: 0 }),
    }));
  });

  it('akcje zapisu oryginału są na liście raportu i liczone w akcjach doby', async () => {
    expect(LIFECYCLE_REPORT_ACTIONS).toEqual(expect.arrayContaining([
      'invoice.ksef_original_imported',
      'invoice.ksef_original_review_released',
      'invoice.operator_original_release',
      'invoice.ksef_original_recheck_flagged',
    ]));
    m.audit = [
      { action: 'invoice.ksef_original_imported', user_id: 'owner' },
      { action: 'invoice.ksef_original_imported', user_id: null },
      { action: 'invoice.ksef_original_review_released', user_id: 'op' },
      { action: 'invoice.operator_original_release', user_id: 'op' },
      { action: 'invoice.ksef_original_recheck_flagged', user_id: 'owner' },
    ];

    const result = await runKsefLifecycleReport(ctx);

    expect(result.actions24h).toMatchObject({
      'invoice.ksef_original_imported': 2,
      'invoice.ksef_original_review_released': 1,
      'invoice.operator_original_release': 1,
      'invoice.ksef_original_recheck_flagged': 1,
    });
    const text = String((m.slack.mock.calls[0]?.[0] as { text?: string } | undefined)?.text);
    expect(text).toContain('ksef_original_imported 2');
    expect(text).toContain('ksef_original_review_released 1');
    expect(text).toContain('operator_original_release 1');
    expect(text).toContain('ksef_original_recheck_flagged 1');
  });
});
