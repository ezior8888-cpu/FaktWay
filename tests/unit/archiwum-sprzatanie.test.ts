import { existsSync, readFileSync } from 'node:fs';

import { DeleteObjectCommand, NoSuchKey, S3ServiceException } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

import { historyClient, historyDb, type HistoryDb, type Row } from './helpers/historia-ksef-baza';

/**
 * Krok 6.4, część 2 planu kompletnej aplikacji: zadanie
 * `cron.document-archive-cleanup` usuwa z magazynu pliki paczek archiwum,
 * których link wygasł (migracja 00190). Prawdziwy runner i prawdziwa warstwa
 * magazynu (`lib/storage/r2.ts`); atrapy tylko dla klienta S3 i bazy.
 *
 * Granice (ryzyko R1, usuwanie danych): jeden obiekt o kluczu `file_key`
 * z wiersza i tylko w katalogu tego zlecenia; tylko `completed` z wygasłym
 * linkiem; wiersz zostaje i dostaje znacznik (funkcja bazy razem z wpisem
 * `audit_logs`); błąd magazynu = brak znacznika i ponowienie.
 *
 * Funkcja `mark_document_archive_file_deleted` jest tu atrapą o tych samych
 * warunkach co SQL z 00190; samą funkcję, CHECK i wpis audytu sprawdza
 * `tests/rls-archiwum-sprzatanie.test.ts` na prawdziwej bazie.
 */

