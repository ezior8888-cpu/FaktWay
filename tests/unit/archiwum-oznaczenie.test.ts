import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Sesja 30 planu skalowania 3000: `cron.archive-old-invoices` oznaczał
 * kandydatki (do 500 na przebieg) PATCH-em z całą listą id w adresie
 * (`id=in.(…)`). UUID po zakodowaniu to 39 znaków, więc 500 id dawało
 * ok. 19,5 tys. znaków. Bramka przed PostgREST-em (Kong na nginx) przyjmuje
 * zwykle najwyżej 8 KB na wiersz żądania, więc oznaczenie padało dopiero PO
 * wgraniu plików do Glacier. Ponowienie (pg-boss wykonuje cały handler od
 * nowa, bez pamięci kroków) wgrywało te same pliki jeszcze raz i znów
 * padało. Archiwum stało.
 *
 * Testy idą przez PRAWDZIWEGO klienta Supabase i prawdziwy `step` workera;
 * atrapą jest serwer (`fetch`) z limitem wiersza żądania jak w bramce oraz
 * magazyny plików (R2, Glacier), więc widać adres, który naprawdę wychodzi
 * z workera.
 */

type Row = Record<string, unknown>;

const m = vi.hoisted(() => ({
  client: null as unknown,
  /** Id faktur w kolejności udanych wgrań do Glacier (z ponowieniami). */
  uploads: [] as string[],
  /** Próby wgrania, także nieudane. */
  uploadAttempts: 0,
  /** Która z kolei próba wgrania ma paść (chwilowy błąd Glacier). */
  failUploadAt: null as number | null,
}));

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => m.client }));
vi.mock('@/lib/storage/r2', () => ({
  downloadInvoiceXml: vi.fn(async () => '<Faktura/>'),
  downloadInvoiceXmlUnchecked: vi.fn(async () => '<Faktura/>'),
}));
vi.mock('@/lib/storage/glacier', () => ({
  // Klucz jak w `lib/storage/glacier.ts`: firma/rok/miesiąc/faktura.
  uploadToGlacier: vi.fn(async (tenantId: string, invoiceId: string, issueDate: string) => {
    m.uploadAttempts += 1;
    if (m.uploadAttempts === m.failUploadAt) throw new Error('SlowDown: Please reduce your request rate.');
    m.uploads.push(invoiceId);
    const [year, month] = issueDate.slice(0, 10).split('-');
    return `${tenantId}/${year}/${month}/${invoiceId}.xml`;
  }),
}));

import type { JobContext } from '@/lib/jobs/registry';
import { runArchiveOldInvoices } from '@/lib/jobs/runners/archive-old-invoices';
import { createJobStep } from '@/lib/jobs/step-shim';

/** Cron o 3:00 w Polsce (CET), więc granica dwóch lat to 2024-11-11. */
const NOW = new Date('2026-11-11T02:00:00.000Z');
const ARCHIVED_AT = '2026-11-11T02:00:00.000Z';
const DELETION_AT = '2034-11-11T23:00:00.000Z';

/** Wiersz żądania ponad ten rozmiar bramka odrzuca (nginx: `large_client_header_buffers 4 8k`). */
const REQUEST_LINE_LIMIT = 8192;
/** Najwięcej id w jednym zapytaniu: wymaganie sesji 30. */
const MAX_IDS_PER_REQUEST = 100;
/** Produkcyjny PostgREST oddaje najwyżej tyle wierszy na odczyt (`PGRST_DB_MAX_ROWS`). */
const MAX_ROWS = 1000;

