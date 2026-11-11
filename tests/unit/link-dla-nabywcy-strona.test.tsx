// @vitest-environment jsdom
import { createHash } from 'node:crypto';

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 2.10 planu kompletnej aplikacji: strona faktury dla nabywcy
 * (`/faktura/<token>`). Prawdziwe: limiter z `lib/rate-limit` (na atrapie
 * Redisa po HTTP), skrót tokenu, odczyt odpowiedzi funkcji bazy i strona.
 * Atrapy tylko dla Redisa, klienta bazy i adresu IP. Samą funkcję
 * `invoice_share_link_view` (wygasły, cofnięty, cudzy token, faktura
 * nieprzyjęta) sprawdza `tests/rls-link-dla-nabywcy.test.ts` na bazie.
 */

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
const TENANT = '00179179-0000-4000-8000-0000000000aa';
const INVOICE = '00179179-1111-4000-8000-0000000000bb';
const LINK = '00179179-2222-4000-8000-0000000000cc';
const XML_PATH = `${TENANT}/2026/10/${INVOICE}.xml`;
const SHA = 'ab'.repeat(32);

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  redisOn: true,
  count: 1,
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/lib/auth/get-client-ip', () => ({ getClientIp: async () => '203.0.113.7' }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock('@/lib/cache/redis', () => ({
  isRedisConfigured: () => mocks.redisOn,
  getRedis: () => ({
    pipeline() {
      const pipe = {
        zremrangebyscore: () => pipe,
        zadd: () => pipe,
        zcard: () => pipe,
        expire: () => pipe,
        exec: async () => [0, 1, mocks.count, 1],
      };
      return pipe;
    },
    zrem: async () => 1,
    zrange: async () => ['m', Date.now() - 60_000],
  }),
}));

const { loadBuyerInvoice } = await import('@/lib/invoice-share/buyer-invoice');
const { default: BuyerInvoicePage } = await import('@/app/faktura/[token]/page');

function rpcRow(overrides: Record<string, unknown> = {}, invoice: Record<string, unknown> = {}) {
  return {
    link_id: LINK,
    tenant_id: TENANT,
    invoice_id: INVOICE,
    expires_at: '2027-02-07T10:00:00+00:00',
    ksef_environment: 'test',
    xml_storage_path: XML_PATH,
    xml_sha256: SHA,
    invoice: {
      internal_number: 'FV/1/11/2026',
      invoice_type: 'VAT',
      invoice_kind: 'regular',
      issue_date: '2026-11-09',
      sale_date: '2026-11-08',
      currency: 'PLN',
      net_total: 1000,
      vat_total: 230,
      gross_total: 1230,
      notes: 'Dziękujemy za zakupy',
      ksef_number: '1234567890-20261109-0A1B2C3D4E5F-6A',
      ksef_accepted_at: '2026-11-09T09:15:00+00:00',
      split_payment: false,
      seller: { name: 'Sprzedawca Testowy', nip: '1234567890', address_line1: 'ul. Prosta 1', address_line2: '00-001 Warszawa', country_code: 'PL' },
      buyer: { name: 'Jan Nabywca', nip: null, vat_ue_number: null, address_line1: 'ul. Krzywa 2', address_line2: '00-002 Kraków', country_code: 'PL' },
      payment: { method: 'transfer', due_date: '2026-11-23', bank_account: 'PL61109010140000071219812874', bank_name: 'Bank Testowy', swift: null },
      lines: [
        { ordinal: 1, name: 'Usługa testowa', unit: 'szt.', quantity: 2, unit_price_net: 500, vat_rate: '23', net_amount: 1000, vat_amount: 230, gross_amount: 1230 },
      ],
      ...invoice,
    },
    ...overrides,
  };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.redisOn = true;
  mocks.count = 1;
  vi.stubEnv('KSEF_ENV', 'test');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.test');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'fixture-token');
});
afterEach(() => vi.unstubAllEnvs());

