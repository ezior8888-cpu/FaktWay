import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 3.4, część 1 (rejestr przepisów RP-BL-01): przy koszcie ponad
 * 15 000 zł brutto rachunek sprzedawcy sprawdzamy w wykazie podatników VAT
 * (biała lista) istniejącym sprawdzeniem `validateBankAccountAction`.
 *
 * Do tej zmiany sprawdzenie łączyło trzy różne stany w jeden: błąd API
 * (limit, awaria, brak odpowiedzi) wracał jako `success: true` z
 * `isOnWhitelist: false`, czyli „rachunku nie ma w wykazie”, a rachunek
 * zapisany z „PL” (IBAN, tak bywa w FA(3)) nigdy nie pasował do 26 cyfr
 * z wykazu. Rachunek wirtualny (firma ma maskę w wykazie) też wychodził
 * „poza wykazem”. Teraz: w wykazie, poza wykazem, albo „nie udało się
 * sprawdzić” (fail-closed: nigdy „w porządku” bez odpowiedzi wykazu).
 *
 * Prawdziwe: akcja, klient API białej listy. Zastąpione: HTTP (atrapa `fetch`)
 * i sesja.
 */

vi.mock('@/lib/supabase/auth-context', () => ({
  ActionAuthError: class extends Error {},
  requireUserAndActiveOrg: vi.fn(async () => ({ tenantId: 'org-a', user: { id: 'u-1' }, role: 'owner' })),
}));

const NIP = '1234567890';
const NRB = '61109010140000071219812874';

function odpowiedz(subject: Record<string, unknown> | null, status = 200) {
  return new Response(JSON.stringify({ result: { subject, requestId: 'abc-123' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['Date'] });
  // 23:30 UTC 9.11 to już 10.11 w Warszawie: dzień sprawdzenia to dzień w Polsce.
  vi.setSystemTime(new Date('2026-11-09T23:30:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('biała lista: rachunek sprzedawcy przy koszcie', () => {
  it('rachunek w wykazie (zapisany z PL i spacjami): w wykazie, dzień sprawdzenia w Polsce', async () => {
    fetchMock.mockResolvedValue(odpowiedz({ name: 'Dostawca', statusVat: 'Czynny', accountNumbers: [NRB], hasVirtualAccounts: false }));
    const { validateBankAccountAction } = await import('@/app/actions/validation');

    const wynik = await validateBankAccountAction(NIP, 'PL61 1090 1014 0000 0712 1981 2874');

    expect(wynik).toMatchObject({ success: true, isOnWhitelist: true, checkedOn: '2026-11-10' });
    expect(String(fetchMock.mock.calls[0]![0])).toContain(`/search/nip/${NIP}?date=2026-11-10`);
  });

  it('rachunku nie ma w wykazie: poza wykazem (to nie błąd)', async () => {
    fetchMock.mockResolvedValue(odpowiedz({ name: 'Dostawca', statusVat: 'Czynny', accountNumbers: ['11111111111111111111111111'], hasVirtualAccounts: false }));
    const { validateBankAccountAction } = await import('@/app/actions/validation');

    await expect(validateBankAccountAction(NIP, NRB)).resolves.toMatchObject({ success: true, isOnWhitelist: false });
  });

  it('firmy nie ma w wykazie (wykreślona albo niezarejestrowana): rachunek poza wykazem', async () => {
    fetchMock.mockResolvedValue(odpowiedz(null));
    const { validateBankAccountAction } = await import('@/app/actions/validation');

    await expect(validateBankAccountAction(NIP, NRB)).resolves.toMatchObject({ success: true, isOnWhitelist: false });
  });

  it('firma ma rachunki wirtualne, a tego rachunku nie ma na liście: „nie udało się potwierdzić”, nie „poza wykazem”', async () => {
    fetchMock.mockResolvedValue(odpowiedz({ name: 'Dostawca', statusVat: 'Czynny', accountNumbers: [], hasVirtualAccounts: true }));
    const { validateBankAccountAction } = await import('@/app/actions/validation');

    await expect(validateBankAccountAction(NIP, NRB)).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/wirtualn/),
    });
  });

  it.each([
    ['błąd serwera 500', () => Promise.resolve(new Response('x', { status: 500 }))],
    ['limit zapytań 429', () => Promise.resolve(new Response('x', { status: 429 }))],
    ['brak odpowiedzi (przerwane połączenie)', () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))],
    ['zła odpowiedź (nie JSON)', () => Promise.resolve(new Response('<html>', { status: 200 }))],
  ])('%s: „nie udało się sprawdzić”, nigdy „rachunek w porządku” ani „poza wykazem”', async (_nazwa, odp) => {
    fetchMock.mockImplementation(odp);
    const { validateBankAccountAction } = await import('@/app/actions/validation');

    const wynik = await validateBankAccountAction(NIP, NRB);
    expect(wynik.success).toBe(false);
    expect(wynik).not.toHaveProperty('isOnWhitelist');
  });
});
