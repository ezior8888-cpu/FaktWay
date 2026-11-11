import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { utworzAtrape, uuidNr, type Wiersz } from '../helpers/kopia-json-atrapa';

/**
 * Plan skalowania 3000, sesja 12 (CPU-V2): tygodniowa weryfikacja pobierała
 * cały plik kopii do pamięci, rozpakowywała go do jednego napisu i parsowała
 * naraz. Przy dużej bazie to ten sam koniec pamięci co przy zapisie kopii,
 * a komunikat błędu `JSON.parse` niósł kawałek wiersza (dane klienta) do
 * alarmu na Slacku.
 *
 * Kopia ma układ „wiersz na linię” (dalej poprawny JSON), więc weryfikacja
 * czyta strumień i parsuje linię po linii. Stare kopie jednoliniowe (sprzed
 * zmiany, leżą do 8 tygodni) dalej przechodzą. Limit długości linii w teście
 * jest mały (4 KiB), żeby sprawdzić drogę „za długa linia” bez ogromnych plików.
 */

const { LIMIT_LINII_TESTOWY } = vi.hoisted(() => ({ LIMIT_LINII_TESTOWY: 4 * 1024 }));

const state = vi.hoisted(() => ({
  atrapa: null as null | { admin: unknown },
  plik: Buffer.alloc(0) as Buffer,
  wgrane: [] as Array<{ body: Buffer; checksum: string }>,
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), addBreadcrumb: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => state.atrapa!.admin }));
vi.mock('@/lib/backup/r2-backup-client', () => ({
  buildSnapshotKey: () => ({ full: 'backups/db/2026/11/11-010000.json.gz', relative: 'db/2026/11/11-010000.json.gz' }),
  uploadSnapshot: async (_key: string, body: Uint8Array, checksum: string) => {
    state.wgrane.push({ body: Buffer.from(body), checksum });
  },
  // Stara droga (cały plik naraz) i nowa (strumień w kawałkach po 1000 B).
  downloadSnapshot: async () => state.plik,
  openSnapshotStream: async () => {
    const kawalki: Buffer[] = [];
    for (let i = 0; i < state.plik.length; i += 1000) kawalki.push(state.plik.subarray(i, i + 1000));
    return Readable.from(kawalki, { objectMode: false });
  },
}));
vi.mock('@/lib/backup/snapshot-tables', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MAX_SNAPSHOT_LINE_BYTES: LIMIT_LINII_TESTOWY,
}));

import { createDbSnapshot } from '@/lib/backup/db-snapshot';
import { verifySnapshot, type VerifyResult } from '@/lib/backup/verify';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function liczniki(tabele: Record<string, Wiersz[]>): Record<string, number> {
  return Object.fromEntries(Object.entries(tabele).map(([n, w]) => [n, w.length]));
}

/** Plik kopii w układzie „wiersz na linię”, tak jak zapisuje go `createDbSnapshot`. */
function plikLiniowy(
  tabele: Record<string, Wiersz[]>,
  opcje: { stopka?: Record<string, number>; zmien?: (linie: string[]) => string[] } = {},
): string {
  const linie = ['{"version":1,"created_at":"2026-11-11T01:00:00.000Z","kind":"daily","layout":"line-per-row","tables":{'];
  Object.entries(tabele).forEach(([nazwa, wiersze], i) => {
    linie.push(`${i === 0 ? '' : ','}${JSON.stringify(nazwa)}:[`);
    wiersze.forEach((w, j) => linie.push(`${j === 0 ? '' : ','}${JSON.stringify(w)}`));
    linie.push(']');
  });
  linie.push(`},"row_counts":${JSON.stringify(opcje.stopka ?? liczniki(tabele))}}`);
  return `${(opcje.zmien ? opcje.zmien(linie) : linie).join('\n')}\n`;
}

/** Stara kopia: jeden `JSON.stringify` całości. */
function plikJednoliniowy(tabele: Record<string, Wiersz[]>): string {
  return JSON.stringify({
    version: 1,
    created_at: '2026-11-01T01:00:00.000Z',
    kind: 'daily',
    row_counts: liczniki(tabele),
    tables: tabele,
  });
}

function kontrahenci(n: number): Wiersz[] {
  return Array.from({ length: n }, (_, i) => ({ id: uuidNr(i + 1), name: `Firma ${i + 1}`, nip: '1234567890' }));
}

