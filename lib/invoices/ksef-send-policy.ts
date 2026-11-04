/**
 * Co klient może zrobić z fakturą po nieudanej wysyłce (cykl życia faktury,
 * PR 3b — K3 z rewizji 03.10.2026, decyzje D2 i D4). Jedna tabela decyzji
 * dla akcji serwerowych (`actions-detail.ts`) i przycisków (`failed-invoice-
 * actions.tsx`), żeby interfejs nie pokazywał przycisku, którego akcja odmówi.
 *
 * CZYSTY moduł (importowany w komponencie klienckim i w workerze): katalog
 * klas z `send-error-classes.ts`, adres pomocy z `lib/site.ts` i TYP faktów
 * ponowienia. RPC z 00131 sprawdzają to samo po stronie bazy — ta tabela
 * jest pierwszą linią, nie jedyną.
 *
 * Dokumenty specjalne (A4b PR2b): korektę, zaliczkę i fakturę rozliczeniową
 * wysyłamy ponownie z kopii na wierszu (ZAL `fa3_data.advanceEnvelope`,
 * KOR/ROZ `special_data`) — tylko w dniu wystawienia (decyzja Bartosza
 * 06.10.2026 b; po północy worker odmawia sam, 00147). KOR_HOLD
 * i ROZ_HOLD_RECONCILE nie mają przycisków klienta (decyzja a), a teksty mówią
 * prawdę: automat ich nie wznowi (decyzje 07.10.2026). Kolejność blokad
 * klienta: rodzaj wstrzymany → brak danych → data — inaczej niż builder
 * i operator (dane → rodzaj → data), celowo: starej korekcie na PROD ani
 * staremu ROZ nie wolno kazać „wystaw od nowa”, bo kolejkowanie odmówiłoby
 * też nowemu dokumentowi.
 *
 * D-A4-1b-3 PR B: `KSEF_DUPLICATE_RECONCILE` ma wyjście klienta (panel decyzji)
 * — tekst bez operatora; szkic po „numer zajęty” jest wycofany (00148), więc
 * teksty KSEF_NUMBER_TAKEN nie każą usuwać zwykłej faktury ani zaliczki, a korekcie
 * i fakturze rozliczeniowej każą (decyzja 9 — usunięcie to ich wyjście).
 */

import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import { isAutoRequeueable, SEND_ERROR_CODES, sendErrorClassOf, type SendErrorClass } from '@/lib/ksef/send-error-classes';
import { SUPPORT_EMAIL } from '@/lib/site';

/** Role, które uruchamiają ponowną wysyłkę i powrót do szkicu (D4). */
export const KSEF_SEND_MANAGER_ROLES: readonly string[] = ['owner', 'admin'];

export function canManageKsefSend(role: string | null | undefined): boolean {
  return typeof role === 'string' && KSEF_SEND_MANAGER_ROLES.includes(role);
}

