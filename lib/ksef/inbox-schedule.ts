/**
 * Harmonogram odpytywania Skrzynki KSeF: jedno miejsce na wszystkie liczby
 * i rachunki terminów (FaktWay 1.0, sekcja 3 pkt 6; sesje 13, 14 i 17 planu
 * skalowania). Czysty moduł: bez bazy, bez KSeF, bez importów, zegar z
 * argumentu. Bazą rozmawia `inbox-schedule-db.ts`, a SQL (00160) dostaje progi
 * jako parametry, więc w migracji nie ma drugiej kopii tych wartości.
 *
 * Dlaczego rzadziej dla części firm, a nie „co 15 minut dla wszystkich”:
 * firma bez ruchu nie potrzebuje świeżych danych, a okno zapytania idzie od
 * HWM, więc po dłuższej przerwie przebieg nadrabia cały okres i żadna faktura
 * nie ginie. Oszczędzamy zapytania, nie kompletność.
 *
 * Dokumentacja MF (CIRFMF/ksef-docs, `limity/limity-api.md`), stan 02.11.2026:
 *   - `/invoices/query/metadata`: 8/s, 16/min, 20/h na parę (kontekst NIP, adres IP),
 *   - interwał cykliczny nie krótszy niż 15 min na podmiot, stąd poziom gorący,
 *   - synchronizacja na żądanie użytkownika jest dozwolona, stąd „Sprawdź teraz”,
 *   - powtarzane 429 wydłużają blokadę, także dla zakresu adresów, stąd hamulec.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const INBOX_ACTIVITY_TIERS = ['hot', 'warm', 'cold', 'dormant'] as const;
export type InboxActivityTier = (typeof INBOX_ACTIVITY_TIERS)[number];

export type InboxPollErrorClass = 'credentials' | 'ksef' | 'rate_limit' | 'other';

// ═══════════════════════════════════════════════════════════════
// Częstotliwość
// ═══════════════════════════════════════════════════════════════

/** Podstawowy odstęp poziomu. */
export const INBOX_TIER_INTERVAL_MS: Readonly<Record<InboxActivityTier, number>> = {
  hot: 15 * MINUTE_MS,
  warm: 60 * MINUTE_MS,
  cold: 6 * HOUR_MS,
  dormant: 24 * HOUR_MS,
};

/** Nowa faktura młodsza niż tyle = firma gorąca. */
export const INBOX_HOT_INVOICE_WINDOW_MS = 7 * DAY_MS;
/** Ktoś z firmy aktywny w tym oknie = firma gorąca. */
export const INBOX_HOT_ACTIVITY_WINDOW_MS = DAY_MS;
/** Cokolwiek w tym oknie = firma ciepła; nic = zimna. */
export const INBOX_WARM_WINDOW_MS = 30 * DAY_MS;

/** Noc w Polsce: poziomy poza gorącym idą dwa razy rzadziej, ale nigdy rzadziej niż raz na dobę. */
export const INBOX_NIGHT_START_HOUR = 22;
export const INBOX_NIGHT_END_HOUR = 6;
export const INBOX_NIGHT_MULTIPLIER = 2;
export const INBOX_MAX_INTERVAL_MS = DAY_MS;

/**
 * Najmniejszy odstęp od bieżącego przebiegu jako część odstępu poziomu.
 * Spóźniony przebieg nie goni straconego terminu tuż po sobie, tylko bierze
 * następny termin firmy, więc przy przeciążeniu ruch sam się zmniejsza.
 */
const INBOX_MIN_GAP_SHARE = 0.5;

/** Nadrabianie po przerwie dłuższej niż limit zakresu API: następne okno po tylu ms (12/h przy limicie 20/h). */
export const INBOX_CATCH_UP_INTERVAL_MS = 5 * MINUTE_MS;

/** Subskrypcja, która daje firmie poziom inny niż uśpiony (próba, opłacona, w trakcie ponawiania płatności). */
export const INBOX_ACTIVE_SUBSCRIPTION_STATUSES: readonly string[] = ['trialing', 'active', 'past_due'];

