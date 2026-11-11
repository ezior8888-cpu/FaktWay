/**
 * Identyfikator zbiorczy z KSeF 2.0: `POST /collective-identifiers` (plan
 * kompletnej aplikacji, krok 1.4, część 2; RP-PLAT-02).
 *
 * Źródło: specyfikacja OpenAPI KSeF 2.0 (https://api-test.ksef.mf.gov.pl/docs/v2/openapi.json,
 * „Generowanie identyfikatora zbiorczego”): zwykły `accessToken` sesji
 * uwierzytelnionej, jedno z uprawnień InvoiceRead, InvoiceWrite albo
 * CollectiveIdentifierManage; wejście `{"invoices":[{"ksefNumber":"…"}, …]}`
 * (od 2 do 500 faktur jednego sprzedawcy), wyjście 201
 * `{"collectiveIdentifierNumber":"…"}`; błędy 400 z kodami 21001, 21405,
 * 71001, 71002, 71004, 71005 oraz 401, 403 i 429; limit 20/s, 120/min, 240/h.
 *
 * Wzorzec: `queryMetadataPage` (`lib/ksef/history-sync/query.ts`): kolejka
 * per NIP, sesja z `ksefSessionCache`, jedno wywołanie `ksefFetch` z audytem
 * (`ksef.collective_identifier.generate`), błąd nie jest połykany. Środowisko
 * TEST albo produkcja wynika z `KSEF_ENV` (`requireMatchingKsefEnvironment`,
 * adres z `getKsefBaseUrl`).
 *
 * Kwot (`payment`) i opisu nie wysyłamy: pola są opcjonalne, a identyfikator
 * ma wskazywać faktury; kwota przelewu może się jeszcze zmienić.
 *
 * Wywołanie NIE jest idempotentne (specyfikacja nie mówi, że ten sam zestaw
 * da ten sam numer, a faktura mieści najwyżej 132 identyfikatory), dlatego
 * akcja (`app/actions/identyfikator-zbiorczy.ts`) zapisuje wynik w bazie
 * (00191) i nie woła KSeF drugi raz dla tego samego zestawu.
 *
 * Odpowiedź przechodzi ten sam walidator co ekran (`poprawnyIdentyfikatorZbiorczy`:
 * format i CRC-8), a NIP w identyfikatorze musi być NIP-em sprzedawcy faktur.
 * Identyfikator, który tego nie spełnia, nie trafia do klienta (fail-closed).
 */

import {
  MAKS_FAKTUR_W_IDENTYFIKATORZE,
  MAKS_IDENTYFIKATOROW_FAKTURY,
  MIN_FAKTUR_W_IDENTYFIKATORZE,
  nipZIdentyfikatora,
  poprawnyIdentyfikatorZbiorczy,
} from '@/lib/invoices/identyfikator-zbiorczy';
import { poprawnyNumerKsef } from '@/lib/invoices/tytul-przelewu';
import type { KsefAuth } from '@/lib/ksef/auth';
import { requireMatchingKsefEnvironment } from '@/lib/ksef/claim-environment';
import { KsefApiError, ksefErrorCodes, ksefFetch } from '@/lib/ksef/client';
import { isNetworkError } from '@/lib/ksef/history-sync/errors';
import { ksefRateLimiter } from '@/lib/ksef/rate-limiter';
import { ksefSessionCache } from '@/lib/ksef/session-cache';
import { KsefCredentialsError } from '@/lib/supabase/admin-queries';
import type { KsefEnvironment } from '@/types/ksef';

export const SCIEZKA_IDENTYFIKATORA_ZBIORCZEGO = '/collective-identifiers';

export interface ZadanieIdentyfikatora {
  tenantId: string;
  /** Musi być środowiskiem z `KSEF_ENV` aplikacji. */
  env: KsefEnvironment;
  /** NIP sprzedawcy faktur, 10 cyfr: pierwsza część identyfikatora. */
  nipSprzedawcy: string;
  numeryKsef: readonly string[];
}

/** Logowanie do KSeF nie powiodło się, więc żądanie identyfikatora nie poszło. */
export class BladLogowaniaKsef extends Error {
  constructor(public readonly przyczyna: unknown) {
    super('Logowanie do KSeF przed identyfikatorem zbiorczym nie powiodło się');
    this.name = 'BladLogowaniaKsef';
  }
}

/** KSeF odpowiedział sukcesem, ale numer nie przeszedł walidatora albo ma NIP innego sprzedawcy. */
export class NiepoprawnyIdentyfikatorZKsef extends Error {
  constructor(
    /** Początek odpowiedzi do audytu (najwyżej 64 znaki); `null`, gdy pola nie było. */
    public readonly otrzymano: string | null,
    public readonly powod: 'format' | 'nip',
  ) {
    super(`KSeF zwrócił identyfikator zbiorczy, który nie przeszedł sprawdzenia (${powod})`);
    this.name = 'NiepoprawnyIdentyfikatorZKsef';
  }
}

