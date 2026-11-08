import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * Plan usprawnień 2.7: `scripts/ci/typy-bazy-zgodne.mjs` porównuje
 * `types/database.ts` (z produkcji) z typami ze schematu zbudowanego
 * z migracji (job „RLS isolation”). Format obu plików się różni (CLI kontra
 * prettier na produkcji), więc liczy się znaczenie.
 */

const SCRIPT = resolve(__dirname, '../../scripts/ci/typy-bazy-zgodne.mjs');
let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

// Format CLI: bez prettiera, `(string)[]`, `NonNullable<Json>`, widok bez null.
const FROM_MIGRATIONS = `export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]
export type Database = {
  "public": {
          Tables: {
            "invoices": { Row: { "id": string; "tags": (string)[]; "fa3_data": NonNullable<Json>; "status": Database["public"]["Enums"]["status"] }; Insert: {}; Update: {}; Relationships: [] }
          }
          Views: { "overdue": { Row: { "id": string } } }
          Functions: { "mark_paid": { Args: { "p_id": string }; Returns: undefined } }
          Enums: { "status": "draft" | "sent" }
          CompositeTypes: { [_ in never]: never }
        }
}
`;
// Format z produkcji (prettier), ta sama treść.
const FROM_REPO = `// nagłówek
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.6"
  }
  public: {
    Tables: {
      invoices: {
        Row: {
          id: string
          tags: string[]
          fa3_data: Json
          status: Database["public"]["Enums"]["status"]
        }
        Insert: {}
        Update: {}
        Relationships: []
      }
    }
    Views: {
      overdue: {
        Row: {
          id: string | null
        }
      }
    }
    Functions: {
      mark_paid: { Args: { p_id: string }; Returns: undefined }
    }
    Enums: {
      status: "sent" | "draft"
    }
    CompositeTypes: { [_ in never]: never }
  }
}
`;

function run(gen: string, repo: string) {
  dir = mkdtempSync(join(tmpdir(), 'typy-bazy-'));
  writeFileSync(join(dir, 'gen.ts'), gen);
  writeFileSync(join(dir, 'repo.ts'), repo);
  return spawnSync(process.execPath, [SCRIPT, join(dir, 'gen.ts'), join(dir, 'repo.ts')], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '' },
  });
}

describe('typy-bazy-zgodne.mjs', () => {
  it('ta sama treść w innym formacie: zgodne', () => {
    const r = run(FROM_MIGRATIONS, FROM_REPO);
    expect(r.stdout).toContain('0 błędów, 0 ostrzeżeń');
    expect(r.status).toBe(0);
  });

  it('kolumna w types/database.ts, której migracje nie tworzą: błąd', () => {
    const r = run(FROM_MIGRATIONS, FROM_REPO.replace('tags: string[]', 'tags: string[]\n          reczna: string'));
    expect(r.stdout).toContain('BŁĄD: public.Tables.invoices.reczna: jest w');
    expect(r.status).toBe(1);
  });

  it('inny typ kolumny tabeli: błąd', () => {
    const r = run(FROM_MIGRATIONS, FROM_REPO.replace('id: string\n          tags', 'id: number\n          tags'));
    expect(r.stdout).toContain('BŁĄD: public.Tables.invoices.id: typ');
    expect(r.status).toBe(1);
  });

  it('nowa migracja jeszcze nie w typach: ostrzeżenie, nie błąd', () => {
    const r = run(FROM_MIGRATIONS.replace('"mark_paid"', '"nowa_funkcja": { Args: {}; Returns: undefined }; "mark_paid"'), FROM_REPO);
    expect(r.stdout).toContain('ostrzeżenie: public.Functions.nowa_funkcja');
    expect(r.status).toBe(0);
  });
});
