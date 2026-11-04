import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Strażnik tekstu migracji 00148 (D-A4-1b-3 PR B, decyzja klienta przy
 * duplikacie 440). Zachowanie sprawdza baza: tests/rls-decyzja-duplikatu.test.ts
 * i tests/rls-kolejkowanie-wysylki.test.ts (job „RLS isolation”, R1–R9).
 *
 * Precedens tests/unit/migracje-uprawnienia.test.ts wycina tylko ciała `$$`.
 * Tu (C11) prosty lekser wycina także komentarze `--` / `/* *\/` i literały
 * `'…'`, zanim szukamy DML i DROP: nagłówek 00148 mówi „DROP FUNCTION”,
 * „DROP poza” i „bez DELETE”, a komentarze w SQL — „DELETE”.
 *
 * Każdy przypadek czyta plik sam, więc przed migracją każdy pada osobno
 * (ENOENT), a nie cały plik przy imporcie.
 */

const M148 = 'supabase/migrations/00148_ksef_duplicate_decision.sql';
const M136 = 'supabase/migrations/00136_ksef_submission_intent.sql';
/** Te same funkcje decyzji i wyzwalacza z tekstami w marce FaktWay (zmiana marki 10.2026). */
const M151 = 'supabase/migrations/00151_faktway_duplicate_decision_texts.sql';

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
  /** To samo z literałami zamienionymi na `''` (skan DML/DROP — C11). */
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

/**
 * Ciała funkcji z 00148 w wersji, która obowiązuje po wszystkich migracjach:
 * funkcja zdefiniowana ponownie w 00151 ma ciało z 00151.
 */
function currentBodies(): Map<string, string[]> {
  const bodies = functionBodies(read(M148));
  for (const [name, list] of functionBodies(read(M151))) bodies.set(name, list);
  return bodies;
}

/** Zmiana marki w literale: adres pomocy i nazwa produktu, nic więcej. */
const rebrand = (literal: string): string => literal.replaceAll('pomoc@faktflow.pl', 'pomoc@faktway.pl').replaceAll('FaktFlow', 'FaktWay');

/** Ciało z podmienioną marką wyłącznie w literałach `'…'` — kod i komentarze bez zmian. */
const rebrandLiterals = (body: string): string => lex(body).map((p) => (p.kind === 'literal' ? rebrand(p.text) : p.text)).join('');

/** Funkcje, które 00151 definiuje ponownie (te z marką w tekstach RAISE 00148). */
const REBRANDED_FUNCTIONS = [
  ['decide_ksef_duplicate', 'uuid, uuid, uuid, text, text, text, text, text, text'],
  ['guard_ksef_retired_draft', ''],
] as const;

const NEW_FUNCTIONS = [
  ['ksef_duplicate_check_allows', 'jsonb, text'],
  ['ksef_duplicate_decision_blocker', 'uuid, uuid'],
  ['decide_ksef_duplicate', 'uuid, uuid, uuid, text, text, text, text, text, text'],
  ['ksef_lifecycle_violations', ''],
] as const;

const RETIRED_TRIGGERS = [
  'c_guard_ksef_retired_draft',
  'c_guard_ksef_retired_draft_delete',
  'c_guard_ksef_retired_draft_number',
] as const;

/** Klucze `DUPLICATE_DECISION_SQL_TEXTS`, których szablony stoją w 00148 (2.11.A). */
const SQL_TEXT_KEYS_00148 = [
  'NOTE', 'ROLE', 'ALREADY', 'IN_FLIGHT', 'not-pending', 'in-ksef', 'kind', 'billing', 'offline', 'no-marker',
  'conflicting-originals', 'no-check', 'reason', 'known-stale', 'own-history', 'payments', 'STALE', 'ENV', 'EVIDENCE',
  'TRIGGER_SAME', 'TRIGGER_OTHER', 'TRIGGER_AUTO', 'TRIGGER_DELETE', 'TRIGGER_RENUMBER', 'TRIGGER_DIRECTION', 'CATALOG_NUMBER_TAKEN',
];

/**
 * PR C (spec v3 7.4, 9.2 commit 1): klucze z 00156 (6.3; rezerwacja 00149 przeszła
 * na 00156) — ich szablony sprawdza U16e-00156 w `tests/unit/zapis-oryginalu-migracja.test.ts`,
 * nie ten strażnik (00148 i 00151 ich nie mają i mieć nie będą). Każdy klucz lustra
 * należy do dokładnie jednej z tych list — nowy klucz bez migracji czerwieni U16e.
 */
