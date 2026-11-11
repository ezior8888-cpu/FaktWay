/**
 * Teksty klienta decyzji przy 440 i szkicu wycofanego (2.11.B–C) po przeglądzie
 * prawnika; migawka `tests/unit/__snapshots__/ksef-duplikat-decyzja-teksty.txt`.
 *
 * Część barelu `./duplicate-decision` (plan usprawnień 3.7b). Spoza
 * `lib/ksef/duplicate-decision*.ts` importuj tylko z barelu `@/lib/ksef/duplicate-decision`.
 * CZYSTY moduł (komponenty klienckie i worker): bez bazy, KSeF, Node i `duplicate-verdict.ts`.
 */

import { KSEF_SEND_MESSAGES, KSEF_SPECIAL_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';
import { SUPPORT_EMAIL } from '@/lib/site';

import { DUPLICATE_ORIGINAL_NOTES } from './duplicate-check';

// ─── Teksty klienta (2.11.B–C) ───────────────────────────────────────────────

/** `{program}` w bierniku (2.11): FaktWay, inny znany program albo nieznany (każdy plik FaktWay ma SystemInfo). */
export function programAccusative(program: string | null): string {
  if (program === 'FaktWay') return DUPLICATE_DECISION_TEXTS.PROGRAM_ACCUSATIVE.FAKTFLOW;
  return program ? DUPLICATE_DECISION_TEXTS.PROGRAM_ACCUSATIVE.OTHER(program) : DUPLICATE_DECISION_TEXTS.PROGRAM_ACCUSATIVE.UNKNOWN;
}

/** `{programN}` w mianowniku. */
export function programNominative(program: string | null): string {
  if (program === 'FaktWay') return DUPLICATE_DECISION_TEXTS.PROGRAM_NOMINATIVE.FAKTFLOW;
  return program ? DUPLICATE_DECISION_TEXTS.PROGRAM_NOMINATIVE.OTHER(program) : DUPLICATE_DECISION_TEXTS.PROGRAM_NOMINATIVE.UNKNOWN;
}

/** ` (numer KSeF {K})` — pomijane, gdy wpisy nie niosą numeru oryginału. */
const ksefNumberPart = (k: string | null): string => (k ? ` (numer KSeF ${k})` : '');

const S = KSEF_SPECIAL_SEND_MESSAGES;

/**
 * Wszystkie teksty klienta decyzji przy 440 i szkicu wycofanego (2.11.B–C).
 * Argumenty pozycyjne (napisy), żeby migawka dla prawnika pokazała całe zdania
 * ze znacznikami: `{nr}` numer dokumentu, `{K}` numer KSeF oryginału, `{nrK}`
 * numer faktury z KSeF (`summary.number ?? {nr}`), `{Y}` numer dokumentu, który
 * ma K w FaktWay, `{X}` program. Odmowy z bazy (P0001) są w
 * `DUPLICATE_DECISION_SQL_TEXTS`. Teksty operatora (2.11.D) — poza przeglądem,
 * w `lib/admin/ksef-operator-policy.ts`.
 */
export const DUPLICATE_DECISION_TEXTS = {
  // Panel decyzji na karcie faktury.
  INTRO: (nr: string, k: string, program: string | null) =>
    `KSeF nie przyjął dokumentu ${nr}, bo ma już fakturę Twojej firmy o tym numerze (numer KSeF ${k}), ${programAccusative(program)}. Faktura w KSeF jest wiążąca — nie da się jej usunąć ani zastąpić. Porównaj dane i zdecyduj, czym jest ten dokument.`,
  PROGRAM_ACCUSATIVE: {
    FAKTFLOW: 'wystawioną w FaktWay',
    OTHER: (x: string) => `wystawioną w programie „${x}”`,
    UNKNOWN: 'wystawioną poza FaktWay',
  },
  PROGRAM_NOMINATIVE: {
    FAKTFLOW: 'wystawiona w FaktWay',
    OTHER: (x: string) => `wystawiona w programie „${x}”`,
    UNKNOWN: 'wystawiona poza FaktWay',
  },
  /** Linia treści: `sameContent` null / true / false. */
  NO_OWN_FILE: 'Treści pozycji nie porównaliśmy — FaktWay nie ma pliku tej próby wysyłki.',
  CONTENT_SAME: 'Treść pozycji jest taka sama jak w fakturze w KSeF — różni się tylko nagłówek pliku.',
  CONTENT_DIFFERENT: 'Treść pozycji różni się od faktury w KSeF.',
  KNOWN_NUMBER_LINE: (k: string, y: string, nr: string) =>
    `W FaktWay numer KSeF ${k} ma już dokument ${y}. Twoja decyzja dotyczy tylko dokumentu ${nr}; jeśli dane dokumentu ${y} nie zgadzają się z fakturą w KSeF, napisz do nas: ${SUPPORT_EMAIL}, podając oba numery.`,
  /** Odnośnik do dokumentu Y (`/invoices/{Y.id}`) — panel, baner, notatka. */
  KNOWN_LINK: DUPLICATE_ORIGINAL_NOTES.KNOWN_LINK,
  COLUMN_KSEF: 'W KSeF',
  COLUMN_OURS: 'Ten dokument',
  DIFFERS: 'różni się',
  ROW_LABELS: {
    number: 'Numer faktury',
    issueDate: 'Data wystawienia',
    buyer: 'Nabywca',
    buyerNip: 'NIP nabywcy',
    gross: 'Kwota brutto',
    program: 'Program',
  },
  BUTTON_SAME: 'To ta sama sprzedaż',
  BUTTON_OTHER: 'To inna sprzedaż',
  SUPPORT: (nr: string) =>
    `Nie wiesz, co wybrać? Napisz do nas: ${SUPPORT_EMAIL}, podając numer ${nr}. Do tego czasu nie wystawiaj tej faktury ponownie.`,

  DIALOG_SAME: {
    TITLE: 'To ta sama sprzedaż?',
    LINE_1: (nrK: string, k: string, program: string | null) =>
      `Fakturą tej sprzedaży zostaje faktura ${nrK} z KSeF (numer KSeF ${k}), ${programNominative(program)} — tam ją rozliczasz i korygujesz.`,
    LINE_1_KNOWN: (nrK: string, k: string, y: string) =>
      `Fakturą tej sprzedaży zostaje faktura ${nrK} z KSeF (numer KSeF ${k}) — w FaktWay ma ją dokument ${y}.`,
    LINE_2: (nr: string) =>
      `Dokument ${nr} w FaktWay zostanie wycofany: zostanie jako szkic, którego nie wyślesz do KSeF ani nie usuniesz.`,
    LINE_3: (k: string) =>
      `FaktWay nie ujmie faktury ${k} w JPK ani w KPiR — jeśli składasz je z FaktWay, uwzględnij ją osobno.`,
    LINE_3_KNOWN: (nr: string, k: string, y: string) =>
      `Dokument ${nr} nie trafi do JPK ani do KPiR w FaktWay. Fakturę ${k} FaktWay zna jako dokument ${y} — sprawdź, czy jego dane zgadzają się z danymi z KSeF w tabeli; jeśli nie, napisz do nas: ${SUPPORT_EMAIL}, podając oba numery.`,
    LINE_4: 'Jeśli to jednak inna sprzedaż, zostanie bez faktury — wystaw ją wtedy jako nową fakturę z nowym numerem.',
    /** Etykieta pola „Rozumiem skutki” (wymaganego, gdy `needsConfirmation.same_sale`, C5), gdy tabela zaznacza różnicę (`markedDifference`). */
    CHECKBOX: (k: string, nr: string) =>
      `Rozumiem skutki: faktura ${k} w KSeF dokumentuje tę samą sprzedaż co dokument ${nr}, mimo różnic zaznaczonych w tabeli.`,
    /** Etykieta tego samego pola bez różnic zaznaczonych w tabeli; pole nadal wymagane — tarcie z danych nieznanych (NIP, kwota, waluta). */
    CHECKBOX_UNCOMPARABLE: (k: string, nr: string) =>
      `Rozumiem skutki: faktura ${k} w KSeF dokumentuje tę samą sprzedaż co dokument ${nr}, choć części danych w tabeli nie da się porównać.`,
    CONFIRM_BUTTON: 'Zapisz: ta sama sprzedaż',
  },
  DIALOG_OTHER: {
    TITLE: 'To inna sprzedaż?',
    LINE_1: (nr: string, k: string) =>
      `Numer ${nr} jest zajęty w KSeF przez fakturę ${k}. Dokument ${nr} w FaktWay zostanie wycofany: zostanie jako szkic, którego nie wyślesz do KSeF ani nie usuniesz.`,
    LINE_2: 'Tę sprzedaż wystawisz jako nową fakturę — z nowym numerem i dzisiejszą datą.',
    LINE_3: 'Jeśli to jednak ta sama sprzedaż, powstaną dwie faktury, a VAT z obu trzeba będzie wykazać, dopóki jednej z nich nie skorygujesz do zera.',
    /** Dopisek do LINE_3 tylko przy `heldCorrections` (KSeF produkcyjny). */
    LINE_3_HELD: ' Korekty do produkcyjnego KSeF są teraz wstrzymane przez FaktWay.',
    /** Program znany (`{X}`). */
    LINE_4: (k: string, x: string) => `FaktWay nie ujmuje faktury ${k} w JPK ani w KPiR — rozliczasz ją w programie „${x}”.`,
    /** Program nieznany (`program` null). */
    LINE_4_UNKNOWN_PROGRAM: (k: string) =>
      `FaktWay nie ujmuje faktury ${k} w JPK ani w KPiR — rozliczasz ją tam, gdzie ją wystawiono.`,
    LINE_4_KNOWN: (k: string, y: string) =>
      `Fakturę ${k} FaktWay zna jako dokument ${y} — sprawdź, czy jego dane zgadzają się z danymi z KSeF w tabeli; jeśli nie, napisz do nas: ${SUPPORT_EMAIL}, podając oba numery.`,
    /** Pole wymagane, gdy `needsConfirmation.other_sale` (C5). */
    CHECKBOX: (k: string, nr: string) => `Rozumiem skutki: faktura ${k} w KSeF dokumentuje inną sprzedaż niż dokument ${nr}.`,
    CONFIRM_BUTTON: 'Zapisz: inna sprzedaż',
  },

  TOAST_SAME: (nr: string) => `Zapisano: ta sama sprzedaż. Dokument ${nr} jest wycofany.`,
  TOAST_OTHER: 'Zapisano: inna sprzedaż. Wystaw ją jako nową fakturę z nowym numerem.',

  // Odmowy w panelu i w akcji klienta (pozostałe — teksty SQL wypełnione numerem).
  ROLE: 'Decyzję, czym jest ten dokument, zapisuje właściciel lub administrator firmy — poproś go o to. Nie wystawiaj tej faktury ponownie.',
  ENV_UNKNOWN: KSEF_SEND_MESSAGES.envUnknown,
  STALE: 'Dane faktury w KSeF zmieniły się od otwarcia strony — odśwież stronę i zdecyduj jeszcze raz.',
  CONFIRM: 'Zaznacz „Rozumiem skutki” i zapisz decyzję jeszcze raz.',
  GENERIC: `Nie udało się zapisać decyzji. Spróbuj ponownie za chwilę; jeśli błąd się powtarza, napisz do nas: ${SUPPORT_EMAIL}.`,

  /** Notatki karty (`describeDuplicateOriginal`, `duplicate-check.ts`). */
  NOTES: DUPLICATE_ORIGINAL_NOTES,

  /** Pasek pod kartą przy `KSEF_DUPLICATE_RECONCILE` (`ksef-send-policy.ts`). */
  BAR_DUPLICATE_PANEL: KSEF_SEND_MESSAGES.duplicatePanel,
  BAR_DUPLICATE: KSEF_SEND_MESSAGES.duplicate,

  /** „Numer zajęty” (`KSEF_NUMBER_TAKEN`): pasek i toasty po „Wróć do szkicu” (`ksef-send-policy.ts`, C4). */
  NUMBER_TAKEN: {
    BAR: KSEF_SEND_MESSAGES.numberTaken,
    RESET_DONE_REGULAR: KSEF_SEND_MESSAGES.numberTakenResetDone,
    RESET_DONE_ADVANCE: S.numberTakenResetDone('advance'),
    RESET_DONE_CORRECTION: S.numberTakenResetDoneDeletable('correction'),
    RESET_DONE_CORRECTION_HELD: S.numberTakenResetDoneDeletableHeld('correction'),
    RESET_DONE_FINAL: S.numberTakenResetDoneDeletable('final'),
    RESET_DONE_FINAL_HELD: S.numberTakenResetDoneDeletableHeld('final'),
  },
  /** `last_error` „numer zajęty” (`numberTakenMessage`); `{opis}` — numer KSeF, data, nabywca, kwota oryginału. */
  NUMBER_TAKEN_LAST_ERROR: (nr: string, opis: string, x: string) =>
    `W KSeF jest już faktura Twojej firmy o numerze ${nr} (${opis}), wystawiona w programie „${x}”. Tego dokumentu nie wyślesz do KSeF. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie (zmiany: korekta tamtej faktury). Jeśli to inna sprzedaż — wystaw ją jako nową fakturę z nowym numerem.`,
  NUMBER_TAKEN_LAST_ERROR_UNKNOWN_PROGRAM: (nr: string, opis: string) =>
    `W KSeF jest już faktura Twojej firmy o numerze ${nr} (${opis}), wystawiona poza FaktWay. Tego dokumentu nie wyślesz do KSeF. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie (zmiany: korekta tamtej faktury). Jeśli to inna sprzedaż — wystaw ją jako nową fakturę z nowym numerem.`,
  /** `last_error` werdyktu `known-number` (`knownNumberVerdictMessage`, C16): oryginał nie może być naszą wysyłką. */
  KNOWN_NUMBER_LAST_ERROR: (k: string, y: string) =>
    `KSeF ma już fakturę o tym numerze (numer KSeF ${k}), a w FaktWay ten numer KSeF ma dokument ${y} — do rozstrzygnięcia na karcie faktury (ta sama czy inna sprzedaż); nie wystawiaj jej ponownie.`,
  /** To samo, gdy oryginał może być wcześniejszą wysyłką tego dokumentu (`ownHistory`) — klient nie decyduje. */
  KNOWN_NUMBER_LAST_ERROR_OWN: (k: string, y: string) =>
    `KSeF ma już fakturę o tym numerze (numer KSeF ${k}), a w FaktWay ten numer KSeF ma dokument ${y}; faktura w KSeF może być wcześniejszą wysyłką tego dokumentu z FaktWay — wyjaśnia to pomoc FaktWay; nie wystawiaj jej ponownie.`,

  // Baner szkicu wycofanego — każdy rodzaj (decyzja 9). `{data}` = formatWarsawDateTime(decision.at).
  BANNER_TITLE: (nr: string) => `Dokument wycofany — numer ${nr} jest zajęty w KSeF`,
  /** `{via}` przy decyzji zapisanej przez operatora. */
  BANNER_VIA_OPERATOR: ' (zapisała pomoc FaktWay na Twoją prośbę)',
  BANNER_SAME: (data: string, via: string, nrK: string, k: string, program: string | null) =>
    `Zapisano ${data}${via}: to ta sama sprzedaż co faktura ${nrK} w KSeF (numer KSeF ${k}), ${programNominative(program)}. Tam ją rozliczasz i korygujesz; FaktWay nie ujmuje jej w JPK ani w KPiR. Tego dokumentu nie wyślesz do KSeF. Jeśli to jednak inna sprzedaż, wystaw ją jako nową fakturę z nowym numerem.`,
  BANNER_SAME_KNOWN: (data: string, via: string, nrK: string, k: string, y: string) =>
    `Zapisano ${data}${via}: to ta sama sprzedaż co faktura ${nrK} w KSeF (numer KSeF ${k}), którą w FaktWay ma dokument ${y}. Tego dokumentu nie wyślesz do KSeF. Jeśli to jednak inna sprzedaż, wystaw ją jako nową fakturę z nowym numerem.`,
  BANNER_OTHER: (data: string, via: string, k: string, nr: string) =>
    `Zapisano ${data}${via}: to inna sprzedaż niż faktura ${k} w KSeF. Wystaw ją jako nową fakturę — z nowym numerem i dzisiejszą datą. Tego dokumentu nie wyślesz do KSeF ani nie usuniesz; numer ${nr} zostaje przy nim, żeby FaktWay nie podpowiedział go ponownie.`,
  /** Automatyczny „numer zajęty”, zwykła faktura; `k` null — bez „(numer KSeF …)”. */
  BANNER_AUTO: (nr: string, k: string | null) =>
    `KSeF ma już fakturę Twojej firmy o numerze ${nr}${ksefNumberPart(k)}, wystawioną poza FaktWay — tego dokumentu nie wyślesz do KSeF ani nie usuniesz; numer zostaje przy nim, żeby FaktWay nie podpowiedział go ponownie. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie (zmiany: korekta tamtej faktury w programie, w którym ją wystawiono). Jeśli inna — wystaw ją jako nową fakturę z nowym numerem.`,
  BANNER_AUTO_ADVANCE: (nr: string, k: string | null) =>
    `KSeF ma już dokument Twojej firmy o numerze ${nr}${ksefNumberPart(k)}, wystawiony poza FaktWay — tej faktury zaliczkowej nie wyślesz do KSeF ani nie usuniesz; numer zostaje przy niej, żeby FaktWay nie podpowiedział go ponownie. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie. Jeśli inna — wystaw nową fakturę zaliczkową z nowym numerem.`,
  /** Korekta i faktura rozliczeniowa: `{G}`/`{A}` — dopełniacz i biernik z `SPECIAL_KIND_LABEL`. */
  BANNER_AUTO_DELETABLE: (nr: string, k: string | null, g: string, a: string) =>
    `KSeF ma już dokument Twojej firmy o numerze ${nr}${ksefNumberPart(k)}, wystawiony poza FaktWay — tego szkicu ${g} nie wyślesz do KSeF. Jeśli w KSeF jest ten sam dokument — nie wystawiaj go ponownie. Jeśli inny — usuń ten szkic („Usuń szkic”) i wystaw ${a} od nowa z nowym numerem.`,
  BANNER_AUTO_DELETABLE_HELD: (nr: string, k: string | null, g: string, a: string) =>
    `KSeF ma już dokument Twojej firmy o numerze ${nr}${ksefNumberPart(k)}, wystawiony poza FaktWay — tego szkicu ${g} nie wyślesz do KSeF. Jeśli w KSeF jest ten sam dokument — nie wystawiaj go ponownie. Jeśli inny — usuń ten szkic („Usuń szkic”), a po zdjęciu blokady wysyłki wystaw ${a} od nowa z nowym numerem.`,
  CTA_REGULAR: { href: '/invoices/new/regular', label: 'Wystaw nową fakturę' },
  CTA_ADVANCE: { href: '/invoices/new/advance', label: 'Wystaw nową fakturę zaliczkową' },

  /** `window.confirm` przy „Usuń szkic” wycofanej korekty albo faktury rozliczeniowej. */
  RETIRED_DELETE_CONFIRM: 'Usunąć wycofany szkic? Numer tego dokumentu jest zajęty w KSeF — nowy dokument wystaw z nowym numerem.',
  /** Odmowa e-maila do nabywcy (decyzja 10). */
  RETIRED_EMAIL_REFUSAL: (nr: string) =>
    `Dokumentu ${nr} nie wyślesz e-mailem: jest wycofany, bo jego numer jest zajęty w KSeF przez inną fakturę, więc nie jest fakturą dla nabywcy. Jeśli to inna sprzedaż, wystaw nową fakturę z nowym numerem i wyślij ją.`,
  /** Odczyt wpisów `number_taken` nieudany (wysyłka, usunięcie, e-mail — fail-closed). */
  HISTORY_READ_FAILED: 'Nie udało się sprawdzić historii wysyłki tej faktury — spróbuj ponownie za chwilę.',

  // Powiadomienie „czeka na Twoją decyzję” (2.11.C): e-mail raz na (faktura, K) i przypomnienie operatora.
  NOTICE: {
    SUBJECT: (nr: string) => `Faktura ${nr} czeka na Twoją decyzję`,
    REMINDER_SUBJECT: (nr: string) => `Przypomnienie: faktura ${nr} czeka na Twoją decyzję`,
    BODY: (nr: string, k: string) =>
      `KSeF nie przyjął faktury ${nr}, bo ma już fakturę Twojej firmy o tym numerze (numer KSeF ${k}). Otwórz fakturę w FaktWay, porównaj dane i zdecyduj, czy to ta sama sprzedaż, czy inna. Do tego czasu nie wystawiaj jej ponownie. Pytania: ${SUPPORT_EMAIL}.`,
    BUTTON: 'Otwórz fakturę',
    PUSH_TITLE: (nr: string) => `Faktura ${nr} czeka na Twoją decyzję`,
    PUSH_BODY: 'KSeF ma już fakturę o tym numerze — porównaj dane i zdecyduj.',
  },

  // ── PR C (00156): oryginał z oznaczeniem FaktWay (`faktflow-original`) — spec v3 6.2, słowo w słowo;
  // lista prawnika przed KSeF PROD (6.7). Znaczniki: `{nr}` dokument, `{k}` numer KSeF oryginału,
  // `{nrK}` numer faktury z KSeF (`summary.number ?? nr`), `{nrOld}` dawny numer wycofanego dokumentu,
  // `{okres}` = `preview.period`, `{dzien}` = `originalAssignedDay`, `{data}` = formatWarsawDateTime(decision.at),
  // `{via}` = `BANNER_VIA_OPERATOR` przy operatorze. Teksty PR B używane bez zmian — 6.2, akapit końcowy.
  FAKTFLOW: {
    // Panel — para
    INTRO_PAIR: (nr: string, k: string) =>
      `KSeF nie przyjął dokumentu ${nr}, bo ma już fakturę Twojej firmy o tym numerze (numer KSeF ${k}) z oznaczeniem FaktWay. Faktura w KSeF jest wiążąca — nie da się jej usunąć ani zastąpić. Porównaj dane i zdecyduj, czym jest ten dokument.`,
    NOT_RECORDED: 'W FaktWay nie ma zapisu tej faktury — najpewniej jej dokument usunięto, zanim FaktWay zapisał potwierdzenie z KSeF.',
    LEDGER: (k: string, okres: string) =>
      `Do czasu decyzji FaktWay nie ujmuje faktury ${k} w JPK ani w KPiR — nie składaj z FaktWay JPK_V7 za ${okres}, dopóki jej nie zapiszesz. Po decyzji zapiszemy ją w FaktWay z danymi z KSeF i trafi do JPK i KPiR za ${okres}.`,
    // Panel — jeden przycisk
    INTRO_RECORD_OWN: (nr: string, k: string, dzien: string | null, nrK: string) =>
      `W KSeF jest wcześniejsza wersja dokumentu ${nr}, wysłana z FaktWay (numer KSeF ${k}${dzien ? `, numer nadany ${dzien}` : ''}). To ona jest wystawioną fakturą i obowiązują jej dane — faktury w KSeF nie da się usunąć ani zastąpić. Zapiszemy ją w FaktWay jako fakturę ${nrK}, a ten dokument wycofamy bez numeru; zmiany wprowadzisz korektą faktury ${nrK}.`,
    INTRO_RECORD_SAME: (nr: string, k: string, dzien: string | null) =>
      `W KSeF jest już faktura ${nr} z oznaczeniem FaktWay (numer KSeF ${k}${dzien ? `, numer nadany ${dzien}` : ''}) o tej samej treści co ten dokument — różni się tylko nagłówek pliku. Najpewniej to wcześniejsza wysyłka, której wyniku FaktWay nie zapisał.`,
    ROW_SALE_DATE: 'Data sprzedaży',
    ANNOTATIONS: (lista: string) => `Oznaczenia faktury w KSeF: ${lista}.`,
    ANNOTATION_LABELS: {
      cashMethod: 'metoda kasowa',
      splitPayment: 'mechanizm podzielonej płatności',
      reverseCharge: 'odwrotne obciążenie',
      exemption: (podstawa: string) => `zwolnienie z VAT (${podstawa})`,
    },
    LINES_TOGGLE: (n: number) => `Pozycje faktury w KSeF (${n})`,
    LINES_MORE: (m: number) => `…i jeszcze ${m} — pełną treść ma plik faktury w KSeF.`,
    LINES_COLUMNS: { name: 'Nazwa', quantity: 'Ilość', unitPriceNet: 'Cena netto', vatRate: 'Stawka VAT', gross: 'Brutto' },
    BUTTON_RECORD: 'Zapisz fakturę z KSeF w FaktWay',
    // Dialogi
    DIALOG_SAME: {
      LINE_1: (nrK: string, k: string, okres: string) =>
        `Fakturą tej sprzedaży jest faktura ${nrK} z KSeF (numer KSeF ${k}). Zapiszemy ją w FaktWay z danymi z KSeF — trafi do JPK i KPiR za ${okres}; w FaktWay ją rozliczasz i korygujesz.`,
      LINE_2: (nr: string) =>
        `Dokument ${nr} wycofamy: zostanie w FaktWay jako szkic bez numeru, którego nie wyślesz do KSeF ani nie usuniesz. Numer ${nr} przejdzie na fakturę z KSeF.`,
    },
    DIALOG_OTHER: {
      LINE_1: (nrK: string, k: string, okres: string) =>
        `Faktura ${nrK} z KSeF (numer KSeF ${k}) dokumentuje inną sprzedaż i jest wystawiona — obowiązuje, bo jest w KSeF. Zapiszemy ją w FaktWay z danymi z KSeF — trafi do JPK i KPiR za ${okres}.`,
      LINE_2: (nr: string) =>
        `Dokument ${nr} wycofamy: zostanie w FaktWay jako szkic bez numeru, którego nie wyślesz do KSeF ani nie usuniesz. Sprzedaż z tego dokumentu wystawisz jako nową fakturę — z nowym numerem i dzisiejszą datą.`,
      ALREADY_REISSUED: 'Jeśli sprzedaż z tego dokumentu jest już wystawiona ponownie pod innym numerem, nie wystawiaj kolejnej faktury.',
      ZERO: (nrK: string) => `Jeśli sprzedaż z faktury ${nrK} nie doszła do skutku, fakturę ${nrK} trzeba skorygować do zera.`,
    },
    DIALOG_RECORD: {
      TITLE: (nrK: string) => `Zapisać fakturę ${nrK} z KSeF w FaktWay?`,
      LINE_1: (nrK: string, okres: string) =>
        `Zapiszemy w FaktWay fakturę ${nrK} z danymi z KSeF — trafi do JPK i KPiR za ${okres}. To ona jest fakturą tej sprzedaży.`,
      LINE_2: (nr: string) =>
        `Dokument ${nr} wycofamy: zostanie w FaktWay jako szkic bez numeru, którego nie wyślesz do KSeF ani nie usuniesz. Numer ${nr} przejdzie na fakturę z KSeF.`,
      LINE_DIFF: (nrK: string) => `Dane z KSeF różnią się od tego dokumentu. Obowiązują dane z KSeF — zmienisz je tylko korektą faktury ${nrK}.`,
      CHECKBOX: (k: string, nr: string) => `Rozumiem skutki: obowiązują dane faktury ${k} z KSeF, nie dane dokumentu ${nr}.`,
      CONFIRM_BUTTON: 'Zapisz fakturę z KSeF',
    },
    REISSUED: 'Jeśli sprzedaż z tego dokumentu jest już wystawiona ponownie pod innym numerem, są teraz dwie faktury tej samej sprzedaży — fakturę wystawioną ponownie trzeba skorygować do zera.',
    CORRECTION_PERSON: ` Korekty faktury dla nabywcy bez NIP i bez numeru VAT-UE FaktWay jeszcze nie wystawia — jeśli trzeba ją skorygować, napisz do nas: ${SUPPORT_EMAIL}.`,
    // D-A4-1b-3-KORZW: pozycja zw (do C3), stawka FA(3) spoza FaktWay albo pozycja bez ceny netto. Krótko, bez długiego myślnika.
    CORRECTION_RATE: (nrK: string) =>
      ` Korekt faktury ${nrK} z pozycją o stawce zwolnionej, o stawce spoza FaktWay albo bez ceny netto jeszcze nie wystawiamy. Jeśli trzeba coś w niej zmienić, napisz do nas: ${SUPPORT_EMAIL}.`,
    SALE_DATE_AS_ISSUE: 'jak data wystawienia',
    DATA_FROM_KSEF: (nrK: string) => `Obowiązują dane z KSeF. Jeśli trzeba je zmienić, wystaw korektę faktury ${nrK}.`,
    HELD_CORRECTIONS: ` Korekty do produkcyjnego KSeF są teraz wstrzymane przez FaktWay — napisz do nas: ${SUPPORT_EMAIL}.`,
    BUYER_DIFFERS: (nrK: string) =>
      `Nabywca w KSeF jest inny niż w tym dokumencie. Jeśli tę sprzedaż dostał inny nabywca, fakturę ${nrK} trzeba skorygować do zera, a sprzedaż wystawić jako nową fakturę z nowym numerem.`,
    PAST_PERIOD: (okres: string) =>
      `Jeśli JPK_V7 za ${okres} jest już złożony albo KPiR za ten miesiąc zamknięta bez tej faktury, sprawdź z księgową, czy trzeba je skorygować.`,
    TOAST_SAME: (nrK: string) => `Zapisano: ta sama sprzedaż. Faktura ${nrK} z KSeF jest w FaktWay.`,
    TOAST_OTHER: (nrK: string) => `Zapisano: inna sprzedaż. Faktura ${nrK} z KSeF jest w FaktWay — sprzedaż z wycofanego dokumentu wystaw jako nową fakturę z nowym numerem, jeśli nie jest już wystawiona.`,
    TOAST_RECORD: (nrK: string) => `Zapisano fakturę ${nrK} z KSeF w FaktWay.`,
    // Po oddaniu przez operatora (FO-ODDANA)
    RELEASED_NOTE: 'Plik tej faktury w KSeF ma oznaczenie FaktWay, ale sprawdziliśmy go: nie powstał w FaktWay. Rozstrzygnij ją jak fakturę z innego programu — FaktWay jej nie zapisze.',
    PROGRAM_RELEASED: 'oznaczenie FaktWay — plik nie powstał w FaktWay',
    // Odmowy w akcji i na stronie
    // Odmowa w chwili zapisu (archiwum, inna ocena pliku, niezgodność projekcji) — zawsze ze znacznikiem recheckNeeded (INV-25)
    RECHECK: (nr: string) =>
      `Fakturę z KSeF dla dokumentu ${nr} musimy sprawdzić jeszcze raz — tej decyzji nie zapiszesz teraz. Sprawdzimy ją automatycznie, zwykle w ciągu 2 dni; potem decyzję zapiszesz na karcie dokumentu. Nie wystawiaj go ponownie; jeśli ten komunikat zostanie dłużej, napisz do nas: ${SUPPORT_EMAIL}.`,
    READ_FAILED: (nr: string) =>
      `Nie udało się teraz sprawdzić faktury z KSeF dla dokumentu ${nr} — odśwież stronę za chwilę. Nie wystawiaj go ponownie.`,
    // Szkic wycofany po zapisie (karta X)
    BANNER_TITLE: (nrOld: string) => `Dokument wycofany — numer ${nrOld} ma teraz faktura z KSeF`,
    BANNER_SAME: (data: string, via: string, nrK: string, k: string) =>
      `Zapisano ${data}${via}: to ta sama sprzedaż co faktura ${nrK} z KSeF (numer KSeF ${k}). Zapisaliśmy ją w FaktWay — przy niej zapisujesz wpłaty i wystawiasz korekty. Tego dokumentu nie wyślesz do KSeF ani nie usuniesz. Jeśli sprzedaż z tego dokumentu jest jednak inna, wystaw ją jako nową fakturę z nowym numerem — chyba że jest już wystawiona.`,
    BANNER_OTHER: (data: string, via: string, nrK: string, k: string) =>
      `Zapisano ${data}${via}: to inna sprzedaż niż faktura ${nrK} z KSeF (numer KSeF ${k}) — zapisaliśmy ją w FaktWay jako osobną fakturę. Sprzedaż z tego dokumentu wystaw jako nową fakturę — z nowym numerem i dzisiejszą datą; jeśli jest już wystawiona ponownie pod innym numerem, nie wystawiaj kolejnej. Tego dokumentu nie wyślesz do KSeF ani nie usuniesz. Jeśli to jednak ta sama sprzedaż: nie wystawiaj nowej faktury — fakturą tej sprzedaży jest faktura ${nrK}; jeśli nową już wystawiono, trzeba ją skorygować do zera.`,
    BANNER_RECORD: (data: string, via: string, nrK: string, k: string) =>
      `Zapisano ${data}${via}: fakturą tej sprzedaży jest faktura ${nrK} z KSeF (numer KSeF ${k}), zapisana w FaktWay — przy niej zapisujesz wpłaty i wystawiasz korekty. Tego dokumentu nie wyślesz do KSeF ani nie usuniesz. Jeśli sprzedaż z tego dokumentu jest jednak inna, wystaw ją jako nową fakturę z nowym numerem — chyba że jest już wystawiona.`,
    IMPORTED_LINK: (nrK: string) => `Zobacz fakturę ${nrK}`,
    RETIRED_DOCUMENT_REFUSAL: (nrOld: string) =>
      `Wycofany dokument (dawniej ${nrOld}) nie jest fakturą — numer ${nrOld} ma teraz faktura z KSeF zapisana w FaktWay. Nie pobierzesz PDF tego dokumentu ani nie wyślesz go e-mailem; pobierz PDF faktury ${nrOld}.`,
    RETIRED_PDF_LINK: (nrOld: string) => `Pobierz PDF faktury ${nrOld}`,
    // Karta faktury z KSeF (K)
    IMPORTED_CARD: (data: string, via: string, nrOld: string, wybor: string) =>
      `Faktura zapisana z KSeF ${data}${via}: KSeF nie przyjął dokumentu ${nrOld} z FaktWay, bo miał już fakturę o tym numerze (${wybor}).`,
    IMPORTED_CARD_CHOICE: { same_sale: 'ta sama sprzedaż', other_sale: 'inna sprzedaż', record: 'zapis faktury z KSeF' },
    IMPORTED_CARD_RETIRED_LINK: 'Zobacz wycofany dokument',
    IMPORTED_CARD_REMINDERS: 'Przypomnienia o płatności nie obejmują faktur zapisanych z KSeF.',
    IMPORTED_CARD_PAYMENTS: 'Jeśli nabywca już zapłacił za tę fakturę, zapisz wpłatę przy niej.',
    // Powiadomienia
    NOTICE_BODY_RECORD: (nr: string, k: string) =>
      `KSeF nie przyjął faktury ${nr}, bo ma już jej wersję z oznaczeniem FaktWay (numer KSeF ${k}). Otwórz fakturę w FaktWay i zapisz fakturę z KSeF — do tego czasu nie trafi ona do JPK ani KPiR. Nie wystawiaj jej ponownie. Pytania: ${SUPPORT_EMAIL}.`,
    NOTICE_PUSH_BODY_RECORD: 'KSeF ma już tę fakturę z oznaczeniem FaktWay — zapisz ją w FaktWay.',
    NOTICE_BODY_RELEASED: (nr: string, k: string) =>
      `Sprawdziliśmy fakturę z KSeF (numer KSeF ${k}), przez którą KSeF nie przyjął dokumentu ${nr}: ma oznaczenie FaktWay, ale nie powstała w FaktWay. Otwórz dokument w FaktWay, porównaj dane i zdecyduj, czy to ta sama sprzedaż, czy inna — FaktWay tej faktury nie zapisze. Do tego czasu nie wystawiaj dokumentu ponownie. Pytania: ${SUPPORT_EMAIL}.`,
    NOTICE_REVIEW_SUBJECT: (nr: string) => `Faktura ${nr}: sprawdzamy fakturę z KSeF`,
    NOTICE_BODY_REVIEW: (nr: string, k: string) =>
      `KSeF nie przyjął faktury ${nr}, bo ma już fakturę Twojej firmy o tym numerze (numer KSeF ${k}). Sprawdzamy fakturę z KSeF — nie wystawiaj jej ponownie, damy znać. Pytania: ${SUPPORT_EMAIL}.`,
    NOTICE_PUSH_TITLE_REVIEW: (nr: string) => `Faktura ${nr}: sprawdzamy fakturę z KSeF`,
    NOTICE_PUSH_BODY_REVIEW: 'Nie wystawiaj jej ponownie — damy znać.',
    // last_error werdyktu (runner, 5.1)
    LAST_ERROR: (k: string) =>
      `KSeF ma już fakturę o tym numerze z oznaczeniem FaktWay (numer KSeF ${k}) — szczegóły są na karcie faktury; nie wystawiaj jej ponownie.`,
    LAST_ERROR_REVIEW: (k: string) =>
      `KSeF ma już fakturę o tym numerze z oznaczeniem FaktWay (numer KSeF ${k}). Sprawdzamy fakturę z KSeF — nie wystawiaj jej ponownie, damy znać.`,
  },

  /**
   * D-A4-1b-3 PR D: „Sprawdź ponownie” przy braku danych oryginału (pobranie, magazyn, archiwum, brak zapisu
   * sprawdzenia, inne środowisko KSeF). Lista prawnika (plan zero zgubionych faktur, sekcja 8). Nowe teksty
   * bez długich myślników; adres pomocy tylko przez `SUPPORT_EMAIL`. `{nr}` numer dokumentu, `{k}` numer KSeF
   * oryginału, `{dzien}` dzień nadania numeru (RRRR-MM-DD, może brakować), `{minuty}` minuty do końca cooldownu.
   */
  RECHECK: {
    BUTTON: 'Sprawdź ponownie',
    NO_REISSUE: 'Nie wystawiaj tej faktury ponownie.',
    INTRO: (nr: string, k: string, dzien: string | null) =>
      `KSeF ma już fakturę Twojej firmy o numerze dokumentu ${nr} (numer KSeF ${k}${dzien ? `, numer nadany ${dzien}` : ''}). Nie mamy jeszcze jej treści, więc nie możesz teraz zdecydować, czym jest ten dokument.`,
    /** Co robi przycisk; tylko tam, gdzie przycisk jest. */
    WHAT_NEXT:
      'Wybierz „Sprawdź ponownie”: pobierzemy tę fakturę z KSeF jeszcze raz, a wynik zobaczysz na tej karcie. Robimy to także automatycznie, zwykle w ciągu 2 dni.',
    /**
     * Odmowa pobrania 403: dane logowania KSeF w FaktWay bez uprawnienia do odczytu faktur. Klient łączy FaktWay
     * z KSeF certyfikatem (tokenu nie ma gdzie nadać), więc rada jak w nocie PR B (`describeDuplicateOriginal`).
     */
    HINT_403:
      'Dane logowania KSeF w FaktWay nie mają uprawnienia do odczytu faktur (InvoiceRead). Sprawdź uprawnienia w Aplikacji Podatnika KSeF albo podłącz KSeF ponownie w Ustawieniach → KSeF, a potem wybierz „Sprawdź ponownie”.',
    /** Inne środowisko niż obecne: dane oryginału sprawdziliśmy gdzie indziej. */
    ENV_MISMATCH:
      'Dane oryginału pochodzą z innego środowiska KSeF niż to, w którym FaktWay pracuje teraz. Sprawdź ponownie, żeby pobrać fakturę z obecnego środowiska.',
    ROLE:
      'Ponowne sprawdzenie w KSeF uruchamia właściciel lub administrator firmy. Poproś właściciela lub administratora firmy o kliknięcie „Sprawdź ponownie”. Nie wystawiaj tej faktury ponownie.',
    IN_FLIGHT: (nr: string) => `Sprawdzamy ponownie w KSeF dokument ${nr}. Odśwież stronę za kilka minut.`,
    COOLDOWN: (nr: string, minuty: number) =>
      `Dokument ${nr} sprawdziliśmy w KSeF przed chwilą. Kolejne sprawdzenie możesz uruchomić za ${minuty} min. Nie wystawiaj go ponownie.`,
    QUEUED: (nr: string) => `Sprawdzamy dokument ${nr} ponownie w KSeF. Odśwież stronę za kilka minut.`,
    NOT_AVAILABLE: (nr: string) =>
      `Dokumentu ${nr} nie sprawdzimy ponownie z tego miejsca. Odśwież stronę; jeśli komunikat wraca, napisz do nas: ${SUPPORT_EMAIL}, podając numer dokumentu. Nie wystawiaj go ponownie.`,
    CANNOT: (nr: string) =>
      `Dokumentu ${nr} nie możemy teraz sprawdzić ponownie z tego miejsca. Napisz do nas: ${SUPPORT_EMAIL}, podając numer dokumentu. Nie wystawiaj go ponownie.`,
    PAUSED: (nr: string) =>
      `Wysyłka do KSeF jest chwilowo wstrzymana przez FaktWay, więc dokumentu ${nr} nie sprawdziliśmy ponownie. Spróbuj ponownie, gdy wysyłka zostanie przywrócona. Nie wystawiaj go ponownie.`,
    PAUSE_UNKNOWN: (nr: string) =>
      `Nie możemy sprawdzić, czy KSeF jest teraz dostępny, więc dokumentu ${nr} nie sprawdziliśmy ponownie. Spróbuj ponownie za chwilę. Nie wystawiaj go ponownie.`,
    /** `KSEF_ENV` nieustawione albo niepoprawne: o sprawdzaniu (nie o wysyłce), z numerem dokumentu (D4). */
    ENV_UNKNOWN: (nr: string) =>
      `Nie możemy teraz potwierdzić środowiska KSeF po stronie FaktWay, więc dokumentu ${nr} nie sprawdziliśmy ponownie. Odśwież stronę za kilka minut; jeśli komunikat się powtarza, napisz do nas: ${SUPPORT_EMAIL}, podając numer dokumentu. Nie wystawiaj go ponownie.`,
    NO_CERTIFICATE: (nr: string) =>
      `Brak certyfikatu KSeF: dokumentu ${nr} nie sprawdziliśmy ponownie. Wgraj certyfikat w Ustawieniach KSeF i spróbuj jeszcze raz. Nie wystawiaj go ponownie.`,
    /** Odmowa kolejki, której tekst nie nazywa dokumentu: numer z przodu. */
    REFUSED: (nr: string, powod: string) => `Dokumentu ${nr} nie sprawdziliśmy ponownie. ${powod}`,
    GENERIC: `Nie udało się uruchomić ponownego sprawdzenia. Spróbuj ponownie za chwilę; jeśli błąd się powtarza, napisz do nas: ${SUPPORT_EMAIL}.`,
  },
} as const;
