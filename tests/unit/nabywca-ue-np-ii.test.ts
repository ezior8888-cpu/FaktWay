import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AUD-70: zwykła faktura dla firmy z innego państwa UE (numer VAT-UE) i stawka
 * „np. II” — usługi z art. 100 ust. 1 pkt 4 (art. 28b), za które VAT rozlicza
 * nabywca. Do 03.10.2026 formularz znał tylko firmę z polskim NIP-em i osobę
 * prywatną, a adres nabywcy miał wpisany na sztywno kraj PL.
 *
 * Zapis w bazie jak przy imporcie (`buyerIdentityFromParsed`): `buyer_nip`
 * to VARCHAR(10) — numer VAT-UE idzie wyłącznie do `buyer_data`/`fa3_data`.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  audit: vi.fn(),
  enqueue: vi.fn(),
  gus: vi.fn(),
  inserts: [] as Array<{ table: string; payload: unknown }>,
  lastInvoice: null as unknown,
}));

const POZYCJE = [
  { ordinal: 1, name: 'Wdrożenie systemu', unit: 'usł.', quantity: 1, unit_price_net: 5000, vat_rate: 'np_ii' },
];

function fakeSupabase() {
  return {
    from(table: string) {
      let op = 'select';
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => q,
        insert: (payload: unknown) => {
          op = 'insert';
          mocks.inserts.push({ table, payload });
          return q;
        },
        maybeSingle: async () => ({
          data:
            table === 'tenants'
              ? {
                  id: 'ten-1', nip: '5260001246', name: 'Moja Firma',
                  address_json: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' },
                  vat_exemption_basis: null, vat_cash_method: false,
                }
              : table === 'invoices'
                ? mocks.lastInvoice
                : null,
          error: null,
        }),
        single: async () => ({ data: op === 'insert' ? { id: 'inv-new' } : null, error: null }),
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
          Promise.resolve({ data: table === 'invoice_line_items' && op === 'select' ? POZYCJE : null, error: null })
            .then(ok, fail),
      };
      return q;
    },
  };
}

vi.mock('@/lib/supabase/auth-context', () => ({ requireUserAndActiveOrg: mocks.auth }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: mocks.enqueue }));
vi.mock('@/lib/gus/client', () => ({ lookupCompanyByNip: mocks.gus }));

import {
  prefillFromLastInvoiceAction,
  saveAndSendInvoiceAction,
  saveDraftAction,
} from '@/components/invoices/actions';
import {
  EU_BUYER_COUNTRIES,
  invoiceFormSchema,
  NP_II_REQUIRES_EU_BUYER_MESSAGE,
  type InvoiceFormValues,
} from '@/lib/schemas/invoice-form';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { validateInvoiceXml } from '@/lib/xml/validator';
import type { Invoice } from '@/types/invoice';

const DZIS = '2026-10-03';

