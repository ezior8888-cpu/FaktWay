import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyScenario,
  FIXTURE_503,
  FIXTURE_SESSION_OPEN_OK,
  getMockFailureCount,
  getMockScenario,
  resetMockState,
  resolveFixture,
  setMockScenario,
} from '@/lib/ksef/mock-fixtures';
import { getKsefBaseUrl, ksefFetch, KsefApiError } from '@/lib/ksef/client';

describe('Mock KSeF fixtures', () => {
  beforeEach(() => {
    resetMockState();
    process.env.E2E_MOCK_KSEF_SKIP_DELAY = '1';
  });

  afterEach(() => {
    resetMockState();
    delete process.env.E2E_MOCK_KSEF_SKIP_DELAY;
  });

  describe('resolveFixture', () => {
    it('mapuje /sessions/online POST → session open fixture', () => {
      const fx = resolveFixture('/sessions/online', 'POST');
      expect(fx).toBe(FIXTURE_SESSION_OPEN_OK);
    });

    it('mapuje /sessions/online/{ref}/invoices POST → invoice send fixture', () => {
      const fx = resolveFixture('/sessions/online/REF-1/invoices', 'POST');
      expect(fx?.status).toBe(200);
      expect(fx?.body).toMatchObject({ referenceNumber: expect.any(String) });
    });

    it('mapuje /sessions/{ref}/invoices/{ref} GET → poll accepted', () => {
      const fx = resolveFixture('/sessions/A/invoices/B', 'GET');
      expect(fx?.body).toMatchObject({
        status: { code: 200 },
        ksefNumber: expect.stringMatching(/^MOCK-/),
      });
    });

    it('zwraca null dla nieznanej ścieżki', () => {
      const fx = resolveFixture('/foo/bar', 'GET');
      expect(fx).toBeNull();
    });
  });

  describe('applyScenario', () => {
    it('healthy → przepuszcza fixturę bez zmian', () => {
      const out = applyScenario('healthy', FIXTURE_SESSION_OPEN_OK);
      expect(out).toBe(FIXTURE_SESSION_OPEN_OK);
    });

    it('down → zawsze 503', () => {
      const out = applyScenario('down', FIXTURE_SESSION_OPEN_OK);
      expect(out).toBe(FIXTURE_503);
      expect(getMockFailureCount()).toBeGreaterThan(0);
    });

    it('recovery → 503 dla pierwszych N calls, potem healthy', () => {
      process.env.E2E_MOCK_KSEF_RECOVERY_AFTER = '3';
      const r1 = applyScenario('recovery', FIXTURE_SESSION_OPEN_OK);
      const r2 = applyScenario('recovery', FIXTURE_SESSION_OPEN_OK);
      const r3 = applyScenario('recovery', FIXTURE_SESSION_OPEN_OK);
      const r4 = applyScenario('recovery', FIXTURE_SESSION_OPEN_OK);
      expect(r1.status).toBe(503);
      expect(r2.status).toBe(503);
      expect(r3.status).toBe(503);
      expect(r4.status).toBe(200);
      delete process.env.E2E_MOCK_KSEF_RECOVERY_AFTER;
    });
  });

  describe('setMockScenario override', () => {
    it('runtime override ma pierwszeństwo nad env', () => {
      process.env.E2E_MOCK_KSEF_SCENARIO = 'down';
      setMockScenario('healthy');
      expect(getMockScenario()).toBe('healthy');
      setMockScenario(null);
      expect(getMockScenario()).toBe('down');
      delete process.env.E2E_MOCK_KSEF_SCENARIO;
    });
  });
});

describe('ksefFetch z interceptorem', () => {
  beforeEach(() => {
    resetMockState();
    process.env.E2E_MOCK_KSEF = '1';
    process.env.E2E_MOCK_KSEF_SKIP_DELAY = '1';
  });

  afterEach(() => {
    resetMockState();
    vi.unstubAllGlobals();
    delete process.env.E2E_MOCK_KSEF;
    delete process.env.E2E_MOCK_KSEF_SKIP_DELAY;
    delete process.env.E2E_MOCK_KSEF_SCENARIO;
  });

  it('zwraca mock response gdy E2E_MOCK_KSEF=1 i scenariusz healthy', async () => {
    setMockScenario('healthy');
    const result = await ksefFetch<{ referenceNumber: string }>(
      '/sessions/online',
      { method: 'POST', body: {}, accessToken: 'fake' },
    );
    expect(result.referenceNumber).toBe('MOCK-SESSION-REF-0001');
  });

  it('rzuca KsefApiError(503) gdy scenariusz down', async () => {
    setMockScenario('down');
    try {
      await ksefFetch('/sessions/online', { method: 'POST', accessToken: 'fake' });
      expect.fail('Powinno rzucić KsefApiError');
    } catch (e) {
      expect(e).toBeInstanceOf(KsefApiError);
      const ksefErr = e as KsefApiError;
      expect(ksefErr.status).toBe(503);
      expect(ksefErr.isRetryable).toBe(true);
    }
  });

  it('zwraca 404 dla nieznanej ścieżki — wykrywa brak fixturki', async () => {
    setMockScenario('healthy');
    try {
      await ksefFetch('/nonexistent', { method: 'GET', accessToken: 'fake' });
      expect.fail('Powinno rzucić KsefApiError(404)');
    } catch (e) {
      expect(e).toBeInstanceOf(KsefApiError);
      expect((e as KsefApiError).status).toBe(404);
    }
  });

  it('passes-through gdy E2E_MOCK_KSEF nie ustawione (delegates to real fetch)', async () => {
    delete process.env.E2E_MOCK_KSEF;
    // Atrapa zamiast sieci: prawdziwy fetch do KSeF TEST potrafił wisieć
    // ponad 5 s i wywracać test. 500 z atrapy odróżnia odpowiedź z fetch
    // od fixture'a (dla /sessions/online byłoby 200) i od 404 „fixture-not-found”.
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ exception: 'atrapa' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const error = await ksefFetch('/sessions/online', { method: 'POST' }).catch((e: unknown) => e);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `${getKsefBaseUrl('test')}/sessions/online`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(error).toBeInstanceOf(KsefApiError);
    expect((error as KsefApiError).status).toBe(500);
  });
});
