import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import { createAdminClient } from '@/lib/supabase/server';

import { buildSnapshotKey, uploadSnapshot, type SnapshotKey } from './r2-backup-client';
import { MAX_SNAPSHOT_JSON_BYTES, SKIP_TABLES, snapshotKeyFor } from './snapshot-tables';

/**
 * Wiersze na stronę odczytu. Poniżej produkcyjnego PGRST_DB_MAX_ROWS (1000),
 * a kopia i tak czyta do pustej strony, więc niższy limit serwera niczego
 * nie gubi.
 */
export const SNAPSHOT_PAGE_SIZE = 500;

/**
 * Układ pliku: poprawny JSON (ten sam kształt co dawniej), ale jedna linia na
 * wiersz tabeli, żeby weryfikacja mogła czytać plik strumieniem
 * (`lib/backup/verify.ts`):
 *
 * ```
 * {"version":1,"created_at":"…","kind":"daily","layout":"line-per-row","tables":{
 * "contractors":[
 * {…}
 * ,{…}
 * ]
 * ,"invoices":[
 * …
 * ]
 * },"row_counts":{"contractors":2,…}}
 * ```
 *
 * `JSON.stringify` zamienia znak nowej linii w napisie na `\n`, więc bajt
 * 0x0A występuje w pliku tylko na końcu linii.
 */
export const SNAPSHOT_LAYOUT = 'line-per-row';

type Row = Record<string, unknown>;

interface PgError {
  message: string;
  code?: string;
}

interface PageResponse {
  data: Row[] | null;
  error: PgError | null;
}

/** Tyle z zapytania PostgREST, ile używa odczyt stronami. */
interface PageQuery extends PromiseLike<PageResponse> {
  order(column: string, options: { ascending: boolean }): PageQuery;
  gt(column: string, value: string): PageQuery;
  gte(column: string, value: string): PageQuery;
  or(filters: string): PageQuery;
  limit(count: number): PageQuery;
}

export interface SnapshotReadClient {
  from(table: string): { select(columns: '*'): PageQuery };
}

interface AdminRpc {
  rpc: (
    fn: 'list_public_tables',
    args?: Record<string, never>,
  ) => Promise<{
    data: Array<{ table_name: string }> | null;
    error: { message: string } | null;
  }>;
}

/** Kopia zapisana i wgrana. */
export interface SnapshotResult {
  complete: true;
  /** Pełny R2 key, np. backups/db/2026/05/15-020000.json.gz */
  r2KeyFull: string;
  /** Relative — do zapisu w backup_log.r2_key */
  r2KeyRelative: string;
  /** Rozmiar spakowanego pliku. */
  sizeBytes: number;
  checksum: string;
  rowCounts: Record<string, number>;
  /** Bajty JSON-a przed spakowaniem (to liczy bezpiecznik rozmiaru). */
  jsonBytes: number;
  durationMs: number;
}

/** Kopia przerwana przez bezpiecznik rozmiaru: nic nie zostało wgrane. */
export interface SnapshotIncomplete {
  complete: false;
  reason: 'size_limit';
  limitBytes: number;
  /** Bajty JSON-a w chwili przerwania (pierwsza linia ponad progiem). */
  jsonBytes: number;
  stoppedAtTable: string;
  /** Tabele zapisane w całości przed przerwaniem. */
  tablesDone: number;
  tablesTotal: number;
  durationMs: number;
}

export type SnapshotOutcome = SnapshotResult | SnapshotIncomplete;

/**
 * Tworzy snapshot JSON tabel `public` (warstwa C, runbook
 * `docs/runbooks/backup-restore.md` § 6): listuje tabele, czyta każdą stronami
 * po kluczu, pisze linię po linii przez strumień gzip (w puli wątków, nie
 * w pętli zdarzeń), liczy SHA-256 w locie i wgrywa plik.
 *
 * W pamięci workera jest jedna strona wierszy i spakowany plik czekający na
 * wgranie. Bezpiecznik (`MAX_SNAPSHOT_JSON_BYTES`, JOB-02) przerywa kopię,
 * gdy JSON przekroczy próg: wynik `complete: false`, nic nie jest wgrywane,
 * a nocny job wysyła jeden alarm zamiast wywracać worker.
 *
 * `beforeUpload` dostaje klucz pliku tuż przed wgraniem (nocny job zapisuje
 * go w `backup_log`, żeby plik nigdy nie był sierotą).
 */
