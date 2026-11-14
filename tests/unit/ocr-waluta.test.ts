import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

type Row = Record<string, unknown>;

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OCR_JOB = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const db = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  doc: {} as Record<string, unknown>,
  nbp: vi.fn(),
}));

// AUD-107: budżet AI firmy — tu zawsze w limicie (osobne testy: ai-limit-*).
vi.mock('@/lib/ai/tenant-ai-budget', () => ({
  checkTenantAiBudget: async () => ({ allowed: true }),
  recordTenantAiUsage: async () => undefined,
}));
vi.mock('@/lib/categorization', () => ({
  categorizeExpense: async () => ({ kpir_column: 'col_13', category_label: 'Oprogramowanie', method: 'rule', confidence: 0.5 }),
}));
vi.mock('@/lib/ocr/engine', () => ({
  extractInvoiceFromImage: async () => ({
    success: true,
    data: db.doc,
    inputTokens: 1,
    outputTokens: 1,
    processingTimeMs: 1,
  }),
}));
// Kurs z NBP bez sieci — test sprawdza, CO job z nim robi.
vi.mock('@/lib/nbp/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/nbp/client')>()),
  nbpRateForCost: db.nbp,
}));
vi.mock('@/lib/storage/expenses', () => ({
  downloadExpensePhoto: async () => ({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' }),
}));
vi.mock('@/lib/push/sender', () => ({ sendPushToUser: vi.fn() }));
vi.mock('@/lib/flo/proposals', () => ({ createProposal: vi.fn() }));
vi.mock('@/lib/jobs/runners/tenant-boundary', () => ({ requireTenantMember: vi.fn(async () => undefined) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let insertRow: Row | null = null;
      // Historia sprzedawcy czyta stronami po `id` (sesja 29 planu skalowania).
      let pagedById = false;
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        gt: () => q,
        order: (column: string) => {
          pagedById = column === 'id';
          return q;
        },
        limit: () => q,
        update: () => q,
        insert: (r: Row) => {
          insertRow = r;
          if (table === 'expenses') db.inserts.push(r);
          return q;
        },
        single: async () => {
          if (table === 'ocr_jobs') {
            return {
              data: { id: OCR_JOB, tenant_id: TENANT, created_by: USER, source_file_path: 'r2/x.jpg', source_file_mime: 'image/jpeg' },
              error: null,
            };
          }
          return { data: insertRow ? { id: 'exp-1' } : null, error: null };
        },
        maybeSingle: async () => {
          if (table === 'tenants') return { data: { vat_exemption_basis: null }, error: null };
          if (table === 'memberships') return { data: { user_id: USER }, error: null };
          return { data: null, error: null };
        },
        // Strona historii: pusta lista, jak sprzedawca bez wcześniejszych kosztów.
        then: (ok: (v: { data?: Row[]; error: null }) => unknown) =>
          Promise.resolve(pagedById ? { data: [], error: null } : { error: null }).then(ok),
      });
      return q;
    },
  }),
}));

import { fetchNbpTablesBefore } from '@/lib/nbp/client';
import { costInPln, documentCurrency } from '@/lib/ocr/currency';
import { extractedInvoiceSchema } from '@/lib/ocr/schema';
import { runProcessOcr } from '@/lib/jobs/runners/process-ocr';

/**
 * Koszt w walucie obcej (faktura za oprogramowanie w EUR/USD). Do 29.09 OCR
 * miał „kwoty w PLN”: euro szły do KPiR jako złotówki albo po kursie „z głowy”
 * modelu. Teraz: waluta z dokumentu, kurs średni NBP z ostatniego dnia
 * roboczego PRZED datą dokumentu (art. 11a ust. 2 PIT), numer tabeli przy koszcie.
 */

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const DOKUMENT = {
  seller_name: 'Figma Inc.',
  seller_nip: null,
  seller_address: null,
  document_number: 'INV-2026-0917',
  document_type: 'invoice',
  issue_date: '2026-09-28',
  net_amount: 100,
  vat_amount: 0,
  gross_amount: 100,
  vat_rate: 'np',
  line_items: null,
  ocr_confidence: 0.95,
  notes: null,
};
const KURS = { currency: 'EUR', mid: 4.2567, tableNo: '188/A/NBP/2026', effectiveDate: '2026-09-25' };

