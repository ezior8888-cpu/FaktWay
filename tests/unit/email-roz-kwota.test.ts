import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  generatePdf: vi.fn(),
  verifyPdf: vi.fn(),
  loadInvoice: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: mocks.requireAuth,
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('@/lib/pdf/invoice-pdf', () => ({
  generateInvoicePdf: mocks.generatePdf,
  verifyInvoicePdfDeliveryState: mocks.verifyPdf,
}));
vi.mock('@/lib/pdf/invoice-data', () => ({ loadInvoiceForPdf: mocks.loadInvoice }));
vi.mock('@/lib/email/send', () => ({ sendInvoiceEmail: mocks.sendEmail }));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/storage/r2', () => ({ downloadInvoiceXml: vi.fn() }));

import { emailInvoiceAction } from '@/components/invoices/actions-detail';
import { invoiceEmailAmount } from '@/lib/email/invoice-email-amount';
import type { Invoice } from '@/types/invoice';

/**
 * Kwota w mailu z fakturą = „Do zapłaty” z PDF w załączniku. Faktura
 * rozliczeniowa (ROZ) ma w `grossTotal` pełne zamówienie, a do zapłaty
 * jest reszta po zaliczkach (#84). Do 01.10.2026 mail podawał przy ROZ
 * „Kwota brutto: 12 300,00 PLN” obok terminu płatności, a PDF „Do zapłaty:
 * 9 840,00 PLN”.
 */

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function faktura(o: Partial<Invoice> = {}): Invoice {
  return {
    internalNumber: 'FV/1/10',
    type: 'VAT',
    seller: { name: 'Moja Firma' },
    grossTotal: 12_300,
    payment: { dueDate: '2026-10-15', amountDue: 12_300 },
    ...o,
  } as unknown as Invoice;
}

const roz = faktura({ internalNumber: 'FR/1/10', type: 'ROZ', payment: { dueDate: '2026-10-15', amountDue: 9_840 } as Invoice['payment'] });

/**
 * `toLocaleString('pl-PL')` grupuje twardą spacją i dopiero od pięciu cyfr
 * („9840,00”, ale „12 300,00”) — porównujemy po zwykłej spacji.
 */
const plain = (s: string) => s.replace(/\s/g, ' ');

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAuth.mockResolvedValue({ user: { id: 'user-1' }, tenantId: TENANT });
  mocks.generatePdf.mockResolvedValue({ success: true, pdf: Buffer.from('pdf'), filename: 'faktura.pdf', qrStateKey: 'qr-state' });
  mocks.verifyPdf.mockResolvedValue(null);
  mocks.sendEmail.mockResolvedValue({ sent: true });
});

describe('kwota w mailu z fakturą', () => {
  it('ROZ: do zapłaty po zaliczkach, z takim opisem', () => {
    const a = invoiceEmailAmount(roz);
    expect(a.caption).toBe('Do zapłaty (po zaliczkach)');
    expect(plain(a.label)).toBe('9840,00 PLN');
  });

  it('zwykła faktura: kwota brutto jak dotąd', () => {
    const a = invoiceEmailAmount(faktura());
    expect(a.caption).toBe('Kwota brutto');
    expect(plain(a.label)).toBe('12 300,00 PLN');
  });

  it('akcja wysyłki przekazuje do maila kwotę z PDF, nie pełne zamówienie', async () => {
    mocks.loadInvoice.mockResolvedValue({ tenantId: TENANT, invoice: roz });
    expect(await emailInvoiceAction('11111111-1111-4111-8111-111111111111', 'nabywca@example.test')).toEqual({ success: true });
    const payload = mocks.sendEmail.mock.calls[0]![0];
    expect(payload.amountCaption).toBe('Do zapłaty (po zaliczkach)');
    expect(plain(payload.amountLabel)).toBe('9840,00 PLN');
  });
});

/**
 * Krok 1.4 planu kompletnej aplikacji (RP-PLAT-01): mail podaje ten sam tytuł
 * przelewu co PDF w załączniku (numer KSeF, potem numer faktury). Bez numeru
 * KSeF mail wygląda jak dotąd.
 */
describe('tytuł przelewu w mailu z fakturą', () => {
  const KSEF = '1234567890-20270105-0A1B2C3D4E5F-7A';
  const przelew = { dueDate: '2026-10-15', amountDue: 12_300, method: 'transfer', bankAccount: '61109010140000071219812874' } as Invoice['payment'];

  it('akcja wysyłki przekazuje do maila tytuł z numerem KSeF, ten sam co na PDF', async () => {
    mocks.loadInvoice.mockResolvedValue({ tenantId: TENANT, ksefNumber: KSEF, invoice: faktura({ payment: przelew }) });
    expect(await emailInvoiceAction('11111111-1111-4111-8111-111111111111', 'nabywca@example.test')).toEqual({ success: true });
    expect(mocks.sendEmail.mock.calls[0]![0].transferTitle).toBe(`${KSEF} FV/1/10`);
  });

  it('bez numeru KSeF: mail bez tytułu przelewu, jak dotąd', async () => {
    mocks.loadInvoice.mockResolvedValue({ tenantId: TENANT, ksefNumber: null, invoice: faktura({ payment: przelew }) });
    expect(await emailInvoiceAction('11111111-1111-4111-8111-111111111111', 'nabywca@example.test')).toEqual({ success: true });
    expect(mocks.sendEmail.mock.calls[0]![0].transferTitle ?? null).toBeNull();
  });
});
