/**
 * Stałe synchronizacji historii KSeF (decyzja Bartosza 22.10.2026).
 *
 * CZYSTY moduł: same literały, bez importów (strażnik
 * tests/unit/ksef-historia-stale-czyste.test.ts). Importuje go ekran
 * (`status.ts`) i worker.
 *
 * ── Budżet KSeF ────────────────────────────────────────────────────
 * KSeF pozwala na (kontekst NIP, adres IP): 20 zapytań o metadane na godzinę
 * i 64 pobrania faktur na godzinę, 16 na minutę. Ten sam budżet zużywa
 * Skrzynka KSeF (firma gorąca co 15 min, `inbox-schedule.ts`) i wysyłka faktur. Historia jest konsumentem
 * o NAJNIŻSZYM priorytecie: przebieg co 15 minut bierze najwyżej
 * 1 zapytanie o metadane i 5 pobrań w dzień (4/h i 20/h), 2 i 10 w nocy
 * (8/h i 40/h), pobrania co najmniej 6 s od siebie (≤ 10/min), a przy 429
 * czeka pełny `Retry-After`. Ustępuje skrzynce i wysyłce (`budget.ts`).
 */

/** Najstarsza chwila, o którą pytamy KSeF („najlepiej wszystko”); data rozpoczęcia działalności może ją podnieść. */
export const KSEF_HISTORY_FLOOR = '2022-01-01T00:00:00.000Z';

/** Okno jednego zapytania: 90 dni (API przyjmuje do 100). */
export const KSEF_HISTORY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Maksymalna strona `/invoices/query/metadata` (OpenAPI KSeF 2.0: 10–250). */
export const PAGE_SIZE = 250;

export interface HistoryBudget {
  metadata: number;
  downloads: number;
}

/** Dzień (06:00–20:00 Europe/Warsaw): zapytania o metadane i pobrania na jeden przebieg. */
export const BUDGET_DAY: HistoryBudget = { metadata: 1, downloads: 5 };
/** Noc (20:00–06:00 Europe/Warsaw): mniejszy ruch wysyłek — więcej dla historii. */
export const BUDGET_NIGHT: HistoryBudget = { metadata: 2, downloads: 10 };
export const NIGHT_START_HOUR = 20;
export const NIGHT_END_HOUR = 6;

/** Odstęp między pobraniami faktur (≤ 10 na minutę). */
export const DOWNLOAD_SPACING_MS = 6_000;
/** Po tylu ms od startu przebiegu nie zaczynamy nowego wywołania KSeF. */
export const RUN_DEADLINE_MS = 90_000;

/** Dzierżawa przebiegu firmy (wiersz sprzedaży) — po awarii workera wygasa sama. */
export const LEASE_MS = 600_000;
/** Granica zaległość / bieżące: chwila założenia strumienia − 1 h. */
export const BOUNDARY_LAG_MS = 3_600_000;

/** Co ile pytamy o nową sprzedaż spoza FaktWay: dzień 29 min, noc 14 min. */
export const LIVE_INTERVAL_DAY_MS = 29 * 60_000;
export const LIVE_INTERVAL_NIGHT_MS = 14 * 60_000;

/** Ponowne sprawdzenie odłożonych i zablokowanych (stan lokalny): co godzinę; wycofane szkice — co dobę. */
export const DEFERRED_RECHECK_MS = 3_600_000;
export const BLOCKED_RECHECK_MS = 3_600_000;
export const RETIRED_RECHECK_MS = 86_400_000;
export const RECHECK_LIMIT = 50;

/** Wysyłka FaktWay, której wyniku nie uzgodniliśmy po 48 h — jak strażnik I5. */
export const OWN_SEND_GRACE_MS = 48 * 3_600_000;
/** Próby zapisu jednej faktury, zanim trafi do operatora. */
export const ITEM_MAX_ATTEMPTS = 3;
/** KSeF 21165 (faktura jeszcze niedostępna do pobrania) — ponów za 15 min, bez liczenia próby. */
export const KSEF_NOT_READY_RETRY_MS = 15 * 60_000;

/** 429: pauza wg `Retry-After`, domyślnie 15 min, od 60 s do 24 h. */
export const RATE_LIMIT_DEFAULT_MS = 15 * 60_000;
export const RATE_LIMIT_MIN_MS = 60_000;
export const RATE_LIMIT_MAX_MS = 24 * 3_600_000;
/** Tyle firm z 429 w ostatniej godzinie = globalny bezpiecznik (bez fan-outu, alarm). */
export const GLOBAL_429_TENANTS = 3;

/** HWM skrzynki starszy niż tyle (firma gorąca; rzadziej odpytywane mają wyższy próg, `inboxLagYieldThresholdMs`) = skrzynka ma zaległość, historia ustępuje. */
export const INBOX_LAG_YIELD_MS = 60 * 60_000;
/** Faktura ze skrzynki czeka na archiwum XML (świeższa niż tyle) = historia nie pobiera. */
export const INBOX_XML_PENDING_WINDOW_MS = 2 * 3_600_000;

/** Twardy limit dziennika na strumień (≈ 0,5 GB) — dalej komunikat i alarm operatora. */
export const MAX_ITEMS_PER_STREAM = 25_000;

/** Ile przebiegów firm naraz w workerze. */
export const LOCAL_CONCURRENCY = 3;
/**
 * Czas slotów na jeden cykl crona: 3 sloty × 13 min. Fan-out mieści się w nim
 * (pomniejszonym o zlecenia poprzednich cykli wciąż czekające w kolejce), więc
 * żaden przebieg historii nie czeka w kolejce dłużej niż próg „zaległe”
 * heartbeatu (15 min, `lib/jobs/jobs-health.ts`). Firma z otwartą zaległością
 * liczy się z pełnym budżetem pobrań (dzień 55 s → 42 na cykl, noc 95 s → 24);
 * 117 na cykl tylko dla firm z samą bieżącą sprzedażą i pustą kolejką (20 s).
 */
export const FANOUT_SLOT_SECONDS = 3 * 13 * 60;

/** Okno pomiaru tempa pobierania na ekranie (godziny). */
export const KSEF_HISTORY_RATE_WINDOW_H = 6;
