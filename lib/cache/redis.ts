/**
 * Klient Redisa po HTTP (biblioteka `@upstash/redis`).
 *
 * Gdzie stoi Redis (stan 23.10.2026): własny redis:7.2 na serwerze app-1
 * (Hetzner) z nakładką `hiett/serverless-redis-http`, która wystawia REST API
 * zgodne z Upstash. Korzystają z niego aplikacja i worker jobów. Nazwy
 * UPSTASH_REDIS_REST_URL / _TOKEN i biblioteka zostały z czasów Vercela —
 * to zgodność API, nie dostawca: produkcja nie wysyła danych do Upstash
 * (stan 23.10.2026; dlatego nie ma go w `lib/legal/subprocessors.ts`).
 *
 * Lazy init: bez tego `next build` padałby przy importowaniu łańcucha
 * (np. server action → categorization → ai-classifier → ...), nawet gdy
 * build nie woła Redisa.
 *
 * Awaria Redisa kosztuje najwyżej pół sekundy (plan skalowania, sesja 6):
 *   - całe polecenie, z jednym ponowieniem i odczytem odpowiedzi, ma
 *     `REDIS_COMMAND_TIMEOUT_MS` (500 ms). Biblioteka sama robiła 6 prób
 *     z przerwami ok. 4,3 s i bez limitu czasu: zawieszona nakładka trzymała
 *     każde polecenie do kilku minut. Wyjątek: limitery fail-closed (2FA,
 *     hasło) wołają `getRedis('failClosedLimiter')` z limitem 2 s, bo
 *     przerwanie nie cofa skryptu, który Redis już wykonał. Przy 500 ms wolna
 *     odpowiedź (albo chwilowo zatrzymana pętla zdarzeń) spaliłaby próbę 2FA
 *     albo jednorazowe potwierdzenie resetu hasła, a klient dostałby odmowę;
 *   - po `CIRCUIT_FAILURE_THRESHOLD` (3) awariach połączenia z rzędu obwód
 *     „Redis niedostępny” na `CIRCUIT_OPEN_MS` (10 s) odmawia od razu, bez
 *     sieci (`RedisUnavailableError`). Potem jedna próba: odpowiedź zamyka
 *     obwód, awaria otwiera go na kolejne 10 s. „Z rzędu” znaczy: każda
 *     następna awaria dotyczy polecenia wysłanego PO poprzedniej. Polecenia,
 *     które były w locie razem (np. przerwane naraz po zatrzymaniu pętli
 *     zdarzeń), liczą się jak jedna. Obwód jest w pamięci procesu, osobno
 *     w aplikacji i w workerze, wspólny dla obu profili klienta. Błąd
 *     polecenia z odpowiedzią Redisa (zły typ, błąd skryptu) dowodzi, że
 *     Redis działa, więc obwodu nie otwiera: inaczej dałoby się nim wyłączyć
 *     Redisa wszystkim. Wyjątkiem są błędy samej nakładki o braku Redisa
 *     (`SRH_UNAVAILABLE_PREFIXES`, HTTP 500): biblioteka gubi kod statusu,
 *     więc rozpoznajemy je po treści;
 *   - `/api/health` pinguje osobnym klientem (`getRedisHealthProbe`, 300 ms,
 *     bez obwodu), żeby pokazywać prawdziwy stan i zmieścić się w 5 s
 *     healthchecku kontenera.
 * Wszyscy wołający już łapią błędy Redisa i przy błędzie robią to samo co
 * dawniej przy awarii (lista niżej). Zmienia się czas, po którym to zapada,
 * a przy Redisie wolniejszym niż limit także wynik: zamiast czekać, wołający
 * przechodzi w tryb awarii.
 *
 * Brak konfiguracji (np. lokalny dev bez Redisa): `lib/cache/index.ts` nie woła
 * wtedy `getRedis()` i przechodzi w passthrough (bez cache); przy awarii łapie
 * błąd i robi to samo.
 * To NIE znaczy, że cała aplikacja działa bez Redisa. Bez niego (i przy jego
 * awarii) odmawiają — to jedyna pełna lista, inne pliki odsyłają tutaj:
 *   - limitery MFA i hasła (`lib/rate-limit/mfa.ts`, `password.ts`,
 *     fail-closed): kod TOTP (przy logowaniu i przy potwierdzeniu po biometrii),
 *     włączanie 2FA, zmiana i reset hasła, ponowne uwierzytelnienie
 *     (`lib/auth/reauth.ts`: wyłączenie 2FA, usunięcie konta RODO i jego
 *     anulowanie hasłem; anulowanie linkiem z maila działa);
 *   - podgląd przypomnienia o płatności (`app/actions/reminders.ts`): jedyna
 *     akcja, która `fallback: true` z ogólnego limitera
 *     (`lib/rate-limit/index.ts` liczy wtedy w pamięci) traktuje jak odmowę.
 * Skutek pośredni: kodu nie da się podać ani włączyć 2FA, więc to, co wymaga
 * potwierdzonego 2FA (`getVerifiedMfaState`), działa tylko w sesji już
 * potwierdzonej kodem: wgranie certyfikatu KSeF, wstrzymanie historii KSeF
 * i `/admin` (także dla konta bez 2FA), a na koncie z 2FA również płatności,
 * nadawanie dostępu (także ustawienia wysyłki dla księgowej), eksport danych
 * konta i urządzenia biometrii. Przy fladze `requireMfaForSensitive` także
 * wysyłka do KSeF i płatności właściciela albo admina.
 * Przechodzą (limit w pamięci procesu): logowanie hasłem konta bez 2FA,
 * rejestracja, logowanie biometrią (daje AAL1, nie AAL2) i pozostałe ogólne limity.
 * Nie odmawia, ale gaśnie: monitor KSeF (`lib/ksef/health-status.ts`): baner,
 * `isKsefHealthy` (zwraca `true`, więc wysyłka nie odkłada ponowień przy
 * awarii KSeF), status publiczny (`operational`), `ksef_health_log` i alarm
 * `ksef_down`; przy awarii `recordKsefPing` rzuca.
 * Przy otwartym obwodzie to samo dzieje się od razu, a nie po pół sekundy.
 */