export const KSEF_SEND_MESSAGES = {
  role: 'Ponowną wysyłkę i powrót do szkicu może uruchomić właściciel lub administrator firmy.',
  direction: 'Ponownie wysłać można tylko fakturę wystawioną w FaktWay.',
  status: 'Ponowną wysyłkę można uruchomić tylko dla faktury z błędem wysyłki.',
  rejected: 'KSeF odrzucił treść tej faktury — wróć do szkicu, popraw i wyślij ponownie.',
  terminal: 'Dokument nie przeszedł kontroli treści — wróć do szkicu i popraw.',
  reconcile: 'Ta faktura wymaga uzgodnienia z KSeF — zajmuje się tym operator FaktWay. Nie wysyłaj jej ponownie.',
  hold: 'Wysyłka jest wstrzymana przez operatora. Faktura wyjdzie automatycznie po przywróceniu wysyłki.',
  korHold: `Wysyłka korekt do KSeF jest wstrzymana przez FaktWay do czasu poprawki ich kwot — tej korekty teraz nie wyślemy, a po zdjęciu blokady sami jej nie wyślemy. Nie wystawiaj nowej korekty na własną rękę — napisz do pomocy FaktWay (${SUPPORT_EMAIL}), podając numer korekty. Jeśli żadna próba nie dotarła do KSeF, cofniemy ją do szkicu (wtedy usuń szkic i po zdjęciu blokady wystaw korektę od nowa); jeśli mogła dotrzeć — korekta poczeka na zdjęcie blokady.`,
  rozHold: `Wysyłka faktur rozliczeniowych do KSeF jest wstrzymana przez FaktWay do czasu pewnego rozliczania zaliczek — tej faktury teraz nie wyślemy, a po zdjęciu blokady sami jej nie wyślemy. Nie wystawiaj nowej faktury rozliczeniowej na własną rękę — napisz do pomocy FaktWay (${SUPPORT_EMAIL}), podając numer faktury. Jeśli żadna próba nie dotarła do KSeF, cofniemy ją do szkicu (wtedy usuń szkic i po zdjęciu blokady wystaw fakturę rozliczeniową od nowa); jeśli mogła dotrzeć — faktura poczeka na zdjęcie blokady.`,
  incomplete: 'Faktura nie ma kompletnych danych do wysyłki — nie wyślemy jej ponownie. Wróć do szkicu, usuń go i wystaw fakturę od nowa.',
  transient: 'Błąd po stronie KSeF albo FaktWay — wysyłkę ponowimy automatycznie. Możesz też wysłać teraz.',
  transientManual: `Błąd po stronie KSeF albo FaktWay — tej wysyłki nie ponowimy automatycznie. Wyślij ponownie albo wróć do szkicu; jeśli błąd się powtarza, napisz do pomocy FaktWay (${SUPPORT_EMAIL}).`,
  envUnknown: `Nie możemy teraz potwierdzić środowiska KSeF po stronie FaktWay — tej faktury teraz nie wyślemy. Odśwież stronę za kilka minut; jeśli komunikat się powtarza, napisz do pomocy FaktWay (${SUPPORT_EMAIL}).`,
  setup: 'Brak zweryfikowanego certyfikatu KSeF — uzupełnij ustawienia KSeF, potem wyślij ponownie.',
  notInKsef: 'KSeF nie ma tej faktury — poprzednia wysyłka do niego nie dotarła. Wyślij ją ponownie albo wróć do szkicu.',
  issueDatePassed: `Tej wysyłki nie wykonaliśmy: dokument ma datę wystawienia sprzed dzisiaj, a w KSeF dokument wystawia się w dniu wysyłki (szczegóły wyżej). Wróć do szkicu, usuń go i wystaw dokument od nowa z dzisiejszą datą. Jeśli powrót do szkicu jest zablokowany, wcześniejsza próba mogła dotrzeć do KSeF: nie wystawiaj dokumentu ponownie i napisz do pomocy FaktWay (${SUPPORT_EMAIL}) — sprawdzimy go w KSeF.`,
  envMismatch: `Tej wysyłki nie wykonaliśmy: zlecenie dotyczyło innego środowiska KSeF (testowego albo produkcyjnego) niż obecne ustawienie FaktWay — szczegóły wyżej. Wróć do szkicu i zdecyduj, czy wysłać fakturę w obecnym środowisku. Jeśli powrót do szkicu jest zablokowany, wcześniejsza próba mogła dotrzeć do KSeF: nie wystawiaj tej faktury ponownie i napisz do pomocy FaktWay (${SUPPORT_EMAIL}) — sprawdzimy ją w KSeF.`,
  // D-A4-1b-3 PR B (decyzje Bartosza 07.10.2026 (3) i (9)): szkic po „numer zajęty” jest wycofany —
  // nie wyślesz go, a zwykłej faktury i zaliczki nie usuniesz (00148), więc tekst nie każe „usuń go”.
  numberTaken: 'W KSeF jest już faktura Twojej firmy o tym numerze, wystawiona w innym programie (szczegóły wyżej). Tego dokumentu nie wyślesz do KSeF. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie. Jeśli inna — wystaw ją jako nową fakturę z nowym numerem.',
  /** Toast po „Wróć do szkicu” przy `KSEF_NUMBER_TAKEN` — zwykła faktura (dokumenty specjalne: `KSEF_SPECIAL_SEND_MESSAGES`). */
  numberTakenResetDone: 'Dokument wrócił do szkicu jako wycofany: numer jest zajęty w KSeF, więc tego szkicu nie wyślesz ani nie usuniesz. Jeśli to inna sprzedaż, wystaw ją jako nową fakturę z nowym numerem.',
  /**
   * `KSEF_DUPLICATE_RECONCILE` (D-A4-1b-3 PR B, reguła 07.10.2026): duplikat 440 ma wyjście klienta
   * (panel decyzji na karcie faktury) albo adres pomocy — bez odsyłania do operatora. Pozostałe kody
   * klasy reconcile zostają przy `reconcile` (§7 p. 17 specyfikacji PR B).
   */
  duplicate: `KSeF ma już fakturę o tym numerze — tej faktury nie wysyłaj ponownie. Szczegóły są na karcie faktury; pytania: pomoc FaktWay (${SUPPORT_EMAIL}), podaj numer faktury.`,
  /** To samo, gdy nad paskiem stoi panel decyzji (ramka „W KSeF jest już faktura o tym numerze”). */
  duplicatePanel: 'KSeF ma już fakturę o tym numerze — szczegóły i dalsze kroki są wyżej, w ramce „W KSeF jest już faktura o tym numerze”. Nie wysyłaj tej faktury ponownie.',
  historical: 'Wysyłka nie powiodła się. Możesz wysłać ponownie albo wrócić do szkicu.',
  askManager: 'Poproś właściciela lub administratora firmy.',
  resetDone: 'Faktura wróciła do szkicu. Popraw ją i wyślij ponownie.',
  resetFailed: 'Nie udało się przywrócić szkicu. Spróbuj ponownie.',
  notFound: 'Nie można znaleźć faktury w tej organizacji.',
} as const;