beforeEach(() => {
  db.inserts = [];
  db.doc = { ...DOKUMENT, currency: 'EUR' };
  db.nbp.mockReset().mockResolvedValue({ found: true, rate: KURS, gapDays: 3 });
});

describe('schemat OCR — waluta', () => {
  it.each([
    ['EUR', 'EUR'],
    ['eur', 'EUR'],
    ['€', 'EUR'],
    ['zł', 'PLN'],
    [' pln ', 'PLN'],
    ['$', 'USD'],
    [null, undefined],
    [undefined, undefined],
  ])('%j → %j', (wejscie, oczekiwane) => {
    const wynik = extractedInvoiceSchema.parse({ ...DOKUMENT, currency: wejscie });
    expect(wynik.currency).toBe(oczekiwane);
  });

  it('wynik OCR BEZ pola waluty (każdy dotychczasowy) przechodzi jako PLN', () => {
    const wynik = extractedInvoiceSchema.parse(DOKUMENT);
    expect(wynik.currency).toBeUndefined();
    expect(documentCurrency(wynik)).toBe('PLN');
  });

  it('nieznany zapis waluty odrzuca wynik — nie „pewnie złotówki”', () => {
    expect(extractedInvoiceSchema.safeParse({ ...DOKUMENT, currency: 'euros' }).success).toBe(false);
  });
});

describe('costInPln', () => {
  it('ujemna korekta walutowa odwraca kwotę dodatnią co do grosza', () => {
    const lookup = { found: true as const, rate: { currency: 'EUR', mid: 4.255, tableNo: '188/A/NBP/2026', effectiveDate: '2026-09-25' }, gapDays: 1 };
    const plus = costInPln({ currency: 'EUR', net_amount: 1, vat_amount: 0, gross_amount: 1 }, '2026-09-28', lookup);
    const minus = costInPln({ currency: 'EUR', net_amount: -1, vat_amount: 0, gross_amount: -1 }, '2026-09-28', lookup);
    expect(plus.kind).toBe('pln');
    expect(minus.kind).toBe('pln');
    if (plus.kind === 'pln' && minus.kind === 'pln') {
      expect(plus.gross).toBe(4.26);
      expect(minus.gross).toBe(-plus.gross);
      expect(minus.net).toBe(-plus.net);
    }
  });

  it('złotówki bez zmian, VAT do odliczenia wg dotychczasowej reguły', () => {
    expect(costInPln({ currency: 'PLN', net_amount: 100, vat_amount: 23, gross_amount: 123 }, '2026-09-28', null)).toMatchObject({
      kind: 'pln', net: 100, vat: 23, gross: 123, vatDeductible: null, fx: null, note: null,
    });
    expect(documentCurrency({ currency: undefined })).toBe('PLN');
  });

  it.each([
    [' eur ', 'EUR'],
    ['', 'PLN'],
    [null, 'PLN'],
    ['1€', 'PLN'],
  ])('documentCurrency(%j) = %j (np. waluta z bazy, nie z OCR)', (wejscie, oczekiwane) => {
    expect(documentCurrency({ currency: wejscie })).toBe(oczekiwane);
  });

  it('EUR: kwoty × kurs, VAT jako różnica, bez odliczenia, ślad tabeli', () => {
    const wynik = costInPln(
      { currency: 'EUR', net_amount: 100, vat_amount: 19, gross_amount: 119 },
      '2026-09-28',
      { found: true, rate: KURS, gapDays: 3 },
    );
    expect(wynik).toMatchObject({
      kind: 'pln', net: 425.67, gross: 506.55, vat: 80.88, vatDeductible: 0,
      fx: { currency: 'EUR', mid: 4.2567, tableNo: '188/A/NBP/2026', effectiveDate: '2026-09-25', appliedFor: '2026-09-28' },
    });
    expect(wynik.kind === 'pln' && wynik.note).toContain('tabela 188/A/NBP/2026 z 2026-09-25');
  });

  it('brak kursu: kwoty NIE przeliczone, powód dla człowieka', () => {
    const wynik = costInPln(
      { currency: 'EUR', net_amount: 100, vat_amount: 0, gross_amount: 100 },
      '2026-09-28',
      { found: false, reason: 'stale_buffer' },
    );
    expect(wynik.kind).toBe('missing_rate');
    expect(wynik.kind === 'missing_rate' && wynik.note).toMatch(/nie przeliczone.*nie jest liczony do KPiR/);
  });
});

