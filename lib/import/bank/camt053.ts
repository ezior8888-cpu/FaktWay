import { XMLParser } from 'fast-xml-parser';

import { groszeZKwotyXml } from './kwoty';
import { rachunekZnormalizowany } from './rachunek';
import { cleanText } from './tekst';
import { BankFileError, type BankOperation } from './typy';

/**
 * Wyciąg CAMT.053 (ISO 20022 BankToCustomerStatement, krok 3.2), wersje
 * camt.053.001.02 (PKO BP, iPKO biznes, wersja 10; ING Business 1.20A,
 * rozdział 10) i camt.053.001.08 (mBank, „Opis formatu pliku eksportu
 * wyciągów dziennych camt.053.001.08”). Czytamy po nazwach elementów bez
 * przestrzeni nazw: Stmt/Acct/Id (IBAN albo Othr/Id), Ntry/Amt z walutą,
 * CdtDbtInd, Sts (BOOK; w .08 Sts/Cd), BookgDt i ValDt (Dt albo DtTm),
 * AcctSvcrRef, NtryDtls/TxDtls/RltdPties (Dbtr albo Cdtr, w .08 z Pty)
 * z rachunkiem i RmtInf (Ustrd, Strd/CdtrRefInf/Ref).
 *
 * Operacje inne niż zaksięgowane (BOOK) pomijamy: nie są jeszcze pieniędzmi
 * na rachunku. DOCTYPE i encje to odmowa pliku (wyciąg ich nie potrzebuje).
 */

type Node = Record<string, unknown>;

const ARRAYS = new Set(['Stmt', 'Ntry', 'NtryDtls', 'TxDtls', 'Ustrd', 'Strd']);
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Wartości jako tekst: kwota „0012.50” i numer rachunku nie mogą stać się liczbą.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
  isArray: (name) => ARRAYS.has(name),
});

export function looksLikeCamt053(text: string): boolean {
  return /<(?:\w+:)?BkToCstmrStmt[\s>]/.test(text);
}

function node(value: unknown): Node | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Node) : null;
}

function list(value: unknown): Node[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(node).filter((n): n is Node => n !== null);
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const n = node(value);
  return n && typeof n['#text'] === 'string' ? (n['#text'] as string) : null;
}

function path(root: unknown, ...keys: string[]): unknown {
  let current: unknown = root;
  for (const key of keys) {
    const n = node(Array.isArray(current) ? current[0] : current);
    if (!n) return undefined;
    current = n[key];
  }
  return current;
}

function warsawDay(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const withZone = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  if (!withZone) return /^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(parsed);
}

function realDay(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(`${iso}T12:00:00Z`);
  // filtr-wyjatek: data-warszawa sprawdzenie dnia kalendarzowego na dacie w UTC, nie dzisiejsza data
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

function day(value: unknown): string | null {
  const raw = text(path(value, 'Dt')) ?? text(path(value, 'DtTm'));
  return raw ? realDay(warsawDay(raw)) : null;
}

function accountOf(value: unknown): string | null {
  return rachunekZnormalizowany(text(path(value, 'Id', 'IBAN')) ?? text(path(value, 'Id', 'Othr', 'Id')));
}

/** Nazwa strony: w .02 `Dbtr/Nm`, w .08 `Dbtr/Pty/Nm`. */
function partyName(value: unknown): string | null {
  return cleanText(text(path(value, 'Nm')) ?? text(path(value, 'Pty', 'Nm')));
}

function remittance(tx: Node): string | null {
  const rmt = path(tx, 'RmtInf');
  const pieces: string[] = [];
  const ustrd = path(rmt, 'Ustrd');
  for (const piece of Array.isArray(ustrd) ? ustrd : []) {
    const t = text(piece);
    if (t) pieces.push(t);
  }
  for (const strd of list(path(rmt, 'Strd'))) {
    const ref = text(path(strd, 'CdtrRefInf', 'Ref'));
    if (ref) pieces.push(ref);
  }
  return cleanText(pieces.join(' ')) ?? cleanText(text(path(tx, 'AddtlTxInf')));
}

function entryStatus(entry: Node): string | null {
  const sts = entry.Sts;
  return text(sts) ?? text(path(sts, 'Cd'));
}

export function parseCamt053(xml: string): { operations: BankOperation[]; skipped: number } {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new BankFileError('invalid_file');
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new BankFileError('invalid_file');
  }
  const statements = list(path(doc, 'Document', 'BkToCstmrStmt', 'Stmt'));
  if (statements.length === 0) throw new BankFileError('invalid_file');

  const operations: BankOperation[] = [];
  let skipped = 0;
  for (const stmt of statements) {
    const account = accountOf(path(stmt, 'Acct'));
    if (!account) throw new BankFileError('no_account');
    for (const entry of list(stmt.Ntry)) {
      if (entryStatus(entry) !== 'BOOK') {
        skipped += 1;
        continue;
      }
      const amountNode = entry.Amt;
      const amount = groszeZKwotyXml(text(amountNode) ?? '');
      const currency = node(amountNode)?.['@_Ccy'];
      const indicator = text(entry.CdtDbtInd);
      const bookingDate = day(entry.BookgDt);
      if (amount === null || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || !bookingDate ||
          (indicator !== 'CRDT' && indicator !== 'DBIT')) {
        throw new BankFileError('invalid_file');
      }
      const incoming = indicator === 'CRDT';
      // Strona przeciwna: przy wpływie płacący (Dbtr), przy wypływie odbiorca (Cdtr).
      const txs = list(entry.NtryDtls).flatMap((details) => list(details.TxDtls));
      const parties = txs.map((tx) => path(tx, 'RltdPties'));
      const names = [...new Set(parties.map((p) => partyName(path(p, incoming ? 'Dbtr' : 'Cdtr'))).filter((n): n is string => n !== null))];
      const accounts = [...new Set(parties.map((p) => accountOf(path(p, incoming ? 'DbtrAcct' : 'CdtrAcct'))).filter((a): a is string => a !== null))];
      const title = cleanText(txs.map(remittance).filter((t): t is string => t !== null).join(' ')) ?? cleanText(text(entry.AddtlNtryInf));
      const reference = text(entry.AcctSvcrRef) ?? text(path(txs[0], 'Refs', 'AcctSvcrRef'));
      operations.push({
        account,
        bookingDate,
        valueDate: day(entry.ValDt),
        amountGrosze: incoming || amount === 0 ? amount : -amount,
        currency,
        // Kilka płacących w jednej pozycji zbiorczej: bez zgadywania, kto zapłacił.
        counterpartyName: names.length === 1 ? names[0]! : null,
        counterpartyAccount: accounts.length === 1 ? accounts[0]! : null,
        title,
        bankReference: reference ? reference.slice(0, 100) : null,
      });
    }
  }
  return { operations, skipped };
}
