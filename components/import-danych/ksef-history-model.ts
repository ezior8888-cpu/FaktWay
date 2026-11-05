import { formatPlInt, formatPlMoney } from '@/lib/format/pl';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { plural, type PluralForms } from '@/lib/i18n/plural';
import type {
  KsefHistoryBlockedItem,
  KsefHistoryDeferredItem,
  KsefHistoryDirection,
  KsefHistoryErrorCode,
  KsefHistoryStreamStatus,
  KsefHistorySyncStatus,
} from '@/lib/ksef/history-sync/status';
import { SUPPORT_EMAIL } from '@/lib/site';

/**
 * Teksty karty „Historia z KSeF” na ekranie Import danych — same czyste
 * funkcje nad stanem z `readKsefHistorySyncStatus` (decyzja Bartosza
 * 22.10.2026: zamiast Magicznego importu FaktWay sam pobiera z KSeF całą
 * historię sprzedaży i zakupów, a potem na bieżąco sprzedaż wystawioną poza
 * FaktWay).
 *
 * Zasada: tekst nie mówi więcej, niż pokazują dane. „Pobrana” tylko wtedy,
 * gdy nic nie czeka; koniec szacujemy dopiero po przeszukaniu całej historii
 * i z tempa, które naprawdę zmierzyliśmy; limitów KSeF nie podajemy jako
 * naszego tempa. Wstrzymane pobieranie nie udaje, że „szukamy dalej”.
 * Tak samo pobieranie zatrzymane błędem certyfikatu (naprawia go klient):
 * runner nie woła wtedy KSeF wcale, więc zostają same fakty, a plakietka
 * mówi „Wymaga działania” (poprawka po przeglądzie, decyzja Bartosza
 * 22.10.2026).
 */

const FAKTURE: PluralForms = ['fakturę', 'faktury', 'faktur'];
const FAKTURA: PluralForms = ['faktura', 'faktury', 'faktur'];

/** „1 fakturę”, „3 faktury”, „1 250 faktur” — liczba po polsku z odmianą. */
export function invoiceCount(count: number, forms: PluralForms = FAKTURE): string {
  return `${formatPlInt(count)} ${plural(count, forms)}`;
}

function warsawParts(iso: string): { day: string; month: string; year: string; time: string } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('pl-PL', {
    timeZone: 'Europe/Warsaw',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: get('day'), month: get('month'), year: get('year'), time: `${get('hour')}:${get('minute')}` };
}

/** Znacznik czasu jako „DD.MM.RRRR” w czasie polskim. */
export function formatHistoryDay(iso: string): string {
  const p = warsawParts(iso);
  return p ? `${p.day}.${p.month}.${p.year}` : iso;
}

/** „2026-10-05” (data z faktury) → „05.10.2026”. */
export function formatInvoiceDay(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : isoDate;
}

/** „DD.MM o GG:MM” w czasie polskim (szacowany koniec, wznowienie). */
export function formatDayAt(iso: string): string {
  const p = warsawParts(iso);
  return p ? `${p.day}.${p.month} o ${p.time}` : iso;
}

/** Wznowienie: „o GG:MM” dziś, „DD.MM o GG:MM” innego dnia (czas polski). */
export function formatResumeAt(iso: string, now: Date): string {
  const at = warsawParts(iso);
  const today = warsawParts(now.toISOString());
  if (!at) return iso;
  if (today && at.day === today.day && at.month === today.month && at.year === today.year) return `o ${at.time}`;
  return `${at.day}.${at.month} o ${at.time}`;
}

/** Ostatnie pobranie: „DD.MM.RRRR, GG:MM” (jak w Skrzynce KSeF). */
export function formatLastFetch(iso: string): string {
  return formatWarsawDateTime(iso);
}

export const SECTION_TITLES: Readonly<Record<KsefHistoryDirection, string>> = {
  outgoing: 'Sprzedaż',
  incoming: 'Zakupy',
};

export const SETTINGS_KSEF_HREF = '/settings/ksef';
/** Ustawienia logowania dwuetapowego (TOTP) — tam właściciel je włącza. */
export const SECURITY_SETTINGS_HREF = '/settings/security';

