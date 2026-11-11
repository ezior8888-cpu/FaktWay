import { createHash } from 'node:crypto';
import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

import { createAdminClient } from '@/lib/supabase/server';

import { SNAPSHOT_LAYOUT } from './db-snapshot';
import { openSnapshotStream } from './r2-backup-client';
import { MAX_SNAPSHOT_LINE_BYTES } from './snapshot-tables';

/**
 * Weryfikacja integralności snapshotu (Faza 29 Krok 4).
 *
 * Robi 3 sprawdzenia:
 *   1. Checksum — liczymy SHA-256 pobieranego pliku i porównujemy
 *      z `backup_log.checksum`. Bit-rot detection.
 *   2. Odczyt — gunzip i parsowanie linia po linii (układ pliku:
 *      `SNAPSHOT_LAYOUT` w `db-snapshot.ts`), liczba wierszy każdej tabeli
 *      zgodna ze stopką pliku i z `backup_log.row_counts`. Wykrywa plik
 *      ucięty, uszkodzony albo niepełny.
 *   3. Sample row counts — porównanie row_counts ze snapshotu z bieżącym
 *      stanem DB. Pozwala wykryć: czy snapshot nie jest podejrzanie pusty
 *      (czyli czy ostatnio nie sypnęło się z RLS / connectivity).
 *
 * Plik idzie strumieniem (CPU-V2, plan skalowania, sesja 12): w pamięci jest
 * najwyżej jedna linia, a nie cały plik i cały JSON naraz. Linia dłuższa niż
 * `MAX_SNAPSHOT_LINE_BYTES` jest liczona bez parsowania, z ostrzeżeniem. Stara
 * kopia jednoliniowa (sprzed sesji 12) jest parsowana w całości, gdy mieści
 * się w tym limicie, a inaczej sprawdzana tylko sumą kontrolną. Komunikaty
 * błędów idą na Slacka, więc nie niosą treści wierszy.
 *
 * `tolerancePercent` (default 50%) — bieżący DB może mieć ±50% rows
 * względem snapshotu z 24h temu i to OK. Większe odchyły = alert.
 */

export interface VerifyResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** Per-table porównanie: snapshot vs current. */
  rowCountDiff: Array<{
    table: string;
    snapshot: number;
    current: number;
    diffPct: number;
  }>;
}

interface VerifyInput {
  /** R2 key (relative, np. `db/2026/05/15-020000.json.gz`). */
  r2KeyRelative: string;
  expectedChecksum: string;
  /** Wartość z `backup_log.row_counts`. */
  snapshotRowCounts: Record<string, number>;
  /** % różnicy wobec bieżącego stanu wybierającej alert. Default 50. */
  tolerancePercent?: number;
}

interface AdminCountClient {
  from: (n: string) => {
    select: (
      c: string,
      opts: { count: 'exact'; head: true },
    ) => Promise<{ count: number | null; error: { message: string } | null }>;
  };
}

