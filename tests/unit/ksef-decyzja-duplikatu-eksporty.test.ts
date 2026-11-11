import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import * as decision from '@/lib/ksef/duplicate-decision';
import type {
  ComparisonRow,
  DuplicateChoice,
  DuplicateDecidableOffer,
  DuplicateDecisionBlockerCode,
  DuplicateDecisionFacts,
  DuplicateDecisionInvoiceRow,
  DuplicateDecisionKnownInvoice,
  DuplicateDecisionLabel,
  DuplicateDecisionMode,
  DuplicateDecisionOptionsInput,
  DuplicateDecisionReason,
  DuplicateDecisionRefusal,
  DuplicateDecisionReviewView,
  DuplicateDecisionSqlText,
  DuplicateDecisionSqlTextKey,
  DuplicateDecisionSubmissionRow,
  DuplicateDecisionView,
  DuplicateNoticeVariant,
  DuplicateOriginalImportOffer,
  DuplicateOriginalOffer,
  DuplicateOriginalViewData,
  DuplicateRecordIntro,
  DuplicateRefusalDetail,
  DuplicateReviewOffer,
  DuplicateVia,
  ImportedOriginalProvenance,
  RetiredDraftView,
  RetiredDraftViewInput,
} from '@/lib/ksef/duplicate-decision';

/**
 * Plan usprawnień 3.7b: `lib/ksef/duplicate-decision.ts` podzielony na moduły
 * obok, ale ścieżka `@/lib/ksef/duplicate-decision` zostaje jedynym wejściem
 * dla UI, serwera, workera i testów. Ten test pilnuje, że publiczne API się
 * nie zmienia (lista wartości i typów z 08.11.2026, przed podziałem) i że
 * moduł zostaje czysty: ładują go komponenty klienckie i worker.
 *
 * Nowy eksport = świadoma zmiana tej listy w tym samym PR.
 */

const ROOT = join(__dirname, '..', '..');

const PUBLIC_VALUES = [
  'DUPLICATE_DECISION_BLOCKER_CODES',
  'DUPLICATE_DECISION_SQL_TEXTS',
  'DUPLICATE_DECISION_TEXTS',
  'decisionLabel',
  'duplicateCheckAllows',
  'duplicateDecisionOptions',
  'duplicateEnvLabel',
  'duplicateMarker',
  'duplicateNoticeVariant',
  'duplicateOriginalOffer',
  'fillSqlText',
  'importedOriginalProvenance',
  'originalAssignedDay',
  'originalGateOk',
  'originalRecheckNeeded',
  'ownHistoryInSubmissions',
  'programAccusative',
  'programNominative',
  'retiredDraftSendRefusal',
  'retiredDraftView',
];

/** Lokalne moduły, które ładuje barel (`./duplicate-decision*`), razem z nim samym. */
function decisionModules(): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    const source = readFileSync(join(ROOT, 'lib/ksef', `${name}.ts`), 'utf8');
    seen.set(name, source);
    for (const m of source.matchAll(/from '\.\/(duplicate-decision[a-z-]*)'/g)) visit(m[1]!);
  };
  visit('duplicate-decision');
  return seen;
}

