/**
 * Co operator może zrobić z fakturą w `/admin/ksef` (cykl życia faktury,
 * PR 3c). CZYSTY moduł — importowany w komponencie klienckim przycisków
 * i w akcjach serwerowych; te same reguły, które sprawdza RPC z 00131.
 *
 * Różnice wobec akcji klienta (`lib/invoices/ksef-send-policy.ts`):
 *   - operator ma „Tylko uzgodnij” (`requeue_ksef_send(p_reconcile_only)`),
 *     także dla `rejected` — ale tylko gdy jest otwarty wpis `sent`, bo
 *     runner uzgadnia po referencji, a bez niej wysłałby fakturę od nowa;
 *   - operator może ponowić po hamulcu (klasa hold) — to on go zdejmuje;
 *   - klasa reconcile: operator decyduje (uzgodnij albo zostaw), a przy
 *     ENQUEUE_LOST, INVALID_EVENT i RESULT_UNCERTAIN może też wysłać
 *     ponownie (A4) — patrz `OPERATOR_REQUEUE_RECONCILE_CODES`.
 *
 * Dokumenty specjalne (KOR, ZAL, ROZ) od A4b PR2a: zdarzenie odtwarzamy
 * z kopii na wierszu (`ksefResendFacts`). Po klasie kodu: środowisko znane →
 * dane zapisane → rodzaj niewstrzymany (KOR na PROD, ROZ wszędzie — C4) →
 * pełna wysyłka tylko w dniu wystawienia (decyzja Bartosza 06.10.2026 b).
 * „Tylko uzgodnij” datę pomija — nie wysyła.
 *
 * D-A4-1b-3 PR B (decyzje Bartosza 04.10 i 07.10.2026 (5), (7), (12)):
 * „Zapisz decyzję klienta” (decyzja przekazana przez klienta — operator nie
 * decyduje sam) i „Przypomnij klientowi” (najwyżej raz na 24 h). O obu
 * decyduje widok polityki `duplicateDecisionOptions` (actor operator) — te
 * same reguły co RPC `decide_ksef_duplicate` i blokada z 00148.
 *
 * D-A4-1b-3 PR C (00156, spec v3 6.6): przy powodzie `faktflow-original` dochodzi
 * przegląd pliku (widok `review`, I5R): „Zapisz fakturę z KSeF w FaktWay” (tylko
 * gdy suchy przebieg strony mówi, że plik da się zapisać) i — przy `review-pair` —
 * „Oddaj decyzję klientowi”. Zapisywalność liczy strona (`prepareOriginalImport`,
 * odczyt magazynu); ta polityka jest czysta i dostaje jej wynik jako dane.
 */

