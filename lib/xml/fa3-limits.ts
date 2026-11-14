/**
 * Granice tekstu FA(3) w jednym miejscu (C1 planu „zero zgubionych faktur”,
 * ustalenia W4 i W6).
 *
 * Kto z tego korzysta:
 * - generatory XML (`lib/xml/fa3-generator.ts`, `lib/ksef/fa3-correction-generator.ts`,
 *   `lib/ksef/fa3-advance-generator.ts`) sprawdzają tekst tuż przed budową
 *   pliku (`assertFa3TextLimits`) i odmawiają komunikatem z nazwą pola, zamiast
 *   zostawić to walidatorowi XSD z surowym komunikatem xmllint;
 * - formularze i walidatory (`lib/schemas/`, `lib/validators/`, profil firmy,
 *   kontrahenci, paragon) odrzucają te same wartości, zanim faktura powstanie.
 *
 * Dwa rodzaje granic, celowo osobno:
 * - `FA3_TEXT_LIMITS`: granice ze schematu XSD FA(3) (`lib/xml/schemas/fa3/`),
 *   czyli tyle, ile przyjmie KSeF. Test `tests/xml/fa3-limits.test.ts` czyta je
 *   wprost z plików XSD, więc nowa wersja schematu z inną granicą go zaczerwieni;
 * - `DB_TEXT_LIMITS`: kolumny bazy węższe niż XSD (jednostka miary: 50 w bazie,
 *   256 w XSD). Formularz pilnuje bazy, generator schematu.
 *
 * XSD liczy znaki Unicode (emoji to jeden znak) po normalizacji białych znaków
 * swojego typu (`xsdLength`). Formularze z prostym `.max()` liczą jednostki
 * UTF-16 i nie zwijają spacji, więc są co najwyżej surowsze od generatora:
 * to, co przejdzie formularz, przejdzie też generator.
 *
 * Moduł trafia do paczki przeglądarki (schematy formularzy), więc importuje
 * tylko typy i nic z `node:`.
 */

/**
 * Jak typ XSD traktuje białe znaki, zanim policzy długość:
 * - `token` (`xsd:token`): tabulator, nowa linia i spacje zwinięte do jednej
 *   spacji, bez spacji na brzegach;
 * - `replace` (`whiteSpace="replace"`): tabulator i nowa linia to spacja;
 * - `string`: bez zmian.
 */
export type Fa3TextKind = 'token' | 'replace' | 'string';

export interface Fa3TextLimit {
  /** Elementy FA(3) tego typu, które wstawiają generatory. */
  readonly elements: readonly string[];
  /** Typ prosty w XSD. */
  readonly xsdType: string;
  /** `maxLength` w XSD, w znakach Unicode po normalizacji białych znaków. */
  readonly max: number;
  readonly kind: Fa3TextKind;
}

/**
 * Granice XSD elementów z wolnym tekstem, które wstawiają generatory. Każdy
 * typ `token` ma też `minLength` 1, więc tekst z samych spacji XSD odrzuca.
 * Elementy z wolnym tekstem świadomie pominięte (stałe z generatora, pola,
 * których nic nie ustawia) wylicza z powodem `tests/xml/fa3-limits.test.ts`.
 */
export const FA3_TEXT_LIMITS = {
  nazwa: { elements: ['Nazwa'], xsdType: 'tns:TZnakowy512', max: 512, kind: 'token' },
  adresL1: { elements: ['AdresL1'], xsdType: 'tns:TZnakowy512', max: 512, kind: 'token' },
  adresL2: { elements: ['AdresL2'], xsdType: 'tns:TZnakowy512', max: 512, kind: 'token' },
  nrId: { elements: ['NrID'], xsdType: 'etd:TNrIdentyfikacjiPodatkowej', max: 50, kind: 'replace' },
  p2: { elements: ['P_2'], xsdType: 'tns:TZnakowy', max: 256, kind: 'token' },
  przyczynaKorekty: { elements: ['PrzyczynaKorekty'], xsdType: 'tns:TZnakowy', max: 256, kind: 'token' },
  nrFaKorygowanej: { elements: ['NrFaKorygowanej'], xsdType: 'tns:TZnakowy', max: 256, kind: 'token' },
  nrFaZaliczkowej: { elements: ['NrFaZaliczkowej'], xsdType: 'tns:TZnakowy', max: 256, kind: 'token' },
  p7: { elements: ['P_7'], xsdType: 'tns:TZnakowy512', max: 512, kind: 'token' },
  p7z: { elements: ['P_7Z'], xsdType: 'tns:TZnakowy512', max: 512, kind: 'token' },
  p8a: { elements: ['P_8A'], xsdType: 'tns:TZnakowy', max: 256, kind: 'token' },
  gtin: { elements: ['GTIN'], xsdType: 'tns:TZnakowy20', max: 20, kind: 'token' },
  pkwiu: { elements: ['PKWiU'], xsdType: 'tns:TZnakowy50', max: 50, kind: 'token' },
  cn: { elements: ['CN'], xsdType: 'tns:TZnakowy50', max: 50, kind: 'token' },
  nazwaBanku: { elements: ['NazwaBanku'], xsdType: 'tns:TZnakowy', max: 256, kind: 'token' },
  p19: { elements: ['P_19A', 'P_19B', 'P_19C'], xsdType: 'tns:TZnakowy', max: 256, kind: 'token' },
  stopkaFaktury: { elements: ['StopkaFaktury'], xsdType: 'etd:TTekstowy', max: 3500, kind: 'string' },
} as const satisfies Record<string, Fa3TextLimit>;