describe('odczyt faktury po tokenie (loader strony i plików)', () => {
  it('pyta bazę skrótem tokenu, nigdy samym tokenem, i liczy otwarcie tylko na życzenie', async () => {
    mocks.rpc.mockResolvedValue({ data: rpcRow(), error: null });
    const result = await loadBuyerInvoice(TOKEN, { countOpen: true });
    expect(result.status).toBe('ok');
    expect(mocks.rpc).toHaveBeenCalledWith('invoice_share_link_view', { p_token_hash: sha256(TOKEN), p_count_open: true });
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(TOKEN);

    await loadBuyerInvoice(TOKEN, { countOpen: false });
    expect(mocks.rpc).toHaveBeenLastCalledWith('invoice_share_link_view', { p_token_hash: sha256(TOKEN), p_count_open: false });
  });

  it('bez Redisa odmawia (fail-closed) i nie pyta bazy', async () => {
    mocks.redisOn = false;
    expect(await loadBuyerInvoice(TOKEN, { countOpen: true })).toEqual({ status: 'unavailable' });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('po przekroczeniu limitu prób odmawia z czasem do ponowienia i nie pyta bazy', async () => {
    mocks.count = 61;
    const result = await loadBuyerInvoice(TOKEN, { countOpen: true });
    expect(result.status).toBe('limited');
    expect(result.status === 'limited' && result.retryAfter).toBeGreaterThan(0);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each(['', 'krotki', `${TOKEN}x`, `${TOKEN.slice(0, 42)}!`, `../${TOKEN.slice(3)}`])(
    'token w złym formacie (%s) to brak faktury, bez pytania bazy',
    async (token) => {
      expect(await loadBuyerInvoice(token, { countOpen: true })).toEqual({ status: 'not_found' });
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it('link nieznany, wygasły, cofnięty albo faktura nieprzyjęta (funkcja zwraca NULL) to brak faktury', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    expect(await loadBuyerInvoice(TOKEN, { countOpen: true })).toEqual({ status: 'not_found' });
  });

  it('faktura z innego środowiska KSeF niż aplikacja to brak faktury', async () => {
    mocks.rpc.mockResolvedValue({ data: rpcRow({ ksef_environment: 'production' }), error: null });
    expect(await loadBuyerInvoice(TOKEN, { countOpen: true })).toEqual({ status: 'not_found' });
  });

  it('błąd bazy albo odpowiedź w złym kształcie to strona niedostępna, nie pusta faktura', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    expect(await loadBuyerInvoice(TOKEN, { countOpen: true })).toEqual({ status: 'unavailable' });
    mocks.rpc.mockResolvedValue({ data: { ...rpcRow(), invoice: 'nie-obiekt' }, error: null });
    expect(await loadBuyerInvoice(TOKEN, { countOpen: true })).toEqual({ status: 'unavailable' });
  });

  it('widok dla strony nie niesie identyfikatorów firmy, faktury, linku ani ścieżki pliku', async () => {
    mocks.rpc.mockResolvedValue({ data: rpcRow(), error: null });
    const result = await loadBuyerInvoice(TOKEN, { countOpen: true });
    if (result.status !== 'ok') throw new Error(result.status);
    const view = JSON.stringify(result.view);
    for (const secret of [TENANT, INVOICE, LINK, XML_PATH]) expect(view).not.toContain(secret);
    expect(result.access).toEqual({ tenantId: TENANT, invoiceId: INVOICE, linkId: LINK, xmlStoragePath: XML_PATH });
  });
});

const page = async () => renderToStaticMarkup(await BuyerInvoicePage({ params: Promise.resolve({ token: TOKEN }) }));

describe('strona /faktura/<token>', () => {
  it('pokazuje podgląd, numer KSeF, dane do przelewu i odnośniki do PDF i XML z KSeF', async () => {
    mocks.rpc.mockResolvedValue({ data: rpcRow(), error: null });
    const html = await page();
    expect(html).toContain('FV/1/11/2026');
    expect(html).toContain('Sprzedawca Testowy');
    expect(html).toContain('Jan Nabywca');
    expect(html).toContain('Usługa testowa');
    expect(html).toContain('1234567890-20261109-0A1B2C3D4E5F-6A');
    expect(html).toContain('PL61109010140000071219812874');
    // Polski zapis nie grupuje czterocyfrowych kwot (CLDR, `lib/format/pl.ts`).
    expect(html).toMatch(/1\s?230,00 PLN/);
    expect(html).toContain('23.11.2026');
    expect(html).toContain(`href="/faktura/${TOKEN}/pdf"`);
    expect(html).toContain(`href="/faktura/${TOKEN}/xml"`);
    expect(html).toContain('Dziękujemy za zakupy');
  });

  it('nie pokazuje identyfikatorów, ścieżek ani długich myślników', async () => {
    mocks.rpc.mockResolvedValue({ data: rpcRow(), error: null });
    const html = await page();
    for (const secret of [TENANT, INVOICE, LINK, XML_PATH, SHA]) expect(html).not.toContain(secret);
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });

  it('odnośniki do plików to zwykłe <a> bez wstępnego pobierania i bez Referer', async () => {
    mocks.rpc.mockResolvedValue({ data: rpcRow(), error: null });
    const html = await page();
    const pdfLink = html.match(/<a[^>]*href="\/faktura\/[^"]+\/pdf"[^>]*>/)?.[0] ?? '';
    expect(pdfLink).toMatch(/rel="[^"]*noreferrer/);
  });

  it('nieznany, wygasły albo cofnięty link: strona „nie znaleziono”', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await expect(page()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('za dużo prób: komunikat z tym, co zrobić, bez danych faktury', async () => {
    mocks.count = 61;
    const html = await page();
    expect(html).toContain('Za dużo otwarć');
    expect(html).not.toContain('FV/1/11/2026');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('bez Redisa: strona chwilowo niedostępna, bez danych faktury', async () => {
    mocks.redisOn = false;
    const html = await page();
    expect(html).toContain('chwilowo niedostępna');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