export async function verifySnapshot(input: VerifyInput): Promise<VerifyResult> {
  const tolerance = input.tolerancePercent ?? 50;
  const errors: string[] = [];
  const warnings: string[] = [];

  // Pełny key — `r2KeyRelative` jest bez prefixu, build snapshot key już go
  // dodaje. Tu rekonstruujemy: prefix obliczony jak w r2-backup-client.
  const ctxPrefix =
    process.env.R2_BACKUPS_BUCKET?.trim() &&
    !process.env.R2_BACKUPS_BUCKET.startsWith('x')
      ? ''
      : 'backups/';
  const fullKey = `${ctxPrefix}${input.r2KeyRelative}`;

  // 1–2. Pobranie strumieniem: suma kontrolna i odczyt linia po linii.
  const checker = new SnapshotChecker(MAX_SNAPSHOT_LINE_BYTES);
  let read: ReadOutcome;
  try {
    read = await readSnapshot(await openSnapshotStream(fullKey), checker);
  } catch (err) {
    read = { checksum: null, downloadError: errorText(err), unpackError: null };
  }
  if (read.downloadError !== null) {
    return { ok: false, errors: [`download_failed: ${read.downloadError}`], warnings: [], rowCountDiff: [] };
  }

  if (read.checksum !== input.expectedChecksum) {
    errors.push(
      `checksum_mismatch: expected=${input.expectedChecksum.slice(0, 8)}… actual=${(read.checksum ?? '').slice(0, 8)}…`,
    );
  }
  if (checker.error) errors.push(checker.error);
  if (read.unpackError !== null) errors.push(`parse_failed: gzip: ${read.unpackError}`);
  if (!checker.error && read.unpackError === null && !checker.complete && !checker.legacyNotParsed) {
    errors.push('parse_failed: odczyt nie doszedł do końca pliku');
  }
  if (!checker.complete && !checker.legacyNotParsed) {
    return { ok: false, errors, warnings: [], rowCountDiff: [] };
  }

  warnings.push(...checker.warnings());
  if (checker.complete) errors.push(...rowCountMismatches(checker, input.snapshotRowCounts));

  // 3. Sample row count comparison. `*`, bo nie każda tabela ma kolumnę `id`.
  const admin = createAdminClient() as unknown as AdminCountClient;
  const diff: VerifyResult['rowCountDiff'] = [];
  for (const [table, snapshotCount] of Object.entries(input.snapshotRowCounts)) {
    try {
      const { count, error } = await admin
        .from(table)
        .select('*', { count: 'exact', head: true });
      if (error) {
        warnings.push(`count_failed:${table}:${error.message}`);
        continue;
      }
      const current = count ?? 0;
      const diffPct =
        snapshotCount === 0
          ? current === 0
            ? 0
            : 100
          : Math.abs((current - snapshotCount) / snapshotCount) * 100;
      diff.push({ table, snapshot: snapshotCount, current, diffPct });
      if (diffPct > tolerance) {
        warnings.push(
          `row_count_drift:${table}:snapshot=${snapshotCount} current=${current} diff=${diffPct.toFixed(0)}%`,
        );
      }
    } catch (err) {
      warnings.push(
        `count_exception:${table}:${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    rowCountDiff: diff,
  };
}

/** Wiersze policzone w pliku vs stopka pliku vs `backup_log.row_counts`. */
function rowCountMismatches(checker: SnapshotChecker, fromLog: Record<string, number>): string[] {
  const log = new Map(Object.entries(fromLog));
  const names = new Set([...checker.counted.keys(), ...checker.trailer.keys(), ...log.keys()]);
  const mismatches: string[] = [];
  for (const name of [...names].sort()) {
    const inFile = checker.counted.get(name);
    const inTrailer = checker.trailer.get(name);
    // Wpis bez row_counts (nie powinien się zdarzyć) nie ma czego porównać.
    const inLog = log.size > 0 ? log.get(name) : inFile;
    if (inFile !== inTrailer || inFile !== inLog) {
      mismatches.push(
        `row_count_mismatch: ${name}: plik=${inFile ?? 'brak'} stopka=${inTrailer ?? 'brak'} backup_log=${log.size > 0 ? (inLog ?? 'brak') : 'brak danych'}`,
      );
    }
  }
  return mismatches;
}

interface ReadOutcome {
  /** SHA-256 całego pobranego pliku; null, gdy pobieranie się urwało. */
  checksum: string | null;
  downloadError: string | null;
  /** Błąd rozpakowania (zlib). Suma kontrolna i tak jest liczona do końca pliku. */
  unpackError: string | null;
}

/**
 * Pobiera plik do końca, licząc sumę kontrolną, i równolegle rozpakowuje go do
 * `checker`. Gdy gunzip padnie w środku pliku (bit-rot), pobieranie i suma idą
 * dalej, żeby raport mówił, czy plik zmienił się po zapisie.
 */
async function readSnapshot(body: Readable, checker: SnapshotChecker): Promise<ReadOutcome> {
  const hash = createHash('sha256');
  const gunzip = createGunzip();
  let unpackError: unknown = null;
  const unpacked = pipeline(gunzip, checker).catch((err: unknown) => {
    unpackError = err;
  });
  const unpacking = () => unpackError === null && !gunzip.destroyed;

  try {
    for await (const chunk of body) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      if (unpacking() && !gunzip.write(bytes)) await drainOrClose(gunzip);
    }
  } catch (err) {
    gunzip.destroy();
    await unpacked;
    return { checksum: null, downloadError: errorText(err), unpackError: null };
  }
  if (unpacking()) gunzip.end();
  await unpacked;
  return {
    checksum: hash.digest('hex'),
    downloadError: null,
    unpackError: unpackError === null ? null : errorText(unpackError),
  };
}

/** Czeka, aż gunzip przyjmie dalsze dane albo się zamknie (po błędzie). */
function drainOrClose(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      stream.off('drain', done);
      stream.off('close', done);
      resolve();
    };
    stream.on('drain', done);
    stream.on('close', done);
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

const NEWLINE = 0x0a;
const COMMA = 0x2c;
const BRACE_OPEN = 0x7b;
const BRACE_CLOSE = 0x7d;
const HEADER_END = ',"tables":{';
const TRAILER_START = '},"row_counts":';

/** `JSON.parse` nigdy nie zwraca `undefined`, więc to znak „nieczytelne”. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCountMap(value: unknown): value is Record<string, number> {
  return isObject(value) && Object.values(value).every((v) => Number.isInteger(v) && (v as number) >= 0);
}

function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

type CheckerState = 'header' | 'table' | 'rows' | 'end' | 'broken';

/**
 * Odbiera rozpakowany plik i sprawdza jego układ linia po linii: nagłówek,
 * dla każdej tabeli `"nazwa":[`, wiersze `{…}` / `,{…}`, `]`, na końcu stopka
 * `},"row_counts":{…}}`. Nigdy nie zgłasza błędu strumienia: pierwszy błąd
 * formatu zapisuje w `error` (bez treści linii), a resztę pliku tylko
 * przepuszcza, żeby suma kontrolna objęła cały plik.
 */
class SnapshotChecker extends Writable {
  /** Pierwszy błąd formatu, gotowy do raportu. */
  error: string | null = null;
  /** Plik przeczytany do stopki bez błędu (albo stara kopia sparsowana w całości). */
  complete = false;
  /** Stara kopia jednoliniowa ponad limitem: sprawdzona tylko suma kontrolna. */
  legacyNotParsed = false;
  /** Wiersze policzone w pliku, per tabela. */
  readonly counted = new Map<string, number>();
  /** Liczby wierszy ze stopki pliku. */
  trailer = new Map<string, number>();

  private state: CheckerState = 'header';
  private lineNo = 0;
  private parts: Buffer[] = [];
  private partBytes = 0;
  private oversized = false;
  /** Pierwsze dwa i ostatni bajt bieżącej linii (do sprawdzenia linii ponad limitem). */
  private head: number[] = [];
  private last = -1;
  private table = '';
  private tableIndex = 0;
  private rowIndex = 0;
  private readonly unparsed = new Map<string, number>();

  constructor(private readonly maxLineBytes: number) {
    super();
  }

  warnings(): string[] {
    const list = [...this.unparsed].map(
      ([table, n]) => `row_not_parsed: ${table}: ${n} wiersz(y) dłuższe niż ${sizeText(this.maxLineBytes)}, policzone bez sprawdzenia treści`,
    );
    if (this.legacyNotParsed) {
      list.push(
        `legacy_snapshot_not_parsed: stara kopia jednoliniowa dłuższa niż ${sizeText(this.maxLineBytes)}, sprawdzona tylko suma kontrolna`,
      );
    }
    return list;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(NEWLINE, start);
        const end = newline === -1 ? chunk.length : newline;
        if (end > start) this.append(chunk.subarray(start, end));
        if (newline === -1) break;
        this.endLine();
        start = newline + 1;
      }
    } catch {
      this.fail('błąd weryfikatora przy odczycie linii');
    }
    callback();
  }

  override _final(callback: (error?: Error | null) => void): void {
    try {
      this.endOfFile();
    } catch {
      this.fail('błąd weryfikatora na końcu pliku');
    }
    callback();
  }

  private append(piece: Buffer): void {
    for (let i = 0; this.head.length < 2 && i < piece.length; i++) this.head.push(piece[i]!);
    this.last = piece[piece.length - 1]!;
    if (this.oversized) return;
    if (this.partBytes + piece.length > this.maxLineBytes) {
      this.oversized = true;
      this.parts = [];
      this.partBytes = 0;
      return;
    }
    this.parts.push(piece);
    this.partBytes += piece.length;
  }

  private endLine(): void {
    this.lineNo += 1;
    if (this.state !== 'broken') {
      if (this.oversized) this.oversizedLine();
      else this.line(Buffer.concat(this.parts, this.partBytes).toString('utf8'));
    }
    this.parts = [];
    this.partBytes = 0;
    this.oversized = false;
    this.head = [];
    this.last = -1;
  }

  private fail(reason: string): void {
    this.error ??= `parse_failed: ${reason}`;
    this.state = 'broken';
  }

  private line(text: string): void {
    switch (this.state) {
      case 'header':
        return this.headerLine(text);
      case 'table':
        return this.tableOrTrailerLine(text);
      case 'rows':
        return this.rowLine(text);
      case 'end':
        return this.fail(`linia ${this.lineNo}: dane po stopce pliku`);
      case 'broken':
        return;
    }
  }

  private headerLine(text: string): void {
    const header = text.endsWith(HEADER_END) ? parseJson(`${text.slice(0, -HEADER_END.length)}}`) : undefined;
    if (!isObject(header) || header.version !== 1 || header.layout !== SNAPSHOT_LAYOUT) {
      return this.fail('linia 1: nieznany nagłówek kopii');
    }
    this.state = 'table';
  }

  private tableOrTrailerLine(text: string): void {
    if (text.startsWith(TRAILER_START)) {
      const counts = text.endsWith('}') ? parseJson(text.slice(TRAILER_START.length, -1)) : undefined;
      if (!isCountMap(counts)) return this.fail(`linia ${this.lineNo}: nieczytelna stopka row_counts`);
      this.trailer = new Map(Object.entries(counts));
      this.state = 'end';
      return;
    }
    const prefix = this.tableIndex === 0 ? '' : ',';
    const name = text.startsWith(prefix) && text.endsWith(':[') ? parseJson(text.slice(prefix.length, -2)) : undefined;
    if (typeof name !== 'string') return this.fail(`linia ${this.lineNo}: oczekiwano początku tabeli albo stopki`);
    if (this.counted.has(name)) return this.fail(`linia ${this.lineNo}: tabela ${name} drugi raz w pliku`);
    this.table = name;
    this.counted.set(name, 0);
    this.rowIndex = 0;
    this.state = 'rows';
  }

  private rowLine(text: string): void {
    if (text === ']') {
      this.tableIndex += 1;
      this.state = 'table';
      return;
    }
    const where = `linia ${this.lineNo} (tabela ${this.table})`;
    if (this.rowIndex > 0 && !text.startsWith(',')) return this.fail(`${where}: brak przecinka przed wierszem`);
    const row = parseJson(this.rowIndex === 0 ? text : text.slice(1));
    if (row === undefined) return this.fail(`${where}: wiersz nie jest poprawnym JSON-em`);
    if (!isObject(row)) return this.fail(`${where}: wiersz nie jest obiektem`);
    this.countRow();
  }

  /** Linia ponad limitem: w tabeli liczona jako wiersz, gdy wygląda na obiekt; gdzie indziej błąd. */
  private oversizedLine(): void {
    const where = `linia ${this.lineNo}`;
    if (this.state !== 'rows') return this.fail(`${where}: linia dłuższa niż ${sizeText(this.maxLineBytes)} poza wierszami tabeli`);
    const opens = this.rowIndex === 0 ? this.head[0] === BRACE_OPEN : this.head[0] === COMMA && this.head[1] === BRACE_OPEN;
    if (!opens || this.last !== BRACE_CLOSE) return this.fail(`${where} (tabela ${this.table}): wiersz nie jest obiektem`);
    this.unparsed.set(this.table, (this.unparsed.get(this.table) ?? 0) + 1);
    this.countRow();
  }

  private countRow(): void {
    this.rowIndex += 1;
    this.counted.set(this.table, this.rowIndex);
  }

  private endOfFile(): void {
    if (this.state === 'broken') return;
    const unfinishedLine = this.partBytes > 0 || this.oversized;
    if (this.lineNo === 0) {
      // Bez znaku nowej linii: stara kopia jednoliniowa (sprzed sesji 12) albo pusty plik.
      if (!unfinishedLine) return this.fail('pusty plik');
      if (this.oversized) {
        this.legacyNotParsed = true;
        return;
      }
      return this.legacyFile(Buffer.concat(this.parts, this.partBytes).toString('utf8'));
    }
    if (unfinishedLine) return this.fail(`linia ${this.lineNo + 1}: plik nie kończy się znakiem nowej linii`);
    if (this.state !== 'end') return this.fail(`plik urwany po linii ${this.lineNo}: brak stopki row_counts`);
    this.complete = true;
  }

  private legacyFile(text: string): void {
    const payload = parseJson(text);
    if (payload === undefined) return this.fail('stara kopia nie jest poprawnym JSON-em');
    if (!isObject(payload) || !payload.version || !isObject(payload.tables) || !isCountMap(payload.row_counts)) {
      return this.fail('invalid_structure');
    }
    for (const [name, rows] of Object.entries(payload.tables)) {
      if (!Array.isArray(rows)) return this.fail(`stara kopia: tabela ${name} nie jest listą`);
      this.counted.set(name, rows.length);
    }
    this.trailer = new Map(Object.entries(payload.row_counts));
    this.complete = true;
  }
}
