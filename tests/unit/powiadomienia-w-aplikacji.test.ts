import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * Dzwonek w aplikacji (plan kompletnej aplikacji, krok 8.1, część 2, 00188).
 *
 * Zapis idzie przez RPC `app_notification_publish`: wpis dla każdego
 * aktywnego członka firmy, UNIQUE (odbiorca, firma, rodzaj, klucz obiektu)
 * z ON CONFLICT DO NOTHING. Samo UNIQUE i RLS sprawdza baza
 * (`tests/rls-powiadomienia-w-aplikacji.test.ts`); tutaj prawdziwa ścieżka
 * z atrapą bazy: klucz jest stały przy ponowieniu, błąd zapisu w jobach
 * istniejących nie rzuca (fail-open z logiem), a trzecie kolejki wyniku
 * wysyłki do KSeF zapisują tylko prawdziwe przyjęcie i odrzucenie.
 */

type RpcCall = { fn: string; args: Record<string, unknown> };

const db = vi.hoisted(() => ({
  rpcCalls: [] as RpcCall[],
  rpcResult: { data: 1, error: null } as { data: unknown; error: null | { message: string; code?: string } },
  rpcThrows: null as Error | null,
  invoice: null as Record<string, unknown> | null,
  invoiceError: null as null | { message: string },
  invoiceReads: 0,
  invoiceFilters: [] as Array<[string, unknown]>,
}));
const sentry = vi.hoisted(() => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

vi.mock('@sentry/nextjs', () => sentry);
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args });
      if (db.rpcThrows) throw db.rpcThrows;
      return db.rpcResult;
    },
    from: (table: string) => {
      if (table !== 'invoices') throw new Error(`nieoczekiwana tabela ${table}`);
      const q: Record<string, unknown> = {};
      Object.assign(q, {
        select: () => q,
        eq: (k: string, v: unknown) => (db.invoiceFilters.push([k, v]), q),
        maybeSingle: async () => {
          db.invoiceReads++;
          return { data: db.invoice, error: db.invoiceError };
        },
      });
      return q;
    },
  }),
}));

