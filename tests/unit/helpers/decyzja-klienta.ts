/**
 * D-A4-1b-3 PR B — wspólne dane testów decyzji klienta przy nierozstrzygniętym
 * duplikacie 440 i szkicu wycofanym (akcja klienta, szkic, strona, ekrany,
 * e-mail do nabywcy).
 *
 * Teksty to kopia słowo w słowo tabel 2.11 specyfikacji PR B (decyzje Bartosza
 * 07.10.2026). Po stronie kodu żyją w `lib/ksef/duplicate-decision.ts`
 * (`DUPLICATE_DECISION_TEXTS`, `DUPLICATE_DECISION_SQL_TEXTS`) i w 00148 / 00151 —
 * przechodzą przegląd prawnika przed KSeF PROD (decyzje A i 8). Zmiana tekstu
 * po przeglądzie = zmiana tutaj, w module i w migracji.
 *
 * Test NIE importuje modułu decyzji: na main (f49e687) go nie ma, a import
 * brakującego pliku wywróciłby cały plik testów razem ze strażnikami. Teksty
 * są więc tu, a typy widoków — lokalne, w kształcie z 2.2.1.
 */

// ─── Dane: numery, skróty, identyfikatory ───────────────────────────────────

/** Numer KSeF faktury, którą KSeF ma już pod naszym numerem (fikcyjny NIP 1234567890). */
export const K = '1234567890-20261001-0100A0B0C0D0-1A';
/** Inny numer KSeF — „stary” albo drugi oryginał. */
export const K2 = '1234567890-20260930-0200B0C0D0E0-2B';
/** SHA-256 (hex) bajtów oryginału zapisany przy sprawdzeniu. */
export const SHA_K = 'bb'.repeat(32);
/** SHA-256 (hex) naszego pliku próby. */
export const SHA_OURS = 'aa'.repeat(32);
/** Faktura sprzedaży w FaktWay, która ma numer KSeF oryginału (known-number). */
export const Y_ID = '44444444-4444-4444-8444-444444444441';
export const Y_NR = 'FV/INNA/1';

export const DECIDED_AT = '2026-10-02T08:30:00.000Z';

type Row = Record<string, unknown>;

/** `ksef_submissions.original_check` (00144) dla powodu `no-own-file` z kompletnymi danymi oryginału. */
export function duplicateCheck(patch: Row = {}): Row {
  return {
    v: 1,
    env: 'test',
    checkedAt: '2026-10-01T10:05:00.000Z',
    reason: 'no-own-file',
    sha256: SHA_K,
    archivePath: `firma/ksef-import/${K}.xml`,
    sizeBytes: 2048,
    summary: {
      systemInfo: 'Inny Program 1.0',
      number: 'FV/12/10/2026',
      issueDate: '2026-10-01',
      buyerNip: '1234567890',
      buyerName: 'Nabywca testowy',
      gross: '123.00',
      currency: 'PLN',
    },
    sameContentExceptHeader: null,
    ownHistory: false,
    acquiredAt: '2026-09-30T08:00:00.000Z',
    httpStatus: null,
    knownInvoice: null,
    recheck: null,
    ...patch,
  };
}

/** Sprawdzenie `known-number`: oryginał pobrany (PR B), numer KSeF ma faktura Y. */
export function knownNumberCheck(patch: Row = {}): Row {
  return duplicateCheck({
    reason: 'known-number',
    sameContentExceptHeader: true,
    knownInvoice: { id: Y_ID, internalNumber: Y_NR },
    ...patch,
  });
}

