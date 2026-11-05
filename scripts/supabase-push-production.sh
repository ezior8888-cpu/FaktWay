#!/usr/bin/env bash
# WYŁĄCZONY, jak `pnpm db:push:prod` (opis w scripts/supabase-push-production.mjs).
# Migracje na produkcję: ./scripts/ops/wgraj-migracje.sh <numery>
{
  echo "scripts/supabase-push-production.sh jest wyłączony: to pozostałość po Supabase Cloud."
  echo "Migracje na produkcję wgrywa: ./scripts/ops/wgraj-migracje.sh <numery>"
  echo "Procedura: AGENTS.md, „Wgrywanie migracji na produkcję”."
} >&2
exit 1