// ---------------------------------------------------------------------------
// Certyfikat, plakietka i stany całej karty
// ---------------------------------------------------------------------------

/**
 * Stan certyfikatu dla pobierania historii (poprawka po przeglądzie, decyzja
 * Bartosza 22.10.2026). Cron pobiera historię tylko firmom z certyfikatem
 * POTWIERDZONYM dla skonfigurowanego środowiska KSeF (`ksef_verified_at`
 * + `ksef_verified_environment`, `hasConfiguredKsefProof`). Sam znacznik
 * `has_ksef_credentials` nie wystarcza: stary certyfikat bez potwierdzenia
 * (kwarantanna z 00117) albo potwierdzony w innym środowisku nigdy nie
 * dostanie strumienia — wtedy prosimy o ponowne wgranie, a nie obiecujemy
 * „zaczniemy w ciągu 30 minut”.
 */
export type CertificateState = 'missing' | 'unconfirmed' | 'ready';

export function certificateState(hasCertificate: boolean, certificateConfirmed: boolean): CertificateState {
  if (!hasCertificate) return 'missing';
  return certificateConfirmed ? 'ready' : 'unconfirmed';
}

/**
 * Błędy, które naprawia klient (nowy certyfikat albo uprawnienie w KSeF).
 * Runner nie woła wtedy KSeF wcale, cron nie zleca pobierania przy wygasłym
 * certyfikacie — pobieranie stoi, dopóki klient czegoś nie zrobi.
 */
const CLIENT_FIXABLE_ERRORS: ReadonlySet<KsefHistoryErrorCode> = new Set(['credentials', 'certificate_expired', 'permission']);

export function needsClientAction(status: KsefHistorySyncStatus | null): boolean {
  return Boolean(status?.error && CLIENT_FIXABLE_ERRORS.has(status.error.code));
}

export type HistoryBadge = {
  label: 'Automatycznie' | 'Wymaga certyfikatu' | 'Wymaga działania' | 'Wstrzymane';
  tone: 'ok' | 'wait' | 'muted';
};

export function historyBadge(certificate: CertificateState, status: KsefHistorySyncStatus | null): HistoryBadge {
  if (certificate !== 'ready') return { label: 'Wymaga certyfikatu', tone: 'wait' };
  // Błąd certyfikatu przed wstrzymaniem: bez nowego certyfikatu nie ruszy nic, także po wznowieniu.
  if (needsClientAction(status)) return { label: 'Wymaga działania', tone: 'wait' };
  if (status?.clientPausedAt) return { label: 'Wstrzymane', tone: 'muted' };
  return { label: 'Automatycznie', tone: 'ok' };
}

export const NO_CERTIFICATE_TEXT = 'Wgraj certyfikat KSeF — całą historię sprzedaży i zakupów pobierzemy sami.';
export const UNCONFIRMED_CERTIFICATE_TEXT =
  'Certyfikat KSeF wymaga ponownego potwierdzenia. Wgraj go jeszcze raz — wtedy zaczniemy pobierać historię faktur z KSeF.';
export const READ_FAILURE_TEXT = 'Nie udało się wczytać stanu pobierania z KSeF.';
export const STUCK_TEXT = 'Pobieranie historii stoi. Dostaliśmy alarm i to sprawdzamy — nic nie musisz robić.';
export const RECEIVABLES_NOTE =
  'Faktur wystawionych poza FaktWay nie liczymy w należnościach i nie wysyłamy do nich przypomnień o płatności.';

/**
 * Wynik nieudanej zmiany wstrzymania (parametr `?wstrzymanie=`): `failed` —
 * odmowa albo błąd zapisu („spróbuj ponownie”); `mfa` — właściciel bez
 * potwierdzonego logowania dwuetapowego (poprawka po przeglądzie, decyzja
 * Bartosza 22.10.2026: ponawianie nic by nie dało, więc mówimy, co włączyć).
 */
export type PauseError = 'failed' | 'mfa';

export function pauseErrorFromParam(value: string | string[] | undefined): PauseError | null {
  if (value === 'blad') return 'failed';
  if (value === '2fa') return 'mfa';
  return null;
}

