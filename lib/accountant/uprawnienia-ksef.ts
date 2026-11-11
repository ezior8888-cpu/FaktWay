/**
 * Uprawnienie biura rachunkowego w KSeF nadawane i odbierane z FaktWay (plan
 * kompletnej aplikacji, krok 6.2, część 4; ryzyko R1). Czysty model bez sieci
 * i bazy: działa w przeglądarce (formularz) i na serwerze (akcje, odczyt listy).
 *
 * Źródła (odczyt 11.11.2026):
 *  - specyfikacja OpenAPI KSeF 2.0 TEST, https://api-test.ksef.mf.gov.pl/docs/v2/openapi.json:
 *    `POST /permissions/entities/grants` („Nadanie podmiotom uprawnień do obsługi
 *    faktur”, `EntityPermissionsGrantRequest`: `subjectIdentifier` typu Nip,
 *    `permissions` z `EntityPermissionType` InvoiceRead, InvoiceWrite albo
 *    CollectiveIdentifierManage i flagą `canDelegate`, `description` 5-256 znaków,
 *    `subjectDetails.fullName` 5-90 znaków), status operacji
 *    (`PermissionsOperationStatusResponse.status.code`: 100 przyjęta, 200 sukces,
 *    400, 410, 420, 430, 440, 450, 500, 550 porażki);
 *  - dokumentacja CIRFMF, https://github.com/CIRFMF/ksef-docs/blob/main/uprawnienia.md:
 *    uprawnienia do obsługi faktur dla biur rachunkowych, `canDelegate` pozwala
 *    biuru przekazać dostęp pracownikom (uprawnienia pośrednie), operacja jest
 *    asynchroniczna, tego samego uprawnienia nie da się nadać dwa razy.
 *
 * Zakres to zawsze przeglądanie faktur (InvoiceRead), opcjonalnie także
 * wystawianie (InvoiceWrite). CollectiveIdentifierManage nie wchodzi: według
 * dokumentacji InvoiceRead obejmuje już identyfikatory zbiorcze.
 */

import { z } from 'zod';

import { validateNipChecksum } from '@/lib/xml/invoice-calculator';
import type { KsefEnvironment } from '@/types/ksef';

export type UprawnienieKsef = 'InvoiceRead' | 'InvoiceWrite';

export const ZAKRESY = ['odczyt', 'odczyt_i_wystawianie'] as const;
export type Zakres = (typeof ZAKRESY)[number];

/** Uprawnienia KSeF zakresu, po kolei jak w bazie (00195: `scopes`). */
export const UPRAWNIENIA_ZAKRESU: Readonly<Record<Zakres, readonly UprawnienieKsef[]>> = {
  odczyt: ['InvoiceRead'],
  odczyt_i_wystawianie: ['InvoiceRead', 'InvoiceWrite'],
};

export const NAZWY_ZAKRESOW: Readonly<Record<Zakres, string>> = {
  odczyt: 'Przeglądanie faktur',
  odczyt_i_wystawianie: 'Przeglądanie i wystawianie faktur',
};

export const OPISY_ZAKRESOW: Readonly<Record<Zakres, string>> = {
  odczyt: 'Biuro widzi i pobiera z KSeF faktury sprzedaży i zakupu firmy.',
  odczyt_i_wystawianie: 'Biuro widzi faktury firmy i może też wysyłać do KSeF faktury w jej imieniu.',
};

const NAZWY_UPRAWNIEN: Readonly<Record<UprawnienieKsef, string>> = {
  InvoiceRead: 'przeglądanie faktur',
  InvoiceWrite: 'wystawianie faktur',
};

/** Zakres z listy uprawnień (kolejność bez znaczenia); zestaw spoza dwóch zakresów to `null`. */
export function zakresZUprawnien(uprawnienia: unknown): Zakres | null {
  if (!Array.isArray(uprawnienia) || !uprawnienia.every((u) => typeof u === 'string')) return null;
  const klucz = [...uprawnienia].sort().join(',');
  if (new Set(uprawnienia).size !== uprawnienia.length) return null;
  return ZAKRESY.find((z) => UPRAWNIENIA_ZAKRESU[z].join(',') === klucz) ?? null;
}