export async function createDbSnapshot(opts: {
  kind: 'daily' | 'weekly' | 'manual';
  now?: Date;
  beforeUpload?: (key: SnapshotKey) => Promise<void>;
}): Promise<SnapshotOutcome> {
  const start = Date.now();
  const now = opts.now ?? new Date();
  const limitBytes = MAX_SNAPSHOT_JSON_BYTES;

  const admin = createAdminClient();
  const tables = (await listPublicTables(admin as unknown as AdminRpc)).filter((t) => !SKIP_TABLES.has(t));
  const client = admin as unknown as SnapshotReadClient;

  const out = new GzipCollector();
  let closed = false;
  let jsonBytes = 0;
  let pending = '';
  const add = (line: string) => {
    pending += line;
    jsonBytes += Buffer.byteLength(line, 'utf8');
  };
  const flush = async () => {
    if (pending.length === 0) return;
    await out.write(pending);
    pending = '';
  };

  try {
    const header = JSON.stringify({ version: 1, created_at: now.toISOString(), kind: opts.kind, layout: SNAPSHOT_LAYOUT });
    add(`${header.slice(0, -1)},"tables":{\n`);

    const rowCounts: Record<string, number> = {};
    for (const [index, table] of tables.entries()) {
      add(`${index === 0 ? '' : ','}${JSON.stringify(table)}:[\n`);
      let count = 0;
      for await (const page of readTablePages(client, table)) {
        for (const row of page) {
          add(`${count === 0 ? '' : ','}${JSON.stringify(row)}\n`);
          count += 1;
          if (jsonBytes > limitBytes) {
            return {
              complete: false,
              reason: 'size_limit',
              limitBytes,
              jsonBytes,
              stoppedAtTable: table,
              tablesDone: index,
              tablesTotal: tables.length,
              durationMs: Date.now() - start,
            };
          }
        }
        await flush();
      }
      add(']\n');
      rowCounts[table] = count;
    }
    add(`},"row_counts":${JSON.stringify(rowCounts)}}\n`);
    await flush();

    const { body, checksum } = await out.close();
    closed = true;

    const keys = buildSnapshotKey(now);
    await opts.beforeUpload?.(keys);
    await uploadSnapshot(keys.full, body, checksum);

    return {
      complete: true,
      r2KeyFull: keys.full,
      r2KeyRelative: keys.relative,
      sizeBytes: body.length,
      checksum,
      rowCounts,
      jsonBytes,
      durationMs: Date.now() - start,
    };
  } finally {
    if (!closed) out.abort();
  }
}

async function listPublicTables(admin: AdminRpc): Promise<string[]> {
  const { data, error } = await admin.rpc('list_public_tables');
  if (error || !data) {
    throw new Error(
      `list_public_tables RPC failed: ${error?.message ?? 'no_data'}`,
    );
  }
  return data.map((r) => r.table_name).sort();
}

/**
 * Czyta tabelę stronami po kluczu (keyset, QAL-01): `ORDER BY klucz`
 * i „większy niż ostatni klucz poprzedniej strony”, do pustej strony.
 *
 * OFFSET bez ORDER BY nie obiecuje kolejności między zapytaniami, więc gdy
 * tabela zmieniała się w trakcie, wiersze wypadały albo się powtarzały. Tu
 * każdy wiersz istniejący przez cały odczyt trafia do kopii dokładnie raz,
 * a dopisany w trakcie trafia, gdy jego klucz jest za kursorem. Klucz musi być
 * unikalny (strażnik `SNAPSHOT_KEYS` w testach). Kopia nie jest migawką
 * z jednej chwili: tabele i strony czytane są po kolei.
 *
 * Nie `forEachPageById` (`lib/pagination/keyset.ts`): tamten zna tylko `id`
 * typu uuid i sprawdza kolejność porównaniem napisów w JS. Tu klucze bywają
 * złożone, liczbowe i tekstowe z kolacją bazy (`stripe_webhook_events.id`),
 * więc pętla pilnuje tylko, że kursor się przesuwa. Reszta zasad ta sama:
 * błąd strony albo `data: null` to wyjątek, koniec tylko na pustej stronie.
 */
