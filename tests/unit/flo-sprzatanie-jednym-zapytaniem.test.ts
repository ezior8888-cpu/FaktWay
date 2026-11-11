import { createClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureException = vi.hoisted(() => vi.fn());
vi.mock('@sentry/nextjs', () => ({ captureException }));

const audit = vi.hoisted(() => vi.fn(async (_entry: { entityId?: string }) => undefined));
vi.mock('@/lib/audit/log-system', () => ({ logAuditSystem: audit }));

import type { FloDbClient } from '@/lib/flo/db-types';
import { expireStale } from '@/lib/flo/proposals';
import { runFloTick, summarizeTick, type FloTickSources } from '@/lib/flo/tick';
import type { JobContext } from '@/lib/jobs/registry';

/**
 * FLO-01 (plan skalowania 3000, sesja 3): sprzątanie na początku pulsu.
 *
 * `expireStale` i strażnik zawieszonych kart najpierw czytały listę id,
 * a potem odsyłały ją w adresie PATCH-a (`id=in.(…)`). Produkcyjny PostgREST
 * oddaje najwyżej 1000 wierszy, więc lista była ucinana, a adres rósł
 * o ok. 39 znaków na kartę. Od ok. 200 kart przekracza 8000 znaków — granicę,
 * przed którą ostrzega sama biblioteka Supabase. Błąd pierwszego kroku
 * zatrzymywał cały puls, czyli wszystkie reguły na wszystkich kontach.
 *
 * Testy idą przez PRAWDZIWEGO klienta Supabase; atrapą jest tylko serwer
 * (`fetch`), więc widać adres, który naprawdę wychodzi z workera.
 */

const NOW = new Date('2026-11-11T06:30:00.000Z');
const PAST = '2026-11-10T00:00:00.000Z';
const FUTURE = '2026-11-20T00:00:00.000Z';
/** Ponad 15 minut przed NOW — tyle czeka strażnik, zanim uzna kartę za porzuconą. */
const LONG_AGO = '2026-11-11T06:00:00.000Z';
/** Pięć minut przed NOW — wykonanie, które po prostu trwa. */
const JUST_NOW = '2026-11-11T06:25:00.000Z';

/** Produkcyjny PostgREST oddaje najwyżej tyle wierszy na odczyt (`PGRST_DB_MAX_ROWS`). */
const MAX_ROWS = 1000;

type Row = Record<string, unknown>;

interface Sent {
  method: string;
  url: string;
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict']);

/** Warunek z adresu — tylko operatory, których używa sprzątanie pulsu. */
function condition(column: string, raw: string): (row: Row) => boolean {
  const dot = raw.indexOf('.');
  const op = raw.slice(0, dot);
  const value = raw.slice(dot + 1);
  switch (op) {
    case 'eq':
      return (row) => row[column] != null && String(row[column]) === value;
    case 'lt':
      return (row) => row[column] != null && String(row[column]) < value;
    case 'gte':
      return (row) => row[column] != null && String(row[column]) >= value;
    case 'in': {
      const list = value.replace(/^\(|\)$/g, '').split(',');
      return (row) => list.includes(String(row[column]));
    }
    default:
      throw new Error(`atrapa PostgREST: nieobsługiwany operator ${op} (${column})`);
  }
}

function contentRange(returned: number, total: number): string {
  return `${returned > 0 ? `0-${returned - 1}` : '*'}/${total}`;
}

/**
 * Serwer PostgREST w pamięci. Odczyt ucina do 1000 wierszy jak produkcja;
 * zapis zwraca wszystkie zmienione wiersze, bo od PostgREST 10 `max-rows`
 * nie dotyczy wierszy zwracanych przez zapis.
 */
function server(
  tables: Record<string, Row[]>,
  /** Które żądanie ma paść — po treści zapisu, żeby nie zależeć od kształtu adresu. */
  failWhen?: (method: string, body: Row | null) => boolean,
) {
  const sent: Sent[] = [];
  const client = createClient('https://database.example.invalid', 'synthetic-local-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        sent.push({ method, url: url.toString() });
        const body = typeof init?.body === 'string' && init.body !== '' ? (JSON.parse(init.body) as Row) : null;

        if (failWhen?.(method, body)) {
          return Response.json(
            { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null },
            { status: 500 },
          );
        }

        const table = url.pathname.replace(/^\/rest\/v1\//, '');
        const rows = (tables[table] ??= []);
        let filters: Array<(row: Row) => boolean>;
        try {
          filters = [...url.searchParams]
            .filter(([key]) => !RESERVED.has(key))
            .map(([key, raw]) => condition(key, raw));
        } catch (e) {
          // Odpowiedź z błędem, nie wyjątek z `fetch`: wyjątek przy GET
          // biblioteka ponawia z opóźnieniem, a test ma paść od razu.
          return Response.json({ code: 'PGRST100', message: String(e), details: null, hint: null }, { status: 400 });
        }
        const matching = rows.filter((row) => filters.every((f) => f(row)));
        const prefer = new Headers(init?.headers).get('Prefer') ?? '';
        const columns = url.searchParams.get('select')?.split(',').map((c) => c.trim());
        const project = (row: Row): Row =>
          !columns || columns.includes('*')
            ? { ...row }
            : Object.fromEntries(columns.map((c) => [c, row[c] ?? null]));

        if (method === 'GET') {
          const page = matching.slice(0, MAX_ROWS).map(project);
          return Response.json(page, {
            headers: { 'content-range': contentRange(page.length, matching.length) },
          });
        }

        if (method === 'PATCH' && body) {
          for (const row of matching) Object.assign(row, body);
          const headers: Record<string, string> = /count=exact/.test(prefer)
            ? { 'content-range': contentRange(matching.length, matching.length) }
            : {};
          if (/return=representation/.test(prefer)) {
            return Response.json(matching.map(project), { headers });
          }
          return new Response(null, { status: 204, headers });
        }

        throw new Error(`atrapa PostgREST: nieobsługiwana metoda ${method}`);
      },
    },
  }) as unknown as FloDbClient;

  return { client, sent };
}