/** Kolumny bazy węższe niż XSD. */
export const DB_TEXT_LIMITS = {
  /** `invoice_line_items.unit VARCHAR(50)` (migracja 00001); XSD (P_8A) przyjmuje 256. */
  lineUnit: 50,
} as const;

/** Nazwa pozycji faktury zaliczkowej (P_7) to ten przedrostek i opis zaliczki. */
export const ADVANCE_LINE_NAME_PREFIX = 'Zaliczka: ';

/**
 * Najdłuższy opis zaliczki: P_7 = przedrostek + opis musi się zmieścić w 512.
 * Przedrostek kończy się spacją, więc po zwinięciu spacji przez XSD długość
 * P_7 to dokładnie długość przedrostka plus długość opisu.
 */
export const ADVANCE_DESCRIPTION_MAX = FA3_TEXT_LIMITS.p7.max - ADVANCE_LINE_NAME_PREFIX.length;

/**
 * Znaki, których XML 1.0 nie przyjmie: sterujące poza tabulatorem, LF i CR,
 * U+FFFE, U+FFFF i połówka pary zastępczej UTF-16 bez drugiej połówki (np.
 * ucięte emoji). Z flagą `u` całe emoji to jeden znak spoza klasy, więc
 * zakres D800–DFFF łapie tylko połówki bez pary (F-041).
 */
export const XML_FORBIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u;

export const NO_CONTROL_CHARS_MESSAGE = 'Usuń niewidoczne znaki sterujące (np. wklejone z Worda)';

export function isXmlSafe(value: string): boolean {
  return !XML_FORBIDDEN_CHARS.test(value);
}

/**
 * Długość tekstu tak, jak liczy ją walidator XSD: w znakach Unicode (emoji to
 * jeden znak), po normalizacji parsera XML (CRLF i samo CR to LF) i po
 * normalizacji białych znaków typu (`Fa3TextKind`). Twarda spacja (NBSP) nie
 * jest białym znakiem XML, więc liczy się jak litera.
 */
export function xsdLength(value: string, kind: Fa3TextKind): number {
  let v = value.replace(/\r\n?/g, '\n');
  if (kind === 'token') v = v.replace(/[\t\n ]+/g, ' ').replace(/^ | $/g, '');
  else if (kind === 'replace') v = v.replace(/[\t\n]/g, ' ');
  return [...v].length;
}

/** Tekst, który w polu typu `token` byłby pusty (same spacje). */
export function isXsdBlank(value: string): boolean {
  return xsdLength(value, 'token') === 0;
}

/**
 * Do formularzy (`.refine(notXsdBlank, …)` obok `.min(1)`): odrzuca same
 * spacje, a pusty tekst zostawia `.min()`, żeby nie było dwóch błędów naraz.
 */
export function notXsdBlank(value: string): boolean {
  return value === '' || !isXsdBlank(value);
}

/** „1 znak”, „2 znaki”, „5 znaków”, „12 znaków”, „22 znaki”. */
export function liczbaZnakow(n: number): string {
  const jednosci = n % 10;
  const reszta100 = n % 100;
  const slowo =
    n === 1 ? 'znak' : jednosci >= 2 && jednosci <= 4 && (reszta100 < 12 || reszta100 > 14) ? 'znaki' : 'znaków';
  return `${n} ${slowo}`;
}

/**
 * XML niezgodny ze schematem XSD FA(3). KSeF takiej faktury nigdy nie
 * przyjmie, więc to błąd danych, a nie przejściowy — bez ponowień i bez
 * Offline24 (AUD-13).
 *
 * Rzuca go walidator XSD po zbudowaniu pliku (`lib/xml/validator.ts` oddaje
 * tę samą klasę) i generatory przed budową, gdy tekst przekracza granicę
 * (`assertFa3TextLimits`). Ta sama klasa daje ten sam kod XSD_INVALID.
 */
export class InvoiceXmlSchemaError extends Error {
  constructor(public readonly errors: string[]) {
    super(`XML FA(3) jest niezgodny ze schematem XSD:\n${errors.map((e) => `  ${e}`).join('\n')}`);
    this.name = 'InvoiceXmlSchemaError';
  }
}

// ─── Sprawdzanie tekstu przed budową XML ────────────────────────────────────

