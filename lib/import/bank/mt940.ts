import { groszeZKwotySwift } from './kwoty';
import { nrbZNumeruBankuIRachunku, rachunekZnormalizowany } from './rachunek';
import { cleanText, joinPieces } from './tekst';
import { BankFileError, type BankOperation } from './typy';

/**
 * Wyciąg MT940 (SWIFT, krok 3.2). Według specyfikacji banków:
 * - PKO BP, „Struktura plików wyjściowych. Raporty plikowe iPKO biznes”,
 *   wersja 10: :86: z podpolami po tyldzie (`020~00…`), tytuł ~20-~25 po 27
 *   znaków, kontrahent ~32-~33, IBAN ~38, puste pole = bajt 0xFF;
 * - ING Bank Śląski, „Opis formatów plików importu i eksportu wykorzystywanych
 *   w ING Business”, wersja 1.20A, rozdział 8: kod operacji „S” + 3 cyfry,
 *   kilka pól :86: na operację, ~29 NRB, ~62-~63 dalsza nazwa, linia
 *   informacyjna `S940` z kwotą zero;
 * - mBank, „Opis formatu pliku wyciągów dziennych MT940”, wersja 1.3: :61:
 *   z trzecią literą kodu waluty, :86: jako tekst z kluczami („z rach.:”,
 *   „od:”, „tyt.:”) rozdzielanymi średnikiem.
 *
 * Linia :61: spoza formatu, zła data albo kwota przerywa cały plik
 * (`BankFileError`): lepiej odmówić niż zapisać zgadniętą kwotę.
 */

interface Field {
  tag: string;
  lines: string[];
}

interface Statement {
  account: string | null;
  currency: string | null;
}

const TAG = /^:(\d{2}[A-Z]?):(.*)$/;
/**
 * Data waluty RRMMDD, data księgowania MMDD (opcjonalna), znak (C, D, RC, RD),
 * trzecia litera kodu waluty (opcjonalna), kwota z przecinkiem, kod operacji
 * (N, S albo F i trzy znaki), dalej referencje.
 */
const LINE_61 = /^(\d{6})(\d{4})?(RC|RD|C|D)([A-Z])?(\d{1,15},\d{0,2})([NSF][A-Z0-9]{3})(.*)$/;

export function looksLikeMt940(text: string): boolean {
  return /(^|\n)\s*:20:/.test(text) && /(^|\n):(25|61):/.test(text);
}