const m = vi.hoisted(() => ({
  db: null as unknown,
  /** Polecenia wysłane do magazynu (klient S3). */
  sent: [] as unknown[],
  /** Klucz → błąd, który magazyn zwróci przy tym kluczu. */
  failKeys: new Map<string, Error>(),
  /** Każde polecenie kończy się tym błędem (awaria całego magazynu). */
  failAll: null as Error | null,
  sentry: [] as Array<{ message: string; extra?: unknown }>,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureMessage: vi.fn((message: string, context?: { extra?: unknown }) => {
    m.sentry.push({ message, extra: context?.extra });
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => m.db }));
vi.mock('@/lib/storage/r2-client', () => ({
  getR2Config: () => ({ bucketName: 'faktury' }),
  getR2Client: () => ({
    send: async (command: { input: { Key?: string } }) => {
      m.sent.push(command);
      if (m.failAll) throw m.failAll;
      const fail = m.failKeys.get(String(command.input.Key));
      if (fail) throw fail;
      return {};
    },
  }),
}));

import {
  ARCHIVE_FILE_GRACE_MS,
  CLEANUP_MAX_PAGES,
  CLEANUP_MAX_STORAGE_ERRORS,
  CLEANUP_PAGE_SIZE,
  runDocumentArchiveCleanup,
} from '@/lib/jobs/runners/document-archive-cleanup';
import { CRON_JOBS } from '@/lib/jobs/queues';
import { cronMaxGapMs } from '@/lib/jobs/jobs-health';
import { deleteDocumentArchiveFile } from '@/lib/storage/r2';
import { isDocumentArchiveFileKey } from '@/lib/storage/tenant-path';

const T = '0190aaaa-0000-4000-8000-000000000001';
const OTHER_T = '0190aaaa-0000-4000-8000-000000000002';
const NOW = Date.parse('2026-11-20T03:30:00.000Z'); // 04:30 w Warszawie, pora crona
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const archiveId = (n: number) => `0190bbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FILE = 'Archiwum_1234567890_2026-03-01_2026-03-31.zip';

/** Gotowa paczka, której link wygasł 2 dni temu (nadpisz, co potrzebne). */
function paczka(n: number, patch: Row = {}): Row {
  const id = archiveId(n);
  const tenant = (patch.tenant_id as string | undefined) ?? T;
  return {
    id,
    tenant_id: tenant,
    kind: 'archive',
    period_start: '2026-03-01',
    period_end: '2026-03-31',
    status: 'completed',
    file_key: `exports/${tenant}/archiwum/${id}/${FILE}`,
    file_name: FILE,
    size_bytes: 2048,
    files_count: 5,
    missing_count: 0,
    finished_at: iso(NOW - 9 * DAY),
    expires_at: iso(NOW - 2 * DAY),
    notified_at: iso(NOW - 9 * DAY),
    file_deleted_at: null,
    ...patch,
  };
}

let db: HistoryDb;
let audits: Row[];
/** Ile kolejnych wywołań funkcji znacznika ma się skończyć błędem bazy. */
let rpcFailures: number;

/** Atrapa `mark_document_archive_file_deleted` z 00190: te same warunki UPDATE i wpis audytu w „transakcji”. */
function markRpc(fn: string, args: Record<string, unknown>) {
  if (fn !== 'mark_document_archive_file_deleted') return { data: null, error: { message: `brak funkcji ${fn}` } };
  if (rpcFailures > 0) {
    rpcFailures -= 1;
    return { data: null, error: { message: 'canceling statement due to statement timeout' } };
  }
  const row = (db.tables.document_archives ?? []).find((r) => r.id === args.p_archive_id);
  const eligible =
    row &&
    row.status === 'completed' &&
    row.file_key === args.p_file_key &&
    row.file_deleted_at == null &&
    row.expires_at != null &&
    Date.parse(String(row.expires_at)) < Date.now();
  if (!eligible) return { data: false, error: null };
  row.file_deleted_at = iso(Date.now());
  audits.push({ tenant_id: row.tenant_id, action: 'document_archive.file_deleted', entity_type: 'document_archive', entity_id: row.id });
  return { data: true, error: null };
}

function useRows(rows: Row[], options: { maxRows?: number } = {}) {
  db = historyDb({ document_archives: rows }, options);
  db.rpc = markRpc;
  m.db = historyClient(db);
}

const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

/** Klucze usunięte z magazynu (tylko DeleteObject; inne polecenia łapie osobna asercja). */
const deletedKeys = () => m.sent.filter((c) => c instanceof DeleteObjectCommand).map((c) => (c as DeleteObjectCommand).input.Key);
const row = (n: number) => db.tables.document_archives!.find((r) => r.id === archiveId(n))!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  m.sent = [];
  m.failKeys = new Map();
  m.failAll = null;
  m.sentry = [];
  audits = [];
  rpcFailures = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('cron.document-archive-cleanup: co wolno usunąć', () => {
  it('usuwa tylko plik gotowej paczki po wygaśnięciu linku i zapasie; inne stany i świeże paczki nietknięte', async () => {
    useRows([
      paczka(1),
      // W zapasie: link wygasł 30 minut temu (podpisany link żyje 5 minut, pobieranie dłużej).
      paczka(2, { expires_at: iso(NOW - 30 * 60_000) }),
      paczka(3, { expires_at: iso(NOW + 3 * DAY) }),
      // Stany aktywne i nieudane nigdy, nawet z kluczem i datą w przeszłości.
      paczka(4, { status: 'pending' }),
      paczka(5, { status: 'generating' }),
      paczka(6, { status: 'failed', error_message: 'Nie udało się przygotować paczki.' }),
      // Plik usunięty w poprzednim przebiegu.
      paczka(7, { file_deleted_at: iso(NOW - DAY) }),
      paczka(8, { tenant_id: OTHER_T }),
    ]);

    const result = await runDocumentArchiveCleanup(ctx);

    expect(result).toMatchObject({ deleted: 2, refused: 0, storageErrors: 0, truncated: false });
    // Dokładnie dwa polecenia DeleteObject, każde na jeden klucz z wiersza; bez listowania i bez usuwania po prefiksie.
    expect(m.sent).toHaveLength(2);
    expect(m.sent.every((c) => c instanceof DeleteObjectCommand)).toBe(true);
    expect(m.sent.map((c) => (c as DeleteObjectCommand).input)).toEqual([
      { Bucket: 'faktury', Key: `exports/${T}/archiwum/${archiveId(1)}/${FILE}` },
      { Bucket: 'faktury', Key: `exports/${OTHER_T}/archiwum/${archiveId(8)}/${FILE}` },
    ]);
    // Wiersze zostają jako historia; znacznik tylko przy usuniętych.
    expect(db.tables.document_archives).toHaveLength(8);
    expect(db.log.some((q) => q.table === 'document_archives' && q.op !== 'select')).toBe(false);
    expect(row(1).file_deleted_at).toBe(iso(NOW));
    expect(row(8).file_deleted_at).toBe(iso(NOW));
    for (const n of [2, 3, 4, 5, 6]) expect(row(n).file_deleted_at, `paczka ${n}`).toBeNull();
    expect(row(7).file_deleted_at).toBe(iso(NOW - DAY));
    expect(audits.map((a) => a.entity_id)).toEqual([archiveId(1), archiveId(8)]);
    // Zapytanie kandydatów: stan, brak znacznika, klucz i wygaśnięcie z zapasem, strona po kluczu.
    const select = db.log.find((q) => q.table === 'document_archives' && q.op === 'select')!;
    expect(select.filters).toEqual(expect.arrayContaining([
      'status=eq.completed',
      'file_deleted_at=is.null',
      'file_key=not.is.null',
      `expires_at=lt.${iso(NOW - ARCHIVE_FILE_GRACE_MS)}`,
    ]));
  });

  it('klucz spoza katalogu zlecenia: bez usuwania i bez znacznika, ostrzeżenie dla operatora, reszta idzie dalej', async () => {
    const id = (n: number) => archiveId(n);
    useRows([
      paczka(11, { file_key: `exports/${T}/archiwum/${id(99)}/${FILE}` }), // katalog innego zlecenia
      paczka(12, { file_key: `exports/${T}/0190eeee-0000-4000-8000-000000000001/JPK_V7M.xml` }), // zwykły eksport
      paczka(13, { file_key: `${T}/2026/03/0190ffff-0000-4000-8000-000000000001.xml` }), // XML faktury firmy
      paczka(14, { file_key: `exports/${T}/archiwum/${id(14)}/../../../${T}/2026/03/faktura.xml` }),
      paczka(15, { file_key: `exports/${T}/archiwum/${id(15)}/podkatalog/${FILE}` }),
      paczka(16, { file_key: `exports/${OTHER_T}/archiwum/${id(16)}/${FILE}` }), // katalog innej firmy
      paczka(17, { file_key: `exports/${T}/archiwum/${id(17)}/` }), // sam katalog
      paczka(18, { file_key: `exports/${T}/archiwum/${id(18)}/${FILE}` }),
    ]);

    const result = await runDocumentArchiveCleanup(ctx);

    expect(result).toMatchObject({ deleted: 1, refused: 7 });
    expect(deletedKeys()).toEqual([`exports/${T}/archiwum/${id(18)}/${FILE}`]);
    expect(m.sent).toHaveLength(1);
    for (const n of [11, 12, 13, 14, 15, 16, 17]) expect(row(n).file_deleted_at, `paczka ${n}`).toBeNull();
    expect(row(18).file_deleted_at).toBe(iso(NOW));
    const warning = m.sentry.find((s) => /klucz pliku spoza katalogu zlecenia/.test(s.message));
    expect(warning?.extra).toEqual({ archiveIds: [id(11), id(12), id(13), id(14), id(15), id(16), id(17)] });
  });

  it('warstwa magazynu sama odmawia klucza spoza katalogu zlecenia (bez polecenia do magazynu)', async () => {
    const id = archiveId(21);
    await expect(deleteDocumentArchiveFile(`${T}/2026/03/faktura.xml`, T, id)).rejects.toThrow(/document archive/);
    await expect(deleteDocumentArchiveFile(`exports/${T}/archiwum/${id}/a/../b.zip`, T, id)).rejects.toThrow(/document archive/);
    expect(m.sent).toEqual([]);

    expect(isDocumentArchiveFileKey(`exports/${T}/archiwum/${id}/${FILE}`, T, id)).toBe(true);
    for (const key of [
      `exports/${T}/archiwum/${id}`,
      `exports/${T}/archiwum/${id}/`,
      `exports/${T}/archiwum/${id}/x/${FILE}`,
      `exports/${T}/archiwum/${id}/..${FILE}`,
      `exports/${T}/archiwum/${id}/a\\b.zip`,
      `exports/${T}/archiwum/${id}/a\nb.zip`,
      `exports/${T}/archiwum/${archiveId(22)}/${FILE}`,
      `exports/${OTHER_T}/archiwum/${id}/${FILE}`,
      `/exports/${T}/archiwum/${id}/${FILE}`,
    ]) {
      expect(isDocumentArchiveFileKey(key, T, id), key).toBe(false);
    }
    // Identyfikatory spoza formatu uuid (np. pusty) nie składają prefiksu.
    expect(isDocumentArchiveFileKey(`exports//archiwum//${FILE}`, '', '')).toBe(false);
  });
});

