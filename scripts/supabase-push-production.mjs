/**
 * `pnpm db:push:prod` jest WYŁĄCZONY.
 *
 * To była droga z czasów Supabase Cloud (`supabase db push` z SUPABASE_DB_URL).
 * Produkcja stoi na self-hosted db-1, gdzie migrację trzeba wgrać w jednej
 * transakcji, dopisać do schema_migrations, przeładować PostgREST
 * (`NOTIFY pgrst`) i sprawdzić, że widzi nowe obiekty. Robi to:
 *
 *   ./scripts/ops/wgraj-migracje.sh 00157 00158
 *
 * Skrypt kończy się błędem zawsze, także z ustawionym SUPABASE_DB_URL, żeby
 * nikt (człowiek ani agent) nie wypchnął migracji z pominięciem tych kroków.
 */

console.error(
  [
    'pnpm db:push:prod jest wyłączony: to pozostałość po Supabase Cloud.',
    'Migracje na produkcję wgrywa: ./scripts/ops/wgraj-migracje.sh <numery>',
    'Procedura: AGENTS.md, „Wgrywanie migracji na produkcję”.',
  ].join('\n'),
);
process.exit(1);