import {
  errors,
  Redis,
  type RedisConfigNodejs,
  type Requester,
  type UpstashRequest,
  type UpstashResponse,
} from '@upstash/redis';

/** Całe polecenie: obie próby, przerwa między nimi i odczyt odpowiedzi. */
export const REDIS_COMMAND_TIMEOUT_MS = 500;
/** Skrypty limiterów fail-closed (2FA, hasło): przerwanie nie cofa wykonanego skryptu. */
export const REDIS_LIMITER_TIMEOUT_MS = 2000;
/** Ping w `/api/health`. Healthcheck kontenera ma 5 s na całość, z bazą. */
export const REDIS_HEALTH_PING_TIMEOUT_MS = 300;
/** Tyle awarii połączenia z rzędu otwiera obwód. */
export const CIRCUIT_FAILURE_THRESHOLD = 3;
/** Tyle obwód odmawia bez próby, zanim przepuści jedno polecenie na próbę. */
export const CIRCUIT_OPEN_MS = 10_000;

/**
 * Błędy samej nakładki SRH, gdy nie ma połączenia z Redisem (HTTP 500,
 * `lib/srh/http/base_router.ex` i `command_handler.ex` w hiett/serverless-redis-http).
 * Treść błędów Redisa (np. `ERR`, `WRONGTYPE`, błąd skryptu) tak się nie zaczyna.
 */
const SRH_UNAVAILABLE_PREFIXES = [
  'SRH: Unable to connect to the Redis server',
  'SRH: An error occurred internally',
];

/**
 * Jedno ponowienie, tylko gdy `fetch` rzuci bez przerwania (np. zerwane stare
 * połączenie z puli). W tej bibliotece `retry: false` daje nadal 2 próby,
 * a `retries: 1` daje dokładnie 2.
 */
const RETRY = { retries: 1, backoff: () => 50 };

/**
 * Sygnał MUSI być funkcją (biblioteka woła ją raz na polecenie, więc limit
 * obejmuje obie próby). Przy statycznym, przerwanym `AbortSignal` biblioteka
 * nie rzuca, tylko udaje odpowiedź 200 `{ result: "Aborted" }`: limiter
 * dostałby „wynik” zamiast błędu i przepuścił próbę logowania.
 */
