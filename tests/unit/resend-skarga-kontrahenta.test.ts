import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: mocks.admin }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
import { POST } from '@/app/api/email/resend-webhook/route';

/**
 * AUD-80: skarga („to spam”) albo twarde odbicie maila z PONAGLENIEM
 * dotyczy kontrahenta klienta, nie użytkownika FaktWay. Do 02.10 webhook
 * szukał użytkownika po adresie i wypisywał go ze wszystkich maili — także
 * transakcyjnych — gdy kontrahent sam miał konto w FaktWay.
 */

const key = Buffer.from('local-fixture-key-no-external-service');
let inserts: number;
let rows: Array<Record<string, unknown>>;
let writes: string[];

function request(type: 'email.bounced' | 'email.complained', tags?: Record<string, string>) {
  const body = JSON.stringify({ type, data: { to: ['kontrahent@example.test'], bounce: { type: 'hard' }, ...(tags ? { tags } : {}) } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = `evt-${type}-${tags ? 'tag' : 'plain'}`;
  const sig = createHmac('sha256', key).update(id + '.' + timestamp + '.' + body).digest('base64');
  return new Request('https://app.example.test/api/email/resend-webhook', {
    method: 'POST', body, headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': 'v1,' + sig },
  });
}

beforeEach(() => {
  vi.resetAllMocks(); inserts = 0; writes = []; rows = [];
  vi.stubEnv('RESEND_WEBHOOK_SECRET', 'whsec_' + key.toString('base64'));
  mocks.admin.mockImplementation(() => ({
    auth: { admin: { listUsers: async () => ({ data: { users: [{ id: 'kontrahent-z-kontem', email: 'kontrahent@example.test' }] }, error: null }) } },
    from: () => ({
      insert: async (row: Record<string, unknown>) => { inserts++; rows.push(row); return { error: null }; },
      upsert: async (row: { category: string }) => { writes.push(row.category); return { error: null }; },
    }),
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe.each(['email.bounced', 'email.complained'] as const)('%s', (type) => {
  it('ponaglenie: adres trafia na listę odbić, użytkownik o tym adresie NIE jest wypisywany', async () => {
    const res = await POST(request(type, { kind: 'payment_reminder' }));

    expect(res.status).toBe(200);
    expect(inserts).toBe(1);
    expect(writes).toEqual([]);
  });

  it('mail aplikacji do użytkownika — wypis jak dotąd', async () => {
    await POST(request(type));

    expect(writes).toContain('marketing');
  });
});

describe('retencja zdarzeń Resend (AUD-81, decyzja B9)', () => {
  it.each(['email.bounced', 'email.complained'] as const)('%s: zapisujemy adres i typ, bez surowego zdarzenia', async (type) => {
    await POST(request(type));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw_payload ?? null).toBeNull();
    expect(rows[0]).toMatchObject({ email: 'kontrahent@example.test' });
  });
});

describe('użytkownik dalej niż na pierwszej stronie kont (AUD-125)', () => {
  it('odbicie wypisuje użytkownika z 2. strony', async () => {
    const users = Array.from({ length: 1500 }, (_, i) => ({ id: `u-${i}`, email: `osoba${i}@example.test` }));
    users[1200] = { id: 'szukany', email: 'kontrahent@example.test' };
    mocks.admin.mockImplementation(() => ({
      auth: { admin: { listUsers: async ({ page = 1, perPage = 50 }: { page?: number; perPage?: number }) =>
        ({ data: { users: users.slice((page - 1) * perPage, page * perPage) }, error: null }) } },
      from: () => ({
        insert: async () => ({ error: null }),
        upsert: async (row: { user_id: string; category: string }) => { writes.push(`${row.user_id}:${row.category}`); return { error: null }; },
      }),
    }));

    expect((await POST(request('email.bounced'))).status).toBe(200);
    expect(writes).toContain('szukany:marketing');
  });
});