export const PAUSE_ERROR_TEXT = 'Nie udało się zmienić ustawienia — spróbuj ponownie.';
export const PAUSE_MFA_TEXT = 'Przed wstrzymaniem albo wznowieniem pobierania włącz i potwierdź logowanie dwuetapowe.';

/** Pobrane faktury (bez naprawionych) w obu kierunkach. */
export function importedTotal(status: KsefHistorySyncStatus): number {
  return status.outgoing.counts.imported + status.incoming.counts.imported;
}

/** Bez certyfikatu: ile pobraliśmy do tej pory (tylko gdy cokolwiek). */
export function importedSoFarText(status: KsefHistorySyncStatus | null): string | null {
  if (!status) return null;
  const total = importedTotal(status);
  return total > 0 ? `Do tej pory pobraliśmy ${invoiceCount(total)}.` : null;
}

// ---------------------------------------------------------------------------
// Sekcje „Sprzedaż” i „Zakupy”
// ---------------------------------------------------------------------------

const ONE_HOUR_MS = 60 * 60 * 1000;

/** Faktury, które jeszcze nie są ani pobrane, ani odłożone na stałe. */
export function remainingCount(stream: KsefHistoryStreamStatus): number {
  return stream.counts.pending + stream.counts.deferred;
}

/**
 * Główne zdania sekcji dla fazy kierunku. `outgoingEnabledAt` — kiedy
 * powstała synchronizacja sprzedaży (zakupy czekają na Skrzynkę KSeF).
 * `paused` — klient wstrzymał pobieranie; `blocked` — pobieranie stoi przez
 * błąd certyfikatu, który naprawia klient (`needsClientAction`). W obu
 * przypadkach zostają same fakty: bez „szukamy dalej”, „pobieramy” i obietnic.
 */
export function phaseLines(
  stream: KsefHistoryStreamStatus,
  opts: { outgoingEnabledAt: string | null; paused: boolean; blocked: boolean; now: Date },
): string[] {
  const { paused, blocked, now } = opts;
  const stopped = paused || blocked;
  const outgoing = stream.direction === 'outgoing';

  if (stream.capacityReached) {
    return [
      `Twoja historia w KSeF jest bardzo duża — pobraliśmy ${invoiceCount(stream.counts.imported, [
        'najnowszą fakturę',
        'najnowsze faktury',
        'najnowszych faktur',
      ])}. Po starsze napisz na ${SUPPORT_EMAIL}.`,
    ];
  }

  switch (stream.phase) {
    case 'waiting': {
      if (paused) return ['Pobieranie wstrzymane.'];
      if (outgoing) {
        return blocked
          ? ['Zaczniemy, gdy rozwiążesz problem z certyfikatem opisany wyżej.']
          : ['Zaczniemy w ciągu 30 minut od wgrania certyfikatu.'];
      }
      const lines = ['Zaczniemy po pierwszym pobraniu Skrzynki KSeF.'];
      // Skrzynka łączy się tym samym certyfikatem — przy jego błędzie nie mówimy „sprawdzamy to”.
      if (blocked) return lines;
      const enabled = opts.outgoingEnabledAt ? Date.parse(opts.outgoingEnabledAt) : Number.NaN;
      if (Number.isFinite(enabled) && now.getTime() - enabled > ONE_HOUR_MS) {
        lines.push('Skrzynka KSeF jeszcze się nie połączyła — sprawdzamy to, nic nie musisz robić.');
      }
      return lines;
    }
    case 'searching': {
      const searched = stream.coveredFrom
        ? `Przeszukaliśmy KSeF od ${formatHistoryDay(stream.coveredFrom)} do dziś.`
        : 'Przeszukujemy KSeF.';
      return stopped ? [searched] : [searched, 'Szukamy dalej wstecz.'];
    }
    case 'downloading':
      if (stopped) return ['Znaleźliśmy całą historię w KSeF.'];
      // Nic już nie czeka na pobranie, zostały tylko faktury odłożone (lista
      // niżej) — nie mówimy, że „pobieramy” (decyzja Bartosza 22.10.2026).
      if (stream.counts.pending === 0) {
        return [`Pobraliśmy całą historię z KSeF poza ${invoiceCount(stream.counts.deferred)} do wyjaśnienia.`];
      }
      return [`Znaleźliśmy całą historię w KSeF — pobieramy jeszcze ${invoiceCount(remainingCount(stream))}.`];
    case 'live':
    case 'done':
      if (outgoing) {
        return stopped
          ? ['Cała historia sprzedaży pobrana.']
          : [
              'Cała historia sprzedaży pobrana. Nowe faktury wystawione poza FaktWay pobieramy automatycznie, zwykle w ciągu godziny.',
            ];
      }
      // Przy błędzie certyfikatu Skrzynka KSeF też się nie połączy — bez obietnicy „co 15 minut”.
      if (blocked) {
        return ['Historia zakupów pobrana. Faktury z historii zapisujemy jako archiwum — nie dodajemy ich do kosztów.'];
      }
      // Skrzynka KSeF działa także przy wstrzymanej historii — zdanie zostaje prawdziwe.
      return [
        'Historia zakupów pobrana. Nowe faktury zakupowe trafiają do Skrzynki KSeF co 15 minut. Faktury z historii zapisujemy jako archiwum — nie dodajemy ich do kosztów.',
      ];
    default:
      return [];
  }
}

