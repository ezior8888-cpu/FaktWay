import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';

/**
 * F12-E2b i F12-E6: odmowa eksportu CSV dochodzi do klienta.
 *
 * - E2b: odmowa z numerem faktury (FP, nieznane kwoty z importu, waluta) ma
 *   trafić do Centrum eksportu z treścią, a nie jako „Nie udało się
 *   wygenerować pliku”. Job pokazywał tylko komunikaty z listy dokładnych
 *   treści i odmowy JPK po początku.
 * - E6: odmowa przy fakturze walutowej podaje numer tej faktury; jedna taka
 *   faktura blokuje cały plik, więc bez numeru klient nie wie, której szukać.
 *
 * Ścieżka: generator CSV → błąd nieponawialny joba → `onExportsGenerateExhausted`
 * → wiersz `export_jobs` → przycisk naprawy w Centrum eksportu. Atrapa tylko bazy.
 */

const db = vi.hoisted(() => ({ updates: [] as unknown[] }));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        update: (row: unknown) => {
          db.updates.push(row);
          return q;
        },
        eq: () => q,
        in: () => q,
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
      });
      return q;
    },
  }),
}));

import { CSV_DOCUMENT_REFUSAL_PREFIX, exportFixFor } from '@/components/exports/export-fixes';
import { CSV_REFUSAL_PREFIX, generateUniversalCsv, type CsvExportInput } from '@/lib/exports/csv-generators';
import { NonRetriableError } from '@/lib/jobs/errors';
import { onExportsGenerateExhausted } from '@/lib/jobs/runners/exports-generate';

function faktura(p: Partial<JpkInvoice> = {}): JpkInvoice {
  return {
    invoiceNumber: 'FV/1/2026',
    issueDate: '2026-10-10',
    saleDate: '2026-10-10',
    invoiceType: 'standard',
    currency: 'PLN',
    netTotal: 100,
    vatTotal: 23,
    grossTotal: 123,
    issuer: { nip: '1234567890', name: 'Firma Testowa' },
    buyer: { nip: '1234567890', name: 'Nabywca Testowy' },
    lines: [],
    ...p,
  } as JpkInvoice;
}

function dane(p: Partial<CsvExportInput>): CsvExportInput {
  return {
    issuer: { nip: '1234567890', name: 'Firma Testowa' },
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    issuedInvoices: [],
    receivedInvoices: [],
    ...p,
  };
}

/** Treść odmowy generatora, tak jak job ją przekazuje dalej (`NonRetriableError(e.message)`). */
function odmowa(d: CsvExportInput): Error {
  try {
    generateUniversalCsv(d);
  } catch (e) {
    return new NonRetriableError((e as Error).message);
  }
  throw new Error('generator nie odmówił');
}

beforeEach(() => {
  db.updates = [];
});

describe('odmowa CSV u klienta (F12-E2b, F12-E6)', () => {
  it.each([
    ['faktura do paragonu', dane({ issuedInvoices: [faktura({ invoiceNumber: 'FP/5/2026', ksefMarkers: { fp: true } } as Partial<JpkInvoice>)] }), 'FP/5/2026'],
    ['nieznane kwoty z importu', dane({ receivedInvoices: [faktura({ invoiceNumber: 'FZ/3/2026', importedTotalsUnknown: true } as Partial<JpkInvoice>)] }), 'FZ/3/2026'],
    ['faktura walutowa', dane({ receivedInvoices: [faktura({ invoiceNumber: 'FZ/7/2026', currency: 'EUR' })] }), 'FZ/7/2026'],
  ])('%s: Centrum eksportu dostaje treść z numerem i link do faktury', async (_opis, d, numer) => {
    const failure = odmowa(d);
    expect(failure.message.startsWith(CSV_REFUSAL_PREFIX)).toBe(true);
    expect(failure.message).toContain(`faktura ${numer} `);

    await onExportsGenerateExhausted(failure, { exportJobId: 'job-1' });
    expect(db.updates).toEqual([{ status: 'failed', error_message: failure.message }]);

    expect(exportFixFor({ status: 'failed', format: 'csv_universal', error_message: failure.message, period_start: '2026-10-01', period_end: '2026-10-31' } as never)).toEqual({
      kind: 'link',
      label: 'Otwórz fakturę',
      href: `/invoices?q=${encodeURIComponent(numer)}`,
    });
  });

  it('faktura walutowa: odmowa podaje walutę i wyjście', () => {
    const failure = odmowa(dane({ issuedInvoices: [faktura({ invoiceNumber: 'FV/9/2026', currency: 'EUR' })] }));
    expect(failure.message).toContain('EUR');
    expect(failure.message).toContain('wpisz w programie księgowym ręcznie');
  });

  it('Centrum eksportu zna ten sam początek odmowy co generator', () => {
    expect(CSV_DOCUMENT_REFUSAL_PREFIX).toBe(CSV_REFUSAL_PREFIX);
  });

  it('zapisana wcześniej odmowa waluty bez numeru dalej prowadzi do listy faktur', () => {
    const stara = `${CSV_REFUSAL_PREFIX} faktura walutowa wymaga uzgodnienia kwot PLN z XML.`;
    expect(exportFixFor({ status: 'failed', format: 'csv_universal', error_message: stara, period_start: '2026-10-01', period_end: '2026-10-31' } as never)).toEqual({
      kind: 'link',
      label: 'Faktury',
      href: '/invoices',
    });
  });

  it('inny błąd dalej daje ogólny komunikat', async () => {
    await onExportsGenerateExhausted(new Error('ECONNRESET przy zapisie pliku'), { exportJobId: 'job-1' });
    expect(db.updates).toEqual([{ status: 'failed', error_message: 'Nie udało się wygenerować pliku. Spróbuj ponownie albo napisz do nas.' }]);
  });
});