const SQL_TEXT_KEYS_00156 = [
  'known-now', 'cross-tenant', 'recheck-needed', 'provenance-review', 'CHOICE', 'IMPORT_MISMATCH', 'ALREADY_IMPORTED',
  'TRIGGER_SAME_IMPORTED', 'TRIGGER_OTHER_IMPORTED', 'TRIGGER_DELETE_IMPORTED', 'TRIGGER_RENUMBER_IMPORTED', 'TRIGGER_DIRECTION_IMPORTED',
];

/** Kod błędu RAISE wg 2.11.A: NOTE 22023, ROLE 42501, reszta P0001. */
const errcodeFor = (key: string): string => (key === 'NOTE' ? '22023' : key === 'ROLE' ? '42501' : 'P0001');

describe('strażnik tekstu migracji 00148 (D-A4-1b-3 PR B)', () => {
  it('U16a: ksef_lifecycle_violations = ciało z 00136 + jedna linia w I5 + blok I5D przed I9', () => {
    const m148 = read(M148);
    const body136 = functionBodies(read(M136)).get('ksef_lifecycle_violations');
    const body148 = functionBodies(m148).get('ksef_lifecycle_violations');
    expect(body136).toHaveLength(1);
    expect(body148).toHaveLength(1);

    const i5Old = tight("AND i.ksef_status <> 'sending';");
    const i5New = tight("AND i.ksef_status <> 'sending' AND public.ksef_duplicate_decision_blocker(s.invoice_id, s.tenant_id) IS NOT NULL;");
    const i9 = tight("RETURN QUERY SELECT 'I9'::text");
    const i5d = tight(`
      RETURN QUERY
        SELECT 'I5D'::text, i.id, i.tenant_id,
               jsonb_build_object(
                 'original_ksef_number', m.original_ksef_number,
                 'reason', m.original_check->>'reason',
                 'env', m.original_check->>'env',
                 'checked_at', m.original_check->>'checkedAt',
                 'attempted_at', m.attempted_at,
                 'last_attempt_at', i.last_attempt_at)
          FROM public.invoices i
          CROSS JOIN LATERAL (
            SELECT s.original_ksef_number, s.original_check, s.attempted_at
              FROM public.ksef_submissions s
             WHERE s.invoice_id = i.id AND s.tenant_id = i.tenant_id
               AND s.status IN ('intent', 'sent') AND s.original_ksef_number IS NOT NULL
             ORDER BY s.attempted_at DESC NULLS LAST, s.id
             LIMIT 1) m
         WHERE i.direction = 'outgoing'
           AND i.ksef_status = 'failed'
           AND i.last_error_code = 'KSEF_DUPLICATE_RECONCILE'
           AND public.ksef_duplicate_decision_blocker(i.id, i.tenant_id) IS NULL;`);

    const base = normBody(body136![0]!);
    expect(base.split(i5Old)).toHaveLength(2);
    expect(base.split(i9)).toHaveLength(2);
    const expected = tight(base.replace(i5Old, i5New).replace(i9, `${i5d} ${i9}`));
    expect(normBody(body148![0]!)).toBe(expected);
  });

  it('U16b: poza ciałami, komentarzami i literałami — jedna transakcja, jeden UPDATE katalogu i tylko DROP TRIGGER IF EXISTS trzech nowych wyzwalaczy', () => {
    const m148 = read(M148);
    const stmts = statements(m148);
    const first = (s: Statement) => s.bare.split(' ')[0]!.toUpperCase();

    expect(first(stmts[0]!)).toBe('BEGIN');
    expect(first(stmts[stmts.length - 1]!)).toBe('COMMIT');
    const allowed = new Set(['BEGIN', 'COMMIT', 'CREATE', 'DROP', 'REVOKE', 'GRANT', 'COMMENT', 'UPDATE']);
    expect(stmts.filter((s) => !allowed.has(first(s))).map((s) => s.bare)).toEqual([]);

    const creates = stmts.filter((s) => first(s) === 'CREATE');
    expect(creates.filter((s) => !/^CREATE (OR REPLACE FUNCTION public\.\w+\s*\(|TRIGGER c_guard_ksef_retired_draft(_delete|_number)? )/i.test(s.bare))
      .map((s) => s.bare)).toEqual([]);

    const dml = stmts.filter((s) => /^(UPDATE|INSERT|DELETE|TRUNCATE|MERGE|COPY|WITH|DO|SELECT|CALL)\b/i.test(s.bare));
    expect(dml).toHaveLength(1);
    const catalogUpdate = tight(dml[0]!.text).replace(/'[^']*'/g, (lit) => (lit === "'KSEF_NUMBER_TAKEN'" ? lit : "'…'"));
    expect(catalogUpdate).toBe(tight("UPDATE public.ksef_error_codes SET client_message = '…' WHERE code = 'KSEF_NUMBER_TAKEN'"));

    const drops = stmts.filter((s) => /\bDROP\b/i.test(s.bare)).map((s) => tight(s.bare)).sort();
    expect(drops).toEqual(RETIRED_TRIGGERS.map((n) => tight(`DROP TRIGGER IF EXISTS ${n} ON public.invoices`)).sort());

    // Także w ciałach funkcji: bez kasowania danych i dynamicznego SQL.
    for (const [name, bodies] of functionBodies(m148)) {
      for (const body of bodies) {
        expect(bodyCode(body), name).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|DROP|ALTER\s+TABLE|EXECUTE)\b/i);
      }
    }
  });

  it('U16c: REVOKE FROM PUBLIC, anon, authenticated i GRANT tylko service_role dla każdej nowej funkcji; funkcja wyzwalacza — tylko REVOKE', () => {
    const stmts = statements(read(M148));

    for (const [fn, args] of NEW_FUNCTIONS) {
      const create = stmts.filter((s) => s.bare.startsWith(`CREATE OR REPLACE FUNCTION public.${fn}(`)
        || s.bare.startsWith(`CREATE OR REPLACE FUNCTION public.${fn} (`));
      expect(create, fn).toHaveLength(1);
      expect(tight(create[0]!.text), fn).toContain(tight("SET search_path = ''"));
      expect(/\bSECURITY DEFINER\b/i.test(create[0]!.bare), fn).toBe(fn === 'ksef_lifecycle_violations');

      const revoke = stmts.filter((s) => [
        tight(`REVOKE ALL ON FUNCTION public.${fn}(${args}) FROM PUBLIC, anon, authenticated`),
        tight(`REVOKE EXECUTE ON FUNCTION public.${fn}(${args}) FROM PUBLIC, anon, authenticated`),
      ].includes(tight(s.bare)));
      expect(revoke, `${fn}: REVOKE`).toHaveLength(1);

      const grants = stmts.filter((s) => new RegExp(`^GRANT .* ON FUNCTION public\\.${fn}\\s*\\(`, 'i').test(s.bare));
      expect(grants.map((s) => tight(s.bare)), `${fn}: GRANT`).toEqual([
        tight(`GRANT EXECUTE ON FUNCTION public.${fn}(${args}) TO service_role`),
      ]);
    }

    const guard = stmts.filter((s) => /^CREATE OR REPLACE FUNCTION public\.guard_ksef_retired_draft\s*\(\s*\)/.test(s.bare));
    expect(guard).toHaveLength(1);
    expect(guard[0]!.bare).toMatch(/\bRETURNS trigger\b/i);
    expect(tight(guard[0]!.text)).toContain(tight("SET search_path = ''"));
    expect(/\bSECURITY DEFINER\b/i.test(guard[0]!.bare)).toBe(false);
    expect(stmts.filter((s) => tight(s.bare) === tight('REVOKE ALL ON FUNCTION public.guard_ksef_retired_draft() FROM PUBLIC, anon, authenticated')))
      .toHaveLength(1);
    expect(stmts.filter((s) => /^GRANT\b/i.test(s.bare) && /guard_ksef_retired_draft/.test(s.bare))).toEqual([]);
  });

  it('U16d: trzy wyzwalacze szkicu wycofanego — zdarzenie, WHEN i funkcja', () => {
    const stmts = statements(read(M148));
    const triggers = new Map(stmts
      .map((s) => [/^CREATE TRIGGER (\w+)\s/i.exec(s.text)?.[1], s] as const)
      .filter((entry): entry is readonly [string, Statement] => entry[0] !== undefined));

    expect([...triggers.keys()].sort()).toEqual([...RETIRED_TRIGGERS].sort());
    expect(tight(triggers.get('c_guard_ksef_retired_draft')!.text)).toBe(tight(`
      CREATE TRIGGER c_guard_ksef_retired_draft
        BEFORE UPDATE OF ksef_status ON public.invoices FOR EACH ROW
        WHEN (OLD.ksef_status = 'draft' AND NEW.ksef_status IS DISTINCT FROM 'draft')
        EXECUTE FUNCTION public.guard_ksef_retired_draft()`));
    // 07.10 (9): korekta i faktura rozliczeniowa zostają usuwalne. Bez warunku
    // na kierunek (rewizja PR B #0): wpisy number_taken są tylko przy fakturach
    // wychodzących, a warunek `OLD.direction = 'outgoing'` klient obchodził,
    // zmieniając najpierw kierunek na 'incoming'.
    const deleteTrigger = triggers.get('c_guard_ksef_retired_draft_delete')!;
    expect(tight(deleteTrigger.text)).toBe(tight(`
      CREATE TRIGGER c_guard_ksef_retired_draft_delete
        BEFORE DELETE ON public.invoices FOR EACH ROW
        WHEN (OLD.ksef_status = 'draft'
              AND OLD.invoice_kind IN ('regular', 'advance'))
        EXECUTE FUNCTION public.guard_ksef_retired_draft()`));
    expect(/\bWHEN\s*\(([\s\S]*)\)\s*EXECUTE\b/i.exec(deleteTrigger.bare)?.[1]).not.toMatch(/\bdirection\b/i);
    // 07.10 (11): numer i kierunek szkicu wycofanego (każdy rodzaj) zmienia tylko serwis.
    const numberTrigger = triggers.get('c_guard_ksef_retired_draft_number')!;
    expect(tight(numberTrigger.text)).toBe(tight(`
      CREATE TRIGGER c_guard_ksef_retired_draft_number
        BEFORE UPDATE OF internal_number, direction ON public.invoices FOR EACH ROW
        WHEN (OLD.ksef_status = 'draft'
              AND (NEW.internal_number IS DISTINCT FROM OLD.internal_number
                   OR NEW.direction IS DISTINCT FROM OLD.direction))
        EXECUTE FUNCTION public.guard_ksef_retired_draft()`));
    expect(tight(numberTrigger.bare)).toContain(tight('BEFORE UPDATE OF internal_number, direction ON public.invoices'));
    expect(tight(numberTrigger.bare)).toContain(tight('NEW.internal_number IS DISTINCT FROM OLD.internal_number'));
    expect(tight(numberTrigger.bare)).toContain(tight('NEW.direction IS DISTINCT FROM OLD.direction'));

    // Każdy CREATE TRIGGER poprzedza DROP TRIGGER IF EXISTS tego samego wyzwalacza (powtarzalność).
    for (const name of RETIRED_TRIGGERS) {
      const drop = stmts.findIndex((s) => tight(s.bare) === tight(`DROP TRIGGER IF EXISTS ${name} ON public.invoices`));
      const create = stmts.findIndex((s) => new RegExp(`^CREATE TRIGGER ${name}\\s`).test(s.bare));
      expect(drop, name).toBeGreaterThanOrEqual(0);
      expect(drop, name).toBeLessThan(create);
    }
  });

  it('U16f (rewizja PR B #0): w gałęzi wyzwalacza numeru zmiana kierunku dostaje TRIGGER_DIRECTION przed TRIGGER_RENUMBER; obejście roli serwisu bez zmian', async () => {
    const { DUPLICATE_DECISION_SQL_TEXTS } = await import('@/lib/ksef/duplicate-decision');
    const bodies = currentBodies().get('guard_ksef_retired_draft');
    expect(bodies).toHaveLength(1);
    const body = normBody(bodies![0]!);

    // Krok 1: serwis (rola spoza authenticated/anon) przechodzi wyzwalacz numeru bez sprawdzania wpisów.
    expect(body).toContain(tight(`
      ELSIF TG_NAME = 'c_guard_ksef_retired_draft_number' THEN
        IF current_user NOT IN ('authenticated', 'anon') THEN
          RETURN NEW;
        END IF;`));
    // Krok 6: kierunek najpierw, potem numer — oba z argumentami (nr, odwołanie do K).
    expect(body).toContain(tight(`
      IF TG_NAME = 'c_guard_ksef_retired_draft_number' THEN
        IF NEW.direction IS DISTINCT FROM OLD.direction THEN
          RAISE EXCEPTION '${DUPLICATE_DECISION_SQL_TEXTS.TRIGGER_DIRECTION.template}', v_num, v_ref USING ERRCODE = 'P0001';
        END IF;
        RAISE EXCEPTION '${DUPLICATE_DECISION_SQL_TEXTS.TRIGGER_RENUMBER.template}', v_num, v_ref USING ERRCODE = 'P0001';
      END IF;`));
  });

  it('U16g (rewizja PR B #7): decyzja blokuje (krok 4) i zamyka (a) ten sam zbiór otwartych wpisów — intent, sent i duplicate', () => {
    const bodies = currentBodies().get('decide_ksef_duplicate');
    expect(bodies).toHaveLength(1);
    const body = normBody(bodies![0]!);
    const open = "s.status IN ('intent', 'sent', 'duplicate')";
    const where = `WHERE s.invoice_id = p_invoice_id AND s.tenant_id = p_tenant_id AND ${open}`;

    expect(body).toContain(tight(`PERFORM 1 FROM public.ksef_submissions s ${where} FOR UPDATE;`));
    // Bez `intent` w (a) starszy otwarty zamiar bez znacznika zostałby dowodem kontaktu
    // (00136), a (b) odmawiałby EVIDENCE każdej takiej decyzji. Zachowanie: R2 (1).
    const closing = /UPDATE public\.ksef_submissions s SET status='number_taken'[\s\S]*?;/.exec(body)?.[0];
    expect(closing).toBeDefined();
    expect(closing!.endsWith(tight(`${where};`))).toBe(true);
  });

  it('U16e (C1): każdy szablon 00148 z DUPLICATE_DECISION_SQL_TEXTS stoi dosłownie po RAISE EXCEPTION z kodem z 2.11.A, nigdy w format(); CATALOG w UPDATE katalogu (klucze 00156 — U16e-00156)', async () => {
    const m148 = read(M148);
    const m151 = read(M151);
    const { DUPLICATE_DECISION_SQL_TEXTS } = await import('@/lib/ksef/duplicate-decision');
    const all = Object.entries(DUPLICATE_DECISION_SQL_TEXTS) as Array<[string, { template: string; arity: number }]>;
    expect(all.map(([key]) => key)).toEqual(expect.arrayContaining(SQL_TEXT_KEYS_00148));
    // PR C: lustro = dokładnie klucze 00148 ∪ 00156 (bez powtórzeń); tu tylko szablony 00148 (od 00151 w marce FaktWay).
    expect([...all.map(([key]) => key)].sort()).toEqual([...SQL_TEXT_KEYS_00148, ...SQL_TEXT_KEYS_00156].sort());
    const entries = all.filter(([key]) => SQL_TEXT_KEYS_00148.includes(key));
    expect(entries).toHaveLength(SQL_TEXT_KEYS_00148.length);

    // Od 00151 decyzja i wyzwalacz mają teksty w marce FaktWay — szablony stoją w ciałach po wszystkich migracjach.
    const bodies = [...currentBodies().values()].flat();
    for (const [key, { template }] of entries) {
      for (const sql of [m148, m151]) {
        expect(sql, `${key}: format()`).not.toMatch(new RegExp(`format\\s*\\(\\s*'${escapeRegExp(template)}`));
      }

      if (key.startsWith('CATALOG')) {
        const update = statements(m148).find((s) => /^UPDATE public\.ksef_error_codes\b/i.test(s.bare));
        expect(update, key).toBeDefined();
        expect(/client_message\s*=\s*'([^']*)'/.exec(update!.text)?.[1], key).toBe(template);
        continue;
      }

      const raise = new RegExp(`RAISE\\s+EXCEPTION\\s+'${escapeRegExp(template)}'`, 'g');
      const codes: string[] = [];
      for (const body of bodies) {
        for (const match of body.matchAll(raise)) {
          // Od końca szablonu do średnika poza literałami: argumenty i USING ERRCODE.
          let j = match.index + match[0].length;
          let inLiteral = false;
          let rest = '';
          while (j < body.length && (inLiteral || body[j] !== ';')) {
            if (body[j] === "'") inLiteral = !inLiteral;
            rest += body[j];
            j += 1;
          }
          codes.push(/USING\s+ERRCODE\s*=\s*'(\w+)'/i.exec(rest)?.[1] ?? '(brak USING ERRCODE)');
        }
      }
      expect(codes.length, `${key}: brak RAISE EXCEPTION '<szablon>'`).toBeGreaterThan(0);
      expect(new Set(codes), key).toEqual(new Set([errcodeFor(key)]));
    }
  });
});