/** Nazwy uprawnień do zdania („przeglądanie faktur i wystawianie faktur”). */
export function nazwyUprawnien(uprawnienia: readonly UprawnienieKsef[]): string {
  return uprawnienia.map((u) => NAZWY_UPRAWNIEN[u]).join(' i ');
}

// ─── NIP i nazwa biura ──────────────────────────────────────────────────

/** Wzorzec `Nip` ze specyfikacji KSeF 2.0. */
const WZORZEC_NIP_KSEF = /^[1-9](([0-9][1-9])|([1-9][0-9]))[0-9]{7}$/;

/** NIP bez spacji, myślników i polskiego prefiksu „PL”. */
export function normalizujNip(wartosc: string): string {
  return wartosc.replace(/[\s-]/g, '').replace(/^pl/i, '');
}

/** NIP biura po normalizacji: 10 cyfr, wzorzec KSeF i suma kontrolna; inaczej `null`. */
export function poprawnyNipBiura(wartosc: unknown): string | null {
  if (typeof wartosc !== 'string') return null;
  const nip = normalizujNip(wartosc);
  return WZORZEC_NIP_KSEF.test(nip) && validateNipChecksum(nip) ? nip : null;
}

/** `EntityDetails.fullName` w KSeF 2.0: od 5 do 90 znaków. */
export const MIN_NAZWY_BIURA = 5;
export const MAKS_NAZWY_BIURA = 90;

/** Nazwa bez spacji na brzegach i bez wielokrotnych spacji (tak samo robi 00195). */
export function normalizujNazwe(wartosc: string): string {
  return wartosc.replace(/\s+/g, ' ').trim();
}

export const BLAD_NIP =
  'NIP biura ma 10 cyfr i poprawną sumę kontrolną. Sprawdź go na fakturze biura albo w wykazie podatników VAT.';
export const BLAD_NAZWY = `Wpisz pełną nazwę biura, od ${MIN_NAZWY_BIURA} do ${MAKS_NAZWY_BIURA} znaków, na przykład z formą prawną.`;

/** Formularz nadania: ten sam schemat w przeglądarce i w akcji (konwencja repo). */
export const nadanieUprawnieniaSchema = z.object({
  /** Firma, dla której wyrenderowano formularz (UX-01): porównanie z aktywną firmą w akcji. */
  firma: z.string().uuid({ message: 'Odśwież stronę i spróbuj ponownie.' }),
  nip: z
    .string({ message: BLAD_NIP })
    .max(32, { message: BLAD_NIP })
    .transform(normalizujNip)
    .refine((nip) => poprawnyNipBiura(nip) !== null, { message: BLAD_NIP }),
  nazwa: z
    .string({ message: BLAD_NAZWY })
    .max(500, { message: BLAD_NAZWY })
    .transform(normalizujNazwe)
    .refine((n) => n.length >= MIN_NAZWY_BIURA && n.length <= MAKS_NAZWY_BIURA, { message: BLAD_NAZWY }),
  zakres: z.enum(ZAKRESY, { message: 'Wybierz zakres uprawnienia.' }),
  przekazanie: z.boolean({ message: 'Zdecyduj, czy biuro może przekazać dostęp pracownikom.' }),
});
export type NadanieWejscie = z.input<typeof nadanieUprawnieniaSchema>;

/** `description` uprawnienia w KSeF (5-256 znaków): widzi je biuro i właściciel w Aplikacji Podatnika. */
export function opisDlaKsef(nazwa: string): string {
  return `Dostęp biura rachunkowego ${normalizujNazwe(nazwa)} nadany w FaktWay przez właściciela firmy`.slice(0, 256);
}