describe('klient NBP', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('okno 10 dni PRZED datą (do dnia poprzedniego), tabele z numerem', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'EUR', rates: [{ no: '188/A/NBP/2026', effectiveDate: '2026-09-25', mid: 4.2567 }] }), { status: 200 }),
    );
    const tabele = await fetchNbpTablesBefore('eur', '2026-09-28');
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.nbp.pl/api/exchangerates/rates/a/eur/2026-09-18/2026-09-27/?format=json');
    expect(tabele).toEqual([KURS]);
  });

  it('404 (brak tabel/waluty) → pusta lista; 5xx → wyjątek (job ponowi)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
    await expect(fetchNbpTablesBefore('EUR', '2026-09-28')).resolves.toEqual([]);
    fetchMock.mockResolvedValueOnce(new Response('err', { status: 503 }));
    await expect(fetchNbpTablesBefore('EUR', '2026-09-28')).rejects.toThrow(/NBP: HTTP 503/);
  });

  it('nie-kod waluty nie idzie do NBP', async () => {
    await expect(fetchNbpTablesBefore('euro', '2026-09-28')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('job OCR — dokument w walucie obcej', () => {
  it('EUR: wydatek w złotych po kursie NBP z dnia przed datą, ze śladem kursu', async () => {
    await runProcessOcr({ ocrJobId: OCR_JOB, tenantId: TENANT }, ctx);
    expect(db.nbp).toHaveBeenCalledWith('EUR', '2026-09-28');
    expect(db.inserts[0]).toMatchObject({ net_amount: 425.67, vat_amount: 0, gross_amount: 425.67, vat_deductible_amount: 0 });
    expect(db.inserts[0]!.is_deductible).toBeUndefined(); // domyślnie koszt
    expect(String(db.inserts[0]!.notes)).toContain('Przeliczono z 100,00 EUR');
    expect(db.inserts[0]!.ocr_extracted_data).toMatchObject({ currency: 'EUR', net_amount: 100, fx: { tableNo: '188/A/NBP/2026' } });
  });

  it('brak kursu: kwoty z dokumentu, ALE poza KPiR (is_deductible false) z uwagą', async () => {
    db.nbp.mockResolvedValue({ found: false, reason: 'no_table_before' });
    await runProcessOcr({ ocrJobId: OCR_JOB, tenantId: TENANT }, ctx);
    expect(db.inserts[0]).toMatchObject({ gross_amount: 100, is_deductible: false, vat_deductible_amount: 0 });
    expect(String(db.inserts[0]!.notes)).toContain('nie przeliczone');
  });

  it('NBP nie odpowiada: job rzuca (ponowienie), wydatek nie powstaje', async () => {
    db.nbp.mockRejectedValue(new Error('NBP: HTTP 503'));
    await expect(runProcessOcr({ ocrJobId: OCR_JOB, tenantId: TENANT }, ctx)).rejects.toThrow('NBP');
    expect(db.inserts).toEqual([]);
  });

  it('złotówki: bez NBP, bez zmian (VAT do odliczenia jak dotąd)', async () => {
    db.doc = { ...DOKUMENT, currency: 'PLN', net_amount: 100, vat_amount: 23, gross_amount: 123, vat_rate: '23' };
    await runProcessOcr({ ocrJobId: OCR_JOB, tenantId: TENANT }, ctx);
    expect(db.nbp).not.toHaveBeenCalled();
    expect(db.inserts[0]).toMatchObject({ net_amount: 100, vat_amount: 23, gross_amount: 123, vat_deductible_amount: 23, notes: null });
  });
});