/** Otwarty wpis próby ze znacznikiem 440 (marker) — jak zostawia go runner przed `KSEF_DUPLICATE_RECONCILE`. */
export function markerRow(tenantId: string, invoiceId: string, patch: Row = {}): Row {
  return {
    id: `sub-${invoiceId.slice(-4)}-marker`,
    tenant_id: tenantId,
    invoice_id: invoiceId,
    status: 'sent',
    error_code: '440',
    session_reference_number: 'SES-OWN-1',
    request_payload_hash: SHA_OURS,
    response_ksef_number: null,
    original_ksef_number: K,
    original_session_reference_number: 'SES-ORIG-1',
    original_check: duplicateCheck(),
    attempted_at: '2026-10-01T10:00:00.000Z',
    completed_at: null,
    ...patch,
  };
}

export type RetiredRowShape = 'decided-other' | 'decided-same' | 'automatic' | 'unmarked';

/**
 * Wpis `number_taken` szkicu wycofanego (00148):
 *  - `decided-*` — decyzja klienta (`original_check.decision`),
 *  - `automatic` — automatyczny werdykt KSEF_NUMBER_TAKEN, z numerem KSeF oryginału,
 *  - `unmarked` — starsza próba bez znacznika (`markKsefSubmissionsNumberTaken` zamyka i ją).
 */
export function numberTakenRow(tenantId: string, invoiceId: string, shape: RetiredRowShape, patch: Row = {}): Row {
  const base: Row = {
    id: `sub-${invoiceId.slice(-4)}-${shape}`,
    tenant_id: tenantId,
    invoice_id: invoiceId,
    status: 'number_taken',
    error_code: 'NUMBER_TAKEN',
    session_reference_number: `SES-${shape}`,
    request_payload_hash: SHA_OURS,
    response_ksef_number: null,
    original_ksef_number: K,
    original_session_reference_number: 'SES-ORIG-1',
    original_check: null,
    attempted_at: '2026-10-01T10:00:00.000Z',
    completed_at: '2026-10-02T08:30:00.000Z',
  };
  if (shape === 'decided-other' || shape === 'decided-same') {
    base.original_check = duplicateCheck({
      decision: {
        choice: shape === 'decided-other' ? 'other_sale' : 'same_sale',
        via: 'client',
        at: DECIDED_AT,
        reason: 'no-own-file',
        env: 'test',
      },
    });
  }
  if (shape === 'unmarked') {
    base.original_ksef_number = null;
    base.original_session_reference_number = null;
    base.attempted_at = '2026-09-30T10:00:00.000Z';
    base.completed_at = '2026-10-02T09:00:00.000Z';
  }
  return { ...base, ...patch };
}

// ─── Teksty: wypełnianie szablonów SQL (2.11.A, RAISE z własnymi „%”) ───────

/** `fillSqlText` z 2.2.1: każdy `%` po kolei, liczba argumentów musi się zgadzać (C1). */
export function fill(template: string, ...args: string[]): string {
  const parts = template.split('%');
  if (parts.length - 1 !== args.length) {
    throw new Error(`szablon ma ${parts.length - 1} znaczników, podano ${args.length} argumentów: ${template}`);
  }
  return parts.reduce((out, part, i) => out + part + (i < args.length ? args[i] : ''), '');
}

