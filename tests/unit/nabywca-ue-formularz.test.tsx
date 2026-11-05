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

/** AUD-70: trzy rodzaje nabywcy i stawka „np. II” w formularzu zwykłej faktury. */
describe('formularz faktury — nabywca z UE i np. II', () => {
  const html = renderToStaticMarkup(<InvoiceForm tenantId={TENANT} />);

  it('wybór rodzaju nabywcy: firma z Polski, osoba prywatna, firma z UE', () => {
    expect(html).toContain('Firma z Polski (NIP)');
    expect(html).toContain('Osoba prywatna');
    expect(html).toContain('Firma z UE (VAT-UE)');
    expect(html.match(/<input[^>]*type="radio"/g)).toHaveLength(3);
  });

  it('domyślnie firma z Polski — zaznaczona i z polem NIP', () => {
    expect(html).toMatch(/<input[^>]*id="buyer-kind-pl"[^>]*checked=""/);
    expect(html).toContain('NIP nabywcy');
    expect(html).not.toContain('Numer VAT-UE nabywcy');
  });

  it('osoba prywatna zachowuje id `buyer-is-consumer` (test e2e 07)', () => {
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*id="buyer-is-consumer"|<input[^>]*id="buyer-is-consumer"[^>]*type="radio"/);
  });

  it('stawka „np. II (usługa dla firmy z UE)” w wyborze stawki', () => {
    expect(html).toContain('<option value="np_ii">np. II (usługa dla firmy z UE)</option>');
  });
});