export interface Fa3TextCheck {
  /** Nazwa pola dla klienta, np. „Nabywca, nazwa”. */
  readonly label: string;
  /** Wartość dokładnie taka, jaką generator wstawi do elementu; pusta = elementu nie będzie. */
  readonly value: string | null | undefined;
  readonly limit: Fa3TextLimit;
  /** Granica węższa niż XSD (opis zaliczki); domyślnie `limit.max`. */
  readonly max?: number;
  /** Dane z Ustawień firmy, nie z faktury: komunikat mówi, gdzie je poprawić. */
  readonly fromSettings?: boolean;
}

const SETTINGS_HINT = ' (popraw w Ustawieniach firmy)';

/**
 * Problemy z tekstem, którego XSD nie przyjmie: najwyżej jeden na pole, bez
 * kropki na końcu (wysyłka łączy je średnikiem). Co zrobić dalej, mówi strona
 * faktury (zasady ponownej wysyłki), więc komunikat podaje tylko fakty.
 * Pustą wartość pomija: brak elementu albo pustkę zgłasza generator sam.
 */
export function fa3TextProblems(checks: readonly Fa3TextCheck[]): string[] {
  const problems: string[] = [];
  for (const { label, value, limit, max = limit.max, fromSettings } of checks) {
    if (value === undefined || value === null || value === '') continue;
    const hint = fromSettings ? SETTINGS_HINT : '';
    if (!isXmlSafe(value)) {
      problems.push(`${label}: zawiera niewidoczne znaki sterujące (np. wklejone z Worda), usuń je${hint}`);
      continue;
    }
    const length = xsdLength(value, limit.kind);
    if (limit.kind === 'token' && length === 0) {
      problems.push(`${label}: pole jest puste (same spacje)${hint}`);
    } else if (length > max) {
      problems.push(`${label}: najwyżej ${liczbaZnakow(max)}, a jest ${length}${hint}`);
    }
  }
  return problems;
}

/** Odmowa przed budową XML: ten sam błąd co z walidatora XSD, ale z nazwami pól. */
export function assertFa3TextLimits(checks: readonly Fa3TextCheck[]): void {
  const problems = fa3TextProblems(checks);
  if (problems.length > 0) throw new InvoiceXmlSchemaError(problems);
}

interface Fa3Party {
  readonly name?: string | null;
  readonly address?: { readonly addressLine1?: string | null; readonly addressLine2?: string | null } | null;
}

/** Nazwa i adres strony faktury (Podmiot1 albo Podmiot2). Dane sprzedawcy pochodzą z Ustawień firmy. */
export function fa3PartyChecks(role: 'Sprzedawca' | 'Nabywca', party: Fa3Party): Fa3TextCheck[] {
  const fromSettings = role === 'Sprzedawca';
  return [
    { label: `${role}, nazwa`, value: party.name, limit: FA3_TEXT_LIMITS.nazwa, fromSettings },
    { label: `${role}, adres (linia 1)`, value: party.address?.addressLine1, limit: FA3_TEXT_LIMITS.adresL1, fromSettings },
    { label: `${role}, adres (linia 2)`, value: party.address?.addressLine2, limit: FA3_TEXT_LIMITS.adresL2, fromSettings },
  ];
}

interface Fa3Line {
  readonly ordinal?: number;
  readonly name?: string | null;
  readonly unit?: string | null;
  /** Kod, który generator wstawia jako GTIN, CN albo PKWiU. */
  readonly classificationCode?: string | null;
}

const LINE_NAME_PREVIEW = 30;

/** „Pozycja 2 „Usługa wdrożeniowa”” — numer jak NrWierszaFa i początek nazwy, bez znaków sterujących. */
function lineLabel(line: Fa3Line, index: number): string {
  const label = `Pozycja ${line.ordinal ?? index + 1}`;
  const chars = [...(line.name ?? '')].filter(isXmlSafe).join('').replace(/\s+/g, ' ').trim();
  if (!chars) return label;
  const name = [...chars];
  const preview =
    name.length > LINE_NAME_PREVIEW ? `${name.slice(0, LINE_NAME_PREVIEW).join('').trimEnd()}…` : chars;
  return `${label} „${preview}”`;
}

/**
 * Nazwa (P_7), jednostka (P_8A) i kod klasyfikacji pozycji. Kod GTIN
 * (8–14 cyfr) i CN (4–10 cyfr) zawsze mieści się w swojej granicy, a każdy
 * inny generator wstawia jako PKWiU, więc kod sprawdzamy granicą PKWiU.
 */
export function fa3LineChecks(lines: readonly Fa3Line[]): Fa3TextCheck[] {
  return lines.flatMap((line, index) => {
    const label = lineLabel(line, index);
    return [
      { label: `${label}, nazwa`, value: line.name, limit: FA3_TEXT_LIMITS.p7 },
      { label: `${label}, jednostka miary`, value: line.unit, limit: FA3_TEXT_LIMITS.p8a },
      { label: `${label}, kod PKWiU`, value: line.classificationCode, limit: FA3_TEXT_LIMITS.pkwiu },
    ];
  });
}