// ─── stany z bazy (00195) ───────────────────────────────────────────────

export const STANY_UPRAWNIENIA = [
  'grant_pending',
  'grant_in_progress',
  'granted',
  'grant_failed',
  'revoke_pending',
  'revoke_in_progress',
  'revoked',
  'revoke_failed',
] as const;
export type StanUprawnienia = (typeof STANY_UPRAWNIENIA)[number];

/** Próba bez wyniku dłużej niż tyle (restart, zerwane połączenie) jest do przejęcia (00195). */
export const CZAS_PROBY_MS = 5 * 60_000;

export interface UprawnienieBiura {
  id: string;
  nip: string;
  nazwa: string;
  zakres: Zakres;
  przekazanie: boolean;
  stan: StanUprawnienia;
  /** Ostatni kod statusu operacji z KSeF (100, 200, 4xx, 5xx). */
  kodKsef: number | null;
  opisKsef: string | null;
  /** Kod błędu FaktWay (`error_code`), także uwaga przy „odebrane” (`not_found_in_ksef`). */
  kodBledu: string | null;
  /** Początek bieżącej próby (`claimed_at`). */
  rozpoczeto: string;
  sprawdzono: string | null;
  nadano: string | null;
  odebrano: string | null;
}

/** Wiersz `ksef_permission_grants` (odczyt kluczem sesji) jako model; wiersz spoza schematu to `null`. */
export function wierszZBazy(w: Record<string, unknown>): UprawnienieBiura | null {
  const stan = STANY_UPRAWNIENIA.find((s) => s === w.status);
  const zakres = zakresZUprawnien(w.scopes);
  const nip = typeof w.subject_nip === 'string' ? w.subject_nip : null;
  if (!stan || !zakres || !nip || typeof w.id !== 'string' || typeof w.subject_name !== 'string') return null;
  if (typeof w.can_delegate !== 'boolean' || typeof w.claimed_at !== 'string') return null;
  const tekstLubNull = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    id: w.id,
    nip,
    nazwa: w.subject_name,
    zakres,
    przekazanie: w.can_delegate,
    stan,
    kodKsef: typeof w.ksef_status_code === 'number' ? w.ksef_status_code : null,
    opisKsef: tekstLubNull(w.ksef_status_description),
    kodBledu: tekstLubNull(w.error_code),
    rozpoczeto: w.claimed_at,
    sprawdzono: tekstLubNull(w.checked_at),
    nadano: tekstLubNull(w.granted_at),
    odebrano: tekstLubNull(w.revoked_at),
  };
}

/** Dane sekcji w Ustawieniach (zakładka Księgowa). */
export interface SekcjaUprawnien {
  /** `null`: KSEF_ENV nie jest bezpiecznie ustawione, sekcja niczego nie wysyła. */
  srodowisko: KsefEnvironment | null;
  /** Certyfikat właściciela podłączony i potwierdzony w tym środowisku. */
  polaczono: boolean;
  nipFirmy: string | null;
  lista: { rodzaj: 'wiersze'; wiersze: UprawnienieBiura[] } | { rodzaj: 'niedostepna' } | { rodzaj: 'blad' };
  /** Chwila odczytu z serwera: od niej liczymy, czy próba jest przerwana. */
  teraz: string;
}

// ─── komunikaty ─────────────────────────────────────────────────────────

export interface Biuro {
  nazwa: string;
  nip: string;
}

export type RodzajOperacji = 'nadanie' | 'odebranie' | 'sprawdzenie';

/** Rodzaj kodu statusu operacji KSeF: tylko 200 to sukces, 100-199 w toku, reszta to porażka (fail-closed). */
export function rodzajStatusuOperacji(kod: number): 'w_toku' | 'sukces' | 'porazka' {
  if (kod === 200) return 'sukces';
  if (Number.isInteger(kod) && kod >= 100 && kod < 200) return 'w_toku';
  return 'porazka';
}

