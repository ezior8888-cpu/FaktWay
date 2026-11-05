import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  submit: vi.fn(),
  row: { xml_generated_at: null as string | null },
  failClaim: false,
  failRead: false,
}));

vi.mock('@/lib/auth/ksef-verification-guard', () => ({ requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined) }));
vi.mock('@/lib/storage/r2', () => ({ uploadInvoiceXml: mocks.upload }));
vi.mock('@/lib/ksef/submit', () => ({ submitInvoice: mocks.submit }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      let patch: Record<string, unknown> | null = null;
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        update: (p: Record<string, unknown>) => { patch = p; return q; },
        select: () => q,
        eq: () => q,
        is: () => q,
        maybeSingle: async () => {
          if (patch) {
            if (mocks.failClaim) return { data: null, error: { message: 'db down' } };
            if (mocks.row.xml_generated_at === null) mocks.row.xml_generated_at = String(patch.xml_generated_at);
            return { data: { ...mocks.row }, error: null };
          }
          if (mocks.failRead) return { data: null, error: { message: 'db down' } };
          return { data: { ...mocks.row }, error: null };
        },
      });
      return q;
    },
  }),
}));

import { submitInvoiceFullFlow } from '@/lib/ksef/submit-invoice-full';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import type { KsefAuth } from '@/lib/ksef/auth';

/**
 * AUD-46: XML FA(3) dostawał `DataWytworzeniaFa = new Date()` przy KAŻDYM
 * generowaniu. Ponowienie wysyłki budowało inny plik niż pierwsza próba —
 * archiwum (hash) przestawało odpowiadać temu, co dostał KSeF. Teraz chwila
 * wytworzenia zapisuje się przy pierwszym generowaniu i wraca przy ponowieniach.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';

const faktura = () =>
  finalizeInvoice({
    internalNumber: 'FV 2026/10/001',
    type: 'VAT',
    issueDate: '2026-10-01',
    saleDate: '2026-10-01',
    seller: { nip: '5260001246', name: 'ACME sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
    buyer: { nip: '5252241585', name: 'Klient sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '02-001 Warszawa' } },
    lines: [{ ordinal: 1, name: 'Usługa', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-10-15', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
  });

beforeEach(() => {
  vi.useRealTimers();
  mocks.row.xml_generated_at = null;
  mocks.failClaim = false;
  mocks.failRead = false;
  mocks.upload.mockReset().mockResolvedValue({ storagePath: 'x.xml', sha256Hash: 'h', sizeBytes: 1 });
  mocks.submit.mockReset().mockResolvedValue({ ksefNumber: 'K', acquisitionTimestamp: '2026-10-01T10:00:00Z' });
});

describe('DataWytworzeniaFa stała między próbami (AUD-46)', () => {
  it('druga próba buduje dokładnie ten sam XML', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));
    await submitInvoiceFullFlow(T, ID, faktura(), {} as KsefAuth, 'test');

    vi.setSystemTime(new Date('2026-10-01T10:07:00Z'));
    await submitInvoiceFullFlow(T, ID, faktura(), {} as KsefAuth, 'test');

    const [first, second] = mocks.upload.mock.calls.map((c) => c[3] as string);
    expect(first).toContain('2026-10-01T10:00:00');
    expect(second).toBe(first);
  });

  // C-12: plik jest niezmienny, więc awaria bazy nie może dać pliku z chwilą t1,
  // skoro ponowienie odczyta t2 — bajty tej próby różniłyby się już zawsze.
  it('błąd odczytu chwili: bez pliku i bez wysyłki; ponowienie buduje plik z zapisaną chwilą', async () => {
    mocks.failRead = true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T10:00:00Z'));

    await expect(submitInvoiceFullFlow(T, ID, faktura(), {} as KsefAuth, 'test')).rejects.toThrow('xml_generated_at');
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();

    mocks.failRead = false;
    vi.setSystemTime(new Date('2026-10-01T10:07:00Z'));
    await submitInvoiceFullFlow(T, ID, faktura(), {} as KsefAuth, 'test');

    expect(mocks.upload).toHaveBeenCalledOnce();
    const retried = mocks.upload.mock.calls[0]![3] as string;
    expect(retried).toContain(String(mocks.row.xml_generated_at).slice(0, 19));
  });

  it('nieudany zapis chwili i brak zapisanej wartości: bez pliku', async () => {
    mocks.failClaim = true;

    await expect(submitInvoiceFullFlow(T, ID, faktura(), {} as KsefAuth, 'test')).rejects.toThrow('xml_generated_at');
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('nieudany zapis chwili przy już zapisanej wartości: plik z tą wartością', async () => {
    mocks.failClaim = true;
    mocks.row.xml_generated_at = '2026-10-01T09:30:00.000Z';

    await submitInvoiceFullFlow(T, ID, faktura(), {} as KsefAuth, 'test');

    expect(mocks.upload.mock.calls[0]![3] as string).toContain('2026-10-01T09:30:00');
  });

  it('migracja: kolumna dodawana bez zmian istniejących danych', () => {
    const sql = readFileSync('supabase/migrations/00107_invoice_xml_generated_at.sql', 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS xml_generated_at timestamptz');
    expect(sql).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i);
  });
});
