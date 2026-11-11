import { gunzipSync } from 'node:zlib';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { utworzAtrape, uuidNr, type AtrapaOpcje, type Wiersz } from '../helpers/kopia-json-atrapa';

/**
 * Plan skalowania 3000, sesja 12 (QAL-01): nocna kopia JSON czytała tabele
 * przez OFFSET bez ORDER BY. Postgres nie obiecuje wtedy kolejności między
 * zapytaniami, więc gdy między stronami w tabeli coś się zmieni, strony się
 * przesuwają: wiersz trafia do kopii dwa razy albo wcale.
 *
 * Kopia ma czytać stronami po kluczu (`order` + „większy niż ostatni klucz”),
 * do pustej strony, także dla tabel z kluczem złożonym.
 */

const state = vi.hoisted(() => ({
  atrapa: null as null | { admin: unknown },
  wgrane: [] as Buffer[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => state.atrapa!.admin,
}));
vi.mock('@/lib/backup/r2-backup-client', () => ({
  buildSnapshotKey: () => ({ full: 'backups/db/2026/11/11-010000.json.gz', relative: 'db/2026/11/11-010000.json.gz' }),
  uploadSnapshot: async (_key: string, body: Uint8Array) => {
    state.wgrane.push(Buffer.from(body));
  },
}));

import { createDbSnapshot } from '@/lib/backup/db-snapshot';

/** Stałe „tasowanie”: kolejność fizyczna inna niż kolejność kluczy. */
function potasuj<T>(wiersze: T[]): T[] {
  const wynik = [...wiersze];
  let ziarno = 12;
  for (let i = wynik.length - 1; i > 0; i--) {
    ziarno = (ziarno * 1103515245 + 12345) % 2147483648;
    const j = ziarno % (i + 1);
    [wynik[i], wynik[j]] = [wynik[j]!, wynik[i]!];
  }
  return wynik;
}

function faktury(n: number): Wiersz[] {
  return potasuj(
    Array.from({ length: n }, (_, i) => ({ id: uuidNr(i + 1), number: `FV/${i + 1}/2026`, gross: 123.45 })),
  );
}

async function kopia(opcje: AtrapaOpcje): Promise<Record<string, Wiersz[]>> {
  state.atrapa = utworzAtrape(opcje);
  await createDbSnapshot({ kind: 'daily', now: new Date('2026-11-11T01:00:00Z') });
  expect(state.wgrane).toHaveLength(1);
  const payload = JSON.parse(gunzipSync(state.wgrane[0]!).toString('utf8')) as {
    tables: Record<string, Wiersz[]>;
    row_counts: Record<string, number>;
  };
  for (const [tabela, wiersze] of Object.entries(payload.tables)) {
    expect(payload.row_counts[tabela], `row_counts.${tabela}`).toBe(wiersze.length);
  }
  return payload.tables;
}

function klucze(wiersze: Wiersz[], kolumny: string[]): string[] {
  return wiersze.map((w) => kolumny.map((k) => String(w[k])).join('|'));
}

/** Każdy wiersz istniejący przed kopią jest w niej dokładnie raz. */
function bezZgubIDubli(kopia: Wiersz[], przed: Wiersz[], kolumny: string[] = ['id']) {
  const wKopii = klucze(kopia, kolumny);
  const powtorzone = wKopii.filter((k, i) => wKopii.indexOf(k) !== i);
  const zgubione = klucze(przed, kolumny).filter((k) => !wKopii.includes(k));
  expect({ powtorzone, zgubione }).toEqual({ powtorzone: [], zgubione: [] });
}

beforeEach(() => {
  state.wgrane = [];
  state.atrapa = null;
});

describe('kopia JSON czyta tabele stronami po kluczu', () => {
  it('nowy wiersz dopisany między stronami (w wolne miejsce tabeli) nie dubluje innego wiersza', async () => {
    const przed = faktury(1500);
    const tabele = await kopia({
      tabele: { invoices: [...przed] },
      poOdczycie: (tabela, nr, t) => {
        // Po pierwszej stronie: INSERT trafia w wolne miejsce na początku tabeli.
        if (tabela === 'invoices' && nr === 1) t.invoices!.unshift({ id: uuidNr(9000), number: 'FV/NOWA', gross: 1 });
      },
    });
    bezZgubIDubli(tabele.invoices!, przed);
    // Klucz nowego wiersza jest za kursorem, więc wiersz trafia do tej samej kopii.
    expect(klucze(tabele.invoices!, ['id'])).toContain(uuidNr(9000));
  });

  it('wiersz zmieniony między stronami (nowa wersja na końcu tabeli) nie znika i nie dubluje się', async () => {
    const przed = faktury(1500);
    const tabele = await kopia({
      tabele: { invoices: [...przed] },
      poOdczycie: (tabela, nr, t) => {
        if (tabela !== 'invoices' || nr !== 1) return;
        // UPDATE zapisuje nową wersję wiersza na końcu tabeli.
        const [zmieniony] = t.invoices!.splice(10, 1);
        t.invoices!.push({ ...zmieniony!, gross: 999 });
      },
    });
    bezZgubIDubli(tabele.invoices!, przed);
  });

  it('serwer ucina odpowiedź poniżej rozmiaru strony: kopia czyta dalej, aż strona będzie pusta', async () => {
    const przed = faktury(700);
    const tabele = await kopia({ tabele: { invoices: [...przed] }, maxRows: 300 });
    bezZgubIDubli(tabele.invoices!, przed);
  });

  it('tabela z kluczem złożonym i znakami zastrzeżonymi PostgREST w kluczu: każdy wiersz raz', async () => {
    const rodzaje = [
      ...Array.from({ length: 400 }, (_, i) => `rodzaj_${String(i).padStart(3, '0')}`),
      'a,b',
      'x.y',
      'p(q)',
      'cytat "w środku"',
      'ukośnik\\wsteczny',
      'dwukropek:wartość',
      ' spacja',
    ];
    const przed = potasuj(
      [1, 2, 3].flatMap((t) =>
        rodzaje.map((kind) => ({ tenant_id: uuidNr(t, '11111111'), kind, accepted: 1 })),
      ),
    );
    const tabele = await kopia({
      tabele: { flo_decisions: [...przed], invoices: faktury(10) },
      poOdczycie: (tabela, nr, t) => {
        if (tabela === 'flo_decisions' && nr === 1) {
          t.flo_decisions!.unshift({ tenant_id: uuidNr(0, '11111111'), kind: 'nowy', accepted: 0 });
        }
      },
    });
    bezZgubIDubli(tabele.flo_decisions!, przed, ['tenant_id', 'kind']);
  });
});