/** Opisy kodów ze specyfikacji (`PermissionsOperationStatusResponse`), gdy KSeF nie poda własnego. */
const OPISY_STATUSOW: Readonly<Record<number, string>> = {
  400: 'Operacja zakończona niepowodzeniem',
  410: 'Podane identyfikatory są niezgodne lub pozostają w niewłaściwej relacji',
  420: 'Użyte poświadczenia nie mają uprawnień do wykonania tej operacji',
  430: 'Kontekst identyfikatora nie odpowiada wymaganej roli lub uprawnieniom',
  440: 'Operacja niedozwolona dla wskazanych powiązań identyfikatorów',
  450: 'Operacja niedozwolona dla wskazanego identyfikatora lub jego typu',
  500: 'Nieznany błąd',
  550: 'Operacja została anulowana przez system',
};

export const biuroWZdaniu = (b: Biuro) => `${b.nazwa} (NIP ${b.nip})`;

const PROSBA: Readonly<Record<RodzajOperacji, string>> = {
  nadanie: 'nadanie uprawnienia',
  odebranie: 'odebranie uprawnienia',
  sprawdzenie: 'sprawdzenie stanu uprawnienia',
};

const PONOW_NADANIE = 'FaktWay najpierw sprawdzi w KSeF, czy uprawnienie już jest, i nie nada go drugi raz.';
const PONOW_ODEBRANIE = 'FaktWay najpierw sprawdzi w KSeF, które uprawnienia biura są jeszcze aktywne.';
const POMOC = 'napisz do pomocy FaktWay';

function zaIle(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return 'za chwilę';
  return `za ${Math.max(1, Math.ceil(ms / 60_000))} min`;
}

function opisZKsef(kod: number, opis: string | null): string {
  const z = (opis ?? '').replace(/\s+/g, ' ').trim();
  const tekst = z.length > 0 ? z : (OPISY_STATUSOW[kod] ?? 'Operacja zakończona niepowodzeniem');
  return tekst.length > 200 ? `${tekst.slice(0, 199)}…` : tekst;
}

/** Komunikat dla porażki operacji w KSeF (status ≥ 300 albo spoza 100-200). */
export function komunikatStatusu(kod: number, opis: string | null, rodzaj: RodzajOperacji, b: Biuro): string {
  const kto = biuroWZdaniu(b);
  const poczatek =
    rodzaj === 'odebranie' ? `KSeF nie odebrał uprawnienia dla ${kto}` : `KSeF nie nadał uprawnienia dla ${kto}`;
  const tekst = opisZKsef(kod, opis);
  if (kod === 420) {
    return (
      `${poczatek}: połączenie FaktWay z KSeF nie ma prawa do zarządzania uprawnieniami (kod 420). ` +
      'Połącz FaktWay certyfikatem właściciela firmy albo zrób to w Aplikacji Podatnika KSeF.'
    );
  }
  if (kod === 410 || kod === 430 || kod === 440 || kod === 450) {
    return (
      `${poczatek}: ${tekst} (kod ${kod}). Sprawdź NIP biura i spróbuj ponownie; jeśli NIP jest dobry, ` +
      `zrób to w Aplikacji Podatnika KSeF albo ${POMOC}.`
    );
  }
  if (kod === 550) {
    return `${poczatek}: KSeF przerwał operację (kod 550). Spróbuj ponownie później.`;
  }
  return `${poczatek}: ${tekst} (kod ${kod}). Spróbuj ponownie później, a jeśli to się powtórzy, ${POMOC}.`;
}

export interface SzczegolyBledu {
  kodKsef: number | null;
  opisKsef: string | null;
  retryAfterMs: number | null;
}

/**
 * Komunikat dla kodu błędu z bazy albo z klasyfikacji (`lib/ksef/uprawnienia.ts`):
 * nazwa biura, NIP, co się stało i co zrobić (protokół napraw, pkt 4).
 */