type SpecialKind = 'correction' | 'advance' | 'final';

/** Odmiana nazw dokumentów specjalnych (wszystkie rodzaju żeńskiego). */
const KIND_LABEL: Record<SpecialKind, { N: string; T: string; L: string; A: string; G: string }> = {
  correction: { N: 'Korekta', T: 'Ta korekta', L: 'ta korekta', A: 'korektę', G: 'korekty' },
  advance: { N: 'Faktura zaliczkowa', T: 'Ta faktura zaliczkowa', L: 'ta faktura zaliczkowa', A: 'fakturę zaliczkową', G: 'faktury zaliczkowej' },
  final: { N: 'Faktura rozliczeniowa', T: 'Ta faktura rozliczeniowa', L: 'ta faktura rozliczeniowa', A: 'fakturę rozliczeniową', G: 'faktury rozliczeniowej' },
};

/**
 * Ta sama odmiana dla tekstów szkicu wycofanego (`lib/ksef/duplicate-decision.ts`,
 * D-A4-1b-3 PR B): N — mianownik, T/L — „Ta …”/„ta …”, A — biernik, G — dopełniacz.
 * Ten moduł nie importuje `duplicate-decision.ts` (bez cyklu).
 */
export const SPECIAL_KIND_LABEL: Readonly<Record<SpecialKind, Readonly<{ N: string; T: string; L: string; A: string; G: string }>>> = KIND_LABEL;

/** Rodzaj dokumentu specjalnego; `null` dla zwykłej faktury i rodzaju nieznanego (fakty: brak danych). */
export function specialKindOf(kind: string | null): SpecialKind | null {
  return kind === 'correction' || kind === 'advance' || kind === 'final' ? kind : null;
}

const sendToday = (k: SpecialKind) => {
  const l = KIND_LABEL[k];
  return `${l.T} może wyjść do KSeF tylko dziś, w dniu wystawienia — po północy jej nie wyślemy. Szkicu ${l.G} nie wyślesz: jeśli wrócisz do szkicu, usuń go i wystaw ${l.A} od nowa.`;
};

const issueDatePassedSpecial = (k: SpecialKind) => {
  const l = KIND_LABEL[k];
  return `${l.T} ma datę wystawienia sprzed dzisiaj, a w KSeF dokument wystawia się w dniu wysyłki — nie wyślemy jej ponownie i nie ponowimy automatycznie. Wróć do szkicu, usuń go i wystaw ${l.A} od nowa z dzisiejszą datą. Jeśli powrót do szkicu jest zablokowany, wcześniejsza próba mogła dotrzeć do KSeF: nie wystawiaj ${l.G} ponownie i napisz do pomocy FaktWay (${SUPPORT_EMAIL}) — sprawdzimy ją w KSeF.`;
};

/** Hamulec rodzaju w tym środowisku — nowego dokumentu kolejkowanie i tak by nie wysłało. */
const KIND_BRAKE: Record<SpecialKind, string> = {
  correction: 'wysyłka korekt do produkcyjnego KSeF jest wstrzymana przez FaktWay do czasu poprawki ich kwot',
  final: 'wysyłka faktur rozliczeniowych do KSeF jest wstrzymana przez FaktWay do czasu pewnego rozliczania zaliczek',
  // Zaliczka jest „wstrzymana” tylko przy nieznanym środowisku (wtedy ta gałąź nie jest używana).
  advance: 'nie możemy teraz potwierdzić środowiska KSeF po stronie FaktWay',
};

