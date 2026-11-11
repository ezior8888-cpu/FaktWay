import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SKIP_TABLES, SNAPSHOT_KEYS, snapshotKeyFor } from '@/lib/backup/snapshot-tables';

/**
 * Nocny backup (`cron.daily-db-snapshot`) czyta KAŻDĄ tabelę `public` jako
 * `service_role` i wywraca się na pierwszej, której przeczytać nie może.
 *
 * Tak było od wydania 25.09 do 28.09: 00078 i 00080 odebrały `service_role`
 * wszystkie prawa do czterech tabel obsługiwanych wyłącznie przez RPC
 * (słusznie, jeśli chodzi o zapis), a razem z zapisem poszedł odczyt.
 * Trzy noce bez kopii, zauważone dopiero w logach. Naprawa: 00098.
 *
 * Ten strażnik odtwarza z migracji, kto na koniec może czytać którą tabelę,
 * i wymaga odczytu `service_role` dla każdej tabeli spoza `SKIP_TABLES`.
 * Świadomie wąski: śledzi tylko `service_role` i tylko tabele, nie widoki.
 */

const KATALOG = join(process.cwd(), 'supabase/migrations');

/** Treść bez komentarzy i bez ciał funkcji (`$$ … $$`), podzielona na polecenia. */
function polecenia(sql: string): string[] {
  const czysty = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ');
  return czysty.split(';').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** `public.x`, `"x"`, `x` → `x`; inny schemat → null. */
function tabelaPublic(nazwa: string): string | null {
  const n = nazwa.trim().replace(/"/g, '');
  const kropka = n.lastIndexOf('.');
  if (kropka >= 0 && n.slice(0, kropka).toLowerCase() !== 'public') return null;
  return (kropka >= 0 ? n.slice(kropka + 1) : n).toLowerCase();
}

/** Czy lista uprawnień obejmuje pełny odczyt tabeli (nie kolumnowy). */
function dotyczyOdczytu(uprawnienia: string): boolean {
  return uprawnienia
    .split(',')
    .map((u) => u.trim().toUpperCase())
    .some((u) => u === 'ALL' || u === 'ALL PRIVILEGES' || u === 'SELECT');
}

/** Stan końcowy: tabela → czy `service_role` może ją czytać. */
function odczytServiceRole(pominPliki: ReadonlySet<string> = new Set()): Map<string, boolean> {
  const stan = new Map<string, boolean>();
  const pliki = readdirSync(KATALOG).filter((f) => f.endsWith('.sql') && !pominPliki.has(f)).sort();

  for (const plik of pliki) {
    for (const p of polecenia(readFileSync(join(KATALOG, plik), 'utf8'))) {
      const utworzona = /^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?([\w."]+)/i.exec(p);
      if (utworzona) {
        const t = tabelaPublic(utworzona[1]!);
        // Supabase daje service_role domyślnie komplet praw do nowych tabel.
        if (t && !stan.has(t)) stan.set(t, true);
        continue;
      }

      const usunieta = /^DROP TABLE (?:IF EXISTS )?(.+?)(?: CASCADE| RESTRICT)?$/i.exec(p);
      if (usunieta) {
        for (const n of usunieta[1]!.split(',')) {
          const t = tabelaPublic(n);
          if (t) stan.delete(t);
        }
        continue;
      }

      const zmianaNazwy = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([\w."]+) RENAME TO ([\w"]+)$/i.exec(p);
      if (zmianaNazwy) {
        const stara = tabelaPublic(zmianaNazwy[1]!);
        const nowa = tabelaPublic(zmianaNazwy[2]!);
        if (stara && nowa && stan.has(stara)) {
          stan.set(nowa, stan.get(stara)!);
          stan.delete(stara);
        }
        continue;
      }

      const prawo = /^(GRANT|REVOKE) (?!GRANT OPTION FOR)(.+?) ON (?:TABLE )?(.+?) (TO|FROM) (.+)$/i.exec(p);
      if (!prawo) continue;
      const [, rodzaj, uprawnienia, obiekty, , role] = prawo;
      if (!role!.split(',').some((r) => r.trim().toLowerCase() === 'service_role')) continue;
      if (!dotyczyOdczytu(uprawnienia!)) continue;
      const nadaje = rodzaj!.toUpperCase() === 'GRANT';

      if (/^ALL TABLES IN SCHEMA public$/i.test(obiekty!.trim())) {
        for (const t of stan.keys()) stan.set(t, nadaje);
        continue;
      }
      if (/^(FUNCTION|FUNCTIONS|SEQUENCE|SEQUENCES|SCHEMA|TYPE|ROUTINE|PROCEDURE|ALL )/i.test(obiekty!.trim())) continue;

      for (const n of obiekty!.split(',')) {
        const t = tabelaPublic(n);
        if (t && stan.has(t)) stan.set(t, nadaje);
      }
    }
  }
  return stan;
}

function nieczytelne(stan: Map<string, boolean>): string[] {
  return [...stan]
    .filter(([t, czyta]) => !czyta && !SKIP_TABLES.has(t))
    .map(([t]) => t)
    .sort();
}

describe('nocny backup czyta każdą tabelę', () => {
  it('service_role może czytać każdą tabelę public spoza SKIP_TABLES', () => {
    expect(
      nieczytelne(odczytServiceRole()),
      'Snapshot (lib/backup/db-snapshot.ts) czyta każdą tabelę jako service_role. ' +
        'Zabierz zapis, zostaw GRANT SELECT … TO service_role — albo dopisz tabelę do SKIP_TABLES z uzasadnieniem.',
    ).toEqual([]);
  });

  it('bez 00098 wskazuje dokładnie cztery tabele, które wywracały backup 26–28.09', () => {
    // Zgodne z produkcją przed 00098 (has_table_privilege, 28.09).
    expect(nieczytelne(odczytServiceRole(new Set(['00098_backup_read_stripe_service_tables.sql'])))).toEqual([
      'stripe_financial_case_refs',
      'stripe_financial_case_reopenings',
      'stripe_financial_case_reviews',
      'stripe_subscription_sync_leases',
    ]);
  });

  it('widzi jawne nadanie po odebraniu wszystkiego (00080: stripe_financial_cases)', () => {
    expect(odczytServiceRole().get('stripe_financial_cases')).toBe(true);
  });

  it('skan obejmuje rzeczywisty schemat', () => {
    expect(odczytServiceRole().size).toBeGreaterThan(50);
  });
});

/*
 * Plan skalowania 3000, sesja 12 (QAL-01): kopia czyta każdą tabelę stronami
 * po kluczu (`order` + „większy niż ostatni klucz”). Klucz musi być unikalny,
 * inaczej wiersze o tym samym kluczu na granicy strony przepadają po cichu.
 * Domyślny klucz to `id`; tabela bez unikalnego `id` musi mieć w
 * `SNAPSHOT_KEYS` swój klucz główny, kolumna w kolumnę.
 *
 * Strażnik odtwarza z migracji kolumny, klucze główne i unikalne `id`.
 * Pomija treść funkcji i bloków `DO` (jak strażnik wyżej), więc klucz
 * założony w bloku `DO` trzeba dopisać ręcznie albo zmienić migrację.
 */

interface KluczeTabeli {
  kolumny: Set<string>;
  pk: string[] | null;
  pkNazwa: string | null;
  unikalne: Array<{ nazwa: string; kolumny: string[] }>;
}

/** Jak `polecenia`, ale bez treści napisów: średnik w napisie nie dzieli polecenia. */
function poleceniaDDL(sql: string): string[] {
  const czysty = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
  return czysty.split(';').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const NAZWA = String.raw`("[^"]+"|\w+)`;

function nazwaKolumny(s: string): string {
  return s.trim().replace(/"/g, '').toLowerCase();
}

/** Dzieli po przecinkach poza nawiasami. */
function podziel(tekst: string): string[] {
  const wynik: string[] = [];
  let glebokosc = 0;
  let start = 0;
  for (let i = 0; i < tekst.length; i++) {
    if (tekst[i] === '(') glebokosc++;
    else if (tekst[i] === ')') glebokosc--;
    else if (tekst[i] === ',' && glebokosc === 0) {
      wynik.push(tekst.slice(start, i).trim());
      start = i + 1;
    }
  }
  wynik.push(tekst.slice(start).trim());
  return wynik.filter(Boolean);
}

/** Treść pierwszego nawiasu od pozycji `od` i to, co po nim. */
function nawias(tekst: string, od = 0): { srodek: string; reszta: string } | null {
  const start = tekst.indexOf('(', od);
  if (start < 0) return null;
  let glebokosc = 0;
  for (let i = start; i < tekst.length; i++) {
    if (tekst[i] === '(') glebokosc++;
    else if (tekst[i] === ')' && --glebokosc === 0) {
      return { srodek: tekst.slice(start + 1, i), reszta: tekst.slice(i + 1) };
    }
  }
  return null;
}

/** `(a, "b" DESC)` → `['a', 'b']`; wyrażenie (np. `lower(x)`) → null. */
function listaKolumn(srodek: string): string[] | null {
  const kolumny = srodek.split(',').map((k) => k.trim().replace(/ (ASC|DESC)$/i, ''));
  if (kolumny.some((k) => !/^("[^"]+"|\w+)$/.test(k))) return null;
  return kolumny.map(nazwaKolumny);
}

function dodajKolumne(s: KluczeTabeli, tabela: string, kolumna: string, definicja: string): void {
  s.kolumny.add(kolumna);
  if (/\bPRIMARY KEY\b/i.test(definicja)) {
    s.pk = [kolumna];
    s.pkNazwa = nazwaKolumny(/CONSTRAINT ("[^"]+"|\w+) PRIMARY KEY/i.exec(definicja)?.[1] ?? `${tabela}_pkey`);
  }
  if (/\bUNIQUE\b/i.test(definicja)) s.unikalne.push({ nazwa: `${tabela}_${kolumna}_key`, kolumny: [kolumna] });
}

/** Ograniczenie tabeli (`PRIMARY KEY (…)`, `UNIQUE (…)`, inne). Zwraca false, gdy to kolumna. */
function ograniczenie(s: KluczeTabeli, tabela: string, tekst: string, indeksy: Map<string, string[]>): boolean {
  const m = new RegExp(String.raw`^(?:CONSTRAINT ${NAZWA} )?(PRIMARY KEY|UNIQUE)\b(.*)$`, 'i').exec(tekst);
  if (!m) return /^(CONSTRAINT|FOREIGN KEY|CHECK|EXCLUDE|LIKE)\b/i.test(tekst);
  const [, nazwa, rodzaj, reszta] = m;
  const zIndeksu = new RegExp(String.raw`USING INDEX ${NAZWA}`, 'i').exec(reszta!);
  const kolumny = zIndeksu
    ? (indeksy.get(nazwaKolumny(zIndeksu[1]!)) ?? null)
    : listaKolumn(nawias(reszta!)?.srodek ?? '');
  if (!kolumny) return true;
  if (rodzaj!.toUpperCase() === 'PRIMARY KEY') {
    s.pk = kolumny;
    s.pkNazwa = nazwa ? nazwaKolumny(nazwa) : `${tabela}_pkey`;
  } else {
    s.unikalne.push({ nazwa: nazwa ? nazwaKolumny(nazwa) : `${tabela}_${kolumny.join('_')}_key`, kolumny });
  }
  return true;
}

function usunKolumne(s: KluczeTabeli, kolumna: string): void {
  s.kolumny.delete(kolumna);
  if (s.pk?.includes(kolumna)) s.pk = null;
  s.unikalne = s.unikalne.filter((u) => !u.kolumny.includes(kolumna));
}

function akcjaAlter(s: KluczeTabeli, tabela: string, akcja: string, indeksy: Map<string, string[]>): void {
  let m: RegExpExecArray | null;
  if ((m = /^ADD (?:COLUMN )?(?:IF NOT EXISTS )?(.*)$/i.exec(akcja))) {
    const tekst = m[1]!;
    if (ograniczenie(s, tabela, tekst, indeksy)) return;
    const kol = new RegExp(String.raw`^${NAZWA}(?: (.*))?$`).exec(tekst);
    if (kol) dodajKolumne(s, tabela, nazwaKolumny(kol[1]!), kol[2] ?? '');
    return;
  }
  if ((m = new RegExp(String.raw`^DROP CONSTRAINT (?:IF EXISTS )?${NAZWA}`, 'i').exec(akcja))) {
    const nazwa = nazwaKolumny(m[1]!);
    if (s.pkNazwa === nazwa) s.pk = null;
    s.unikalne = s.unikalne.filter((u) => u.nazwa !== nazwa);
    return;
  }
  if ((m = new RegExp(String.raw`^DROP (?:COLUMN )?(?:IF EXISTS )?${NAZWA}`, 'i').exec(akcja))) {
    usunKolumne(s, nazwaKolumny(m[1]!));
    return;
  }
  if ((m = new RegExp(String.raw`^RENAME CONSTRAINT ${NAZWA} TO ${NAZWA}$`, 'i').exec(akcja))) {
    const [stara, nowa] = [nazwaKolumny(m[1]!), nazwaKolumny(m[2]!)];
    if (s.pkNazwa === stara) s.pkNazwa = nowa;
    for (const u of s.unikalne) if (u.nazwa === stara) u.nazwa = nowa;
    return;
  }
  if ((m = new RegExp(String.raw`^RENAME (?:COLUMN )?${NAZWA} TO ${NAZWA}$`, 'i').exec(akcja))) {
    const [stara, nowa] = [nazwaKolumny(m[1]!), nazwaKolumny(m[2]!)];
    const zamien = (k: string) => (k === stara ? nowa : k);
    if (s.kolumny.delete(stara)) s.kolumny.add(nowa);
    if (s.pk) s.pk = s.pk.map(zamien);
    for (const u of s.unikalne) u.kolumny = u.kolumny.map(zamien);
  }
}

/** Stan końcowy z migracji: tabela → kolumny, klucz główny, unikalne kolumny. */
function kluczeZMigracji(): Map<string, KluczeTabeli> {
  const stan = new Map<string, KluczeTabeli>();
  const indeksy = new Map<string, string[]>();
  const pliki = readdirSync(KATALOG).filter((f) => f.endsWith('.sql')).sort();

  for (const plik of pliki) {
    for (const p of poleceniaDDL(readFileSync(join(KATALOG, plik), 'utf8'))) {
      let m: RegExpExecArray | null;
      if ((m = /^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?([\w."]+) ?\(/i.exec(p))) {
        const t = tabelaPublic(m[1]!);
        if (!t || stan.has(t)) continue;
        const s: KluczeTabeli = { kolumny: new Set(), pk: null, pkNazwa: null, unikalne: [] };
        stan.set(t, s);
        for (const element of podziel(nawias(p, m[0].length - 1)?.srodek ?? '')) {
          if (ograniczenie(s, t, element, indeksy)) continue;
          const kol = new RegExp(String.raw`^${NAZWA} (.*)$`).exec(element);
          if (kol) dodajKolumne(s, t, nazwaKolumny(kol[1]!), kol[2]!);
        }
        continue;
      }

      if ((m = /^DROP TABLE (?:IF EXISTS )?(.+?)(?: CASCADE| RESTRICT)?$/i.exec(p))) {
        for (const n of m[1]!.split(',')) {
          const t = tabelaPublic(n);
          if (t) stan.delete(t);
        }
        continue;
      }

      if ((m = /^CREATE UNIQUE INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(?:([\w."]+) )?ON (?:ONLY )?([\w."]+)/i.exec(p))) {
        const t = tabelaPublic(m[2]!);
        const kolumny = nawias(p, m[0].length);
        if (!t || !kolumny || /\bWHERE\b/i.test(kolumny.reszta)) continue;
        const lista = listaKolumn(kolumny.srodek);
        if (!lista) continue;
        const nazwa = m[1] ? nazwaKolumny(m[1].slice(m[1].lastIndexOf('.') + 1)) : `${t}_idx`;
        indeksy.set(nazwa, lista);
        stan.get(t)?.unikalne.push({ nazwa, kolumny: lista });
        continue;
      }

      if ((m = /^DROP INDEX (?:CONCURRENTLY )?(?:IF EXISTS )?(.+?)(?: CASCADE| RESTRICT)?$/i.exec(p))) {
        for (const n of m[1]!.split(',')) {
          const nazwa = nazwaKolumny(n.slice(n.lastIndexOf('.') + 1));
          indeksy.delete(nazwa);
          for (const s of stan.values()) s.unikalne = s.unikalne.filter((u) => u.nazwa !== nazwa);
        }
        continue;
      }

      if ((m = /^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?([\w."]+) (.+)$/i.exec(p))) {
        const t = tabelaPublic(m[1]!);
        const s = t ? stan.get(t) : undefined;
        if (!t || !s) continue;
        const nowaNazwa = /^RENAME TO ([\w"]+)$/i.exec(m[2]!);
        if (nowaNazwa) {
          const n = tabelaPublic(nowaNazwa[1]!);
          if (n) {
            stan.set(n, s);
            stan.delete(t);
          }
          continue;
        }
        for (const akcja of podziel(m[2]!)) akcjaAlter(s, t, akcja, indeksy);
      }
    }
  }
  return stan;
}

function maUnikalneId(s: KluczeTabeli): boolean {
  if (!s.kolumny.has('id')) return false;
  if (s.pk?.length === 1 && s.pk[0] === 'id') return true;
  return s.unikalne.some((u) => u.kolumny.length === 1 && u.kolumny[0] === 'id');
}

function bledyKluczy(stan: Map<string, KluczeTabeli>): string[] {
  const bledy: string[] = [];
  for (const [t, s] of [...stan].sort(([a], [b]) => a.localeCompare(b))) {
    if (SKIP_TABLES.has(t)) continue;
    const klucz = snapshotKeyFor(t);
    if (SNAPSHOT_KEYS.has(t)) {
      if (s.pk?.join(',') !== klucz.join(',')) {
        bledy.push(`${t}: SNAPSHOT_KEYS = [${klucz.join(', ')}], a klucz główny = [${s.pk?.join(', ') ?? 'brak'}]`);
      }
    } else if (!maUnikalneId(s)) {
      bledy.push(`${t}: brak unikalnej kolumny id, dopisz do SNAPSHOT_KEYS klucz główny [${s.pk?.join(', ') ?? 'brak'}]`);
    }
  }
  for (const t of SNAPSHOT_KEYS.keys()) {
    if (!stan.has(t) || SKIP_TABLES.has(t)) bledy.push(`${t}: wpis w SNAPSHOT_KEYS bez tabeli w kopii`);
  }
  return bledy;
}

describe('nocny backup czyta każdą tabelę po unikalnym kluczu', () => {
  const stan = kluczeZMigracji();

  it('każda tabela ma unikalny klucz kopii: id albo klucz główny z SNAPSHOT_KEYS', () => {
    expect(
      bledyKluczy(stan),
      'Kopia (lib/backup/db-snapshot.ts) czyta tabele stronami po kluczu. Tabela bez unikalnego id ' +
        'potrzebuje wpisu w SNAPSHOT_KEYS (lib/backup/snapshot-tables.ts) z kluczem głównym albo miejsca w SKIP_TABLES.',
    ).toEqual([]);
  });

  it('SNAPSHOT_KEYS to dokładnie tabele bez unikalnego id (strażnik nie przepuszcza wszystkiego)', () => {
    const bezId = [...stan]
      .filter(([t, s]) => !SKIP_TABLES.has(t) && !maUnikalneId(s))
      .map(([t]) => t)
      .sort();
    expect(bezId).toEqual([...SNAPSHOT_KEYS.keys()].sort());
  });

  it('odczytuje klucze z migracji: zwykły i złożony', () => {
    expect(stan.get('invoices')?.pk).toEqual(['id']);
    expect(stan.get('flo_decisions')?.pk).toEqual(['tenant_id', 'kind']);
    expect(snapshotKeyFor('invoices')).toEqual(['id']);
  });
});