const { publishAppNotification, writeAppNotification } = await import('@/lib/app-notifications/publish');
const texts = await import('@/lib/app-notifications/texts');
const { runAppNotificationInvoiceAccepted, runAppNotificationInvoiceRejected } = await import(
  '@/lib/jobs/runners/app-notifications'
);
const { NonRetriableError } = await import('@/lib/jobs/errors');

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVOICE = '11111111-1111-4111-8111-111111111111';
const EXPENSE = '22222222-2222-4222-8222-222222222222';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}
function ctx(log = logger()): JobContext {
  return {
    attempt: 0,
    logger: log,
    step: { run: async (_n: string, fn: () => unknown) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
  } as unknown as JobContext;
}

const WPIS = {
  tenantId: TENANT,
  kind: 'inbox_new' as const,
  objectKey: INVOICE,
  title: 'Nowa faktura zakupu',
  body: 'FV 1/2026 od Dostawca, 123,00 zł',
  link: `/expenses/${EXPENSE}`,
};

beforeEach(() => {
  db.rpcCalls = [];
  db.rpcResult = { data: 1, error: null };
  db.rpcThrows = null;
  db.invoice = null;
  db.invoiceError = null;
  db.invoiceReads = 0;
  db.invoiceFilters = [];
  sentry.captureException.mockClear();
});

describe('zapis powiadomienia (RPC z kluczem)', () => {
  it('woła app_notification_publish z firmą, rodzajem, kluczem obiektu, treścią i linkiem', async () => {
    db.rpcResult = { data: 2, error: null };
    await expect(publishAppNotification(WPIS)).resolves.toEqual({ ok: true, created: 2 });
    expect(db.rpcCalls).toEqual([
      {
        fn: 'app_notification_publish',
        args: {
          p_tenant_id: TENANT,
          p_kind: 'inbox_new',
          p_object_key: INVOICE,
          p_title: 'Nowa faktura zakupu',
          p_body: 'FV 1/2026 od Dostawca, 123,00 zł',
          p_link: `/expenses/${EXPENSE}`,
        },
      },
    ]);
  });

  it('drugie wykonanie wysyła ten sam klucz; baza zwraca 0 nowych wpisów (ON CONFLICT DO NOTHING)', async () => {
    await publishAppNotification(WPIS);
    db.rpcResult = { data: 0, error: null };
    await expect(publishAppNotification(WPIS)).resolves.toEqual({ ok: true, created: 0 });
    expect(db.rpcCalls).toHaveLength(2);
    expect(db.rpcCalls[1]!.args).toEqual(db.rpcCalls[0]!.args);
  });

  it('fail-open: błąd bazy nie rzuca, zostaje log i Sentry', async () => {
    db.rpcResult = { data: null, error: { message: 'relation "app_notifications" does not exist', code: '42P01' } };
    const log = logger();
    await expect(publishAppNotification(WPIS, { logger: log })).resolves.toMatchObject({ ok: false, reason: 'write-failed' });
    expect(log.warn).toHaveBeenCalledOnce();
    expect(sentry.captureException).toHaveBeenCalledOnce();
  });

  it('fail-open: wyjątek klienta bazy (sieć) też nie rzuca', async () => {
    db.rpcThrows = new Error('fetch failed');
    const log = logger();
    await expect(publishAppNotification(WPIS, { logger: log })).resolves.toMatchObject({ ok: false, reason: 'write-failed' });
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('link spoza aplikacji nie trafia do bazy', async () => {
    for (const link of ['https://faktway.example/expenses', '//faktway.example', '/expenses/x y', 'expenses/1']) {
      await expect(publishAppNotification({ ...WPIS, link }, { logger: logger() })).resolves.toMatchObject({ ok: false, reason: 'invalid' });
    }
    expect(db.rpcCalls).toEqual([]);
  });

  it('długi tytuł i treść są skracane do limitów kolumn, puste pola idą jako null', async () => {
    await publishAppNotification({ ...WPIS, title: 'T'.repeat(250), body: 'B'.repeat(1200), link: null });
    const args = db.rpcCalls[0]!.args;
    expect(String(args.p_title)).toHaveLength(200);
    expect(String(args.p_title).endsWith('…')).toBe(true);
    expect(String(args.p_body)).toHaveLength(1000);
    expect(args.p_link).toBeNull();
    await publishAppNotification({ ...WPIS, body: '  ' });
    expect(db.rpcCalls[1]!.args.p_body).toBeNull();
  });

  it('wariant ścisły (kolejki dzwonka) rzuca przy błędzie bazy, żeby pg-boss ponowił', async () => {
    db.rpcResult = { data: null, error: { message: 'timeout' } };
    await expect(writeAppNotification(WPIS)).rejects.toThrow(/timeout/);
  });
});

describe('treści i klucze', () => {
  it('nowa faktura zakupu: numer, sprzedawca, kwota w walucie, link do kosztu, klucz = faktura', () => {
    expect(
      texts.inboxNewNotification({
        tenantId: TENANT,
        invoiceId: INVOICE,
        expenseId: EXPENSE,
        documentNumber: 'FV 1/2026',
        sellerName: 'Dostawca sp. z o.o.',
        grossAmount: 123,
        currency: 'PLN',
      }),
    ).toEqual({
      tenantId: TENANT,
      kind: 'inbox_new',
      objectKey: INVOICE,
      title: 'Nowa faktura zakupu',
      body: 'FV 1/2026 od Dostawca sp. z o.o., 123,00 zł',
      link: `/expenses/${EXPENSE}`,
    });
    const eur = texts.inboxNewNotification({
      tenantId: TENANT,
      invoiceId: INVOICE,
      expenseId: EXPENSE,
      documentNumber: 'INV-7',
      sellerName: 'Nieznany',
      grossAmount: 100,
      currency: 'EUR',
    });
    expect(eur.body).toBe('INV-7, 100,00 EUR');
  });

  it('przyjęta w KSeF: numer faktury i numer KSeF, link do faktury, klucz = faktura', () => {
    expect(
      texts.invoiceAcceptedNotification({
        tenantId: TENANT,
        invoiceId: INVOICE,
        invoiceNumber: 'FV/1/11/2026',
        ksefNumber: '1234567890-20261111-ABCDEF123456-01',
      }),
    ).toEqual({
      tenantId: TENANT,
      kind: 'invoice_accepted',
      objectKey: INVOICE,
      title: 'Faktura przyjęta w KSeF',
      body: 'FV/1/11/2026, numer KSeF 1234567890-20261111-ABCDEF123456-01',
      link: `/invoices/${INVOICE}`,
    });
  });

  it('odrzucona w KSeF: klucz z faktury i skrótu powodu (ten sam powód = ten sam klucz)', () => {
    const a = texts.invoiceRejectedNotification({ tenantId: TENANT, invoiceId: INVOICE, invoiceNumber: 'FV/2/11/2026', error: 'Błąd: zły NIP nabywcy' });
    const b = texts.invoiceRejectedNotification({ tenantId: TENANT, invoiceId: INVOICE, invoiceNumber: 'FV/2/11/2026', error: 'Błąd: zły NIP nabywcy' });
    const c = texts.invoiceRejectedNotification({ tenantId: TENANT, invoiceId: INVOICE, invoiceNumber: 'FV/2/11/2026', error: 'Błąd: brak daty sprzedaży' });
    expect(a).toEqual(b);
    expect(a.objectKey).toMatch(new RegExp(`^${INVOICE}:[0-9a-f]{16}$`));
    expect(c.objectKey).not.toBe(a.objectKey);
    expect(a).toMatchObject({
      kind: 'invoice_rejected',
      title: 'Faktura odrzucona w KSeF',
      body: 'FV/2/11/2026: powód odrzucenia jest na stronie faktury.',
      link: `/invoices/${INVOICE}`,
    });
  });

  it('termin podatku: treść przypomnienia modułu, klucz = rozliczenie i etap', () => {
    expect(
      texts.taxDeadlineNotification({
        tenantId: TENANT,
        miesiac: '2026-10',
        etap: 'termin-5:2026-11-20',
        tytul: 'Termin 20.11.2026: rozliczenie za październik 2026',
        tresc: 'Za 5 dni, 20.11.2026, mija termin za październik 2026.',
        adres: '/reports/ten-miesiac?month=10&year=2026',
      }),
    ).toEqual({
      tenantId: TENANT,
      kind: 'tax_deadline',
      objectKey: '2026-10:termin-5:2026-11-20',
      title: 'Termin 20.11.2026: rozliczenie za październik 2026',
      body: 'Za 5 dni, 20.11.2026, mija termin za październik 2026.',
      link: '/reports/ten-miesiac?month=10&year=2026',
    });
  });

  it('teksty bez długich myślników', () => {
    const wszystkie = [
      texts.inboxNewNotification({ tenantId: TENANT, invoiceId: INVOICE, expenseId: EXPENSE, documentNumber: 'A', sellerName: 'B', grossAmount: 1, currency: 'PLN' }),
      texts.invoiceAcceptedNotification({ tenantId: TENANT, invoiceId: INVOICE, invoiceNumber: null, ksefNumber: null }),
      texts.invoiceRejectedNotification({ tenantId: TENANT, invoiceId: INVOICE, invoiceNumber: null, error: 'x' }),
      texts.invoiceRejectedNotification({ tenantId: TENANT, invoiceId: INVOICE, invoiceNumber: null, error: 'x', beforeKsef: true }),
    ];
    for (const n of wszystkie) expect(`${n.title} ${n.body}`).not.toMatch(/[—–]/);
  });
});

describe('kolejka dzwonka: faktura przyjęta w KSeF', () => {
  const DANE = { tenantId: TENANT, invoiceId: INVOICE, ksefNumber: 'K-1', environment: 'test' as const };

  it('zapisuje wpis, gdy faktura w bazie jest przyjęta; ponowienie wysyła ten sam klucz', async () => {
    db.invoice = { id: INVOICE, tenant_id: TENANT, internal_number: 'FV/1/11/2026', ksef_status: 'accepted', ksef_number: 'K-1' };
    await expect(runAppNotificationInvoiceAccepted(DANE, ctx())).resolves.toEqual({ created: 1 });
    expect(db.invoiceFilters).toEqual(expect.arrayContaining([['id', INVOICE], ['tenant_id', TENANT]]));
    db.rpcResult = { data: 0, error: null };
    await expect(runAppNotificationInvoiceAccepted(DANE, ctx())).resolves.toEqual({ created: 0 });
    expect(db.rpcCalls).toHaveLength(2);
    expect(db.rpcCalls[0]!.args).toMatchObject({ p_kind: 'invoice_accepted', p_object_key: INVOICE, p_link: `/invoices/${INVOICE}` });
    expect(db.rpcCalls[1]!.args).toEqual(db.rpcCalls[0]!.args);
  });

  it('faktura w innym stanie (np. znów w wysyłce): bez wpisu', async () => {
    db.invoice = { id: INVOICE, tenant_id: TENANT, internal_number: 'FV/1', ksef_status: 'sending', ksef_number: null };
    await expect(runAppNotificationInvoiceAccepted(DANE, ctx())).resolves.toEqual({ skipped: 'not-accepted' });
    expect(db.rpcCalls).toEqual([]);
  });

  it('faktura spoza firmy zadania: błąd bez ponowień i bez wpisu', async () => {
    db.invoice = null;
    await expect(runAppNotificationInvoiceAccepted(DANE, ctx())).rejects.toBeInstanceOf(NonRetriableError);
    expect(db.rpcCalls).toEqual([]);
  });

  it('błąd zapisu: zadanie rzuca, pg-boss ponawia (UNIQUE chroni przed dublem); wysyłka faktury bez zmian', async () => {
    db.invoice = { id: INVOICE, tenant_id: TENANT, internal_number: 'FV/1', ksef_status: 'accepted', ksef_number: 'K-1' };
    db.rpcResult = { data: null, error: { message: 'connection reset' } };
    await expect(runAppNotificationInvoiceAccepted(DANE, ctx())).rejects.toThrow(/connection reset/);
  });
});

describe('kolejka dzwonka: faktura odrzucona w KSeF', () => {
  const DANE = { tenantId: TENANT, invoiceId: INVOICE, error: 'Błąd: zły NIP nabywcy', environment: 'test' as const };

  it('zapisuje wpis, gdy faktura w bazie jest odrzucona za treść (`rejected`)', async () => {
    db.invoice = { id: INVOICE, tenant_id: TENANT, internal_number: 'FV/2/11/2026', ksef_status: 'rejected', ksef_number: null, last_error_code: 'KSEF_REJECTED' };
    await expect(runAppNotificationInvoiceRejected(DANE, ctx())).resolves.toEqual({ created: 1 });
    expect(db.rpcCalls[0]!.args).toMatchObject({
      p_kind: 'invoice_rejected',
      p_title: 'Faktura odrzucona w KSeF',
      p_link: `/invoices/${INVOICE}`,
    });
    expect(String(db.rpcCalls[0]!.args.p_object_key)).toMatch(new RegExp(`^${INVOICE}:[0-9a-f]{16}$`));
  });

  it('błąd schematu FA(3) przed wysyłką (`XSD_INVALID`): tekst mówi, że faktura do KSeF nie trafiła', async () => {
    db.invoice = { id: INVOICE, tenant_id: TENANT, internal_number: 'FV/3/11/2026', ksef_status: 'rejected', ksef_number: null, last_error_code: 'XSD_INVALID' };
    await runAppNotificationInvoiceRejected(DANE, ctx());
    expect(db.rpcCalls[0]!.args).toMatchObject({
      p_kind: 'invoice_rejected',
      p_title: 'Faktura nie trafiła do KSeF',
      p_body: 'FV/3/11/2026: dane nie przeszły sprawdzenia przed wysyłką. Szczegóły są na stronie faktury.',
    });
  });

  it.each([
    ['błąd techniczny (`failed`, ponawia cron)', 'failed'],
    ['faktura przyjęta w międzyczasie', 'accepted'],
    ['faktura znów w wysyłce', 'sending'],
  ])('%s: bez wpisu „odrzucona”', async (_nazwa, status) => {
    db.invoice = { id: INVOICE, tenant_id: TENANT, internal_number: 'FV/2', ksef_status: status, ksef_number: null };
    await expect(runAppNotificationInvoiceRejected(DANE, ctx())).resolves.toEqual({ skipped: 'not-rejected' });
    expect(db.rpcCalls).toEqual([]);
  });

  it('blokada ROZ do uzgodnienia: bez odczytu i bez wpisu (to nie jest odrzucenie)', async () => {
    await expect(runAppNotificationInvoiceRejected({ ...DANE, manualReconciliationRequired: true }, ctx())).resolves.toEqual({
      skipped: 'manual-reconciliation',
    });
    expect(db.invoiceReads).toBe(0);
    expect(db.rpcCalls).toEqual([]);
  });

  it('błąd odczytu faktury: zadanie rzuca (ponowienie), bez wpisu', async () => {
    db.invoiceError = { message: 'db down' };
    await expect(runAppNotificationInvoiceRejected(DANE, ctx())).rejects.toThrow();
    expect(db.rpcCalls).toEqual([]);
  });
});

describe('migracja 00188 (tekst; zachowanie na bazie w tests/rls-powiadomienia-w-aplikacji.test.ts)', () => {
  const sql = () => readFileSync(join(process.cwd(), 'supabase/migrations/00188_app_notifications.sql'), 'utf8');

  it('PRZED wdrożeniem, klucz idempotencji i zapis bez dubli', () => {
    const tekst = sql();
    expect(tekst).toMatch(/KIEDY WGRAĆ: PRZED wdrożeniem/);
    expect(tekst).toContain('CONSTRAINT app_notifications_klucz_unikalny UNIQUE (user_id, tenant_id, kind, object_key)');
    expect(tekst).toContain('ON CONFLICT ON CONSTRAINT app_notifications_klucz_unikalny DO NOTHING');
    expect(tekst).toContain("m.status = 'active'");
  });

  it('klucz użytkownika: tylko odczyt tabeli i oznaczanie; zapis wpisów tylko zadania (service_role)', () => {
    const tekst = sql();
    expect(tekst).toContain('REVOKE ALL ON public.app_notifications FROM PUBLIC, anon, authenticated, service_role;');
    expect(tekst).toContain('GRANT SELECT ON public.app_notifications TO authenticated;');
    expect(tekst).not.toMatch(/GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*TO authenticated/);
    expect(tekst).toContain(
      'REVOKE ALL ON FUNCTION public.app_notification_publish(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(tekst).toContain('GRANT EXECUTE ON FUNCTION public.app_notification_publish(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;');
    expect(tekst).toContain('REVOKE ALL ON FUNCTION public.app_notifications_mark_read(UUID[]) FROM PUBLIC, anon, authenticated, service_role;');
    expect(tekst).toContain('GRANT EXECUTE ON FUNCTION public.app_notifications_mark_read(UUID[]) TO authenticated;');
  });

  it('funkcje z pustym search_path; oznaczanie tylko własnych wpisów aktywnej firmy', () => {
    const tekst = sql();
    expect(tekst.match(/SET search_path = ''/g)?.length).toBe(2);
    expect(tekst).toMatch(/n\.tenant_id = v_tenant\s+AND n\.user_id = v_user/);
    expect(tekst).toContain('SET read_at = GREATEST(now(), n.created_at)');
  });
});