/** Rodzaj wstrzymany: szkic tak, nowy dokument dopiero po zdjęciu blokady. */
const heldNote = (k: SpecialKind) =>
  `Nowej ${KIND_LABEL[k].G} teraz nie wystawisz, bo ${KIND_BRAKE[k]} — po zdjęciu blokady usuń szkic i wystaw ${KIND_LABEL[k].A} od nowa (pytania: ${SUPPORT_EMAIL}).`;

/** Teksty dla korekty, zaliczki i faktury rozliczeniowej (A4b PR2b). */
export const KSEF_SPECIAL_SEND_MESSAGES = {
  rejected: (k: SpecialKind) =>
    `KSeF odrzucił treść ${KIND_LABEL[k].G} — wróć do szkicu, usuń go i wystaw ${KIND_LABEL[k].A} od nowa z poprawionymi danymi. Szkicu ${KIND_LABEL[k].G} nie wyślesz do KSeF.`,
  terminal: (k: SpecialKind) =>
    `${KIND_LABEL[k].T} nie przeszła kontroli treści — wróć do szkicu, usuń go i wystaw ${KIND_LABEL[k].A} od nowa z poprawionymi danymi. Szkicu ${KIND_LABEL[k].G} nie wyślesz do KSeF.`,
  envMismatchNote: (k: SpecialKind) =>
    `Szkicu ${KIND_LABEL[k].G} nie wyślesz do KSeF — jeśli zdecydujesz się ją wysłać, po powrocie do szkicu usuń go i wystaw ${KIND_LABEL[k].A} od nowa z dzisiejszą datą.`,
  issueDatePassed: issueDatePassedSpecial,
  issueDatePassedCode: (k: SpecialKind) => `Tej wysyłki nie wykonaliśmy (szczegóły wyżej). ${issueDatePassedSpecial(k)}`,
  // Rodzaj wstrzymany (KOR na PROD, ROZ): kolejkowanie odmówiłoby nowemu dokumentowi — „od nowa” tylko po zdjęciu blokady.
  heldNote,
  rejectedHeld: (k: SpecialKind) => `KSeF odrzucił treść ${KIND_LABEL[k].G} — możesz wrócić do szkicu. ${heldNote(k)}`,
  terminalHeld: (k: SpecialKind) => `${KIND_LABEL[k].T} nie przeszła kontroli treści — możesz wrócić do szkicu. ${heldNote(k)}`,
  issueDatePassedCodeHeld: (k: SpecialKind) =>
    `Tej wysyłki nie wykonaliśmy (szczegóły wyżej): ${KIND_LABEL[k].L} ma datę wystawienia sprzed dzisiaj, a w KSeF dokument wystawia się w dniu wysyłki. Możesz wrócić do szkicu. ${heldNote(k)} Jeśli powrót do szkicu jest zablokowany, wcześniejsza próba mogła dotrzeć do KSeF: nie wystawiaj ${KIND_LABEL[k].G} ponownie i napisz do pomocy FaktWay (${SUPPORT_EMAIL}) — sprawdzimy ją w KSeF.`,
  incomplete: (k: SpecialKind) =>
    `Nie mamy zapisanej kopii danych ${KIND_LABEL[k].G} potrzebnej do ponownej wysyłki — nie wyślemy jej ponownie i nie ponowimy automatycznie. Wróć do szkicu, usuń go i wystaw ${KIND_LABEL[k].A} od nowa z dzisiejszą datą. Jeśli powrót do szkicu jest zablokowany, wcześniejsza próba mogła dotrzeć do KSeF: nie wystawiaj ${KIND_LABEL[k].G} ponownie i napisz do pomocy FaktWay (${SUPPORT_EMAIL}) — sprawdzimy ją w KSeF.`,
  kindHeld: (k: SpecialKind): string => {
    if (k === 'correction') {
      return `Wysyłka korekt do produkcyjnego KSeF jest wstrzymana przez FaktWay do czasu poprawki ich kwot — tej korekty nie wyślemy ponownie i nie ponowimy automatycznie. Możesz wrócić do szkicu; szkicu korekty nie wyślesz, więc po zdjęciu blokady usuń go i wystaw korektę od nowa. Jeśli powrót do szkicu jest zablokowany, wcześniejsza próba mogła dotrzeć do KSeF: nie wystawiaj korekty ponownie — poczeka na zdjęcie blokady (pytania: ${SUPPORT_EMAIL}).`;
    }
    if (k === 'final') {
      return `Wysyłka faktur rozliczeniowych do KSeF jest wstrzymana przez FaktWay do czasu pewnego rozliczania zaliczek — tej faktury nie wyślemy ponownie i nie ponowimy automatycznie. Możesz wrócić do szkicu; szkicu faktury rozliczeniowej nie wyślesz, więc po zdjęciu blokady usuń go i wystaw fakturę rozliczeniową od nowa. Jeśli powrót do szkicu jest zablokowany, wcześniejsza próba mogła dotrzeć do KSeF: nie wystawiaj tej faktury ponownie — poczeka na zdjęcie blokady (pytania: ${SUPPORT_EMAIL}).`;
    }
    // Zaliczka jest wstrzymana tylko przy nieznanym środowisku (sprawdzane wcześniej).
    return KSEF_SEND_MESSAGES.envUnknown;
  },
  paused: (k: SpecialKind) =>
    `Wysyłka do KSeF jest wstrzymana przez operatora. ${KIND_LABEL[k].T} może wyjść do KSeF tylko dziś, w dniu wystawienia: jeśli wysyłka wróci przed północą, spróbujemy wysłać ją automatycznie. Jeśli nie wyjdzie do północy, wróć do szkicu, usuń go i wystaw ${KIND_LABEL[k].A} od nowa.`,
  sendToday,
  transient: (k: SpecialKind) =>
    `Błąd po stronie KSeF albo FaktWay — wysyłkę ponawiamy automatycznie mniej więcej co godzinę, ale tylko do północy. Możesz też wysłać teraz. ${sendToday(k)}`,
  resetDone: (k: SpecialKind) =>
    `${KIND_LABEL[k].N} wróciła do szkicu. Szkicu ${KIND_LABEL[k].G} nie wyślesz do KSeF — usuń go („Usuń szkic”) i wystaw ${KIND_LABEL[k].A} od nowa z dzisiejszą datą.`,
  resetDoneHeld: (k: SpecialKind) =>
    `${KIND_LABEL[k].N} wróciła do szkicu. Szkicu ${KIND_LABEL[k].G} nie wyślesz do KSeF — usuń go („Usuń szkic”), a po zdjęciu blokady wystaw ${KIND_LABEL[k].A} od nowa.`,
  // D-A4-1b-3 PR B (C4, decyzja 07.10.2026 (9)): „Wróć do szkicu” przy KSEF_NUMBER_TAKEN — szkic wycofany.
  // Zaliczki nie usuniesz (00148, jak zwykłej faktury); korektę i fakturę rozliczeniową usuwasz — to ich wyjście.
  numberTakenResetDone: (k: SpecialKind) =>
    `${KIND_LABEL[k].N} wróciła do szkicu jako wycofana: numer jest zajęty w KSeF, więc tego szkicu nie wyślesz ani nie usuniesz. Jeśli to inna sprzedaż, wystaw ${KIND_LABEL[k].A} od nowa z nowym numerem.`,
  numberTakenResetDoneDeletable: (k: SpecialKind) =>
    `${KIND_LABEL[k].N} wróciła do szkicu jako wycofana: numer jest zajęty w KSeF, więc tego szkicu nie wyślesz do KSeF. Jeśli w KSeF jest inny dokument, usuń szkic („Usuń szkic”) i wystaw ${KIND_LABEL[k].A} od nowa z nowym numerem.`,
  numberTakenResetDoneDeletableHeld: (k: SpecialKind) =>
    `${KIND_LABEL[k].N} wróciła do szkicu jako wycofana: numer jest zajęty w KSeF, więc tego szkicu nie wyślesz do KSeF. Jeśli w KSeF jest inny dokument, usuń szkic („Usuń szkic”), a po zdjęciu blokady wysyłki wystaw ${KIND_LABEL[k].A} od nowa z nowym numerem.`,
} as const;

