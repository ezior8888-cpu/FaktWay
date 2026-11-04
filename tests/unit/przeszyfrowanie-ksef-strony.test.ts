import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decryptCredentials,
  encryptCredentials,
  isCredentialsV2,
  isEncryptedWithCurrentKey,
  type TenantKsefCredentials,
} from '@/lib/ksef/credentials-crypto';
import { reencryptComplete, reencryptKsefCredentials, type ReencryptReport } from '@/lib/ksef/reencrypt-credentials';
import { bufferToByteaLiteral } from '@/lib/supabase/bytea';

import { historyClient, historyDb, type HistoryDb, type Row } from './helpers/historia-ksef-baza';

/**
 * `scripts/reencrypt-ksef-credentials.ts` (AUD-52, sesja 27 planu skalowania).
 * Dwie szkody o tym samym skutku — po usunięciu starego klucza część firm
 * traci dane dostępowe KSeF, a wysyłka i odbiór stają:
 *   1. jedno zapytanie oddawało najwyżej 1000 firm (PGRST_DB_MAX_ROWS),
 *      a skrypt zgłaszał sukces („przeszyfrowano: 1000, błędy: 0”),
 *   2. „już v2” sprawdzało samą magię formatu, nie odcisk klucza — przy
 *      rotacji v2 starym kluczem było pomijane.
 * Atrapa ucina każdą odpowiedź SELECT do 1000 wierszy, jak produkcja.
 */

// Sekrety testowe składane w czasie testu — literał wyglądałby dla skanera
// sekretów (gitleaks, reguła ogólna) jak prawdziwy klucz.
const KEY = ['klucz', 'testowy', 'nowy'].join('-');
const OLD = ['klucz', 'testowy', 'stary'].join('-');
const FIRMS = 2500;

const id = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const creds = (n: number): TenantKsefCredentials => ({ type: 'token', nip: String(1000000000 + n), token: `ref|nip|sekret-${n}` });
/** Kolejność sterty ≠ kolejność id (7919 względnie pierwsze z 2500). */
const heapOrder = (count: number) => Array.from({ length: count }, (_, i) => ((i * 7919) % count) + 1);

/** scrypt jest celowo kosztowny — klucz v1 liczymy raz na sekret. */
const legacyKeys = new Map<string, Buffer>();