function timeoutSignal(ms: number): () => AbortSignal {
  return () => AbortSignal.timeout(ms);
}

/** Polecenie odrzucone bez sieci, bo obwód „Redis niedostępny” jest otwarty. */
export class RedisUnavailableError extends Error {
  constructor() {
    super('Redis niedostępny (obwód otwarty)');
    this.name = 'RedisUnavailableError';
  }
}

interface Ticket {
  kind: 'pass' | 'probe';
  /** Kolejny numer wydanego polecenia: rozróżnia „wysłane po awarii” od „w locie razem z nią”. */
  seq: number;
}

/**
 * Czy od `since` minęło mniej niż okno obwodu. Zegar cofnięty (np. korekta
 * czasu systemu) kończy okno od razu: inaczej obwód stałby otwarty o tyle
 * dłużej, o ile cofnięto zegar, a z nim logowanie z 2FA.
 */
function withinWindow(now: number, since: number): boolean {
  const elapsed = now - since;
  return elapsed >= 0 && elapsed < CIRCUIT_OPEN_MS;
}

/** Obwód „Redis niedostępny” w pamięci procesu (zamknięty → otwarty → próba). */
class RedisCircuit {
  private seq = 0;
  private failures = 0;
  /** Awarie poleceń o numerze ≤ tym należą do już policzonej fali. */
  private countedUpTo = 0;
  private openedAt: number | null = null;
  private probe: { seq: number; startedAt: number } | null = null;

  /** `null` = odmowa bez sieci. */
  acquire(): Ticket | null {
    if (this.openedAt === null) return { kind: 'pass', seq: ++this.seq };
    const now = Date.now();
    if (withinWindow(now, this.openedAt)) return null;
    // Jedna próba naraz. Próba zawsze kończy się w limicie czasu polecenia;
    // gdyby jednak utknęła, po kolejnym oknie wolno spróbować znowu.
    if (this.probe !== null && withinWindow(now, this.probe.startedAt)) return null;
    this.probe = { seq: ++this.seq, startedAt: now };
    return { kind: 'probe', seq: this.probe.seq };
  }

  /** Redis odpowiedział (także błędem polecenia): obwód zamknięty. */
  reached(): void {
    if (this.openedAt !== null) {
      console.info('[redis] obwód zamknięty: Redis znowu odpowiada');
    }
    this.failures = 0;
    this.openedAt = null;
    this.probe = null;
  }

  /** Brak odpowiedzi: zerwane połączenie, przekroczony limit czasu, brak Redisa za nakładką. */
  failed(ticket: Ticket, error: unknown): void {
    if (ticket.kind === 'probe') {
      // Tylko bieżąca próba. Spóźniona porażka starej próby nie otwiera obwodu,
      // który nowsza, udana próba już zamknęła.
      if (this.probe?.seq !== ticket.seq) return;
      this.openedAt = Date.now();
      this.probe = null;
      return;
    }
    // Spóźniona awaria polecenia sprzed otwarcia nie przedłuża przerwy.
    if (this.openedAt !== null) return;
    // Polecenie było w locie, gdy liczyliśmy poprzednią awarię: ta sama fala.
    if (ticket.seq <= this.countedUpTo) return;
    this.failures += 1;
    this.countedUpTo = this.seq;
    if (this.failures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.openedAt = Date.now();
      // Tylko nazwa błędu: treść błędów Redisa potrafi zawierać dane żądania.
      console.warn(
        `[redis] obwód otwarty po ${this.failures} awariach z rzędu (${errorName(error)}): ` +
          `przez ${CIRCUIT_OPEN_MS / 1000} s polecenia odmawiają bez połączenia`,
      );
    }
  }
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : typeof error;
}

/** Czy błąd oznacza brak odpowiedzi Redisa (a nie odpowiedź z błędem polecenia). */
function isTransportFailure(error: unknown): boolean {
  // Odpowiedź, która nie jest JSON-em, to nie nakładka SRH (np. strona błędu bramki).
  if (error instanceof errors.UpstashJSONParseError) return true;
  if (error instanceof errors.UpstashError) {
    return SRH_UNAVAILABLE_PREFIXES.some((prefix) => error.message.startsWith(prefix));
  }
  return true;
}