describe('3.7b: publiczne API @/lib/ksef/duplicate-decision', () => {
  it('eksportuje dokładnie te same wartości co przed podziałem', () => {
    expect(Object.keys(decision).sort()).toEqual([...PUBLIC_VALUES].sort());
  });

  it('wartości mają ten sam rodzaj (funkcja albo obiekt)', () => {
    const objects = ['DUPLICATE_DECISION_BLOCKER_CODES', 'DUPLICATE_DECISION_SQL_TEXTS', 'DUPLICATE_DECISION_TEXTS'];
    for (const name of PUBLIC_VALUES) {
      const value = (decision as Record<string, unknown>)[name];
      expect(typeof value, name).toBe(objects.includes(name) ? 'object' : 'function');
    }
  });

  it('eksportuje te same typy (sprawdza `pnpm typecheck`)', () => {
    expectTypeOf<DuplicateChoice>().toEqualTypeOf<'same_sale' | 'other_sale'>();
    expectTypeOf<DuplicateVia>().toEqualTypeOf<'client' | 'operator'>();
    expectTypeOf<DuplicateDecisionReason>().toEqualTypeOf<'no-own-file' | 'known-number' | 'faktflow-original'>();
    expectTypeOf<DuplicateDecisionBlockerCode>().toEqualTypeOf<(typeof decision.DUPLICATE_DECISION_BLOCKER_CODES)[number]>();
    expectTypeOf<DuplicateDecisionSqlTextKey>().toEqualTypeOf<keyof typeof decision.DUPLICATE_DECISION_SQL_TEXTS>();
    expectTypeOf<DuplicateDecisionSqlText>().toEqualTypeOf<{ template: string; arity: number }>();
    expectTypeOf<DuplicateNoticeVariant>().toEqualTypeOf<'pair' | 'record' | 'released' | 'review'>();
    expectTypeOf<DuplicateDecisionLabel>().toEqualTypeOf<DuplicateChoice | 'record'>();
    expectTypeOf<DuplicateRecordIntro>().toEqualTypeOf<'own' | 'same'>();
    expectTypeOf<DuplicateDecidableOffer>().toEqualTypeOf<Extract<DuplicateOriginalOffer, 'pair' | 'record' | 'released'>>();
    expectTypeOf<DuplicateReviewOffer>().toEqualTypeOf<Extract<DuplicateOriginalOffer, 'review-pair' | 'review-record'>>();
    expectTypeOf<DuplicateDecisionRefusal>().toMatchTypeOf<string>();
    expectTypeOf<DuplicateDecisionMode>().toMatchTypeOf<string>();
    expectTypeOf<DuplicateOriginalImportOffer>().toMatchTypeOf<DuplicateOriginalOffer>();
    expectTypeOf(decision.duplicateDecisionOptions).parameter(0).toEqualTypeOf<DuplicateDecisionOptionsInput>();
    expectTypeOf(decision.duplicateDecisionOptions).returns.toEqualTypeOf<DuplicateDecisionView>();
    expectTypeOf<Extract<DuplicateDecisionView, { kind: 'review' }>>().toEqualTypeOf<DuplicateDecisionReviewView>();
    expectTypeOf(decision.retiredDraftView).parameter(0).toEqualTypeOf<RetiredDraftViewInput>();
    expectTypeOf(decision.retiredDraftView).returns.toEqualTypeOf<RetiredDraftView | null>();
    expectTypeOf(decision.importedOriginalProvenance).returns.toEqualTypeOf<ImportedOriginalProvenance | null>();
    expectTypeOf<DuplicateDecisionFacts['invoice']>().toEqualTypeOf<DuplicateDecisionInvoiceRow | null>();
    expectTypeOf<DuplicateDecisionFacts['submissions']>().toEqualTypeOf<DuplicateDecisionSubmissionRow[]>();
    expectTypeOf<DuplicateDecisionFacts['knownInvoice']>().toEqualTypeOf<DuplicateDecisionKnownInvoice | null>();
    expectTypeOf<DuplicateRefusalDetail['originalKsefNumber']>().toEqualTypeOf<string | null>();
    expectTypeOf<DuplicateOriginalViewData['pastPeriod']>().toEqualTypeOf<boolean>();
    expectTypeOf<ComparisonRow['same']>().toEqualTypeOf<boolean | null>();
  });

  it('części barelu importuje tylko barel i inne części (reszta kodu idzie przez barel)', () => {
    const modules = decisionModules();
    const parts = [...modules.keys()].filter((name) => name !== 'duplicate-decision');
    expect(parts.length).toBeGreaterThan(0);
    // Jeden `git grep` zamiast czytania każdego pliku; kod wyjścia 1 = brak trafień.
    let hits = '';
    try {
      hits = execFileSync('git', ['grep', '-lE', `(lib/ksef|\\.)/(${parts.join('|')})['"]`, '--', 'app', 'components', 'lib', 'hooks', 'tests', 'e2e', 'scripts'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
    } catch (e) {
      if ((e as { status?: number }).status !== 1) throw e;
    }
    const insideBarrel = (file: string) => file.startsWith('lib/ksef/') && modules.has(file.slice('lib/ksef/'.length, -'.ts'.length));
    const outside = hits.split('\n').filter((file) => file !== '' && !insideBarrel(file));
    expect(outside).toEqual([]);
  });

  it('barel i jego części zostają czyste: bez server-only, Node, Supabase i duplicate-verdict', () => {
    const modules = decisionModules();
    expect(modules.size).toBeGreaterThanOrEqual(1);
    for (const [name, source] of modules) {
      // Statyczne `from`, import dla efektu ubocznego, `import()` i `require()`.
      const forbidden = /(?:from\s+|import\s*\(?\s*|require\s*\(\s*)['"](server-only|node:[^'"]+|@supabase\/[^'"]+|@\/lib\/supabase\/[^'"]+|[^'"]*duplicate-verdict)['"]/;
      expect(source, name).not.toMatch(forbidden);
      expect(source, name).not.toMatch(/^['"]use (client|server)['"]/m);
      expect(source, name).not.toMatch(/\bnew Date\(\)|\bDate\.now\(/);
    }
  });
});
