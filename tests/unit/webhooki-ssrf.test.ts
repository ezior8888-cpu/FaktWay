import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 7.1, część 3: ochrona SSRF webhooków i jedna próba dostawy.
 *
 * - Adres: tylko `https://` na porcie 443, nazwa domeny (bez adresu IP, bez
 *   danych logowania, bez nazw lokalnych).
 * - Przy KAŻDEJ wysyłce: DNS, potem sprawdzenie WSZYSTKICH adresów (prywatne
 *   i zarezerwowane odpadają) i połączenie przypięte do sprawdzonego adresu,
 *   więc zmiana odpowiedzi DNS po sprawdzeniu (rebinding) nic nie da.
 * - Limit 10 s na całość (DNS, połączenie, odpowiedź), bez śledzenia
 *   przekierowań: 3xx to nieudana dostawa.
 *
 * Atrapa DNS i HTTP, bez prawdziwej sieci.
 */

import { encryptWebhookSecret } from '@/lib/webhooks/secret-box';
import { signatureHeader } from '@/lib/webhooks/signature';
import { checkWebhookUrl, isPublicAddress, resolvePublicTarget, type ResolvedAddress } from '@/lib/webhooks/url-guard';
import { attemptDelivery, webhookBody, type ClaimedDelivery } from '@/lib/webhooks/deliver';
import { createHttpsTransport, type WebhookRequest } from '@/lib/webhooks/transport';

const TENANT = 'aaaaaaaa-0000-4000-8000-000000000001';
const WEBHOOK = 'bbbbbbbb-0000-4000-8000-000000000002';
const TEST_SIGNING_VALUE = `fwws_${'c'.repeat(43)}`;

beforeEach(() => {
  // Klucz szyfrowania testowy bez entropii (skan sekretów).
  vi.stubEnv('WEBHOOK_SECRETS_ENCRYPTION_KEY', 'k'.repeat(44));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function delivery(overrides: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  return {
    delivery_id: 'dddddddd-0000-4000-8000-000000000003',
    tenant_id: TENANT,
    webhook_id: WEBHOOK,
    url: 'https://hooks.example.com/faktway?zrodlo=1',
    secret_ciphertext: encryptWebhookSecret(TEST_SIGNING_VALUE, { tenantId: TENANT, webhookId: WEBHOOK }),
    event_id: 'b27c7ddc-abc6-55e7-9d18-25b3ced39fae',
    event_type: 'invoice.ksef_accepted',
    occurred_at: '2026-11-11T09:30:00+00:00',
    data: { invoice: { id: '11111111-1111-4111-8111-111111111111', ksef_number: '1234567890-20261111-ABCDEF-12' } },
    attempt: 1,
    ...overrides,
  };
}

const PUBLIC: ResolvedAddress[] = [{ address: '93.184.216.34', family: 4 }];

function fakeTransport(status = 200) {
  const calls: WebhookRequest[] = [];
  const transport = vi.fn(async (request: WebhookRequest) => {
    calls.push(request);
    return { status };
  });
  return { calls, transport };
}

describe('adres webhooka (przy dodaniu i przy każdej wysyłce)', () => {
  it('przyjmuje https z nazwą domeny i zapisuje postać znormalizowaną', () => {
    const ok = checkWebhookUrl('  https://Hooks.Example.com:443/faktway?zrodlo=1  ');
    expect(ok).toEqual({ ok: true, href: 'https://hooks.example.com/faktway?zrodlo=1', hostname: 'hooks.example.com' });
  });

  it.each([
    ['http://hooks.example.com/x', 'not_https'],
    ['ftp://hooks.example.com/x', 'not_https'],
    ['https://ktos:x@hooks.example.com/x', 'credentials'],
    ['https://hooks.example.com:8443/x', 'port'],
    ['https://hooks.example.com/x#fragment', 'fragment'],
    ['https://127.0.0.1/x', 'ip_literal'],
    ['https://2130706433/x', 'ip_literal'],
    ['https://0x7f.1/x', 'ip_literal'],
    ['https://[::1]/x', 'ip_literal'],
    ['https://[2606:4700:4700::1111]/x', 'ip_literal'],
    ['https://localhost/x', 'hostname'],
    ['https://api.localhost/x', 'hostname'],
    ['https://drukarka.local/x', 'hostname'],
    ['https://db.internal/x', 'hostname'],
    ['https://router.home.arpa/x', 'hostname'],
    ['https://intranet/x', 'hostname'],
    ['https://hooks.example.com./x', 'hostname'],
    ['nie adres', 'invalid'],
    [`https://hooks.example.com/${'a'.repeat(2100)}`, 'too_long'],
  ])('odrzuca %s (%s)', (raw, problem) => {
    const result = checkWebhookUrl(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem).toBe(problem);
      expect(result.message).not.toMatch(/[—–]/);
    }
  });
});

describe('adresy prywatne i zarezerwowane', () => {
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1',
    '172.31.255.255', '192.0.0.8', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.51.100.7',
    '203.0.113.7', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '64:ff9b::a00:1', '100::1', '2001::1', '2001:db8::1', '2002:a00:1::1', '3fff::1', 'nie-adres',
  ])('blokuje %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a01:4f8:c0c:1234::1'])(
    'przepuszcza publiczny %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it('DNS: wszystkie adresy publiczne, wynik to pierwszy z nich', async () => {
    const resolve = vi.fn(async () => [...PUBLIC, { address: '2606:4700:4700::1111', family: 6 as const }]);
    expect(await resolvePublicTarget('hooks.example.com', resolve)).toEqual({ ok: true, address: '93.184.216.34', family: 4 });
  });

  it('DNS: jeden adres prywatny wśród publicznych blokuje całość', async () => {
    const resolve = vi.fn(async () => [...PUBLIC, { address: '10.0.0.5', family: 4 as const }]);
    expect(await resolvePublicTarget('hooks.example.com', resolve)).toEqual({ ok: false, reason: 'blocked_address' });
  });

  it('DNS: brak adresów albo błąd to „dns”', async () => {
    expect(await resolvePublicTarget('hooks.example.com', async () => [])).toEqual({ ok: false, reason: 'dns' });
    expect(await resolvePublicTarget('hooks.example.com', async () => { throw new Error('ENOTFOUND'); })).toEqual({ ok: false, reason: 'dns' });
  });
});