/**
 * Toast po „Wróć do szkicu” — szkicu dokumentu specjalnego nie da się wysłać.
 * Przy `KSEF_NUMBER_TAKEN` szkic jest wycofany (wpis `number_taken`, 00148):
 * zwykłej faktury i zaliczki nie usuniesz, korektę i fakturę rozliczeniową tak
 * (C4, decyzja 07.10.2026 (9)). Inne kody — bez zmian.
 */
export function resetDoneMessage(invoiceKind: string | null, facts: KsefResendFacts, errorCode?: string | null): string {
  const k = specialKindOf(invoiceKind);
  const S = KSEF_SPECIAL_SEND_MESSAGES;
  if (errorCode === SEND_ERROR_CODES.KSEF_NUMBER_TAKEN) {
    if (!k) return KSEF_SEND_MESSAGES.numberTakenResetDone;
    if (k === 'advance') return S.numberTakenResetDone(k);
    return facts.kindHeld ? S.numberTakenResetDoneDeletableHeld(k) : S.numberTakenResetDoneDeletable(k);
  }
  if (!k) return KSEF_SEND_MESSAGES.resetDone;
  return facts.kindHeld ? S.resetDoneHeld(k) : S.resetDone(k);
}

type AuditKind = 'regular' | 'correction' | 'advance' | 'final';

