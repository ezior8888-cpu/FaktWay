import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  invoice: null as Row | null,
  inserts: [] as Row[],
  categorized: [] as Row[],
  nbp: vi.fn(),
}));

vi.mock('@/lib/ksef/inbox-xml', () => ({ archiveInboxInvoiceXml: async () => ({ archived: false, reason: 'not-applicable' }) }));
vi.mock('@/lib/categorization', () => ({
  categorizeExpense: async (_tenantId: string, extracted: Row) => {
    db.categorized.push(extracted);
    return { kpir_column: 'col_13', category_label: 'Usługi', method: 'rule', confidence: 0.95 };
  },
}));
vi.mock('@/lib/nbp/client', () => ({ nbpRateForCost: db.nbp }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let insertRow: Row | null = null;
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        limit: () => q,
        // Krok 1.3 (00175): po zapisie kosztu runner szuka paragonu z NIP do
        // faktury (lista kosztów). Tu nie ma żadnego, więc lista jest pusta.
        is: () => q,
        neq: () => q,
        gte: () => q,
        lte: () => q,
        order: () => q,
        then: (ok: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(ok),
        insert: (r: Row) => {
          insertRow = r;
          db.inserts.push(r);
          return q;
        },
        single: async () => {
          if (table === 'invoices') return { data: db.invoice, error: null };
          return { data: insertRow ? { id: 'exp-1' } : null, error: null };
        },
        maybeSingle: async () => {
          if (table === 'invoices') return { data: db.invoice, error: null };
          if (table === 'memberships') return { data: { user_id: 'u-1' }, error: null };
          return { data: null, error: null };
        },
      });
      return q;
    },
  }),
}));

import { runAutoCategorizeInbox } from '@/lib/jobs/runners/auto-categorize-inbox';

/**
 * Korekta zakupu „in minus” ze skrzynki KSeF (dostawca obniża cenę) ma ujemne
 * kwoty. Do 27.09 auto-kategoryzacja ją pomijała („brak dodatniej kwoty”),
 * więc koszt w KPiR i VAT do odliczenia zostawały zawyżone — a po #58 eksport
 * KPiR/JPK liczy koszty wyłącznie z wydatków.
 */

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};
const DANE = {
  invoiceId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  environment: 'test' as const,
};