/** Numery do żądania: każdy zgodny z `TNumerKSeF`, bez powtórzeń, od 2 do 500, rosnąco. */
function numeryDoZadania(numery: readonly string[]): string[] {
  const poprawne = numery.map((n) => poprawnyNumerKsef(n));
  if (poprawne.some((n) => n === null)) {
    throw new Error('Identyfikator zbiorczy: numer spoza wzorca KSeF');
  }
  // Sortowanie po kodach znaków: ta sama kolejność co `COLLATE "C"` w 00191.
  const unikalne = [...new Set(poprawne as string[])].sort();
  if (unikalne.length !== numery.length) throw new Error('Identyfikator zbiorczy: powtórzony numer KSeF');
  if (unikalne.length < MIN_FAKTUR_W_IDENTYFIKATORZE || unikalne.length > MAKS_FAKTUR_W_IDENTYFIKATORZE) {
    throw new Error('Identyfikator zbiorczy: liczba faktur poza limitem KSeF');
  }
  return unikalne;
}

/**
 * Jedno wywołanie `POST /collective-identifiers`. Zwraca identyfikator po
 * walidacji albo rzuca: błąd sesji jako `BladLogowaniaKsef`, odpowiedź KSeF
 * spoza 2xx jako `KsefApiError` (401 czyści sesję z pamięci procesu), zły
 * numer jako `NiepoprawnyIdentyfikatorZKsef`. Komunikat dla klienta:
 * `opiszBladIdentyfikatora`.
 */
export async function wygenerujIdentyfikatorZbiorczy(auth: KsefAuth, zadanie: ZadanieIdentyfikatora): Promise<string> {
  const env = requireMatchingKsefEnvironment(zadanie.env);
  if (!/^[0-9]{10}$/.test(zadanie.nipSprzedawcy)) throw new Error('Identyfikator zbiorczy: NIP sprzedawcy spoza 10 cyfr');
  const numery = numeryDoZadania(zadanie.numeryKsef);

  return ksefRateLimiter.enqueue(auth.nip, async () => {
    let session;
    try {
      session = await ksefSessionCache.getSession(auth, env);
    } catch (error) {
      throw new BladLogowaniaKsef(error);
    }

    let odpowiedz: unknown;
    try {
      odpowiedz = await ksefFetch<unknown>(SCIEZKA_IDENTYFIKATORA_ZBIORCZEGO, {
        method: 'POST',
        accessToken: session.accessToken,
        body: { invoices: numery.map((ksefNumber) => ({ ksefNumber })) },
        env,
        audit: {
          tenantId: zadanie.tenantId,
          action: 'collective_identifier.generate',
          metadata: { sellerNip: zadanie.nipSprzedawcy, invoiceCount: numery.length, ksefNumbers: numery },
        },
      });
    } catch (error) {
      // Token z pamięci procesu przestał działać: następna próba zaloguje się od nowa.
      if (error instanceof KsefApiError && error.status === 401) ksefSessionCache.invalidate(auth.nip, env);
      throw error;
    }

    const surowy =
      odpowiedz && typeof odpowiedz === 'object'
        ? (odpowiedz as { collectiveIdentifierNumber?: unknown }).collectiveIdentifierNumber
        : undefined;
    const identyfikator = poprawnyIdentyfikatorZbiorczy(surowy);
    if (!identyfikator) {
      throw new NiepoprawnyIdentyfikatorZKsef(typeof surowy === 'string' ? surowy.slice(0, 64) : null, 'format');
    }
    if (nipZIdentyfikatora(identyfikator) !== zadanie.nipSprzedawcy) {
      throw new NiepoprawnyIdentyfikatorZKsef(identyfikator, 'nip');
    }
    return identyfikator;
  });
}

// ─── Komunikaty dla klienta ─────────────────────────────────────────────

export interface KontekstBledu {
  /** Nazwa sprzedawcy, jak na liście „Do zapłaty”. */
  sprzedawca: string;
  faktury: ReadonlyArray<{ numerFaktury: string; numerKsef: string }>;
}

export interface OpisBleduIdentyfikatora {
  /** Kod do bazy (`error_code` w 00191) i audytu: `[a-z0-9_]`. */
  kod: string;
  /** Pełne zdania: który dokument, co się stało i co zrobić (protokół napraw, pkt 4). */
  komunikat: string;
  /** Błąd po naszej stronie albo nieoczekiwany: do Sentry, operator patrzy. */
  techniczny: boolean;
}