export function komunikatBledu(kod: string, rodzaj: RodzajOperacji, b: Biuro, sz: SzczegolyBledu): string {
  const kto = biuroWZdaniu(b);
  const prosba = PROSBA[rodzaj];
  const niewyslana = `FaktWay nie wysłał prośby o ${prosba} dla ${kto}`;
  const status = /^status_(\d{3})$/.exec(kod);
  if (status) return komunikatStatusu(Number(status[1]), sz.opisKsef, rodzaj, b);
  const ksef = /^ksef_(\d+)$/.exec(kod);
  if (ksef) {
    return (
      `KSeF odrzucił prośbę o ${prosba} dla ${kto} (kod ${ksef[1]}${ksef[1] === '21405' ? ': błąd walidacji danych' : ''}). ` +
      `Sprawdź NIP i nazwę biura i spróbuj ponownie, a jeśli to się powtórzy, ${POMOC}.`
    );
  }
  const http = /^ksef_http_(\d{3})$/.exec(kod);
  if (http) {
    return `KSeF odrzucił prośbę o ${prosba} dla ${kto} (HTTP ${http[1]}). Spróbuj ponownie później, a jeśli to się powtórzy, ${POMOC}.`;
  }
  switch (kod) {
    case 'credentials_missing':
      return (
        `${PROSBA[rodzaj].charAt(0).toUpperCase()}${PROSBA[rodzaj].slice(1)} dla ${kto} wymaga połączenia FaktWay z KSeF, ` +
        'a ta firma go nie ma. Połącz KSeF w Ustawieniach (zakładka KSeF) i spróbuj ponownie.'
      );
    case 'credentials_read':
      return `Nie udało się odczytać połączenia z KSeF, więc ${niewyslana}. Spróbuj ponownie za chwilę.`;
    case 'credentials_internal':
      return (
        `Nie udało się użyć połączenia z KSeF tej firmy, więc ${niewyslana}. Napisz do pomocy FaktWay; ` +
        'do tego czasu można to zrobić w Aplikacji Podatnika KSeF.'
      );
    case 'session':
      return (
        `Nie udało się zalogować do KSeF, więc ${niewyslana}. ` +
        'Sprawdź połączenie z KSeF w Ustawieniach (zakładka KSeF) i spróbuj ponownie.'
      );
    case 'http_401':
      return (
        `KSeF nie przyjął logowania FaktWay przy prośbie o ${prosba} dla ${kto}. ` +
        'Spróbuj ponownie: FaktWay zaloguje się do KSeF od nowa. Jeśli to się powtórzy, sprawdź połączenie z KSeF w Ustawieniach.'
      );
    case 'http_403':
      return (
        `KSeF odmówił prośby o ${prosba} dla ${kto}: połączenie FaktWay z KSeF nie ma uprawnienia do zarządzania ` +
        'uprawnieniami (CredentialsManage). Połącz FaktWay certyfikatem właściciela firmy albo zrób to w Aplikacji Podatnika KSeF.'
      );
    case 'http_429':
      return `KSeF ogranicza teraz liczbę zapytań, więc prośba o ${prosba} dla ${kto} nie przeszła. Spróbuj ponownie ${zaIle(sz.retryAfterMs)}.`;
    case 'http_5xx':
    case 'timeout':
    case 'network':
      if (rodzaj === 'nadanie') {
        return (
          `KSeF nie odpowiedział na prośbę o nadanie uprawnienia dla ${kto}, więc nie wiadomo, czy ją przyjął. ` +
          `Spróbuj ponownie za kilka minut: ${PONOW_NADANIE}`
        );
      }
      if (rodzaj === 'odebranie') {
        return `KSeF nie odpowiedział na prośbę o odebranie uprawnienia dla ${kto}. Spróbuj ponownie za kilka minut: ${PONOW_ODEBRANIE}`;
      }
      return `KSeF nie odpowiedział, więc stanu uprawnienia dla ${kto} nie udało się teraz sprawdzić. Spróbuj ponownie za kilka minut.`;
    case 'invalid_response':
      if (rodzaj === 'nadanie') {
        return (
          `KSeF odpowiedział na prośbę o nadanie uprawnienia dla ${kto} w nieoczekiwany sposób, więc nie wiadomo, czy ją przyjął. ` +
          `Spróbuj ponownie za kilka minut: ${PONOW_NADANIE} Jeśli to się powtórzy, ${POMOC}.`
        );
      }
      return (
        `KSeF odpowiedział na prośbę o ${prosba} dla ${kto} w nieoczekiwany sposób. Spróbuj ponownie za kilka minut, ` +
        `a jeśli to się powtórzy, ${POMOC}.`
      );
    case 'operation_expired':
      return (
        `KSeF nie przechowuje już wyniku tej operacji (wynik jest dostępny przez 30 dni), a uprawnienie dla ${kto} ` +
        'nie jest aktywne. Nadaj je ponownie.'
      );
    case 'still_active':
      return (
        `Nie udało się odebrać całego uprawnienia dla ${kto}: część jest nadal aktywna w KSeF. Kliknij „Ponów odebranie”, ` +
        'a jeśli to się powtórzy, odbierz je w Aplikacji Podatnika KSeF.'
      );
    case 'not_found_in_ksef':
      return (
        `W KSeF nie było już aktywnego uprawnienia dla ${kto} (mogło zostać odebrane w Aplikacji Podatnika KSeF). ` +
        'Jeśli chcesz się upewnić, sprawdź listę uprawnień w Aplikacji Podatnika KSeF.'
      );
    default:
      return `Coś poszło nie tak przy prośbie o ${prosba} dla ${kto}. Spróbuj ponownie za chwilę, a jeśli to się powtórzy, ${POMOC}.`;
  }
}

