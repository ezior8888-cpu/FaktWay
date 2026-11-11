import { createHash } from 'node:crypto';

import { rachunekZnormalizowany } from './rachunek';
import type { BankOperation } from './typy';

/**
 * Klucz duplikatu operacji (krok 3.2, `payment_imports.transaction_id`).
 *
 * SHA-256 z: własnego rachunku, dnia księgowania, kwoty w groszach ze znakiem,
 * rachunku kontrahenta i numeru kolejnego identycznej operacji w pliku. Tytułu
 * i referencji banku w kluczu nie ma celowo: bank zapisuje je inaczej w MT940,
 * CAMT.053 i CSV (podział na linie, inna referencja dla tej samej operacji,
 * w CAMT ta sama referencja przy przelewie i jego opłacie), a ta sama
 * operacja z drugiego pliku, także w innym formacie, nie może wejść drugi raz.
 * Numer kolejny odróżnia dwa identyczne przelewy jednego dnia (dwie faktury na
 * tę samą kwotę od tego samego nabywcy); ten sam plik wgrany jeszcze raz daje
 * te same numery. Klucz zostaje po zamaskowaniu danych operacji (RODO), więc
 * pominięta operacja też nie wraca.
 */
export function operationKeys(operations: ReadonlyArray<Pick<BankOperation, 'account' | 'bookingDate' | 'amountGrosze' | 'counterpartyAccount'>>): string[] {
  const seen = new Map<string, number>();
  return operations.map((op) => {
    const base = [
      'v1',
      rachunekZnormalizowany(op.account) ?? op.account,
      op.bookingDate,
      String(op.amountGrosze),
      rachunekZnormalizowany(op.counterpartyAccount) ?? '',
    ].join('|');
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return `v1:${createHash('sha256').update(`${base}|${occurrence}`).digest('hex')}`;
  });
}
