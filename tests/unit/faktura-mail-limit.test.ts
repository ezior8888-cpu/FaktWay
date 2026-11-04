import { beforeEach, describe, expect, it, vi } from 'vitest';

const s = vi.hoisted(() => ({ pdf: vi.fn(), send: vi.fn() }));

vi.mock('@/lib/supabase/auth-context', () => ({
  ActionAuthError: class ActionAuthError extends Error {},
  requireUserAndActiveOrg: async () => ({ user: { id: 'u-1' }, tenantId: 'ten-limit', role: 'owner', supabase: {} }),
}));
vi.mock('@/lib/pdf/invoice-pdf', () => ({ generateInvoicePdf: s.pdf }));
vi.mock('@/lib/email/send', () => ({ sendInvoiceEmail: s.send }));

import { emailInvoiceAction } from '@/components/invoices/actions-detail';

/**
 * AUD-102: wysyłka faktury mailem na dowolny adres nie miała limitu —
 * przejęte konto mogło rozsyłać z domeny FaktWay setki maili z PDF.
 * Limit: 30 wysyłek na godzinę na firmę, sprawdzany PRZED generowaniem PDF.
 */

beforeEach(() => {
  s.pdf.mockReset().mockResolvedValue({ success: false, error: 'stop-po-limicie' });
});

describe('wysyłka faktury mailem — limit', () => {
  it('31. wysyłka w godzinie odmówiona przed generowaniem PDF', async () => {
    for (let i = 0; i < 30; i++) {
      await emailInvoiceAction('inv-1', 'klient@example.test');
    }
    expect(s.pdf).toHaveBeenCalledTimes(30);

    const out = await emailInvoiceAction('inv-1', 'klient@example.test');

    expect(out).toMatchObject({ success: false });
    expect((out as { error: string }).error).toMatch(/limit|później/i);
    expect(s.pdf).toHaveBeenCalledTimes(30);
  });
});