// Tak zapisuje skrzynka (inbox-polling): kwoty z metadanych KSeF, bez pozycji.
function faktura(o: Row): Row {
  return {
    id: DANE.invoiceId,
    tenant_id: DANE.tenantId,
    direction: 'incoming',
    origin: 'ksef_inbox',
    ksef_status: 'accepted',
    ksef_environment: 'test',
    ksef_number: '5260001246-20260925-000000000001-00',
    internal_number: 'KOR 1/09/2026',
    issue_date: '2026-09-25',
    currency: 'PLN',
    seller_data: null,
    seller_nip: '5260001246',
    fa3_data: { _source: 'inbox-metadata', invoiceType: 'Kor', seller: { name: 'Dostawca', nip: '5260001246' } },
    invoice_line_items: [],
    ...o,
  };
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.inserts = [];
  db.categorized = [];
  db.nbp.mockReset().mockResolvedValue({
    found: true,
    rate: { currency: 'EUR', mid: 4.25, tableNo: '187/A/NBP/2026', effectiveDate: '2026-09-24' },
    gapDays: 1,
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('korekta zakupu „in minus” ze skrzynki KSeF', () => {
  it('powstaje ujemny koszt — obniża KPiR i VAT do odliczenia', async () => {
    db.invoice = faktura({ gross_total: -123, net_total: -100, vat_total: -23 });
    await runAutoCategorizeInbox(DANE, ctx);
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({
      net_amount: -100,
      vat_amount: -23,
      gross_amount: -123,
      vat_deductible_amount: -23,
      vat_rate: '23',
      document_number: 'KOR 1/09/2026',
    });
  });

  it('kategoryzacja dostaje kwoty bez znaku (progi reguł jak dla faktury)', async () => {
    db.invoice = faktura({ gross_total: -123, net_total: -100, vat_total: -23 });
    await runAutoCategorizeInbox(DANE, ctx);
    expect(db.categorized[0]).toMatchObject({ net_amount: 100, vat_amount: 23, gross_amount: 123 });
  });

  it('zwykła faktura bez zmian', async () => {
    db.invoice = faktura({ internal_number: 'FV 1/2026', gross_total: 123, net_total: 100, vat_total: 23 });
    await runAutoCategorizeInbox(DANE, ctx);
    expect(db.inserts[0]).toMatchObject({ net_amount: 100, vat_amount: 23, gross_amount: 123, vat_deductible_amount: 23 });
  });

  it('zerowa kwota — nadal pomijamy, bez zapisu', async () => {
    db.invoice = faktura({ gross_total: 0, net_total: 0, vat_total: 0 });
    await expect(runAutoCategorizeInbox(DANE, ctx)).rejects.toThrow(/Brak kwoty brutto/);
    expect(db.inserts).toEqual([]);
  });
});

describe('waluta kosztu z inbox KSeF', () => {
  it('EUR: kwoty przeliczone, ale koszt czeka poza KPiR na sprawdzenie XML', async () => {
    // KSeF InvoiceMetadata: netto/brutto w EUR, ale vatAmount już w PLN.
    db.invoice = faktura({ currency: 'EUR', gross_total: 123, net_total: 100, vat_total: 98.75 });
    await runAutoCategorizeInbox(DANE, ctx);

    expect(db.nbp).toHaveBeenCalledWith('EUR', '2026-09-25');
    expect(db.categorized[0]).toMatchObject({ net_amount: 425, gross_amount: 522.75 });
    expect(db.inserts[0]).toMatchObject({
      net_amount: 425,
      vat_amount: 98.75,
      gross_amount: 522.75,
      vat_deductible_amount: 0,
      is_deductible: false,
      is_reviewed: false,
      vat_rate: '23',
      ocr_extracted_data: {
        currency: 'EUR',
        net_amount: 100,
        gross_amount: 123,
        vat_amount_pln_metadata: 98.75,
        fx: { mid: 4.25, tableNo: '187/A/NBP/2026', effectiveDate: '2026-09-24' },
      },
    });
    expect(String(db.inserts[0]?.notes)).toContain('187/A/NBP/2026');
  });

  it('ujemna korekta EUR obniża koszt po przeliczeniu, bez automatycznego VAT', async () => {
    db.invoice = faktura({ currency: 'EUR', gross_total: -123, net_total: -100, vat_total: -98.75 });
    await runAutoCategorizeInbox(DANE, ctx);
    expect(db.categorized[0]).toMatchObject({ net_amount: 425, gross_amount: 522.75 });
    expect(db.inserts[0]).toMatchObject({
      net_amount: -425, vat_amount: -98.75, gross_amount: -522.75,
      vat_deductible_amount: 0, is_deductible: false, is_reviewed: false,
    });
  });

  it('bez kursu zachowuje kwotę źródłową, ale wyłącza koszt z KPiR i VAT', async () => {
    db.nbp.mockResolvedValue({ found: false, reason: 'no_table_before' });
    db.invoice = faktura({ currency: 'EUR', gross_total: 123, net_total: 100, vat_total: 98.75 });
    await runAutoCategorizeInbox(DANE, ctx);
    expect(db.inserts[0]).toMatchObject({
      gross_amount: 123, vat_amount: 0, is_deductible: false, vat_deductible_amount: 0, is_reviewed: false,
    });
    expect(db.inserts[0]?.ocr_extracted_data).toMatchObject({ vat_amount_pln_metadata: 98.75 });
    expect(db.inserts[0]).toMatchObject({ category_label: 'Do weryfikacji waluty', categorization_method: 'manual' });
    expect(db.categorized).toEqual([]);
    expect(String(db.inserts[0]?.notes)).toContain('nie przeliczone');
  });

  it('awaria NBP nie tworzy kosztu z kwotą w EUR jako PLN', async () => {
    db.nbp.mockRejectedValue(new Error('NBP: HTTP 503'));
    db.invoice = faktura({ currency: 'EUR', gross_total: 123, net_total: 100, vat_total: 98.75 });
    await expect(runAutoCategorizeInbox(DANE, ctx)).rejects.toThrow('NBP: HTTP 503');
    expect(db.inserts).toEqual([]);
  });

  it('brak poprawnej waluty w metadanych KSeF nie tworzy kosztu', async () => {
    db.invoice = faktura({ currency: null, gross_total: 123, net_total: 100, vat_total: 23 });
    await expect(runAutoCategorizeInbox(DANE, ctx)).rejects.toThrow(/Brak poprawnej waluty/);
    expect(db.inserts).toEqual([]);
  });

  it('brak vatAmount w nullable kolumnie nie tworzy pozornego kosztu PLN z VAT 0', async () => {
    db.invoice = faktura({ currency: 'PLN', gross_total: 123, net_total: 100, vat_total: null });
    await expect(runAutoCategorizeInbox(DANE, ctx)).rejects.toThrow(/Brak poprawnej kwoty VAT/);
    expect(db.inserts).toEqual([]);
  });
});
