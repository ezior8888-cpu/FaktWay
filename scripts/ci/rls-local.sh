#!/usr/bin/env bash
# AUD-109: test izolacji firm (RLS) na lokalnym Supabase w CI.
#
# Kolejność ma znaczenie: funkcje `ops.*` z 00100 czytają `pgboss.job`, a schemat
# `pgboss` tworzy sam pg-boss przy starcie — na świeżej bazie musi powstać
# PRZED migracjami. Dlatego: Supabase bez migracji → schemat pg-boss →
# migracje z repo → testy. Wszystko lokalnie (127.0.0.1), bez sekretów.
set -euo pipefail

cleanup() { [ -d supabase/migrations.ci ] && mv supabase/migrations.ci supabase/migrations || true; }
trap cleanup EXIT

mv supabase/migrations supabase/migrations.ci
mkdir -p supabase/migrations
# postgres-meta zostaje: generuje typy dla kontroli `types/database.ts` na końcu.
supabase start -x studio,imgproxy,mailpit,inbucket,edge-runtime,logflare,vector,supavisor,realtime,storage-api
rmdir supabase/migrations
mv supabase/migrations.ci supabase/migrations

DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
node --input-type=module -e "
import { PgBoss } from 'pg-boss';
const boss = new PgBoss({ connectionString: '${DB_URL}', schema: 'pgboss', schedule: false, supervise: false });
await boss.start();
await boss.stop({ graceful: false, close: true });
console.log('schemat pgboss gotowy');
"

supabase migration up --local

eval "$(supabase status -o env)"
export RLS_TEST_SUPABASE_URL="${API_URL}"
export RLS_TEST_SUPABASE_ANON_KEY="${ANON_KEY:-${PUBLISHABLE_KEY:-}}"
export RLS_TEST_SUPABASE_SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY:-${SECRET_KEY:-}}"
export RLS_TEST_ALLOW_DESTRUCTIVE="isolated-local-database"
# Testy kolejki pg-boss (PR 3 cyklu życia) łączą się z tą samą lokalną bazą po Postgresie.
export RLS_TEST_DATABASE_URL="${DB_URL}"
unset NEXT_PUBLIC_SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY

pnpm test:rls

# Plan usprawnień 2.7: `types/database.ts` (z produkcji) nie może mieć niczego,
# czego migracje z repo nie tworzą (dryf produkcji albo ręczna edycja).
# Migracja jeszcze nieodzwierciedlona w typach to tylko ostrzeżenie.
GEN_TYPES="${RUNNER_TEMP:-/tmp}/database.z-migracji.ts"
supabase gen types typescript --local --schema public,graphql_public > "$GEN_TYPES"
node scripts/ci/typy-bazy-zgodne.mjs "$GEN_TYPES" types/database.ts