/** Kolejkowanie w trybie ponowienia: wyłącznik operatora — faktura zostaje `failed`, nie szkicem. */
export function resendPausedMessage(kind: AuditKind): string {
  const k = specialKindOf(kind);
  if (!k) {
    return 'Wysyłka faktur do KSeF jest chwilowo wstrzymana przez operatora — tej wysyłki nie wykonaliśmy, faktura zostaje z błędem wysyłki. Wyślij ją ponownie, gdy wysyłka zostanie przywrócona.';
  }
  const l = KIND_LABEL[k];
  return `Wysyłka faktur do KSeF jest chwilowo wstrzymana przez operatora — tej wysyłki nie wykonaliśmy, ${l.L} zostaje z błędem wysyłki. Wyślij ją ponownie, gdy wysyłka zostanie przywrócona — z zapisanej kopii tylko dziś, w dniu wystawienia; później wróć do szkicu, usuń go i wystaw ${l.A} od nowa z dzisiejszą datą.`;
}

/** Kolejkowanie w trybie ponowienia: nie da się odczytać wyłącznika. */
export function resendPauseUnknownMessage(kind: AuditKind): string {
  const k = specialKindOf(kind);
  const l = k ? KIND_LABEL[k].L : 'faktura';
  return `Nie można sprawdzić, czy wysyłka do KSeF jest dostępna — tej wysyłki nie wykonaliśmy, ${l} zostaje z błędem wysyłki. Spróbuj ponownie za chwilę.`;
}

/** Kolejkowanie w trybie ponowienia: brak certyfikatu KSeF. */
export function resendMissingCredentialsMessage(kind: AuditKind): string {
  const k = specialKindOf(kind);
  if (!k) {
    return 'Brak certyfikatu KSeF — tej wysyłki nie wykonaliśmy, faktura zostaje z błędem wysyłki. Wgraj certyfikat w Ustawieniach KSeF, potem wyślij fakturę ponownie.';
  }
  const l = KIND_LABEL[k];
  return `Brak certyfikatu KSeF — tej wysyłki nie wykonaliśmy, ${l.L} zostaje z błędem wysyłki. Wgraj certyfikat w Ustawieniach KSeF i wyślij ${l.A} ponownie dziś, w dniu wystawienia; później wróć do szkicu, usuń go i wystaw ${l.A} od nowa z dzisiejszą datą.`;
}

export type ResendRefusal =
  | 'direction'
  | 'status'
  | 'rejected'
  | 'terminal'
  | 'reconcile'
  | 'env-unknown'
  | 'hold'
  | 'incomplete'
  | 'kind-held'
  | 'issue-date';

export type ResendDecision =
  | { allowed: true; errorClass: SendErrorClass | null }
  | { allowed: false; reason: ResendRefusal; message: string };

export interface ResendInput {
  direction: string | null;
  status: string | null;
  errorCode: string | null;
  invoiceKind: string | null;
  /** Ponowienie z kopii: dane zapisane, rodzaj wstrzymany, data wystawienia minęła (A4b). */
  facts: KsefResendFacts;
  /** `KSEF_ENV` aplikacji poprawny — bez niego nic nie zlecamy. */
  environmentKnown: boolean;
}

