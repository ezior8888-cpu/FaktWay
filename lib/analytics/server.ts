import 'server-only';

import { createHash } from 'node:crypto';

import { createAdminClient } from '@/lib/supabase/admin';

import { FUNNEL_EVENTS, type AnalyticsEventName, type AnalyticsProperties } from './events';
import { getPostHogNodeClient } from './posthog-node-client';
import {
  firstTouchPersonProperties,
  isAllowedAnalyticsEvent,
  isSafeAnalyticsId,
  sanitizeAnalyticsProperties,
  sanitizeFirstTouch,
} from './privacy';

/**
 * Jedyna droga zdarzeń z serwera do PostHoga: bramka zgody i te same listy
 * dozwolonych danych co w przeglądarce. Zgoda leży w `users.analytics_consent`,
 * bo jobs i webhook Stripe nie mają przeglądarki ani ciasteczek. Zdarzenia firmy
 * idą na najstarszego aktywnego właściciela: jego zgoda decyduje, a lejek w PostHogu
 * widzi jedną osobę od rejestracji po płatność. Brak zgody, błąd odczytu albo brak
 * właściciela = brak zdarzenia. Strażnik: tests/unit/analytics-bramka-zgody.test.ts.
 */
export type TrackServerInput = (
  | { userId: string; tenantId?: string }
  | { tenantId: string; userId?: undefined }
) & {
  event: AnalyticsEventName;
  properties?: AnalyticsProperties;
  /** Reviewed person attributes, such as the subscription plan. */
  setPersonProperties?: AnalyticsProperties;
  /**
   * Klucz jednego zdarzenia (firma, użytkownik, faktura Stripe). Daje deterministyczny
   * uuid, więc ponowienie joba albo webhooka nie zlicza się drugi raz. SDK tylko
   * przekazuje uuid (bez niego nadaje świeży uuidv7), a skleja magazyn PostHoga po
   * (data z `timestamp`, nazwa, distinct id, uuid). Dlatego ponawialne zdarzenia
   * niosą też `timestamp` z prawdziwej chwili: ponowienie następnego dnia to ten sam wiersz.
   */
  dedupeKey?: string;
  timestamp?: Date | string | null;
};

// Stała przestrzeń nazw: zmiana rozkleiłaby zdarzenia przy ponowieniu w trakcie wdrożenia.
const EVENT_UUID_NAMESPACE = 'faktway-analytics-event-v1';

/** UUID v5 (RFC 9562): SHA-1 z nazwy zdarzenia i klucza. */
function eventUuid(event: string, key: string): string {
  const hex = createHash('sha1').update(`${EVENT_UUID_NAMESPACE}:${event}:${key}`).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return [hex.slice(0, 8), hex.slice(8, 12), `5${hex.slice(13, 16)}`, variant + hex.slice(18, 20), hex.slice(20, 32)].join('-');
}

function eventTimestamp(value: TrackServerInput['timestamp']): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

interface ConsentedSubject {
  userId: string;
  signupSource: unknown;
}

/** Bramka zgody. Czyta bazę przy każdym zdarzeniu: odwołanie działa od razu. Rzuca przy błędzie bazy. */
async function consentedSubject(subject: { userId?: string; tenantId?: string }): Promise<ConsentedSubject | null> {
  const admin = await createAdminClient();
  let userId: unknown = subject.userId;
  if (!userId) {
    if (!isSafeAnalyticsId(subject.tenantId)) return null;
    const { data, error } = await admin.rpc('analytics_tenant_owner', { p_tenant_id: subject.tenantId });
    if (error) throw new Error(`analytics owner lookup failed: ${error.code ?? 'unknown'}`);
    userId = data;
  }
  if (!isSafeAnalyticsId(userId)) return null;

  const { data, error } = await admin
    .from('users')
    .select('analytics_consent, signup_source')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error(`analytics consent lookup failed: ${error.code ?? 'unknown'}`);
  if (data?.analytics_consent !== 'granted') return null;
  return { userId, signupSource: data.signup_source };
}

/** Analytics failure must not fail the business operation. */
export async function trackServer(input: TrackServerInput): Promise<void> {
  if (!isAllowedAnalyticsEvent(input.event)) return;
  const c = getPostHogNodeClient();
  if (!c) return;
  try {
    const subject = await consentedSubject(input);
    if (!subject) return;

    const touch = FUNNEL_EVENTS.has(input.event) ? sanitizeFirstTouch(subject.signupSource) : null;
    const properties = sanitizeAnalyticsProperties({
      ...input.properties,
      ...(input.tenantId ? { tenant_id: input.tenantId } : {}),
      ...(touch ? { source: touch.channel } : {}),
    });
    const person = sanitizeAnalyticsProperties(input.setPersonProperties ?? {});
    const timestamp = eventTimestamp(input.timestamp);

    c.capture({
      distinctId: subject.userId,
      event: input.event,
      // Właściwości osoby tylko w `properties`: SDK ignoruje `$set` podane obok nich.
      properties: {
        ...properties,
        ...(Object.keys(person).length > 0 ? { $set: person } : {}),
        // $set_once: pierwszy dotyk zostaje pierwszy, także gdy zdarzenia wyjdą nie po kolei.
        ...(touch ? { $set_once: firstTouchPersonProperties(touch) } : {}),
      },
      ...(input.tenantId ? { groups: { tenant: input.tenantId } } : {}),
      ...(input.dedupeKey ? { uuid: eventUuid(input.event, input.dedupeKey) } : {}),
      ...(timestamp ? { timestamp } : {}),
    });
    await c.flush();
  } catch (err) {
    console.error('[analytics:server] capture failed:', err);
  }
}

/** Associates only reviewed attributes with a pseudonymous user ID, under the same consent gate. */
export async function identifyServer(
  distinctId: string,
  properties: AnalyticsProperties,
): Promise<void> {
  if (!isSafeAnalyticsId(distinctId)) return;
  const c = getPostHogNodeClient();
  if (!c) return;
  try {
    if (!(await consentedSubject({ userId: distinctId }))) return;
    c.identify({ distinctId, properties: sanitizeAnalyticsProperties(properties) });
    await c.flush();
  } catch (err) {
    console.error('[analytics:server] identify failed:', err);
  }
}
