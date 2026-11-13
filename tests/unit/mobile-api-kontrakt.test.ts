import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { MOBILE_API_ERROR_CODES, type RolaWFirmie } from '@/lib/api/mobile/kontrakt';
import type { UserRole } from '@/lib/supabase/auth-context';

/**
 * Plan aplikacji mobilnej 4.1 (decyzja M6): kontrakt API `/api/mobile/v1`
 * (`lib/api/mobile/kontrakt.ts`) importuje także aplikacja w `mobile/` przez
 * Metro. Gdyby plik zaczął importować kod serwera, Supabase albo Nexta,
 * paczka aplikacji ciągnęłaby kod serwera (albo nie zbudowałaby się wcale).
 */

const SOURCE = readFileSync(resolve(__dirname, '../../lib/api/mobile/kontrakt.ts'), 'utf8');

describe('kontrakt API aplikacji na telefon', () => {
  it('nie ma żadnych importów ani require', () => {
    expect(SOURCE).not.toMatch(/^\s*import\s/m);
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
    expect(SOURCE).not.toMatch(/\bimport\s*\(/);
  });

  it('kody błędów są unikalne i w zapisie snake_case', () => {
    expect(new Set(MOBILE_API_ERROR_CODES).size).toBe(MOBILE_API_ERROR_CODES.length);
    for (const code of MOBILE_API_ERROR_CODES) expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
  });

  it('role w firmie są tymi samymi rolami co na stronie', () => {
    expectTypeOf<RolaWFirmie>().toEqualTypeOf<UserRole>();
  });
});
