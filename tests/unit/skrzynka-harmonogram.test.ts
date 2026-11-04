import { describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';

import { CRON_JOBS } from '@/lib/jobs/queues';
import {
  INBOX_ACTIVITY_TIERS,
  INBOX_DISPATCH_TICK_SECONDS,
  INBOX_POLL_SLOTS_DEFAULT,
  INBOX_TIER_INTERVAL_MS,
  inboxActivityTier,
  inboxDispatchCapacity,
  inboxDispatchLimit,
  inboxExpectedGapSeconds,
  inboxExpectedMaxGapMs,
  inboxLagYieldThresholdMs,
  inboxOldestLagSeconds,
  inboxPhaseFraction,
  inboxPollSlots,
  inboxRateLimitBrake,
  isInboxNight,
  isInboxPollJobRedundant,
  nextInboxPollAfterError,
  nextInboxPollAfterSuccess,
  type InboxActivityTier,
} from '@/lib/ksef/inbox-schedule';

/**
 * Harmonogram skrzynki (FaktWay 1.0, sekcja 3 pkt 6): czyste rachunki terminów.
 * Tu są wszystkie liczby decyzji; SQL dostaje je parametrami, więc to jest
 * jedyny test, który trzeba zmienić przy zmianie częstotliwości.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** Środek dnia w Polsce (poniedziałek). */
const NOON = new Date('2026-11-02T11:00:00Z');
/** Północ w Polsce. */
const MIDNIGHT = new Date('2026-11-02T23:30:00Z');
const ago = (ms: number, from = NOON) => new Date(from.getTime() - ms);

function tier(input: Partial<Parameters<typeof inboxActivityTier>[0]>) {
  return inboxActivityTier({
    now: NOON,
    lastInvoiceAt: null,
    lastActivityAt: null,
    subscriptionActive: true,
    ...input,
  });
}

describe('poziom aktywności', () => {
  it('gorąca: nowa faktura w 7 dni albo ktoś aktywny w 24 h', () => {
    expect(tier({ lastInvoiceAt: ago(7 * DAY - MIN) })).toBe('hot');
    expect(tier({ lastActivityAt: ago(24 * HOUR - MIN) })).toBe('hot');
  });

  it('ciepła: cokolwiek w 30 dni, ale poza progami gorącej', () => {
    expect(tier({ lastInvoiceAt: ago(7 * DAY + MIN) })).toBe('warm');
    expect(tier({ lastActivityAt: ago(24 * HOUR + MIN) })).toBe('warm');
    expect(tier({ lastActivityAt: ago(30 * DAY - MIN) })).toBe('warm');
    expect(tier({ lastInvoiceAt: ago(30 * DAY - MIN) })).toBe('warm');
  });

  it('zimna: nic od 30 dni, także bez żadnej historii', () => {
    expect(tier({ lastInvoiceAt: ago(30 * DAY + MIN), lastActivityAt: ago(30 * DAY + MIN) })).toBe('cold');
    expect(tier({})).toBe('cold');
  });

  it('uśpiona: bez subskrypcji i bez ruchu, nawet gdy dostawcy dalej wystawiają faktury', () => {
    expect(tier({ subscriptionActive: false })).toBe('dormant');
    expect(tier({ subscriptionActive: false, lastInvoiceAt: ago(MIN) })).toBe('dormant');
    expect(tier({ subscriptionActive: false, lastActivityAt: ago(24 * HOUR + MIN) })).toBe('dormant');
  });

  it('człowiek w aplikacji wygrywa z brakiem subskrypcji: kafel obiecuje mu 15 minut', () => {
    expect(tier({ subscriptionActive: false, lastActivityAt: ago(MIN) })).toBe('hot');
  });

  it('nieczytelna data nie robi firmy gorącą', () => {
    expect(tier({ lastActivityAt: 'nie-data' })).toBe('cold');
  });
});

describe('termin po udanym przebiegu', () => {
  it.each<[InboxActivityTier, number]>([
    ['hot', 15 * MIN],
    ['warm', 60 * MIN],
    ['cold', 6 * HOUR],
    ['dormant', 24 * HOUR],
  ])('%s: w rytmie dokładnie %i ms między kolejnymi terminami w dzień', (level, interval) => {
    expect(INBOX_TIER_INTERVAL_MS[level]).toBe(interval);
    // Dzień bez nocy w środku: od 7:00 do 22:00 w Polsce dla krótkich poziomów.
    const first = nextInboxPollAfterSuccess({ tenantId: TENANT, tier: level, now: new Date('2026-11-02T06:00:00Z') });
    const second = nextInboxPollAfterSuccess({ tenantId: TENANT, tier: level, now: first });
    if (level === 'cold') {
      // Cold może wpaść w noc i wtedy idzie rzadziej; sprawdzone niżej.
      expect(second.getTime() - first.getTime()).toBeGreaterThanOrEqual(interval);
    } else {
      expect(second.getTime() - first.getTime()).toBe(interval);
    }
  });

  it('spóźniony przebieg nie zmienia rytmu: następny termin to następne miejsce firmy w cyklu', () => {
    const due = nextInboxPollAfterSuccess({ tenantId: TENANT, tier: 'hot', now: NOON });
    const onTime = nextInboxPollAfterSuccess({ tenantId: TENANT, tier: 'hot', now: due });
    const late = nextInboxPollAfterSuccess({ tenantId: TENANT, tier: 'hot', now: new Date(due.getTime() + 5 * MIN) });
    expect(late.getTime()).toBe(onTime.getTime());
  });

  it('przebieg spóźniony o więcej niż pół cyklu bierze następne miejsce, więc przeciążenie się nie piętrzy', () => {
    const due = nextInboxPollAfterSuccess({ tenantId: TENANT, tier: 'hot', now: NOON });
    const late = nextInboxPollAfterSuccess({ tenantId: TENANT, tier: 'hot', now: new Date(due.getTime() + 9 * MIN) });
    expect(late.getTime()).toBe(due.getTime() + 30 * MIN);
  });

  it('nigdy bliżej niż pół odstępu (poza uśpioną)', () => {
    for (let i = 0; i < 200; i += 1) {
      const now = new Date(NOON.getTime() + i * 73 * MIN);
      for (const level of ['hot', 'warm', 'cold'] as const) {
        const next = nextInboxPollAfterSuccess({ tenantId: randomUUID(), tier: level, now });
        expect(next.getTime() - now.getTime()).toBeGreaterThanOrEqual(INBOX_TIER_INTERVAL_MS[level] / 2);
        expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(inboxExpectedMaxGapMs(level));
      }
    }
  });

  it('uśpiona: nigdy rzadziej niż raz na dobę, także w nocy i poza swoim miejscem w cyklu', () => {
    for (let i = 0; i < 500; i += 1) {
      const now = new Date(MIDNIGHT.getTime() + i * 47 * MIN);
      const next = nextInboxPollAfterSuccess({ tenantId: randomUUID(), tier: 'dormant', now });
      expect(next.getTime() - now.getTime()).toBeGreaterThan(0);
      expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(24 * HOUR);
    }
  });
});

describe('noc 22-6 w Polsce', () => {
  it('rozpoznaje granice w strefie Warszawy, nie w UTC', () => {
    expect(isInboxNight(new Date('2026-11-02T20:59:00Z'))).toBe(false); // 21:59 w Polsce
    expect(isInboxNight(new Date('2026-11-02T21:00:00Z'))).toBe(true); // 22:00
    expect(isInboxNight(new Date('2026-11-03T04:59:00Z'))).toBe(true); // 5:59
    expect(isInboxNight(new Date('2026-11-03T05:00:00Z'))).toBe(false); // 6:00
    // Czas letni: inne przesunięcie względem UTC.
    expect(isInboxNight(new Date('2026-07-01T20:00:00Z'))).toBe(true); // 22:00
    expect(isInboxNight(new Date('2026-07-01T19:59:00Z'))).toBe(false); // 21:59
  });

  it('ciepła i zimna idą dwa razy rzadziej, gorąca bez zmian', () => {
    const inCycle = (level: InboxActivityTier, now: Date) => {
      const first = nextInboxPollAfterSuccess({ tenantId: TENANT, tier: level, now });
      const second = nextInboxPollAfterSuccess({ tenantId: TENANT, tier: level, now: first });
      return second.getTime() - first.getTime();
    };
    expect(inCycle('hot', MIDNIGHT)).toBe(15 * MIN);
    const warmAtNight = nextInboxPollAfterSuccess({ tenantId: TENANT, tier: 'warm', now: MIDNIGHT });
    expect(warmAtNight.getTime() - MIDNIGHT.getTime()).toBeGreaterThanOrEqual(HOUR);
    expect(warmAtNight.getTime() - MIDNIGHT.getTime()).toBeLessThanOrEqual(3 * HOUR);
    const coldAtNight = nextInboxPollAfterSuccess({ tenantId: TENANT, tier: 'cold', now: MIDNIGHT });
    expect(coldAtNight.getTime() - MIDNIGHT.getTime()).toBeGreaterThanOrEqual(6 * HOUR);
    expect(coldAtNight.getTime() - MIDNIGHT.getTime()).toBeLessThanOrEqual(18 * HOUR);
  });

  it('dzień, który wypadłby w nocy, liczy się już jak noc', () => {
    // Zimna o 21:00: termin za 3-9 h trafiłby w noc, więc wchodzi siatka 12 h.
    const evening = new Date('2026-11-02T20:00:00Z');
    const next = nextInboxPollAfterSuccess({ tenantId: TENANT, tier: 'cold', now: evening });
    expect(next.getTime() - evening.getTime()).toBeGreaterThanOrEqual(6 * HOUR);
  });
});

describe('rozrzut terminów z id firmy', () => {
  const ids = Array.from({ length: 5000 }, () => randomUUID());

  it('ten sam id daje zawsze ten sam ułamek, w [0, 1)', () => {
    for (const id of ids.slice(0, 50)) {
      const value = inboxPhaseFraction(id);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      expect(inboxPhaseFraction(id)).toBe(value);
    }
  });

  it('5000 firm z tym samym „teraz” nie rusza w tej samej minucie', () => {
    const perMinute = new Map<number, number>();
    for (const id of ids) {
      const at = nextInboxPollAfterSuccess({ tenantId: id, tier: 'hot', now: NOON });
      const minute = Math.floor(at.getTime() / MIN);
      perMinute.set(minute, (perMinute.get(minute) ?? 0) + 1);
    }
    const uniform = ids.length / 15;
    // 15 minut cyklu może zahaczyć o 16 minut kalendarzowych.
    expect(perMinute.size).toBeGreaterThanOrEqual(15);
    expect(Math.max(...perMinute.values())).toBeLessThan(uniform * 1.3);
  });

  it('rozrzut działa też dla kolejnych, podobnych identyfikatorów', () => {
    const similar = Array.from({ length: 5000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const buckets = new Array<number>(15).fill(0);
    for (const id of similar) buckets[Math.floor(inboxPhaseFraction(id) * 15)]! += 1;
    expect(Math.max(...buckets)).toBeLessThan((similar.length / 15) * 1.3);
    expect(Math.min(...buckets)).toBeGreaterThan((similar.length / 15) * 0.7);
  });

  it('po awarii (wszystkie należne naraz) następny cykl jest znów równomierny', () => {
    const afterOutage = new Date(NOON.getTime() + 3 * HOUR);
    const terms = ids.map((id) => nextInboxPollAfterSuccess({ tenantId: id, tier: 'hot', now: afterOutage }).getTime());
    const span = Math.max(...terms) - Math.min(...terms);
    expect(span).toBeGreaterThan(14 * MIN);
  });
});

describe('termin po błędzie', () => {
  const after = (errorClass: 'credentials' | 'ksef' | 'rate_limit' | 'other', n: number, extra: { tier?: InboxActivityTier; retryAfterMs?: number | null } = {}) =>
    nextInboxPollAfterError({
      tenantId: TENANT,
      tier: extra.tier ?? 'hot',
      errorClass,
      consecutiveErrors: n,
      retryAfterMs: extra.retryAfterMs,
      now: NOON,
    }).getTime() - NOON.getTime();

  it('zły certyfikat: odstęp rośnie do 24 h i dalej nie rośnie', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 40].map((n) => after('credentials', n));
    for (let i = 1; i < 6; i += 1) expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    expect(delays[0]).toBeGreaterThanOrEqual(HOUR);
    expect(delays[0]).toBeLessThan(2 * HOUR);
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(24 * HOUR);
    expect(delays[7]).toBe(24 * HOUR);
  });

  it('błąd po stronie KSeF nie karze firmy tak jak zły certyfikat', () => {
    for (const n of [1, 3, 6, 12]) {
      expect(after('ksef', n)).toBeLessThan(after('credentials', n));
      expect(after('ksef', n, { tier: 'cold' })).toBeLessThanOrEqual(HOUR * 1.2);
    }
    expect(after('ksef', 1)).toBeLessThan(10 * MIN);
  });

  it('firma gorąca podczas awarii KSeF nie wypada poza swój rytm 15 minut (z rozrzutem)', () => {
    expect(after('ksef', 20)).toBeLessThanOrEqual(15 * MIN * 1.2);
    expect(after('other', 20)).toBeLessThanOrEqual(15 * MIN * 1.2);
  });

  it('429: czekamy co najmniej tyle, ile każe Retry-After, a licznik błędów tego nie zwiększa', () => {
    expect(after('rate_limit', 1, { retryAfterMs: 120_000 })).toBeGreaterThanOrEqual(120_000);
    expect(after('rate_limit', 1, { retryAfterMs: 120_000 })).toBe(after('rate_limit', 9, { retryAfterMs: 120_000 }));
    expect(after('rate_limit', 1, { retryAfterMs: 1000 })).toBeGreaterThanOrEqual(MIN);
    expect(after('rate_limit', 1, { retryAfterMs: null })).toBeGreaterThanOrEqual(15 * MIN);
    expect(after('rate_limit', 1, { retryAfterMs: 90 * DAY })).toBeLessThanOrEqual(24 * HOUR);
  });

  it('po awarii firmy nie wracają w tej samej minucie', () => {
    const ids = Array.from({ length: 500 }, () => randomUUID());
    const terms = new Set(ids.map((id) => nextInboxPollAfterError({
      tenantId: id, tier: 'hot', errorClass: 'ksef', consecutiveErrors: 3, now: NOON,
    }).getTime()));
    expect(terms.size).toBeGreaterThan(400);
  });
});

describe('limit taktu', () => {
  it('sloty: domyślnie 16, zmienna środowiskowa, zła wartość nie zatrzymuje workera', () => {
    expect(INBOX_POLL_SLOTS_DEFAULT).toBe(16);
    expect(inboxPollSlots({})).toBe(INBOX_POLL_SLOTS_DEFAULT);
    expect(inboxPollSlots({ KSEF_INBOX_POLL_SLOTS: '12' })).toBe(12);
    expect(inboxPollSlots({ KSEF_INBOX_POLL_SLOTS: 'dużo' })).toBe(INBOX_POLL_SLOTS_DEFAULT);
    expect(inboxPollSlots({ KSEF_INBOX_POLL_SLOTS: '0' })).toBe(INBOX_POLL_SLOTS_DEFAULT);
    expect(inboxPollSlots({ KSEF_INBOX_POLL_SLOTS: '-3' })).toBe(INBOX_POLL_SLOTS_DEFAULT);
    expect(inboxPollSlots({ KSEF_INBOX_POLL_SLOTS: '9999' })).toBe(64);
  });

  it('pojemność: slot przerabia najwyżej 30 zadań na minutę (pętla pg-boss co 2 s)', () => {
    expect(inboxDispatchCapacity(8)).toBe(240);
    expect(inboxDispatchCapacity(4)).toBe(120);
  });

  it('limit to pojemność minus zlecenia w toku, nigdy poniżej zera', () => {
    expect(inboxDispatchLimit({ slots: 8, inFlight: 0, braking: false })).toBe(240);
    expect(inboxDispatchLimit({ slots: 8, inFlight: 200, braking: false })).toBe(40);
    expect(inboxDispatchLimit({ slots: 8, inFlight: 500, braking: false })).toBe(0);
  });

  it('hamulec 429 zmniejsza pojemność czterokrotnie, licząc zlecenia w toku', () => {
    expect(inboxDispatchLimit({ slots: 8, inFlight: 0, braking: true })).toBe(60);
    expect(inboxDispatchLimit({ slots: 8, inFlight: 100, braking: true })).toBe(0);
  });

  it('hamulec: pojedyncze 429 go nie włączają, duży udział firm tak', () => {
    expect(inboxRateLimitBrake({ polledRecent: 100, rateLimitedRecent: 4 })).toBe(false);
    expect(inboxRateLimitBrake({ polledRecent: 1000, rateLimitedRecent: 30 })).toBe(false);
    expect(inboxRateLimitBrake({ polledRecent: 100, rateLimitedRecent: 20 })).toBe(true);
    expect(inboxRateLimitBrake({ polledRecent: 0, rateLimitedRecent: 5 })).toBe(true);
  });

  it('cron rozsyłki chodzi co minutę, zgodnie z założeniem limitu', () => {
    const cron = CRON_JOBS.find((job) => job.queue === 'cron.inbox-polling');
    expect(cron?.cron).toBe('* * * * *');
    expect(INBOX_DISPATCH_TICK_SECONDS).toBe(60);
  });

  it('opóźnienie najstarszej: sekundy, zero gdy nic nie czeka', () => {
    expect(inboxOldestLagSeconds(null, NOON)).toBe(0);
    expect(inboxOldestLagSeconds(ago(90_000).toISOString(), NOON)).toBe(90);
    expect(inboxOldestLagSeconds(new Date(NOON.getTime() + MIN).toISOString(), NOON)).toBe(0);
  });
});

describe('zadanie zbędne', () => {
  const future = new Date(NOON.getTime() + MIN).toISOString();
  const past = ago(MIN).toISOString();

  it('bez dzierżawy i z terminem w przyszłości: ktoś już obsłużył firmę', () => {
    expect(isInboxPollJobRedundant({ next_poll_at: future, poll_lease_until: null }, NOON)).toBe(true);
  });

  it('z dzierżawą albo z należnym terminem: przebieg idzie', () => {
    expect(isInboxPollJobRedundant({ next_poll_at: future, poll_lease_until: future }, NOON)).toBe(false);
    expect(isInboxPollJobRedundant({ next_poll_at: past, poll_lease_until: null }, NOON)).toBe(false);
  });

  it('bez wiersza (zlecenie sprzed wdrożenia): przebieg idzie jak dawniej', () => {
    expect(isInboxPollJobRedundant(null, NOON)).toBe(false);
  });
});

describe('progi zależne od poziomu', () => {
  it('normalny odstęp rośnie z poziomem, uśpiona dokładnie doba', () => {
    const gaps = INBOX_ACTIVITY_TIERS.map(inboxExpectedMaxGapMs);
    for (let i = 1; i < gaps.length; i += 1) expect(gaps[i]!).toBeGreaterThan(gaps[i - 1]!);
    expect(inboxExpectedMaxGapMs('dormant')).toBe(24 * HOUR);
    expect(inboxExpectedGapSeconds().hot).toBe(22.5 * 60);
  });

  it('historia ustępuje skrzynce tylko przy prawdziwej zaległości względem poziomu', () => {
    const minimum = 60 * MIN;
    expect(inboxLagYieldThresholdMs(null, minimum)).toBe(minimum);
    expect(inboxLagYieldThresholdMs('hot', minimum)).toBe(minimum);
    expect(inboxLagYieldThresholdMs('cold', minimum)).toBeGreaterThan(6 * HOUR);
    expect(inboxLagYieldThresholdMs('dormant', minimum)).toBeGreaterThan(24 * HOUR);
  });
});