export const SQL = {
  kind: 'Dokument % to korekta, faktura zaliczkowa albo rozliczeniowa — tej decyzji nie zapiszesz jeszcze w FaktWay. Nie wystawiaj go ponownie i napisz do nas: pomoc@faktway.pl, podając numer dokumentu.',
  knownStale: 'Dokument w FaktWay, który ma albo miał numer KSeF %, nie zgadza się już z naszym zapisem — sprawdzimy fakturę w KSeF ponownie automatycznie (zwykle w ciągu 2 dni). Jeśli ten komunikat zostanie dłużej, napisz do nas: pomoc@faktway.pl. Nie wystawiaj dokumentu % ponownie.',
  payments: 'Na dokumencie % są zapisane wpłaty — decyzji nie zapiszemy, dopóki wpłaty są przy tym dokumencie. W FaktWay nie zmienisz ich sam: napisz do nas: pomoc@faktway.pl, podając numer dokumentu — ustalimy, przy której fakturze je zapisać. Nie wystawiaj go ponownie.',
  env: 'Dane faktury % sprawdziliśmy w środowisku KSeF „%”, a FaktWay pracuje teraz w środowisku „%” — tej decyzji nie zapiszesz. Nie wystawiaj dokumentu % ponownie i napisz do nas: pomoc@faktway.pl.',
  triggerSame: 'Dokument % jest wycofany: to ta sama sprzedaż co faktura % w KSeF. Tego dokumentu nie wyślesz do KSeF.',
  triggerOther: 'Dokument % jest wycofany: numer jest zajęty w KSeF przez fakturę %. Tego dokumentu nie wyślesz do KSeF — tę sprzedaż wystaw jako nową fakturę z nowym numerem.',
  triggerAuto: 'Numer % jest zajęty w KSeF przez % wystawioną poza FaktWay — tego dokumentu nie wyślesz do KSeF (KSeF odrzuciłby go jako duplikat). Jeśli to inna sprzedaż, wystaw ją jako nową fakturę z nowym numerem.',
  triggerDelete: 'Wycofanego dokumentu % nie usuniesz: zajmuje numer, który w KSeF ma już %, i zostaje w FaktWay, żeby ten numer nie został podpowiedziany ponownie. Jeśli musisz go usunąć, napisz do nas: pomoc@faktway.pl.',
} as const;

/** Odmowa wysyłki szkicu wycofanego (`retiredDraftSendRefusal`) = tekst wyzwalacza 00148. */
export function sendRefusal(nr: string, shape: RetiredRowShape, k: string | null = K): string {
  if (shape === 'decided-same') return fill(SQL.triggerSame, nr, k ?? '');
  if (shape === 'decided-other') return fill(SQL.triggerOther, nr, k ?? '');
  return fill(SQL.triggerAuto, nr, k ? `fakturę ${k}` : 'inną fakturę Twojej firmy');
}

/** Odmowa usunięcia szkicu wycofanego (zwykła faktura, zaliczka) = TRIGGER_DELETE. */
export function deleteRefusal(nr: string, k: string | null = K): string {
  return fill(SQL.triggerDelete, nr, k ? `faktura ${k}` : 'inna faktura Twojej firmy');
}

// ─── Teksty klienta (2.11.B) ────────────────────────────────────────────────

export const CLIENT = {
  role: 'Decyzję, czym jest ten dokument, zapisuje właściciel lub administrator firmy — poproś go o to. Nie wystawiaj tej faktury ponownie.',
  stale: 'Dane faktury w KSeF zmieniły się od otwarcia strony — odśwież stronę i zdecyduj jeszcze raz.',
  confirm: 'Zaznacz „Rozumiem skutki” i zapisz decyzję jeszcze raz.',
  generic: 'Nie udało się zapisać decyzji. Spróbuj ponownie za chwilę; jeśli błąd się powtarza, napisz do nas: pomoc@faktway.pl.',
  toastSame: (nr: string) => `Zapisano: ta sama sprzedaż. Dokument ${nr} jest wycofany.`,
  toastOther: 'Zapisano: inna sprzedaż. Wystaw ją jako nową fakturę z nowym numerem.',
  historyReadFailed: 'Nie udało się sprawdzić historii wysyłki tej faktury — spróbuj ponownie za chwilę.',
  retiredDeleteConfirm: 'Usunąć wycofany szkic? Numer tego dokumentu jest zajęty w KSeF — nowy dokument wystaw z nowym numerem.',
  retiredEmailRefusal: (nr: string) =>
    `Dokumentu ${nr} nie wyślesz e-mailem: jest wycofany, bo jego numer jest zajęty w KSeF przez inną fakturę, więc nie jest fakturą dla nabywcy. Jeśli to inna sprzedaż, wystaw nową fakturę z nowym numerem i wyślij ją.`,
  knownNumberNote: (k: string, y: string, nr: string) =>
    `W FaktWay numer KSeF ${k} ma już dokument ${y} — te dane się nie zgadzają i musimy je wyjaśnić, zanim zdecydujesz, czym jest ten dokument. Napisz do nas: pomoc@faktway.pl, podając numer ${nr}. Nie wystawiaj tej faktury ponownie.`,
} as const;

