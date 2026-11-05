import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/invoices/actions', () => ({
  saveDraftAction: vi.fn(),
  saveAndSendInvoiceAction: vi.fn(),
  lookupBuyerAction: vi.fn(),
  prefillFromLastInvoiceAction: vi.fn(),
}));

import { InvoiceForm } from '@/components/invoices/invoice-form';

/** Firma formularza (UX-01) — w tym teście tylko wymagany prop. */
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Formularz faktury ma pole MPP (P_18A) przy płatności. */
describe('formularz faktury — MPP', () => {
  it('pole „Mechanizm podzielonej płatności” jest przy płatności', () => {
    const html = renderToStaticMarkup(<InvoiceForm tenantId={TENANT} />);
    expect(html).toContain('Mechanizm podzielonej płatności (MPP)');
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*name="splitPayment"|<input[^>]*name="splitPayment"[^>]*type="checkbox"/);
  });

  it('pusta faktura (0 zł) — bez podpowiedzi o progu 15 000 zł', () => {
    expect(renderToStaticMarkup(<InvoiceForm tenantId={TENANT} />)).not.toContain('co najmniej 15 000 zł');
  });
});