const warsawHour = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Warsaw',
  hour: 'numeric',
  hourCycle: 'h23',
});

export function isInboxNight(at: Date): boolean {
  const hour = Number(warsawHour.format(at));
  return hour >= INBOX_NIGHT_START_HOUR || hour < INBOX_NIGHT_END_HOUR;
}

function ageMs(at: Date | string | null | undefined, now: Date): number {
  if (!at) return Number.POSITIVE_INFINITY;
  const value = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(value) ? now.getTime() - value : Number.POSITIVE_INFINITY;
}

export interface InboxTierInput {
  now: Date;
  /** Ostatnia nowa faktura zapisana przez skrzynkę. */
  lastInvoiceAt: Date | string | null | undefined;
  /** Ostatnia aktywność kogokolwiek z firmy w aplikacji. */
  lastActivityAt: Date | string | null | undefined;
  /** Aktywna subskrypcja albo próba. */
  subscriptionActive: boolean;
}

/**
 * Poziom aktywności firmy.
 *
 * Człowiek w aplikacji wygrywa ze wszystkim: dziś nic nie wymaga subskrypcji do
 * korzystania z programu, a kafel obiecuje patrzącemu „co 15 minut”. Bez ruchu
 * brak subskrypcji wygrywa z fakturami: dostawcy dalej wystawiają faktury porzuconej
 * firmie i inaczej byłaby gorąca na zawsze.
 */
export function inboxActivityTier(input: InboxTierInput): InboxActivityTier {
  const invoiceAge = ageMs(input.lastInvoiceAt, input.now);
  const activityAge = ageMs(input.lastActivityAt, input.now);
  if (activityAge <= INBOX_HOT_ACTIVITY_WINDOW_MS) return 'hot';
  if (!input.subscriptionActive) return 'dormant';
  if (invoiceAge <= INBOX_HOT_INVOICE_WINDOW_MS) return 'hot';
  if (Math.min(invoiceAge, activityAge) <= INBOX_WARM_WINDOW_MS) return 'warm';
  return 'cold';
}

/**
 * Stały ułamek [0, 1) wyliczany z id firmy (FNV-1a z domieszaniem końcowym).
 * Bez `node:crypto`, żeby moduł mógł iść także do kodu ekranu.
 */
export function inboxPhaseFraction(tenantId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < tenantId.length; i += 1) {
    hash ^= tenantId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 2 ** 32;
}

/** Pierwszy termin firmy po `afterMs`: każda firma ma stałe miejsce w cyklu, zależne od jej id. */
function nextSlotMs(afterMs: number, intervalMs: number, fraction: number): number {
  const phase = Math.floor(fraction * intervalMs);
  return (Math.floor((afterMs - phase) / intervalMs) + 1) * intervalMs + phase;
}

/**
 * Termin po udanym przebiegu. Firma zawsze wraca na swoje miejsce w cyklu,
 * więc po awarii (wszystko należne naraz) następny cykl jest znów równomierny,
 * a tysiące firm nie ruszają w tej samej minucie.
 *
 * Uśpiona nie ma minimalnego odstępu: bez tego pierwszy przebieg poza swoim
 * miejscem w cyklu wypadałby dalej niż za dobę, a „co 24 h” to górna granica.
 */
export function nextInboxPollAfterSuccess(input: {
  tenantId: string;
  tier: InboxActivityTier;
  now: Date;
}): Date {
  const { tenantId, tier, now } = input;
  const fraction = inboxPhaseFraction(tenantId);
  const nowMs = now.getTime();
  const base = INBOX_TIER_INTERVAL_MS[tier];
  const slot = (intervalMs: number) =>
    nextSlotMs(tier === 'dormant' ? nowMs : nowMs + intervalMs * INBOX_MIN_GAP_SHARE, intervalMs, fraction);

  if (tier === 'hot' || tier === 'dormant') return new Date(slot(base));

  const nightInterval = Math.min(base * INBOX_NIGHT_MULTIPLIER, INBOX_MAX_INTERVAL_MS);
  if (isInboxNight(now)) return new Date(slot(nightInterval));
  const dayTerm = slot(base);
  return new Date(isInboxNight(new Date(dayTerm)) ? slot(nightInterval) : dayTerm);
}