/** Firma z Polski — fixture jak w pozostałych testach formularza. */
const firmaPl: InvoiceFormValues = {
  internalNumber: 'FV/1/10/2026', issueDate: DZIS, saleDate: '',
  buyerNip: '5252241585', buyerName: 'Klient', buyerAddressLine1: 'ul. B 2',
  buyerAddressLine2: '00-002 Warszawa', buyerEmail: '', buyerIsConsumer: false,
  buyerPesel: '', buyerIdDocument: '', paymentMethod: 'transfer', paymentDueDate: '2026-10-17',
  bankAccount: 'PL61109010140000071219812874',
  lines: [{ name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
};

const firmaUe: InvoiceFormValues = {
  ...firmaPl,
  buyerNip: '',
  buyerIsEu: true,
  buyerVatUe: 'de 123 456 789',
  buyerCountryCode: 'DE',
  buyerName: 'Kunde GmbH',
  buyerAddressLine1: 'Hauptstraße 1',
  buyerAddressLine2: '10115 Berlin',
  buyerEmail: 'rechnung@kunde.example',
  lines: [{ name: 'Wdrożenie systemu', unit: 'usł.', quantity: 1, unitPriceNet: 5000, vatRate: 'np_ii' }],
};

const konsument: InvoiceFormValues = {
  ...firmaPl,
  buyerNip: '',
  buyerIsConsumer: true,
  buyerConsumerIdType: 'no_id',
  buyerName: 'Jan Kowalski',
};

const npII = (v: InvoiceFormValues): InvoiceFormValues => ({
  ...v,
  lines: [{ name: 'Usługa doradcza', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: 'np_ii' }],
});

function bledy(v: InvoiceFormValues): string[] {
  const r = invoiceFormSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('schemat formularza — nabywca z UE i stawka np. II (AUD-70)', () => {
  it('firma z UE + np. II — przechodzi, bez polskiego NIP-u', () => {
    expect(bledy(firmaUe)).toEqual([]);
  });

  it('firma z UE może mieć też inne stawki (np. 23%)', () => {
    expect(bledy({ ...firmaUe, lines: firmaPl.lines })).toEqual([]);
  });

  it('dotychczasowe fixture’y bez pól UE dalej przechodzą', () => {
    expect(bledy(firmaPl)).toEqual([]);
    expect(bledy(konsument)).toEqual([]);
  });

  it.each([
    ['firma z Polski', firmaPl],
    ['osoba prywatna', konsument],
  ])('np. II dla nabywcy „%s” — odrzucone przy pozycji', (_opis, v) => {
    expect(bledy(npII(v))).toEqual([`lines.0.vatRate: ${NP_II_REQUIRES_EU_BUYER_MESSAGE}`]);
  });

  it('komunikat np. II mówi, kiedy stawka jest dozwolona', () => {
    expect(NP_II_REQUIRES_EU_BUYER_MESSAGE).toMatch(/np\. II/);
    expect(NP_II_REQUIRES_EU_BUYER_MESSAGE).toMatch(/VAT-UE/);
  });

  it('wskazuje każdą pozycję np. II, nie tylko pierwszą', () => {
    const v: InvoiceFormValues = {
      ...firmaPl,
      lines: [firmaPl.lines[0]!, { ...firmaPl.lines[0]!, vatRate: 'np_ii' }, { ...firmaPl.lines[0]!, vatRate: 'np_ii' }],
    };
    expect(bledy(v).filter((e) => e.includes('np. II')).map((e) => e.split(':')[0])).toEqual([
      'lines.1.vatRate',
      'lines.2.vatRate',
    ]);
  });

  it.each([
    ['polski prefiks', 'PL5252241585', /polski numer/i],
    ['zły format', 'DE12345_678', /prefiks kraju/i],
    ['prefiks spoza UE', 'US123456789', /prefiks kraju/i],
    ['pusty', '', /prefiks kraju/i],
  ])('numer VAT-UE: %s — odrzucony', (_opis, numer, komunikat) => {
    const e = bledy({ ...firmaUe, buyerVatUe: numer }).filter((x) => x.startsWith('buyerVatUe'));
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(komunikat);
  });

  it.each([
    ['brak kraju', undefined],
    ['pusty kraj', ''],
    ['Polska', 'PL'],
    ['kod spoza listy UE', 'US'],
    ['małe litery', 'de'],
  ])('kraj nabywcy z UE: %s — odrzucony', (_opis, kraj) => {
    expect(bledy({ ...firmaUe, buyerCountryCode: kraj }).some((e) => e.startsWith('buyerCountryCode'))).toBe(true);
  });

  it('firma z Irlandii Płn. (XI): np. II odrzucone, inne stawki dozwolone', () => {
    const xi = { ...firmaUe, buyerVatUe: 'XI123456789', buyerCountryCode: 'XI' };
    expect(bledy(xi).some((e) => e.startsWith('lines.0.vatRate'))).toBe(true);
    expect(bledy({ ...xi, lines: firmaPl.lines })).toEqual([]);
  });

  it('Grecja: prefiks EL, kraj adresu GR', () => {
    expect(bledy({ ...firmaUe, buyerVatUe: 'EL123456789', buyerCountryCode: 'GR' })).toEqual([]);
  });

  it('firma z UE i osoba prywatna naraz — odrzucone', () => {
    expect(
      bledy({ ...firmaUe, buyerIsConsumer: true, buyerConsumerIdType: 'no_id' }).some((e) => e.startsWith('buyerIsEu')),
    ).toBe(true);
  });

  it('firma z Polski nadal wymaga poprawnego NIP-u', () => {
    expect(bledy({ ...firmaPl, buyerNip: '1234567891' })).toContain('buyerNip: NIP firmy — 10 cyfr i suma kontrolna');
    // Numer VAT-UE wpisany przy firmie z Polski nie zastępuje NIP-u.
    expect(bledy({ ...firmaPl, buyerNip: '', buyerVatUe: 'DE123456789', buyerCountryCode: 'DE' }))
      .toContain('buyerNip: NIP firmy — 10 cyfr i suma kontrolna');
  });

  it('lista krajów: państwa UE bez Polski, Grecja jako GR, polskie nazwy', () => {
    const kody = EU_BUYER_COUNTRIES.map((k) => k.code);
    expect(kody).toHaveLength(27);
    expect(kody).not.toContain('PL');
    expect(kody).not.toContain('EL');
    expect(kody).toContain('GR');
    expect(EU_BUYER_COUNTRIES.find((k) => k.code === 'DE')?.name).toBe('Niemcy');
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inserts = [];
  mocks.lastInvoice = null;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${DZIS}T10:00:00Z`));
  mocks.auth.mockResolvedValue({ supabase: fakeSupabase(), user: { id: 'user-1' }, tenantId: 'ten-1', role: 'owner' });
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
});

function wstawionaFaktura() {
  const ins = mocks.inserts.find((i) => i.table === 'invoices');
  expect(ins).toBeDefined();
  return ins!.payload as Record<string, unknown> & { buyer_data: Invoice['buyer']; fa3_data: Invoice };
}

describe('akcje — zapis faktury dla firmy z UE (AUD-70)', () => {
  it('szkic: numer VAT-UE znormalizowany w buyer_data, bez NIP-u, kraj z formularza', async () => {
    await expect(saveDraftAction(firmaUe, 'ten-1')).resolves.toMatchObject({ success: true, invoiceId: 'inv-new' });
    const row = wstawionaFaktura();

    expect(row.buyer_data).toEqual({
      vatUeNumber: 'DE123456789',
      name: 'Kunde GmbH',
      address: { countryCode: 'DE', addressLine1: 'Hauptstraße 1', addressLine2: '10115 Berlin' },
      email: 'rechnung@kunde.example',
      jst: 2,
      gv: 2,
    });
    expect(row.buyer_data).not.toHaveProperty('nip');
    expect(row.fa3_data.buyer).toEqual(row.buyer_data);
  });

  it('kolumny bazy jak przy imporcie: B2B, typ „nip”, buyer_nip pusty', async () => {
    await saveDraftAction(firmaUe, 'ten-1');
    expect(wstawionaFaktura()).toMatchObject({
      is_b2c: false,
      buyer_id_type: 'nip',
      buyer_nip: null,
      buyer_pesel: null,
      buyer_id_number: null,
    });
  });

  it('pozycja np. II trafia do invoice_line_items ze stawką np_ii', async () => {
    await saveDraftAction(firmaUe, 'ten-1');
    const linie = mocks.inserts.find((i) => i.table === 'invoice_line_items')?.payload as Array<{ vat_rate: string; vat_amount: number }>;
    expect(linie).toEqual([expect.objectContaining({ vat_rate: 'np_ii', vat_amount: 0 })]);
  });

  it('firma z Polski bez zmian: NIP w kolumnie i kraj PL', async () => {
    await saveDraftAction(firmaPl, 'ten-1');
    const row = wstawionaFaktura();
    expect(row).toMatchObject({ buyer_nip: '5252241585', is_b2c: false, buyer_id_type: 'nip' });
    expect(row.buyer_data).toMatchObject({ nip: '5252241585', address: { countryCode: 'PL' } });
    expect(row.buyer_data).not.toHaveProperty('vatUeNumber');
  });

  it('np. II dla firmy z Polski — odmowa po stronie serwera, bez zapisu', async () => {
    const r = await saveAndSendInvoiceAction(npII(firmaPl), 'ten-1');
    expect(r).toEqual({ success: false, error: NP_II_REQUIRES_EU_BUYER_MESSAGE });
    expect(mocks.inserts).toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('wysyłka: faktura w kolejce daje XML FA(3) z KodUE/NrVatUE i np II, zgodny ze schematem', async () => {
    await expect(saveAndSendInvoiceAction(firmaUe, 'ten-1')).resolves.toMatchObject({ success: true });
    const invoice = mocks.enqueue.mock.calls[0]![0].invoice as Invoice;
    expect(invoice.buyer.vatUeNumber).toBe('DE123456789');
    expect(invoice.buyer.nip).toBeUndefined();

    const xml = generateFA3Xml(invoice);
    expect(xml).toContain('<KodUE>DE</KodUE>');
    expect(xml).toContain('<NrVatUE>123456789</NrVatUE>');
    expect(xml).toMatch(/<Podmiot2>[\s\S]*<KodKraju>DE<\/KodKraju>[\s\S]*<\/Podmiot2>/);
    expect(xml).toContain('<P_12>np II</P_12>');
    const v = await validateInvoiceXml(xml);
    expect(v.errors).toEqual([]);
    expect(v.valid).toBe(true);
  });
});

describe('wypełnienie z ostatniej faktury — nabywca z UE (AUD-70)', () => {
  it('podaje pola UE zamiast pustego NIP-u', async () => {
    mocks.lastInvoice = {
      id: 'last-invoice',
      fa3_data: {
        buyer: {
          vatUeNumber: 'EL123456789',
          name: 'Pelatis AE',
          address: { countryCode: 'GR', addressLine1: 'Odos 1', addressLine2: '10431 Athina' },
        },
        payment: { method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
      },
    };
    const p = await prefillFromLastInvoiceAction();
    expect(p?.values).toMatchObject({
      buyerNip: '',
      buyerIsEu: true,
      buyerVatUe: 'EL123456789',
      buyerCountryCode: 'GR',
      buyerName: 'Pelatis AE',
      lines: [{ name: 'Wdrożenie systemu', unit: 'usł.', quantity: 1, unitPriceNet: 5000, vatRate: 'np_ii' }],
    });
    // Podkład musi przejść schemat — inaczej „Wypełnij” zostawi formularz z błędem.
    const form: InvoiceFormValues = {
      ...firmaPl,
      ...p!.values,
      bankAccount: p!.values.bankAccount ?? '',
    };
    expect(bledy(form)).toEqual([]);
  });

  it('kraj adresu brany z prefiksu, gdy w starej fakturze go brak', async () => {
    mocks.lastInvoice = {
      id: 'last-invoice',
      fa3_data: { buyer: { vatUeNumber: 'EL123456789', name: 'Pelatis AE', address: { countryCode: 'PL' } } },
    };
    expect((await prefillFromLastInvoiceAction())?.values.buyerCountryCode).toBe('GR');
  });

  it('firma z Polski — bez pól UE', async () => {
    mocks.lastInvoice = {
      id: 'last-invoice',
      fa3_data: {
        buyer: { nip: '5252241585', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
      },
    };
    const p = await prefillFromLastInvoiceAction();
    expect(p?.values.buyerNip).toBe('5252241585');
    expect(p?.values).not.toHaveProperty('buyerIsEu');
    expect(p?.values).not.toHaveProperty('buyerVatUe');
  });
});
