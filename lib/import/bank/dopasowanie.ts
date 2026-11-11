import { canonicalKsefNumber, ksefNumbersInText } from './numer-ksef';
import { foldText } from './tekst';
import type { BankOperation } from './typy';

/**
 * Propozycja faktury dla wpływu z wyciągu (krok 3.2). Tylko propozycja: wpłatę
 * zapisuje dopiero „Potwierdź” klienta (`confirm_bank_operation`, 00180).
 *
 * Kolejność i pewność:
 * 1. numer KSeF w tytule (jednoznaczny w całym KSeF): pewność wysoka;
 * 2. numer faktury w tytule (inny zapis liter, spacji i ukośników, ale z granicą
 *    numeru: „FV/1/2026” nie trafia w „FV/11/2026”): pewność średnia;
 * 3. kwota równa reszcie do zapłaty i nazwa nabywcy w danych płacącego:
 *    podpowiedź o niskiej pewności.
 * Dwie i więcej pasujących faktur na tym samym poziomie to brak propozycji
 * (wybór ręczny), np. dwie faktury cykliczne na tę samą kwotę. Numer KSeF
 * w tytule, którego nie ma wśród niezapłaconych faktur, zatrzymuje słabsze
 * dopasowania: tytuł wskazuje inny dokument. Obciążenia nie dostają propozycji.
 */

export interface MatchCandidate {
  id: string;
  /** Numer faktury nadany w FaktWay (`internal_number`). */
  number: string | null;
  ksefNumber: string | null;
  /** Pozostało do zapłaty w groszach (`outstandingOf`). */
  outstandingGrosze: number;
  buyerName: string | null;
}

export const MATCH_KINDS = ['ksef_number', 'invoice_number', 'amount_name', 'manual'] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

export type MatchResult =
  | {
      kind: Exclude<MatchKind, 'manual'>;
      invoiceId: string;
      confidence: 'high' | 'medium' | 'low';
      /** Kwota wpływu wobec reszty: cała reszta, część albo więcej (zapis odmówi nadpłaty). */
      amount: 'full' | 'partial' | 'over';
    }
  | { kind: 'ambiguous'; invoiceIds: string[] }
  | { kind: 'none'; unknownKsefNumber: boolean };

const SEP = '[\\s/\\\\._-]';
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Wzorzec numeru faktury: kawałki liter i cyfr, między cyframi co najmniej jeden separator. */
function numberPattern(number: string): RegExp | null {
  const tokens = foldText(number).match(/[A-Z0-9]+/g) ?? [];
  if (!tokens.some((t) => /\d/.test(t)) || tokens.join('').length < 3) return null;
  let source = '';
  tokens.forEach((token, i) => {
    if (i > 0) source += /\d$/.test(tokens[i - 1]!) && /^\d/.test(token) ? `${SEP}+` : `${SEP}*`;
    source += escape(token);
  });
  return new RegExp(`(?<![A-Z0-9])${source}(?![A-Z0-9])`);
}

export function invoiceNumberInText(number: string, text: string): boolean {
  const pattern = numberPattern(number);
  return pattern !== null && pattern.test(foldText(text));
}

/** Formy prawne i skróty, które nie odróżniają firm. */
const GENERIC = new Set(['SPOLKA', 'SPOLKI', 'KOMANDYTOWA', 'JAWNA', 'CYWILNA', 'AKCYJNA', 'OGRANICZONA', 'ODPOWIEDZIALNOSCIA', 'PHU', 'PPHU', 'FHU', 'FIRMA', 'USLUGI', 'HANDEL']);

function nameTokens(name: string): string[] {
  return foldText(name).split(/[^A-Z0-9]+/).filter((t) => t.length >= 3 && !GENERIC.has(t));
}

/** Każde znaczące słowo nazwy nabywcy występuje w danych płacącego (nazwa z adresem). */
export function buyerNameMatches(buyerName: string | null, counterparty: string | null): boolean {
  if (!buyerName || !counterparty) return false;
  const wanted = nameTokens(buyerName);
  if (wanted.length === 0) return false;
  const present = new Set(nameTokens(counterparty));
  return wanted.every((t) => present.has(t));
}

function proposal(kind: Exclude<MatchKind, 'manual'>, candidate: MatchCandidate, amountGrosze: number): MatchResult {
  const confidence = kind === 'ksef_number' ? 'high' : kind === 'invoice_number' ? 'medium' : 'low';
  const amount = amountGrosze === candidate.outstandingGrosze ? 'full' : amountGrosze < candidate.outstandingGrosze ? 'partial' : 'over';
  return { kind, invoiceId: candidate.id, confidence, amount };
}

function pick(kind: Exclude<MatchKind, 'manual'>, hits: readonly MatchCandidate[], amountGrosze: number): MatchResult | null {
  if (hits.length === 1) return proposal(kind, hits[0]!, amountGrosze);
  if (hits.length > 1) return { kind: 'ambiguous', invoiceIds: hits.map((c) => c.id) };
  return null;
}

export function matchInvoice(
  op: Pick<BankOperation, 'amountGrosze' | 'title' | 'counterpartyName'>,
  candidates: readonly MatchCandidate[],
): MatchResult {
  if (!Number.isSafeInteger(op.amountGrosze) || op.amountGrosze <= 0) return { kind: 'none', unknownKsefNumber: false };
  const open = candidates.filter((c) => c.outstandingGrosze > 0);
  const title = op.title ?? '';

  const ksef = ksefNumbersInText(title);
  if (ksef.length > 0) {
    const hits = open.filter((c) => {
      const own = canonicalKsefNumber(c.ksefNumber);
      return own !== null && ksef.includes(own);
    });
    return pick('ksef_number', hits, op.amountGrosze) ?? { kind: 'none', unknownKsefNumber: true };
  }

  const byNumber = open.filter((c) => c.number !== null && invoiceNumberInText(c.number, title));
  const numbered = pick('invoice_number', byNumber, op.amountGrosze);
  if (numbered) return numbered;

  const byAmount = open.filter((c) => c.outstandingGrosze === op.amountGrosze && buyerNameMatches(c.buyerName, op.counterpartyName));
  return pick('amount_name', byAmount, op.amountGrosze) ?? { kind: 'none', unknownKsefNumber: false };
}