/** Najdłuższy normalny odstęp między przebiegami poziomu (noc + firma poza swoim miejscem w cyklu). */
export function inboxExpectedMaxGapMs(tier: InboxActivityTier): number {
  if (tier === 'dormant') return INBOX_MAX_INTERVAL_MS;
  if (tier === 'hot') return INBOX_TIER_INTERVAL_MS.hot * (1 + INBOX_MIN_GAP_SHARE);
  const nightInterval = Math.min(INBOX_TIER_INTERVAL_MS[tier] * INBOX_NIGHT_MULTIPLIER, INBOX_MAX_INTERVAL_MS);
  return nightInterval * (1 + INBOX_MIN_GAP_SHARE);
}

// ═══════════════════════════════════════════════════════════════
// Błędy
// ═══════════════════════════════════════════════════════════════

/** Zły certyfikat: 1 h, 2 h, 4 h … do doby. Naprawia klient; nowy certyfikat zeruje licznik (00160). */
const INBOX_CREDENTIALS_BACKOFF_BASE_MS = HOUR_MS;
/** Błąd po stronie KSeF albo naszej: 5, 10, 20 … minut. Firma nie jest niczemu winna, więc krótko. */
const INBOX_TRANSIENT_BACKOFF_BASE_MS = 5 * MINUTE_MS;
const INBOX_TRANSIENT_BACKOFF_MAX_MS = HOUR_MS;
/** 429 bez `Retry-After`: jak w historii KSeF (`RATE_LIMIT_DEFAULT_MS`). */
const INBOX_RATE_LIMIT_DEFAULT_MS = 15 * MINUTE_MS;
const INBOX_RATE_LIMIT_MIN_MS = MINUTE_MS;
/** Rozrzut ponowień, żeby po awarii wszystkie firmy nie wróciły w tej samej minucie. */
const INBOX_ERROR_JITTER_SHARE = 0.2;