describe('jedna próba dostawy (attemptDelivery)', () => {
  it('sukces 2xx: POST z JSON, podpis i identyfikator zdarzenia w nagłówkach, połączenie z adresem sprawdzonym', async () => {
    const { calls, transport } = fakeTransport(204);
    const resolve = vi.fn(async () => PUBLIC);
    const nowMs = () => 1_762_853_400_000;

    const outcome = await attemptDelivery(delivery(), { resolve, transport, nowMs });

    expect(outcome).toMatchObject({ succeeded: true, statusCode: 204 });
    expect(calls).toHaveLength(1);
    const [request] = calls;
    const body = webhookBody(delivery());
    expect(request!.body).toBe(body);
    expect(JSON.parse(body)).toEqual({
      id: 'b27c7ddc-abc6-55e7-9d18-25b3ced39fae',
      type: 'invoice.ksef_accepted',
      created_at: '2026-11-11T09:30:00.000Z',
      data: delivery().data,
    });
    expect(request!.address).toBe('93.184.216.34');
    expect(request!.url.href).toBe('https://hooks.example.com/faktway?zrodlo=1');
    expect(request!.headers['Content-Type']).toBe('application/json');
    expect(request!.headers['FaktWay-Event-Id']).toBe('b27c7ddc-abc6-55e7-9d18-25b3ced39fae');
    expect(request!.headers['FaktWay-Event-Type']).toBe('invoice.ksef_accepted');
    expect(request!.headers['FaktWay-Signature']).toBe(signatureHeader(TEST_SIGNING_VALUE, 1_762_853_400, body));
    // Sekret nie wychodzi w żadnym nagłówku ani w treści.
    expect(JSON.stringify(request)).not.toContain(TEST_SIGNING_VALUE);
  });

  it('adres prywatny z DNS: bez żądania, błąd blocked_address liczony do wyłączenia', async () => {
    const { transport } = fakeTransport();
    const outcome = await attemptDelivery(delivery(), { resolve: async () => [{ address: '169.254.169.254', family: 4 }], transport });
    expect(outcome).toMatchObject({ succeeded: false, error: 'blocked_address', statusCode: null, countsTowardDisable: true });
    expect(transport).not.toHaveBeenCalled();
  });

  it('rebinding: DNS raz na próbę, żądanie idzie na adres sprawdzony, nie na nową odpowiedź DNS', async () => {
    const answers: ResolvedAddress[][] = [PUBLIC, [{ address: '127.0.0.1', family: 4 }]];
    const resolve = vi.fn(async () => answers.shift() ?? []);
    const { calls, transport } = fakeTransport(200);

    await attemptDelivery(delivery(), { resolve, transport });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(calls[0]!.address).toBe('93.184.216.34');
  });

  it('przekierowanie 3xx: nieudana dostawa z kodem, jedno żądanie, bez podążania za Location', async () => {
    const transport = vi.fn(async () => ({ status: 302 }));
    const outcome = await attemptDelivery(delivery(), { resolve: async () => PUBLIC, transport });
    expect(outcome).toMatchObject({ succeeded: false, error: 'redirect', statusCode: 302, countsTowardDisable: true });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('odpowiedź 500 albo 404: nieudana dostawa z kodem', async () => {
    for (const status of [500, 404, 429]) {
      const outcome = await attemptDelivery(delivery(), { resolve: async () => PUBLIC, transport: async () => ({ status }) });
      expect(outcome).toMatchObject({ succeeded: false, error: 'http_status', statusCode: status });
    }
  });

  it('limit 10 s: brak odpowiedzi kończy próbę błędem timeout i przerywa żądanie', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const transport = vi.fn((request: WebhookRequest) => {
      signal = request.signal;
      return new Promise<{ status: number }>(() => {});
    });
    const pending = attemptDelivery(delivery(), { resolve: async () => PUBLIC, transport });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await expect(pending).resolves.toMatchObject({ succeeded: false, error: 'timeout', statusCode: null });
    expect(signal?.aborted).toBe(true);
  });

  it('limit 10 s obejmuje też DNS', async () => {
    vi.useFakeTimers();
    const transport = vi.fn(async () => ({ status: 200 }));
    const pending = attemptDelivery(delivery(), { resolve: () => new Promise<ResolvedAddress[]>(() => {}), transport });
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(pending).resolves.toMatchObject({ succeeded: false, error: 'timeout' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('adres w bazie niezgodny z zasadami (np. http): bez żądania', async () => {
    const transport = vi.fn(async () => ({ status: 200 }));
    const outcome = await attemptDelivery(delivery({ url: 'http://hooks.example.com/x' }), { resolve: async () => PUBLIC, transport });
    expect(outcome).toMatchObject({ succeeded: false, error: 'invalid_url' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('brak klucza szyfrowania na serwerze: bez żądania, błąd po stronie FaktWay nie liczy się do wyłączenia', async () => {
    const stored = delivery();
    vi.stubEnv('WEBHOOK_SECRETS_ENCRYPTION_KEY', '');
    const transport = vi.fn(async () => ({ status: 200 }));
    const outcome = await attemptDelivery(stored, { resolve: async () => PUBLIC, transport });
    expect(outcome).toMatchObject({ succeeded: false, error: 'signing_unavailable', countsTowardDisable: false });
    expect(transport).not.toHaveBeenCalled();
  });

  it('szyfrogram z innego webhooka (inne AAD) się nie odszyfruje: bez żądania', async () => {
    const transport = vi.fn(async () => ({ status: 200 }));
    const foreign = encryptWebhookSecret(TEST_SIGNING_VALUE, { tenantId: TENANT, webhookId: 'eeeeeeee-0000-4000-8000-000000000009' });
    const outcome = await attemptDelivery(delivery({ secret_ciphertext: foreign }), { resolve: async () => PUBLIC, transport });
    expect(outcome).toMatchObject({ succeeded: false, error: 'signing_unavailable', countsTowardDisable: false });
    expect(transport).not.toHaveBeenCalled();
  });
});

/** Atrapa `https.request`: zapisuje opcje i odpowiada podanym kodem. */
function fakeRequestFn(status: number) {
  const options: Record<string, unknown>[] = [];
  const requestFn = vi.fn((opts: Record<string, unknown>, onResponse: (res: EventEmitter & { statusCode: number; destroy: () => void }) => void) => {
    options.push(opts);
    const req = new EventEmitter() as EventEmitter & { end: (body: string) => void; destroy: (error?: Error) => void };
    req.end = () => {
      setImmediate(() => {
        const res = Object.assign(new EventEmitter(), { statusCode: status, headers: { location: 'http://169.254.169.254/' }, destroy: vi.fn() });
        onResponse(res);
      });
    };
    req.destroy = (error?: Error) => {
      if (error) req.emit('error', error);
    };
    return req;
  });
  return { options, requestFn };
}

describe('transport HTTPS', () => {
  const request = (signal = new AbortController().signal): WebhookRequest => ({
    url: new URL('https://hooks.example.com/faktway?zrodlo=1'),
    address: '93.184.216.34',
    family: 4,
    headers: { 'Content-Type': 'application/json' },
    body: '{"a":1}',
    signal,
  });

  it('POST na port 443, bez agenta (bez puli połączeń), z SNI nazwy i DNS przypiętym do sprawdzonego adresu', async () => {
    const { options, requestFn } = fakeRequestFn(200);
    const transport = createHttpsTransport(requestFn as never);
    await expect(transport(request())).resolves.toEqual({ status: 200 });

    const opts = options[0]!;
    expect(opts).toMatchObject({
      protocol: 'https:', hostname: 'hooks.example.com', port: 443, method: 'POST', path: '/faktway?zrodlo=1',
      agent: false, servername: 'hooks.example.com',
    });
    expect((opts.headers as Record<string, string>)['Content-Length']).toBe('7');
    const lookup = opts.lookup as (host: string, o: unknown, cb: (...args: unknown[]) => void) => void;
    const one = vi.fn();
    lookup('hooks.example.com', {}, one);
    expect(one).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    const all = vi.fn();
    lookup('hooks.example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
  });

  it('302 z Location na adres metadanych: jedno żądanie, wynik 302', async () => {
    const { requestFn } = fakeRequestFn(302);
    const transport = createHttpsTransport(requestFn as never);
    await expect(transport(request())).resolves.toEqual({ status: 302 });
    expect(requestFn).toHaveBeenCalledTimes(1);
  });

  it('sygnał przerwania idzie do żądania', async () => {
    const { options, requestFn } = fakeRequestFn(200);
    const controller = new AbortController();
    await createHttpsTransport(requestFn as never)(request(controller.signal));
    expect(options[0]!.signal).toBe(controller.signal);
  });
});
