import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E17b: koszt ze zdjęcia (OCR) w walucie obcej bez kursu NBP.
 *
 * Job OCR (`lib/jobs/runners/process-ocr.ts`, `cost.kind === 'missing_rate'`)
 * zapisuje kwoty w walucie dokumentu, `is_deductible: false` i ślad waluty
 * w `ocr_extracted_data.currency` bez `fx`. Do tej poprawki:
 *  - klient wpisywał kwoty w złotych, klikał „Zaakceptuj” i koszt zostawał
 *    na stałe poza KPiR (`is_deductible` dalej false, `is_reviewed` true);
 *  - sam checkbox „Uwzględnij w KPiR” wpuszczał 100 AED do KPiR jako 100 zł
 *    (blokada waluty działała tylko dla kosztów KSeF).
 *
 * Prawdziwa akcja `reviewExpenseAction`; atrapa tylko bazy (klient Supabase)
 * i zależności poza ścieżką zapisu.
 */

const mocks = vi.hoisted(() => ({
  existing: null as Record<string, unknown> | null,
  patches: [] as Record<string, unknown>[],
  adminCalls: [] as { fn: string; args: Record<string, unknown> }[],
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/categorization', () => ({ learnFromCorrection: vi.fn() }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: vi.fn() }));
vi.mock('@/lib/jobs/events', () => ({ ocrProcessPhotoRequested: { create: vi.fn() } }));
vi.mock('@/lib/jobs/error-message', () => ({ formatJobSendError: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      mocks.adminCalls.push({ fn, args });
      return { data: 'exp-1', error: null };
    },
  }),
}));
vi.mock('@/lib/supabase/auth-context', () => ({ requireUserAndActiveOrg: vi.fn() }));
vi.mock('@/lib/storage/expenses', () => ({ uploadExpensePhoto: vi.fn(), deleteExpensePhoto: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      let patch: Record<string, unknown> | null = null;
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        update: (p: Record<string, unknown>) => {
          patch = p;
          mocks.patches.push(p);
          return q;
        },
        maybeSingle: async () => {
          if (patch) return { data: { id: 'exp-1' }, error: null };
          if (table === 'invoices') return { data: { currency: 'EUR' }, error: null };
          return { data: mocks.existing, error: null };
        },
      });
      return q;
    },
  }),
}));

import { reviewExpenseAction } from '@/app/actions/expenses';
import { requireUserAndActiveOrg } from '@/lib/supabase/auth-context';
import { createClient } from '@/lib/supabase/server';

type Updates = Parameters<typeof reviewExpenseAction>[1];

/** Ślad OCR paragonu z Dubaju: AED, NBP nie publikuje kursu w tabeli A. */
const aedTrace = (fields: Record<string, unknown> = {}) => ({
  seller_name: 'Hotel Marina LLC',
  seller_nip: null,
  document_type: 'receipt',
  issue_date: '2026-10-20',
  currency: 'AED',
  net_amount: 95.24,
  vat_amount: 4.76,
  gross_amount: 100,
  ocr_confidence: 0.93,
  ...fields,
});

/** Wiersz `expenses` tak, jak zapisuje go job OCR przy braku kursu. */
const ocrAed = (fields: Record<string, unknown> = {}) => ({
  seller_nip: null,
  seller_name: 'Hotel Marina LLC',
  kpir_column: 'col_13',
  category_label: 'Podróże służbowe',
  vat_amount: 4.76,
  vat_deductible_amount: 0,
  is_deductible: false,
  source: 'ocr_photo',
  ksef_invoice_id: null,
  issue_date: '2026-10-20',
  updated_at: '2026-10-20T10:00:00Z',
  ocr_extracted_data: aedTrace(),
  ...fields,
});

/** Kwoty po przeliczeniu przez klienta (kurs przykładowy 1,08 zł za 1 AED). */
const plnAmounts = { net_amount: 102.86, vat_amount: 5.14, gross_amount: 108 };

beforeEach(() => {
  mocks.patches = [];
  mocks.adminCalls = [];
  mocks.existing = null;
  vi.mocked(requireUserAndActiveOrg).mockImplementation(async () => ({
    supabase: await createClient(),
    user: { id: 'u-1' },
    tenantId: 'ten-1',
    role: 'member',
  }) as unknown as Awaited<ReturnType<typeof requireUserAndActiveOrg>>);
});