function uuid(prefix: number, i: number): string {
  return `00000000-0000-4000-8${prefix}00-${String(i).padStart(12, '0')}`;
}

/** `n` kart po terminie, na przemian otwartych i zatwierdzonych. */
function staleCards(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: uuid(1, i),
    tenant_id: uuid(9, i % 7),
    kind: 'payment.chase',
    status: i % 2 === 0 ? 'open' : 'approved',
    expires_at: PAST,
    approved_at: i % 2 === 0 ? null : PAST,
    dismissed_reason: null,
  }));
}

/** Karty, których wygaszanie NIE może dotknąć. */
function untouchableCards(): Row[] {
  return [
    // Termin jeszcze nie minął.
    { id: uuid(2, 1), tenant_id: uuid(9, 1), kind: 'payment.chase', status: 'open', expires_at: FUTURE, approved_at: null, dismissed_reason: null },
    // Po terminie, ale już zamknięta przez człowieka — powód zostaje jego.
    { id: uuid(2, 2), tenant_id: uuid(9, 1), kind: 'payment.chase', status: 'dismissed', expires_at: PAST, approved_at: null, dismissed_reason: 'never' },
    // Po terminie, ale wykonanie trwa — tę kartę prowadzi wykonawca.
    { id: uuid(2, 3), tenant_id: uuid(9, 1), kind: 'payment.chase', status: 'executing', expires_at: PAST, approved_at: JUST_NOW, dismissed_reason: null },
  ];
}

/** `n` kart porzuconych w stanie „wykonuję” (worker zginął w połowie). */
function stuckCards(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: uuid(3, i),
    tenant_id: uuid(9, i % 7),
    kind: 'payment.chase',
    status: 'executing',
    expires_at: FUTURE,
    approved_at: LONG_AGO,
    dismissed_reason: null,
  }));
}

