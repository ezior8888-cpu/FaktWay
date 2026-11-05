import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ORIGINAL_RECHECK_KINDS } from '@/lib/ksef/duplicate-check';
import { DUPLICATE_DECISION_SQL_TEXTS } from '@/lib/ksef/duplicate-decision';
import type { DuplicateDecisionSqlTextKey } from '@/lib/ksef/duplicate-decision';
import {
  ORIGINAL_IMPORT_BUYER_ID_TYPES,
  ORIGINAL_IMPORT_INVOICE_KEYS,
  ORIGINAL_IMPORT_LINE_KEYS,
  ORIGINAL_IMPORT_VAT_RATES,
} from '@/lib/ksef/duplicate-original-projection';

/**
 * Strażnik tekstu migracji 00156 (D-A4-1b-3 PR C, zapis oryginału z oznaczeniem
 * FaktWay; spec v3 7.2 wiersz `zapis-oryginalu-migracja`, sekcje 4.1–4.14).
 * Zachowanie sprawdza baza (`tests/rls-zapis-oryginalu.test.ts`, job „RLS
 * isolation”); tu tylko to, czego baza nie widzi: kształt pliku, REVOKE/GRANT,
 * dosłowne teksty odmów, zgodność list SQL z ich lustrami w TS i dosłowne
 * instrukcje oraz odmowy 00151 w trybie `retire` (INV-14).
 *
 * Numer: rezerwacja PR C 00149 przeszła na 00156, bo 00151 (marka FaktWay)
 * i 00155 (synchronizacja historii) przepisały po niej `decide_ksef_duplicate`,
 * `guard_ksef_retired_draft` i `ksef_lifecycle_violations`. Dlatego 00156 jest
 * pisana na ciałach 00151 i 00155 — pilnują tego przypadki „= ciało z 00151 /
 * 00155” niżej (wzór: U16a w `ksef-decyzja-duplikatu-migracja.test.ts`).
 *
 * Lekser SQL jak w `ksef-decyzja-duplikatu-migracja.test.ts` (komentarze `--`
 * i `/* *\/`, literały `'…'`, ciała `$tag$…$tag$`): nagłówek 00156 mówi
 * „DROP FUNCTION”, „bez DML”, a komentarze w SQL — „DELETE”, więc zakazane
 * operacje szukamy dopiero poza komentarzami i literałami. Każdy przypadek
 * czyta plik sam, żeby padał osobno.
 */

const M156 = 'supabase/migrations/00156_ksef_duplicate_original.sql';
/** Ostatnie definicje przed 00156: decyzja i wyzwalacz w marce FaktWay (00151), strażnik z I3 przez predykat (00155). */
const M151 = 'supabase/migrations/00151_faktway_duplicate_decision_texts.sql';
const M155 = 'supabase/migrations/00155_ksef_history_sync.sql';

const read = (path: string): string => readFileSync(path, 'utf8');

type Part = { kind: 'code' | 'comment' | 'literal' | 'body'; text: string };

/** Lekser SQL: kod, komentarze, literały `'…'` (z `''`), ciała `$tag$…$tag$`. */
function lex(sql: string): Part[] {
  const parts: Part[] = [];
  let start = 0;
  let i = 0;
  const push = (kind: Part['kind'], end: number) => {
    if (end > start) parts.push({ kind, text: sql.slice(start, end) });
    start = end;
  };
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      push('code', i);
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      push('comment', i);
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      push('code', i);
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 2;
      push('comment', i);
      continue;
    }
    if (c === "'") {
      push('code', i);
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j += 1;
      }
      i = Math.min(j + 1, sql.length);
      push('literal', i);
      continue;
    }
    if (c === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        push('code', i);
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? sql.length : close + tag.length;
        push('body', i);
        continue;
      }
    }
    if (c === '"') {
      const close = sql.indexOf('"', i + 1);
      i = close === -1 ? sql.length : close + 1;
      continue;
    }
    i += 1;
  }
  push('code', sql.length);
  return parts;
}

/** Zwija białe znaki. */
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** Postać kanoniczna do porównań: bez białych znaków przy nawiasach, przecinkach i operatorach. */
const tight = (s: string): string => squash(s).replace(/\s*([(),;=<>!:+\-*/|])\s*/g, '$1');
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Statement {
  /** Instrukcja poza ciałami funkcji i komentarzami, literały zostają. */
  text: string;
  /** To samo z literałami zamienionymi na `''` (skan DML/DROP). */
  bare: string;
}

/** Instrukcje najwyższego poziomu (ciała funkcji jako `$$…$$`, bez komentarzy). */
function statements(sql: string): Statement[] {
  const out: Statement[] = [];
  let text = '';
  let bare = '';
  const flush = () => {
    if (squash(bare)) out.push({ text: squash(text), bare: squash(bare) });
    text = '';
    bare = '';
  };
  for (const part of lex(sql)) {
    if (part.kind === 'code') {
      const pieces = part.text.split(';');
      pieces.forEach((piece, idx) => {
        text += piece;
        bare += piece;
        if (idx < pieces.length - 1) flush();
      });
    } else if (part.kind === 'literal') {
      text += part.text;
      bare += "''";
    } else if (part.kind === 'body') {
      text += ' $$…$$ ';
      bare += ' $$…$$ ';
    } else {
      text += ' ';
      bare += ' ';
    }
  }
  flush();
  return out;
}

