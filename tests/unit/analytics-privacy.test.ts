import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureResult } from 'posthog-js';
import posthog from 'posthog-js';

import { initPosthogBrowser } from '@/lib/analytics/init-posthog-browser';
import { CONSENT_KEY, CONSENT_META_KEY, getAnalyticsConsent, setAnalyticsConsent } from '@/lib/analytics/consent';
import { sanitizeAnalyticsEvent, sanitizeAnalyticsUrl } from '@/lib/analytics/privacy';
import { track, trackPageView } from '@/lib/analytics/client';
import { ANALYTICS_EVENTS } from '@/lib/analytics/events';

const sdk = vi.hoisted(() => ({
  __loaded: false,
  optedOut: true,
  init: vi.fn(),
  capture: vi.fn(),
  stopSessionRecording: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
  has_opted_out_capturing: vi.fn(),
}));
vi.mock('posthog-js', () => ({ default: sdk }));

let storage: Map<string, string>;
let browser: EventTarget & { localStorage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_unit_test');
  storage = new Map();
  browser = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
  });
  vi.stubGlobal('window', browser);
  // Also resets the in-memory fallback from storage-failure tests.
  setAnalyticsConsent(false);
  storage.clear();
  sdk.__loaded = false;
  sdk.optedOut = true;
  sdk.init.mockImplementation(() => { sdk.__loaded = true; });
  sdk.has_opted_out_capturing.mockImplementation(() => sdk.optedOut);
  sdk.opt_in_capturing.mockImplementation(() => { sdk.optedOut = false; });
  sdk.opt_out_capturing.mockImplementation(() => { sdk.optedOut = true; });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

/** Zgoda z datą wyboru. Sama wartość bez daty to zapis sprzed 11.2026, czyli brak decyzji. */
function storeGranted(): void {
  storage.set(CONSENT_META_KEY, JSON.stringify({ chosenAt: '2026-11-02T10:00:00.000Z', synced: false }));
  storage.set(CONSENT_KEY, 'granted');
}

function event(properties: CaptureResult['properties'] = {}, name = '$pageview'): CaptureResult {
  return { uuid: 'unit-event', event: name, properties };
}

describe('PostHog explicit consent', () => {
  // `granted` bez daty: zgoda sprzed 11.2026, na węższe oświadczenie.
  it.each([undefined, 'denied', 'unexpected', 'granted'])('does not initialize or capture with consent %s', (consent) => {
    if (consent) storage.set(CONSENT_KEY, consent);
    initPosthogBrowser();
    track(ANALYTICS_EVENTS.supportChatStarted);
    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(sanitizeAnalyticsEvent(event())).toBeNull();
  });

  it('starts immediately after consent and stops after revocation', () => {
    initPosthogBrowser();
    setAnalyticsConsent(true);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.init).toHaveBeenCalledWith('phc_unit_test', expect.objectContaining({
      autocapture: false,
      disable_session_recording: true,
      session_recording: { maskAllInputs: true, maskTextSelector: '*' },
      disable_external_dependency_loading: true,
      advanced_disable_flags: true,
      capture_exceptions: false,
      capture_performance: false,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      save_referrer: false,
      save_campaign_params: false,
      before_send: sanitizeAnalyticsEvent,
    }));
    track(ANALYTICS_EVENTS.supportChatStarted);
    expect(sdk.capture).toHaveBeenLastCalledWith('support_chat_started', undefined);
    setAnalyticsConsent(false);
    const captures = sdk.capture.mock.calls.length;
    track(ANALYTICS_EVENTS.supportChatStarted);
    expect(sdk.capture).toHaveBeenCalledTimes(captures);
    expect(sdk.opt_out_capturing).toHaveBeenCalled();
    expect(sdk.stopSessionRecording).toHaveBeenCalled();
    expect(sanitizeAnalyticsEvent(event())).toBeNull();
  });

  it('honors revocation in another tab', () => {
    storeGranted();
    initPosthogBrowser();
    storage.set(CONSENT_KEY, 'denied');
    browser.dispatchEvent(Object.assign(new Event('storage'), { key: CONSENT_KEY }));
    expect(sdk.opt_out_capturing).toHaveBeenCalled();
  });

  it('requires consent even if an SDK instance has an old opt-in', () => {
    sdk.__loaded = true;
    sdk.optedOut = false;
    track(ANALYTICS_EVENTS.supportChatStarted);
    trackPageView('/accountant/private-token');
    expect(sdk.capture).not.toHaveBeenCalled();
  });

  it('handles unavailable storage without silently granting consent', () => {
    browser.localStorage.getItem = () => { throw new Error('blocked'); };
    browser.localStorage.setItem = () => { throw new Error('blocked'); };
    initPosthogBrowser();
    expect(sdk.init).not.toHaveBeenCalled();
    setAnalyticsConsent(true);
    expect(getAnalyticsConsent()).toBe('granted');
    expect(sdk.init).toHaveBeenCalledTimes(1);
    setAnalyticsConsent(false);
    expect(getAnalyticsConsent()).toBe('denied');
    expect(sdk.opt_out_capturing).toHaveBeenCalled();
  });
});