/** Puls bez kont — te testy dotyczą sprzątania, reguły mają własne testy. */
function noTenants(listTenantIds: () => Promise<string[]> = async () => []): FloTickSources {
  return {
    listTenantIds,
    readGlobalKill: async () => false,
    paymentConfirm: {
      readOverdueInvoices: async () => [],
      readInvoiceState: async () => ({ facts: {}, context: {} }),
      readGlobalKill: async () => false,
    },
    expenseMissing: { readRecentExpenses: async () => [], readGlobalKill: async () => false },
    invoiceMissing: { readIssuedInvoices: async () => [], readGlobalKill: async () => false },
    onboarding: { readAccount: async () => null, readGlobalKill: async () => false },
  };
}

function jobContext() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { ctx: { logger } as unknown as JobContext, logger };
}

/** Żądania strażnika zawieszonych kart — jedyne, które dotyczą stanu „wykonuję”. */
function releaseRequests(sent: readonly Sent[]): Sent[] {
  return sent.filter((s) => new URL(s.url).searchParams.get('status') === 'eq.executing');
}

/** Zapis wygaszający karty — niezależnie od tego, jak wygląda jego adres. */
const isExpire = (method: string, body: Row | null) => method === 'PATCH' && body?.status === 'expired';
/** Zapis strażnika: karta z „wykonuję” wraca do „zatwierdzona”. */
const isRelease = (method: string, body: Row | null) => method === 'PATCH' && body?.status === 'approved';

beforeEach(() => {
  audit.mockClear();
  captureException.mockClear();
});

describe('FLO-01 — wygaszanie kart po terminie', () => {
  it('500 kart po terminie: jedno żądanie, adres tej samej długości co przy 5 kartach', async () => {
    const small = server({ flo_proposals: staleCards(5) });
    await expireStale(NOW, small.client);

    const proposals = [...staleCards(500), ...untouchableCards()];
    const big = server({ flo_proposals: proposals });
    const expired = await expireStale(NOW, big.client);

    expect(expired).toBe(500);
    expect(big.sent).toHaveLength(1);
    expect(big.sent[0]!.method).toBe('PATCH');
    // Warunek jedzie w zapytaniu, nie lista id — adres nie rośnie z liczbą kart.
    expect(big.sent[0]!.url).toBe(small.sent[0]!.url);
    expect(big.sent[0]!.url.length).toBeLessThan(300);
    expect(new URL(big.sent[0]!.url).searchParams.has('id')).toBe(false);

    const stale = proposals.slice(0, 500);
    expect(stale.every((p) => p.status === 'expired' && p.dismissed_reason === 'auto_expired')).toBe(true);
    const [fresh, dismissed, executing] = proposals.slice(500);
    expect(fresh).toMatchObject({ status: 'open', dismissed_reason: null });
    expect(dismissed).toMatchObject({ status: 'dismissed', dismissed_reason: 'never' });
    expect(executing).toMatchObject({ status: 'executing', dismissed_reason: null });
  });

  it('drugi przebieg niczego już nie zmienia', async () => {
    const proposals = [...staleCards(500), ...untouchableCards()];
    const db = server({ flo_proposals: proposals });
    await expireStale(NOW, db.client);
    const afterFirst = structuredClone(proposals);

    const second = await expireStale(NOW, db.client);

    expect(second).toBe(0);
    expect(proposals).toEqual(afterFirst);
    // Drugi przebieg to to samo jedno żądanie — bez odczytu listy przed zapisem.
    expect(db.sent).toHaveLength(2);
    expect(db.sent[1]).toEqual(db.sent[0]);
  });

  it('1500 kart po terminie — ponad limit 1000 wierszy serwera — gaśnie w jednym przebiegu', async () => {
    const proposals = staleCards(1500);
    const db = server({ flo_proposals: proposals });

    const expired = await expireStale(NOW, db.client);

    expect(expired).toBe(1500);
    expect(proposals.filter((p) => p.status !== 'expired')).toEqual([]);
  });
});