export interface ProgressInfo {
  imported: number;
  total: number;
  percent: number;
  label: string;
}

/** „Pobrano X z Y faktur” (w trakcie szukania: „z co najmniej Y”); brak, gdy nic nie znaleźliśmy. */
export function progressInfo(stream: KsefHistoryStreamStatus): ProgressInfo | null {
  const imported = stream.counts.imported;
  const total = imported + remainingCount(stream);
  if (total <= 0) return null;
  const atLeast = stream.phase === 'searching' ? 'co najmniej ' : '';
  // Dopełniacz po „z”: „z 1 faktury”, „z 2 faktur”, „z 5 faktur”.
  const noun = total === 1 ? 'faktury' : 'faktur';
  return {
    imported,
    total,
    percent: Math.min(100, Math.max(0, Math.round((imported / total) * 100))),
    label: `Pobrano ${formatPlInt(imported)} z ${atLeast}${formatPlInt(total)} ${noun}`,
  };
}

/**
 * Tempo i szacowany koniec — tylko w trakcie szukania i pobierania, nigdy
 * gdy pobieranie stoi (`stopped`: wstrzymanie klienta albo błąd certyfikatu).
 * Koniec podaje stan dopiero po przeszukaniu całej historii (faza
 * „downloading”) i z tempa zmierzonego w ostatnich godzinach.
 */
export function rateLines(stream: KsefHistoryStreamStatus, stopped: boolean): string[] {
  if (stopped || (stream.phase !== 'searching' && stream.phase !== 'downloading')) return [];
  // Same faktury odłożone: tempo i szacowany koniec nic nie znaczą.
  if (stream.phase === 'downloading' && stream.counts.pending === 0) return [];
  const lines: string[] = [];
  if (stream.measuredPerHour !== null && stream.measuredPerHour >= 1) {
    lines.push(`Pobieramy ok. ${invoiceCount(stream.measuredPerHour)} na godzinę, żeby nie przekroczyć limitów KSeF.`);
    if (stream.estimatedFinishAt) lines.push(`Szacowany koniec: ${formatDayAt(stream.estimatedFinishAt)}.`);
    if (stream.phase === 'searching') lines.push('Koniec oszacujemy, gdy przeszukamy całą historię.');
  } else if (stream.counts.pending > 0) {
    lines.push('Pobieramy faktury powoli, żeby nie przekroczyć limitów KSeF.');
  }
  return lines;
}

/** Sprzedaż z KSeF spoza FaktWay nie trafia do należności — mówimy to wprost. */
export function showsReceivablesNote(stream: KsefHistoryStreamStatus): boolean {
  return stream.direction === 'outgoing' && stream.counts.imported > 0;
}

// ---------------------------------------------------------------------------
// Komunikaty całej firmy: tempo KSeF, błędy, wstrzymanie, eksport
// ---------------------------------------------------------------------------

export function rateLimitText(rateLimitedUntil: string | null, now: Date): string | null {
  if (!rateLimitedUntil) return null;
  const until = Date.parse(rateLimitedUntil);
  if (!Number.isFinite(until) || until <= now.getTime()) return null;
  return `KSeF ograniczył tempo pobierania. Wznowimy ${formatResumeAt(rateLimitedUntil, now)}.`;
}

