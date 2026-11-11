/**
 * Uprawnienia w KSeF 2.0 dla biura rachunkowego (plan kompletnej aplikacji,
 * krok 6.2, część 4; ryzyko R1): nadanie, stan operacji, lista aktywnych
 * uprawnień biura w kontekście firmy i odebranie.
 *
 * Źródło: specyfikacja OpenAPI KSeF 2.0 TEST (https://api-test.ksef.mf.gov.pl/docs/v2/openapi.json,
 * odczyt 11.11.2026), wszystkie operacje z Bearer `accessToken` sesji firmy:
 *  - `POST /permissions/entities/grants` („Nadanie podmiotom uprawnień do obsługi
 *    faktur”, wymagane CredentialsManage): `EntityPermissionsGrantRequest`, 202
 *    `{"referenceNumber":"…"}`; błędy 400 (21001, 21405), 401, 403, 429;
 *  - `GET /permissions/operations/{referenceNumber}` („Pobranie statusu operacji”):
 *    200 `{"status":{"code","description","details"}}`, status dostępny 30 dni,
 *    potem 410 („Operacja wygasła i nie jest już dostępna.”);
 *  - `POST /permissions/query/persons/grants?pageOffset=&pageSize=` („Pobranie listy
 *    uprawnień do pracy w KSeF nadanych osobom fizycznym lub podmiotom”, wymagane
 *    CredentialsManage, CredentialsRead albo SubunitManage; `pageSize` 10-100):
 *    `queryType` PermissionsInCurrentContext, filtr `authorizedIdentifier`,
 *    `permissionTypes`, `permissionState`; 200 `{"permissions":[…],"hasMore":…}`;
 *  - `DELETE /permissions/common/grants/{permissionId}` („Odebranie uprawnień”,
 *    wymagane CredentialsManage): 202 `{"referenceNumber":"…"}`;
 *  - limity każdej z tych operacji: 10 na sekundę, 30 na minutę, 120 na godzinę
 *    (`x-rate-limits`), liczone dla pary kontekst i adres IP
 *    (https://github.com/CIRFMF/ksef-docs/blob/main/limity/limity-api.md).
 *
 * Ten sam przebieg co oficjalny test E2E klienta CIRFMF
 * (`KSeF.Client.Tests.Core/E2E/Permissions/EntityPermission/EntityPermissionE2ETests.cs`):
 * nadanie podmiotowi, wyszukanie uprawnień listą osób i podmiotów
 * (domyślny `queryType` PermissionsInCurrentContext), odebranie każdego
 * po `id`, status operacji do 200, lista pusta.
 *
 * Wzorzec: `queryMetadataPage` (`lib/ksef/history-sync/query.ts`): kolejka per NIP,
 * sesja z `ksefSessionCache`, jedno `ksefFetch` z audytem `ksef.permissions.*`,
 * błąd nie jest połykany; 401 czyści sesję z pamięci procesu. Środowisko TEST
 * albo produkcja wynika z `KSEF_ENV` (`requireMatchingKsefEnvironment`, adres
 * z `getKsefBaseUrl`). Odpowiedź spoza schematu to `NiepoprawnaOdpowiedzUprawnien`,
 * nigdy zgadywanie (fail-closed).
 */

import {
  MAKS_NAZWY_BIURA,
  MIN_NAZWY_BIURA,
  normalizujNazwe,
  poprawnyNipBiura,
  type UprawnienieKsef,
} from '@/lib/accountant/uprawnienia-ksef';
import type { KsefAuth } from '@/lib/ksef/auth';
import { requireMatchingKsefEnvironment } from '@/lib/ksef/claim-environment';
import { KsefApiError, ksefErrorCodes, ksefFetch } from '@/lib/ksef/client';
import { isNetworkError } from '@/lib/ksef/history-sync/errors';
import { ksefRateLimiter } from '@/lib/ksef/rate-limiter';
import { ksefSessionCache } from '@/lib/ksef/session-cache';
import { KsefCredentialsError } from '@/lib/supabase/admin-queries';
import type { KsefEnvironment } from '@/types/ksef';

export const SCIEZKA_NADANIA = '/permissions/entities/grants';
export const SCIEZKA_LISTY = '/permissions/query/persons/grants';
const sciezkaOdebrania = (idUprawnienia: string) => `/permissions/common/grants/${encodeURIComponent(idUprawnienia)}`;
const sciezkaOperacji = (numer: string) => `/permissions/operations/${encodeURIComponent(numer)}`;

/** `ReferenceNumber` i `PermissionId` w specyfikacji: napisy po 36 znaków (numer operacji, UUID). */
const WZORZEC_36 = /^[0-9A-Za-z-]{36}$/;
export const poprawnyNumerOperacji = (v: unknown): v is string => typeof v === 'string' && WZORZEC_36.test(v);

