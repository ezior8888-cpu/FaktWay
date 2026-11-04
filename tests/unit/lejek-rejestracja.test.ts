import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_COOKIE_DELIVERED,
  decodeFirstTouch,
  encodeFirstTouch,
  parseFirstTouch,
} from '@/lib/analytics/attribution';

import { memoryDb, type MemoryDb, type Row } from '../helpers/fake-supabase-memory';
import { fakePosthog, lejekClient } from '../helpers/lejek-atrapy';

/**
 * signup_completed na prawdziwej ścieżce: akcja rejestracji i `/auth/callback`
 * (Google). Mock tylko HTTP: GoTrue, PostHog i baza w pamięci. Ciasteczko
 * pierwszego dotyku jest dla anonimowego gościa jedynym dowodem zgody, jaki
 * widzi serwer: przeglądarka zapisuje je dopiero po zgodzie i kasuje przy odwołaniu.
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  posthog: null as unknown,
  jar: new Map<string, string>(),
  signUp: vi.fn(),
  exchange: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error('redirect:' + path); } }));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ origin: 'https://app.example.test' }),
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name) } : undefined),
    set: (name: string, value: string) => { h.jar.set(name, value); },
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { signUp: h.signUp, exchangeCodeForSession: h.exchange } }),
  createAdminClient: () => lejekClient(h.db as MemoryDb),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => lejekClient(h.db as MemoryDb) }));
vi.mock('@/lib/analytics/posthog-node-client', () => ({ getPostHogNodeClient: () => h.posthog }));
vi.mock('@/lib/audit/log', () => ({ logAudit: h.audit }));
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '192.0.2.1' }));
vi.mock('@/lib/feature-flags/signups', () => ({ isSignupClosed: async () => false }));
vi.mock('@/lib/security/turnstile', () => ({ verifyTurnstile: async () => ({ success: true }) }));
vi.mock('@/lib/rate-limit/auth', () => ({ checkRegisterRateLimit: async () => ({ allowed: true }) }));
vi.mock('@/lib/auth/password', () => ({ validatePassword: async () => ({ valid: true }) }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: vi.fn() }));
vi.mock('@/lib/jobs/events', () => ({ userRegistered: { create: (data: unknown) => ({ data }) } }));
vi.mock('@/lib/legal/record', () => ({ recordTermsAcceptance: async () => ({ ok: true }) }));

const { signupWithEmail } = await import('@/app/(auth)/register/actions');
const { GET } = await import('@/app/auth/callback/route');

const USER = '00000000-0000-4000-8000-000000000041';
const CREATED_AT = '2026-11-02T10:00:00.000Z';
const NOW = new Date('2026-11-02T10:00:20.000Z');
const TOUCH = parseFirstTouch({
  url: 'https://faktway.pl/pricing?utm_source=google&utm_medium=cpc&utm_campaign=ksef',
  referrer: 'https://www.google.com/',
  now: new Date('2026-10-30T09:00:00Z'),
});

let posthog: ReturnType<typeof fakePosthog>;
let db: MemoryDb;

function row(): Row {
  return db.tables.users![0]!;
}

function form() {
  const data = new FormData();
  data.set('email', 'fixture@example.test');
  data.set('password', 'Fixture-Passw0rd!');
  data.set('name', 'Jan Testowy');
  data.set('terms', 'on');
  data.set('cf-turnstile-response', 'synthetic-turnstile-token');
  return data;
}

function goTrueUser(over: Record<string, unknown> = {}) {
  return {
    id: USER, email: 'fixture@example.test', created_at: CREATED_AT,
    identities: [{ provider: 'email' }], app_metadata: { provider: 'email' }, ...over,
  };
}

async function signup() {
  // Bez sesji (potwierdzenie e-mailem) akcja kończy się przekierowaniem.
  await expect(signupWithEmail(form())).rejects.toThrow('redirect:/login?success=check_email');
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.test');
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'production');
  posthog = fakePosthog();
  h.posthog = posthog;
  h.jar.clear();
  h.audit.mockReset();
  db = memoryDb({ users: [{ id: USER, analytics_consent: null, analytics_consent_at: null, signup_source: null }] });
  h.db = db;
  h.signUp.mockResolvedValue({ data: { user: goTrueUser(), session: null }, error: null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('rejestracja hasłem', () => {
  it('ze zgodą: źródło w bazie, jedno signup_completed z kanałem i prawdziwą chwilą założenia konta', async () => {
    h.jar.set(ATTRIBUTION_COOKIE, encodeFirstTouch(TOUCH));

    await signup();

    expect(row()).toMatchObject({ analytics_consent: 'granted', signup_source: TOUCH });
    expect(typeof row().analytics_consent_at).toBe('string');
    expect(posthog.nazwy()).toEqual(['signup_completed']);
    const message = posthog.messages[0]!;
    expect(message.distinctId).toBe(USER);
    expect(message.properties).toMatchObject({ method: 'password', source: 'google_ads' });
    expect(message.properties?.$set_once).toMatchObject({ utm_campaign: 'ksef' });
    expect(message.timestamp?.toISOString()).toBe(CREATED_AT);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'analytics.consent_changed',
      userId: USER,
      metadata: expect.objectContaining({ consent: 'granted', via: 'register_form' }),
    }));
  });

  it('bez zgody (bez ciasteczka): ani źródła w bazie, ani zdarzenia', async () => {
    await signup();
    expect(row()).toMatchObject({ analytics_consent: null, signup_source: null });
    expect(posthog.messages).toEqual([]);
  });

  it('ponowiony formularz niepotwierdzonego konta: to samo zdarzenie, wykres liczy je raz', async () => {
    h.jar.set(ATTRIBUTION_COOKIE, encodeFirstTouch(TOUCH));
    await signup();
    await signup();
    expect(posthog.messages).toHaveLength(2);
    expect(posthog.messages[1]!.uuid).toBe(posthog.messages[0]!.uuid);
    expect(posthog.sklejone('signup_completed')).toHaveLength(1);
  });

  it('ciasteczko jest jednorazowe: druga rejestracja w tej przeglądarce nie dostaje cudzego „tak” ani cudzego źródła', async () => {
    const SECOND = '00000000-0000-4000-8000-000000000042';
    h.jar.set(ATTRIBUTION_COOKIE, encodeFirstTouch(TOUCH));
    await signup();
    expect(row()).toMatchObject({ analytics_consent: 'granted', signup_source: TOUCH });
    expect(h.jar.get(ATTRIBUTION_COOKIE)).toBe(ATTRIBUTION_COOKIE_DELIVERED);

    db.tables.users!.push({ id: SECOND, analytics_consent: null, analytics_consent_at: null, signup_source: null });
    h.signUp.mockResolvedValue({ data: { user: goTrueUser({ id: SECOND }), session: null }, error: null });
    await signup();

    expect(db.tables.users![1]).toMatchObject({ analytics_consent: null, signup_source: null });
    expect(posthog.messages.filter((m) => m.distinctId === SECOND)).toEqual([]);
  });

  it('zapis na koncie się nie udał: ciasteczko zostaje, a wybór dotrze przy wejściu do panelu', async () => {
    const value = encodeFirstTouch(TOUCH);
    h.jar.set(ATTRIBUTION_COOKIE, value);
    db.failures['users:update'] = { code: '08006', message: 'połączenie zerwane' };
    await signup();
    expect(h.jar.get(ATTRIBUTION_COOKIE)).toBe(value);
  });

  it('zajęty adres: GoTrue zwraca konto bez tożsamości, więc ani zdarzenia, ani zapisu na cudzym id', async () => {
    h.jar.set(ATTRIBUTION_COOKIE, encodeFirstTouch(TOUCH));
    h.signUp.mockResolvedValue({ data: { user: goTrueUser({ identities: [] }), session: null }, error: null });
    await signup();
    expect(row()).toMatchObject({ analytics_consent: null, signup_source: null });
    expect(posthog.messages).toEqual([]);
    // To nie rejestracja, więc dowód zostaje dla prawdziwej.
    expect(decodeFirstTouch(h.jar.get(ATTRIBUTION_COOKIE))).toEqual(TOUCH);
  });

  it('decyzja już zapisana na koncie wygrywa z ciasteczkiem', async () => {
    h.jar.set(ATTRIBUTION_COOKIE, encodeFirstTouch(TOUCH));
    Object.assign(row(), { analytics_consent: 'denied', analytics_consent_at: '2026-11-02T10:00:10.000Z' });
    await signup();
    expect(row()).toMatchObject({ analytics_consent: 'denied', signup_source: null });
    expect(posthog.messages).toEqual([]);
  });

  it('podrobione ciasteczko: bez zapisu i bez zdarzenia', async () => {
    h.jar.set(ATTRIBUTION_COOKIE, 'nie-json');
    await signup();
    expect(row()).toMatchObject({ analytics_consent: null, signup_source: null });
    expect(posthog.messages).toEqual([]);
  });

  it('awaria analityki nie psuje rejestracji', async () => {
    h.jar.set(ATTRIBUTION_COOKIE, encodeFirstTouch(TOUCH));
    db.failures['users:update'] = { code: '08006', message: 'połączenie zerwane' };
    await signup();
    expect(posthog.messages).toEqual([]);
  });
});

describe('rejestracja przez Google (/auth/callback)', () => {
  const callback = () => GET(new Request('https://container.example.test/auth/callback?code=fixture-code'));
  const googleUser = (over: Record<string, unknown> = {}) => goTrueUser({
    identities: [{ provider: 'google' }], app_metadata: { provider: 'google', providers: ['google'] }, ...over,
  });

  it('nowe konto ze zgodą: źródło i signup_completed z metodą google, przekierowanie bez zmian', async () => {
    h.jar.set(ATTRIBUTION_COOKIE, encodeFirstTouch(TOUCH));
    h.exchange.mockResolvedValue({ data: { user: googleUser() }, error: null });

    const response = await callback();

    expect(response.headers.get('location')).toBe('https://app.example.test/dashboard');
    expect(row()).toMatchObject({ analytics_consent: 'granted', signup_source: TOUCH });
    expect(posthog.nazwy()).toEqual(['signup_completed']);
    expect(posthog.messages[0]!.properties).toMatchObject({ method: 'google', source: 'google_ads' });
    expect(posthog.messages[0]!.timestamp?.toISOString()).toBe(CREATED_AT);
  });

  it('ponowne logowanie Google na stare konto: nie liczy się jako rejestracja', async () => {
    h.jar.set(ATTRIBUTION_COOKIE, encodeFirstTouch(TOUCH));
    Object.assign(row(), { analytics_consent: 'granted', analytics_consent_at: CREATED_AT });
    h.exchange.mockResolvedValue({ data: { user: googleUser({ created_at: '2026-01-15T10:00:00.000Z' }) }, error: null });

    await callback();

    expect(posthog.messages).toEqual([]);
    expect(row().signup_source).toBeNull();
  });

  it('drugie wejście przez Google w oknie świeżości: to samo zdarzenie, sklejone do jednego', async () => {
    h.jar.set(ATTRIBUTION_COOKIE, encodeFirstTouch(TOUCH));
    h.exchange.mockResolvedValue({ data: { user: googleUser() }, error: null });
    await callback();
    await callback();
    expect(posthog.sklejone('signup_completed')).toHaveLength(1);
  });

  it('nowe konto: ciasteczko zużyte, kolejne konto Google w tej przeglądarce nie dostaje zgody', async () => {
    h.jar.set(ATTRIBUTION_COOKIE, encodeFirstTouch(TOUCH));
    h.exchange.mockResolvedValue({ data: { user: googleUser() }, error: null });
    await callback();
    expect(h.jar.get(ATTRIBUTION_COOKIE)).toBe(ATTRIBUTION_COOKIE_DELIVERED);
  });

  it('nowe konto bez zgody: bez źródła i bez zdarzenia', async () => {
    h.exchange.mockResolvedValue({ data: { user: googleUser() }, error: null });
    await callback();
    expect(row()).toMatchObject({ analytics_consent: null, signup_source: null });
    expect(posthog.messages).toEqual([]);
  });

  it('potwierdzenie e-maila po rejestracji hasłem: zdarzenie poszło już z formularza, tu nic', async () => {
    h.jar.set(ATTRIBUTION_COOKIE, encodeFirstTouch(TOUCH));
    h.exchange.mockResolvedValue({ data: { user: goTrueUser() }, error: null });
    await callback();
    expect(posthog.messages).toEqual([]);
  });

  it('awaria analityki nie zatrzymuje logowania', async () => {
    h.jar.set(ATTRIBUTION_COOKIE, encodeFirstTouch(TOUCH));
    db.failures['users:update'] = { code: '08006', message: 'połączenie zerwane' };
    db.failures['users:select'] = { code: '08006', message: 'połączenie zerwane' };
    h.exchange.mockResolvedValue({ data: { user: googleUser() }, error: null });
    const response = await callback();
    expect(response.headers.get('location')).toBe('https://app.example.test/dashboard');
  });
});
