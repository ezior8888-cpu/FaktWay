#!/usr/bin/env node
// Blokada wdrożenia przy niewgranych migracjach (plan usprawnień 3.1).
//
//   node scripts/ci/migracje-niewgrane.mjs <katalog-migracji> <stan.json>
//
// `stan.json` to odpowiedź `GET /api/ops/deploy-state` (`{ migrations: [...] }`,
// wersje z `supabase_migrations.schema_migrations` na db-1). Każdy plik
// `NNNNN_*.sql` bez wpisu to migracja niewgrana:
// - nagłówek mówi „PO wdrożeniu” (i nie mówi „przed”): wolno wdrożyć, lista
//   idzie do podsumowania jako „wgraj po tym wdrożeniu”;
// - każda inna (także bez słowa o kolejności): wdrożenie stoi, kod 1.
// Kolejność według docs/runbooks/wgrywanie-migracji.md, zasada 3.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FILE_PATTERN = /^(\d{5})_.+\.sql$/;

/** Komentarze na początku pliku, do pierwszej linii kodu. */
export function headerOf(sql) {
  const lines = [];
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('--')) break;
    lines.push(trimmed);
  }
  return lines.join('\n');
}

/** `po`: nagłówek każe wgrać PO wdrożeniu; `przed`: wszystko inne (fail-closed). */
export function whenToApply(sql) {
  const header = headerOf(sql);
  if (/przed\s+wdro[żz]eni/i.test(header)) return 'przed';
  if (/\bPO\s+wdro[żz]eni/.test(header)) return 'po';
  return 'przed';
}

/**
 * @param {{ file: string, sql: string }[]} migrations
 * @param {string[]} applied
 */
export function missingMigrations(migrations, applied) {
  const appliedSet = new Set(applied.map(String));
  const before = [];
  const after = [];
  for (const { file, sql } of migrations) {
    const match = FILE_PATTERN.exec(file);
    if (!match || appliedSet.has(match[1])) continue;
    (whenToApply(sql) === 'po' ? after : before).push(file);
  }
  return { before: before.sort(), after: after.sort() };
}

function main([dir, statePath]) {
  if (!dir || !statePath) {
    console.error('Użycie: node scripts/ci/migracje-niewgrane.mjs <katalog-migracji> <stan.json>');
    return 2;
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (!Array.isArray(state?.migrations) || state.migrations.length === 0) {
    console.error('Stan wdrożenia bez listy migracji: nie da się sprawdzić bazy, wdrożenie stoi.');
    return 1;
  }
  const migrations = readdirSync(dir)
    .filter((file) => FILE_PATTERN.test(file))
    .map((file) => ({ file, sql: readFileSync(join(dir, file), 'utf8') }));
  const { before, after } = missingMigrations(migrations, state.migrations);

  for (const file of after) console.log(`Wgraj PO tym wdrożeniu: ${file}`);
  if (before.length > 0) {
    for (const file of before) console.error(`Niewgrana migracja „przed wdrożeniem”: ${file}`);
    console.error(
      `Wdrożenie stoi: ${before.length} migracji bez wpisu w schema_migrations na db-1. ` +
        'Wgraj je (./scripts/ops/wgraj-migracje.sh NNNNN) i uruchom workflow ponownie.',
    );
    return 1;
  }
  console.log(`Migracje w porządku: ${migrations.length} plików, brak niewgranych „przed wdrożeniem”.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