/** Panel decyzji (2.11.B „Panel”, dialogi). `program` jak `DuplicateDecisionView.program`. */
export const PANEL = {
  intro: (nr: string, k: string, program: string | null) =>
    `KSeF nie przyjął dokumentu ${nr}, bo ma już fakturę Twojej firmy o tym numerze (numer KSeF ${k}), ${programAcc(program)}. Faktura w KSeF jest wiążąca — nie da się jej usunąć ani zastąpić. Porównaj dane i zdecyduj, czym jest ten dokument.`,
  noOwnFile: 'Treści pozycji nie porównaliśmy — FaktWay nie ma pliku tej próby wysyłki.',
  contentSame: 'Treść pozycji jest taka sama jak w fakturze w KSeF — różni się tylko nagłówek pliku.',
  contentDifferent: 'Treść pozycji różni się od faktury w KSeF.',
  knownNumberLine: (k: string, y: string, nr: string) =>
    `W FaktWay numer KSeF ${k} ma już dokument ${y}. Twoja decyzja dotyczy tylko dokumentu ${nr}; jeśli dane dokumentu ${y} nie zgadzają się z fakturą w KSeF, napisz do nas: pomoc@faktway.pl, podając oba numery.`,
  knownLink: (y: string) => `Zobacz dokument ${y}`,
  columns: ['W KSeF', 'Ten dokument'] as const,
  differs: 'różni się',
  buttonSame: 'To ta sama sprzedaż',
  buttonOther: 'To inna sprzedaż',
  support: (nr: string) =>
    `Nie wiesz, co wybrać? Napisz do nas: pomoc@faktway.pl, podając numer ${nr}. Do tego czasu nie wystawiaj tej faktury ponownie.`,
  same: {
    line1: (nrK: string, k: string, program: string | null) =>
      `Fakturą tej sprzedaży zostaje faktura ${nrK} z KSeF (numer KSeF ${k}), ${programNom(program)} — tam ją rozliczasz i korygujesz.`,
    line1Known: (nrK: string, k: string, y: string) =>
      `Fakturą tej sprzedaży zostaje faktura ${nrK} z KSeF (numer KSeF ${k}) — w FaktWay ma ją dokument ${y}.`,
    line2: (nr: string) =>
      `Dokument ${nr} w FaktWay zostanie wycofany: zostanie jako szkic, którego nie wyślesz do KSeF ani nie usuniesz.`,
    line3: (k: string) =>
      `FaktWay nie ujmie faktury ${k} w JPK ani w KPiR — jeśli składasz je z FaktWay, uwzględnij ją osobno.`,
    line3Known: (nr: string, k: string, y: string) =>
      `Dokument ${nr} nie trafi do JPK ani do KPiR w FaktWay. Fakturę ${k} FaktWay zna jako dokument ${y} — sprawdź, czy jego dane zgadzają się z danymi z KSeF w tabeli; jeśli nie, napisz do nas: pomoc@faktway.pl, podając oba numery.`,
    line4: 'Jeśli to jednak inna sprzedaż, zostanie bez faktury — wystaw ją wtedy jako nową fakturę z nowym numerem.',
    checkbox: (k: string, nr: string) =>
      `Rozumiem skutki: faktura ${k} w KSeF dokumentuje tę samą sprzedaż co dokument ${nr}, mimo różnic zaznaczonych w tabeli.`,
    confirm: 'Zapisz: ta sama sprzedaż',
  },
  other: {
    line1: (nr: string, k: string) =>
      `Numer ${nr} jest zajęty w KSeF przez fakturę ${k}. Dokument ${nr} w FaktWay zostanie wycofany: zostanie jako szkic, którego nie wyślesz do KSeF ani nie usuniesz.`,
    line2: 'Tę sprzedaż wystawisz jako nową fakturę — z nowym numerem i dzisiejszą datą.',
    line3: 'Jeśli to jednak ta sama sprzedaż, powstaną dwie faktury, a VAT z obu trzeba będzie wykazać, dopóki jednej z nich nie skorygujesz do zera.',
    line3HeldClause: ' Korekty do produkcyjnego KSeF są teraz wstrzymane przez FaktWay.',
    line4: (k: string, program: string | null) =>
      program
        ? `FaktWay nie ujmuje faktury ${k} w JPK ani w KPiR — rozliczasz ją w programie „${program}”.`
        : `FaktWay nie ujmuje faktury ${k} w JPK ani w KPiR — rozliczasz ją tam, gdzie ją wystawiono.`,
    line4Known: (k: string, y: string) =>
      `Fakturę ${k} FaktWay zna jako dokument ${y} — sprawdź, czy jego dane zgadzają się z danymi z KSeF w tabeli; jeśli nie, napisz do nas: pomoc@faktway.pl, podając oba numery.`,
    checkbox: (k: string, nr: string) =>
      `Rozumiem skutki: faktura ${k} w KSeF dokumentuje inną sprzedaż niż dokument ${nr}.`,
    confirm: 'Zapisz: inna sprzedaż',
  },
} as const;

