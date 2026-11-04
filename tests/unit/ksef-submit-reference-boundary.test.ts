import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Invoice } from '@/types/invoice';
import type { CorrectionInvoiceData, AdvanceInvoiceData, FinalInvoiceData } from '@/types/invoice-types';
import { sellerPartyFromSellerData } from '@/lib/invoices/map-buyer-party';
import { assertSubmitReferences } from '@/lib/ksef/submit-reference-boundary';

vi.mock('@/lib/xml/invoice-calculator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/xml/invoice-calculator')>(),
  // The NIP in this fixture is deliberately fictional.
  validateNipChecksum: () => true,
}));

const tenantId = '11111111-1111-4111-8111-111111111111';
const invoiceId = '22222222-2222-4222-8222-222222222222';
const parentId = '33333333-3333-4333-8333-333333333333';
const nip = '1234567890';
const seller = {
  nip, name: 'Fixture seller',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
};
const sellerParty = sellerPartyFromSellerData(seller);
const buyerAddress = { countryCode: 'PL', addressLine1: 'ul. Odbiorcy 2', addressLine2: '00-002 Warszawa' };
const correction = {
  invoiceType: 'correction', internalNumber: 'KOR/1', parentInvoiceId: parentId,
  parentInvoiceNumber: 'VAT/1', parentInvoiceIssueDate: '2026-09-01',
  parentKsefNumber: 'KSEF-PROD-1', seller: { nip },
  buyer: { type: 'b2b', idType: 'nip', nip, name: 'Fixture buyer', address: buyerAddress },
} as CorrectionInvoiceData;
const euAddress = { countryCode: 'DE', addressLine1: 'Hauptstrasse 1', addressLine2: '10115 Berlin' };
const euCorrection = {
  ...correction,
  buyer: { type: 'eu', vatUeNumber: 'DE123456789', name: 'Kunde GmbH', address: euAddress },
} as CorrectionInvoiceData;
const advance = {
  invoiceType: 'advance', internalNumber: 'ZAL/1', seller,
  issueDate: '2026-09-28', advanceAmount: 123, totalContractAmount: 1000,
  vatRate: '23', description: 'Zaliczka na usługę',
  buyer: {
    type: 'b2b', idType: 'nip', nip: '9876543210', name: 'Fixture buyer',
    address: { countryCode: 'PL', addressLine1: 'ul. Odbiorcy 2', addressLine2: '00-002 Warszawa' },
  },
  paymentMethod: 'transfer', paymentDueDate: '2026-09-28', bankAccount: '11111111111111111111111111',
  taxAnnotations: { cashMethod: 2, splitPayment: 2 },
} as AdvanceInvoiceData;
const final = {
  invoiceType: 'final', internalNumber: 'ROZ/1', advanceInvoiceIds: [parentId], seller,
  paymentMethod: 'transfer', bankAccount: '11111111111111111111111111',
  taxAnnotations: { cashMethod: 1, splitPayment: 2 },
} as FinalInvoiceData;

type Row = Record<string, unknown>;
let invoice: Row;
let eventInvoice: Invoice;
let parent: Row;
let tenant: Row;
let readError: string | null;
let reads: Array<{ table: string; filters: Record<string, unknown>; columns: string[] }>;

function from(table: string) {
  const record = { table, filters: {} as Record<string, unknown>, columns: [] as string[] };
  reads.push(record);
  const chain = {
    // Jak PostgREST: wiersz ma tylko kolumny z SELECT — kolumna, której kod
    // nie pobrał (np. `special_data`), w teście też jej nie ma.
    select: (columns: string) => { record.columns = columns.split(',').map((c) => c.trim()); return chain; },
    eq: (key: string, value: unknown) => { record.filters[key] = value; return chain; },
    maybeSingle: async () => {
      if (readError === table) return { data: null, error: { message: 'temporary-db-error' } };
      const row = table === 'tenants' ? tenant :
        table === 'invoices' && reads.length === 1 ? invoice : parent;
      const match = Object.entries(record.filters).every(([key, value]) => row[key] === value);
      const projected = Object.fromEntries(record.columns.filter((c) => c in row).map((c) => [c, row[c]]));
      return { data: match ? projected : null, error: null };
    },
  };
  return chain;
}
const supabase = { from } as unknown as SupabaseClient;