/** Blob w dotychczasowym formacie v1 — tak jak zapisywał go stary kod. */
function legacyBlob(secret: string, value: TenantKsefCredentials): Buffer {
  let key = legacyKeys.get(secret);
  if (!key) {
    key = scryptSync(secret, Buffer.from('ksef-saas-credentials-v1'), 32);
    legacyKeys.set(secret, key);
  }
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(Buffer.from(JSON.stringify(value))), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

/** v2 zaszyfrowane wskazanym kluczem (jak przed rotacją). */
function v2With(secret: string, n: number): Buffer {
  const saved = process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY;
  process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY = secret;
  try {
    return encryptCredentials(creds(n), id(n));
  } finally {
    process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY = saved;
  }
}

function tenantRow(n: number, blob: Buffer | null): Row {
  return {
    id: id(n), nip: String(1000000000 + n),
    ksef_credentials_encrypted: blob ? bufferToByteaLiteral(blob) : null,
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

const blobOf = (row: Row) => Buffer.from(String(row.ksef_credentials_encrypted).slice(2), 'hex');

let db: HistoryDb;
let saved: Record<string, string | undefined>;

function client() {
  return historyClient(db) as unknown as Parameters<typeof reencryptKsefCredentials>[0];
}

beforeEach(() => {
  saved = { k: process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY, p: process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS };
  process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY = KEY;
  process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS = OLD;
});

afterEach(() => {
  if (saved.k === undefined) delete process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY;
  else process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY = saved.k;
  if (saved.p === undefined) delete process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS;
  else process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS = saved.p;
});

describe(`rotacja klucza: ${FIRMS} firm w v2 na starym kluczu, limit PostgREST 1000`, () => {
  beforeEach(() => {
    db = historyDb({
      tenants: [
        ...heapOrder(FIRMS).map((n) => tenantRow(n, v2With(OLD, n))),
        // Firma bez danych KSeF — poza przebiegiem.
        tenantRow(FIRMS + 1, null),
      ],
    }, { maxRows: 1000 });
  });

  it('obejmuje wszystkie firmy; po usunięciu starego klucza każda się odszyfruje', async () => {
    const report = await reencryptKsefCredentials(client(), { apply: true, force: false });
    expect(report).toEqual<ReencryptReport>({ total: FIRMS, read: FIRMS, rewritten: FIRMS, alreadyCurrent: 0, changedMeanwhile: 0, failed: 0 });
    expect(reencryptComplete(report)).toBe(true);

    delete process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS;
    for (const row of db.tables.tenants!.filter((r) => r.ksef_credentials_encrypted)) {
      const blob = blobOf(row);
      expect(isEncryptedWithCurrentKey(blob)).toBe(true);
      expect(decryptCredentials(blob, String(row.id))).toEqual(creds(Number(String(row.id).slice(0, 8))));
    }
  });

  it('druga runda nic nie zapisuje (wszystko już na bieżącym kluczu)', async () => {
    await reencryptKsefCredentials(client(), { apply: true, force: false });
    const before = db.tables.tenants!.map((r) => r.ksef_credentials_encrypted);
    const again = await reencryptKsefCredentials(client(), { apply: true, force: false });
    expect(again).toMatchObject({ read: FIRMS, rewritten: 0, alreadyCurrent: FIRMS, failed: 0 });
    expect(db.tables.tenants!.map((r) => r.ksef_credentials_encrypted)).toEqual(before);
  });

  it('podgląd (bez --apply) liczy wszystkie, ale nic nie zapisuje', async () => {
    const before = db.tables.tenants!.map((r) => r.ksef_credentials_encrypted);
    const report = await reencryptKsefCredentials(client(), { apply: false, force: false });
    expect(report).toMatchObject({ read: FIRMS, rewritten: FIRMS, alreadyCurrent: 0 });
    expect(db.tables.tenants!.map((r) => r.ksef_credentials_encrypted)).toEqual(before);
    expect(db.log.filter((e) => e.op === 'update')).toEqual([]);
  });
});

describe('format v1 → v2', () => {
  it('1500 firm w v1: wszystkie w v2 na bieżącym kluczu', async () => {
    delete process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS;
    db = historyDb({ tenants: heapOrder(1500).map((n) => tenantRow(n, legacyBlob(KEY, creds(n)))) }, { maxRows: 1000 });
    const report = await reencryptKsefCredentials(client(), { apply: true, force: false });
    expect(report).toMatchObject({ total: 1500, read: 1500, rewritten: 1500, failed: 0 });
    expect(db.tables.tenants!.every((r) => isCredentialsV2(blobOf(r)) && isEncryptedWithCurrentKey(blobOf(r)))).toBe(true);
  });
});

describe('wyścig z klientem i błędy', () => {
  it('certyfikat wgrany między odczytem a zapisem nie zostaje nadpisany — „zmieniona w trakcie”, przebieg niekompletny', async () => {
    db = historyDb({ tenants: [1, 2, 3].map((n) => tenantRow(n, v2With(OLD, n))) });
    const base = historyClient(db);
    const uploaded = bufferToByteaLiteral(encryptCredentials({ type: 'token', nip: '1000000001', token: 'nowy-token' }, id(1)));
    let raced = false;
    const racing = {
      ...base,
      from(table: string) {
        const q = base.from(table);
        const update = q.update;
        q.update = (payload: Row) => {
          if (!raced) {
            // Klient wgrywa nowe dane firmy 1 tuż przed zapisem skryptu.
            raced = true;
            Object.assign(db.tables.tenants![0]!, { ksef_credentials_encrypted: uploaded, updated_at: '2026-10-29T12:00:00.000Z' });
          }
          return update(payload);
        };
        return q;
      },
    };
    const lines: string[] = [];
    const report = await reencryptKsefCredentials(racing as unknown as Parameters<typeof reencryptKsefCredentials>[0], {
      apply: true, force: false, log: (line) => lines.push(line),
    });
    expect(report).toMatchObject({ read: 3, rewritten: 2, changedMeanwhile: 1, failed: 0 });
    expect(reencryptComplete(report)).toBe(false);
    expect(db.tables.tenants![0]!.ksef_credentials_encrypted).toBe(uploaded);
    expect(lines).toEqual([expect.stringContaining(`firma ${id(1)}: zmieniona albo usunięta w trakcie`)]);
  });

  it('zapis, którego nie da się odszyfrować, to błąd w raporcie (bez treści danych), reszta idzie dalej', async () => {
    delete process.env.KSEF_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS;
    db = historyDb({ tenants: [tenantRow(1, v2With(OLD, 1)), tenantRow(2, legacyBlob(KEY, creds(2)))] });
    const lines: string[] = [];
    const report = await reencryptKsefCredentials(client(), { apply: true, force: false, log: (line) => lines.push(line) });
    expect(report).toMatchObject({ read: 2, rewritten: 1, failed: 1 });
    expect(reencryptComplete(report)).toBe(false);
    expect(lines).toEqual([`firma ${id(1)}: decryptCredentials: brak klucza, którym zaszyfrowano dane (rotacja?)`]);
  });

  it('błąd odczytu strony 2 listy firm: wyjątek, nie raport „przeszyfrowano: 200”', async () => {
    db = historyDb({ tenants: heapOrder(FIRMS).slice(0, 600).map((n) => tenantRow(n, v2With(OLD, n))) });
    // SELECT-y na `tenants`: 1 — liczba firm, 2 — strona 1 (200 firm), 3 — strona 2.
    const base = historyClient(db);
    let selects = 0;
    const failing = {
      ...base,
      from(table: string) {
        const q = base.from(table) as ReturnType<typeof base.from> & { then: unknown };
        const select = q.select;
        const update = q.update;
        // `.update(…).select('id')` to zapis, nie odczyt — nie liczymy go.
        let writing = false;
        q.update = (...args: Parameters<typeof update>) => { writing = true; return update(...args); };
        q.select = (...args: Parameters<typeof select>) => {
          if (table === 'tenants' && !writing && (selects += 1) === 3) {
            q.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
              Promise.resolve({ data: null, count: null, error: { message: 'canceling statement due to statement timeout' } }).then(ok, fail);
          }
          return select(...args);
        };
        return q;
      },
    };
    await expect(reencryptKsefCredentials(failing as unknown as Parameters<typeof reencryptKsefCredentials>[0], { apply: true, force: false }))
      .rejects.toThrow('Przeszyfrowanie: odczyt firm: canceling statement due to statement timeout');
    // Strona 1 zdążyła się zapisać (powtórka ją pominie jako „już na bieżącym kluczu”), strona 2 — nie.
    expect(db.log.filter((e) => e.table === 'tenants' && e.op === 'update')).toHaveLength(200);
  });

  it('mniej przeczytanych niż w bazie (firma zniknęła w trakcie) = przebieg niekompletny', () => {
    expect(reencryptComplete({ total: 10, read: 9, rewritten: 9, alreadyCurrent: 0, changedMeanwhile: 0, failed: 0 })).toBe(false);
    expect(reencryptComplete({ total: 10, read: 11, rewritten: 11, alreadyCurrent: 0, changedMeanwhile: 0, failed: 0 })).toBe(true);
  });
});