function programAcc(program: string | null): string {
  if (program === 'FaktWay') return 'wystawioną w FaktWay';
  return program ? `wystawioną w programie „${program}”` : 'wystawioną poza FaktWay';
}

function programNom(program: string | null): string {
  if (program === 'FaktWay') return 'wystawiona w FaktWay';
  return program ? `wystawiona w programie „${program}”` : 'wystawiona poza FaktWay';
}

/** Baner szkicu wycofanego (2.11.B „Retired banner”, każdy rodzaj — decyzja 9). */
export const BANNER = {
  title: (nr: string) => `Dokument wycofany — numer ${nr} jest zajęty w KSeF`,
  otherSale: (data: string, k: string, nr: string, via = '') =>
    `Zapisano ${data}${via}: to inna sprzedaż niż faktura ${k} w KSeF. Wystaw ją jako nową fakturę — z nowym numerem i dzisiejszą datą. Tego dokumentu nie wyślesz do KSeF ani nie usuniesz; numer ${nr} zostaje przy nim, żeby FaktWay nie podpowiedział go ponownie.`,
  automatic: (nr: string, k: string) =>
    `KSeF ma już fakturę Twojej firmy o numerze ${nr} (numer KSeF ${k}), wystawioną poza FaktWay — tego dokumentu nie wyślesz do KSeF ani nie usuniesz; numer zostaje przy nim, żeby FaktWay nie podpowiedział go ponownie. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie (zmiany: korekta tamtej faktury w programie, w którym ją wystawiono). Jeśli inna — wystaw ją jako nową fakturę z nowym numerem.`,
  autoAdvance: (nr: string, k: string) =>
    `KSeF ma już dokument Twojej firmy o numerze ${nr} (numer KSeF ${k}), wystawiony poza FaktWay — tej faktury zaliczkowej nie wyślesz do KSeF ani nie usuniesz; numer zostaje przy niej, żeby FaktWay nie podpowiedział go ponownie. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie. Jeśli inna — wystaw nową fakturę zaliczkową z nowym numerem.`,
  autoDeletable: (nr: string, k: string, genitive: string, accusative: string) =>
    `KSeF ma już dokument Twojej firmy o numerze ${nr} (numer KSeF ${k}), wystawiony poza FaktWay — tego szkicu ${genitive} nie wyślesz do KSeF. Jeśli w KSeF jest ten sam dokument — nie wystawiaj go ponownie. Jeśli inny — usuń ten szkic („Usuń szkic”) i wystaw ${accusative} od nowa z nowym numerem.`,
  autoDeletableHeld: (nr: string, k: string, genitive: string, accusative: string) =>
    `KSeF ma już dokument Twojej firmy o numerze ${nr} (numer KSeF ${k}), wystawiony poza FaktWay — tego szkicu ${genitive} nie wyślesz do KSeF. Jeśli w KSeF jest ten sam dokument — nie wystawiaj go ponownie. Jeśli inny — usuń ten szkic („Usuń szkic”), a po zdjęciu blokady wysyłki wystaw ${accusative} od nowa z nowym numerem.`,
  ctaRegular: { href: '/invoices/new/regular', label: 'Wystaw nową fakturę' },
  ctaAdvance: { href: '/invoices/new/advance', label: 'Wystaw nową fakturę zaliczkową' },
} as const;

