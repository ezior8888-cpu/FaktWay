import type { CaptureResult, Properties } from 'posthog-js';

import { hasAnalyticsConsent } from './consent';
import { ANALYTICS_EVENTS } from './events';

// Analytics needs the application area, never a document ID, portal token,
// search value, fragment, username, or an external referrer's full URL.
const ROUTE_AREAS = new Set([
  'accountant', 'admin', 'dashboard', 'invoices', 'expenses', 'contractors',
  'settings', 'reports', 'kpir', 'help', 'legal', 'login', 'register',
  'forgot-password', 'reset-password', 'onboarding', 'billing', 'pricing',
  'contact', 'blog', 'flo', 'notifications', 'portal', 'verify-email',
]);

export function sanitizeAnalyticsUrl(value: string): string {
  try {
    const url = new URL(value, 'https://analytics.invalid');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '/[redacted]';
    const area = url.pathname.split('/')[1];
    if (!area) return '/';
    if (!ROUTE_AREAS.has(area)) return '/[redacted]';
    return `/${area}${url.pathname.split('/').filter(Boolean).length > 1 ? '/[redacted]' : ''}`;
  } catch {
    return '/[redacted]';
  }
}

const ALLOWED_EVENTS = new Set<string>([
  ...Object.values(ANALYTICS_EVENTS),
  '$pageview', '$pageleave', '$identify', '$groupidentify', '$opt_in',
]);
const URL_PROPERTIES = new Set([
  '$current_url', '$pathname', '$referrer', '$initial_current_url', '$initial_pathname', '$initial_referrer',
]);
// SDK IDs and Supabase user/tenant IDs are UUIDs; never accept email-based IDs.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSafeAnalyticsId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isAllowedAnalyticsEvent(value: string): boolean {
  return ALLOWED_EVENTS.has(value);
}

const ID_PROPERTIES = new Set([
  'distinct_id', '$device_id', '$user_id', '$anon_distinct_id', '$session_id', '$window_id',
  '$insert_id', '$pageview_id', '$prev_pageview_id', '$group_key',
  'tenant_id', 'from_tenant_id', 'to_tenant_id',
]);
const BOOLEAN_PROPERTIES = new Set([
  '$is_identified', '$process_person_profile', '$geoip_disable',
  'success', 'is_draft', 'vendor_recognized', 'converted',
]);
const COUNTER_PROPERTIES = new Set([
  '$screen_height', '$screen_width', '$viewport_height', '$viewport_width',
  'count', 'imported_count', 'step_index', 'length', 'trial_days', 'failed_attempts',
]);
const VERSION_PROPERTIES = new Set(['$lib_version', '$os_version', '$browser_version']);
const PLANS = new Set(['monthly', 'annual', 'trial', 'active', 'canceled']);
const ENUM_PROPERTIES: Readonly<Record<string, ReadonlySet<string>>> = {
  '$lib': new Set(['web']),
  '$os': new Set(['Windows', 'Mac OS X', 'Linux', 'Android', 'iOS', 'Chrome OS']),
  '$browser': new Set(['Chrome', 'Chrome iOS', 'Firefox', 'Firefox iOS', 'Safari', 'Mobile Safari', 'Microsoft Edge', 'Opera', 'Samsung Internet']),
  '$device_type': new Set(['Desktop', 'Mobile', 'Tablet']),
  '$group_type': new Set(['tenant']),
  method: new Set(['password', 'google', 'email', 'passkey']),
  plan: PLANS,
  from_plan: PLANS,
  to_plan: PLANS,
  status: new Set(['active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'success', 'failed', 'pending']),
  env: new Set(['test', 'production']),
  ksef_env: new Set(['test', 'production']),
  source: new Set(['manual', 'ocr', 'ksef', 'ksef_inbox', 'csv', 'xls', 'import']),
  format: new Set(['jpk_fa', 'kpir', 'csv', 'xlsx', 'xml', 'pdf', 'zip']),
  role: new Set(['owner', 'admin', 'member', 'accountant', 'viewer']),
  feature: ROUTE_AREAS,
};

export function sanitizeAnalyticsProperties(properties: Record<string, unknown>): Properties {
  const safe: Properties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (URL_PROPERTIES.has(key) && typeof value === 'string') {
      safe[key] = sanitizeAnalyticsUrl(value);
    } else if (ID_PROPERTIES.has(key) && typeof value === 'string' && UUID.test(value)) {
      safe[key] = value;
    } else if (BOOLEAN_PROPERTIES.has(key) && typeof value === 'boolean') {
      safe[key] = value;
    } else if (COUNTER_PROPERTIES.has(key) && typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000) {
      safe[key] = value;
    } else if (['duration_ms', '$prev_pageview_duration'].includes(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000) {
      safe[key] = value;
    } else if (key === 'confidence' && typeof value === 'number' && value >= 0 && value <= 1) {
      safe[key] = value;
    } else if (key === 'month' && typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 12) {
      safe[key] = value;
    } else if (VERSION_PROPERTIES.has(key) && typeof value === 'string' && /^\d{1,4}(?:\.\d{1,4}){0,3}$/.test(value)) {
      safe[key] = value;
    } else if (VERSION_PROPERTIES.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000) {
      safe[key] = value;
    } else if (Object.hasOwn(ENUM_PROPERTIES, key) && typeof value === 'string' && ENUM_PROPERTIES[key].has(value)) {
      safe[key] = value;
    } else if (key === '$groups' && typeof value === 'object' && value !== null) {
      const tenant = (value as Record<string, unknown>).tenant;
      if (typeof tenant === 'string' && UUID.test(tenant)) safe[key] = { tenant };
    }
  }
  return safe;
}
/** Final outbound allowlist also strips old persisted person properties. */
export function sanitizeAnalyticsEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event || !hasAnalyticsConsent() || !ALLOWED_EVENTS.has(event.event)) return null;
  const properties = sanitizeAnalyticsProperties(event.properties);
  // The browser SDK puts its PUBLIC project key in properties.token. Preserve
  // only the configured value; arbitrary access tokens remain excluded.
  const projectKey = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  if (projectKey && event.properties.token === projectKey) properties.token = projectKey;
  return {
    uuid: event.uuid,
    event: event.event,
    properties,
    ...(event.timestamp ? { timestamp: event.timestamp } : {}),
  };
}