/** Blokady wysyłki z kopii — kolejność klienta: rodzaj → dane → data. */
function sendBlocker(kind: SpecialKind | null, facts: KsefResendFacts): Extract<ResendDecision, { allowed: false }> | null {
  if (kind && facts.kindHeld) {
    return { allowed: false, reason: 'kind-held', message: KSEF_SPECIAL_SEND_MESSAGES.kindHeld(kind) };
  }
  if (facts.sendData === 'missing') {
    return {
      allowed: false,
      reason: 'incomplete',
      message: kind ? KSEF_SPECIAL_SEND_MESSAGES.incomplete(kind) : KSEF_SEND_MESSAGES.incomplete,
    };
  }
  if (kind && facts.issueDatePassed) {
    return { allowed: false, reason: 'issue-date', message: KSEF_SPECIAL_SEND_MESSAGES.issueDatePassed(kind) };
  }
  return null;
}

/**
 * Czy klient może uruchomić `requeue_ksef_send`. `rejected` nigdy (D2: wraca
 * do szkicu); `failed` wg klasy kodu: transient i setup tak, brak kodu
 * (historyczny) tak — decyduje człowiek, a runner i tak zaczyna od
 * uzgodnienia; terminal, hold i reconcile nie. Potem środowisko i fakty
 * ponowienia z kopii (dokumenty specjalne tylko w dniu wystawienia).
 */
export function decideResend(input: ResendInput): ResendDecision {
  const kind = specialKindOf(input.invoiceKind);
  const M = KSEF_SEND_MESSAGES;
  const S = KSEF_SPECIAL_SEND_MESSAGES;
  if (input.direction !== 'outgoing') {
    return { allowed: false, reason: 'direction', message: M.direction };
  }
  // Rodzaj wstrzymany w znanym środowisku: wszystkie teksty „wystaw od nowa” mówią „po zdjęciu blokady”.
  const held = kind !== null && input.environmentKnown && input.facts.kindHeld;
  if (input.status === 'rejected') {
    return {
      allowed: false,
      reason: 'rejected',
      message: kind ? (held ? S.rejectedHeld(kind) : S.rejected(kind)) : M.rejected,
    };
  }
  if (input.status !== 'failed') {
    return { allowed: false, reason: 'status', message: M.status };
  }
  const errorClass = sendErrorClassOf(input.errorCode);
  if (errorClass === 'terminal') {
    const message = input.errorCode === SEND_ERROR_CODES.ENV_MISMATCH
      ? (kind ? `${M.envMismatch} ${held ? S.heldNote(kind) : S.envMismatchNote(kind)}` : M.envMismatch)
      : input.errorCode === SEND_ERROR_CODES.ISSUE_DATE_PASSED
        ? (kind ? (held ? S.issueDatePassedCodeHeld(kind) : S.issueDatePassedCode(kind)) : M.issueDatePassed)
        : input.errorCode === SEND_ERROR_CODES.KSEF_NUMBER_TAKEN
          ? M.numberTaken
          : (kind ? (held ? S.terminalHeld(kind) : S.terminal(kind)) : M.terminal);
    return { allowed: false, reason: 'terminal', message };
  }
  if (errorClass === 'reconcile') {
    // Duplikat 440 ma wyjście klienta (panel decyzji, D-A4-1b-3 PR B); reszta klasy — operator (§7 p. 17).
    const message = input.errorCode === SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE ? M.duplicate : M.reconcile;
    return { allowed: false, reason: 'reconcile', message };
  }
  if (!input.environmentKnown) {
    return { allowed: false, reason: 'env-unknown', message: M.envUnknown };
  }
  if (errorClass === 'hold') {
    if (input.errorCode === SEND_ERROR_CODES.KOR_HOLD) return { allowed: false, reason: 'hold', message: M.korHold };
    if (input.errorCode === SEND_ERROR_CODES.ROZ_HOLD_RECONCILE) return { allowed: false, reason: 'hold', message: M.rozHold };
    // KSEF_PAUSED: automat (I7) wznowi tylko wiersz z danymi, niewstrzymany i — dokument specjalny — dziś.
    return sendBlocker(kind, input.facts)
      ?? { allowed: false, reason: 'hold', message: kind ? S.paused(kind) : M.hold };
  }
  return sendBlocker(kind, input.facts) ?? { allowed: true, errorClass };
}

/**
 * Czy automat (cron I6/I7) naprawdę ponowi tę fakturę — jedna definicja dla
 * tekstu nad przyciskami i znaczka statusu (decyzja Bartosza 07.10.2026).
 */