function backoffMs(baseMs: number, consecutiveErrors: number, maxMs: number): number {
  const exponent = Math.min(Math.max(consecutiveErrors, 1) - 1, 20);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

/**
 * Termin po nieudanym przebiegu. Błąd po stronie KSeF (5xx, 429) nie oddala
 * firmy poza jej zwykły rytm na dłużej niż godzinę; zły certyfikat oddala
 * ją do doby, bo pytanie co 15 minut niczego nie zmieni, a 401 z KSeF też
 * jest liczone do limitów.
 */
export function nextInboxPollAfterError(input: {
  tenantId: string;
  tier: InboxActivityTier;
  errorClass: InboxPollErrorClass;
  /** Licznik PO tym błędzie (pierwszy błąd = 1). */
  consecutiveErrors: number;
  retryAfterMs?: number | null;
  now: Date;
}): Date {
  const { tenantId, tier, errorClass, consecutiveErrors, retryAfterMs, now } = input;
  const fraction = inboxPhaseFraction(tenantId);
  let delayMs: number;
  if (errorClass === 'credentials') {
    delayMs = backoffMs(INBOX_CREDENTIALS_BACKOFF_BASE_MS, consecutiveErrors, INBOX_MAX_INTERVAL_MS);
  } else if (errorClass === 'rate_limit') {
    const requested = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
      ? retryAfterMs
      : INBOX_RATE_LIMIT_DEFAULT_MS;
    delayMs = Math.min(INBOX_MAX_INTERVAL_MS, Math.max(INBOX_RATE_LIMIT_MIN_MS, requested));
  } else {
    const cap = Math.min(INBOX_TRANSIENT_BACKOFF_MAX_MS, Math.max(INBOX_TIER_INTERVAL_MS.hot, INBOX_TIER_INTERVAL_MS[tier]));
    delayMs = backoffMs(INBOX_TRANSIENT_BACKOFF_BASE_MS, consecutiveErrors, cap);
  }
  // Rozrzut tylko w górę: `Retry-After` to dolna granica.
  const jittered = delayMs + Math.floor(fraction * delayMs * INBOX_ERROR_JITTER_SHARE);
  return new Date(now.getTime() + Math.min(jittered, Math.max(delayMs, INBOX_MAX_INTERVAL_MS)));
}

// ═══════════════════════════════════════════════════════════════
// Rozsyłka
// ═══════════════════════════════════════════════════════════════

/** Co ile działa cron rozsyłki (`cron.inbox-polling`). Musi się zgadzać z `lib/jobs/queues.ts` (test). */
export const INBOX_DISPATCH_TICK_SECONDS = 60;

/**
 * Domyślna liczba slotów kolejki `inbox.poll.tenant`. Przebieg to głównie
 * czekanie na sieć. Zmiana bez wdrożenia kodu: `KSEF_INBOX_POLL_SLOTS`.
 */
export const INBOX_POLL_SLOTS_DEFAULT = 8;
const INBOX_POLL_SLOTS_MAX = 64;

/**
 * Pętla slotu w pg-boss bierze następne zadanie najwcześniej po tylu sekundach
 * od poprzedniego (`pollingIntervalSeconds`, domyślnie 2), nawet gdy zadanie
 * trwało krócej. To sufit przepustowości slotu: 30 zadań na minutę.
 */
export const INBOX_SLOT_SECONDS_PER_JOB = 2;

/** Paczka jednej transakcji: wybór firm + zapis zleceń. */
export const INBOX_DISPATCH_CHUNK = 200;

/**
 * Dzierżawa „zadanie czeka albo trwa”. Po wygaśnięciu firma znów może dostać
 * zadanie (worker padł). Ponowne zadanie przy żywym pierwszym niczego nie psuje:
 * grupa = NIP puszcza je po kolei, a drugie kończy się jednym odczytem.
 */
export const INBOX_LEASE_SECONDS = 30 * 60;

/** Sloty z konfiguracji; zła wartość = domyślna, bo nie może zatrzymać workera. */
export function inboxPollSlots(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.KSEF_INBOX_POLL_SLOTS?.trim());
  if (!Number.isInteger(raw) || raw < 1) return INBOX_POLL_SLOTS_DEFAULT;
  return Math.min(raw, INBOX_POLL_SLOTS_MAX);
}

/** Ile zadań slotów przerobi jeden takt, gdy zadania są krótkie. */
export function inboxDispatchCapacity(slots: number): number {
  return Math.floor((slots * INBOX_DISPATCH_TICK_SECONDS) / INBOX_SLOT_SECONDS_PER_JOB);
}

/** Okno liczenia hamulca 429. */
export const INBOX_BRAKE_WINDOW_SECONDS = 10 * 60;
const INBOX_BRAKE_MIN_FIRMS = 5;
const INBOX_BRAKE_SHARE = 0.2;
const INBOX_BRAKE_CAPACITY_DIVISOR = 4;

/**
 * Hamulec: dużo firm z 429 naraz to już nie limit jednej firmy, tylko sygnał,
 * że KSeF ogranicza nasz adres. Dokumentacja MF: powtarzane przekroczenia
 * wydłużają blokadę. Pojedyncze 429 hamulca nie włączają.
 */
export function inboxRateLimitBrake(input: { polledRecent: number; rateLimitedRecent: number }): boolean {
  if (input.rateLimitedRecent < INBOX_BRAKE_MIN_FIRMS) return false;
  return input.rateLimitedRecent >= input.polledRecent * INBOX_BRAKE_SHARE;
}

/**
 * Ile firm wolno wysłać w tym takcie: pojemność slotów minus zlecenia, które
 * jeszcze czekają albo trwają. Gdy zadania trwają dłużej (pełne logowania po
 * restarcie), kolejka się nie rozrasta, a reszta przechodzi na następny takt.
 */