export async function* readTablePages(
  client: SnapshotReadClient,
  table: string,
  key: readonly string[] = snapshotKeyFor(table),
  pageSize: number = SNAPSHOT_PAGE_SIZE,
): AsyncGenerator<Row[], void, undefined> {
  let cursor: string[] | null = null;
  for (;;) {
    let query = client.from(table).select('*');
    for (const column of key) query = query.order(column, { ascending: true });
    if (cursor) query = afterCursor(query, key, cursor);
    const { data, error } = await query.limit(pageSize);
    if (error) throw new Error(readErrorMessage(table, key, error));
    // `data: null` bez błędu (np. odpowiedź 200 z pustą treścią od pośrednika)
    // to nie pusta strona: nie wiadomo, czy tabela się skończyła.
    if (!Array.isArray(data)) {
      throw new Error(`dump_table_failed: ${table}: odpowiedź bez danych i bez błędu, nie wiadomo, czy to koniec tabeli`);
    }
    if (data.length === 0) return;

    let previous: string[] | null = cursor;
    for (const [i, row] of data.entries()) {
      const values = keyValues(table, key, row);
      // Ten sam klucz dwa razy pod rząd: filtr „większy niż” nie zadziałał
      // albo klucz nie jest unikalny. Dalej kopia gubiłaby albo dublowała wiersze.
      if (previous && previous.every((v, j) => v === values[j])) {
        throw new Error(
          i === 0
            ? `dump_table_failed: ${table}: kursor stoi w miejscu na kluczu (${key.join(', ')})`
            : `dump_table_failed: ${table}: klucz kopii (${key.join(', ')}) nie jest unikalny`,
        );
      }
      previous = values;
    }
    cursor = previous;
    yield data;
  }
}

/** `(k1, k2, …) > (v1, v2, …)`: PostgREST nie porównuje krotek, więc rozpisane na OR. */
function afterCursor(query: PageQuery, key: readonly string[], cursor: readonly string[]): PageQuery {
  if (key.length === 1) return query.gt(key[0]!, cursor[0]!);
  const branches = key.map((column, i) => {
    const greater = `${column}.gt.${quote(cursor[i]!)}`;
    if (i === 0) return greater;
    const equal = key.slice(0, i).map((c, j) => `${c}.eq.${quote(cursor[j]!)}`);
    return `and(${[...equal, greater].join(',')})`;
  });
  // `gte` na pierwszej kolumnie daje Postgresowi punkt startu w indeksie klucza.
  return query.gte(key[0]!, cursor[0]!).or(branches.join(','));
}

/** Wartość w filtrze `or` PostgREST: w cudzysłowie, `\` i `"` poprzedzone `\`. */
function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function keyValues(table: string, key: readonly string[], row: Row): string[] {
  return key.map((column) => {
    const value = row[column];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    // Bez wartości w treści błędu: trafia do backup_log i na Slacka.
    throw new Error(
      `dump_table_failed: ${table}: kolumna klucza kopii ${column} ma ${value === null || value === undefined ? 'pustą wartość' : `typ ${typeof value}`}`,
    );
  });
}

function readErrorMessage(table: string, key: readonly string[], error: PgError): string {
  if (error.code === '42703') {
    return (
      `dump_table_failed: ${table}: brak kolumny klucza kopii (${key.join(', ')}). ` +
      'Dopisz tabelę do SNAPSHOT_KEYS (lib/backup/snapshot-tables.ts) z kluczem głównym albo do SKIP_TABLES.'
    );
  }
  return `dump_table_failed: ${table}: ${error.message}`;
}

/** Strumień gzip z SHA-256 liczonym w locie; spakowane bajty czekają w pamięci na wgranie. */
class GzipCollector {
  private readonly gzip = createGzip();
  private readonly chunks: Buffer[] = [];
  private readonly hash = createHash('sha256');
  private readonly ended: Promise<void>;

  constructor() {
    this.gzip.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.hash.update(chunk);
    });
    this.ended = finished(this.gzip);
    // Błąd odbiera `write` albo `close`; po `abort` nikt na niego nie czeka.
    this.ended.catch(() => undefined);
  }

  async write(text: string): Promise<void> {
    // Po błędzie strumienia `drain` już nie przyjdzie, a `error` już był.
    if (this.gzip.errored) throw this.gzip.errored;
    if (!this.gzip.write(Buffer.from(text, 'utf8'))) await once(this.gzip, 'drain');
  }

  async close(): Promise<{ body: Buffer; checksum: string }> {
    this.gzip.end();
    await this.ended;
    const body = Buffer.concat(this.chunks);
    // Bez tego kawałki żyją obok `body` przez całe wgrywanie (dwie kopie pliku).
    this.chunks.length = 0;
    return { body, checksum: this.hash.digest('hex') };
  }

  abort(): void {
    this.gzip.destroy();
    this.chunks.length = 0;
  }
}