export interface ErrorMessage {
  text: string;
  /** Klient naprawi to sam w ustawieniach KSeF (link). */
  settingsLink: boolean;
  tone: 'destructive' | 'warning';
}

export function errorMessage(error: KsefHistorySyncStatus['error']): ErrorMessage | null {
  if (!error) return null;
  const code: KsefHistoryErrorCode = error.code;
  switch (code) {
    case 'credentials':
      return {
        text: 'KSeF nie przyjął certyfikatu. Wgraj aktualny certyfikat — pobieranie wznowi się samo.',
        settingsLink: true,
        tone: 'destructive',
      };
    case 'certificate_expired':
      return {
        text: error.certificateExpiry
          ? `Certyfikat KSeF wygasł ${formatHistoryDay(error.certificateExpiry)}. Wgraj nowy — pobieranie wznowi się samo.`
          : 'Certyfikat KSeF wygasł. Wgraj nowy — pobieranie wznowi się samo.',
        settingsLink: true,
        tone: 'destructive',
      };
    case 'permission':
      return {
        text: 'Certyfikat nie ma uprawnienia do przeglądania faktur w KSeF. Nadaj je w Aplikacji Podatnika KSeF albo wgraj certyfikat właściciela.',
        settingsLink: true,
        tone: 'destructive',
      };
    case 'ksef_unavailable':
      return { text: 'KSeF chwilowo nie odpowiada. Ponowimy automatycznie.', settingsLink: false, tone: 'warning' };
    case 'internal':
      return { text: STUCK_TEXT, settingsLink: false, tone: 'warning' };
    default:
      return null;
  }
}

/**
 * Wstrzymanie przez klienta. Zdanie „wysyłka i Skrzynka działają” tylko bez
 * błędu certyfikatu — z odrzuconym albo wygasłym certyfikatem nie działają
 * (poprawka po przeglądzie, decyzja Bartosza 22.10.2026).
 */
export function pausedText(clientPausedAt: string, blocked = false): string {
  const paused = `Pobieranie historii wstrzymane ${formatHistoryDay(clientPausedAt)}.`;
  return blocked ? paused : `${paused} Wysyłka faktur z FaktWay i Skrzynka KSeF działają bez zmian.`;
}

/** „10.2026 (3)” z okresu „2026-10”. */
function periodLabel(period: string, count: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  return `${match ? `${match[2]}.${match[1]}` : period} (${formatPlInt(count)})`;
}

export interface ExportNotice {
  periods: string;
  lead: string;
  regenerate: string;
  rest: string;
}

/** Okresy, za które po eksporcie doszły faktury z historii KSeF (najnowsze pierwsze). */
export function exportNotice(periods: KsefHistorySyncStatus['periodsChangedAfterExport']): ExportNotice | null {
  if (periods.length === 0) return null;
  const list = periods.map((p) => periodLabel(p.period, p.count)).join(', ');
  return {
    periods: list,
    lead: `Po Twoim eksporcie doszły faktury z KSeF za okresy: ${list}. `,
    regenerate: 'Wygeneruj eksport ponownie',
    rest: '; jeśli JPK za te okresy jest już wysłany, sprawdź z księgowym, czy potrzebna jest korekta.',
  };
}

// ---------------------------------------------------------------------------
// Listy: odłożone i niepobrane faktury
// ---------------------------------------------------------------------------

export interface ReasonText {
  text: string;
  /** Dokument w FaktWay, który klient może otworzyć. */
  invoiceHref: string | null;
  /** Zdanie kończy się adresem pomocy (link `mailto:`). */
  mentionsSupport: boolean;
}

const invoiceHref = (id: string | null) => (id ? `/invoices/${encodeURIComponent(id)}` : null);

export function deferredReasonText(item: KsefHistoryDeferredItem): ReasonText {
  if (item.reason === 'duplicate_decision') {
    return {
      text: 'Ta faktura jest w KSeF, a w FaktWay czeka na Twoją decyzję przy duplikacie.',
      invoiceHref: invoiceHref(item.localInvoiceId),
      mentionsSupport: false,
    };
  }
  return {
    text: 'To prawdopodobnie faktura wysłana właśnie z FaktWay — sprawdzimy ją ponownie za godzinę.',
    invoiceHref: null,
    mentionsSupport: false,
  };
}