describe('cron.document-archive-cleanup: ponowienie od zera', () => {
  it('brak obiektu w magazynie to sukces: znacznik i jeden wpis audytu', async () => {
    useRows([paczka(31), paczka(32)]);
    m.failKeys.set(String(paczka(31).file_key), new NoSuchKey({ message: 'The specified key does not exist.', $metadata: { httpStatusCode: 404 } }));

    const result = await runDocumentArchiveCleanup(ctx);

    expect(result).toMatchObject({ deleted: 2, storageErrors: 0 });
    expect(row(31).file_deleted_at).toBe(iso(NOW));
    expect(audits).toHaveLength(2);
  });

  it('błąd magazynu: wiersz bez znacznika, reszta partii dalej, zadanie rzuca; ponowienie domyka tylko ten plik', async () => {
    useRows([paczka(41), paczka(42), paczka(43)]);
    const failing = String(paczka(42).file_key);
    m.failKeys.set(failing, new S3ServiceException({ name: 'ServiceUnavailable', $fault: 'server', $metadata: { httpStatusCode: 503 }, message: 'Service Unavailable' }));

    await expect(runDocumentArchiveCleanup(ctx)).rejects.toThrow(/magazyn/i);

    expect(row(41).file_deleted_at).toBe(iso(NOW));
    expect(row(42).file_deleted_at).toBeNull();
    expect(row(43).file_deleted_at).toBe(iso(NOW));
    expect(audits.map((a) => a.entity_id)).toEqual([archiveId(41), archiveId(43)]);

    // Ponowienie (pg-boss wykonuje cały handler od nowa): magazyn już działa.
    m.failKeys.clear();
    m.sent = [];
    const retry = await runDocumentArchiveCleanup(ctx);

    expect(retry).toMatchObject({ deleted: 1, storageErrors: 0 });
    expect(deletedKeys()).toEqual([failing]);
    expect(row(42).file_deleted_at).toBe(iso(NOW));
    expect(audits.map((a) => a.entity_id)).toEqual([archiveId(41), archiveId(43), archiveId(42)]);
  });

  it('awaria całego magazynu: przerwanie po 3 błędach, bez żadnego znacznika', async () => {
    useRows([1, 2, 3, 4, 5, 6].map((n) => paczka(50 + n)));
    m.failAll = new Error('connect ECONNREFUSED');

    await expect(runDocumentArchiveCleanup(ctx)).rejects.toThrow(/magazyn/i);

    expect(CLEANUP_MAX_STORAGE_ERRORS).toBe(3);
    expect(m.sent).toHaveLength(CLEANUP_MAX_STORAGE_ERRORS);
    expect(db.tables.document_archives!.every((r) => r.file_deleted_at === null)).toBe(true);
    expect(audits).toEqual([]);
  });

  it('ponowienie po usunięciu pliku, a przed znacznikiem: drugie usunięcie bez skutku, jeden wpis audytu', async () => {
    useRows([paczka(61)]);
    rpcFailures = 1;

    await expect(runDocumentArchiveCleanup(ctx)).rejects.toThrow(/mark_document_archive_file_deleted/);
    expect(deletedKeys()).toHaveLength(1);
    expect(row(61).file_deleted_at).toBeNull();

    const retry = await runDocumentArchiveCleanup(ctx);

    expect(retry).toMatchObject({ deleted: 1 });
    expect(deletedKeys()).toEqual([paczka(61).file_key, paczka(61).file_key]);
    expect(row(61).file_deleted_at).toBe(iso(NOW));
    expect(audits).toHaveLength(1);

    // Trzecie wykonanie (np. spóźnione ponowienie): nic do zrobienia.
    m.sent = [];
    expect(await runDocumentArchiveCleanup(ctx)).toMatchObject({ deleted: 0 });
    expect(m.sent).toEqual([]);
    expect(audits).toHaveLength(1);
  });

  it('funkcja bazy nie zmieniła wiersza (inny przebieg zdążył): bez błędu i bez drugiego wpisu', async () => {
    useRows([paczka(71)]);
    db.rpc = () => ({ data: false, error: null });

    const result = await runDocumentArchiveCleanup(ctx);

    expect(result).toMatchObject({ deleted: 0, alreadyMarked: 1 });
    expect(audits).toEqual([]);
  });

  it('błąd odczytu kandydatów: zadanie rzuca i niczego nie usuwa', async () => {
    useRows([paczka(81)]);
    db.failures.add('document_archives:select');

    await expect(runDocumentArchiveCleanup(ctx)).rejects.toThrow(/document_archives/);
    expect(m.sent).toEqual([]);
  });
});