/**
 * Biuro miało już uprawnienie w KSeF (np. z Aplikacji Podatnika) z innym `canDelegate`
 * niż wybrane: FaktWay nie nadaje go drugi raz i nie podaje wyboru jako faktu (`delegate_mismatch`).
 */
export const UWAGA_PRZEKAZANIE =
  'Uprawnienie nadane wcześniej ma w KSeF inne ustawienie przekazania pracownikom niż wybrane; zmienisz je, ' +
  'odbierając uprawnienie i nadając je ponownie.';

/** Komunikat sukcesu po nadaniu. */
export function komunikatNadane(w: { zakres: Zakres; przekazanie: boolean }, b: Biuro): string {
  return (
    `Uprawnienie w KSeF dla ${biuroWZdaniu(b)} jest nadane: ${NAZWY_ZAKRESOW[w.zakres].toLowerCase()}` +
    `${w.przekazanie ? ', z możliwością przekazania pracownikom biura' : ''}.`
  );
}

export const komunikatWToku = (rodzaj: 'nadanie' | 'odebranie', b: Biuro) =>
  `KSeF przyjął ${rodzaj === 'nadanie' ? 'nadanie' : 'odebranie'} uprawnienia dla ${biuroWZdaniu(b)} i jeszcze je przetwarza. ` +
  'Wynik zobaczysz po kliknięciu „Sprawdź stan”.';

export type AkcjaUprawnienia = 'sprawdz' | 'odbierz' | 'ponow_nadanie' | 'ponow_odebranie' | 'nadaj_ponownie';

export const NAPISY_AKCJI: Readonly<Record<AkcjaUprawnienia, string>> = {
  sprawdz: 'Sprawdź stan',
  odbierz: 'Odbierz',
  ponow_nadanie: 'Ponów',
  ponow_odebranie: 'Ponów odebranie',
  nadaj_ponownie: 'Nadaj ponownie',
};

export type Ton = 'ok' | 'czeka' | 'blad' | 'neutralny';

export interface StanDlaKlienta {
  etykieta: string;
  ton: Ton;
  opis: string;
  akcje: AkcjaUprawnienia[];
}