export function automaticResendExpected(input: {
  status: string | null;
  errorCode: string | null;
  invoiceKind: string | null;
  facts: KsefResendFacts;
  environmentKnown: boolean;
}): boolean {
  return input.status === 'failed'
    && input.environmentKnown
    && (isAutoRequeueable(input.errorCode) || input.errorCode === SEND_ERROR_CODES.KSEF_PAUSED)
    && input.facts.sendData === 'stored'
    && !input.facts.kindHeld
    && !(specialKindOf(input.invoiceKind) && input.facts.issueDatePassed);
}

export interface FailedInvoiceButtons {
  /** „Wyślij ponownie” — `requeue_ksef_send`. */
  resend: boolean;
  /** „Wróć do szkicu” — `reset_ksef_send`. */
  reset: boolean;
  /** Link do ustawień KSeF (brak certyfikatu). */
  settings: boolean;
  /** Zdanie nad przyciskami: co się stało i co dalej. */
  info: string;
}

export interface FailedInvoiceButtonsInput {
  status: string;
  errorCode: string | null;
  invoiceKind: string | null;
  /** Rola zalogowanej osoby w firmie dopuszcza akcje (D4). */
  canManage: boolean;
  facts: KsefResendFacts;
  environmentKnown: boolean;
  /**
   * `KSEF_DUPLICATE_RECONCILE`: nad paskiem stoi panel duplikatu (decyzja albo
   * notatka z danymi oryginału) — zdanie odsyła do ramki wyżej (D-A4-1b-3 PR B).
   */
  duplicatePanel?: boolean;
}

/** Odmowy, przy których klient może wrócić do szkicu. */
const RESET_REFUSALS: readonly ResendRefusal[] = ['rejected', 'terminal', 'incomplete', 'kind-held', 'issue-date'];

/** Tabela z sekcji 7 projektu cyklu życia; `null` = stan bez przycisków błędu. */
export function failedInvoiceButtons(input: FailedInvoiceButtonsInput): FailedInvoiceButtons | null {
  if (input.status !== 'failed' && input.status !== 'rejected') return null;
  const kind = specialKindOf(input.invoiceKind);
  const decision = decideResend({
    direction: 'outgoing',
    status: input.status,
    errorCode: input.errorCode,
    invoiceKind: input.invoiceKind,
    facts: input.facts,
    environmentKnown: input.environmentKnown,
  });
  const errorClass = sendErrorClassOf(input.errorCode);

  let resend = decision.allowed;
  let reset: boolean;
  let settings = false;
  let info: string;

  if (!decision.allowed) {
    reset = RESET_REFUSALS.includes(decision.reason);
    info = input.errorCode === SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE && input.duplicatePanel
      ? KSEF_SEND_MESSAGES.duplicatePanel
      : decision.message;
  } else {
    reset = true;
    settings = errorClass === 'setup';
    const automat = automaticResendExpected({ ...input, status: input.status });
    // NOT_IN_KSEF jest klasy transient, ale bez automatu — nie obiecujemy ponowienia.
    const base = input.errorCode === SEND_ERROR_CODES.NOT_IN_KSEF
      ? KSEF_SEND_MESSAGES.notInKsef
      : errorClass === 'transient'
        ? (automat ? KSEF_SEND_MESSAGES.transient : KSEF_SEND_MESSAGES.transientManual)
        : errorClass === 'setup'
          ? KSEF_SEND_MESSAGES.setup
          : KSEF_SEND_MESSAGES.historical;
    info = !kind
      ? base
      : errorClass === 'transient' && automat
        ? KSEF_SPECIAL_SEND_MESSAGES.transient(kind)
        : `${base} ${KSEF_SPECIAL_SEND_MESSAGES.sendToday(kind)}`;
  }

  if (!input.canManage && (resend || reset)) {
    resend = false;
    reset = false;
    info = `${info} ${KSEF_SEND_MESSAGES.askManager}`;
  }
  return { resend, reset, settings, info };
}

/** Komunikat dla klienta po błędzie `reset_ksef_send` (P0001 pisze RPC wprost dla klienta). */
export function describeResetError(error: { code?: string | null; message?: string | null }): string {
  if (error.code === 'P0001' && error.message) return error.message;
  if (error.code === 'P0002') return KSEF_SEND_MESSAGES.notFound;
  return KSEF_SEND_MESSAGES.resetFailed;
}