function isoDay(year: number, month: number, day: number): string | null {
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${iso}T12:00:00Z`);
  // filtr-wyjatek: data-warszawa sprawdzenie dnia kalendarzowego na dacie w UTC, nie dzisiejsza data
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

function splitFields(text: string): Field[][] {
  const statements: Field[][] = [];
  let current: Field[] = [];
  let last: Field | null = null;
  const flush = () => {
    if (current.length > 0) statements.push(current);
    current = [];
    last = null;
  };
  for (const raw of text.replace(/[\u0001\u0003]/g, '').split(/\r\n|\n|\r/)) {
    // Koperta SWIFT ({1:…}{2:…}{4:) wokół bloku, „-}” na końcu.
    const line = raw.replace(/^(\{\d:[^}]*\})+/, '').replace(/^\{4:/, '');
    if (/^-\}?\s*$/.test(line)) {
      flush();
      continue;
    }
    const m = TAG.exec(line);
    if (m) {
      if (m[1] === '20' && current.some((f) => f.tag === '61' || f.tag === '62F' || f.tag === '62M')) flush();
      last = { tag: m[1]!, lines: [m[2]!] };
      current.push(last);
    } else if (last) {
      (last as Field).lines.push(line);
    }
  }
  flush();
  return statements;
}

function statementAccount(value: string): string | null {
  const compact = value.trim().replace(/^\//, '').replace(/\s+/g, '');
  const split = /^(\d{8})\/(\d{16})$/.exec(compact);
  if (split) return nrbZNumeruBankuIRachunku(split[1]!, split[2]!);
  return rachunekZnormalizowany(compact);
}

interface Description {
  title: string | null;
  name: string | null;
  account: string | null;
}

/** Podpola :86: po separatorze (PKO BP i ING: „~”, inne banki: „<”, „^”, „?”). */
function structured(text: string): Map<string, string> | null {
  const m = /^\s*(?:\d{3})?\s*([~<^?])\d{2}/.exec(text);
  if (!m) return null;
  const sep = m[1]!;
  const parts = text.split(new RegExp(`\\${sep}(\\d{2})`));
  const out = new Map<string, string>();
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const code = parts[i]!;
    out.set(code, `${out.get(code) ?? ''}${parts[i + 1]!}`);
  }
  return out;
}

function fromStructured(fields: Map<string, string>): Description {
  const pick = (codes: string[]) => codes.map((code) => fields.get(code) ?? '');
  const title = joinPieces(pick(['20', '21', '22', '23', '24', '25', '26', '27', '28']), 27);
  // ~62-~63 to u ING dalszy ciąg nazwy; u PKO BP ~63 to numer SWRK, nie nazwa.
  const tail = pick(['62', '63']).filter((piece) => !/^\s*SWRK\b/i.test(piece));
  const name = joinPieces([...pick(['32', '33']), ...tail], 27);
  const bank = cleanText(fields.get('30'));
  const rest = cleanText(fields.get('31'));
  const account =
    rachunekZnormalizowany(cleanText(fields.get('38'))) ??
    rachunekZnormalizowany(cleanText(fields.get('29'))) ??
    (bank && rest ? nrbZNumeruBankuIRachunku(bank, rest) : null) ??
    rachunekZnormalizowany(rest);
  return { title, name, account };
}

const KEYED = /^\s*([A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż][A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż .\/]{0,24}):\s*([\s\S]*)$/;
const TITLE_KEYS = new Set(['tyt.', 'tytuł', 'tytułem', 'tytul']);
const NAME_KEYS = new Set(['od', 'dla', 'nadawca', 'odbiorca', 'zleceniodawca']);
const ACCOUNT_KEYS = new Set(['z rach.', 'na rach.', 'z rachunku', 'na rachunek', 'rachunek']);

/** Tekst z kluczami rozdzielanymi średnikiem (mBank). Segment bez klucza dopisuje się do poprzedniego. */
function fromFreeText(text: string): Description {
  const body = text.replace(/^\s*\d{3}\s*/, '');
  let description = '';
  const values = new Map<string, string>();
  let lastKey: string | null = null;
  for (const segment of body.split(';')) {
    const m = KEYED.exec(segment);
    if (m) {
      lastKey = m[1]!.trim().toLowerCase();
      values.set(lastKey, m[2]!);
    } else if (lastKey) {
      values.set(lastKey, `${values.get(lastKey)};${segment}`);
    } else {
      description = description === '' ? segment : `${description};${segment}`;
    }
  }
  const first = (keys: Set<string>) => [...values].find(([key]) => keys.has(key))?.[1] ?? null;
  return {
    title: cleanText(first(TITLE_KEYS)) ?? cleanText(description),
    name: cleanText(first(NAME_KEYS)),
    account: rachunekZnormalizowany(cleanText(first(ACCOUNT_KEYS))),
  };
}

/** Pola :86: jednej operacji: podpola, gdy choć jedno pole je ma, inaczej tekst. */
function describe(fields86: readonly string[][]): Description {
  const parsed = fields86.map((lines) => structured(lines.join('')));
  const withSubfields = parsed.filter((p): p is Map<string, string> => p !== null);
  if (withSubfields.length > 0) {
    const merged = new Map<string, string>();
    for (const map of withSubfields) for (const [code, value] of map) if (!merged.has(code)) merged.set(code, value);
    return fromStructured(merged);
  }
  // Linia SWIFT ma 65 znaków: pełna linia to słowo ucięte w pół, krótsza kończy się spacją.
  const text = fields86.map((lines) => lines.reduce((acc, line, i) => (i === 0 ? line : acc + (lines[i - 1]!.length >= 65 ? '' : ' ') + line), '')).join(' ');
  return fromFreeText(text);
}

function parseLine61(value: string, statement: Statement): Omit<BankOperation, 'counterpartyName' | 'counterpartyAccount' | 'title'> {
  const m = LINE_61.exec(value.trim());
  if (!m) throw new BankFileError('invalid_file');
  const year = 2000 + Number(m[1]!.slice(0, 2));
  const month = Number(m[1]!.slice(2, 4));
  const valueDate = isoDay(year, month, Number(m[1]!.slice(4, 6)));
  if (!valueDate) throw new BankFileError('invalid_file');
  let bookingDate = valueDate;
  if (m[2]) {
    const bookingMonth = Number(m[2].slice(0, 2));
    // Data księgowania bez roku: grudzień i styczeń na przełomie roku.
    const bookingYear = bookingMonth - month > 6 ? year - 1 : month - bookingMonth > 6 ? year + 1 : year;
    const day = isoDay(bookingYear, bookingMonth, Number(m[2].slice(2, 4)));
    if (!day) throw new BankFileError('invalid_file');
    bookingDate = day;
  }
  const amount = groszeZKwotySwift(m[5]!);
  if (amount === null || !statement.account || !statement.currency) {
    throw new BankFileError(statement.account ? 'invalid_file' : 'no_account');
  }
  const incoming = m[3] === 'C' || m[3] === 'RD';
  const rest = m[7]!;
  const split = rest.indexOf('//');
  const ownRef = (split >= 0 ? rest.slice(0, split) : rest).trim();
  const bankRef = split >= 0 ? rest.slice(split + 2).trim() : '';
  const reference = bankRef || (ownRef && ownRef !== 'NONREF' ? ownRef : '');
  return {
    account: statement.account,
    bookingDate,
    valueDate,
    amountGrosze: incoming || amount === 0 ? amount : -amount,
    currency: statement.currency,
    bankReference: reference === '' ? null : reference.slice(0, 100),
  };
}

export function parseMt940(text: string): { operations: BankOperation[]; skipped: number } {
  const operations: BankOperation[] = [];
  let skipped = 0;
  for (const fields of splitFields(text)) {
    const statement: Statement = { account: null, currency: null };
    let pending: { line: string; descriptions: string[][] } | null = null;
    const finish = () => {
      if (!pending) return;
      const base = parseLine61(pending.line, statement);
      const { title, name, account } = describe(pending.descriptions);
      if (base.amountGrosze === 0) skipped += 1;
      else operations.push({ ...base, counterpartyName: name, counterpartyAccount: account, title });
      pending = null;
    };
    let open = false;
    for (const field of fields) {
      const value = field.lines[0] ?? '';
      switch (field.tag) {
        case '25':
          statement.account = statementAccount(value);
          if (!statement.account) throw new BankFileError('no_account');
          break;
        case '60F':
        case '60M': {
          const m = /^[CD]\d{6}([A-Z]{3})/.exec(value.trim());
          if (!m) throw new BankFileError('invalid_file');
          statement.currency = m[1]!;
          break;
        }
        case '61':
          finish();
          pending = { line: value, descriptions: [] };
          open = true;
          break;
        case '86':
          if (open && pending) (pending as { descriptions: string[][] }).descriptions.push(field.lines);
          break;
        case '62F':
        case '62M':
        case '64':
        case '65':
          finish();
          open = false;
          break;
        default:
          break;
      }
    }
    finish();
  }
  return { operations, skipped };
}
