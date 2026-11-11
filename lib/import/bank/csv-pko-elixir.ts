import { groszeZLiczbyGroszy } from './kwoty';
import { rachunekZnormalizowany } from './rachunek';
import { cleanText, joinPieces } from './tekst';
import { BankFileError, type BankOperation } from './typy';

/**
 * CSV PKO BP: „Raport plikowy Elixir” z iPKO biznes (PKO BP, „Struktura plików
 * wyjściowych. Raporty plikowe iPKO biznes”, wersja 10). Bez nagłówka,
 * Windows-1250, przecinek między polami, tekst w cudzysłowie, podpola po „|”
 * (po 35 znaków), daty RRRRMMDD, kwota w groszach. Rekord ma 16 pól:
 *  1 typ (111 uznanie, 222 obciążenie), 2 data waluty, 3 kwota w groszach,
 *  4-5 numery rozliczeniowe, 6 rachunek kontrahenta (IBAN), 7 rachunek, dla
 *  którego jest raport (NRB), 8 nazwa i adres kontrahenta, 9 puste,
 *  10 stała 00000000, 11 numer rozliczeniowy, 12 tytuł, 13 puste,
 *  14 numer operacji, 15 puste, 16 informacje międzybankowe.
 *
 * Inne pliki CSV z banków nie mają publicznej specyfikacji (mBank i ING
 * opisują tylko MT940 i CAMT.053), więc ich nie zgadujemy.
 */

const FIELDS = 16;

/** Jedna linia CSV: przecinki poza cudzysłowem, podwojony cudzysłów w tekście. */
function splitCsvLine(line: string): string[] | null {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  if (quoted) return null;
  out.push(field);
  return out;
}

function lines(text: string): string[] {
  return text.split(/\r\n|\n|\r/).filter((line) => line.trim() !== '');
}

function isRecord(fields: string[] | null): fields is string[] {
  return fields !== null && fields.length === FIELDS && (fields[0] === '111' || fields[0] === '222') && /^\d{8}$/.test(fields[1]!);
}

export function looksLikePkoElixir(text: string): boolean {
  const first = lines(text)[0];
  return first !== undefined && isRecord(splitCsvLine(first));
}

function day(value: string): string | null {
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const parsed = new Date(`${iso}T12:00:00Z`);
  // filtr-wyjatek: data-warszawa sprawdzenie dnia kalendarzowego na dacie w UTC, nie dzisiejsza data
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

export function parsePkoElixir(text: string): { operations: BankOperation[]; skipped: number } {
  const operations: BankOperation[] = [];
  for (const line of lines(text)) {
    const f = splitCsvLine(line);
    if (!isRecord(f)) throw new BankFileError('invalid_file');
    const bookingDate = day(f[1]!);
    const amount = groszeZLiczbyGroszy(f[2]!);
    if (!bookingDate || amount === null) throw new BankFileError('invalid_file');
    const account = rachunekZnormalizowany(f[6]);
    if (!account) throw new BankFileError('no_account');
    operations.push({
      account,
      bookingDate,
      valueDate: bookingDate,
      amountGrosze: f[0] === '111' || amount === 0 ? amount : -amount,
      currency: 'PLN',
      counterpartyName: joinPieces(f[7]!.split('|'), 35),
      counterpartyAccount: rachunekZnormalizowany(f[5]),
      title: joinPieces(f[11]!.split('|'), 35),
      bankReference: cleanText(f[13])?.slice(0, 100) ?? null,
    });
  }
  return { operations, skipped: 0 };
}