describe('koszt OCR w walucie bez kursu NBP', () => {
  it('kwoty wpisane w złotych i potwierdzone: koszt wchodzi do KPiR jako przejrzany', async () => {
    mocks.existing = ocrAed();
    const result = await reviewExpenseAction('exp-1', {
      ...plnAmounts,
      confirmPlnAmounts: true,
    } as Updates);

    expect(result).toEqual({ success: true });
    expect(mocks.patches).toHaveLength(1);
    const patch = mocks.patches[0]!;
    expect(patch).toMatchObject({ ...plnAmounts, is_deductible: true, is_reviewed: true });
    // Oryginalny odczyt dokumentu zostaje, dochodzi ślad potwierdzenia.
    expect(patch.ocr_extracted_data).toMatchObject({
      ...aedTrace(),
      pln_confirmation: { confirmed_by: 'u-1', confirmed_at: expect.any(String) },
    });
    expect(mocks.adminCalls).toEqual([]);
  });

  it('sam checkbox „Uwzględnij w KPiR” bez potwierdzenia nie wpuszcza 100 AED jako 100 zł', async () => {
    mocks.existing = ocrAed();
    const result = await reviewExpenseAction('exp-1', { gross_amount: 100, is_deductible: true });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('AED') });
    expect(mocks.patches).toEqual([]);
  });

  it('zapis poza KPiR bez potwierdzenia zostawia koszt do opisania', async () => {
    mocks.existing = ocrAed();
    const result = await reviewExpenseAction('exp-1', { notes: 'sprawdzę kurs', is_deductible: false });

    expect(result).toEqual({ success: true });
    expect(mocks.patches[0]).toMatchObject({ is_deductible: false, is_reviewed: false, notes: 'sprawdzę kurs' });
    expect(mocks.patches[0]).not.toHaveProperty('ocr_extracted_data');
  });

  it('historyczny koszt AED w KPiR bez potwierdzenia: brak pola is_deductible nie obchodzi blokady', async () => {
    mocks.existing = ocrAed({ is_deductible: true });
    const result = await reviewExpenseAction('exp-1', { notes: 'zmiana notatki' });

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('AED') });
    expect(mocks.patches).toEqual([]);
  });

  it('potwierdzenie z odznaczonym KPiR: kwoty w złotych, koszt świadomie poza KPiR', async () => {
    mocks.existing = ocrAed();
    const result = await reviewExpenseAction('exp-1', {
      ...plnAmounts,
      is_deductible: false,
      confirmPlnAmounts: true,
    } as Updates);

    expect(result).toEqual({ success: true });
    expect(mocks.patches[0]).toMatchObject({ is_deductible: false, is_reviewed: true });
    expect(mocks.patches[0]!.ocr_extracted_data).toMatchObject({
      currency: 'AED',
      pln_confirmation: { confirmed_by: 'u-1' },
    });
  });

  it('VAT z dokumentu w walucie nie idzie do odliczenia także po ręcznej poprawce', async () => {
    // Paragon bez VAT w odczycie: przed poprawką 0 → 5,14 dawało pełne odliczenie w JPK_V7M.
    mocks.existing = ocrAed({
      vat_amount: 0,
      ocr_extracted_data: aedTrace({ net_amount: 100, vat_amount: 0 }),
    });
    await reviewExpenseAction('exp-1', { ...plnAmounts, confirmPlnAmounts: true } as Updates);

    expect(mocks.patches[0]).toMatchObject({ vat_amount: 5.14, vat_deductible_amount: 0 });
  });

  it('koszt przeliczony kursem NBP (ślad fx) też nie odlicza VAT po poprawce z zera', async () => {
    const fx = { currency: 'EUR', mid: 4.25, tableNo: '203/A/NBP/2026', effectiveDate: '2026-10-19', appliedFor: '2026-10-20' };
    mocks.existing = ocrAed({
      is_deductible: true,
      vat_amount: 0,
      ocr_extracted_data: aedTrace({ currency: 'EUR', vat_amount: 0, fx }),
    });
    await reviewExpenseAction('exp-1', { vat_amount: 19.5 });

    expect(mocks.patches[0]).toMatchObject({ vat_amount: 19.5, vat_deductible_amount: 0 });
  });
});

describe('ścieżki bez zmian (straż regresji)', () => {
  it('po potwierdzeniu koszt jest zwykłym kosztem w złotych: KPiR bez ponownego potwierdzenia', async () => {
    mocks.existing = ocrAed({
      is_reviewed: true,
      ocr_extracted_data: {
        ...aedTrace(),
        pln_confirmation: { confirmed_by: 'u-1', confirmed_at: '2026-10-21T08:00:00.000Z' },
      },
    });
    const result = await reviewExpenseAction('exp-1', { is_deductible: true });

    expect(result).toEqual({ success: true });
    expect(mocks.patches[0]).toMatchObject({ is_deductible: true, is_reviewed: true });
    expect(mocks.patches[0]).not.toHaveProperty('ocr_extracted_data');
  });

  it('koszt przeliczony automatycznie kursem NBP wchodzi do KPiR bez potwierdzenia', async () => {
    const fx = { currency: 'EUR', mid: 4.25, tableNo: '203/A/NBP/2026', effectiveDate: '2026-10-19', appliedFor: '2026-10-20' };
    mocks.existing = ocrAed({ ocr_extracted_data: aedTrace({ currency: 'EUR', fx }) });
    const result = await reviewExpenseAction('exp-1', { is_deductible: true });

    expect(result).toEqual({ success: true });
    expect(mocks.patches[0]).toMatchObject({ is_deductible: true, is_reviewed: true });
  });

  it('paragon w złotych: poprawka VAT z zera daje pełne odliczenie jak dotąd', async () => {
    mocks.existing = ocrAed({
      is_deductible: true,
      vat_amount: 0,
      ocr_extracted_data: aedTrace({ currency: 'PLN', vat_amount: 0 }),
    });
    const result = await reviewExpenseAction('exp-1', { vat_amount: 23, is_deductible: true });

    expect(result).toEqual({ success: true });
    expect(mocks.patches[0]).toMatchObject({ vat_amount: 23, vat_deductible_amount: 23 });
  });

  it('koszt KSeF: pole potwierdzenia złotych odrzucane jak każde pole spoza listy', async () => {
    mocks.existing = ocrAed({
      source: 'ksef_inbox',
      ksef_invoice_id: 'inv-1',
      ocr_extracted_data: { source: 'ksef_inbox', currency: 'EUR', fx: null },
    });
    const result = await reviewExpenseAction('exp-1', { is_deductible: false, confirmPlnAmounts: true } as Updates);

    expect(result).toMatchObject({ success: false, error: 'Nieprawidłowe dane wydatku KSeF' });
    expect(mocks.adminCalls).toEqual([]);
  });
});
