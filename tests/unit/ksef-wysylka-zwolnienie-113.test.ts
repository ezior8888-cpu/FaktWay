import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Invoice, VatRate } from '@/types/invoice';

/**
 * F12-G6b (luka po F12-G6): firma zwolniona z VAT podmiotowo (art. 113) nie
 * wysyła do KSeF faktury ze stawką z podatkiem (23, 8, 5 %). Podatek wykazany
 * na fakturze trzeba zapłacić (art. 108 ust. 1 ustawy o VAT). #606 pilnował
 * tylko pozycji cyklicznych; zwykły formularz, szkic, zaliczka i API wysyłały
 * taką fakturę bez słowa.
 *
 * Ścieżka prawdziwa: `enqueueKsefSubmitAfterDraft` (wspólna dla formularza,
 * szkicu, zaliczki, strony faktury i API). Atrapy: baza (`tenants`), kolejka
 * jobów, dziennik prób i usługi KSeF.
 */

const mocks = vi.hoisted(() => ({
  verify: vi.fn(), decrypt: vi.fn(), health: vi.fn(), offlineAdd: vi.fn(),
  send: vi.fn(), audit: vi.fn(), environment: vi.fn(), refusal: vi.fn(),
  basis: null as string | null,
  basisReads: 0,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerification: mocks.verify,
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/ksef/credentials-crypto', () => ({ decryptCredentials: mocks.decrypt }));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: mocks.health }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: mocks.offlineAdd }));
vi.mock('@/lib/ksef/claim-environment', () => ({ requireConfiguredKsefEnvironment: mocks.environment }));
vi.mock('@/lib/jobs/enqueue', () => ({ sendJobEvent: mocks.send }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@/lib/ksef/send-attempt-ledger', () => ({ recordSendRefusal: mocks.refusal }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => supabase }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => supabase }));
vi.mock('@/lib/ksef/submission-holds', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksef/submission-holds')>()),
  isKsefSubmissionPaused: async () => false,
}));

import { enqueueKsefSubmitAfterDraft } from '@/lib/invoices/ksef-submit-enqueue';

const invoiceId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const supabase = {
  from(table: string) {
    if (table !== 'tenants') throw new Error(`Unexpected table: ${table}`);
    let columns = '';
    const query = {
      select: (c: string) => {
        columns = c;
        return query;
      },
      eq: () => query,
      single: async () => ({ data: { ksef_credentials_encrypted: 'ZmFrZQ==' }, error: null }),
      maybeSingle: async () => {
        if (columns.includes('vat_exemption_basis')) mocks.basisReads += 1;
        return { data: { vat_exemption_basis: mocks.basis }, error: null };
      },
      update: () => query,
    };
    return query;
  },
} as unknown as SupabaseClient;

function invoice(rates: VatRate[], type: Invoice['type'] = 'VAT'): Invoice {
  return {
    internalNumber: 'FV/11/2026',
    type,
    lines: rates.map((vatRate, i) => ({ ordinal: i + 1, name: 'Usługa', vatRate })),
  } as unknown as Invoice;
}

const base = {
  supabase, tenantId, userId: '33333333-3333-4333-8333-333333333333', invoiceId, nip: '1234567890',
};

const ZWOLNIENIE_113 = 'art. 113 ust. 1 ustawy o VAT';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.basis = null;
  mocks.basisReads = 0;
  mocks.decrypt.mockReturnValue({ type: 'xades', certificatePem: 'fixture-pem' });
  mocks.environment.mockReturnValue('test');
});

describe('wysyłka do KSeF: zwolnienie z art. 113 a stawka z podatkiem (F12-G6b)', () => {
  it.each(['regular', 'advance'] as const)('%s: stawka 23 przy zwolnieniu z art. 113 to odmowa przed kolejką', async (auditKind) => {
    mocks.basis = ZWOLNIENIE_113;
    const result = await enqueueKsefSubmitAfterDraft({ ...base, invoice: invoice(['zw', '23']), auditKind });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.error).toContain('FV/11/2026');
    expect(result.ok ? '' : result.error).toContain('art. 113');
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.refusal).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_DOCUMENT' }));
  });

  it.each(['8', '5'] as const)('stawka %s też', async (rate) => {
    mocks.basis = ZWOLNIENIE_113;
    const result = await enqueueKsefSubmitAfterDraft({ ...base, invoice: invoice([rate]), auditKind: 'regular' });
    expect(result).toMatchObject({ ok: false });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('korekta faktury z 23 % zostaje poza odmową (poprawia fakturę pierwotną)', async () => {
    mocks.basis = ZWOLNIENIE_113;
    await enqueueKsefSubmitAfterDraft({ ...base, invoice: invoice(['23'], 'KOR'), auditKind: 'correction' }).catch(() => undefined);
    expect(mocks.refusal).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_DOCUMENT' }));
    expect(mocks.send).toHaveBeenCalled();
  });

  it('czynny podatnik z 23 % idzie do kolejki', async () => {
    mocks.basis = null;
    await enqueueKsefSubmitAfterDraft({ ...base, invoice: invoice(['23']), auditKind: 'regular' }).catch(() => undefined);
    expect(mocks.send).toHaveBeenCalled();
  });

  it('zwolnienie przedmiotowe (art. 43) z 23 % idzie do kolejki', async () => {
    mocks.basis = 'art. 43 ust. 1 pkt 37 ustawy o VAT';
    await enqueueKsefSubmitAfterDraft({ ...base, invoice: invoice(['23', 'zw']), auditKind: 'regular' }).catch(() => undefined);
    expect(mocks.send).toHaveBeenCalled();
  });

  it('faktura bez stawki z podatkiem nie czyta ustawień VAT i idzie do kolejki', async () => {
    mocks.basis = ZWOLNIENIE_113;
    await enqueueKsefSubmitAfterDraft({ ...base, invoice: invoice(['zw', 'np']), auditKind: 'regular' }).catch(() => undefined);
    expect(mocks.basisReads).toBe(0);
    expect(mocks.send).toHaveBeenCalled();
  });
});
