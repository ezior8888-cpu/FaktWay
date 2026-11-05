import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  submit: vi.fn(),
}));

vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerificationForBackgroundJob: vi.fn(async () => undefined),
}));
vi.mock('@/lib/storage/r2', () => ({
  uploadInvoiceXml: mocks.upload,
}));
vi.mock('@/lib/ksef/xml-generated-at', () => ({
  claimXmlGeneratedAt: vi.fn(async () => new Date('2026-10-01T10:00:00.000Z')),
}));
vi.mock('@/lib/ksef/submit', () => ({ submitInvoice: mocks.submit }));

import { submitInvoiceFullFlow } from '@/lib/ksef/submit-invoice-full';
import {
  assertSpecialInvoiceData,
  specialInvoiceResendMessage,
} from '@/lib/ksef/special-invoice-data';
import { finalizeInvoice, type InvoiceInput } from '@/lib/xml/invoice-calculator';
import { InvoiceValidationError } from '@/lib/xml/fa3-generator';
import type { KsefAuth } from '@/lib/ksef/auth';
import type { AdvanceInvoiceSettlementRow } from '@/lib/ksef/fa3-advance-generator';
import type { FinalInvoiceData } from '@/types/invoice-types';

/**
 * Korekta / zaliczka / rozliczenie wysyłane ponownie Z SAMEJ KOPII faktury
 * (Offline24, „Wyślij ponownie”) nie mają swoich bloków XML. Generator
 * zwykłej faktury wpisałby `RodzajFaktury=KOR` bez `DaneFaKorygowanej`,
 * a XSD to przepuszcza — więc blokada musi być przed generowaniem XML.
 */

const T = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID = '11111111-1111-4111-8111-111111111111';
const AUTH = {} as KsefAuth;

function kopia(type: InvoiceInput['type']) {
  return finalizeInvoice({
    internalNumber: `${type} 2026/09/001`,
    type,
    issueDate: '2026-09-25',
    saleDate: '2026-09-25',
    seller: {
      nip: '5260001246',
      name: 'ACME Software sp. z o.o.',
      address: { countryCode: 'PL', addressLine1: 'ul. Przykładowa 1/2', addressLine2: '00-001 Warszawa' },
    },
    buyer: {
      nip: '5252241585',
      name: 'Klient sp. z o.o.',
      address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' },
    },
    lines: [{ ordinal: 1, name: 'Licencja', unit: 'usł.', quantity: 1, unitPriceNet: 199, vatRate: '23' }],
    payment: {
      currency: 'PLN',
      dueDate: '2026-10-09',
      method: 'transfer',
      bankAccount: 'PL61109010140000071219812874',
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('KSEF_ENV', 'test');
  mocks.upload.mockResolvedValue({ storagePath: 'x.xml', sha256Hash: 'h' });
  mocks.submit.mockResolvedValue({ ksefNumber: 'K', acquisitionTimestamp: '2026-09-25T10:00:00Z' });
});
afterEach(() => vi.unstubAllEnvs());

describe('ponowna wysyłka dokumentów specjalnych z samej kopii', () => {
  it.each(['KOR', 'ZAL', 'ROZ'] as const)(
    '%s bez swoich danych: nic nie idzie do R2 ani do KSeF',
    async (type) => {
      await expect(submitInvoiceFullFlow(T, ID, kopia(type), AUTH, 'test')).rejects.toBeInstanceOf(
        InvoiceValidationError,
      );
      expect(mocks.upload).not.toHaveBeenCalled();
      expect(mocks.submit).not.toHaveBeenCalled();
    },
  );

  it('zwykła faktura VAT z kopii nadal idzie do KSeF', async () => {
    await expect(submitInvoiceFullFlow(T, ID, kopia('VAT'), AUTH, 'test')).resolves.toMatchObject({
      ksefNumber: 'K',
    });
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });

  it('pełny payload ROZ jest zatrzymany przed XML, archiwum i KSeF', async () => {
    const finalPayload = {
      finalData: {} as FinalInvoiceData,
      advanceSettlementRows: [{} as AdvanceInvoiceSettlementRow],
    };
    await expect(submitInvoiceFullFlow(
      T, ID, kopia('ROZ'), AUTH, 'test', null, null, finalPayload,
    )).rejects.toThrow(/Wysyłka faktur rozliczających jest tymczasowo wstrzymana/);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('komunikat mówi, co zrobić, i nie dotyczy faktury VAT', () => {
    expect(specialInvoiceResendMessage('KOR')).toMatch(/korekty.*Wystaw dokument ponownie z formularza/);
    expect(specialInvoiceResendMessage('ZAL')).toMatch(/faktury zaliczkowej/);
    expect(specialInvoiceResendMessage('ROZ')).toMatch(/faktury rozliczeniowej/);
    expect(specialInvoiceResendMessage('VAT')).toBeNull();
    expect(specialInvoiceResendMessage(null)).toBeNull();
  });
});

describe('assertSpecialInvoiceData — każdy typ wymaga SWOICH danych', () => {
  const korekta = { correctionData: {} };
  const zaliczka = { advanceData: {} };
  const rozliczenie = { finalPayload: { advanceSettlementRows: [{}] } };

  it('przepuszcza dokument z jego danymi', () => {
    expect(() => assertSpecialInvoiceData('KOR', korekta)).not.toThrow();
    expect(() => assertSpecialInvoiceData('ZAL', zaliczka)).not.toThrow();
    expect(() => assertSpecialInvoiceData('ROZ', rozliczenie)).not.toThrow();
    expect(() => assertSpecialInvoiceData('VAT', {})).not.toThrow();
  });

  it('nie myli danych jednego typu z drugim', () => {
    expect(() => assertSpecialInvoiceData('KOR', zaliczka)).toThrow(InvoiceValidationError);
    expect(() => assertSpecialInvoiceData('ZAL', korekta)).toThrow(InvoiceValidationError);
    expect(() => assertSpecialInvoiceData('ROZ', korekta)).toThrow(InvoiceValidationError);
  });

  it('rozliczenie bez żadnej zaliczki to też brak danych', () => {
    expect(() =>
      assertSpecialInvoiceData('ROZ', { finalPayload: { advanceSettlementRows: [] } }),
    ).toThrow(InvoiceValidationError);
  });
});