/** Etykieta, opis i przyciski wiersza na liście; próba bez wyniku ponad 5 minut to „przerwane”. */
export function stanDlaKlienta(w: UprawnienieBiura, teraz: Date): StanDlaKlienta {
  const b: Biuro = { nazwa: w.nazwa, nip: w.nip };
  const sz: SzczegolyBledu = { kodKsef: w.kodKsef, opisKsef: w.opisKsef, retryAfterMs: null };
  const rozpoczeto = Date.parse(w.rozpoczeto);
  const przerwana = !Number.isFinite(rozpoczeto) || rozpoczeto <= teraz.getTime() - CZAS_PROBY_MS;
  switch (w.stan) {
    case 'grant_pending':
      return przerwana
        ? {
            etykieta: 'Nadanie przerwane',
            ton: 'blad',
            opis: `Poprzednia próba nadania nie dokończyła się. Kliknij „Ponów”: ${PONOW_NADANIE}`,
            akcje: ['ponow_nadanie'],
          }
        : { etykieta: 'Nadawanie', ton: 'czeka', opis: 'FaktWay wysyła do KSeF prośbę o nadanie uprawnienia.', akcje: [] };
    case 'grant_in_progress':
      return { etykieta: 'W toku w KSeF', ton: 'czeka', opis: 'KSeF przyjął nadanie i jeszcze je przetwarza.', akcje: ['sprawdz'] };
    case 'granted':
      return {
        etykieta: 'Nadane',
        ton: 'ok',
        opis:
          w.kodBledu === 'delegate_mismatch'
            ? `Biuro ma w KSeF uprawnienie: ${NAZWY_ZAKRESOW[w.zakres].toLowerCase()}. ${UWAGA_PRZEKAZANIE}`
            : `Biuro ma w KSeF uprawnienie: ${NAZWY_ZAKRESOW[w.zakres].toLowerCase()}` +
              `${w.przekazanie ? ', z możliwością przekazania pracownikom biura' : ''}.`,
        akcje: ['odbierz'],
      };
    case 'grant_failed':
      return { etykieta: 'Nie nadano', ton: 'blad', opis: komunikatBledu(w.kodBledu ?? 'unknown', 'nadanie', b, sz), akcje: ['ponow_nadanie'] };
    case 'revoke_pending':
      return przerwana
        ? {
            etykieta: 'Odebranie przerwane',
            ton: 'blad',
            opis: 'Poprzednia próba odebrania nie dokończyła się, więc uprawnienie może być nadal aktywne. Kliknij „Ponów odebranie”.',
            akcje: ['ponow_odebranie'],
          }
        : { etykieta: 'Odbieranie', ton: 'czeka', opis: 'FaktWay wysyła do KSeF prośbę o odebranie uprawnienia.', akcje: [] };
    case 'revoke_in_progress':
      return { etykieta: 'Odbieranie w toku', ton: 'czeka', opis: 'KSeF przyjął odebranie i jeszcze je przetwarza.', akcje: ['sprawdz'] };
    case 'revoked':
      return {
        etykieta: 'Odebrane',
        ton: 'neutralny',
        opis: w.kodBledu === 'not_found_in_ksef' ? komunikatBledu('not_found_in_ksef', 'odebranie', b, sz) : 'Biuro nie ma już tego uprawnienia w KSeF.',
        akcje: ['nadaj_ponownie'],
      };
    case 'revoke_failed':
      return {
        etykieta: 'Nie odebrano',
        ton: 'blad',
        opis: `${komunikatBledu(w.kodBledu ?? 'unknown', 'odebranie', b, sz)} Uprawnienie może być nadal aktywne.`,
        akcje: ['ponow_odebranie'],
      };
  }
}

/** Wynik akcji uprawnień dla formularza i listy. */
export type WynikUprawnienia =
  | { success: true; stan: StanUprawnienia; komunikat: string }
  | { success: false; error: string; mfaStepUp?: true };