import type { KsefRequeueRefusal, KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import type {
  DuplicateChoice,
  DuplicateDecisionRefusal,
  DuplicateDecisionView,
  DuplicateRefusalDetail,
} from '@/lib/ksef/duplicate-decision';
import type { OriginalGateProblem } from '@/lib/ksef/duplicate-check';
import {
  SEND_ERROR_CODES,
  isSendErrorCode,
  sendErrorClassOf,
  type SendErrorCode,
  type SendRefusalCode,
} from '@/lib/ksef/send-error-classes';

/**
 * Kody klasy reconcile, przy których „Wyślij ponownie” operatora jest
 * bezpieczne (A4): runner zaczyna od rozstrzygnięcia zamiaru i uzgodnienia
 * otwartego wpisu (A2), treść faktury z dowodem kontaktu jest zamrożona
 * (00132), a KSeF odrzuca drugą fakturę o tym samym numerze (440, a sesja
 * z naszej historii = własny duplikat → `accepted`). Ponowienie tej samej
 * treści nie zrobi więc duplikatu.
 * Poza listą: KSEF_DUPLICATE_RECONCILE (ponowienie powtórzy 440; weryfikację
 * treści powtarza „Tylko uzgodnij” przy otwartym wpisie, a decyzję klienta
 * zapisuje „Zapisz decyzję klienta” — D-A4-1b-3 PR B). ENV_MISMATCH od D-A4-2 (00143) jest klasy terminal: ponowienie
 * wysłałoby fakturę w bieżącym środowisku, więc tylko szkic i decyzja klienta.
 */
export const OPERATOR_REQUEUE_RECONCILE_CODES: readonly SendErrorCode[] = [
  SEND_ERROR_CODES.ENQUEUE_LOST,
  SEND_ERROR_CODES.INVALID_EVENT,
  SEND_ERROR_CODES.RESULT_UNCERTAIN,
];

/**
 * Wpisy `ksef_submissions`, które „Tylko uzgodnij” ma czym uzgodnić: wysyłka
 * z numerem referencyjnym (`sent`) albo zamiar z numerem sesji (`intent`, A2
 * — runner zamyka sesję i pyta KSeF o jej faktury). Ta sama lista dla akcji
 * i karty faktury.
 */
export const OPEN_SUBMISSION_STATUSES = ['sent', 'intent'] as const;

export function hasOpenSubmission(history: ReadonlyArray<{ status: string | null }>): boolean {
  return history.some((s) => (OPEN_SUBMISSION_STATUSES as readonly (string | null)[]).includes(s.status));
}

export const OPERATOR_MESSAGES = {
  notFound: 'Nie ma takiej faktury.',
  incoming: 'To faktura przychodząca — nie wysyła się jej do KSeF.',
  envUnknown: 'Środowisko KSeF nie jest poprawnie skonfigurowane (KSEF_ENV) — zlecenie nie zostało wysłane.',
  incomplete: 'Wiersz nie ma kompletnych danych faktury (fa3_data) — tylko powrót do szkicu.',
  noOpenSent: 'Brak otwartego wpisu wysyłki (sent ani zamiaru intent) — nie ma czego uzgadniać. Ponowna wysyłka wysłałaby fakturę od nowa.',
  paused: 'Wysyłki są wstrzymane wyłącznikiem operatora (killAllKsefSubmissions). Najpierw zdejmij hamulec.',
  pausedUnknown: 'Nie można sprawdzić wyłącznika wysyłek — zlecenie nie zostało wysłane.',
  noNip: 'Firma nie ma NIP-u w bazie ani w fakturze.',
  requeued: 'Zlecono ponowną wysyłkę. Status zmieni się po przebiegu workera.',
  reconcileQueued: 'Zlecono uzgodnienie po numerze referencyjnym. Worker nie wyśle faktury od nowa, dopóki KSeF nie odpowie o poprzedniej wysyłce.',
  reset: 'Faktura wróciła do szkicu.',
  onlyFailed: 'Ponowna wysyłka tylko ze stanu failed.',
  rejectedToDraft: 'Odrzuconej treści nie wysyła się ponownie — powrót do szkicu.',
  terminal: 'Błąd treści dokumentu — powrót do szkicu, nie ponowienie.',
  reconcileClass: 'Klasa reconcile: nie wysyłaj od nowa — użyj „Tylko uzgodnij” albo zostaw.',
  duplicateRequeue: 'KSeF ma już fakturę o tym numerze — ponowienie powtórzy 440. Powody no-own-file, known-number i faktflow-original z oceną pliku: decyzja klienta („Zapisz decyzję klienta” po rozmowie z klientem, „Przypomnij klientowi”). faktflow-original w przeglądzie (I5R): „Zapisz fakturę z KSeF w FaktWay” albo „Oddaj decyzję klientowi”. faktflow-original bez oceny pliku albo „do ponownego sprawdzenia” (recheck-needed), pobranie oryginału nieudane (download-*, storage-pending, archive-pending), known-number bez danych, known-stale, known-now: cron „Tylko uzgodnij” po 48 h (możesz od razu „Tylko uzgodnij” przy otwartym wpisie). same-content-other-program, archive-conflict, cross-tenant: runbook KSEF_DUPLICATE_RECONCILE.',
  envMismatchRequeue: 'Faktura była zlecona w innym środowisku KSeF — ponowienie wysłałoby ją w bieżącym. Bez dowodu kontaktu: „Wróć do szkicu”, klient zdecyduje, czy wysłać ją tutaj. Otwarty wpis: „Tylko uzgodnij” uzgadnia w BIEŻĄCYM środowisku — wpisu sprzed przełączenia środowiska nie uzgadniaj tak (runbook: ENV_MISMATCH).',
  issueDatePassedRequeue: 'Dokument specjalny z datą wystawienia sprzed dzisiaj — worker nie wysyła go z wcześniejszą datą (decyzja 06.10.2026, 00147; do B2). Ten kod powstaje bez otwartego wpisu (worker odmawia po uzgodnieniu, przed plikiem i zamiarem), więc nie ma czego uzgadniać. Bez dowodu kontaktu: „Wróć do szkicu” (klient usuwa szkic i wystawia dokument od nowa z dzisiejszą datą). Z dowodem kontaktu brak wyjścia w panelu do B2 — sprawdź dokument w KSeF i zgłoś go Bartoszowi (runbook ksef-error-codes, „Dokumenty specjalne”).',
  notFailedOrRejected: 'Dostępne tylko dla failed / rejected.',
  evidence: 'Faktura ma dowód kontaktu z KSeF (numer albo wpis sent/accepted/duplicate) — nie wraca do szkicu.',
} as const;

export interface OperatorButton {
  enabled: boolean;
  /** Dlaczego wyłączony — pokazywane jako podpowiedź. */
  reason: string | null;
}

/**
 * PR C (6.6): przycisk przeglądu pliku z etykietą. `reason: null` przy wyłączonym przycisku
 * znaczy „nie dotyczy tej faktury” (widok inny niż `review`) — karta go wtedy nie pokazuje.
 */
export interface OperatorReviewButton extends OperatorButton {
  label: string;
}

/**
 * Wynik suchego przebiegu strony operatora (`prepareOriginalImport`, bez alarmów i zapisów — INV-13):
 * plik z przeglądu da się zapisać w FaktWay jako fakturę K albo nie (`detail` = problem bramy / kod 4.8 /
 * rodzaj błędu odczytu). Polityka jest czysta i magazynu nie czyta — dostaje to jako dane.
 */
export type OperatorRecordable = { ok: true } | { ok: false; detail: string };

export interface OperatorButtons {
  requeue: OperatorButton;
  reconcile: OperatorButton;
  reset: OperatorButton;
  /** „Zapisz decyzję klienta” (D-A4-1b-3 PR B). */
  decide: OperatorButton;
  /** „Przypomnij klientowi” — najwyżej raz na 24 h (decyzja 12). */
  remind: OperatorButton;
  /** PR C: „Zapisz fakturę z KSeF w FaktWay” — tylko widok `review` i plik zapisywalny. */
  record: OperatorReviewButton;
  /** PR C: „Oddaj decyzję klientowi” — tylko widok `review` z ofertą `review-pair`. */
  release: OperatorReviewButton;
}

/** Ślad powiadomień klienta o decyzji (`findDuplicateNotices`) — do „Przypomnij klientowi”. */
export interface DuplicateNoticeSummary {
  count: number;
  lastAt: string | null;
}

export interface OperatorButtonsInput {
  direction: string | null;
  status: string | null;
  errorCode: string | null;
  /** Tylko do etykiet komunikatów — o ponowieniu decydują `facts`. */
  invoiceKind: string | null;
  openSent: boolean;
  evidence: boolean;
  /** Ponowienie z kopii (A4b PR2a): dane zapisane, rodzaj wstrzymany, data wystawienia minęła. */
  facts: KsefResendFacts;
  /** `KSEF_ENV` aplikacji poprawny — bez niego nic nie zlecamy. */
  environmentKnown: boolean;
  /**
   * D-A4-1b-3 PR B: widok decyzji klienta (`duplicateDecisionOptions`, actor
   * operator) dla failed KSEF_DUPLICATE_RECONCILE; brak — faktura nie czeka
   * na decyzję (oba przyciski wyłączone z powodem `notPending`).
   */
  duplicateDecision?: DuplicateDecisionView | null;
  /** Ślad powiadomień o (fakturze, K); brak — bez powiadomienia. */
  duplicateNotice?: DuplicateNoticeSummary | null;
  /**
   * PR C: suchy przebieg strony przy widoku `review` — czy plik da się zapisać. Brak (strona go nie
   * policzyła) = zapis wyłączony: fail-closed, nigdy „zapisywalny z domysłu”.
   */
  originalRecordable?: OperatorRecordable | null;
  /** Chwila odczytu (24 h przypomnienia); domyślnie teraz. */
  now?: Date;
}

/** Odstęp „Przypomnij klientowi” (decyzja 12) — ten sam co w akcji. */
export const OPERATOR_REMIND_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Teksty operatora decyzji klienta przy 440 (2.11.D; bez przeglądu prawnika).
 * `{nr}` numer dokumentu, `{K}` numer KSeF oryginału.
 */
export const OPERATOR_DUPLICATE_MESSAGES = {
  decideButton: 'Zapisz decyzję klienta',
  dialogTitle: (nr: string, k: string) => `Decyzja klienta — ${nr} (faktura w KSeF ${k})`,
  lead: 'Zapisz decyzję przekazaną przez klienta — operator nie decyduje sam (decyzja Bartosza 04.10.2026).',
  choiceSame: 'Klient: to ta sama sprzedaż',
  choiceOther: 'Klient: to inna sprzedaż',
  noteLabel: 'Skąd decyzja (kanał, data, osoba)',
  notePlaceholder: 'np. e-mail od właściciela 05.10, Jan Kowalski',
  noteError: 'Notatka: co najmniej 10 znaków — kanał, data, osoba.',
  /**
   * Pole „Rozumiem skutki” klienta (decyzja 7, C5) — wymagane, gdy `needsConfirmation[choice]`.
   * „Ta sama sprzedaż”: `confirmSame`, gdy tabela zaznacza różnicę (`markedDifference`),
   * inaczej `confirmSameUncomparable` — jak `DIALOG_SAME.CHECKBOX` / `CHECKBOX_UNCOMPARABLE` klienta.
   */
  confirmSame: (k: string, nr: string) =>
    `Klient potwierdził „Rozumiem skutki”: faktura ${k} w KSeF dokumentuje tę samą sprzedaż co dokument ${nr}, mimo różnic w tabeli.`,
  confirmSameUncomparable: (k: string, nr: string) =>
    `Klient potwierdził „Rozumiem skutki”: faktura ${k} w KSeF dokumentuje tę samą sprzedaż co dokument ${nr}, choć części danych w tabeli nie da się porównać.`,
  confirmOther: (k: string, nr: string) =>
    `Klient potwierdził „Rozumiem skutki”: faktura ${k} w KSeF dokumentuje inną sprzedaż niż dokument ${nr}.`,
  confirmMissing: 'Zaznacz potwierdzenie klienta („Rozumiem skutki”) i zapisz jeszcze raz.',
  success: (choice: DuplicateChoice) =>
    `Zapisano decyzję klienta (${choice === 'same_sale' ? 'ta sama sprzedaż' : 'inna sprzedaż'}). Dokument wrócił do szkicu jako wycofany.`,
  remindButton: 'Przypomnij klientowi',
  remindConfirm: (nr: string) => `Wysłać klientowi ponownie e-mail „Faktura ${nr} czeka na Twoją decyzję”?`,
  remindTooSoon: (lastAt: string) =>
    `Ostatnie powiadomienie: ${formatWarsawDateTime(lastAt)} — przypomnienie najwcześniej 24 h później.`,
  remindNoEmail: 'Firma nie ma adresu e-mail właściciela — skontaktuj się z klientem innym kanałem (runbook KSEF_DUPLICATE_RECONCILE).',
  remindReadFailed: 'Nie udało się odczytać adresu e-mail właściciela (błąd bazy albo GoTrue) — spróbuj ponownie za chwilę.',
  remindNotSent: (reason: string) => `Nie wysłano przypomnienia (${reason}).`,
  remindSentNotRecorded: 'Przypomnienie wysłane, ale nie zapisaliśmy śladu w audit_logs — nie wysyłaj go ponownie przez 24 h (klucz Resend chroni tylko dobę).',
  remindSuccess: (email: string) => `Wysłano przypomnienie do ${email}.`,
  // Powody wyłączenia „Zapisz decyzję klienta” i „Przypomnij klientowi”.
  notPending: 'Faktura nie czeka na decyzję klienta (stan albo kod inny niż failed / KSEF_DUPLICATE_RECONCILE).',
  reason: (r: string) =>
    `Powód ${r}: decyzji klienta w panelu nie ma (same-content-other-program — D-A4-1b-2; archive-conflict — runbook; download-*/storage-pending/archive-pending i known-number bez danych — „Tylko uzgodnij”; ownHistory przy no-own-file albo known-number — runbook; faktflow-original bez SystemInfo FaktWay albo z niepełnymi danymi — runbook).`,
  knownStale: (y: string, k: string) =>
    `known-stale: dokument ${y} nie ma już numeru KSeF ${k} albo nie jest przyjęty w KSeF — „Tylko uzgodnij” powtórzy werdykt; dokument ${y} w stanie failed z numerem KSeF to I9 — najpierw I9.`,
  payments: (paidAmount: string) =>
    `Wpłaty na fakturze (paid_amount ${paidAmount}) — decyzja zablokowana (decyzja Bartosza 07.10.2026 (A)); wpłaty zmieniamy tylko za zgodą Bartosza (runbook, decyzja (6)).`,
  env: (checkEnv: string, appEnv: string) =>
    `original_check.env „${checkEnv}” ≠ KSEF_ENV „${appEnv}” — nie zapisuj decyzji (runbook: przełączenie środowiska; alarm I5D-env).`,
  noCheck: 'no-check: wpis sprzed 00144 — I5 zapisze dane przy ponownym sprawdzeniu.',
  runbook: (code: string) => `${code}: runbook KSEF_DUPLICATE_RECONCILE — sprawdź w KSeF i zgłoś Bartoszowi.`,
  /** Alarm monitora i podpowiedź w tabeli I5D `/admin/ksef` (2.7.4). */
  i5dEnv: 'I5D-env: faktura czeka na decyzję klienta, ale dane oryginału sprawdzono w innym środowisku KSeF niż obecne — klient nie zapisze decyzji (runbook KSEF_DUPLICATE_RECONCILE, przełączenie środowiska).',
  // ── PR C (00156, spec v3 6.6; bez przeglądu prawnika). Nowe klucze; `reason`
  // i `OPERATOR_MESSAGES.duplicateRequeue` mają brzmienie 6.6 (przypięte `admin-ksef-cykl-dane.test.ts`).
  knownNow: (k: string) =>
    `known-now: numer KSeF ${k} ma już inna faktura sprzedaży tej firmy — „Tylko uzgodnij” (werdykt będzie known-number, decyzja klienta jak w PR B).`,
  crossTenant: (k: string) =>
    `cross-tenant: numer KSeF ${k} albo numer tego dokumentu ma faktura sprzedaży innej firmy z tym samym NIP — nie zapisuj decyzji; runbook KSEF_DUPLICATE_RECONCILE „Oryginał w innej firmie”, decyzja Bartosza.`,
  provenanceReview: (problems: string) =>
    `provenance-review: plik z oznaczeniem FaktWay nie wygląda na plik z generatora FaktWay (${problems}). Przejrzyj plik i wybierz: „Zapisz fakturę z KSeF w FaktWay” (po rozmowie z klientem, notatka; tylko gdy plik da się zapisać) albo „Oddaj decyzję klientowi (plik nie z FaktWay)”. Po decyzji poinformuj klienta (oddanie wysyła e-mail samo).`,
  recheckPending: (kind: string | null, at: string | null) =>
    `recheck-needed (${kind ?? 'brak oceny pliku'}, ${at ?? '—'}): faktura czeka na nowy werdykt — cron „Tylko uzgodnij” po 48 h od próby; możesz od razu „Tylko uzgodnij”. Decyzji i przypomnienia teraz nie ma.`,
  reviewRecordHint: 'Zapis z plikiem spoza generatora FaktWay: faktura trafi do FaktWay z danymi z pliku jak z Magicznego importu. Stawka spoza FaktWay (0 WDT, 0 EX, 22, 7, 4, 3) albo oznaczenia FP/TP/GTU/procedury wstrzymają JPK za ten miesiąc z komunikatem nazywającym fakturę — powiedz to klientowi. Korekty faktury z pozycją zw (do czasu C3), ze stawką spoza FaktWay albo bez ceny netto (ceny brutto, brak P_9A) FaktWay nie wystawi: powiedz klientowi, że korektę uzgadnia przez pomoc FaktWay.',
  releaseNoGate: 'Ocena pliku nie jest zapisana na wpisie — najpierw „Tylko uzgodnij” (nowa ocena), potem oddanie.',
  releaseFailed: 'Oddanie nie zadziałało (stan po zapisie niezgodny) — nic nie zapisano; zgłoś Bartoszowi.',
  releaseAlreadyEmailed: (at: string) =>
    `Decyzja była już oddana; e-mail do klienta wysłany ${at}.`,
  reviewRecordOnly: 'Plik jest w historii tego dokumentu albo ma tę samą treść — to plik z FaktWay: „Oddaj decyzję klientowi” niedostępne. Zapisz fakturę z KSeF albo zgłoś Bartoszowi (runbook).',
  recordButton: 'Zapisz fakturę z KSeF w FaktWay',
  choiceRecord: 'Klient: zapisać fakturę z KSeF (ta sama sprzedaż)',
  choiceSameRecord: 'Klient: to ta sama sprzedaż — zapisz fakturę z KSeF',
  choiceOtherRecord: 'Klient: to inna sprzedaż — zapisz fakturę z KSeF',
  confirmRecord: (k: string, nr: string) =>
    `Klient potwierdził „Rozumiem skutki”: obowiązują dane faktury ${k} z KSeF, nie dane dokumentu ${nr}.`,
  noteStoredHint: 'Notatka trafi do zapisu decyzji przy fakturze (przechowywany 10 lat, firma ma do niego dostęp) — bez uwag wewnętrznych.',
  releaseButton: 'Oddaj decyzję klientowi (plik nie z FaktWay)',
  releaseLead: 'Oddajesz decyzję klientowi jak przy fakturze z innego programu: bez zapisu faktury z KSeF w FaktWay, numer zostaje przy dokumencie. Klient dostanie e-mail z prośbą o decyzję.',
  releaseNoteLabel: 'Co sprawdziłeś w pliku i dlaczego to nie plik z FaktWay',
  releaseSuccess: (email: string) =>
    `Oddano decyzję klientowi; e-mail z prośbą o decyzję wysłany do ${email}.`,
  releaseSentNoEmail: (reason: string) =>
    `Oddano decyzję klientowi, ale e-mail nie wyszedł (${reason}) — użyj „Przypomnij klientowi”.`,
  releaseNotReview: 'Faktura nie czeka na przegląd pliku (stan się zmienił) — odśwież kartę.',
  releaseStale: 'Dane oryginału zmieniły się od otwarcia karty — odśwież kartę.',
  notBuildable: (reason: string) =>
    `Nie da się zapisać tej faktury w FaktWay z pliku z KSeF (${reason}) — przy review-pair oddaj decyzję klientowi; przy review-record zgłoś Bartoszowi (runbook „Zapis oryginału odmówiony”).`,
  // Odmowa zapisu przy ofercie `pair` / `record`, czyli po ocenie „importable”: to błąd programu (nie decyzja operatora),
  // a faktura jest już oznaczona do ponownego sprawdzenia. `notBuildable` dotyczy ofert przeglądu (`review-*`).
  notBuildableProgram: (detail: string) =>
    `Nie da się zapisać faktury z pliku (${detail}) mimo oceny „importable” — błąd programu; oznaczone do ponownego sprawdzenia (cron „Tylko uzgodnij”), zgłoś Bartoszowi (runbook „Zapis oryginału odmówiony”).`,
  archive: (path: string, detail: string) =>
    `Archiwum oryginału ${path}: ${detail === 'missing' ? 'brak pliku' : 'inny SHA-256 albo rozmiar niż w original_check'} — oznaczone do ponownego sprawdzenia (cron „Tylko uzgodnij”; runner zapisze plik, gdy go brak; inny plik pod tym kluczem = archive-conflict, runbook).`,
  gateDrift: 'Bieżący kod ocenia plik inaczej (inny wynik albo inne problemy) niż ocena zapisana na wpisie — oznaczone do ponownego sprawdzenia; nowy werdykt zapisze nową ocenę.',
  importMismatch: (detail: string) =>
    `import-mismatch (${detail}): baza odrzuciła projekcję, którą przepuściło lustro TS — błąd programu albo zmiana danych firmy w trakcie; nie zapisuj decyzji, zgłoś Bartoszowi (runbook „Zapis oryginału odmówiony”).`,
  importProgram: (detail: string) =>
    `Projekcja faktury z KSeF odrzucona przez bazę (${detail}) — błąd programu, zgłoś Bartoszowi; nie zapisuj decyzji.`,
  stateUnknown: 'Nie udało się odczytać blokady decyzji z bazy — odśwież kartę.',
  noSession: (nrK: string) =>
    `Brak sesji oryginału — UPO faktury ${nrK} nie pobierzemy automatycznie (I3K; runbook „UPO faktury zapisanej z KSeF”).`,
  noDate: (nrK: string) =>
    `Brak daty nadania numeru KSeF faktury ${nrK} (I3K) — ./scripts/ops/oryginal-ksef-data-nadania.sh <id faktury> <data z KSeF> (runbook).`,
  successImport: (choice: DuplicateChoice, nrK: string) =>
    `Zapisano decyzję klienta (${choice === 'same_sale' ? 'ta sama sprzedaż' : 'inna sprzedaż'}). Faktura ${nrK} z KSeF jest w FaktWay; dokument wycofany bez numeru.`,
  successRecord: (nrK: string) =>
    `Zapisano fakturę ${nrK} z KSeF w FaktWay; dokument wycofany bez numeru.`,
  remindReview: 'provenance-review: klient nie zdecyduje, dopóki nie przejrzysz pliku — przypomnienie nic nie da.',
  i5r72h: 'I5R-72h: plik z oznaczeniem FaktWay czeka na przegląd operatora dłużej niż 72 h — klient usłyszał „damy znać”.',
  // Dodatkowe odmowy zapisu oryginału (spec 5.6 krok 9, `read-failed`; e-mail po oddaniu decyzji) — brzmienie operatora.
  archiveReadFailed: (path: string) =>
    `Nie udało się teraz odczytać archiwum oryginału ${path} (błąd magazynu, nic nie oznaczono) — spróbuj ponownie za chwilę; jeśli wraca, zgłoś Bartoszowi.`,
  // „Przypomnij klientowi” ma inny klucz Resend (…/przypomnienie-n) niż e-mail po oddaniu, więc nie jest deduplikowane — wyśle drugi e-mail.
  releaseSentNotRecorded: 'Oddano decyzję klientowi i e-mail wyszedł, ale nie zapisaliśmy śladu w audit_logs — „Przypomnij klientowi” wyśle drugi e-mail; użyj go dopiero, gdy klient potwierdzi, że e-maila nie ma.',
} as const;

/**
 * PR C (spec v3 6.6): etykiety problemów bramy pochodzenia (`importGate.problems`)
 * na karcie operatora i w `provenanceReview(problems)`.
 */
export const ORIGINAL_GATE_PROBLEM_LABELS: Readonly<Record<OriginalGateProblem, string>> = {
  currency: 'waluta inna niż PLN',
  parse: 'plik nie daje się odczytać jako FA(3)',
  form: 'formularz inny niż FA (3)',
  kind: 'RodzajFaktury inny niż VAT',
  number: 'P_2 ≠ numer dokumentu',
  seller: 'NIP sprzedawcy ≠ NIP firmy',
  'buyer-id': 'nabywca bez identyfikatora',
  'no-lines': 'brak pozycji',
  'gross-prices': 'ceny brutto (P_9B/P_11A)',
  'line-fields': 'pozycja bez P_9A/P_11/P_12 albo z P_10/P_11Vat',
  rates: 'stawka P_12 spoza FaktWay',
  amounts: 'kwoty pozycji niezgodne z sumami stawek (C5c)',
  totals: 'P_15 ≠ suma P_13 + P_14',
  annotations: 'adnotacje, których FaktWay nie wystawia, albo nieczytelne',
  markers: 'FP/TP/GTU/procedura/podmiot upoważniony',
  'sale-date': 'OkresFa, P_6A albo nieczytelna data sprzedaży',
};

/**
 * Problemy bramy po polsku, po przecinku. Kod spoza słownika (nowa wersja reguł bramy
 * zapisana przez nowszy program, zła wartość w jsonb) zostaje kodem — etykieta nigdy nie
 * pada na `undefined` (M3).
 */
export function gateProblemsText(problems: readonly string[]): string {
  const labels: Readonly<Record<string, string | undefined>> = ORIGINAL_GATE_PROBLEM_LABELS;
  return problems.map((problem) => labels[problem] ?? problem).join(', ');
}

/** Etykiety dokumentów specjalnych w komunikatach operatora. */
export const OPERATOR_KIND_LABEL = {
  correction: 'Korekta (KOR)',
  advance: 'Zaliczka (ZAL)',
  final: 'Faktura rozliczeniowa (ROZ)',
} as const;

type SpecialKind = keyof typeof OPERATOR_KIND_LABEL;
const isSpecialKind = (kind: string | null): kind is SpecialKind =>
  kind === 'correction' || kind === 'advance' || kind === 'final';

/** Wiersz bez danych do odtworzenia zdarzenia (stary dokument albo zwykła bez pozycji). */
export function operatorLegacyDataMessage(kind: string | null): string {
  switch (kind) {
    case 'correction':
      return 'Korekta (KOR) sprzed 00137 (przed wdrożeniem A4b PR1): wiersz nie ma special_data — zdarzenia wysyłki nie da się odtworzyć. Bez dowodu kontaktu i poza klasą reconcile: „Wróć do szkicu”. W pozostałych przypadkach runbook ksef-error-codes, „Stary dokument specjalny” (scripts/ops/dopisz-dane-specjalne.sh — 00137 dopuszcza NULL → wartość tylko serwerowi), potem na TEST „Tylko uzgodnij” przy otwartym wpisie sent/intent albo „Wyślij ponownie” w dniu wystawienia; inaczej brak wyjścia do B2 — zgłoś Bartoszowi; na PROD korekta czeka na C4 (KOR_HOLD).';
    case 'final':
      return 'Faktura rozliczeniowa (ROZ) sprzed 00137 (przed wdrożeniem A4b PR1): wiersz nie ma special_data — zdarzenia wysyłki nie da się odtworzyć. Bez dowodu kontaktu i poza klasą reconcile: „Wróć do szkicu”. W pozostałych przypadkach runbook ksef-error-codes, „Stary dokument specjalny” (scripts/ops/dopisz-dane-specjalne.sh); ponowienie i uzgodnienie ROZ i tak czekają na C4 (hamulec ROZ we wszystkich środowiskach).';
    case 'advance':
      return 'Zaliczka (ZAL) sprzed 02.10.2026: fa3_data nie ma koperty advanceEnvelope — zdarzenia wysyłki nie da się odtworzyć. Bez dowodu kontaktu i poza klasą reconcile: „Wróć do szkicu”. W pozostałych przypadkach brak wyjścia w panelu: po przejęciu wysyłki fa3_data jest zamrożone (00132) — zgłoś fakturę Bartoszowi (runbook ksef-error-codes, „Stary dokument specjalny”).';
    default:
      return OPERATOR_MESSAGES.incomplete;
  }
}

/** Rodzaj wstrzymany w tym środowisku — runner zatrzymałby zlecenie przed KSeF. */
export function operatorKindHeldMessage(kind: string | null): string {
  switch (kind) {
    case 'correction':
      return 'Hamulec korekt na KSeF produkcyjnym (KOR_HOLD) — runner zatrzymałby ponowienie i uzgodnienie przed KSeF i nadpisał kod. Zdejmuje go C4 (docs/runbooks/hamulce-ksef.md). Bez dowodu kontaktu i poza klasą reconcile: „Wróć do szkicu”.';
    case 'final':
      return 'Hamulec faktur rozliczeniowych we wszystkich środowiskach (ROZ_HOLD_RECONCILE) — runner zatrzymałby ponowienie i uzgodnienie przed KSeF i nadpisał kod. Zdejmuje go C4 (docs/runbooks/hamulce-ksef.md). Bez dowodu kontaktu i poza klasą reconcile: „Wróć do szkicu”.';
    default:
      // Zaliczka jest wstrzymana tylko przy nieznanym środowisku (przyciski odmawiają wcześniej).
      return OPERATOR_MESSAGES.envUnknown;
  }
}

/** Dokument specjalny po dacie wystawienia — pełnej wysyłki z kopii nie zlecamy (decyzja b). */
export function operatorIssueDateMessage(kind: string | null): string {
  const label = isSpecialKind(kind) ? OPERATOR_KIND_LABEL[kind] : 'Dokument specjalny';
  return `${label} z datą wystawienia sprzed dzisiaj — nie zlecamy pełnej wysyłki: worker odmówiłby jej z kodem ISSUE_DATE_PASSED (decyzja 06.10.2026, 00147; do B2). Otwarty wpis sent/intent: „Tylko uzgodnij” (nie wysyła, data nie ma znaczenia). Bez dowodu kontaktu i poza klasą reconcile: „Wróć do szkicu”. W pozostałych przypadkach brak wyjścia w panelu do B2 — sprawdź dokument w KSeF i zgłoś go Bartoszowi.`;
}

function reconcileRequeueRefusal(code: string | null): string {
  if (code === SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE) return OPERATOR_MESSAGES.duplicateRequeue;
  return OPERATOR_MESSAGES.reconcileClass;
}

function terminalRequeueRefusal(code: string | null): string {
  if (code === SEND_ERROR_CODES.ENV_MISMATCH) return OPERATOR_MESSAGES.envMismatchRequeue;
  if (code === SEND_ERROR_CODES.ISSUE_DATE_PASSED) return OPERATOR_MESSAGES.issueDatePassedRequeue;
  return OPERATOR_MESSAGES.terminal;
}

const off = (reason: string): OperatorButton => ({ enabled: false, reason });

/**
 * Odmowa „Wyślij ponownie” / „Tylko uzgodnij”: powód dla operatora i kod do
 * dziennika prób (`refused`, A5). Kod z katalogu, gdy znaczy to samo (hamulce,
 * data wystawienia); odmowa z powodu klasy błędu faktury — kod tej faktury
 * (np. KSEF_DUPLICATE_RECONCILE: „ponowienie powtórzy 440”).
 */
export interface OperatorRefusal {
  code: SendRefusalCode;
  reason: string;
}

const refuse = (code: SendRefusalCode, reason: string): OperatorRefusal => ({ code, reason });
const button = (refusal: OperatorRefusal | null): OperatorButton =>
  refusal ? off(refusal.reason) : { enabled: true, reason: null };

/** Kod hamulca rodzaju — jak w `operatorKindHeldMessage` (zaliczka: tylko nieznane środowisko). */
function kindHeldCode(kind: string | null): SendRefusalCode {
  if (kind === 'correction') return SEND_ERROR_CODES.KOR_HOLD;
  if (kind === 'final') return SEND_ERROR_CODES.ROZ_HOLD_RECONCILE;
  return 'ENV_UNKNOWN';
}

/**
 * „Wyślij ponownie” operatora — ta sama decyzja dla przycisku i akcji
 * (`operatorRequeueAction`); nie zależy od dowodu kontaktu ani otwartego wpisu.
 * Klasa hold zostaje dostępna (operator zdejmuje hamulce; akcja sprawdza wyłącznik).
 */
export function operatorRequeueRefusal(
  input: Pick<OperatorButtonsInput, 'direction' | 'status' | 'errorCode' | 'invoiceKind' | 'facts' | 'environmentKnown'>,
): OperatorRefusal | null {
  const errorClass = sendErrorClassOf(input.errorCode);
  if (input.direction !== 'outgoing') return refuse('STATUS_NOT_ALLOWED', OPERATOR_MESSAGES.incoming);
  if (input.status === 'rejected') return refuse('STATUS_NOT_ALLOWED', OPERATOR_MESSAGES.rejectedToDraft);
  if (input.status !== 'failed') return refuse('STATUS_NOT_ALLOWED', OPERATOR_MESSAGES.onlyFailed);
  // Klasa z katalogu → kod jest w katalogu (zawężenie tylko dla typu).
  if (errorClass === 'terminal' && isSendErrorCode(input.errorCode)) {
    return refuse(input.errorCode, terminalRequeueRefusal(input.errorCode));
  }
  if (errorClass === 'reconcile' && isSendErrorCode(input.errorCode) && !OPERATOR_REQUEUE_RECONCILE_CODES.includes(input.errorCode)) {
    return refuse(input.errorCode, reconcileRequeueRefusal(input.errorCode));
  }
  if (!input.environmentKnown) return refuse('ENV_UNKNOWN', OPERATOR_MESSAGES.envUnknown);
  if (input.facts.sendData === 'missing') return refuse('SEND_DATA_MISSING', operatorLegacyDataMessage(input.invoiceKind));
  if (input.facts.kindHeld) return refuse(kindHeldCode(input.invoiceKind), operatorKindHeldMessage(input.invoiceKind));
  if (input.invoiceKind !== 'regular' && input.facts.issueDatePassed) {
    return refuse(SEND_ERROR_CODES.ISSUE_DATE_PASSED, operatorIssueDateMessage(input.invoiceKind));
  }
  return null;
}

export function operatorRequeueButton(
  input: Pick<OperatorButtonsInput, 'direction' | 'status' | 'errorCode' | 'invoiceKind' | 'facts' | 'environmentKnown'>,
): OperatorButton {
  return button(operatorRequeueRefusal(input));
}

/**
 * „Tylko uzgodnij” — ta sama decyzja dla przycisku i akcji. Bez sprawdzania
 * klasy i daty (nie wysyła), ale z danymi i rodzajem: runner potrzebuje
 * kompletnego zdarzenia na granicy i zatrzymuje hamulec przed uzgodnieniem.
 */
export function operatorReconcileRefusal(
  input: Pick<OperatorButtonsInput, 'direction' | 'status' | 'invoiceKind' | 'facts' | 'environmentKnown' | 'openSent'>,
): OperatorRefusal | null {
  if (input.direction !== 'outgoing') return refuse('STATUS_NOT_ALLOWED', OPERATOR_MESSAGES.incoming);
  if (input.status !== 'failed' && input.status !== 'rejected') {
    return refuse('STATUS_NOT_ALLOWED', OPERATOR_MESSAGES.notFailedOrRejected);
  }
  if (!input.environmentKnown) return refuse('ENV_UNKNOWN', OPERATOR_MESSAGES.envUnknown);
  if (input.facts.sendData === 'missing') return refuse('SEND_DATA_MISSING', operatorLegacyDataMessage(input.invoiceKind));
  if (input.facts.kindHeld) return refuse(kindHeldCode(input.invoiceKind), operatorKindHeldMessage(input.invoiceKind));
  if (!input.openSent) return refuse('NO_OPEN_SUBMISSION', OPERATOR_MESSAGES.noOpenSent);
  return null;
}

export function operatorReconcileButton(
  input: Pick<OperatorButtonsInput, 'direction' | 'status' | 'invoiceKind' | 'facts' | 'environmentKnown' | 'openSent'>,
): OperatorButton {
  return button(operatorReconcileRefusal(input));
}

/**
 * Zdarzenie z kopii na wierszu nie powstało (`buildKsefRequeueEvent`) — zwykle
 * nieosiągalne po decyzji przycisku, chyba że minęła północ między krokami.
 */
export function operatorRequeueEventRefusal(reason: KsefRequeueRefusal, kind: string | null): OperatorRefusal {
  switch (reason) {
    case 'missing-special-data':
    case 'incomplete':
      return refuse('SEND_DATA_MISSING', operatorLegacyDataMessage(kind));
    case 'kind-held':
      return refuse(kindHeldCode(kind), operatorKindHeldMessage(kind));
    case 'issue-date':
      return refuse(SEND_ERROR_CODES.ISSUE_DATE_PASSED, operatorIssueDateMessage(kind));
    default:
      return refuse('NO_NIP', OPERATOR_MESSAGES.noNip);
  }
}

/**
 * Powód wyłączenia „Zapisz decyzję klienta” dla kodu odmowy — z widoku
 * polityki (`detail` niesie wartości z faktów) albo z blokady SQL odczytanej
 * przez akcję przypomnienia (`ksef_duplicate_decision_blocker`).
 */
export function operatorDuplicateRefusalReason(
  refusal: DuplicateDecisionRefusal | string,
  detail: DuplicateRefusalDetail | null | undefined,
): string {
  const M = OPERATOR_DUPLICATE_MESSAGES;
  switch (refusal) {
    case 'not-found':
    case 'not-pending':
      return M.notPending;
    case 'payments':
      return M.payments(detail?.paidAmount != null ? String(detail.paidAmount) : 'nieznana');
    case 'env':
      return M.env(detail?.checkEnv ?? 'brak', detail?.environment ?? 'brak');
    case 'env-unknown':
      return OPERATOR_MESSAGES.envUnknown;
    case 'known-stale':
      return M.knownStale(detail?.knownInvoiceNumber ?? 'bez numeru', detail?.originalKsefNumber ?? '(brak)');
    case 'reason':
      return M.reason(detail?.reason ?? 'nieznany');
    case 'no-check':
      return M.noCheck;
    // PR C (6.6): kody blokady 00156 i odmowy aplikacji; `none` i `no-marker` to DETAIL odmowy `release:not-review`.
    case 'known-now':
      return M.knownNow(detail?.originalKsefNumber ?? '(brak)');
    case 'cross-tenant':
      return M.crossTenant(detail?.originalKsefNumber ?? '(brak)');
    case 'recheck-needed':
    case 'recheck':
      return M.recheckPending(detail?.recheckKind ?? null, detail?.recheckAt ?? null);
    case 'provenance-review':
      // Widok `review` niesie problemy bramy; sam kod z bazy (wyścig) ich nie zna.
      return M.provenanceReview('stan zmienił się od odczytu — odśwież kartę');
    case 'state-unknown':
      return M.stateUnknown;
    case 'not-buildable':
      return M.notBuildable('brak szczegółów');
    case 'none':
      return M.releaseNotReview;
    default:
      return M.runbook(refusal);
  }
}

/** „Zapisz decyzję klienta” — tylko widok `decidable` (actor operator). */
export function operatorDuplicateDecisionButton(view: DuplicateDecisionView | null | undefined): OperatorButton {
  if (!view || view.kind === 'decided') return off(OPERATOR_DUPLICATE_MESSAGES.notPending);
  if (view.kind === 'decidable') return { enabled: true, reason: null };
  // PR C: w przeglądzie pliku „Zapisz decyzję klienta” zastępują „Zapisz fakturę z KSeF” i „Oddaj decyzję
  // klientowi” (`operatorReviewButtons`); tu zostaje powód, dla którego klient jeszcze nie decyduje.
  if (view.kind === 'review') return off(OPERATOR_DUPLICATE_MESSAGES.provenanceReview(gateProblemsText(view.problems)));
  return off(operatorDuplicateRefusalReason(view.refusal, view.detail));
}

/**
 * Zapis i oddanie w przeglądzie pliku (spec v3 6.6, T8). Zapis („Zapisz fakturę z KSeF w FaktWay”):
 * tylko gdy suchy przebieg strony mówi, że plik da się zapisać; inaczej wyłączony z `notBuildable(powód)`
 * (przy `review-pair` zostaje oddanie, przy `review-record` — runbook, Bartosz). Oddanie („Oddaj decyzję
 * klientowi”): tylko `review-pair`; plik w historii dokumentu albo o tej samej treści to plik z FaktWay
 * (`reviewRecordOnly`, INV-19). Poza widokiem `review` oba przyciski są wyłączone bez powodu.
 */
export function operatorReviewButtons(
  view: DuplicateDecisionView | null | undefined,
  recordable: OperatorRecordable | null | undefined,
): { record: OperatorReviewButton; release: OperatorReviewButton } {
  const M = OPERATOR_DUPLICATE_MESSAGES;
  if (!view || view.kind !== 'review') {
    return {
      record: { enabled: false, reason: null, label: M.recordButton },
      release: { enabled: false, reason: null, label: M.releaseButton },
    };
  }
  const record: OperatorReviewButton = recordable?.ok === true
    ? { enabled: true, reason: null, label: M.recordButton }
    : { enabled: false, reason: M.notBuildable(recordable?.ok === false ? recordable.detail : 'plik nie został sprawdzony'), label: M.recordButton };
  const release: OperatorReviewButton = view.releasable
    ? { enabled: true, reason: null, label: M.releaseButton }
    : { enabled: false, reason: M.reviewRecordOnly, label: M.releaseButton };
  return { record, release };
}

/**
 * „Przypomnij klientowi” — gdy decyzja jest możliwa i od ostatniego
 * powiadomienia o (fakturze, K) minęły co najmniej 24 h (decyzja 12).
 * Faktura nigdy niepowiadomiona (zaległość sprzed PR B) — od razu.
 */
export function operatorRemindButton(
  decide: OperatorButton,
  notice: DuplicateNoticeSummary | null | undefined,
  now: Date,
): OperatorButton {
  if (!decide.enabled) return decide;
  const lastAt = notice?.lastAt ?? null;
  if (lastAt !== null) {
    const last = Date.parse(lastAt);
    if (Number.isNaN(last) || now.getTime() - last < OPERATOR_REMIND_INTERVAL_MS) {
      return off(OPERATOR_DUPLICATE_MESSAGES.remindTooSoon(lastAt));
    }
  }
  return { enabled: true, reason: null };
}

export function operatorInvoiceButtons(input: OperatorButtonsInput): OperatorButtons {
  const outgoing = input.direction === 'outgoing';
  const failedOrRejected = input.status === 'failed' || input.status === 'rejected';
  const errorClass = sendErrorClassOf(input.errorCode);

  const requeue = operatorRequeueButton(input);
  const reconcile = operatorReconcileButton(input);

  const reset: OperatorButton = !outgoing
    ? { enabled: false, reason: OPERATOR_MESSAGES.incoming }
    : !failedOrRejected
      ? { enabled: false, reason: OPERATOR_MESSAGES.notFailedOrRejected }
      : input.evidence
        ? { enabled: false, reason: OPERATOR_MESSAGES.evidence }
        : errorClass === 'reconcile'
          ? { enabled: false, reason: OPERATOR_MESSAGES.reconcileClass }
          : { enabled: true, reason: null };

  const decide = operatorDuplicateDecisionButton(input.duplicateDecision);
  // W przeglądzie pliku klient nie zdecyduje, dopóki operator nie przejrzy pliku — przypomnienie nic nie da.
  const remind = input.duplicateDecision?.kind === 'review'
    ? off(OPERATOR_DUPLICATE_MESSAGES.remindReview)
    : operatorRemindButton(decide, input.duplicateNotice, input.now ?? new Date());
  const { record, release } = operatorReviewButtons(input.duplicateDecision, input.originalRecordable);

  return { requeue, reconcile, reset, decide, remind, record, release };
}