// ─── Widoki (kształt z 2.2.1; typy lokalne, bo modułu na main nie ma) ───────

export type DuplicateChoiceFixture = 'same_sale' | 'other_sale';

export interface ComparisonRowFixture {
  label: string;
  ksef: string | null;
  ours: string | null;
  same: boolean | null;
}

export interface DecidableViewFixture {
  kind: 'decidable';
  reason: 'no-own-file' | 'known-number';
  invoiceNumber: string | null;
  originalKsefNumber: string;
  originalSha256: string;
  comparison: ComparisonRowFixture[];
  sameContent: boolean | null;
  needsConfirmation: Record<DuplicateChoiceFixture, boolean>;
  program: string | null;
  knownInvoice: { id: string; internalNumber: string | null } | null;
  heldCorrections: boolean;
}

export interface RefusedViewFixture {
  kind: 'refused';
  refusal: string;
  message: string | null;
}

export interface RetiredDraftViewFixture {
  title: string;
  body: string;
  cta: { href: string; label: string } | null;
  knownInvoice: { id: string; internalNumber: string | null } | null;
  sendRefusal: string | null;
  deletable: boolean;
  deleteRefusal: string | null;
}

export const VIEW_NR = 'FV/12/10/2026';

/** Widok `decidable` dla no-own-file: ta sama data? nie; NIP i kwota zgodne (tarcie tylko dla „inna sprzedaż”). */
export function decidableView(patch: Partial<DecidableViewFixture> = {}): DecidableViewFixture {
  return {
    kind: 'decidable',
    reason: 'no-own-file',
    invoiceNumber: VIEW_NR,
    originalKsefNumber: K,
    originalSha256: SHA_K,
    comparison: [
      { label: 'Numer faktury', ksef: VIEW_NR, ours: VIEW_NR, same: true },
      { label: 'Data wystawienia', ksef: '2026-10-01', ours: '2026-10-02', same: false },
      { label: 'Nabywca', ksef: 'Nabywca testowy', ours: 'Nabywca testowy', same: true },
      { label: 'NIP nabywcy', ksef: '1234567890', ours: '1234567890', same: true },
      { label: 'Kwota brutto', ksef: '123.00 PLN', ours: '123.00 PLN', same: true },
      { label: 'Program', ksef: 'Inny Program 1.0', ours: 'FaktWay', same: null },
    ],
    sameContent: null,
    needsConfirmation: { same_sale: false, other_sale: true },
    program: 'Inny Program 1.0',
    knownInvoice: null,
    heldCorrections: false,
    ...patch,
  };
}

/** Widok known-number: Y ma numer KSeF oryginału. */
export function knownNumberView(patch: Partial<DecidableViewFixture> = {}): DecidableViewFixture {
  return decidableView({
    reason: 'known-number',
    sameContent: true,
    knownInvoice: { id: Y_ID, internalNumber: Y_NR },
    ...patch,
  });
}