/** Weryfikacja pliku; baza „na dziś” = te same tabele (bez dryfu liczników). */
async function weryfikuj(
  tekstAlboGz: string | Buffer,
  opcje: {
    tabeleWBazie: Record<string, Wiersz[]>;
    rowCounts: Record<string, number>;
    checksum?: string;
  },
): Promise<{ wynik: VerifyResult; najdluzszyParse: number }> {
  state.plik = typeof tekstAlboGz === 'string' ? gzipSync(Buffer.from(tekstAlboGz, 'utf8')) : tekstAlboGz;
  state.atrapa = utworzAtrape({ tabele: opcje.tabeleWBazie });
  const parse = vi.spyOn(JSON, 'parse');
  try {
    const wynik = await verifySnapshot({
      r2KeyRelative: 'db/2026/11/11-010000.json.gz',
      expectedChecksum: opcje.checksum ?? sha(state.plik),
      snapshotRowCounts: opcje.rowCounts,
    });
    const najdluzszyParse = parse.mock.calls.reduce((m, [t]) => Math.max(m, String(t).length), 0);
    return { wynik, najdluzszyParse };
  } finally {
    parse.mockRestore();
  }
}

beforeEach(() => {
  state.wgrane = [];
  state.plik = Buffer.alloc(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('weryfikacja kopii JSON czyta plik strumieniem', () => {
  it('plik z 10 000 wierszy przechodzi bez parsowania całości naraz', async () => {
    const tabele = { invoices: kontrahenci(10_000) };
    const { wynik, najdluzszyParse } = await weryfikuj(plikLiniowy(tabele), {
      tabeleWBazie: tabele,
      rowCounts: liczniki(tabele),
    });
    expect(wynik).toMatchObject({ ok: true, errors: [] });
    // Najdłuższy parsowany kawałek to jedna linia, nie ~800 KB pliku.
    expect(najdluzszyParse).toBeLessThan(LIMIT_LINII_TESTOWY);
  });

  it('plik zapisany przez nocną kopię (createDbSnapshot) przechodzi weryfikację linia po linii', async () => {
    const tabele: Record<string, Wiersz[]> = {
      contractors: [],
      flo_decisions: ['a,b', 'x.y', 'cytat "w środku"', 'nowa\nlinia'].map((kind) => ({
        tenant_id: uuidNr(1, '11111111'),
        kind,
        accepted: 1,
      })),
      invoices: kontrahenci(1200),
    };
    state.atrapa = utworzAtrape({ tabele });
    await createDbSnapshot({ kind: 'daily', now: new Date('2026-11-11T01:00:00Z') });
    expect(state.wgrane).toHaveLength(1);
    const { body, checksum } = state.wgrane[0]!;
    expect(checksum).toBe(sha(body));

    const { wynik, najdluzszyParse } = await weryfikuj(body, { tabeleWBazie: tabele, rowCounts: liczniki(tabele) });
    expect(wynik).toMatchObject({ ok: true, errors: [], warnings: [] });
    expect(najdluzszyParse).toBeLessThan(LIMIT_LINII_TESTOWY);
  });

  it('uszkodzony wiersz: błąd z numerem linii i nazwą tabeli, bez treści wiersza', async () => {
    const tabele = { contractors: kontrahenci(3) };
    const tekst = plikLiniowy(tabele, {
      zmien: (linie) => linie.map((l, i) => (i === 3 ? `,{"id":"${uuidNr(2)}","name":Kowalski Jan}` : l)),
    });
    const { wynik } = await weryfikuj(tekst, { tabeleWBazie: tabele, rowCounts: liczniki(tabele) });
    expect(wynik.ok).toBe(false);
    expect(wynik.errors[0]).toMatch(/^parse_failed: linia 4\b/);
    expect(wynik.errors[0]).toContain('contractors');
    // Błąd trafia do alarmu na Slacku: bez danych klienta.
    expect(JSON.stringify(wynik)).not.toMatch(/Kowal/);
  });

  it('liczba wierszy w pliku inna niż w backup_log: błąd row_count_mismatch', async () => {
    const tabele = { contractors: kontrahenci(3) };
    const { wynik } = await weryfikuj(plikLiniowy(tabele), {
      tabeleWBazie: tabele,
      rowCounts: { contractors: 4 },
    });
    expect(wynik.ok).toBe(false);
    expect(wynik.errors.join('\n')).toMatch(/row_count_mismatch: contractors/);
  });

  it('stopka pliku niezgodna z liczbą jego wierszy: błąd row_count_mismatch', async () => {
    const tabele = { contractors: kontrahenci(3) };
    const { wynik } = await weryfikuj(plikLiniowy(tabele, { stopka: { contractors: 5 } }), {
      tabeleWBazie: tabele,
      rowCounts: { contractors: 5 },
    });
    expect(wynik.ok).toBe(false);
    expect(wynik.errors.join('\n')).toMatch(/row_count_mismatch: contractors/);
  });

  it('plik urwany na granicy linii (gzip poprawny, brak stopki): błąd', async () => {
    const tabele = { contractors: kontrahenci(3) };
    const tekst = plikLiniowy(tabele, { zmien: (linie) => linie.slice(0, -1) });
    const { wynik } = await weryfikuj(tekst, { tabeleWBazie: tabele, rowCounts: liczniki(tabele) });
    expect(wynik.ok).toBe(false);
    expect(wynik.errors[0]).toMatch(/^parse_failed/);
  });

  it('ucięty gzip: błąd parse_failed', async () => {
    const tabele = { invoices: kontrahenci(2000) };
    const gz = gzipSync(Buffer.from(plikLiniowy(tabele), 'utf8'));
    const { wynik } = await weryfikuj(gz.subarray(0, gz.length - 200), {
      tabeleWBazie: tabele,
      rowCounts: liczniki(tabele),
      checksum: sha(gz),
    });
    expect(wynik.ok).toBe(false);
    expect(wynik.errors.join('\n')).toMatch(/parse_failed/);
  });

  it('suma kontrolna inna niż w backup_log: błąd checksum_mismatch', async () => {
    const tabele = { contractors: kontrahenci(3) };
    const { wynik } = await weryfikuj(plikLiniowy(tabele), {
      tabeleWBazie: tabele,
      rowCounts: liczniki(tabele),
      checksum: 'a'.repeat(64),
    });
    expect(wynik.ok).toBe(false);
    expect(wynik.errors.join('\n')).toMatch(/checksum_mismatch/);
  });

  it('stara kopia jednoliniowa (sprzed zmiany) dalej przechodzi', async () => {
    const tabele = { contractors: kontrahenci(3), invoices: kontrahenci(5) };
    const tekst = plikJednoliniowy(tabele);
    expect(tekst.length).toBeLessThan(LIMIT_LINII_TESTOWY);
    const { wynik } = await weryfikuj(tekst, { tabeleWBazie: tabele, rowCounts: liczniki(tabele) });
    expect(wynik).toMatchObject({ ok: true, errors: [], warnings: [] });
  });

  it('stara kopia dłuższa niż limit linii: suma kontrolna sprawdzona, treść pominięta z ostrzeżeniem', async () => {
    const tabele = { invoices: kontrahenci(500) };
    const { wynik } = await weryfikuj(plikJednoliniowy(tabele), {
      tabeleWBazie: tabele,
      rowCounts: liczniki(tabele),
    });
    expect(wynik.ok).toBe(true);
    expect(wynik.warnings.join('\n')).toMatch(/legacy_snapshot_not_parsed/);

    const zlaSuma = await weryfikuj(plikJednoliniowy(tabele), {
      tabeleWBazie: tabele,
      rowCounts: liczniki(tabele),
      checksum: 'b'.repeat(64),
    });
    expect(zlaSuma.wynik.ok).toBe(false);
  });

  it('wiersz dłuższy niż limit linii: liczony, bez parsowania, z ostrzeżeniem', async () => {
    const tabele = { contractors: [...kontrahenci(2), { id: uuidNr(3), note: 'x'.repeat(LIMIT_LINII_TESTOWY * 2) }] };
    const { wynik, najdluzszyParse } = await weryfikuj(plikLiniowy(tabele), {
      tabeleWBazie: tabele,
      rowCounts: liczniki(tabele),
    });
    expect(wynik.ok).toBe(true);
    expect(wynik.warnings.join('\n')).toMatch(/row_not_parsed: contractors/);
    expect(najdluzszyParse).toBeLessThan(LIMIT_LINII_TESTOWY);
  });

  it('tabela bez kolumny id (flo_prefs): licznik bieżącego stanu działa, bez ostrzeżenia count_failed', async () => {
    const tabele = {
      contractors: kontrahenci(3),
      flo_prefs: [{ tenant_id: uuidNr(1, '11111111'), level: 'normal' }],
    };
    const { wynik } = await weryfikuj(plikLiniowy(tabele), { tabeleWBazie: tabele, rowCounts: liczniki(tabele) });
    expect(wynik.warnings.filter((w) => w.startsWith('count_failed'))).toEqual([]);
    expect(wynik.rowCountDiff).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: 'flo_prefs', snapshot: 1, current: 1 })]),
    );
  });
});