const OSOBNO = 'Do tego czasu każdą z tych faktur można zapłacić osobnym przelewem z jej numerem KSeF w tytule.';

const dla = (k: KontekstBledu) => `dla ${k.faktury.length} faktur od ${k.sprzedawca}`;
const nazwa = (f: { numerFaktury: string; numerKsef: string }) =>
  `${f.numerFaktury || 'bez numeru'} (numer KSeF ${f.numerKsef})`;

/** Faktura, której numer KSeF podał KSeF w treści błędu (opis albo szczegóły). */
function fakturaZBledu(body: unknown, k: KontekstBledu): KontekstBledu['faktury'][number] | null {
  let tekst = '';
  try {
    tekst = typeof body === 'string' ? body : (JSON.stringify(body) ?? '');
  } catch {
    return null;
  }
  return k.faktury.find((f) => tekst.includes(f.numerKsef)) ?? null;
}

function zaIle(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return 'za chwilę';
  return `za ${Math.max(1, Math.ceil(ms / 60_000))} min`;
}

function limit(k: KontekstBledu, retryAfterMs: number | null): OpisBleduIdentyfikatora {
  return {
    kod: 'http_429',
    komunikat: `KSeF ogranicza teraz liczbę zapytań, więc identyfikator zbiorczy ${dla(k)} nie powstał. Spróbuj ponownie ${zaIle(retryAfterMs)}.`,
    techniczny: false,
  };
}

function niedostepny(k: KontekstBledu, kod: 'http_5xx' | 'network'): OpisBleduIdentyfikatora {
  return {
    kod,
    komunikat: `KSeF jest teraz niedostępny, więc identyfikator zbiorczy ${dla(k)} nie powstał. Spróbuj ponownie za kilka minut. ${OSOBNO}`,
    techniczny: false,
  };
}

function bladKsef(error: KsefApiError, k: KontekstBledu): OpisBleduIdentyfikatora {
  const grupa = dla(k);
  if (error.status === 429) return limit(k, error.retryAfterMs);
  if (error.status === 408) {
    return {
      kod: 'timeout',
      komunikat: `KSeF nie odpowiedział na czas na prośbę o identyfikator zbiorczy ${grupa}. Spróbuj ponownie za kilka minut. ${OSOBNO}`,
      techniczny: false,
    };
  }
  if (error.status >= 500 && error.status < 600) return niedostepny(k, 'http_5xx');
  if (error.status === 401) {
    return {
      kod: 'http_401',
      komunikat:
        `KSeF nie przyjął logowania FaktWay, więc identyfikator zbiorczy ${grupa} nie powstał. Spróbuj ponownie: ` +
        'FaktWay zaloguje się do KSeF od nowa. Jeśli to się powtórzy, sprawdź połączenie z KSeF w Ustawieniach (zakładka KSeF).',
      techniczny: false,
    };
  }
  if (error.status === 403) {
    return {
      kod: 'http_403',
      komunikat:
        `Uprawnienia FaktWay w KSeF nie pozwalają utworzyć identyfikatora zbiorczego ${grupa}. Potrzebne jest jedno ` +
        'z uprawnień: przeglądanie faktur (InvoiceRead), wystawianie faktur (InvoiceWrite) albo identyfikatory zbiorcze ' +
        '(CollectiveIdentifierManage). Uprawnienia nadaje się w Aplikacji Podatnika KSeF; tam można też utworzyć ' +
        `identyfikator. ${OSOBNO}`,
      techniczny: false,
    };
  }

  const kody = ksefErrorCodes(error.body);
  const faktura = fakturaZBledu(error.body, k);
  if (kody.includes(71001)) {
    return {
      kod: 'ksef_71001',
      komunikat:
        `Identyfikator zbiorczy ${grupa} nie powstał: KSeF nie znalazł ` +
        `${faktura ? `faktury ${nazwa(faktura)}` : 'jednej z faktur'} wśród faktur dostępnych dla tej firmy. ` +
        `Sprawdź tę fakturę w Aplikacji Podatnika KSeF. ${OSOBNO}`,
      techniczny: false,
    };
  }
  if (kody.includes(71002)) {
    return {
      kod: 'ksef_71002',
      komunikat:
        `Identyfikator zbiorczy ${grupa} nie powstał: ${faktura ? `faktura ${nazwa(faktura)}` : 'jedna z faktur'} ma już ` +
        `najwięcej identyfikatorów zbiorczych, ile pozwala KSeF (${MAKS_IDENTYFIKATOROW_FAKTURY}). Każdą z tych faktur ` +
        'można zapłacić osobnym przelewem z jej numerem KSeF w tytule.',
      techniczny: false,
    };
  }
  if (kody.includes(71004)) {
    return {
      kod: 'ksef_71004',
      komunikat:
        `Identyfikator zbiorczy ${grupa} nie powstał: według KSeF te faktury mają różnych sprzedawców, a identyfikator ` +
        'obejmuje faktury jednego sprzedawcy. Każdą z tych faktur można zapłacić osobnym przelewem z jej numerem KSeF ' +
        'w tytule. Sprawdź dane sprzedawcy w fakturach.',
      techniczny: false,
    };
  }
  if (kody.includes(71005)) {
    return {
      kod: 'ksef_71005',
      komunikat:
        `Identyfikator zbiorczy ${grupa} nie powstał: lista faktur wysłana do KSeF powtarzała numer KSeF. ` +
        'Odśwież stronę i spróbuj ponownie, a jeśli to się powtórzy, napisz do pomocy FaktWay.',
      techniczny: true,
    };
  }
  const kod = kody[0] ?? null;
  return {
    kod: kod !== null ? `ksef_${kod}` : `ksef_http_${error.status}`,
    komunikat:
      `Identyfikator zbiorczy ${grupa} nie powstał: KSeF odrzucił prośbę (${kod !== null ? `kod ${kod}` : `HTTP ${error.status}`}). ` +
      `Spróbuj ponownie później, a jeśli to się powtórzy, napisz do pomocy FaktWay. ${OSOBNO}`,
    techniczny: true,
  };
}

