import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import '@/lib/flo/functions';
import { getFloHandler, registeredFloKinds } from '@/lib/flo/handlers';

/**
 * Akcje serwerowe agenta — most między interfejsem a silnikiem.
 *
 * Testujemy tu rzeczy, których nie łapie ani typecheck, ani testy jednostkowe
 * silnika: kształt modułu `'use server'` i to, czy rejestr wykonawców jest
 * naprawdę zapełniony w momencie, gdy akcje go potrzebują.
 */

const SOURCE = readFileSync(
  new URL('../../app/actions/flo.ts', import.meta.url),
  'utf8',
);
/** Zatwierdzenie od M10a: akcja deleguje do `lib/flo/approve-proposal.ts` (wspólne z telefonem). */
const APPROVE_SOURCE = readFileSync(
  new URL('../../lib/flo/approve-proposal.ts', import.meta.url),
  'utf8',
);

describe('kształt modułu akcji', () => {
  it('eksportuje WYŁĄCZNIE funkcje asynchroniczne', () => {
    // Plik z dyrektywą 'use server' nie może eksportować klas ani funkcji
    // synchronicznych. `pnpm typecheck` tego nie łapie — wywala się dopiero
    // `next build`, czyli w najgorszym możliwym momencie.
    const exports = [...SOURCE.matchAll(/^export\s+(.+?)[\s({]/gm)].map(
      (match) => match[1]!,
    );

    expect(exports.length).toBeGreaterThan(0);
    for (const declaration of exports) {
      expect(declaration, `nieprawidłowy eksport: ${declaration}`).toBe('async');
    }
  });

  it('ma komplet akcji z kontraktu', () => {
    for (const name of [
      'listProposals',
      'listScheduled',
      'approveProposal',
      'dismissProposal',
      'undoAction',
      'cancelScheduled',
      'getPrefs',
      'savePrefs',
    ]) {
      expect(SOURCE, `brak akcji ${name}`).toContain(`export async function ${name}`);
    }
  });

  it('importuje rejestr funkcji dla efektu ubocznego', () => {
    // Bez tego importu rejestr wykonawców jest pusty i agent odpowiada
    // „tego jeszcze nie umiem wykonać" na każde kliknięcie.
    expect(SOURCE).toContain("import '@/lib/flo/functions'");
  });
});

describe('bezpieczeństwo akcji', () => {
  it('KAŻDA akcja zaczyna się od sprawdzenia organizacji', () => {
    // Klient administracyjny omija RLS, więc przynależność musi być
    // sprawdzona jawnie w każdej akcji — inaczej znajomość identyfikatora
    // propozycji wystarczyłaby, żeby wykonać cudzą sprawę.
    const bodies = SOURCE.split(/export async function /).slice(1);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf('('));
      expect(body, `akcja ${name} bez sprawdzenia organizacji`).toContain(
        'requireUserAndActiveOrg()',
      );
    }
  });

  it('akcje na pojedynczej propozycji filtrują po organizacji w zapytaniu', () => {
    // Druga linia obrony obok sprawdzenia sesji.
    const guarded = ['approveFloProposal', 'dismissProposal', 'cancelScheduled'];
    for (const name of guarded) {
      const source = name === 'approveFloProposal' ? APPROVE_SOURCE : SOURCE;
      const start = source.indexOf(`export async function ${name}`);
      expect(start, `${name} nie istnieje`).toBeGreaterThan(-1);
      const body = source.slice(start, start + 1600);
      expect(body, `${name} bez filtru tenant_id`).toContain(
        ".eq('tenant_id', tenantId)",
      );
    }
  });

  it('zatwierdzenie tworzy żeton PRZED wykonaniem', () => {
    const action = SOURCE.slice(SOURCE.indexOf('export async function approveProposal'), SOURCE.indexOf('export async function dismissProposal'));
    expect(action).toContain('approveFloProposal(');
    const start = APPROVE_SOURCE.indexOf('export async function approveFloProposal');
    const body = APPROVE_SOURCE.slice(start);
    expect(start).toBeGreaterThan(-1);
    expect(body.indexOf('createApproval')).toBeGreaterThan(-1);
    expect(body.indexOf('createApproval')).toBeLessThan(
      body.indexOf('executeProposal'),
    );
  });
});

describe('rejestr wykonawców jest zapełniony', () => {
  it('import modułu funkcji rejestruje handlery', () => {
    // To jest test na pułapkę, która już raz uderzyła: rejestr zapełnia się
    // wyłącznie przez efekt uboczny importu. Pusty rejestr oznacza agenta,
    // który tworzy propozycje i nie umie wykonać żadnej.
    expect(registeredFloKinds().length).toBeGreaterThan(0);
  });

  it('funkcje, które klient realnie klika, mają wykonawcę', () => {
    for (const kind of ['expense.review', 'expense.rule', 'payment.confirm', 'payment.chase'] as const) {
      expect(getFloHandler(kind), `brak wykonawcy dla ${kind}`).not.toBeNull();
    }
  });
});