beforeEach(() => {
  reads = [];
  readError = null;
  invoice = {
    id: invoiceId, tenant_id: tenantId, direction: 'outgoing', invoice_kind: 'correction',
    internal_number: 'KOR/1', parent_invoice_id: parentId, advance_invoice_ids: [],
  };
  setDocument('KOR/1', 'KOR');
  parent = {
    id: parentId, tenant_id: tenantId, direction: 'outgoing', invoice_kind: 'regular',
    ksef_status: 'accepted', ksef_environment: 'test', internal_number: 'VAT/1',
    issue_date: '2026-09-01', ksef_number: 'KSEF-PROD-1', seller_nip: nip,
    buyer_data: { nip, name: 'Fixture buyer', address: buyerAddress, jst: 2, gv: 2 },
  };
  tenant = { id: tenantId, nip, name: seller.name, address_json: seller.address };
});

function setDocument(internalNumber: string, type: Invoice['type']) {
  eventInvoice = {
    internalNumber, type, seller: sellerParty,
    ...(type === 'ZAL' ? {
      advanceEnvelope: advance,
      annotations: advance.taxAnnotations,
      payment: {
        method: 'transfer', dueDate: advance.paymentDueDate,
        bankAccount: advance.bankAccount,
      },
    } : {}),
    ...(type === 'ROZ' ? { annotations: final.taxAnnotations } : {}),
  } as Invoice;
  invoice.internal_number = internalNumber;
  invoice.invoice_type = type;
  invoice.fa3_data = JSON.parse(JSON.stringify(eventInvoice));
  invoice.seller_nip = nip;
  invoice.seller_data = JSON.parse(JSON.stringify(sellerParty));
}

const input = () => ({
  supabase, tenantId, invoiceId, invoice: eventInvoice, environment: 'test' as const,
  correctionData: correction,
});