describe('cron.document-archive-cleanup: partia z limitem', () => {
  it('strony po kluczu do limitu przebiegu; reszta w następnym; odpowiedź ucięta do 1000 wierszy nie gubi paczek', async () => {
    const total = CLEANUP_PAGE_SIZE * CLEANUP_MAX_PAGES + 5;
    useRows(Array.from({ length: total }, (_, i) => paczka(1000 + i)), { maxRows: 1000 });

    const first = await runDocumentArchiveCleanup(ctx);

    expect(first).toMatchObject({ deleted: CLEANUP_PAGE_SIZE * CLEANUP_MAX_PAGES, truncated: true });
    const selects = db.log.filter((q) => q.table === 'document_archives' && q.op === 'select');
    expect(selects).toHaveLength(CLEANUP_MAX_PAGES);
    expect(m.sentry.some((s) => /reszta w następnym przebiegu/.test(s.message))).toBe(true);

    const second = await runDocumentArchiveCleanup(ctx);

    expect(second).toMatchObject({ deleted: 5, truncated: false });
    expect(new Set(deletedKeys()).size).toBe(total);
    expect(db.tables.document_archives!.every((r) => r.file_deleted_at === iso(NOW))).toBe(true);
    expect(audits).toHaveLength(total);
  });

  it('pełna strona paczek bez znacznika (odmowa klucza) nie zasłania następnych: kolejna strona od ostatniego klucza', async () => {
    const refusedRows = Array.from({ length: CLEANUP_PAGE_SIZE }, (_, i) => {
      const id = archiveId(3000 + i);
      return paczka(3000 + i, { file_key: `exports/${T}/archiwum/${id}/podkatalog/${FILE}` });
    });
    useRows([...refusedRows, paczka(4001), paczka(4002), paczka(4003)]);

    const result = await runDocumentArchiveCleanup(ctx);

    expect(result).toMatchObject({ deleted: 3, refused: CLEANUP_PAGE_SIZE, truncated: false });
    expect(deletedKeys()).toEqual([4001, 4002, 4003].map((n) => paczka(n).file_key));
    const pages = db.log.filter((q) => q.table === 'document_archives' && q.op === 'select');
    expect(pages[1]?.filters).toContain(`id=gt.${archiveId(3000 + CLEANUP_PAGE_SIZE - 1)}`);
  });
});