describe('strażnik tekstu migracji 00151 (marka FaktWay w tekstach 00148)', () => {
  it('U16h: jedna transakcja — tylko CREATE OR REPLACE dwóch funkcji, ich REVOKE i GRANT; bez DROP i DML', () => {
    const stmts = statements(read(M151));
    const first = (s: Statement) => s.bare.split(' ')[0]!.toUpperCase();

    expect(first(stmts[0]!)).toBe('BEGIN');
    expect(first(stmts[stmts.length - 1]!)).toBe('COMMIT');
    const allowed = new Set(['BEGIN', 'COMMIT', 'CREATE', 'REVOKE', 'GRANT']);
    expect(stmts.filter((s) => !allowed.has(first(s))).map((s) => s.bare)).toEqual([]);
    expect(stmts.filter((s) => /\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|ALTER)\b/i.test(s.bare)).map((s) => s.bare)).toEqual([]);

    const created = stmts.filter((s) => first(s) === 'CREATE')
      .map((s) => /^CREATE OR REPLACE FUNCTION public\.(\w+)\s*\(/i.exec(s.bare)?.[1] ?? s.bare);
    expect(created).toEqual(REBRANDED_FUNCTIONS.map(([fn]) => fn));
  });

  it('U16h: nagłówek każdej funkcji (parametry, RETURNS, LANGUAGE, SECURITY, search_path) słowo w słowo jak w 00148', () => {
    const header = (sql: string, fn: string) => statements(sql)
      .filter((s) => new RegExp(`^CREATE OR REPLACE FUNCTION public\\.${fn}\\s*\\(`, 'i').test(s.bare))
      .map((s) => tight(s.text));
    for (const [fn] of REBRANDED_FUNCTIONS) {
      const old = header(read(M148), fn);
      expect(old, fn).toHaveLength(1);
      expect(header(read(M151), fn), fn).toEqual(old);
    }
  });

  it('U16h: ciało = ciało z 00148 z marką podmienioną tylko w literałach (kod i komentarze znak w znak), bez „faktflow”', () => {
    const before = functionBodies(read(M148));
    const after = functionBodies(read(M151));
    expect([...after.keys()]).toEqual(REBRANDED_FUNCTIONS.map(([fn]) => fn));
    for (const [fn] of REBRANDED_FUNCTIONS) {
      expect(before.get(fn), fn).toHaveLength(1);
      expect(after.get(fn), fn).toHaveLength(1);
      const old = before.get(fn)![0]!;
      const next = after.get(fn)![0]!;
      expect(next, fn).not.toBe(old);
      expect(next, fn).toBe(rebrandLiterals(old));
      expect(next, fn).not.toMatch(/faktflow/i);
    }
  });

  it('U16h: 00151 obejmuje każdą funkcję 00148 z marką w literale; katalog KSEF_NUMBER_TAKEN marki nie ma', () => {
    const m148 = read(M148);
    const withBrand = [...functionBodies(m148)]
      .filter(([, bodies]) => bodies.some((b) => lex(b).some((p) => p.kind === 'literal' && /faktflow/i.test(p.text))))
      .map(([fn]) => fn);
    expect(withBrand).toEqual(REBRANDED_FUNCTIONS.map(([fn]) => fn));
    const update = statements(m148).find((s) => /^UPDATE public\.ksef_error_codes\b/i.test(s.bare));
    expect(update?.text).not.toMatch(/faktflow/i);
  });

  it('U16h: REVOKE od PUBLIC, anon, authenticated i GRANT jak w 00148', () => {
    const stmts = statements(read(M151)).map((s) => tight(s.bare));
    for (const [fn, args] of REBRANDED_FUNCTIONS) {
      expect(stmts, fn).toContain(tight(`REVOKE ALL ON FUNCTION public.${fn}(${args}) FROM PUBLIC, anon, authenticated`));
    }
    expect(stmts.filter((s) => s.startsWith('GRANT'))).toEqual([
      tight('GRANT EXECUTE ON FUNCTION public.decide_ksef_duplicate(uuid, uuid, uuid, text, text, text, text, text, text) TO service_role'),
    ]);
  });
});
