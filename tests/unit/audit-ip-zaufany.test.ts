import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Adres IP we wpisach `audit_logs` (krok 8.5: pokazuje go lista zalogowanych
 * urządzeń i historia logowań). Ta sama kolejność zaufania co limity prób
 * (`lib/auth/get-client-ip.ts`, AUD-62): `X-Real-Ip` od Traefika, potem OSTATNI
 * wpis `X-Forwarded-For`. Pierwszy wpis może podać sam klient, a wartość, która
 * nie jest adresem, wywracała zapis do kolumny INET i wpis znikał.
 *
 * Prawdziwe: `logAudit`. Atrapą są nagłówki żądania i klient bazy.
 */

const h = vi.hoisted(() => ({ insert: vi.fn(), headers: new Headers() }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({ from: () => ({ insert: h.insert }) }) }));
vi.mock('next/headers', () => ({ headers: async () => h.headers }));

const { logAudit } = await import('@/lib/audit/log');

async function storedIp(headers: Record<string, string>): Promise<unknown> {
  h.headers = new Headers(headers);
  await logAudit({ action: 'auth.login', tenantId: null, userId: 'user-1', metadata: { method: 'password' } });
  expect(h.insert).toHaveBeenCalledTimes(1);
  return h.insert.mock.calls[0]![0].ip_address;
}

beforeEach(() => {
  vi.resetAllMocks();
  h.insert.mockResolvedValue({ error: null });
});

describe('adres IP we wpisie audytu', () => {
  it('X-Real-Ip od Traefika wygrywa z podanym przez klienta pierwszym wpisem X-Forwarded-For', async () => {
    await expect(storedIp({ 'x-forwarded-for': '198.51.100.7, 83.21.104.77', 'x-real-ip': '83.21.104.77' }))
      .resolves.toBe('83.21.104.77');
  });

  it('bez X-Real-Ip: ostatni wpis X-Forwarded-For, dopisany przez nasze proxy', async () => {
    await expect(storedIp({ 'x-forwarded-for': '198.51.100.7, 83.21.104.77' })).resolves.toBe('83.21.104.77');
  });

  it('IPv6 zostaje', async () => {
    await expect(storedIp({ 'x-real-ip': '2a02:a311:4a3f:1::5' })).resolves.toBe('2a02:a311:4a3f:1::5');
  });

  it.each(['x', 'unknown', '999.1.1.1', 'fe80::1%eth0'])('„%s” to nie adres: wpis powstaje bez adresu', async (value) => {
    await expect(storedIp({ 'x-real-ip': value })).resolves.toBeNull();
  });

  it('bez nagłówków: bez adresu', async () => {
    await expect(storedIp({})).resolves.toBeNull();
  });
});
