import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Zgoda przeglądarka ↔ serwer (FAKTWAY-1-0, sekcja 3 pkt 7). Przeglądarka
 * zapisuje wybór od razu, serwer dostaje go akcją; po zalogowaniu ostatni
 * wybór wygrywa. Wybór już dostarczony na konto nie przechodzi na kolejne
 * konto w tej samej przeglądarce (biuro księgowe, wspólny komputer).
 */

const mocks = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock('@/app/actions/analytics-consent', () => ({ syncAnalyticsConsentAction: mocks.action }));

const T0 = '2026-10-01T10:00:00.000Z';
const T1 = '2026-11-01T10:00:00.000Z';
const NOW = new Date('2026-11-02T10:00:00.000Z');

function browser() {
  const storage = new Map<string, string>();
  const win = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
    },
  });
  vi.stubGlobal('window', win);
  return { win, storage };
}

async function load() {
  vi.resetModules();
  const consent = await import('@/lib/analytics/consent');
  const sync = await import('@/lib/analytics/consent-sync');
  return { ...consent, ...sync };
}

const ok = (consent: 'granted' | 'denied' | null, consentAt: string | null = null) =>
  ({ status: 'ok' as const, consent, consentAt });

beforeEach(() => {
  mocks.action.mockReset();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('wybór w banerze', () => {
  it('niezalogowany: wybór zostaje lokalnie, a po zalogowaniu idzie na serwer z chwilą wyboru', async () => {
    browser();
    mocks.action.mockResolvedValueOnce({ status: 'anonymous' });
    const { chooseAnalyticsConsent, readAnalyticsConsentRecord, syncAnalyticsConsentWithServer } = await load();

    chooseAnalyticsConsent(true);
    await vi.waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
    expect(mocks.action).toHaveBeenLastCalledWith({ consent: 'granted', chosenAt: NOW.toISOString() });
    await Promise.resolve();
    expect(readAnalyticsConsentRecord()).toEqual({ consent: 'granted', chosenAt: NOW.toISOString(), synced: false });

    mocks.action.mockResolvedValueOnce(ok('granted', NOW.toISOString()));
    await syncAnalyticsConsentWithServer();
    expect(mocks.action).toHaveBeenLastCalledWith({ consent: 'granted', chosenAt: NOW.toISOString() });
    expect(readAnalyticsConsentRecord()).toEqual({ consent: 'granted', chosenAt: NOW.toISOString(), synced: true });
  });

  it('odwołanie działa w przeglądarce od razu, zanim odpowie serwer', async () => {
    browser();
    mocks.action.mockReturnValue(new Promise(() => undefined));
    const { chooseAnalyticsConsent, hasAnalyticsConsent } = await load();
    chooseAnalyticsConsent(true);
    expect(hasAnalyticsConsent()).toBe(true);
    chooseAnalyticsConsent(false);
    expect(hasAnalyticsConsent()).toBe(false);
  });

  it('awaria akcji: wybór zostaje niezsynchronizowany i poleci przy następnej okazji', async () => {
    browser();
    mocks.action.mockRejectedValueOnce(new Error('offline'));
    const { chooseAnalyticsConsent, readAnalyticsConsentRecord, syncAnalyticsConsentWithServer } = await load();
    chooseAnalyticsConsent(false);
    await vi.waitFor(() => expect(mocks.action).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(readAnalyticsConsentRecord().synced).toBe(false);

    mocks.action.mockResolvedValueOnce(ok('denied', NOW.toISOString()));
    await syncAnalyticsConsentWithServer();
    expect(mocks.action).toHaveBeenLastCalledWith({ consent: 'denied', chosenAt: NOW.toISOString() });
    expect(readAnalyticsConsentRecord().synced).toBe(true);
  });
});

describe('ostatni wybór wygrywa', () => {
  it('serwer nowszy: przeglądarka przyjmuje wybór z konta i powiadamia PostHoga zdarzeniem', async () => {
    const { win, storage } = browser();
    storage.set('ff_analytics_consent', 'granted');
    storage.set('ff_analytics_consent_meta', JSON.stringify({ chosenAt: T0, synced: false }));
    mocks.action.mockResolvedValue(ok('denied', T1));
    const { ANALYTICS_CONSENT_EVENT, readAnalyticsConsentRecord, syncAnalyticsConsentWithServer } = await load();
    const heard = vi.fn();
    win.addEventListener(ANALYTICS_CONSENT_EVENT, heard);

    await syncAnalyticsConsentWithServer();

    expect(mocks.action).toHaveBeenCalledWith({ consent: 'granted', chosenAt: T0 });
    expect(readAnalyticsConsentRecord()).toEqual({ consent: 'denied', chosenAt: T1, synced: true });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('nowe urządzenie bez decyzji: przejmuje decyzję z konta, baner się nie pokazuje', async () => {
    browser();
    mocks.action.mockResolvedValue(ok('granted', T0));
    const { getAnalyticsConsent, syncAnalyticsConsentWithServer } = await load();
    expect(getAnalyticsConsent()).toBe('unset');
    await syncAnalyticsConsentWithServer();
    expect(mocks.action).toHaveBeenCalledWith({ consent: null, chosenAt: null });
    expect(getAnalyticsConsent()).toBe('granted');
  });

  it('wybór sprzed zmiany (bez daty): idzie bez daty, serwer przyjmie go tylko, gdy sam nie ma decyzji', async () => {
    const { storage } = browser();
    storage.set('ff_analytics_consent', 'granted');
    mocks.action.mockResolvedValue(ok('granted', T1));
    const { readAnalyticsConsentRecord, syncAnalyticsConsentWithServer } = await load();
    await syncAnalyticsConsentWithServer();
    expect(mocks.action).toHaveBeenCalledWith({ consent: 'granted', chosenAt: null });
    expect(readAnalyticsConsentRecord()).toEqual({ consent: 'granted', chosenAt: T1, synced: true });
  });

  it('spóźniona odpowiedź nie nadpisuje świeższego kliknięcia', async () => {
    browser();
    let answer: (value: unknown) => void = () => undefined;
    mocks.action.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    mocks.action.mockResolvedValueOnce(ok('denied', NOW.toISOString()));
    const { chooseAnalyticsConsent, getAnalyticsConsent, syncAnalyticsConsentWithServer } = await load();

    const pending = syncAnalyticsConsentWithServer();
    chooseAnalyticsConsent(false);
    answer(ok('granted', T0));
    await pending;

    expect(getAnalyticsConsent()).toBe('denied');
  });

  it('niezalogowany przy synchronizacji: stan lokalny bez zmian', async () => {
    const { storage } = browser();
    storage.set('ff_analytics_consent', 'denied');
    storage.set('ff_analytics_consent_meta', JSON.stringify({ chosenAt: T0, synced: false }));
    mocks.action.mockResolvedValue({ status: 'anonymous' });
    const { readAnalyticsConsentRecord, syncAnalyticsConsentWithServer } = await load();
    await syncAnalyticsConsentWithServer();
    expect(readAnalyticsConsentRecord()).toEqual({ consent: 'denied', chosenAt: T0, synced: false });
  });
});

describe('wspólna przeglądarka', () => {
  it('wybór dostarczony na inne konto nie nadpisuje decyzji kolejnego konta, nawet gdy jest nowszy', async () => {
    const { storage } = browser();
    storage.set('ff_analytics_consent', 'granted');
    storage.set('ff_analytics_consent_meta', JSON.stringify({ chosenAt: T1, synced: true }));
    mocks.action.mockResolvedValue(ok('denied', T0));
    const { readAnalyticsConsentRecord, syncAnalyticsConsentWithServer } = await load();

    await syncAnalyticsConsentWithServer();

    // Tylko odczyt: żadnego „granted” na koncie, które powiedziało „nie”.
    expect(mocks.action).toHaveBeenCalledWith({ consent: null, chosenAt: null });
    expect(readAnalyticsConsentRecord()).toEqual({ consent: 'denied', chosenAt: T0, synced: true });
  });

  it('kolejne konto bez decyzji: przeglądarka wraca do „bez decyzji” i baner pyta tę osobę', async () => {
    const { win, storage } = browser();
    storage.set('ff_analytics_consent', 'granted');
    storage.set('ff_analytics_consent_meta', JSON.stringify({ chosenAt: T1, synced: true }));
    mocks.action.mockResolvedValue(ok(null));
    const { ANALYTICS_CONSENT_EVENT, getAnalyticsConsent, readAnalyticsConsentRecord, syncAnalyticsConsentWithServer } = await load();
    const heard = vi.fn();
    win.addEventListener(ANALYTICS_CONSENT_EVENT, heard);

    await syncAnalyticsConsentWithServer();

    expect(getAnalyticsConsent()).toBe('unset');
    expect(readAnalyticsConsentRecord()).toEqual({ consent: 'unset', chosenAt: null, synced: false });
    expect(storage.has('ff_analytics_consent')).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('zapis lokalny', () => {
  it('uszkodzona data wyboru to brak daty, a nie wieczna odmowa walidacji w akcji', async () => {
    const { storage } = browser();
    storage.set('ff_analytics_consent', 'granted');
    storage.set('ff_analytics_consent_meta', JSON.stringify({ chosenAt: 'wczoraj', synced: false }));
    const { readAnalyticsConsentRecord } = await load();
    expect(readAnalyticsConsentRecord()).toEqual({ consent: 'granted', chosenAt: null, synced: false });
  });

  it('uszkodzony zapis meta nie psuje odczytu zgody', async () => {
    const { storage } = browser();
    storage.set('ff_analytics_consent', 'denied');
    storage.set('ff_analytics_consent_meta', 'nie-json');
    const { readAnalyticsConsentRecord } = await load();
    expect(readAnalyticsConsentRecord()).toEqual({ consent: 'denied', chosenAt: null, synced: false });
  });
});

describe('miejsca wyboru idą przez synchronizację', () => {
  const read = (path: string) => readFileSync(path, 'utf8');

  it.each(['components/analytics/consent-banner.tsx', 'components/legal/cookie-settings.tsx'])(
    '%s: kliknięcie zapisuje też na koncie, nie tylko w przeglądarce',
    (path) => {
      const source = read(path);
      expect(source).toContain('chooseAnalyticsConsent(');
      expect(source).not.toContain('setAnalyticsConsent');
    },
  );

  it('panel synchronizuje zgodę po zalogowaniu', () => {
    expect(read('components/analytics/analytics-identify.tsx')).toContain('syncAnalyticsConsentWithServer()');
    expect(read('app/(dashboard)/layout.tsx')).toContain('<AnalyticsIdentify');
  });

  it('zgodę zmienisz też w ustawieniach konta', () => {
    expect(read('app/(dashboard)/settings/account/page.tsx')).toContain('<CookieSettings />');
  });

  it('atrybucja startuje razem z PostHogiem', () => {
    expect(read('instrumentation-client.ts')).toContain('initAttribution();');
  });
});

describe('akcja serwerowa', () => {
  const rpc = vi.fn();
  const getUser = vi.fn();
  const audit = vi.fn();
  const USER = '00000000-0000-4000-8000-000000000031';

  async function action() {
    vi.resetModules();
    vi.doUnmock('@/app/actions/analytics-consent');
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => ({ auth: { getUser }, rpc }),
    }));
    vi.doMock('@/lib/audit/log', () => ({ logAudit: audit }));
    return (await import('@/app/actions/analytics-consent')).syncAnalyticsConsentAction;
  }

  beforeEach(() => {
    rpc.mockReset();
    getUser.mockReset();
    audit.mockReset();
    getUser.mockResolvedValue({ data: { user: { id: USER } } });
    rpc.mockResolvedValue({ data: [{ consent: 'granted', consent_at: T0, changed: true }], error: null });
  });
  afterEach(() => {
    vi.doUnmock('@/lib/supabase/server');
    vi.doUnmock('@/lib/audit/log');
  });

  it('bez sesji: nic nie zapisuje', async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const run = await action();
    await expect(run({ consent: 'granted', chosenAt: T0 })).resolves.toEqual({ status: 'anonymous' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('z sesją: RPC dostaje wybór i chwilę, a zmiana trafia do dziennika z wersją oświadczenia', async () => {
    const run = await action();
    await expect(run({ consent: 'granted', chosenAt: T0 })).resolves.toEqual({ status: 'ok', consent: 'granted', consentAt: T0 });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('sync_analytics_consent', { p_consent: 'granted', p_chosen_at: T0 });
    expect(audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: 'analytics.consent_changed',
      userId: USER,
      metadata: expect.objectContaining({ consent: 'granted', statement_version: expect.any(String) }),
    }));
  });

  it('sam odczyt albo przegrany wybór: bez wpisu w dzienniku', async () => {
    rpc.mockResolvedValue({ data: [{ consent: 'denied', consent_at: T1, changed: false }], error: null });
    const run = await action();
    await expect(run({ consent: null, chosenAt: null })).resolves.toEqual({ status: 'ok', consent: 'denied', consentAt: T1 });
    expect(rpc).toHaveBeenCalledWith('sync_analytics_consent', { p_consent: null, p_chosen_at: null });
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    [{ consent: 'wszystko', chosenAt: T0 }],
    [{ consent: 'granted', chosenAt: 'wczoraj' }],
    [null],
    ['granted'],
  ])('odrzuca podrobione wejście z formularza akcji: %j', async (input) => {
    const run = await action();
    await expect(run(input as never)).resolves.toEqual({ status: 'unavailable' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('błąd bazy nie wycieka do przeglądarki', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'private_schema.detail' } });
    const run = await action();
    await expect(run({ consent: 'granted', chosenAt: T0 })).resolves.toEqual({ status: 'unavailable' });
  });
});