interface Sent {
  method: string;
  requestLine: string;
  /** Id z filtra `id=in.(…)` albo `id=eq.…`; `null`, gdy żądanie nie wskazuje faktur po id. */
  ids: string[] | null;
  body: Row | null;
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset']);

/** Warunek z adresu: tylko operatory, których używa archiwizacja. */
function condition(column: string, raw: string): (row: Row) => boolean {
  if (raw === 'is.null') return (row) => row[column] == null;
  if (raw === 'not.is.null') return (row) => row[column] != null;
  const dot = raw.indexOf('.');
  const op = raw.slice(0, dot);
  const value = raw.slice(dot + 1);
  switch (op) {
    case 'eq':
      return (row) => row[column] != null && String(row[column]) === value;
    case 'neq':
      return (row) => row[column] != null && String(row[column]) !== value;
    case 'lt':
      return (row) => row[column] != null && String(row[column]) < value;
    case 'in': {
      // UUID nie mają znaków zastrzeżonych, więc lista idzie bez cudzysłowów.
      if (!value.startsWith('(') || !value.endsWith(')') || value.includes('"')) {
        throw new Error(`atrapa PostgREST: nieobsługiwana lista ${raw} (${column})`);
      }
      const list = value.slice(1, -1).split(',');
      return (row) => list.includes(String(row[column]));
    }
    default:
      throw new Error(`atrapa PostgREST: nieobsługiwany operator ${raw} (${column})`);
  }
}

function isMarking(body: Row | null): boolean {
  return body != null && ('archived_at' in body || 'scheduled_deletion_at' in body);
}

function idsOf(filter: string | null): string[] | null {
  if (filter?.startsWith('in.(')) return filter.slice('in.('.length, -1).split(',');
  if (filter?.startsWith('eq.')) return [filter.slice('eq.'.length)];
  return null;
}

/**
 * Bramka i PostgREST w pamięci. Za długi wiersz żądania dostaje 414 ze
 * stroną HTML, zanim cokolwiek dotrze do bazy. Zapis jest atomowy: zapytanie,
 * które pada, nie zmienia żadnego wiersza.
 */
function server(tables: Record<string, Row[]>) {
  const sent: Sent[] = [];
  let markings = 0;
  const srv = {
    sent,
    /** Które z kolei zapytanie oznaczające (`archived_at` / `scheduled_deletion_at`) ma paść. */
    failMarking: null as number | null,
    /** Wołane przed obsługą każdego żądania, np. gdy inny przebieg zmienia wiersz w tym czasie. */
    onRequest: null as ((table: string, url: URL) => void) | null,
    client: null as unknown,
  };
  srv.client = createClient('https://database.example.invalid', 'synthetic-local-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        const requestLine = `${method} ${url.pathname}${url.search} HTTP/1.1`;
        const ids = idsOf(url.searchParams.get('id'));
        const body = typeof init?.body === 'string' && init.body !== '' ? (JSON.parse(init.body) as Row) : null;
        sent.push({ method, requestLine, ids, body });

        if (requestLine.length > REQUEST_LINE_LIMIT) {
          return new Response('<html><head><title>414 Request-URI Too Large</title></head></html>', {
            status: 414,
            headers: { 'content-type': 'text/html' },
          });
        }

        const table = url.pathname.replace(/^\/rest\/v1\//, '');
        const rows = (tables[table] ??= []);
        srv.onRequest?.(table, url);
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

        if (method === 'GET') {
          const limit = Math.min(Number(url.searchParams.get('limit') ?? MAX_ROWS), MAX_ROWS);
          const columns = url.searchParams.get('select')?.split(',').map((c) => c.trim());
          const page = matching.slice(0, limit).map((row) =>
            !columns || columns.includes('*')
              ? { ...row }
              : Object.fromEntries(columns.map((c) => [c, row[c] ?? null])),
          );
          return Response.json(page);
        }

        if (method === 'PATCH' && body) {
          if (isMarking(body)) {
            markings += 1;
            if (markings === srv.failMarking) {
              return Response.json(
                { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null },
                { status: 500 },
              );
            }
          }
          for (const row of matching) Object.assign(row, body);
          return new Response(null, { status: 204 });
        }

        return Response.json(
          { code: 'PGRST000', message: `atrapa PostgREST: nieobsługiwane ${method} ${table}`, details: null, hint: null },
          { status: 400 },
        );
      },
    },
  });
  return srv;
}