/** Ciała funkcji (bez ograniczników `$$`) według nazwy z `FUNCTION public.<nazwa>(`. */
function functionBodies(sql: string): Map<string, string[]> {
  const bodies = new Map<string, string[]>();
  let header = '';
  for (const part of lex(sql)) {
    if (part.kind === 'code') {
      const lastSemicolon = part.text.lastIndexOf(';');
      header = lastSemicolon === -1 ? header + part.text : part.text.slice(lastSemicolon + 1);
    } else if (part.kind === 'body') {
      const name = /FUNCTION\s+public\.(\w+)\s*\(/i.exec(header)?.[1] ?? '(anonimowe)';
      const tag = /^\$[^$]*\$/.exec(part.text)![0];
      bodies.set(name, [...(bodies.get(name) ?? []), part.text.slice(tag.length, part.text.length - tag.length)]);
    }
  }
  return bodies;
}

/** Kod ciała bez komentarzy (literały zostają), w postaci kanonicznej. */
const normBody = (body: string): string => tight(lex(body).filter((p) => p.kind !== 'comment').map((p) => p.text).join(' '));
/** Kod ciała bez komentarzy i literałów (skan zakazanych operacji). */
const bodyCode = (body: string): string => lex(body).filter((p) => p.kind === 'code').map((p) => p.text).join(' ');
/** Tekst bez komentarzy, literały zostają (RAISE, listy literałów). */
const withoutComments = (sql: string): string => lex(sql).map((p) => (p.kind === 'comment' ? ' ' : p.text)).join('');

/** Jedyne ciało funkcji w pliku migracji; brak funkcji = czerwień z komunikatem, nie wyjątek testu. */
function bodyOf(sql: string, fn: string): string {
  const bodies = functionBodies(sql).get(fn);
  expect(bodies?.length ?? 0, `brak funkcji public.${fn}`).toBe(1);
  return bodies![0]!;
}

/** Dzieli po przecinkach najwyższego poziomu (poza nawiasami i literałami). */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (c === "'") {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'") {
          if (text[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j += 1;
      }
      current += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    if (c === ')' || c === ']' || c === '}') depth -= 1;
    if (c === ',' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  out.push(current);
  return out;
}

/** Od końca szablonu RAISE do średnika poza literałami, rozbite na argumenty i klauzule `USING`. */
function splitRaise(rest: string): { args: string[]; using: string[] } {
  let depth = 0;
  let usingAt = -1;
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i]!;
    if (c === "'") {
      let j = i + 1;
      while (j < rest.length) {
        if (rest[j] === "'") {
          if (rest[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    if (c === '(' || c === '[') depth += 1;
    if (c === ')' || c === ']') depth -= 1;
    if (depth === 0 && /^USING\b/i.test(rest.slice(i)) && !/\w/.test(rest[i - 1] ?? ' ')) {
      usingAt = i;
      break;
    }
  }
  const argsText = usingAt === -1 ? rest : rest.slice(0, usingAt);
  const usingText = usingAt === -1 ? '' : rest.slice(usingAt + 'USING'.length);
  const clean = (items: string[]) => items.map((s) => s.trim()).filter((s) => s !== '');
  return { args: clean(splitTopLevel(argsText)), using: clean(splitTopLevel(usingText)) };
}

/** Każde `RAISE EXCEPTION '<szablon>'` w kodzie (bez komentarzy): reszta instrukcji po szablonie. */
function raisesOf(code: string, template: string): string[] {
  const out: string[] = [];
  for (const match of code.matchAll(new RegExp(`RAISE\\s+EXCEPTION\\s+'${escapeRegExp(template)}'`, 'g'))) {
    let j = match.index + match[0].length;
    let inLiteral = false;
    let rest = '';
    while (j < code.length && (inLiteral || code[j] !== ';')) {
      if (code[j] === "'") inLiteral = !inLiteral;
      rest += code[j];
      j += 1;
    }
    out.push(rest);
  }
  return out;
}

/** Wartość klauzuli `USING <klucz> = <wartość>` (klucz bez rozróżniania wielkości liter). */
function usingValue(using: string[], key: string): string | undefined {
  for (const item of using) {
    const eq = item.indexOf('=');
    if (eq !== -1 && item.slice(0, eq).trim().toUpperCase() === key) return item.slice(eq + 1).trim();
  }
  return undefined;
}

/** Listy literałów w kodzie: `(…, …)`, `[…, …]` (ARRAY) i `'{a,b}'` — do porównań z listami TS. */
function literalLists(code: string): string[][] {
  const lists: string[][] = [];
  for (const m of code.matchAll(/[([]\s*((?:'(?:[^']|'')*'\s*,\s*)*'(?:[^']|'')*')\s*[)\]]/g)) {
    lists.push([...m[1]!.matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]!.replace(/''/g, "'")));
  }
  for (const m of code.matchAll(/'\{([^}']*)\}'/g)) {
    lists.push(m[1]!.split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter((x) => x !== ''));
  }
  return lists;
}

/** Postać kanoniczna listy (bez kolejności) — porównujemy zbiory. */
const canon = (items: readonly string[]): string => [...items].sort().join(',');

// ─── Kontrakt funkcji 00156 (spec v3 4.1–4.9; kolejność jak w nagłówku migracji) ───────────────

type Access = 'service_role' | 'authenticated' | 'trigger';

interface FunctionSpec {
  /** Numer w nagłówku 00156 (1–15; punkt 16 to COMMENT na kolumnie). */
  n: number;
  name: string;
  /** „nazwa typ [DEFAULT …]” w kolejności z sygnatury. */
  params: readonly string[];
  returns: string;
  language: 'sql' | 'plpgsql';
  security: 'INVOKER' | 'DEFINER';
  volatility: 'IMMUTABLE' | 'STABLE' | 'VOLATILE';
  /** Kto dostaje EXECUTE: tylko service_role, funkcja 7 także authenticated, wyzwalacz — nikt. */
  access: Access;
}

const INVOICE_AND_TENANT = ['p_invoice_id uuid', 'p_tenant_id uuid'] as const;
const DECISION_ARGS_9 = [
  'p_invoice_id uuid', 'p_tenant_id uuid', 'p_actor_user_id uuid', 'p_choice text', 'p_via text',
  'p_original_ksef_number text', 'p_original_sha256 text', 'p_env text',
] as const;

const FUNCTIONS: readonly FunctionSpec[] = [
  { n: 1, name: 'ksef_duplicate_check_allows', params: ['p_check jsonb', 'p_choice text'], returns: 'boolean', language: 'sql', security: 'INVOKER', volatility: 'IMMUTABLE', access: 'service_role' },
  { n: 2, name: 'ksef_duplicate_own_history', params: [...INVOICE_AND_TENANT, 'p_original_session text', 'p_sha256 text'], returns: 'boolean', language: 'sql', security: 'INVOKER', volatility: 'STABLE', access: 'service_role' },
  { n: 3, name: 'ksef_duplicate_gate_ok', params: ['p_gate jsonb'], returns: 'boolean', language: 'plpgsql', security: 'INVOKER', volatility: 'IMMUTABLE', access: 'service_role' },
  { n: 4, name: 'ksef_duplicate_original_offer', params: ['p_check jsonb', 'p_own_history_db boolean'], returns: 'text', language: 'plpgsql', security: 'INVOKER', volatility: 'IMMUTABLE', access: 'service_role' },
  { n: 5, name: 'ksef_duplicate_cross_tenant', params: ['p_tenant_id uuid', 'p_ksef_number text', 'p_internal_number text'], returns: 'boolean', language: 'sql', security: 'INVOKER', volatility: 'STABLE', access: 'service_role' },
  { n: 6, name: 'ksef_duplicate_decision_blocker', params: INVOICE_AND_TENANT, returns: 'text', language: 'plpgsql', security: 'INVOKER', volatility: 'STABLE', access: 'service_role' },
  { n: 7, name: 'ksef_duplicate_decision_blocker_for_session', params: ['p_invoice_id uuid'], returns: 'text', language: 'plpgsql', security: 'DEFINER', volatility: 'STABLE', access: 'authenticated' },
  {
    n: 8,
    name: 'ksef_original_import_mismatch',
    params: ['p_import jsonb', 'p_inv public.invoices', 'p_marker public.ksef_submissions', 'p_tenant_id uuid', 'p_tenant_nip text', 'p_offer text'],
    returns: 'text', language: 'plpgsql', security: 'INVOKER', volatility: 'STABLE', access: 'service_role',
  },
  {
    n: 9,
    name: 'ksef_duplicate_decide_core',
    params: ['p_mode text', 'p_offer text', ...DECISION_ARGS_9, 'p_note text', 'p_import jsonb'],
    returns: 'jsonb', language: 'plpgsql', security: 'INVOKER', volatility: 'VOLATILE', access: 'service_role',
  },
  {
    n: 10,
    name: 'decide_ksef_duplicate',
    params: [...DECISION_ARGS_9, 'p_note text DEFAULT NULL'],
    returns: 'jsonb', language: 'sql', security: 'INVOKER', volatility: 'VOLATILE', access: 'service_role',
  },
  {
    n: 11,
    name: 'decide_ksef_duplicate_original',
    params: [...DECISION_ARGS_9, 'p_note text', 'p_mode text', 'p_offer text', 'p_import jsonb'],
    returns: 'jsonb', language: 'sql', security: 'INVOKER', volatility: 'VOLATILE', access: 'service_role',
  },
  {
    n: 12,
    name: 'release_ksef_original_review',
    params: ['p_invoice_id uuid', 'p_tenant_id uuid', 'p_actor_user_id uuid', 'p_original_ksef_number text', 'p_original_sha256 text', 'p_env text', 'p_note text'],
    returns: 'jsonb', language: 'plpgsql', security: 'INVOKER', volatility: 'VOLATILE', access: 'service_role',
  },
  {
    n: 13,
    name: 'flag_ksef_original_recheck',
    params: ['p_invoice_id uuid', 'p_tenant_id uuid', 'p_actor_user_id uuid', 'p_original_ksef_number text', 'p_original_sha256 text', 'p_kind text'],
    returns: 'jsonb', language: 'plpgsql', security: 'INVOKER', volatility: 'VOLATILE', access: 'service_role',
  },
  { n: 14, name: 'guard_ksef_retired_draft', params: [], returns: 'trigger', language: 'plpgsql', security: 'INVOKER', volatility: 'VOLATILE', access: 'trigger' },
  // Zwracany typ (`TABLE (…)`) zostaje z 00148 — Postgres nie pozwala go zmienić w CREATE OR REPLACE.
  { n: 15, name: 'ksef_lifecycle_violations', params: [], returns: '', language: 'plpgsql', security: 'DEFINER', volatility: 'STABLE', access: 'service_role' },
];

const COLUMN_COMMENT_TARGET = 'public.ksef_submissions.original_check';

/** Typy parametrów do `REVOKE/GRANT/COMMENT … ON FUNCTION f(<typy>)`. */
const argTypes = (spec: FunctionSpec): string => spec.params.map((p) => p.split(/\s+/)[1]!).join(', ');
/** Sygnatura do porównań: bez `public.` (typy `public.invoices` i `invoices` to to samo), małe litery. */
const normSig = (s: string): string => squash(s).replace(/public\./gi, '').replace(/\s*,\s*/g, ', ').toLowerCase();

interface FunctionHeader {
  name: string;
  params: string[];
  tail: string;
}

/** Nagłówek `CREATE OR REPLACE FUNCTION public.<nazwa>(<parametry>) <reszta do AS>`. */
function parseHeader(stmt: Statement): FunctionHeader | undefined {
  const m = /^CREATE OR REPLACE FUNCTION public\.(\w+)\s*\(/i.exec(stmt.text);
  if (!m) return undefined;
  let depth = 1;
  let i = m[0].length;
  while (i < stmt.text.length && depth > 0) {
    if (stmt.text[i] === '(') depth += 1;
    else if (stmt.text[i] === ')') depth -= 1;
    i += 1;
  }
  return {
    name: m[1]!,
    params: splitTopLevel(stmt.text.slice(m[0].length, i - 1)).map(squash).filter((p) => p !== ''),
    tail: stmt.text.slice(i),
  };
}

const createStatements = (stmts: Statement[]): Array<{ stmt: Statement; header: FunctionHeader }> =>
  stmts.flatMap((stmt) => {
    const header = parseHeader(stmt);
    return header ? [{ stmt, header }] : [];
  });

interface Acl {
  kind: 'REVOKE' | 'GRANT';
  fn: string;
  args: string;
  roles: string[];
}

/** `REVOKE|GRANT ALL|EXECUTE ON FUNCTION public.f(<typy>) FROM|TO <role…>`. */
function aclOf(stmts: Statement[]): Acl[] {
  const out: Acl[] = [];
  for (const s of stmts) {
    const m = /^(REVOKE|GRANT)\s+(?:ALL|EXECUTE)(?:\s+PRIVILEGES)?\s+ON\s+FUNCTION\s+public\.(\w+)\s*\((.*?)\)\s+(?:FROM|TO)\s+(.+)$/i.exec(s.bare);
    if (m) {
      out.push({
        kind: m[1]!.toUpperCase() as Acl['kind'],
        fn: m[2]!,
        args: normSig(m[3]!),
        roles: m[4]!.split(',').map((r) => r.trim().toLowerCase()),
      });
    }
  }
  return out;
}

describe('strażnik tekstu migracji 00156 (D-A4-1b-3 PR C, zapis oryginału z oznaczeniem FaktWay)', () => {
  it('U16a-00156: jedna transakcja BEGIN … COMMIT z 15 funkcjami (CREATE OR REPLACE), REVOKE/GRANT/COMMENT; poza ciałami funkcji żadnego DROP, TRUNCATE, DELETE ani UPDATE', () => {
    const m156 = read(M156);
    const stmts = statements(m156);
    const first = (s: Statement) => s.bare.split(' ')[0]!.toUpperCase();

    // Nagłówek 4.1: funkcje 1–15; punkt 16 to COMMENT na kolumnie. Kolejność plików nie ma znaczenia, zbiór — tak.
    const creates = stmts.filter((s) => first(s) === 'CREATE');
    expect(creates.filter((s) => !/^CREATE OR REPLACE FUNCTION public\.\w+\s*\(/i.test(s.bare)).map((s) => s.bare),
      '00156 tworzy tylko funkcje (CREATE OR REPLACE FUNCTION) — bez tabel, indeksów i wyzwalaczy').toEqual([]);
    const created = createStatements(stmts).map(({ header }) => header.name);
    expect([...created].sort()).toEqual(FUNCTIONS.map((f) => f.name).sort());
    expect(new Set(created).size, 'każda funkcja dokładnie raz').toBe(FUNCTIONS.length);

    expect(first(stmts[0]!)).toBe('BEGIN');
    expect(first(stmts[stmts.length - 1]!)).toBe('COMMIT');
    const allowed = new Set(['BEGIN', 'COMMIT', 'CREATE', 'REVOKE', 'GRANT', 'COMMENT']);
    // Bez DROP (także DROP TABLE/COLUMN/TRIGGER), TRUNCATE, DELETE, UPDATE, INSERT, ALTER: DML tylko w ciałach funkcji.
    expect(stmts.filter((s) => !allowed.has(first(s))).map((s) => s.bare)).toEqual([]);

    // Także w ciałach: bez kasowania danych i zmiany schematu.
    for (const [name, bodies] of functionBodies(m156)) {
      for (const body of bodies) {
        expect(bodyCode(body), name).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|DROP|ALTER\s+TABLE)\b/i);
      }
    }
  });

  it('U16b-00156: sygnatury, zwracany typ, język, SECURITY i zmienność funkcji = kontrakt PR C (4.1–4.9); SET search_path = \'\'; DEFAULT tylko w opakowaniu 9-arg', () => {
    const created = createStatements(statements(read(M156)));

    for (const spec of FUNCTIONS) {
      const found = created.filter(({ header }) => header.name === spec.name);
      expect(found, `${spec.n}. ${spec.name}: CREATE OR REPLACE FUNCTION`).toHaveLength(1);
      const { stmt, header } = found[0]!;

      expect(header.params.map(normSig), `${spec.name}: parametry`).toEqual(spec.params.map(normSig));
      expect(tight(header.tail), `${spec.name}: SET search_path`).toContain(tight("SET search_path = ''"));

      const language = /\bLANGUAGE\s+(\w+)/i.exec(header.tail)?.[1]?.toLowerCase();
      expect(language, `${spec.name}: język`).toBe(spec.language);
      const security = /\bSECURITY\s+(DEFINER|INVOKER)\b/i.exec(header.tail)?.[1]?.toUpperCase() ?? 'INVOKER';
      expect(security, `${spec.name}: SECURITY`).toBe(spec.security);
      const volatility = /\b(IMMUTABLE|STABLE|VOLATILE)\b/i.exec(header.tail)?.[1]?.toUpperCase() ?? 'VOLATILE';
      expect(volatility, `${spec.name}: zmienność (funkcje zapisujące nie mogą być STABLE)`).toBe(spec.volatility);
      if (spec.returns !== '') {
        const returns = /^\s*RETURNS\s+(.+?)\s+(?:LANGUAGE|IMMUTABLE|STABLE|VOLATILE|SECURITY|PARALLEL|SET|AS)\b/i.exec(header.tail)?.[1];
        expect(returns && normSig(returns), `${spec.name}: RETURNS`).toBe(normSig(spec.returns));
      }
      expect(stmt.text, `${spec.name}: ciało w $$…$$`).toContain('$$…$$');
    }

    // Opakowanie 9-arg ma jedyną wartość domyślną (p_note); nowa funkcja `_original` — bez wartości domyślnych
    // (PostgREST rozwiązuje przeciążenie po nazwach argumentów, 4.6).
    for (const { header } of created) {
      const defaults = header.params.filter((p) => /\bDEFAULT\b|=/i.test(p));
      expect(defaults.map(normSig), `${header.name}: DEFAULT`).toEqual(header.name === 'decide_ksef_duplicate' ? ['p_note text default null'] : []);
    }
  });

  it('U16c-00156: REVOKE FROM PUBLIC, anon, authenticated i GRANT tylko service_role (funkcja 7: authenticated, nie anon); wyzwalacz bez GRANT; COMMENT na każdej funkcji i na original_check', () => {
    const m156 = read(M156);
    const stmts = statements(m156);
    const acl = aclOf(stmts);

    for (const spec of FUNCTIONS) {
      if (spec.access === 'trigger') continue;
      const sig = normSig(argTypes(spec));
      const mine = acl.filter((a) => a.fn === spec.name);
      expect(mine.filter((a) => a.args !== sig).map((a) => `${a.kind} ${a.args}`), `${spec.name}: ACL tylko dla własnej sygnatury`).toEqual([]);
      expect(mine.length, `${spec.n}. ${spec.name}: REVOKE/GRANT`).toBeGreaterThan(0);

      const revoked = new Set(mine.filter((a) => a.kind === 'REVOKE').flatMap((a) => a.roles));
      const granted = new Set(mine.filter((a) => a.kind === 'GRANT').flatMap((a) => a.roles));
      expect([...revoked].sort(), `${spec.name}: REVOKE`).toEqual(expect.arrayContaining(['anon', 'public']));
      if (spec.access === 'service_role') {
        expect([...revoked].sort(), `${spec.name}: REVOKE authenticated`).toEqual(['anon', 'authenticated', 'public']);
        expect([...granted], `${spec.name}: GRANT`).toEqual(['service_role']);
      } else {
        // Funkcja 7 (4.9): wywołuje ją sesja klienta — GRANT authenticated, anon i PUBLIC odebrane.
        expect(granted.has('authenticated'), `${spec.name}: GRANT authenticated`).toBe(true);
        expect([...granted].filter((r) => r !== 'authenticated' && r !== 'service_role'), `${spec.name}: GRANT tylko authenticated (i service_role)`).toEqual([]);
      }
    }

    // Wyzwalacz: CREATE OR REPLACE zachowuje ACL z 00148 — 00156 nie dopisuje mu żadnego GRANT.
    expect(acl.filter((a) => a.kind === 'GRANT' && a.fn === 'guard_ksef_retired_draft')).toEqual([]);
    expect(stmts.filter((s) => /^GRANT\b/i.test(s.bare) && /guard_ksef_retired_draft/.test(s.bare))).toEqual([]);
    expect(createStatements(stmts).filter(({ header }) => header.name === 'guard_ksef_retired_draft'),
      '14. guard_ksef_retired_draft: CREATE OR REPLACE').toHaveLength(1);

    // COMMENT na każdej funkcji (4.1) i na kolumnie original_check (punkt 16, 4.12).
    for (const spec of FUNCTIONS) {
      const sig = normSig(argTypes(spec));
      const comments = stmts.flatMap((s) => {
        const m = /^COMMENT ON FUNCTION public\.(\w+)\s*\((.*?)\)\s+IS\s+'(.+)'$/i.exec(s.text);
        return m && m[1] === spec.name && normSig(m[2]!) === sig ? [m[3]!] : [];
      });
      expect(comments, `${spec.n}. ${spec.name}: COMMENT ON FUNCTION`).toHaveLength(1);
      expect(comments[0]!.trim().length, `${spec.name}: COMMENT niepusty`).toBeGreaterThan(20);
    }
    const column = stmts.filter((s) => s.bare.startsWith(`COMMENT ON COLUMN ${COLUMN_COMMENT_TARGET} IS`));
    expect(column, '16. COMMENT ON COLUMN ksef_submissions.original_check').toHaveLength(1);
    // 4.12: opis nowych kluczy znacznika — importGate, recheckNeeded i dopiski do decision.
    expect(column[0]!.text).toContain('importGate');
    expect(column[0]!.text).toContain('recheckNeeded');
    expect(column[0]!.text).toContain('decision');
  });

  // U16e-00156 (spec 7.2): każdy nowy szablon DUPLICATE_DECISION_SQL_TEXTS stoi dosłownie po `RAISE EXCEPTION '`.
  // Funkcja-gospodarz wg 4.6 (core: blokada, powtórzenie, oferta, wybór, projekcja) i 4.11 (wyzwalacz szkicu wycofanego).
  const HOST_00156: ReadonlyArray<readonly [DuplicateDecisionSqlTextKey, string]> = [
    ['known-now', 'ksef_duplicate_decide_core'],
    ['cross-tenant', 'ksef_duplicate_decide_core'],
    ['recheck-needed', 'ksef_duplicate_decide_core'],
    ['provenance-review', 'ksef_duplicate_decide_core'],
    ['CHOICE', 'ksef_duplicate_decide_core'],
    ['IMPORT_MISMATCH', 'ksef_duplicate_decide_core'],
    ['ALREADY_IMPORTED', 'ksef_duplicate_decide_core'],
    ['TRIGGER_SAME_IMPORTED', 'guard_ksef_retired_draft'],
    ['TRIGGER_OTHER_IMPORTED', 'guard_ksef_retired_draft'],
    ['TRIGGER_DELETE_IMPORTED', 'guard_ksef_retired_draft'],
    ['TRIGGER_RENUMBER_IMPORTED', 'guard_ksef_retired_draft'],
    ['TRIGGER_DIRECTION_IMPORTED', 'guard_ksef_retired_draft'],
  ];

  /** 4.14: `DETAIL` odmowy (czyta go akcja przez `DuplicateRpcError.details`). */
  const EXPECTED_DETAIL: Partial<Record<DuplicateDecisionSqlTextKey, string>> = {
    'known-now': 'known-now',
    'cross-tenant': 'cross-tenant',
    'recheck-needed': 'recheck-needed',
    'provenance-review': 'provenance-review',
    CHOICE: 'choice',
    ALREADY_IMPORTED: 'already',
  };

  it('U16e-00156: lista kluczy 00156 jest w DUPLICATE_DECISION_SQL_TEXTS (6.3), każdy z gospodarzem', () => {
    const keys = HOST_00156.map(([key]) => key);
    expect(new Set(keys).size).toBe(12);
    for (const key of keys) {
      expect(DUPLICATE_DECISION_SQL_TEXTS[key], key).toBeDefined();
    }
    // Gospodarze istnieją w 00156 (czerwień do czasu migracji).
    const bodies = functionBodies(read(M156));
    for (const host of new Set(HOST_00156.map(([, h]) => h))) {
      expect(bodies.get(host)?.length ?? 0, `00156: brak funkcji public.${host}`).toBe(1);
    }
  });

  it.each(HOST_00156)(
    'U16e-00156: szablon %s stoi dosłownie po RAISE EXCEPTION w %s — ERRCODE P0001, liczba argumentów = arity, DETAIL wg 4.14, nigdy w format()',
    (key, host) => {
      const m156 = read(M156);
      const { template, arity } = DUPLICATE_DECISION_SQL_TEXTS[key];
      const code = withoutComments(bodyOf(m156, host));

      expect(m156, `${key}: format()`).not.toMatch(new RegExp(`format\\s*\\(\\s*'${escapeRegExp(template)}`));
      const raises = raisesOf(code, template);
      expect(raises.length, `${key}: brak RAISE EXCEPTION '<szablon>' w ${host}`).toBeGreaterThan(0);

      for (const rest of raises) {
        const { args, using } = splitRaise(rest);
        expect(args, `${key}: argumenty RAISE (${args.join(' | ')})`).toHaveLength(arity);
        expect(usingValue(using, 'ERRCODE'), `${key}: ERRCODE`).toBe("'P0001'");

        const detail = usingValue(using, 'DETAIL');
        if (key === 'IMPORT_MISMATCH') {
          expect(detail, `${key}: DETAIL import-mismatch:<kod>`).toMatch(/^'import-mismatch:'\s*\|\|/);
        } else if (EXPECTED_DETAIL[key] !== undefined) {
          // Gałęzie blokady mogą podać kod zmienną `v_code` (DETAIL = kod, 4.6 krok 4).
          const expected = `'${EXPECTED_DETAIL[key]}'`;
          const viaCode = ['known-now', 'cross-tenant', 'recheck-needed', 'provenance-review'].includes(key) && detail === 'v_code';
          expect(viaCode || detail === expected, `${key}: DETAIL ${expected} (jest ${detail ?? 'brak'})`).toBe(true);
        }
      }
    },
  );

  it('tryb retire w core zawiera dosłownie instrukcje (a), (c), (d), (e) z 00151 (INV-14: 9-arg działa jak w 00151 = 00148 w marce FaktWay)', () => {
    const core = normBody(bodyOf(read(M156), 'ksef_duplicate_decide_core'));
    expect(core, "tryb 'retire'").toContain("'retire'");

    // 00151 to ostatnia definicja decide_ksef_duplicate przed 00156 (ciało 00148 z marką FaktWay w literałach).
    const stmts151 = statements(bodyOf(read(M151), 'decide_ksef_duplicate'));
    const pick = (label: string, test: (s: Statement) => boolean): Statement => {
      const found = stmts151.filter(test);
      expect(found, `00151 ${label}`).toHaveLength(1);
      return found[0]!;
    };

    const instructions: ReadonlyArray<readonly [string, Statement]> = [
      ['(a) wpisy → number_taken', pick('(a)', (s) => /^UPDATE public\.ksef_submissions s\b/i.test(s.bare))],
      ['(c) powrót do szkicu', pick('(c)', (s) => /^UPDATE public\.invoices\b/i.test(s.bare))],
      ['(d) audyt invoice.ksef_duplicate_decided', pick('(d)', (s) => s.text.includes("'invoice.ksef_duplicate_decided'"))],
      ['(e) audyt invoice.send_reset', pick('(e)', (s) => s.text.includes("'invoice.send_reset'"))],
    ];
    for (const [label, stmt] of instructions) {
      expect(core.includes(tight(stmt.text)), `${label}: instrukcja z 00151 nie stoi dosłownie w core`).toBe(true);
    }
  });

  it('tryb retire w core: każda odmowa decide_ksef_duplicate z 00151 stoi w core znak w znak — tekst FaktWay, argumenty i USING (INV-14; 00156 nie cofa zmiany marki)', () => {
    const code151 = withoutComments(bodyOf(read(M151), 'decide_ksef_duplicate'));
    const code156 = withoutComments(bodyOf(read(M156), 'ksef_duplicate_decide_core'));
    const templates = [...new Set([...code151.matchAll(/RAISE\s+EXCEPTION\s+'((?:[^']|'')*)'/g)].map((m) => m[1]!))];
    // 00151: 8 odmów technicznych 22023/42501, NOTE, ROLE, ALREADY, IN_FLIGHT, 15 gałęzi blokady, STALE, ENV, EVIDENCE.
    expect(templates.length).toBeGreaterThan(25);
    const missing: string[] = [];
    for (const template of templates) {
      const have = new Set(raisesOf(code156, template).map(tight));
      for (const rest of raisesOf(code151, template).map(tight)) {
        if (!have.has(rest)) missing.push(`${template} …${rest}`);
      }
    }
    expect(missing, 'odmowa z 00151 bez dosłownego odpowiednika w core 00156').toEqual([]);
  });

  it('14. guard_ksef_retired_draft = ciało z 00151 + krok 3b (teksty *_IMPORTED); bez zapisu oryginału teksty i kolejność 00151 znak w znak, nagłówek jak w 00151', () => {
    const T = DUPLICATE_DECISION_SQL_TEXTS;
    const body151 = normBody(bodyOf(read(M151), 'guard_ksef_retired_draft'));
    const body156 = normBody(bodyOf(read(M156), 'guard_ksef_retired_draft'));

    const declOld = tight('v_choice text;');
    const declNew = tight('v_choice text; v_imported text; v_retired text; v_old text;');
    const selectOld = tight("SELECT s.original_ksef_number, s.original_check->'decision'->>'choice' INTO v_k, v_choice");
    const selectNew = tight(`
      SELECT s.original_ksef_number,
             s.original_check->'decision'->>'choice',
             s.original_check->'decision'->>'importedInvoiceId',
             s.original_check->'decision'->>'retiredInternalNumber'
        INTO v_k, v_choice, v_imported, v_retired`);
    const step3 = tight(`
      IF NOT FOUND THEN
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END IF;`);
    // 4.11: v_old = dawny numer; kolejność jak kroki 5–7 (usunięcie, kierunek, numer, wyjście z draft).
    const step3b = tight(`
      IF v_imported IS NOT NULL AND v_k IS NOT NULL THEN
        v_old := COALESCE(v_retired, OLD.internal_number, 'bez numeru');
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION '${T.TRIGGER_DELETE_IMPORTED.template}', v_old, v_k USING ERRCODE = 'P0001';
        END IF;
        IF TG_NAME = 'c_guard_ksef_retired_draft_number' THEN
          IF NEW.direction IS DISTINCT FROM OLD.direction THEN
            RAISE EXCEPTION '${T.TRIGGER_DIRECTION_IMPORTED.template}', v_old, v_k USING ERRCODE = 'P0001';
          END IF;
          RAISE EXCEPTION '${T.TRIGGER_RENUMBER_IMPORTED.template}', v_old, v_k USING ERRCODE = 'P0001';
        END IF;
        IF v_choice = 'other_sale' THEN
          RAISE EXCEPTION '${T.TRIGGER_OTHER_IMPORTED.template}', v_old, v_old, v_k USING ERRCODE = 'P0001';
        END IF;
        RAISE EXCEPTION '${T.TRIGGER_SAME_IMPORTED.template}', v_old, v_k, v_old USING ERRCODE = 'P0001';
      END IF;`);
    for (const piece of [declOld, selectOld, step3]) {
      expect(body151.split(piece), `00151: ${piece}`).toHaveLength(2);
    }
    // Zastępowanie funkcją: `$'` i `$&` w napisie zastępującym to wzorce replace, nie tekst.
    const expected = tight(body151.replace(declOld, () => declNew).replace(selectOld, () => selectNew).replace(step3, () => `${step3} ${step3b}`));
    expect(body156).toBe(expected);

    const header = (sql: string) => createStatements(statements(sql))
      .filter(({ header: h }) => h.name === 'guard_ksef_retired_draft')
      .map(({ stmt }) => tight(stmt.text));
    expect(header(read(M156))).toEqual(header(read(M151)));
  });

  it('15. ksef_lifecycle_violations = ciało z 00155 (I3 przez ksef_upo_expected) + I3K po I3, I5 bez przeglądu pliku, I5D i I5R jednym zapytaniem; reszta znak w znak', () => {
    const body155 = normBody(bodyOf(read(M155), 'ksef_lifecycle_violations'));
    const body156 = normBody(bodyOf(read(M156), 'ksef_lifecycle_violations'));

    const i3End = tight('OR (public.ksef_upo_expected(i) AND NOT EXISTS (SELECT 1 FROM public.upo_receipts u WHERE u.invoice_id = i.id)) );');
    const i3k = tight(`
      RETURN QUERY
        SELECT 'I3K'::text, k.id, k.tenant_id,
               jsonb_build_object(
                 'ksef_number', k.ksef_number,
                 'no_session', NOT EXISTS (SELECT 1 FROM public.ksef_submissions s
                                            WHERE s.invoice_id = k.id AND s.tenant_id = k.tenant_id
                                              AND s.response_ksef_number = k.ksef_number
                                              AND s.session_reference_number IS NOT NULL),
                 'no_date', k.ksef_accepted_at IS NULL,
                 'upo_status', (SELECT u.status FROM public.upo_receipts u WHERE u.invoice_id = k.id))
          FROM public.invoices k
         WHERE k.id IN (SELECT CASE WHEN m.original_check->'decision'->>'importedInvoiceId'
                                         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                    THEN (m.original_check->'decision'->>'importedInvoiceId')::uuid END
                          FROM public.ksef_submissions m
                         WHERE m.status = 'number_taken'
                           AND m.original_check->'decision' ? 'importedInvoiceId')
           AND k.direction = 'outgoing'
           AND k.ksef_status = 'accepted'
           AND k.origin = 'ksef_import'
           AND (k.ksef_accepted_at IS NULL
                OR (NOT EXISTS (SELECT 1 FROM public.upo_receipts u
                                 WHERE u.invoice_id = k.id AND u.status IN ('downloaded', 'archived'))
                    AND NOT EXISTS (SELECT 1 FROM public.ksef_submissions s
                                     WHERE s.invoice_id = k.id AND s.tenant_id = k.tenant_id
                                       AND s.response_ksef_number = k.ksef_number
                                       AND s.session_reference_number IS NOT NULL)));`);
    // 4.10 pkt 1: NULL <> … = NULL — I5D wypada jak w 00148; przegląd pliku idzie do I5R; recheck-needed zostaje w I5.
    const i5Old = tight('AND public.ksef_duplicate_decision_blocker(s.invoice_id, s.tenant_id) IS NOT NULL;');
    const i5New = tight("AND public.ksef_duplicate_decision_blocker(s.invoice_id, s.tenant_id) <> 'provenance-review';");
    const lateralMarker = `
      FROM public.invoices i
      CROSS JOIN LATERAL (
        SELECT s.original_ksef_number, s.original_check, s.attempted_at
          FROM public.ksef_submissions s
         WHERE s.invoice_id = i.id AND s.tenant_id = i.tenant_id
           AND s.status IN ('intent', 'sent') AND s.original_ksef_number IS NOT NULL
         ORDER BY s.attempted_at DESC NULLS LAST, s.id
         LIMIT 1) m`;
    const i5dOld = tight(`
      RETURN QUERY
        SELECT 'I5D'::text, i.id, i.tenant_id,
               jsonb_build_object(
                 'original_ksef_number', m.original_ksef_number,
                 'reason', m.original_check->>'reason',
                 'env', m.original_check->>'env',
                 'checked_at', m.original_check->>'checkedAt',
                 'attempted_at', m.attempted_at,
                 'last_attempt_at', i.last_attempt_at)
        ${lateralMarker}
         WHERE i.direction = 'outgoing'
           AND i.ksef_status = 'failed'
           AND i.last_error_code = 'KSEF_DUPLICATE_RECONCILE'
           AND public.ksef_duplicate_decision_blocker(i.id, i.tenant_id) IS NULL;`);
    // 4.10 pkt 2: blokada liczona raz na fakturę (OFFSET 0), I5R tylko przy provenance-review.
    const i5dNew = tight(`
      RETURN QUERY
        SELECT CASE WHEN b.code IS NULL THEN 'I5D' ELSE 'I5R' END, i.id, i.tenant_id,
               jsonb_build_object(
                 'original_ksef_number', m.original_ksef_number,
                 'reason', m.original_check->>'reason',
                 'env', m.original_check->>'env',
                 'checked_at', m.original_check->>'checkedAt',
                 'attempted_at', m.attempted_at,
                 'last_attempt_at', i.last_attempt_at,
                 'problems', m.original_check->'importGate'->'problems')
        ${lateralMarker}
          CROSS JOIN LATERAL (
            SELECT public.ksef_duplicate_decision_blocker(i.id, i.tenant_id) AS code
            OFFSET 0) b
         WHERE i.direction = 'outgoing'
           AND i.ksef_status = 'failed'
           AND i.last_error_code = 'KSEF_DUPLICATE_RECONCILE'
           AND (b.code IS NULL OR b.code = 'provenance-review');`);

    for (const piece of [i3End, i5Old, i5dOld]) {
      expect(body155.split(piece), `00155: ${piece.slice(0, 80)}`).toHaveLength(2);
    }
    // Zastępowanie funkcją: wzorzec UUID w I3K kończy się na `$'`, a to w napisie zastępującym znaczy „reszta tekstu”.
    const expected = tight(body155.replace(i3End, () => `${i3End} ${i3k}`).replace(i5Old, () => i5New).replace(i5dOld, () => i5dNew));
    expect(body156).toBe(expected);
  });

  it('marka FaktWay (00151, zmiana nazwy 10.2026): literały w ciałach funkcji 00156 bez „FaktFlow” i adresu w dawnej domenie — poza kodem powodu faktflow-original i wzorcem SystemInfo', () => {
    // Identyfikatory, które zostają (docs/rebrand/FAKTWAY.md): kod powodu i przyszła postać SystemInfo
    // (lustro TS: FAKTFLOW_SYSTEM_INFO_NEXT w lib/ksef/duplicate-decision.ts).
    const allowed = new Set(["'faktflow-original'", "'^FaktFlow [0-9]'"]);
    const hits = [...functionBodies(read(M156))].flatMap(([fn, bodies]) => bodies.flatMap((body) => lex(body)
      .filter((p) => p.kind === 'literal' && /faktflow/i.test(p.text) && !allowed.has(p.text))
      .map((p) => `${fn}: ${p.text}`)));
    expect(hits).toEqual([]);
    expect(read(M156), 'adres pomocy w dawnej domenie').not.toMatch(/pomoc@faktflow\.pl/);
  });

  it('listy kluczy w 4.8 (ksef_original_import_mismatch) = ORIGINAL_IMPORT_INVOICE_KEYS i ORIGINAL_IMPORT_LINE_KEYS; lista buyer_id_type = ORIGINAL_IMPORT_BUYER_ID_TYPES', () => {
    const lists = literalLists(withoutComments(bodyOf(read(M156), 'ksef_original_import_mismatch'))).map(canon);

    expect(lists, 'klucze nagłówka (invoice) — 19 kolumn C0 poza kolumnami ustawianymi przez SQL').toContain(canon(ORIGINAL_IMPORT_INVOICE_KEYS));
    expect(lists, 'klucze pozycji (lines)').toContain(canon(ORIGINAL_IMPORT_LINE_KEYS));
    expect(lists, 'buyer_id_type').toContain(canon(ORIGINAL_IMPORT_BUYER_ID_TYPES));
  });

  it('listy stawek w 4.8 = ORIGINAL_IMPORT_VAT_RATES: 8 stawek FaktFlow zawsze, FA3_ONLY_VAT_RATES tylko przy review-*, „nieznana” nigdy', () => {
    const rates = ORIGINAL_IMPORT_VAT_RATES;
    const raw = literalLists(withoutComments(bodyOf(read(M156), 'ksef_original_import_mismatch')));
    const lists = raw.map(canon);

    expect(lists, 'stawki FaktFlow (VAT_RATES)').toContain(canon(rates.faktflow));
    // Stawki spoza FaktFlow: osobna lista albo suma obu (oferty review-* przyjmują obie).
    const reviewOnly = canon(rates.reviewOnly);
    const union = canon([...rates.faktflow, ...rates.reviewOnly]);
    expect(lists.includes(reviewOnly) || lists.includes(union), 'stawki FA(3) spoza FaktFlow (FA3_ONLY_VAT_RATES) przy review-*').toBe(true);
    expect(raw.flat(), 'nieznana nigdy na liście przyjmowanych stawek').not.toContain('nieznana');
  });

  it('kody p_kind w 4.7b (flag_ksef_original_recheck) = ORIGINAL_RECHECK_KINDS', () => {
    const code = withoutComments(bodyOf(read(M156), 'flag_ksef_original_recheck'));
    const lists = literalLists(code).map(canon);
    expect(lists, 'lista p_kind').toContain(canon(ORIGINAL_RECHECK_KINDS));
    expect(code, 'walidacja p_kind').toMatch(/\bp_kind\b/);
  });

  it('ksef_duplicate_cross_tenant: LANGUAGE sql, jedna instrukcja, ciało używa tylko $1–$3 (test R-C7 c wkleja prosrc do PREPARE)', () => {
    const m156 = read(M156);
    const body = bodyOf(m156, 'ksef_duplicate_cross_tenant');
    const header = createStatements(statements(m156)).find(({ header: h }) => h.name === 'ksef_duplicate_cross_tenant')?.header;
    expect(/\bLANGUAGE\s+sql\b/i.test(header?.tail ?? ''), 'LANGUAGE sql (parametry pozycyjne $n)').toBe(true);

    const code = bodyCode(body);
    for (const n of [1, 2, 3]) {
      expect(code, `$${n}`).toMatch(new RegExp(`\\$${n}(?!\\d)`));
    }
    expect(code, 'parametry spoza $1–$3').not.toMatch(/\$(?:[4-9]|\d{2,})/);
    expect(code, 'parametry nazwane (p_…) zamiast pozycyjnych').not.toMatch(/\bp_\w+/i);
    // PREPARE q(uuid, text, text) AS <prosrc> przyjmuje jedną instrukcję.
    expect(statements(body), 'jedna instrukcja SELECT').toHaveLength(1);
  });

  it('(c7): tekst last_error przy braku sesji = komunikat NO_SESSION_REFERENCE z upo-client.ts, w INSERT do upo_receipts', async () => {
    const { downloadUpoFromKsef } = await import('@/lib/ksef/upo-client');
    // Bez numeru sesji funkcja odmawia przed jakąkolwiek siecią i bazą.
    const refusal = await downloadUpoFromKsef('00000000-0000-4000-8000-000000000001', '1234567890-20261001-0100A0B0C0D0-1A');
    expect(refusal.success).toBe(false);
    if (refusal.success) throw new Error('downloadUpoFromKsef bez sesji powinno odmówić');
    expect(refusal.errorCode).toBe('NO_SESSION_REFERENCE');
    expect(refusal.error.length).toBeGreaterThan(20);

    const coreStatements = statements(bodyOf(read(M156), 'ksef_duplicate_decide_core'));
    const upoInserts = coreStatements.filter((s) => /\bINSERT INTO public\.upo_receipts\b/i.test(s.bare));
    expect(upoInserts.length, '(c7) INSERT INTO public.upo_receipts w core').toBeGreaterThan(0);
    expect(upoInserts.some((s) => s.text.includes(`'${refusal.error.replace(/'/g, "''")}'`)),
      '(c7): last_error to dosłownie komunikat NO_SESSION_REFERENCE z upo-client.ts').toBe(true);
  });

  it('release_ksef_original_review: odmowy to komunikaty-kody ORIGINAL_RELEASE_REFUSAL_CODES (P0001; release:not-review z DETAIL), krok 9 — XX000', async () => {
    // Moduł RPC (server-only, klient admina) ładujemy tu, nie statycznie: jego zależności nie mogą wywrócić pozostałych przypadków.
    const { ORIGINAL_RELEASE_REFUSAL_CODES } = await import('@/lib/ksef/duplicate-decision-rpc');
    const code = withoutComments(bodyOf(read(M156), 'release_ksef_original_review'));

    for (const refusal of ORIGINAL_RELEASE_REFUSAL_CODES) {
      const raises = raisesOf(code, refusal);
      expect(raises.length, `${refusal}: RAISE EXCEPTION '${refusal}'`).toBeGreaterThan(0);
      for (const rest of raises) {
        const { using } = splitRaise(rest);
        expect(usingValue(using, 'ERRCODE'), `${refusal}: ERRCODE`).toBe("'P0001'");
        if (refusal === 'release:not-review') {
          expect(usingValue(using, 'DETAIL'), `${refusal}: DETAIL (kod blokady, no-marker albo none)`).toBeDefined();
        }
      }
    }

    // 4.7 krok 9: skutek oddania sprawdzony po zapisie — techniczny wyjątek cofa transakcję.
    const notEffective = raisesOf(code, 'KSeF original release did not take effect');
    expect(notEffective, 'krok 9: RAISE EXCEPTION „did not take effect”').toHaveLength(1);
    expect(usingValue(splitRaise(notEffective[0]!).using, 'ERRCODE')).toBe("'XX000'");
  });
});
