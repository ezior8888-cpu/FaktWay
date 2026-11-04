import { describe, expect, it } from 'vitest';

import { DUPLICATE_DECISION_SQL_TEXTS, DUPLICATE_DECISION_TEXTS } from '@/lib/ksef/duplicate-decision';

/**
 * Strażnik tekstów D-A4-1b-3 PR B dla prawnika (decyzje Bartosza 07.10.2026
 * (A) i (8)): dialogi decyzji, odmowy w panelu, komunikaty P0001 z RPC
 * i wyzwalaczy 00148, baner szkicu wycofanego każdego rodzaju, odmowa e-maila,
 * powiadomienie; od D-A4-1b-3 PR C (00156, spec v3 6.2, 6.3, 6.7) także
 * `DUPLICATE_DECISION_TEXTS.FAKTFLOW` i nowe klucze SQL (zapis oryginału z KSeF).
 * Przegląd przed KSeF PROD (TEST bez blokady); zmiana
 * któregokolwiek tekstu po przeglądzie czerwieni ten test — nowa wersja
 * pliku migawki wraca do prawnika.
 *
 * Migawka jest czytelnym plikiem tekstowym (`__snapshots__/…txt`): jeden
 * wiersz na tekst, funkcje wywołane ze znacznikami argumentów `{1}`, `{2}`…
 * Pierwszy zapis: `pnpm vitest run tests/unit/ksef-duplikat-decyzja-teksty.test.ts -u`
 * po ustaleniu tekstów (w CI brak pliku migawki to błąd).
 */

function render(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'string') {
    out.push(`${path} = ${value}`);
    return;
  }
  if (typeof value === 'function') {
    const fn = value as (...args: unknown[]) => unknown;
    const args = Array.from({ length: fn.length }, (_, i) => `{${i + 1}}`);
    let result: unknown;
    try {
      result = fn(...args);
    } catch (e) {
      result = `<funkcja(${args.join(', ')}) rzuca: ${e instanceof Error ? e.message : String(e)}>`;
    }
    render(result, `${path}(${args.join(', ')})`, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value).sort()) render((value as Record<string, unknown>)[key], `${path}.${key}`, out);
    return;
  }
  out.push(`${path} = ${String(value)}`);
}

describe('U17 strażnik: teksty decyzji przy 440 po przeglądzie prawnika', () => {
  it('DUPLICATE_DECISION_TEXTS i DUPLICATE_DECISION_SQL_TEXTS — migawka do przeglądu', async () => {
    const lines: string[] = ['# DUPLICATE_DECISION_TEXTS (klient, 2.11.B–C)'];
    render(DUPLICATE_DECISION_TEXTS, 'TEXTS', lines);
    lines.push('', '# DUPLICATE_DECISION_SQL_TEXTS (komunikaty P0001/22023/42501 z 00148, marka FaktWay od 00151, 2.11.A, i z 00156, PR C 6.3; % = argument RAISE)');
    const sql = DUPLICATE_DECISION_SQL_TEXTS as Record<string, { template: string; arity: number }>;
    for (const key of Object.keys(sql).sort()) lines.push(`SQL.${key} [${sql[key]!.arity}] = ${sql[key]!.template}`);
    expect(lines.length).toBeGreaterThan(30);
    await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot('./__snapshots__/ksef-duplikat-decyzja-teksty.txt');
  });
});