/**
 * Błąd z akcji identyfikatora zbiorczego (poświadczenia, logowanie, KSeF,
 * odpowiedź) jako kod do bazy i komunikat dla klienta. Każdy komunikat nazywa
 * faktury (liczba i sprzedawca, przy 71001 i 71002 konkretna faktura) i mówi,
 * co zrobić; wyjściem zawsze jest osobny przelew z numerem KSeF faktury.
 */
export function opiszBladIdentyfikatora(error: unknown, k: KontekstBledu): OpisBleduIdentyfikatora {
  const grupa = dla(k);

  if (error instanceof KsefCredentialsError || (error instanceof Error && error.name === 'KsefCredentialsError')) {
    const powod = (error as KsefCredentialsError).reason;
    if (powod === 'missing' || powod === 'not-verified') {
      return {
        kod: 'credentials_missing',
        komunikat: `Identyfikator zbiorczy nadaje KSeF, a ta firma nie ma połączenia z KSeF w FaktWay. Podłącz KSeF w Ustawieniach (zakładka KSeF). ${OSOBNO}`,
        techniczny: false,
      };
    }
    if (powod === 'tenant-read') {
      return {
        kod: 'credentials_read',
        komunikat: `Nie udało się odczytać połączenia z KSeF, więc identyfikator zbiorczy ${grupa} nie powstał. Spróbuj ponownie za chwilę.`,
        techniczny: true,
      };
    }
    return {
      kod: 'credentials_internal',
      komunikat: `Nie udało się użyć połączenia z KSeF tej firmy, więc identyfikator zbiorczy ${grupa} nie powstał. Napisz do pomocy FaktWay. ${OSOBNO}`,
      techniczny: true,
    };
  }

  if (error instanceof BladLogowaniaKsef) {
    const przyczyna = error.przyczyna;
    if (przyczyna instanceof KsefApiError && przyczyna.status === 429) return limit(k, przyczyna.retryAfterMs);
    if (przyczyna instanceof KsefApiError && (przyczyna.status === 408 || przyczyna.status >= 500)) {
      return niedostepny(k, 'http_5xx');
    }
    if (isNetworkError(przyczyna)) return niedostepny(k, 'network');
    return {
      kod: 'session',
      komunikat: `Nie udało się zalogować do KSeF, więc identyfikator zbiorczy ${grupa} nie powstał. Sprawdź połączenie z KSeF w Ustawieniach (zakładka KSeF) i spróbuj ponownie. ${OSOBNO}`,
      techniczny: false,
    };
  }

  if (error instanceof NiepoprawnyIdentyfikatorZKsef) {
    return {
      kod: 'invalid_response',
      komunikat:
        `KSeF zwrócił identyfikator zbiorczy ${grupa}, którego FaktWay nie potwierdził (format, suma kontrolna albo NIP ` +
        `sprzedawcy), więc go nie pokazujemy. Napisz do pomocy FaktWay. ${OSOBNO}`,
      techniczny: true,
    };
  }

  if (error instanceof KsefApiError) return bladKsef(error, k);
  if (isNetworkError(error)) return niedostepny(k, 'network');

  return {
    kod: 'unknown',
    komunikat: `Nie udało się utworzyć identyfikatora zbiorczego ${grupa}. Spróbuj ponownie za chwilę, a jeśli to się powtórzy, napisz do pomocy FaktWay. ${OSOBNO}`,
    techniczny: true,
  };
}