export function inboxDispatchLimit(input: { slots: number; inFlight: number; braking: boolean }): number {
  const capacity = inboxDispatchCapacity(input.slots);
  const allowed = input.braking ? Math.floor(capacity / INBOX_BRAKE_CAPACITY_DIVISOR) : capacity;
  return Math.max(0, allowed - Math.max(0, input.inFlight));
}

/** Opóźnienie najstarszej należnej firmy w sekundach (0, gdy nic nie czeka). */
export function inboxOldestLagSeconds(oldestDueAt: string | null | undefined, now: Date): number {
  if (!oldestDueAt) return 0;
  const at = Date.parse(oldestDueAt);
  return Number.isFinite(at) ? Math.max(0, Math.round((now.getTime() - at) / 1000)) : 0;
}

/**
 * Zadanie zbędne: firma nie ma dzierżawy, a termin jest w przyszłości, czyli
 * ktoś już ją obsłużył. Kończymy jednym odczytem, bez KSeF. Bez wiersza
 * (zlecenie sprzed wdrożenia) przebieg idzie jak dawniej.
 */
export function isInboxPollJobRedundant(
  state: { next_poll_at: string; poll_lease_until: string | null } | null,
  now: Date,
): boolean {
  if (!state || state.poll_lease_until) return false;
  return Date.parse(state.next_poll_at) > now.getTime();
}

// ═══════════════════════════════════════════════════════════════
// Odświeżenie przez aktywność
// ═══════════════════════════════════════════════════════════════

/** Wejście do Skrzynki albo „Sprawdź teraz”: najwyżej raz na 5 min na firmę (12/h przy limicie KSeF 20/h). */
export const INBOX_NUDGE_MIN_SECONDS = 5 * 60;
/** Znacznik aktywności: najwyżej raz na tyle sekund na firmę i proces web (godzina jest dokładna dla okna 24 h). */
export const INBOX_ACTIVITY_NOTE_SECONDS = 60 * 60;
/** Firma, która właśnie się ożywiła, wchodzi w rytm gorącej najpóźniej po tym czasie. */
export const INBOX_ACTIVITY_PULL_SECONDS = 15 * 60;

// ═══════════════════════════════════════════════════════════════
// Alarmy
// ═══════════════════════════════════════════════════════════════

/** Termin minął dawniej niż tyle = rozsyłka albo worker nie nadąża. */
export const INBOX_ALARM_OVERDUE_MS = 60 * MINUTE_MS;
/** Firma z błędami bez sukcesu dłużej niż normalny odstęp poziomu + tyle. */
export const INBOX_ALARM_FAILING_MARGIN_MS = 90 * MINUTE_MS;
/** HWM starszy niż normalny odstęp poziomu + tyle = KSeF albo my nie dajemy kompletu. */
export const INBOX_ALARM_HWM_MARGIN_MS = 6 * HOUR_MS;

/** Normalny odstęp poziomów w sekundach, parametr RPC alarmu. */
export function inboxExpectedGapSeconds(): Record<InboxActivityTier, number> {
  return Object.fromEntries(
    INBOX_ACTIVITY_TIERS.map((tier) => [tier, Math.ceil(inboxExpectedMaxGapMs(tier) / 1000)]),
  ) as Record<InboxActivityTier, number>;
}

/**
 * HWM skrzynki starszy niż tyle oznacza, że skrzynka nadrabia i historia ma
 * ustąpić (`history-sync/budget.ts`). Przy firmie zimnej HWM sprzed kilku
 * godzin to norma, nie zaległość, więc próg zależy od poziomu.
 */
export function inboxLagYieldThresholdMs(
  tier: InboxActivityTier | null | undefined,
  minimumMs: number,
): number {
  if (!tier) return minimumMs;
  return Math.max(minimumMs, inboxExpectedMaxGapMs(tier) + 30 * MINUTE_MS);
}
