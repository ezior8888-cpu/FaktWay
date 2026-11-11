import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Krok 7.3: składanie zdarzeń dla firmy. Terminy podatków i ZUS tylko, gdy
 * moduł księgowości jest dla firmy włączony (wyłącznik `ksiegowosc`, obszar
 * `terminy`); faktury i pozycje cykliczne zawsze. Awaria jednej sekcji nie
 * wyrzuca całego kalendarza.
 */

const mocks = vi.hoisted(() => ({
  wlaczona: vi.fn(),
  wersje: vi.fn(),
  naleznosci: vi.fn(),
  zwolnienie: vi.fn(),
  sentry: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.sentry }));
vi.mock('@/lib/ksiegowosc/wylacznik', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ksiegowosc/wylacznik')>()),
  czyKsiegowoscWlaczona: mocks.wlaczona,
}));
vi.mock('@/lib/ksiegowosc/profil', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ksiegowosc/profil')>()),
  czytajWersjeProfilu: mocks.wersje,
}));
vi.mock('@/lib/dashboard/receivables', () => ({ getReceivables: mocks.naleznosci }));
vi.mock('@/lib/invoices/vat-exemption', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/vat-exemption')>()),
  readTenantVatExemption: mocks.zwolnienie,
}));

import { zbierzZdarzenia } from '@/lib/kalendarz/zbierz';

const TENANT = '22222222-2222-4222-8222-222222222222';
const TERAZ = new Date('2026-11-10T09:00:00Z');

function admin(cykliczne: { id: string; name: string; next_run_date: string }[] = []): SupabaseClient {
  const wynik = { data: cykliczne, error: null };
  const lancuch: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'gte', 'order']) lancuch[m] = () => lancuch;
  lancuch.limit = () => Promise.resolve(wynik);
  return { from: () => lancuch } as unknown as SupabaseClient;
}

describe('zbierzZdarzenia', () => {
  beforeEach(() => {
    mocks.wlaczona.mockReset().mockResolvedValue({ wlaczony: true });
    mocks.wersje.mockReset().mockResolvedValue([{ id: 'p', validFrom: '2026-01-01', forma: 'ryczalt' }]);
    mocks.zwolnienie.mockReset().mockResolvedValue(null);
    mocks.sentry.mockReset();
    mocks.naleznosci.mockReset().mockResolvedValue({
      byInvoice: [{ id: 'i1', internalNumber: 'FV/1/2026', buyerName: 'Acme', paymentDueDate: '2026-11-25', outstanding: 100, daysOverdue: 0 }],
    });
  });

  it('firma z modułem: faktury, cykliczne i terminy podatków oraz ZUS', async () => {
    const z = await zbierzZdarzenia(admin([{ id: 'r1', name: 'Abonament', next_run_date: '2026-12-01' }]), TENANT, TERAZ);
    const tytuly = z.map((e) => e.tytul).join('|');
    expect(tytuly).toContain('FV/1/2026');
    expect(tytuly).toContain('Abonament');
    expect(tytuly).toContain('Składki ZUS');
    expect(mocks.wlaczona).toHaveBeenCalledWith(expect.anything(), TENANT, 'terminy');
  });

  it('firma bez modułu: zero terminów podatkowych, reszta zostaje', async () => {
    mocks.wlaczona.mockResolvedValue({ wlaczony: false });
    const z = await zbierzZdarzenia(admin([{ id: 'r1', name: 'Abonament', next_run_date: '2026-12-01' }]), TENANT, TERAZ);
    const tytuly = z.map((e) => e.tytul).join('|');
    expect(tytuly).toContain('FV/1/2026');
    expect(tytuly).toContain('Abonament');
    expect(tytuly).not.toContain('ZUS');
    expect(tytuly).not.toContain('ryczałt');
    expect(mocks.wersje).not.toHaveBeenCalled();
  });

  it('zwolnienie z VAT z art. 113: bez terminów VAT', async () => {
    mocks.zwolnienie.mockResolvedValue('art. 113 ust. 1');
    const z = await zbierzZdarzenia(admin(), TENANT, TERAZ);
    expect(z.some((e) => e.tytul.includes('VAT'))).toBe(false);
    expect(z.some((e) => e.tytul.includes('ZUS'))).toBe(true);
  });

  it('awaria należności nie psuje kalendarza i trafia do Sentry', async () => {
    mocks.naleznosci.mockRejectedValue(new Error('baza'));
    const z = await zbierzZdarzenia(admin(), TENANT, TERAZ);
    expect(z.some((e) => e.tytul.includes('ZUS'))).toBe(true);
    expect(mocks.sentry).toHaveBeenCalled();
  });

  it('nie przepuszcza zaległych faktur sprzed ponad 30 dni', async () => {
    mocks.naleznosci.mockResolvedValue({
      byInvoice: [
        { id: 'stara', internalNumber: 'FV/0', buyerName: 'X', paymentDueDate: '2026-08-01', outstanding: 10, daysOverdue: 100 },
        { id: 'swieza', internalNumber: 'FV/9', buyerName: 'X', paymentDueDate: '2026-11-01', outstanding: 10, daysOverdue: 9 },
      ],
    });
    const z = await zbierzZdarzenia(admin(), TENANT, TERAZ);
    expect(z.some((e) => e.uid === 'faktura-stara@faktway.pl')).toBe(false);
    expect(z.some((e) => e.uid === 'faktura-swieza@faktway.pl')).toBe(true);
  });
});