describe('KSeF submit reference boundary', () => {
  it('allows a matching correction only after reading the stored parent in the current environment', async () => {
    await expect(assertSubmitReferences(input())).resolves.toBe('correction');
    expect(reads).toHaveLength(2);
    expect(reads[0]?.filters).toMatchObject({
      id: invoiceId, tenant_id: tenantId, direction: 'outgoing',
    });
    expect(reads[1]?.filters).toMatchObject({
      id: parentId, tenant_id: tenantId, ksef_status: 'accepted',
      ksef_environment: 'test', invoice_kind: 'regular', direction: 'outgoing',
    });
  });

  it('blocks an incoming invoice even when its legal document matches the event', async () => {
    invoice.direction = 'incoming';
    await expect(assertSubmitReferences(input())).rejects.toThrow('manual reconciliation');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.filters).toMatchObject({ direction: 'outgoing' });
  });

  it.each([
    ['foreign parent', { tenant_id: '44444444-4444-4444-8444-444444444444' }],
    ['PROD parent', { ksef_environment: 'production' }],
    ['legacy parent', { ksef_environment: null }],
    ['not accepted', { ksef_status: 'draft' }],
    ['missing KSeF number', { ksef_number: null }],
  ])('blocks a %s before KSeF I/O', async (_label, patch) => {
    parent = { ...parent, ...patch };
    await expect(assertSubmitReferences(input())).rejects.toThrow('manual reconciliation');
  });

  it('blocks an Offline24 replay that lost correction data', async () => {
    await expect(assertSubmitReferences({ ...input(), correctionData: undefined }))
      .rejects.toThrow('manual reconciliation');
    expect(reads).toHaveLength(1);
  });

  it('holds correction submission in PROD pending original XML and correction-chain proof', async () => {
    await expect(assertSubmitReferences({ ...input(), environment: 'production' }))
      .rejects.toThrow('manual reconciliation');
    expect(reads).toHaveLength(1);
  });

  it('blocks a changed correction parent and forged metadata', async () => {
    invoice.parent_invoice_id = '55555555-5555-4555-8555-555555555555';
    await expect(assertSubmitReferences(input())).rejects.toThrow('manual reconciliation');
    invoice.parent_invoice_id = parentId;
    reads = [];
    await expect(assertSubmitReferences({
      ...input(), correctionData: { ...correction, parentInvoiceNumber: 'FORGED' },
    })).rejects.toThrow('manual reconciliation');
  });

  it('blocks a correction whose buyer NIP differs from the accepted parent buyer', async () => {
    await expect(assertSubmitReferences({
      ...input(),
      correctionData: { ...correction, buyer: { ...correction.buyer, nip: '9876543210' } as CorrectionInvoiceData['buyer'] },
    })).rejects.toThrow('manual reconciliation');
  });

  it('accepts a formatted but equal buyer NIP', async () => {
    await expect(assertSubmitReferences({
      ...input(),
      correctionData: { ...correction, buyer: { ...correction.buyer, nip: '123-456-78-90' } as CorrectionInvoiceData['buyer'] },
    })).resolves.toBe('correction');
  });

  it.each([
    ['parent without buyer data', () => { parent.buyer_data = null; }],
    ['parent buyer without identifier', () => { parent.buyer_data = { name: 'Fixture buyer', address: buyerAddress }; }],
    ['parent buyer identified only by VAT-UE', () => {
      parent.buyer_data = { vatUeNumber: 'DE123456789', name: 'Kunde GmbH', address: euAddress };
    }],
  ])('blocks a NIP correction for a %s', async (_label, patch) => {
    patch();
    await expect(assertSubmitReferences(input())).rejects.toThrow('manual reconciliation');
  });

  it('blocks a correction without buyer or with a private-person buyer (no B2C corrections)', async () => {
    await expect(assertSubmitReferences({
      ...input(), correctionData: { ...correction, buyer: undefined } as unknown as CorrectionInvoiceData,
    })).rejects.toThrow('manual reconciliation');
    reads = [];
    parent.buyer_data = { noIdMarker: true, name: 'Konsument', address: buyerAddress };
    await expect(assertSubmitReferences({
      ...input(),
      correctionData: {
        ...correction,
        buyer: { type: 'b2c', idType: 'no_id', name: 'Konsument', address: buyerAddress },
      },
    })).rejects.toThrow('manual reconciliation');
  });

  describe('EU buyer (VAT-UE, AUD-70)', () => {
    beforeEach(() => {
      parent.buyer_data = { vatUeNumber: 'DE123456789', name: 'Kunde GmbH', address: euAddress, jst: 2, gv: 2 };
    });

    it('allows a correction whose VAT-UE equals the parent buyer VAT-UE', async () => {
      await expect(assertSubmitReferences({ ...input(), correctionData: euCorrection })).resolves.toBe('correction');
    });

    it('compares the canonical VAT-UE form, not raw spelling', async () => {
      await expect(assertSubmitReferences({
        ...input(),
        correctionData: { ...euCorrection, buyer: { ...euCorrection.buyer, vatUeNumber: 'de 123 456 789' } as CorrectionInvoiceData['buyer'] },
      })).resolves.toBe('correction');
    });

    it.each([
      ['another VAT-UE number', 'DE987654321'],
      ['the same digits under another country prefix', 'AT123456789'],
      ['an unparseable number', 'GR123456789'],
    ])('blocks %s', async (_label, vatUeNumber) => {
      await expect(assertSubmitReferences({
        ...input(),
        correctionData: { ...euCorrection, buyer: { ...euCorrection.buyer, vatUeNumber } as CorrectionInvoiceData['buyer'] },
      })).rejects.toThrow('manual reconciliation');
    });

    it('blocks type mismatch both ways: EU correction for a NIP parent and NIP correction for an EU parent', async () => {
      await expect(assertSubmitReferences(input())).rejects.toThrow('manual reconciliation');
      reads = [];
      parent.buyer_data = { nip, name: 'Fixture buyer', address: buyerAddress };
      await expect(assertSubmitReferences({ ...input(), correctionData: euCorrection }))
        .rejects.toThrow('manual reconciliation');
    });

    it('blocks an EU correction when the parent XML identified the buyer by NIP (NIP wins in FA(3))', async () => {
      parent.buyer_data = { nip, vatUeNumber: 'DE123456789', name: 'Kunde GmbH', address: euAddress };
      await expect(assertSubmitReferences({ ...input(), correctionData: euCorrection }))
        .rejects.toThrow('manual reconciliation');
    });

    it('blocks a parent with a Polish VAT-UE (not a buyer from another EU state)', async () => {
      parent.buyer_data = { vatUeNumber: 'PL1234567890', name: 'Kunde GmbH', address: euAddress };
      await expect(assertSubmitReferences({
        ...input(),
        correctionData: { ...euCorrection, buyer: { ...euCorrection.buyer, vatUeNumber: 'PL1234567890' } as CorrectionInvoiceData['buyer'] },
      })).rejects.toThrow('manual reconciliation');
    });

    it('keeps the PROD hold for an EU correction', async () => {
      await expect(assertSubmitReferences({ ...input(), environment: 'production', correctionData: euCorrection }))
        .rejects.toThrow('manual reconciliation');
      expect(reads).toHaveLength(1);
    });
  });

  it('keeps ordinary VAT payloads and rejects subtype data on a regular invoice', async () => {
    invoice.invoice_kind = 'regular';
    setDocument('VAT/1', 'VAT');
    await expect(assertSubmitReferences({ ...input(), correctionData: undefined })).resolves.toBe('regular');
    reads = [];
    await expect(assertSubmitReferences(input())).rejects.toThrow('manual reconciliation');
  });

  it('blocks incomplete advance and final payloads instead of falling back to VAT XML', async () => {
    invoice.invoice_kind = 'advance';
    setDocument('ZAL/1', 'ZAL');
    await expect(assertSubmitReferences({ ...input(), correctionData: undefined }))
      .rejects.toThrow('manual reconciliation');
    reads = [];
    await expect(assertSubmitReferences({ ...input(), correctionData: undefined, advanceData: advance }))
      .resolves.toBe('advance');
    invoice.invoice_kind = 'final';
    setDocument('ROZ/1', 'ROZ');
    invoice.advance_invoice_ids = [parentId];
    reads = [];
    await expect(assertSubmitReferences({ ...input(), correctionData: undefined }))
      .rejects.toThrow('manual reconciliation');
    reads = [];
    await expect(assertSubmitReferences({
      ...input(), environment: 'production', correctionData: undefined,
      finalData: final, finalAdvanceSettlementRows: [{}],
    })).rejects.toThrow('manual reconciliation');
    reads = [];
    await expect(assertSubmitReferences({
      ...input(), environment: 'test', correctionData: undefined,
      finalData: final, finalAdvanceSettlementRows: [{}],
    })).resolves.toBe('final');
    invoice.advance_invoice_ids = ['different'];
    reads = [];
    await expect(assertSubmitReferences({
      ...input(), environment: 'test', correctionData: undefined,
      finalData: final, finalAdvanceSettlementRows: [{}],
    })).rejects.toThrow('manual reconciliation');
  });

  it.each(['advance', 'final'] as const)(
    'rejects a %s envelope seller changed after enqueue before KSeF I/O',
    async (kind) => {
      invoice.invoice_kind = kind;
      setDocument(kind === 'advance' ? 'ZAL/1' : 'ROZ/1', kind === 'advance' ? 'ZAL' : 'ROZ');
      invoice.advance_invoice_ids = kind === 'final' ? [parentId] : [];
      const changedSeller = {
        ...seller, address: { ...seller.address, addressLine1: 'ul. Inna 5' },
      };
      await expect(assertSubmitReferences({
        ...input(), correctionData: undefined,
        advanceData: kind === 'advance' ? { ...advance, seller: changedSeller } : undefined,
        finalData: kind === 'final' ? { ...final, seller: changedSeller } : undefined,
        finalAdvanceSettlementRows: kind === 'final' ? [{}] : undefined,
      })).rejects.toThrow('manual reconciliation');
      expect(reads).toHaveLength(1);
    },
  );

  /**
   * A4b PR2a: sprawdzenie sprzedawcy z ŻYWEGO profilu firmy tylko przed POST.
   * Uzgodnienie wcześniejszej wysyłki (otwarty wpis sent/intent albo „tylko
   * uzgodnij”) nie wysyła nowego pliku — zmiana nazwy firmy po wysyłce nie
   * może go zablokować. Runner przekazuje `skipLiveTenantSeller` tylko przed
   * uzgodnieniem; zamrożona kopia sprzedawcy jest sprawdzana zawsze.
   */
  describe('A4b PR2a: pominięcie żywego profilu firmy przed uzgodnieniem (`skipLiveTenantSeller`)', () => {
    const special = (kind: 'advance' | 'final') => {
      invoice.invoice_kind = kind;
      setDocument(kind === 'advance' ? 'ZAL/1' : 'ROZ/1', kind === 'advance' ? 'ZAL' : 'ROZ');
      invoice.advance_invoice_ids = kind === 'final' ? [parentId] : [];
      // Profil firmy zmieniony po zleceniu; koperta i zamrożony sprzedawca bez zmian.
      tenant.name = 'Nowa nazwa';
      return {
        ...input(), environment: 'test' as const, correctionData: undefined,
        advanceData: kind === 'advance' ? advance : undefined,
        finalData: kind === 'final' ? final : undefined,
        finalAdvanceSettlementRows: kind === 'final' ? [{}] : undefined,
      };
    };

    it.each(['advance', 'final'] as const)(
      '%s: pominięcie = true → przepuszcza bez odczytu profilu firmy (jeden odczyt)',
      async (kind) => {
        const skip = vi.fn(async () => true);
        await expect(assertSubmitReferences({ ...special(kind), skipLiveTenantSeller: skip })).resolves.toBe(kind);
        expect(reads).toHaveLength(1);
        expect(reads.some((r) => r.table === 'tenants')).toBe(false);
        expect(skip).toHaveBeenCalledTimes(1);
      },
    );

    it.each(['advance', 'final'] as const)(
      'strażnik: %s bez pominięcia (false albo brak opcji) → odmowa po odczycie profilu firmy',
      async (kind) => {
        await expect(assertSubmitReferences({ ...special(kind), skipLiveTenantSeller: async () => false }))
          .rejects.toThrow('manual reconciliation');
        expect(reads).toHaveLength(2);
        expect(reads[1]?.table).toBe('tenants');
        reads = [];
        await expect(assertSubmitReferences(special(kind))).rejects.toThrow('manual reconciliation');
        expect(reads).toHaveLength(2);
        expect(reads[1]?.table).toBe('tenants');
      },
    );

    it('strażnik: final z pominięciem nadal odrzuca kopertę ze zmienionym sprzedawcą (zamrożona kopia przed pominięciem)', async () => {
      const changedSeller = { ...seller, address: { ...seller.address, addressLine1: 'ul. Inna 5' } };
      await expect(assertSubmitReferences({
        ...special('final'),
        finalData: { ...final, seller: changedSeller },
        skipLiveTenantSeller: async () => true,
      })).rejects.toThrow('manual reconciliation');
      expect(reads).toHaveLength(1);
    });

    it.each([
      ['nazwa w seller_data', () => { invoice.seller_data = { ...(invoice.seller_data as object), name: 'Inna nazwa' }; }],
      ['NIP w seller_nip', () => { invoice.seller_nip = '9999999999'; }],
    ] as const)(
      'strażnik: advance z pominięciem nadal porównuje zamrożoną kopię sprzedawcy (%s) — koperta bez zmian',
      async (_name, breakFrozen) => {
        // Koperta = zdarzenie (porównanie koperty przechodzi), zmieniona tylko kopia z wystawienia:
        // pominięcie żywego profilu nie może ominąć porównania zamrożonego sprzedawcy.
        const base = special('advance');
        breakFrozen();
        await expect(assertSubmitReferences({ ...base, skipLiveTenantSeller: async () => true }))
          .rejects.toThrow('manual reconciliation');
        expect(reads).toHaveLength(1);
      },
    );

    it('strażnik: korekta i zwykła faktura nie pytają o pominięcie (opcja dotyczy tylko ZAL/ROZ)', async () => {
      const skip = vi.fn(async () => true);
      await expect(assertSubmitReferences({ ...input(), skipLiveTenantSeller: skip })).resolves.toBe('correction');
      reads = [];
      invoice.invoice_kind = 'regular';
      setDocument('VAT/1', 'VAT');
      await expect(assertSubmitReferences({ ...input(), correctionData: undefined, skipLiveTenantSeller: skip }))
        .resolves.toBe('regular');
      expect(skip).not.toHaveBeenCalled();
    });
  });

  it('rejects a ROZ event without frozen flags or with flags differing from the stored document (AUD-23)', async () => {
    invoice.invoice_kind = 'final';
    setDocument('ROZ/1', 'ROZ');
    invoice.advance_invoice_ids = [parentId];
    const base = { ...input(), environment: 'test' as const, correctionData: undefined, finalAdvanceSettlementRows: [{}] };
    await expect(assertSubmitReferences({ ...base, finalData: final })).resolves.toBe('final');
    for (const finalData of [
      { ...final, taxAnnotations: undefined as unknown as FinalInvoiceData['taxAnnotations'] },
      { ...final, taxAnnotations: { cashMethod: 2, splitPayment: 2 } as const },
      { ...final, taxAnnotations: { cashMethod: 1, splitPayment: 1 } as const, paymentMethod: 'cash' as const },
    ]) {
      reads = [];
      await expect(assertSubmitReferences({ ...base, finalData })).rejects.toThrow('manual reconciliation');
    }
  });

  it('rejects an old ZAL event without flags and a tampered flag after enqueue', async () => {
    invoice.invoice_kind = 'advance';
    setDocument('ZAL/1', 'ZAL');
    await expect(assertSubmitReferences({
      ...input(), correctionData: undefined,
      advanceData: { ...advance, taxAnnotations: undefined as unknown as AdvanceInvoiceData['taxAnnotations'] },
    })).rejects.toThrow('manual reconciliation');
    await expect(assertSubmitReferences({
      ...input(), correctionData: undefined,
      advanceData: { ...advance, taxAnnotations: { cashMethod: 1, splitPayment: 2 } },
    })).rejects.toThrow('manual reconciliation');
  });

  it('rejects a ZAL bank account or payment date changed in the queued envelope', async () => {
    invoice.invoice_kind = 'advance';
    setDocument('ZAL/1', 'ZAL');
    for (const patch of [
      { bankAccount: '22222222222222222222222222' },
      { paymentDueDate: '2026-09-29' },
    ]) {
      await expect(assertSubmitReferences({
        ...input(), correctionData: undefined, advanceData: { ...advance, ...patch },
      })).rejects.toThrow('manual reconciliation');
    }
  });

  it('rejects a ZAL XML envelope with changed amount, buyer, or other payment description', async () => {
    invoice.invoice_kind = 'advance';
    setDocument('ZAL/1', 'ZAL');
    const changed = [
      { ...advance, advanceAmount: 200 },
      { ...advance, buyer: { ...advance.buyer, name: 'Inny nabywca' } },
      { ...advance, paymentMethod: 'other' as const },
    ];
    for (const advanceData of changed) {
      await expect(assertSubmitReferences({
        ...input(), correctionData: undefined, advanceData,
      })).rejects.toThrow('manual reconciliation');
    }
    reads = [];
    await expect(assertSubmitReferences({
      ...input(), correctionData: undefined, advanceData: advance,
    })).resolves.toBe('advance');
  });

  it('rejects changing ZAL payment description from other to compensation', async () => {
    invoice.invoice_kind = 'advance';
    setDocument('ZAL/1', 'ZAL');
    const otherAdvance: AdvanceInvoiceData = { ...advance, paymentMethod: 'other' };
    eventInvoice.advanceEnvelope = otherAdvance;
    eventInvoice.payment.method = 'other';
    invoice.fa3_data = JSON.parse(JSON.stringify(eventInvoice));
    await expect(assertSubmitReferences({
      ...input(), correctionData: undefined,
      advanceData: { ...otherAdvance, paymentMethod: 'compensation' },
    })).rejects.toThrow('manual reconciliation');
    reads = [];
    await expect(assertSubmitReferences({
      ...input(), correctionData: undefined, advanceData: otherAdvance,
    })).resolves.toBe('advance');
  });

  it('rejects legacy ZAL documents without a frozen XML envelope', async () => {
    invoice.invoice_kind = 'advance';
    setDocument('ZAL/1', 'ZAL');
    delete eventInvoice.advanceEnvelope;
    invoice.fa3_data = JSON.parse(JSON.stringify(eventInvoice));
    await expect(assertSubmitReferences({
      ...input(), correctionData: undefined, advanceData: advance,
    })).rejects.toThrow('manual reconciliation');
  });

  it('rejects a stored or tenant seller NIP that differs from the special snapshot', async () => {
    invoice.invoice_kind = 'advance';
    setDocument('ZAL/1', 'ZAL');
    invoice.seller_nip = '9999999999';
    await expect(assertSubmitReferences({
      ...input(), correctionData: undefined, advanceData: advance,
    })).rejects.toThrow('manual reconciliation');

    invoice.seller_nip = nip;
    tenant.nip = '9999999999';
    reads = [];
    await expect(assertSubmitReferences({
      ...input(), correctionData: undefined, advanceData: advance,
    })).rejects.toThrow('manual reconciliation');
  });

  it('rejects a tenant seller address changed before submit, even when event and draft match', async () => {
    invoice.invoice_kind = 'advance';
    setDocument('ZAL/1', 'ZAL');
    tenant.address_json = { ...seller.address, addressLine1: 'ul. Nowa 9' };
    await expect(assertSubmitReferences({
      ...input(), correctionData: undefined, advanceData: advance,
    })).rejects.toThrow('manual reconciliation');
  });

  it('treats a database read failure as retryable rather than a forged document', async () => {
    readError = 'invoices';
    await expect(assertSubmitReferences(input())).rejects.toThrow('Cannot read KSeF invoice kind');
  });

  it('blocks a stale event after the stored legal content changes before sending', async () => {
    invoice.invoice_kind = 'regular';
    setDocument('VAT/1', 'VAT');
    invoice.fa3_data = { internalNumber: 'VAT/1', type: 'VAT', grossTotal: 200 };
    await expect(assertSubmitReferences({ ...input(), correctionData: undefined }))
      .rejects.toThrow('manual reconciliation');
    expect(reads).toHaveLength(1);
  });

  it('blocks a mismatched stored subtype even if the JSON matches', async () => {
    invoice.invoice_kind = 'regular';
    setDocument('VAT/1', 'VAT');
    invoice.invoice_type = 'KOR';
    await expect(assertSubmitReferences({ ...input(), correctionData: undefined }))
      .rejects.toThrow('manual reconciliation');
  });

  describe('A4b (00137): dane dokumentu specjalnego zapisane na wierszu (`special_data`)', () => {
    const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

    it('korekta: zapisana kopia równa zdarzeniu → przepuszcza; inna (np. zmieniona po zleceniu) → odmowa', async () => {
      invoice.special_data = plain({ correctionData: correction });
      await expect(assertSubmitReferences(input())).resolves.toBe('correction');
      reads = [];
      invoice.special_data = plain({ correctionData: { ...correction, internalNumber: 'KOR/1', notes: 'inna treść' } });
      await expect(assertSubmitReferences(input())).rejects.toThrow('manual reconciliation');
    });

    it('korekta bez zapisanej kopii (dokument sprzed 00137) → jak dotąd, bez odmowy', async () => {
      invoice.special_data = null;
      await expect(assertSubmitReferences(input())).resolves.toBe('correction');
    });

    it('ROZ: zapisane finalData i wiersze zaliczek równe zdarzeniu → przepuszcza; inne wiersze → odmowa', async () => {
      invoice.invoice_kind = 'final';
      setDocument('ROZ/1', 'ROZ');
      invoice.advance_invoice_ids = [parentId];
      const rows = [{ invoice_id: parentId, advance_amount: 123 }];
      const base = { ...input(), environment: 'test' as const, correctionData: undefined, finalData: final, finalAdvanceSettlementRows: rows };
      invoice.special_data = plain({ finalData: final, finalAdvanceSettlementRows: rows });
      await expect(assertSubmitReferences(base as never)).resolves.toBe('final');
      reads = [];
      invoice.special_data = plain({ finalData: final, finalAdvanceSettlementRows: [{ invoice_id: parentId, advance_amount: 999 }] });
      await expect(assertSubmitReferences(base as never)).rejects.toThrow('manual reconciliation');
    });

    it('zwykła faktura i zaliczka z danymi specjalnymi na wierszu → odmowa (kształt pilnuje też CHECK)', async () => {
      invoice.invoice_kind = 'regular';
      setDocument('VAT/1', 'VAT');
      invoice.special_data = { correctionData: correction };
      await expect(assertSubmitReferences({ ...input(), correctionData: undefined })).rejects.toThrow('manual reconciliation');
      reads = [];
      invoice.invoice_kind = 'advance';
      setDocument('ZAL/1', 'ZAL');
      invoice.special_data = { correctionData: correction };
      await expect(assertSubmitReferences({ ...input(), correctionData: undefined, advanceData: advance })).rejects.toThrow('manual reconciliation');
    });
  });
});