describe('FLO-01 — strażnik kart porzuconych w „wykonuję”', () => {
  it('500 porzuconych kart: jedno żądanie stałej długości, wpis audytu dla każdej, drugi przebieg bez zmian', async () => {
    const small = server({ flo_proposals: stuckCards(5) });
    await runFloTick(undefined, NOW, small.client, noTenants());
    audit.mockClear();

    const busy: Row = {
      id: uuid(4, 1), tenant_id: uuid(9, 1), kind: 'payment.chase',
      status: 'executing', expires_at: FUTURE, approved_at: JUST_NOW, dismissed_reason: null,
    };
    const proposals = [...stuckCards(500), busy];
    const db = server({ flo_proposals: proposals });

    const first = await runFloTick(undefined, NOW, db.client, noTenants());

    expect(first.released).toBe(500);
    const release = releaseRequests(db.sent);
    expect(release).toHaveLength(1);
    expect(release[0]!.method).toBe('PATCH');
    expect(release[0]!.url).toBe(releaseRequests(small.sent)[0]!.url);
    expect(release[0]!.url.length).toBeLessThan(300);
    expect(new URL(release[0]!.url).searchParams.has('id')).toBe(false);

    // Wraca do „zatwierdzona” — człowiek już się zgodził.
    expect(proposals.slice(0, 500).every((p) => p.status === 'approved')).toBe(true);
    // Krótkie wykonanie nietknięte.
    expect(busy.status).toBe('executing');
    // Operator dostaje wpis o KAŻDEJ podniesionej karcie i tylko o nich.
    const logged = audit.mock.calls.map(([entry]) => entry.entityId);
    expect(new Set(logged)).toEqual(new Set(proposals.slice(0, 500).map((p) => p.id)));
    expect(logged).toHaveLength(500);

    audit.mockClear();
    const afterFirst = structuredClone(proposals);
    const second = await runFloTick(undefined, NOW, db.client, noTenants());

    expect(second.released).toBe(0);
    expect(proposals).toEqual(afterFirst);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('FLO-01 — izolacja kroków sprzątania', () => {
  it('awaria wygaszania nie zatrzymuje strażnika ani reguł', async () => {
    const proposals = [...staleCards(1), ...stuckCards(1)];
    const db = server({ flo_proposals: proposals }, isExpire);
    const listTenantIds = vi.fn(async () => []);
    const { ctx, logger } = jobContext();

    const result = await runFloTick(ctx, NOW, db.client, noTenants(listTenantIds));

    // Strażnik zrobił swoje, reguły ruszyły.
    expect(result.released).toBe(1);
    expect(proposals[1]!.status).toBe('approved');
    expect(listTenantIds).toHaveBeenCalledOnce();
    expect(result.rules).toHaveLength(5);

    // Awaria jest widoczna: w wyniku, w logu, w Sentry i w linii operatora.
    expect(result.failedCleanup).toEqual(['expire']);
    expect(result.expired).toBe(0);
    expect(proposals[0]!.status).toBe('open');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('statement timeout'));
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ job: 'flo-tick', step: 'expire' }) }),
    );
    expect(summarizeTick(result)).toContain('wygaszanie padło');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('wygaszanie padło'));
  });

  it('awaria strażnika nie zatrzymuje wygaszania ani reguł', async () => {
    const proposals = [...staleCards(1), ...stuckCards(1)];
    const db = server({ flo_proposals: proposals }, isRelease);
    const listTenantIds = vi.fn(async () => []);
    const { ctx, logger } = jobContext();

    const result = await runFloTick(ctx, NOW, db.client, noTenants(listTenantIds));

    expect(result.expired).toBe(1);
    expect(proposals[0]!.status).toBe('expired');
    expect(listTenantIds).toHaveBeenCalledOnce();
    expect(result.rules).toHaveLength(5);

    expect(result.failedCleanup).toEqual(['release']);
    expect(result.released).toBe(0);
    expect(proposals[1]!.status).toBe('executing');
    expect(audit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('statement timeout'));
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ job: 'flo-tick', step: 'release' }) }),
    );
    expect(summarizeTick(result)).toContain('podnoszenie padło');
  });

  it('udane sprzątanie nie zgłasza awarii', async () => {
    const db = server({ flo_proposals: [...staleCards(2), ...stuckCards(1)] });
    const { ctx, logger } = jobContext();

    const result = await runFloTick(ctx, NOW, db.client, noTenants());

    expect(result.failedCleanup).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    expect(summarizeTick(result)).toBe('wygasłe 2 · podniesione 1');
  });
});