describe('harmonogram i migracja 00190', () => {
  it('cron raz na dobę o 04:30 (Warszawa), po retencji faktur i kopii; strażnik kolejek pilnuje przerwy 26 h', () => {
    const def = CRON_JOBS.find((c) => c.queue === 'cron.document-archive-cleanup');
    expect(def).toEqual({ queue: 'cron.document-archive-cleanup', cron: '30 4 * * *', tz: 'Europe/Warsaw' });
    expect(cronMaxGapMs(def!.cron)).toBe(26 * HOUR);
    // Zapas po wygaśnięciu: dłuższy niż podpisany link (5 minut), krótszy niż doba.
    expect(ARCHIVE_FILE_GRACE_MS).toBe(HOUR);
  });

  const path = 'supabase/migrations/00190_document_archive_file_cleanup.sql';
  const sql = existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n/g, '\n') : '';
  const outsideBodies = sql.replace(/--[^\n]*/g, '').replace(/\$\$[\s\S]*?\$\$/g, '');
  const header = sql.split('\n').filter((line) => line.startsWith('--')).join('\n');

  it('nagłówek: PRZED wdrożeniem, opis nowego CHECK, bez DROP tabel i kolumn i bez DML przy wgraniu', () => {
    expect(sql).not.toBe('');
    expect(header).toMatch(/PRZED wdrożeniem/);
    expect(header).toMatch(/document_archives_file_deleted_check/);
    expect(outsideBodies).not.toMatch(/\b(DROP\s+(TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+public\.|INSERT\s+INTO)\b/i);
    expect(outsideBodies).toMatch(/ADD COLUMN IF NOT EXISTS file_deleted_at TIMESTAMPTZ/);
    expect(outsideBodies).toMatch(/ADD CONSTRAINT document_archives_file_deleted_check CHECK/);
  });

  it('znacznik tylko przez funkcję bazy: SECURITY DEFINER, stały search_path, EXECUTE tylko service_role', () => {
    const fn = 'mark_document_archive_file_deleted(uuid, text)';
    expect(sql).toMatch(/FUNCTION public\.mark_document_archive_file_deleted\(p_archive_id uuid, p_file_key text\)\s+RETURNS boolean\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = ''/);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
    expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role;`);
    // UPDATE z warunkiem i wpis audytu w tym samym ciele (jednej transakcji).
    const body = /\$\$([\s\S]*?)\$\$/.exec(sql)?.[1] ?? '';
    expect(body).toMatch(/status = 'completed'/);
    expect(body).toMatch(/file_key = p_file_key/);
    expect(body).toMatch(/file_deleted_at IS NULL/);
    expect(body).toMatch(/expires_at < now\(\)/);
    expect(body).toMatch(/INSERT INTO public\.audit_logs[\s\S]*'document_archive\.file_deleted'/);
  });

  it('rejestr numerów: 00190 zajęte w tym PR, „następny wolny” za nim', () => {
    const registry = readFileSync('docs/koordynacja/CLAUDE-DO-CODEXA.md', 'utf8');
    expect(registry).toMatch(/^\| 00190 \| Claude \(plan kompletnej aplikacji, krok 6\.4, część 2/m);
    // Bez numeru na sztywno: po kolejnych migracjach (gałąź zbiorcza, main) „następny wolny” rośnie.
    expect(Number(/^\| \*\*(\d{5})\*\* \| — \| następny wolny/m.exec(registry)?.[1])).toBeGreaterThan(190);
  });
});
