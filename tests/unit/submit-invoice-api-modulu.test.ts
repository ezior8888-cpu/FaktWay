import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as runner from '@/lib/jobs/runners/submit-invoice';
import { SEND_ERROR_CODES } from '@/lib/ksef/send-error-codes';

/**
 * Plan usprawnień 3.7a: `lib/jobs/runners/submit-invoice.ts` podzielony na
 * moduły w `lib/jobs/runners/submit-invoice/`. Publiczne API runnera
 * (handler pg-boss `lib/jobs/handlers/package-d.ts` i testy) ma zostać to
 * samo: te same nazwy, te same wartości stałych, ta sama ścieżka importu.
 * Nowy eksport albo zniknięcie starego to świadoma zmiana API, nie skutek
 * uboczny przenosin.
 */

const ROOT = join(__dirname, '..', '..');

describe('API modułu @/lib/jobs/runners/submit-invoice', () => {
  it('eksportuje dokładnie te nazwy', () => {
    expect(Object.keys(runner).sort()).toEqual([
      'KSEF_DUPLICATE_RECONCILE',
      'KSEF_INTENT_NOT_IN_SESSION_CODE',
      'KSEF_SEND_CLAIM_RETRY_MS',
      'KSEF_SEND_LEASE_SECONDS',
      'KSEF_SUBMISSION_STALE_CODE',
      'KSEF_SUBMISSION_STALE_MS',
      'onSubmitInvoiceExhausted',
      'runSubmitInvoice',
    ]);
  });

  it('stałe mają te same wartości', () => {
    expect(runner.KSEF_DUPLICATE_RECONCILE).toBe(SEND_ERROR_CODES.KSEF_DUPLICATE_RECONCILE);
    expect(runner.KSEF_SEND_LEASE_SECONDS).toBe(15 * 60);
    expect(runner.KSEF_SEND_CLAIM_RETRY_MS).toBe(5 * 60 * 1000);
    expect(runner.KSEF_SUBMISSION_STALE_MS).toBe(48 * 60 * 60 * 1000);
    expect(runner.KSEF_SUBMISSION_STALE_CODE).toBe('STALE');
    expect(runner.KSEF_INTENT_NOT_IN_SESSION_CODE).toBe('NOT_IN_SESSION');
  });

  it('runner i obsługa wyczerpania to funkcje asynchroniczne z (data, ctx)', () => {
    expect(typeof runner.runSubmitInvoice).toBe('function');
    expect(typeof runner.onSubmitInvoiceExhausted).toBe('function');
    expect(runner.runSubmitInvoice.length).toBe(2);
    expect(runner.onSubmitInvoiceExhausted.length).toBe(3);
  });

  it('runSubmitInvoice jest zdefiniowany w submit-invoice.ts, nie tylko re-eksportowany', () => {
    // `flo-architecture.test.ts` łączy kolejkę z plikiem runnera regexem
    // `export (async )?function (run\w+)`. Re-eksport z modułu obok urwałby
    // krawędź kolejka → wysyłka w grafie i test przestałby cokolwiek pilnować.
    const source = readFileSync(join(ROOT, 'lib/jobs/runners/submit-invoice.ts'), 'utf8');
    expect(source).toMatch(/export async function runSubmitInvoice\s*\(/);
  });

  it('handler pg-boss importuje runner z tej samej ścieżki', () => {
    const handler = readFileSync(join(ROOT, 'lib/jobs/handlers/package-d.ts'), 'utf8');
    expect(handler).toMatch(/onSubmitInvoiceExhausted,\s*runSubmitInvoice,\s*\} from '\.\.\/runners\/submit-invoice';/);
  });
});
