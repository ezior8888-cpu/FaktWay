import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDeepStrictEqual } from 'node:util';

/**
 * A4b PR1 (00137): korekta zapisuje przy INSERT dane zdarzenia wysyłki
 * (`special_data = { correctionData }`) — dokładnie ten obiekt, który
 * „Zapisz i wyślij” wkłada do zlecenia pg-boss. Bez tej kopii wiersz nie
 * odtworzy korekty (typKorekty, „stan przed” policzony przez serwer, pozycje
 * z PKWiU, kompensata jako forma płatności), więc ponowna wysyłka po błędzie
 * nie jest możliwa (A4b PR2).
 *
 * Prawdziwa ścieżka: akcja → `enqueueKsefSubmitAfterDraft` → zdarzenie.
 * Zastąpione są tylko baza (klient sesji i serwisowy) oraz zapis zlecenia
 * pg-boss (`sendJobEvent`), który wykonuje krok transakcji na atrapie.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const PARENT = '00000000-0000-4000-8000-000000000001';

const st = vi.hoisted(() => ({
  inserted: [] as Record<string, unknown>[],
  events: [] as Array<{ data: Record<string, unknown> }>,
  insertError: null as { code: string; message: string } | null,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// Testowy NIP 1234567890 nie ma poprawnej sumy kontrolnej — jak w innych testach akcji.
vi.mock('@/lib/xml/invoice-calculator', async (orig) => ({
  ...(await orig<typeof import('@/lib/xml/invoice-calculator')>()),
  validateNipChecksum: () => true,
}));
vi.mock('@/lib/audit/log', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlagForExecution: async () => false }));
vi.mock('@/lib/auth/ksef-verification-guard', () => ({
  requireKsefVerification: async () => undefined,
  KsefNotVerifiedError: class KsefNotVerifiedError extends Error {},
}));
vi.mock('@/lib/auth/sensitive-mfa', () => ({
  assertSensitiveMfa: async () => undefined,
  SensitiveMfaRequiredError: class SensitiveMfaRequiredError extends Error {},
}));
vi.mock('@/lib/ksef/health-check', () => ({ shouldUseOfflineMode: async () => ({ offline: false, isMfOutage: false }) }));
vi.mock('@/lib/ksef/offline-queue', () => ({ addToOfflineQueue: vi.fn() }));
vi.mock('@/lib/ksef/credentials-crypto', () => ({
  decryptCredentials: () => ({ type: 'token', nip: '1234567890', token: 't' }),
}));
vi.mock('@/lib/jobs/enqueue', () => ({
  sendJobEvent: async (
    event: { data: Record<string, unknown> },
    options?: { inTransaction?: (tx: { executeSql: () => Promise<unknown> }) => Promise<void> },
  ) => {
    await options?.inTransaction?.({ executeSql: async () => ({ rows: [{ id: 'inv-1' }], rowCount: 1 }) });
    // Kopia w chwili zapisu zlecenia (pg-boss trzyma jsonb), nie żywa referencja.
    st.events.push(JSON.parse(JSON.stringify(event)) as { data: Record<string, unknown> });
    return { ids: ['job-1'] };
  },
}));
vi.mock('@/lib/supabase/active-org', () => ({ getActiveOrgIdFromCookies: async () => TENANT }));
vi.mock('@/lib/supabase/auth-context', () => ({
  requireUserAndActiveOrg: async () => {
    const { createClient } = await import('@/lib/supabase/server');
    return { supabase: await createClient(), user: { id: 'fixture-user' }, tenantId: TENANT };
  },
  ActionAuthError: class ActionAuthError extends Error {},
}));
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => {
    const q = {
      select: () => q,
      eq: () => q,
      single: async () => ({ data: { ksef_credentials_encrypted: '\\x00' }, error: null }),
    };
    return { from: () => q };
  },
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'fixture-user' } } }) },
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        neq: () => q,
        in: () => q,
        or: () => q,
        order: () => q,
        limit: () => q,
        // Faktura pierwotna: przyjęta w KSeF, w bieżącym środowisku (#63).
        maybeSingle: async () => ({
          data: table === 'invoices'
            ? {
                id: PARENT, tenant_id: TENANT,
                issue_date: '2026-09-30', internal_number: 'FV 1/09/2026', ksef_number: 'KSEF-TEST-1',
                net_total: 1000, vat_total: 230, gross_total: 1230, fa3_data: null,
                seller_data: { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
                buyer_data: { nip: '1234567890', name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } },
              }
            : { id: TENANT, nip: '1234567890', name: 'Firma testowa', address_json: null },
          error: null,
        }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(table === 'invoice_line_items'
          ? { data: [{ name: 'Usługa', unit: 'szt.', quantity: 10, unit_price_net: 100, vat_rate: '23' }], error: null }
          : { data: [], error: null }).then(ok),
        insert: (payload: Record<string, unknown>) => {
          // Kopia w chwili INSERT (supabase-js serializuje treść przy wysyłce) —
          // zmiana koperty po zapisie musi rozjechać wiersz i zlecenie.
          if (table === 'invoices') st.inserted.push(JSON.parse(JSON.stringify(payload)) as Record<string, unknown>);
          if (table === 'invoices' && st.insertError) {
            const error = st.insertError;
            return { select: () => ({ single: async () => ({ data: null, error }) }) };
          }
          return table === 'invoices'
            ? { select: () => ({ single: async () => ({ data: { id: 'inv-1' }, error: null }) }) }
            : Promise.resolve({ error: null });
        },
        delete: () => q,
      };
      return q;
    },
  }),
}));

import { saveAndSendCorrectionAction, saveCorrectionDraftAction } from '@/components/invoices/correction-actions';

const line = (o: Record<string, unknown> = {}) => ({ name: 'Usługa', unit: 'szt.', quantity: 10, unitPriceNet: 100, vatRate: '23', ...o });

function payload(o: Record<string, unknown>) {
  return {
    invoiceType: 'correction',
    internalNumber: 'FK/1/10/2026',
    issueDate: '2026-10-02',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-10-16',
    parentInvoiceId: PARENT,
    parentInvoiceNumber: 'FV 1/09/2026',
    parentInvoiceIssueDate: '2026-09-30',
    parentKsefNumber: 'KSEF-TEST-1',
    correctionReason: 'Zmiana ilości po reklamacji',
    typKorekty: '2',
    seller: { nip: '1234567890', name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
    buyer: { type: 'b2b', idType: 'nip', nip: '1234567890', name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } },
    ...o,
  } as never;
}

/** jsonb w bazie i w pg-boss: undefined znika, kolejność kluczy bez znaczenia. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

const VARIANTS: Array<[string, Record<string, unknown>]> = [
  ['anulowanie', { correctionType: 'cancellation', linesBefore: [line()] }],
  ['przed/po z PKWiU, typKorekty 1, kompensata', {
    correctionType: 'before_after', typKorekty: '1', paymentMethod: 'compensation',
    linesBefore: [line()], linesAfter: [line({ quantity: 8, pkwiuCode: '62.01.11.0' })],
  }],
  ['kwotowa', {
    correctionType: 'amount_change',
    amountChange: { netDelta: -100, vatDelta: -23, grossDelta: -123, description: 'Rabat posprzedażowy' },
  }],
];

beforeEach(() => {
  st.inserted = [];
  st.events = [];
  st.insertError = null;
  vi.stubEnv('KSEF_ENV', 'test');
  // Wysyłka przyjmuje tylko dzisiejszą datę wystawienia (A1, W5).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-02T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('A4b (00137): korekta zapisuje na wierszu dane zdarzenia wysyłki', () => {
  it.each(VARIANTS)('%s: „Zapisz i wyślij” — special_data równe correctionData ze zlecenia', async (_name, extra) => {
    const result = await saveAndSendCorrectionAction(payload(extra), TENANT);
    expect(result).toMatchObject({ success: true, invoiceId: 'inv-1' });
    expect(st.events).toHaveLength(1);
    const correctionData = st.events[0]?.data.correctionData;
    expect(correctionData).toBeTruthy();

    const row = st.inserted[0];
    expect(row).toBeDefined();
    expect(row?.special_data, 'INSERT korekty bez special_data').toBeDefined();
    // isDeepStrictEqual — to samo porównanie, którego używa granica wysyłki.
    expect(isDeepStrictEqual(plain(row?.special_data), plain({ correctionData }))).toBe(true);
  });

  it.each(VARIANTS)('%s: szkic zapisuje ten sam kształt co „Zapisz i wyślij”', async (_name, extra) => {
    await saveAndSendCorrectionAction(payload(extra), TENANT);
    const sent = st.inserted[0]?.special_data;
    st.inserted = [];
    const draft = await saveCorrectionDraftAction(payload(extra), TENANT);
    expect(draft).toEqual({ success: true, invoiceId: 'inv-1' });
    expect(st.inserted[0]?.special_data).toBeDefined();
    expect(plain(st.inserted[0]?.special_data)).toEqual(plain(sent));
    expect(Object.keys(plain(st.inserted[0]?.special_data) as object)).toEqual(['correctionData']);
  });

  it('odmowa bazy na kształcie danych (23514) wraca jako komunikat z nazwą dokumentu, bez zlecenia', async () => {
    st.insertError = {
      code: '23514',
      message: 'new row for relation "invoices" violates check constraint "invoices_special_data_shape"',
    };
    const result = await saveAndSendCorrectionAction(payload(VARIANTS[0]![1]), TENANT);
    expect(result.success).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).toContain('FK/1/10/2026');
    expect(error).not.toContain('invoices_special_data_shape');
    expect(st.events).toEqual([]);
  });
});