describe('PostHog outbound data boundary', () => {
  it('preserves only the SDK public project token, never an arbitrary access token', () => {
    storeGranted();
    const safe = sanitizeAnalyticsEvent(event({ token: 'phc_unit_test', access_token: 'private-token' }));
    expect(safe?.properties).toEqual({ token: 'phc_unit_test' });
    expect(sanitizeAnalyticsEvent(event({ token: 'private-token' }))?.properties).toEqual({});
  });

  it.each([
    ['/accountant/private-token/download/id?token=secret#access_token=secret', '/accountant/[redacted]'],
    ['https://user:password@example.invalid/reset-password?token=secret#fragment', '/reset-password'],
    ['https://example.invalid/invoices/1234567890?search=Jan%20Kowalski', '/invoices/[redacted]'],
    ['/unreviewed-secret-path?token=secret', '/[redacted]'],
    ['javascript:secret', '/[redacted]'],
    ['/login?next=/accountant/secret', '/login'],
  ])('reduces URL %s to a reviewed route area', (url, expected) => {
    expect(sanitizeAnalyticsUrl(url)).toBe(expected);
  });

  it('removes DOM text, personal properties, arbitrary event data and full URLs', () => {
    storeGranted();
    const raw = event({
      distinct_id: '00000000-0000-4000-8000-000000000001', $session_id: '00000000-0000-4000-8000-000000000002',
      $current_url: '/accountant/private-token?token=private-secret',
      $referrer: 'https://external.invalid/private-secret?email=private@example.invalid',
      $pathname: '/invoices/private-secret',
      $elements: [{ text: 'Jan Kowalski', href: '/accountant/private-token' }],
      $elements_chain: 'a:attr__href="/accountant/private-token"',
      $set: { email: 'private@example.invalid' },
      $set_once: { $initial_current_url: '/accountant/private-token' },
      email: 'private@example.invalid', note: 'Jan Kowalski', amount: 123456,
      $groups: { tenant: '00000000-0000-4000-8000-000000000003', email: 'private@example.invalid' },
    });
    raw.$set = { email: 'private@example.invalid' };
    raw.$set_once = { $initial_referrer: '/accountant/private-token' };
    const sanitized = sanitizeAnalyticsEvent(raw);
    expect(sanitized).toEqual(event({
      distinct_id: '00000000-0000-4000-8000-000000000001', $session_id: '00000000-0000-4000-8000-000000000002',
      $current_url: '/accountant/[redacted]', $referrer: '/[redacted]',
      $pathname: '/invoices/[redacted]', $groups: { tenant: '00000000-0000-4000-8000-000000000003' },
    }));
    expect(JSON.stringify(sanitized)).not.toMatch(/private|Kowalski|123456/);
    expect(raw.properties.email).toBe('private@example.invalid');
  });

  it('preserves reviewed counters, enum values and flags without arbitrary text', () => {
    storeGranted();
    const properties = {
      count: 12, imported_count: 3, duration_ms: 2300, step_index: 2,
      plan: 'monthly', status: 'active', method: 'google', feature: 'invoices',
      success: true, confidence: 0.98, month: 9, '$browser': 'Chrome', '$lib_version': '1.374.3',
    };
    expect(sanitizeAnalyticsEvent(event(properties, 'feature_used'))?.properties).toEqual(properties);
    expect(sanitizeAnalyticsEvent(event({
      count: 1234567890, imported_count: '123', duration_ms: Number.POSITIVE_INFINITY,
      plan: 'Jan Kowalski', status: 'private@example.invalid', feature: '/accountant/private-token',
      '$os': 'Jan Kowalski', '$device_id': 'private@example.invalid',
      '$groups': { tenant: 'private@example.invalid' }, month: 1234567890,
    }))?.properties).toEqual({});
  });

  it.each(['$snapshot', '$autocapture', '$exception', '$rageclick', '$dead_click', 'private@example.invalid'])('drops unreviewed event %s', (name) => {
    storeGranted();
    expect(sanitizeAnalyticsEvent(event({}, name))).toBeNull();
  });
});
