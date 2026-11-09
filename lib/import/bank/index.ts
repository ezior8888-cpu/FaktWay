import { looksLikeCamt053, parseCamt053 } from './camt053';
import { looksLikePkoElixir, parsePkoElixir } from './csv-pko-elixir';
import { looksLikeMt940, parseMt940 } from './mt940';
import { decodeBankText } from './kodowanie';
import { BankFileError, type BankFileFormat, type BankOperation, type BankParseResult } from './typy';

/**
 * Wgrany plik z banku (krok 3.2): rozpoznanie formatu po treści, nie po nazwie
 * pliku, i parser tego formatu. Czysta funkcja: nic nie zapisuje. Plik spoza
 * rozpoznanych formatów albo z błędem w środku to odmowa całego pliku z kodem.
 */
export function parseBankFile(bytes: Uint8Array): BankParseResult {
  if (bytes.length === 0) return { ok: false, code: 'empty' };
  const text = decodeBankText(bytes);
  if (text.trim() === '') return { ok: false, code: 'empty' };

  let format: BankFileFormat;
  let parse: (text: string) => { operations: BankOperation[]; skipped: number };
  if (looksLikeCamt053(text)) {
    format = 'camt053';
    parse = parseCamt053;
  } else if (text.trimStart().startsWith('<')) {
    // Inny XML (np. raport CAMT.052 z historii albo CAMT.054): nie wyciąg dzienny.
    return { ok: false, code: 'unknown_format' };
  } else if (looksLikeMt940(text)) {
    format = 'mt940';
    parse = parseMt940;
  } else if (looksLikePkoElixir(text)) {
    format = 'csv_pko_elixir';
    parse = parsePkoElixir;
  } else {
    return { ok: false, code: 'unknown_format' };
  }

  try {
    const { operations, skipped } = parse(text);
    return { ok: true, format, operations, skipped };
  } catch (error) {
    if (error instanceof BankFileError) return { ok: false, code: error.code };
    throw error;
  }
}

export type { BankFileFormat, BankOperation, BankParseResult } from './typy';
