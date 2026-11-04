import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isCorrectionHeldForEnv, isKindHeldForEnv, sendableSpecialKinds } from '@/lib/ksef/kind-holds';
import type { KsefEnvironment } from '@/types/ksef';

/**
 * A4b PR2a: hamulce rodzajów dokumentu w jednym czystym module
 * (`lib/ksef/kind-holds.ts`). Czytają go builder zdarzenia ponowienia, cron
 * cyklu życia i polityki operatora — bez `submission-holds`, który ciągnie
 * `global-flags` (Redis, Supabase), a w testach crona i akcji jest atrapą.
 *
 * - KOR wstrzymana tylko na KSeF produkcyjnym (KOR_HOLD, AUD-03/04);
 * - ROZ wstrzymana wszędzie (ROZ_HOLD — runner, enqueue i backstop; C4);
 * - nieznane środowisko: dokument specjalny wstrzymany (fail-closed);
 * - nieznany rodzaj (także NULL): wstrzymany — nigdy domyślnie „zwykła”.
 */

const KNOWN_ENVS: KsefEnvironment[] = ['test', 'demo', 'production'];
const ALL_ENVS: Array<KsefEnvironment | null> = [...KNOWN_ENVS, null];

describe('isKindHeldForEnv — który rodzaj dokumentu jest wstrzymany w środowisku', () => {
  it.each(ALL_ENVS)('zwykła faktura nigdy (%s)', (env) => {
    expect(isKindHeldForEnv('regular', env)).toBe(false);
  });

  it.each(['test', 'demo'] as const)('korekta na %s — niewstrzymana', (env) => {
    expect(isKindHeldForEnv('correction', env)).toBe(false);
  });

  it.each(['production', null] as const)('korekta na %s — wstrzymana (KOR_HOLD / nieznane środowisko)', (env) => {
    expect(isKindHeldForEnv('correction', env)).toBe(true);
  });

  it.each(KNOWN_ENVS)('zaliczka na %s — niewstrzymana', (env) => {
    expect(isKindHeldForEnv('advance', env)).toBe(false);
  });

  it('zaliczka przy nieznanym środowisku — wstrzymana (fail-closed)', () => {
    expect(isKindHeldForEnv('advance', null)).toBe(true);
  });

  it.each(ALL_ENVS)('faktura rozliczeniowa (ROZ) wstrzymana wszędzie, także %s (do C4)', (env) => {
    expect(isKindHeldForEnv('final', env)).toBe(true);
  });

  it.each([null, undefined, 'VAT', 'KOR', 'Correction', '', 42])(
    'nieznany rodzaj (%s) — wstrzymany w każdym środowisku, nigdy domyślnie „zwykła”',
    (kind) => {
      for (const env of ALL_ENVS) expect(isKindHeldForEnv(kind, env), `${String(kind)} / ${String(env)}`).toBe(true);
    },
  );
});

describe('sendableSpecialKinds — rodzaje specjalne, które cron I6/I7 wybiera osobnym zapytaniem', () => {
  it.each(['test', 'demo'] as const)('%s → korekta i zaliczka', (env) => {
    expect(sendableSpecialKinds(env)).toEqual(['correction', 'advance']);
  });

  it('production → tylko zaliczka (KOR_HOLD; ROZ nigdy)', () => {
    expect(sendableSpecialKinds('production')).toEqual(['advance']);
  });
});

describe('isCorrectionHeldForEnv — jedna definicja hamulca korekt', () => {
  it.each([
    ['test', false],
    ['demo', false],
    ['production', true],
  ] as const)('%s → %s', (env, held) => {
    expect(isCorrectionHeldForEnv(env)).toBe(held);
  });

  it('submission-holds re-eksportuje tę samą funkcję (runner i enqueue bez zmian)', async () => {
    const holds = await import('@/lib/ksef/submission-holds');
    expect(holds.isCorrectionHeldForEnv).toBe(isCorrectionHeldForEnv);
  });

  it('moduł czysty: same importy typów (bez global-flags, Supabase i Next)', () => {
    const source = readFileSync(path.join(process.cwd(), 'lib/ksef/kind-holds.ts'), 'utf8');
    const imports = source.split('\n').filter((l) => /^\s*import\s/.test(l));
    expect(imports.filter((l) => !/^\s*import\s+type\s/.test(l))).toEqual([]);
  });
});