const DOZWOLONE: readonly UprawnienieKsef[] = ['InvoiceRead', 'InvoiceWrite'];
/** Największa strona listy uprawnień w specyfikacji (`pageSize` 10-100). */
const ROZMIAR_STRONY = 100;
/** Filtr po NIP-ie biura i dwóch uprawnieniach daje zwykle 0-2 pozycje; więcej stron to odpowiedź do sprawdzenia. */
const MAKS_STRON = 5;
const MIN_OPISU = 5;
const MAKS_OPISU = 256;

/** Logowanie do KSeF nie powiodło się, więc prośba o uprawnienie nie poszła. */
export class BladLogowaniaUprawnien extends Error {
  constructor(public readonly przyczyna: unknown) {
    super('Logowanie do KSeF przed operacją na uprawnieniach nie powiodło się');
    this.name = 'BladLogowaniaUprawnien';
  }
}

/** KSeF odpowiedział sukcesem, ale treść nie zgadza się ze schematem. */
export class NiepoprawnaOdpowiedzUprawnien extends Error {
  constructor(
    public readonly operacja: 'nadanie' | 'odebranie' | 'stan' | 'lista',
    /** Początek odpowiedzi do audytu (najwyżej 120 znaków); `null`, gdy jej nie było. */
    public readonly otrzymano: string | null,
  ) {
    super(`KSeF zwrócił odpowiedź spoza schematu (${operacja})`);
    this.name = 'NiepoprawnaOdpowiedzUprawnien';
  }
}

export interface ZadanieKsef {
  tenantId: string;
  /** Musi być środowiskiem z `KSEF_ENV` aplikacji. */
  env: KsefEnvironment;
}

export interface NadanieDoKsef extends ZadanieKsef {
  /** NIP biura: 10 cyfr, wzorzec KSeF i suma kontrolna, inny niż NIP firmy. */
  nip: string;
  nazwa: string;
  uprawnienia: readonly UprawnienieKsef[];
  /** `canDelegate`: biuro może przekazać uprawnienie pracownikom (uprawnienia pośrednie). */
  przekazanie: boolean;
  opis: string;
}

export interface StanOperacjiKsef {
  kod: number;
  opis: string;
  szczegoly: string[];
}

export interface AktywneUprawnienie {
  /** `PermissionId`: tym odbiera się uprawnienie. */
  id: string;
  uprawnienie: UprawnienieKsef;
  przekazanie: boolean;
}

