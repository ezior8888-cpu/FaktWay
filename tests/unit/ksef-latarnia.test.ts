import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchKsefOfficialStatus } from '@/lib/ksef/latarnia';

/**
 * Plan „zero zgubionych faktur”, sesja B3. Latarnia to publiczne API MF o stanie KSeF
 * (art. 106ne ustawy o VAT). To ona, a nie nasza sonda, mówi, czy awaria jest ogłoszona,
 * bo od tego zależy tryb prawny i termin dosłania faktur.
 */

const fetchMock = vi.fn();

function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchKsefOfficialStatus', () => {
  it('produkcja pyta produkcyjną Latarnię, bez przekierowań', async () => {
    respond({ status: 'AVAILABLE' });
    await expect(fetchKsefOfficialStatus('production')).resolves.toEqual({ status: 'AVAILABLE', end: null });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api-latarnia.ksef.mf.gov.pl/status');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });

  it('TEST pyta testową Latarnię', async () => {
    respond({ status: 'AVAILABLE' });
    await fetchKsefOfficialStatus('test');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api-latarnia-test.ksef.mf.gov.pl/status');
  });

  it('DEMO nie ma Latarni: brak zapytania i brak stanu', async () => {
    await expect(fetchKsefOfficialStatus('demo')).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['FAILURE', 'FAILURE'],
    ['TOTAL_FAILURE', 'TOTAL_FAILURE'],
    ['MAINTENANCE', 'MAINTENANCE'],
  ])('stan %s przekazuje koniec z komunikatu tej samej kategorii', async (status, category) => {
    respond({
      status,
      messages: [
        { category: 'MAINTENANCE', end: status === 'MAINTENANCE' ? '2026-11-06T18:00:00+01:00' : '2027-01-01T00:00:00+01:00' },
        { category, end: '2026-11-06T18:00:00+01:00' },
      ],
    });
    await expect(fetchKsefOfficialStatus('production')).resolves.toEqual({
      status,
      end: '2026-11-06T18:00:00+01:00',
    });
  });

  it('komunikat bez końca: stan jest, końca nie zgadujemy', async () => {
    respond({ status: 'FAILURE', messages: [{ category: 'FAILURE', end: null }] });
    await expect(fetchKsefOfficialStatus('production')).resolves.toEqual({ status: 'FAILURE', end: null });
  });

  it.each([
    ['nieznany stan', () => respond({ status: 'INNY' })],
    ['błąd HTTP', () => respond({ status: 'AVAILABLE' }, 500)],
    ['niepoprawny JSON', () => fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }))],
    ['błąd sieci', () => fetchMock.mockRejectedValue(new Error('ECONNRESET'))],
  ])('%s: brak wiedzy, nie wyjątek', async (_name, arrange) => {
    arrange();
    await expect(fetchKsefOfficialStatus('production')).resolves.toBeNull();
  });
});