/** Owija klienta HTTP biblioteki. Każde polecenie (też paczki i skrypty) idzie przez `request`. */
function guardRequester(inner: Requester, circuit: RedisCircuit): Requester {
  return {
    get readYourWrites() {
      return inner.readYourWrites;
    },
    set readYourWrites(value) {
      inner.readYourWrites = value;
    },
    get upstashSyncToken() {
      return inner.upstashSyncToken;
    },
    set upstashSyncToken(value) {
      inner.upstashSyncToken = value;
    },
    async request<TResult = unknown>(req: UpstashRequest): Promise<UpstashResponse<TResult>> {
      const ticket = circuit.acquire();
      if (ticket === null) throw new RedisUnavailableError();
      try {
        const response = await inner.request<TResult>(req);
        circuit.reached();
        return response;
      } catch (error) {
        if (isTransportFailure(error)) circuit.failed(ticket, error);
        else circuit.reached();
        throw error;
      }
    },
  };
}

/**
 * `client` jest w bibliotece chroniony, więc podmiana idzie przez podklasę.
 * Automatyczne paczki są wyłączone: z nimi konstruktor biblioteki zwraca
 * Proxy, przez które część metod (np. `scan`) czytała starego klienta
 * i omijała obwód. Bez Proxy każde polecenie czyta `this.client` z tego
 * obiektu. Jawne `pipeline()` i `multi()` działają jak dotąd. Test
 * `redis-klient-odpornosc.test.ts` pilnuje, że wszystkie rodzaje poleceń idą
 * przez obwód, także po aktualizacji biblioteki.
 */
class GuardedRedis extends Redis {
  constructor(config: RedisConfigNodejs, circuit: RedisCircuit) {
    super({ ...config, enableAutoPipelining: false });
    this.client = guardRequester(this.client, circuit);
  }
}

/**
 * `default`: 500 ms, dla cache, ogólnego limitera i monitora KSeF.
 * `failClosedLimiter`: 2 s, dla skryptów limiterów 2FA i hasła.
 */
export type RedisProfile = 'default' | 'failClosedLimiter';

const PROFILE_TIMEOUT_MS: Record<RedisProfile, number> = {
  default: REDIS_COMMAND_TIMEOUT_MS,
  failClosedLimiter: REDIS_LIMITER_TIMEOUT_MS,
};

const clients = new Map<RedisProfile, Redis>();
let circuit: RedisCircuit | null = null;
let cachedHealthProbe: Redis | null = null;

export function isRedisConfigured(): boolean {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  // Zaślepki typu "https://xxx.upstash.io" / "xxx" traktujemy jak brak konfiguracji.
  if (!url || !token) return false;
  if (url.includes('xxx') || token.includes('xxx')) return false;
  return true;
}

function connection(): Pick<RedisConfigNodejs, 'url' | 'token'> {
  if (!isRedisConfigured()) {
    throw new Error('Redis not configured (missing UPSTASH_REDIS_REST_URL/TOKEN)');
  }
  return {
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  };
}

export function getRedis(profile: RedisProfile = 'default'): Redis {
  const cached = clients.get(profile);
  if (cached) return cached;
  const client = new GuardedRedis(
    { ...connection(), retry: RETRY, signal: timeoutSignal(PROFILE_TIMEOUT_MS[profile]) },
    (circuit ??= new RedisCircuit()),
  );
  clients.set(profile, client);
  return client;
}

/**
 * Klient tylko do pingu w `/api/health`: własny, krótszy limit i BEZ obwodu.
 * Ping ma pokazać prawdziwy stan Redisa także wtedy, gdy obwód aplikacji
 * jest otwarty, i nie zmienia stanu tego obwodu.
 */
export function getRedisHealthProbe(): Redis {
  if (cachedHealthProbe) return cachedHealthProbe;
  cachedHealthProbe = new Redis({
    ...connection(),
    retry: RETRY,
    signal: timeoutSignal(REDIS_HEALTH_PING_TIMEOUT_MS),
  });
  return cachedHealthProbe;
}