const uuid = (group: number, n: number) =>
  `${String(group).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

function invoice(id: string, tenant: number, fields: Row): Row {
  const tenantId = uuid(9, tenant);
  return {
    id,
    tenant_id: tenantId,
    issue_date: '2021-03-15',
    xml_storage_path: `${tenantId}/2021/03/${id}.xml`,
    origin: 'app',
    archived_at: null,
    archive_storage_path: null,
    scheduled_deletion_at: null,
    ...fields,
  };
}

/**
 * `count` faktur do archiwizacji i obok nich faktury, których przebieg nie
 * może ruszyć: świeża, z dniem granicy, z historii KSeF, bez XML i już
 * zarchiwizowana.
 */
function scenario(count: number) {
  const candidates = Array.from({ length: count }, (_, i) => invoice(uuid(1, i + 1), i % 7, {}));
  const others = [
    invoice(uuid(2, 1), 1, { issue_date: '2025-06-30', xml_storage_path: `${uuid(9, 1)}/2025/06/${uuid(2, 1)}.xml` }),
    invoice(uuid(2, 2), 1, { issue_date: '2024-11-11', xml_storage_path: `${uuid(9, 1)}/2024/11/${uuid(2, 2)}.xml` }),
    invoice(uuid(2, 3), 2, { origin: 'ksef_import' }),
    invoice(uuid(2, 4), 2, { xml_storage_path: null }),
    invoice(uuid(2, 5), 3, {
      archived_at: '2025-11-11T02:00:00.000Z',
      archive_storage_path: `${uuid(9, 3)}/2021/03/${uuid(2, 5)}.xml`,
      scheduled_deletion_at: '2033-11-11T02:00:00.000Z',
    }),
  ];
  const rows = [...others.slice(0, 2), ...candidates, ...others.slice(2)];
  const candidateIds = new Set(candidates.map((r) => String(r.id)));
  return {
    tables: { invoices: rows, xml_documents: [] as Row[] } as Record<string, Row[]>,
    candidateIds,
    /** Stan po udanym przebiegu: tak samo jak przy oznaczeniu jednym zapytaniem. */
    expected: rows.map((row): Row =>
      candidateIds.has(String(row.id))
        ? {
            ...row,
            archive_storage_path: `${row.tenant_id}/2021/03/${row.id}.xml`,
            archived_at: ARCHIVED_AT,
            scheduled_deletion_at: DELETION_AT,
          }
        : { ...row },
    ),
  };
}

function context(): JobContext {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { step: createJobStep(logger), logger, attempt: 0 };
}

/** Id z zapytań oznaczających daną kolumnę, w kolejności wysłania. */
function markedIds(sent: Sent[], column: string): string[] {
  return sent.filter((s) => s.method === 'PATCH' && s.body && column in s.body).flatMap((s) => s.ids ?? []);
}

/** Kandydatki, których przebieg jeszcze nie oznaczył. */
function unmarked(tables: Record<string, Row[]>, candidateIds: Set<string>): number {
  return tables.invoices.filter((r) => candidateIds.has(String(r.id)) && r.archived_at == null).length;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  m.uploads = [];
  m.uploadAttempts = 0;
  m.failUploadAt = null;
});

afterEach(() => {
  vi.useRealTimers();
});

// 500 kandydatek to ok. 1000 żądań przez prawdziwego klienta: na ciepło
// ok. 0,1 s, ale na zimno, pod obciążeniem, raz przekroczyło domyślne 5 s.
describe('archiwizacja starych faktur: oznaczenie bez listy id w adresie (sesja 30)', { timeout: 30_000 }, () => {
  it('500 kandydatek: każde zapytanie ma najwyżej 100 id i mieści się w wierszu żądania bramki', async () => {
    const { tables, candidateIds } = scenario(500);
    const srv = server(tables);
    m.client = srv.client;

    await expect(runArchiveOldInvoices(context())).resolves.toEqual({ archived: 500 });

    expect(srv.sent.filter((s) => s.requestLine.length > REQUEST_LINE_LIMIT).map((s) => s.requestLine.length)).toEqual([]);
    expect(srv.sent.filter((s) => (s.ids?.length ?? 0) > MAX_IDS_PER_REQUEST).map((s) => s.ids!.length)).toEqual([]);
    // Zapis znaczników zawsze wskazuje faktury po id, nigdy samymi warunkami.
    expect(srv.sent.filter((s) => s.method === 'PATCH' && isMarking(s.body) && s.ids === null)).toEqual([]);
    // Każda kandydatka dokładnie raz w zapytaniach oznaczających, żadna obca.
    const wanted = [...candidateIds].sort();
    expect(markedIds(srv.sent, 'archived_at').sort()).toEqual(wanted);
    expect(markedIds(srv.sent, 'scheduled_deletion_at').sort()).toEqual(wanted);
    // Każdy plik wgrany raz: przebieg nie padł i nie było ponowienia.
    expect(m.uploads).toHaveLength(500);
  });

  // 208 i 209: granica dawnego zapisu z listą id w adresie (wiersz żądania
  // ma 42 + 39·n znaków, od 209 ponad 8192); 500: limit kandydatek na przebieg.
  it.each([0, 1, 208, 209, 500])(
    '%i kandydatek: stan faktur po przebiegu taki jak przy oznaczeniu jednym zapytaniem',
    async (count) => {
      const { tables, expected } = scenario(count);
      const srv = server(tables);
      m.client = srv.client;

      await expect(runArchiveOldInvoices(context())).resolves.toEqual({ archived: count });

      expect(tables.invoices).toEqual(expected);
    },
  );

  it('zapis znaczników pada w trakcie przebiegu: żadna faktura nie ma `archived_at` bez daty usunięcia, a ponowienie od zera kończy archiwum', async () => {
    const { tables, candidateIds, expected } = scenario(150);
    const srv = server(tables);
    m.client = srv.client;
    srv.failMarking = 2;

    await expect(runArchiveOldInvoices(context())).rejects.toThrow(/statement timeout/);

    // `cron.retention-delete` szuka faktur tylko po `scheduled_deletion_at`:
    // zarchiwizowana bez tej daty nie zostałaby nigdy usunięta, a następny
    // przebieg archiwizacji już jej nie wybierze (ma `archived_at`).
    const withoutDeletion = tables.invoices.filter((r) => r.archived_at != null && r.scheduled_deletion_at == null);
    expect(withoutDeletion.map((r) => r.id)).toEqual([]);

    // Ponowienie pg-boss: cały handler od nowa, bez pamięci kroków.
    srv.failMarking = null;
    const uploadedBefore = m.uploads.length;
    const left = unmarked(tables, candidateIds);
    await expect(runArchiveOldInvoices(context())).resolves.toEqual({ archived: left });

    expect(tables.invoices).toEqual(expected);
    // Drugi raz wgrane tylko te, których nie oznaczono.
    expect(m.uploads).toHaveLength(uploadedBefore + left);
  });

  it('wgranie do Glacier pada w trakcie przebiegu: wgrane faktury są już oznaczone, a ponowienie nie wgrywa ich drugi raz', async () => {
    const { tables, candidateIds, expected } = scenario(150);
    const srv = server(tables);
    m.client = srv.client;
    m.failUploadAt = 100;

    await expect(runArchiveOldInvoices(context())).rejects.toThrow(/SlowDown/);

    // Kopia w Glacier bez znaczników to faktura, którą każde ponowienie
    // i każdy następny przebieg wgrałby od nowa.
    const copiedNotMarked = tables.invoices.filter((r) => r.archive_storage_path != null && r.archived_at == null);
    expect(copiedNotMarked.map((r) => r.id)).toEqual([]);
    const withoutDeletion = tables.invoices.filter((r) => r.archived_at != null && r.scheduled_deletion_at == null);
    expect(withoutDeletion.map((r) => r.id)).toEqual([]);

    // Ponowienie pg-boss: cały handler od nowa, bez pamięci kroków.
    m.failUploadAt = null;
    const left = unmarked(tables, candidateIds);
    await expect(runArchiveOldInvoices(context())).resolves.toEqual({ archived: left });

    expect(tables.invoices).toEqual(expected);
    // Każdy plik wgrany dokładnie raz, mimo ponowienia.
    expect(m.uploads).toHaveLength(150);
    expect(new Set(m.uploads).size).toBe(150);
  });

  it('faktura oznaczona w tym czasie przez inny przebieg zachowuje jego znaczniki', async () => {
    const { tables, expected } = scenario(3);
    const srv = server(tables);
    m.client = srv.client;
    const id = uuid(1, 2);
    const row = tables.invoices.find((r) => r.id === id)!;
    const otherRun = {
      archive_storage_path: `${row.tenant_id}/2021/03/${id}.xml`,
      archived_at: '2026-11-11T01:30:00.000Z',
      scheduled_deletion_at: '2034-11-11T01:30:00.000Z',
    };
    // Inny przebieg oznacza fakturę, zanim ten dojdzie do jej zapisu.
    srv.onRequest = (table, url) => {
      if (table === 'xml_documents' && url.searchParams.get('invoice_id') === `eq.${id}`) Object.assign(row, otherRun);
    };

    await expect(runArchiveOldInvoices(context())).resolves.toEqual({ archived: 3 });

    expect(tables.invoices).toEqual(expected.map((r) => (r.id === id ? { ...r, ...otherRun } : r)));
  });
});
