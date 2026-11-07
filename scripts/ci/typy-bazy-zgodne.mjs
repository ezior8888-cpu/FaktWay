#!/usr/bin/env node
// Plan usprawnień 2.7: zgodność `types/database.ts` (z produkcji) ze schematem
// zbudowanym z migracji w repo (job CI „RLS isolation”).
//
//   node scripts/ci/typy-bazy-zgodne.mjs <typy-z-migracji.ts> [types/database.ts]
//
// Porównuje znaczenie, nie tekst (CLI i produkcja formatują inaczej): kolumny
// tabel i widoków z typami (`Row`), wartości enumów, nazwy funkcji.
//
// BŁĄD (kod 1): w `types/database.ts` jest coś, czego migracje nie tworzą,
// albo typ kolumny się różni. To dryf produkcji (zmiana spoza migracji) albo
// ręczna edycja typów.
// OSTRZEŻENIE: migracje tworzą coś, czego typy jeszcze nie mają. Normalne:
// migracja trafia na produkcję po scaleniu, typy z produkcji w następnym PR
// (docs/runbooks/wgrywanie-migracji.md, „Typy bazy”).
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const [genPath, repoPath = 'types/database.ts'] = process.argv.slice(2);
if (!genPath) {
  console.error('Użycie: node scripts/ci/typy-bazy-zgodne.mjs <typy-z-migracji.ts> [types/database.ts]');
  process.exit(2);
}

// Różnice samego formatu między wersjami postgres-meta: `(string)[]` i `string[]`,
// `NonNullable<Json>` i `Json` (kolumna jsonb NOT NULL), wiodące `|` w unii po
// prettierze, średniki i przecinki.
const norm = (text) =>
  text
    .replace(/\s+/g, '')
    .replace(/["']/g, '')
    .replace(/;/g, ',')
    .replace(/,([}\]])/g, '$1')
    .replace(/\(([^()|]+)\)\[\]/g, '$1[]')
    .replace(/NonNullable<Json>/g, 'Json')
    .replace(/^\|/, '');
// Widoki: nowsze postgres-meta wnioskują NOT NULL kolumn widoku, starsze dają
// zawsze `| null`. Przy widokach porównujemy typ bez `null`.
const withoutNull = (type) => type.split('|').filter((t) => t !== 'null').join('|');
const nameOf = (member) => member.name.getText().replace(/^["']|["']$/g, '');
const members = (node) => (node && ts.isTypeLiteralNode(node) ? node.members.filter(ts.isPropertySignature) : []);
const prop = (node, name) => members(node).find((m) => nameOf(m) === name)?.type;

/** Mapa „schemat.rodzaj.nazwa[.kolumna]” → typ znormalizowany. */
function canonical(path) {
  const source = readFileSync(path, 'utf8');
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const db = sf.statements.find((s) => ts.isTypeAliasDeclaration(s) && s.name.text === 'Database');
  if (!db) throw new Error(`${path}: brak typu Database`);
  const out = new Map();
  for (const schema of members(db.type)) {
    const sName = nameOf(schema);
    if (sName === '__InternalSupabase') continue;
    for (const kind of ['Tables', 'Views']) {
      for (const rel of members(prop(schema.type, kind))) {
        out.set(`${sName}.${kind}.${nameOf(rel)}`, '');
        for (const col of members(prop(rel.type, 'Row'))) {
          const type = norm(col.type.getText());
          out.set(`${sName}.${kind}.${nameOf(rel)}.${nameOf(col)}`, kind === 'Views' ? withoutNull(type) : type);
        }
      }
    }
    for (const en of members(prop(schema.type, 'Enums'))) {
      const values = norm(en.type.getText()).split('|').filter(Boolean).sort().join('|');
      out.set(`${sName}.Enums.${nameOf(en)}`, values);
    }
    for (const fn of members(prop(schema.type, 'Functions'))) out.set(`${sName}.Functions.${nameOf(fn)}`, '');
  }
  return out;
}

const fromMigrations = canonical(genPath);
const fromRepo = canonical(repoPath);
const errors = [];
const warnings = [];
for (const [key, type] of fromRepo) {
  if (!fromMigrations.has(key)) errors.push(`${key}: jest w ${repoPath}, migracje tego nie tworzą`);
  else if (fromMigrations.get(key) !== type) errors.push(`${key}: typ w ${repoPath} „${type}”, z migracji „${fromMigrations.get(key)}”`);
}
for (const key of fromMigrations.keys()) {
  if (!fromRepo.has(key)) warnings.push(`${key}: migracje to tworzą, ${repoPath} jeszcze nie`);
}

const gha = process.env.GITHUB_ACTIONS === 'true';
for (const w of warnings) console.log(gha ? `::warning file=${repoPath}::${w}` : `ostrzeżenie: ${w}`);
for (const e of errors) console.log(gha ? `::error file=${repoPath}::${e}` : `BŁĄD: ${e}`);
console.log(`typy bazy: ${fromRepo.size} pozycji w ${repoPath}, ${errors.length} błędów, ${warnings.length} ostrzeżeń (typy do odświeżenia po wgraniu migracji).`);
process.exit(errors.length ? 1 : 0);