function obiekt(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function skrot(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  try {
    return (typeof v === 'string' ? v : (JSON.stringify(v) ?? '')).slice(0, 120);
  } catch {
    return null;
  }
}

function nipBiura(nip: unknown, auth: KsefAuth): string {
  if (typeof nip !== 'string' || poprawnyNipBiura(nip) !== nip) throw new Error('Uprawnienia KSeF: NIP biura spoza wzorca');
  if (nip === auth.nip) throw new Error('Uprawnienia KSeF: NIP biura to NIP firmy');
  return nip;
}

function listaUprawnien(uprawnienia: unknown): UprawnienieKsef[] {
  if (!Array.isArray(uprawnienia) || uprawnienia.length === 0) throw new Error('Uprawnienia KSeF: brak uprawnień');
  if (new Set(uprawnienia).size !== uprawnienia.length) throw new Error('Uprawnienia KSeF: powtórzone uprawnienie');
  if (!uprawnienia.every((u) => DOZWOLONE.includes(u as UprawnienieKsef))) throw new Error('Uprawnienia KSeF: uprawnienie spoza zakresu');
  return DOZWOLONE.filter((u) => uprawnienia.includes(u));
}

/** Jedno wywołanie w kolejce per NIP z sesją z pamięci procesu; 401 czyści sesję. */
async function wywolaj<T>(auth: KsefAuth, env: KsefEnvironment, fn: (accessToken: string) => Promise<T>): Promise<T> {
  return ksefRateLimiter.enqueue(auth.nip, async () => {
    let accessToken: string;
    try {
      accessToken = (await ksefSessionCache.getSession(auth, env)).accessToken;
    } catch (error) {
      throw new BladLogowaniaUprawnien(error);
    }
    try {
      return await fn(accessToken);
    } catch (error) {
      // Token z pamięci procesu przestał działać: następna próba zaloguje się od nowa.
      if (error instanceof KsefApiError && error.status === 401) ksefSessionCache.invalidate(auth.nip, env);
      throw error;
    }
  });
}

/** `POST /permissions/entities/grants`: numer operacji (202) albo błąd. Wynik daje dopiero status operacji. */
export async function nadajUprawnieniaBiuru(auth: KsefAuth, z: NadanieDoKsef): Promise<string> {
  const env = requireMatchingKsefEnvironment(z.env);
  const nip = nipBiura(z.nip, auth);
  const uprawnienia = listaUprawnien(z.uprawnienia);
  const nazwa = typeof z.nazwa === 'string' ? normalizujNazwe(z.nazwa) : '';
  if (nazwa.length < MIN_NAZWY_BIURA || nazwa.length > MAKS_NAZWY_BIURA) throw new Error('Uprawnienia KSeF: nazwa biura poza 5-90 znaków');
  if (typeof z.opis !== 'string' || z.opis.length < MIN_OPISU || z.opis.length > MAKS_OPISU) {
    throw new Error('Uprawnienia KSeF: opis poza 5-256 znaków');
  }
  if (typeof z.przekazanie !== 'boolean') throw new Error('Uprawnienia KSeF: brak decyzji o przekazaniu');
  const przekazanie = z.przekazanie;

  return wywolaj(auth, env, async (accessToken) => {
    const odpowiedz = await ksefFetch<unknown>(SCIEZKA_NADANIA, {
      method: 'POST',
      accessToken,
      env,
      body: {
        subjectIdentifier: { type: 'Nip', value: nip },
        permissions: uprawnienia.map((type) => ({ type, canDelegate: przekazanie })),
        description: z.opis,
        subjectDetails: { fullName: nazwa },
      },
      audit: {
        tenantId: z.tenantId,
        action: 'permissions.grant',
        metadata: { subjectNip: nip, permissions: uprawnienia, canDelegate: przekazanie },
      },
    });
    const numer = obiekt(odpowiedz)?.referenceNumber;
    if (!poprawnyNumerOperacji(numer)) throw new NiepoprawnaOdpowiedzUprawnien('nadanie', skrot(odpowiedz));
    return numer;
  });
}

/** `GET /permissions/operations/{referenceNumber}`: kod i opis statusu operacji nadania albo odebrania. */
export async function stanOperacjiUprawnien(auth: KsefAuth, z: ZadanieKsef & { numer: string }): Promise<StanOperacjiKsef> {
  const env = requireMatchingKsefEnvironment(z.env);
  if (!poprawnyNumerOperacji(z.numer)) throw new Error('Uprawnienia KSeF: numer operacji spoza wzorca');

  return wywolaj(auth, env, async (accessToken) => {
    const odpowiedz = await ksefFetch<unknown>(sciezkaOperacji(z.numer), {
      method: 'GET',
      accessToken,
      env,
      audit: { tenantId: z.tenantId, action: 'permissions.operation', metadata: { referenceNumber: z.numer } },
    });
    const status = obiekt(obiekt(odpowiedz)?.status);
    const kod = status?.code;
    const opis = status?.description;
    if (typeof kod !== 'number' || !Number.isInteger(kod) || typeof opis !== 'string') {
      throw new NiepoprawnaOdpowiedzUprawnien('stan', skrot(odpowiedz));
    }
    const szczegoly = Array.isArray(status!.details)
      ? (status!.details as unknown[]).filter((d): d is string => typeof d === 'string').slice(0, 10)
      : [];
    return { kod, opis, szczegoly };
  });
}

/**
 * Aktywne uprawnienia biura w kontekście firmy, tylko z podanej listy
 * (`POST /permissions/query/persons/grants`, PermissionsInCurrentContext:
 * uprawnienia obowiązujące w kontekście, także nadane poza FaktWay, np.
 * w Aplikacji Podatnika). Strony po 100, dopóki `hasMore`.
 */
export async function aktywneUprawnieniaBiura(
  auth: KsefAuth,
  z: ZadanieKsef & { nip: string; uprawnienia: readonly UprawnienieKsef[] },
): Promise<AktywneUprawnienie[]> {
  const env = requireMatchingKsefEnvironment(z.env);
  const nip = nipBiura(z.nip, auth);
  const uprawnienia = listaUprawnien(z.uprawnienia);
  const wynik: AktywneUprawnienie[] = [];

  for (let strona = 0; strona < MAKS_STRON; strona++) {
    const odpowiedz = await wywolaj(auth, env, (accessToken) =>
      ksefFetch<unknown>(`${SCIEZKA_LISTY}?pageOffset=${strona}&pageSize=${ROZMIAR_STRONY}`, {
        method: 'POST',
        accessToken,
        env,
        body: {
          queryType: 'PermissionsInCurrentContext',
          authorizedIdentifier: { type: 'Nip', value: nip },
          permissionTypes: uprawnienia,
          permissionState: 'Active',
        },
        audit: { tenantId: z.tenantId, action: 'permissions.query', metadata: { subjectNip: nip, permissionTypes: uprawnienia, pageOffset: strona } },
      }),
    );
    const o = obiekt(odpowiedz);
    if (!o || !Array.isArray(o.permissions) || typeof o.hasMore !== 'boolean') {
      throw new NiepoprawnaOdpowiedzUprawnien('lista', skrot(odpowiedz));
    }
    for (const element of o.permissions as unknown[]) {
      const p = obiekt(element);
      if (!p) throw new NiepoprawnaOdpowiedzUprawnien('lista', skrot(element));
      const uprawniony = obiekt(p.authorizedIdentifier);
      // KSeF filtruje sam; pozycji innego podmiotu, nieaktywnych i spoza listy i tak nie bierzemy.
      if (uprawniony?.type !== 'Nip' || uprawniony.value !== nip || p.permissionState !== 'Active') continue;
      const uprawnienie = uprawnienia.find((u) => u === p.permissionScope);
      if (!uprawnienie) continue;
      if (!poprawnyNumerOperacji(p.id)) throw new NiepoprawnaOdpowiedzUprawnien('lista', skrot(element));
      wynik.push({ id: p.id, uprawnienie, przekazanie: p.canDelegate === true });
    }
    if (!o.hasMore) return wynik;
  }
  throw new NiepoprawnaOdpowiedzUprawnien('lista', `ponad ${MAKS_STRON} stron`);
}

/** `DELETE /permissions/common/grants/{permissionId}`: numer operacji odebrania (202). */
export async function odbierzUprawnienieBiura(auth: KsefAuth, z: ZadanieKsef & { idUprawnienia: string }): Promise<string> {
  const env = requireMatchingKsefEnvironment(z.env);
  if (!poprawnyNumerOperacji(z.idUprawnienia)) throw new Error('Uprawnienia KSeF: identyfikator uprawnienia spoza wzorca');

  return wywolaj(auth, env, async (accessToken) => {
    const odpowiedz = await ksefFetch<unknown>(sciezkaOdebrania(z.idUprawnienia), {
      method: 'DELETE',
      accessToken,
      env,
      audit: { tenantId: z.tenantId, action: 'permissions.revoke', metadata: { permissionId: z.idUprawnienia } },
    });
    const numer = obiekt(odpowiedz)?.referenceNumber;
    if (!poprawnyNumerOperacji(numer)) throw new NiepoprawnaOdpowiedzUprawnien('odebranie', skrot(odpowiedz));
    return numer;
  });
}

// ─── klasyfikacja błędów ────────────────────────────────────────────────

export interface KlasyfikacjaBledu {
  /** Kod do bazy (`error_code` w 00195) i audytu: `[a-z0-9_]`; komunikat daje `komunikatBledu`. */
  kod: string;
  /** Błąd po naszej stronie albo nieoczekiwany: do Sentry, operator patrzy. */
  techniczny: boolean;
  /** KSeF mógł przyjąć prośbę (brak odpowiedzi, 5xx, zła odpowiedź 2xx): kolejna próba najpierw sprawdza listę. */
  niepewny: boolean;
  retryAfterMs: number | null;
}

const klasa = (kod: string, techniczny: boolean, niepewny: boolean, retryAfterMs: number | null = null): KlasyfikacjaBledu => ({
  kod,
  techniczny,
  niepewny,
  retryAfterMs,
});

/** Błąd z poświadczeń, logowania, KSeF albo odpowiedzi jako kod do bazy. */
export function klasyfikujBladUprawnien(error: unknown): KlasyfikacjaBledu {
  if (error instanceof KsefCredentialsError || (error instanceof Error && error.name === 'KsefCredentialsError')) {
    const powod = (error as KsefCredentialsError).reason;
    if (powod === 'missing' || powod === 'not-verified') return klasa('credentials_missing', false, false);
    if (powod === 'tenant-read') return klasa('credentials_read', true, false);
    return klasa('credentials_internal', true, false);
  }
  if (error instanceof BladLogowaniaUprawnien) {
    const p = error.przyczyna;
    if (p instanceof KsefApiError && p.status === 429) return klasa('http_429', false, false, p.retryAfterMs);
    if (p instanceof KsefApiError && (p.status === 408 || p.status >= 500)) return klasa('http_5xx', false, false);
    if (isNetworkError(p)) return klasa('network', false, false);
    return klasa('session', false, false);
  }
  if (error instanceof NiepoprawnaOdpowiedzUprawnien) return klasa('invalid_response', true, true);
  if (error instanceof KsefApiError) {
    if (error.status === 401) return klasa('http_401', false, false);
    if (error.status === 403) return klasa('http_403', false, false);
    if (error.status === 429) return klasa('http_429', false, false, error.retryAfterMs);
    if (error.status === 408) return klasa('timeout', false, true);
    if (error.status >= 500 && error.status < 600) return klasa('http_5xx', false, true);
    const kod = ksefErrorCodes(error.body)[0];
    return kod !== undefined ? klasa(`ksef_${kod}`, true, false) : klasa(`ksef_http_${error.status}`, true, false);
  }
  if (isNetworkError(error)) return klasa('network', false, true);
  return klasa('unknown', true, true);
}