export function blockedReasonText(item: KsefHistoryBlockedItem): ReasonText {
  switch (item.reason) {
    case 'currency_not_supported':
      return {
        text: `Faktura w walucie ${item.currency?.trim() || 'obcej'}. FaktWay nie przenosi jeszcze z KSeF faktur walutowych — oryginał zostaje w KSeF.`,
        invoiceHref: null,
        mentionsSupport: false,
      };
    // ZAP-01: także szkic z importu pliku (CSV/JPK) — ma ten sam numer, ale nie liczy się w księgach.
    // Bez „zmień numer”: szkicu nie da się edytować (brak trasy edycji), wyjściem jest usunięcie.
    case 'number_conflict':
      return {
        text: `W FaktWay jest szkic o numerze ${item.invoiceNumber}, np. z importu pliku. Szkic nie liczy się w przychodzie ani w KPiR — usuń go, a pobierzemy oryginał z KSeF sami.`,
        invoiceHref: invoiceHref(item.localInvoiceId),
        mentionsSupport: false,
      };
    case 'file_import_mismatch':
      return {
        text: `W FaktWay jest faktura ${item.invoiceNumber} przeniesiona z pliku, ale z innymi danymi niż w KSeF (kontrahent, data albo kwota). Sprawdzamy to — nie zmieniaj jej.`,
        invoiceHref: invoiceHref(item.localInvoiceId),
        mentionsSupport: false,
      };
    case 'number_taken_local':
      return {
        text: `W FaktWay jest już dokument o numerze ${item.invoiceNumber} z innym numerem KSeF. Nie zmieniaj go — sprawdzamy to.`,
        invoiceHref: invoiceHref(item.localInvoiceId),
        mentionsSupport: false,
      };
    case 'own_send_unresolved':
      return {
        text: 'To prawdopodobnie faktura wysłana z FaktWay, której wynik jeszcze uzgadniamy. Nie wystawiaj jej ponownie.',
        invoiceHref: null,
        mentionsSupport: false,
      };
    default:
      return {
        text: `Nie udało się jej zapisać. Sprawdzamy to — jeśli potrzebujesz jej pilnie, napisz na ${SUPPORT_EMAIL}.`,
        invoiceHref: null,
        mentionsSupport: true,
      };
  }
}

/** Numer · data · kontrahent · kwota — wiersz listy odłożonych i niepobranych. */
export function itemMeta(item: KsefHistoryBlockedItem | KsefHistoryDeferredItem): string {
  const parts = [formatInvoiceDay(item.issueDate)];
  if (item.counterpartyName?.trim()) parts.push(item.counterpartyName.trim());
  if (item.grossAmount !== null && Number.isFinite(item.grossAmount)) {
    const currency = item.currency?.trim();
    parts.push(`${formatPlMoney(item.grossAmount)}${currency ? ` ${currency === 'PLN' ? 'zł' : currency}` : ''}`);
  }
  parts.push(item.direction === 'outgoing' ? 'sprzedaż' : 'zakup');
  return parts.join(' · ');
}

/** „Pokazujemy 20 z 57.” — lista jest ucięta do ostatnio zmienionych. */
export function listCapNote(shown: number, total: number): string | null {
  return total > shown ? `Pokazujemy ${formatPlInt(shown)} ostatnio sprawdzanych z ${formatPlInt(total)}.` : null;
}

/** Oryginały z numerem zajętym przez dokument wycofany przy duplikacie (440). */
export function retiredDraftLine(status: KsefHistorySyncStatus): string | null {
  const n = status.outgoing.counts.retiredDraft + status.incoming.counts.retiredDraft;
  if (n <= 0) return null;
  const subject = invoiceCount(n, FAKTURA);
  const verb = plural(n, ['ma', 'mają', 'ma']);
  const pronoun = n === 1 ? 'jej' : 'ich';
  return `${subject} z KSeF ${verb} numer zajęty przez dokument wycofany przy duplikacie — nie przenosimy ${pronoun}, żeby nie zdublować sprzedaży.`;
}
