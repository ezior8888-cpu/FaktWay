import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Strażnik tekstów dla klienta (plan usprawnień 2.9). Decyzja Bartosza:
 * w tekstach dla klienta bez długich myślników („—”) i bez plakietek nad
 * nagłówkami (mały napis `uppercase` + `tracking` tuż nad `<h1>`–`<h3>`).
 *
 * Dziś takich miejsc jest kilkaset, a zmiana tekstów na zamrożonym desktopie
 * to osobna decyzja. Dlatego to zapadka: liczba na plik z
 * `tests/unit/fixtures/teksty-stan.json` nie może rosnąć, a nowy plik nie
 * może mieć ani jednego. Po poprawce tekstów zapisz mniejszy stan:
 *
 *   ZAPISZ_STAN_TEKSTOW=1 pnpm vitest run tests/unit/teksty-straznik.test.ts
 *
 * Zapis tylko zmniejsza liczby, nigdy ich nie podnosi.
 *
 * Liczone są napisy i tekst JSX (nie komentarze) w `app/`, `components/`,
 * `lib/`, `hooks/` i tekst artykułów w `content/`. Poza zakresem: panel
 * operatora (`app/admin`, `lib/admin`), pliki FLO (tor Igora, jak w
 * `nazwa-produktu.test.ts`), testy i komunikaty, których klient nie widzi
 * (`console.*`, `logger.*`, `new Error(…)`). „FaktFlow” pilnuje
 * `nazwa-produktu.test.ts`.
 */

const ROOT = join(__dirname, '..', '..');
const STATE_FILE = join(ROOT, 'tests/unit/fixtures/teksty-stan.json');
const DASH = /—/g;
const OUT_OF_SCOPE = [
  /^app\/admin\//,
  /^lib\/admin\//,
  /^components\/flo\//,
  /^app\/\(dashboard\)\/flo\//,
  /^app\/\(dashboard\)\/settings\/flo\//,
  /^content\/flo\//,
  /^lib\/flo\//,
  /\.test\.tsx?$/,
  /\/__tests__\//,
  /\.d\.ts$/,
];
const HIDDEN_CALLEES = /^(console|logger|log)\.|^(Error|TypeError|RangeError|NonRetriableError)$/;

interface Counts {
  myslniki: number;
  plakietki: number;
}
type State = Record<string, Counts>;

function trackedFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--', 'app', 'components', 'lib', 'hooks', 'content'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return out
    .split('\n')
    .filter((f) => /\.(tsx?|mdx?)$/.test(f))
    .filter((f) => !OUT_OF_SCOPE.some((re) => re.test(f)));
}

function calleeName(node: ts.Node): string | null {
  if (!ts.isCallExpression(node) && !ts.isNewExpression(node)) return null;
  return node.expression.getText();
}

function classNameOf(element: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const attributes = ts.isJsxElement(element) ? element.openingElement.attributes : element.attributes;
  for (const attribute of attributes.properties) {
    if (ts.isJsxAttribute(attribute) && attribute.name.getText() === 'className' && attribute.initializer) {
      return attribute.initializer.getText();
    }
  }
  return '';
}

function tagOf(element: ts.JsxElement | ts.JsxSelfClosingElement): string {
  return (ts.isJsxElement(element) ? element.openingElement.tagName : element.tagName).getText();
}

/** Liczby dla jednego pliku TS/TSX. */
export function countInSource(file: string, source: string): Counts {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let myslniki = 0;
  let plakietki = 0;
  const visit = (node: ts.Node, hidden: boolean) => {
    const name = calleeName(node);
    const hiddenHere = hidden || (name !== null && HIDDEN_CALLEES.test(name));
    if (
      !hiddenHere &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node))
    ) {
      myslniki += (node.text.match(DASH) ?? []).length;
    }
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const children = node.children.filter((c): c is ts.JsxElement | ts.JsxSelfClosingElement => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c));
      for (let i = 0; i < children.length - 1; i += 1) {
        const cls = classNameOf(children[i]!);
        if (/\buppercase\b/.test(cls) && /\btracking-/.test(cls) && /^h[1-3]$/.test(tagOf(children[i + 1]!))) plakietki += 1;
      }
    }
    ts.forEachChild(node, (child) => visit(child, hiddenHere));
  };
  visit(sf, false);
  return { myslniki, plakietki };
}

/** Artykuły MDX: tekst poza blokami kodu. */
export function countInMarkdown(source: string): Counts {
  const prose = source.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  return { myslniki: (prose.match(DASH) ?? []).length, plakietki: 0 };
}

function currentState(): State {
  const state: State = {};
  for (const file of trackedFiles()) {
    const source = readFileSync(join(ROOT, file), 'utf8');
    if (!source.includes('—') && !source.includes('uppercase')) continue;
    const counts = /\.mdx?$/.test(file) ? countInMarkdown(source) : countInSource(file, source);
    if (counts.myslniki || counts.plakietki) state[file] = counts;
  }
  return state;
}

export function ratchetProblems(current: State, saved: State): string[] {
  const problems: string[] = [];
  for (const [file, counts] of Object.entries(current)) {
    const before = saved[file] ?? { myslniki: 0, plakietki: 0 };
    if (counts.myslniki > before.myslniki) {
      problems.push(`${file}: długie myślniki ${before.myslniki} → ${counts.myslniki}. W tekście dla klienta użyj przecinka, dwukropka albo nowego zdania.`);
    }
    if (counts.plakietki > before.plakietki) {
      problems.push(`${file}: plakietki nad nagłówkiem ${before.plakietki} → ${counts.plakietki}. Usuń mały napis uppercase nad <h1>–<h3>.`);
    }
  }
  return problems;
}

describe('strażnik tekstów dla klienta', () => {
  const current = currentState();
  if (!existsSync(STATE_FILE)) {
    // Pierwsze uruchomienie: stan początkowy z dzisiejszego kodu (widoczny w diffie PR).
    writeFileSync(STATE_FILE, `${JSON.stringify(current, null, 2)}\n`);
  }
  const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;

  if (process.env.ZAPISZ_STAN_TEKSTOW === '1') {
    const lowered: State = {};
    for (const [file, counts] of Object.entries(current)) {
      const before = saved[file] ?? { myslniki: 0, plakietki: 0 };
      const next = { myslniki: Math.min(counts.myslniki, before.myslniki), plakietki: Math.min(counts.plakietki, before.plakietki) };
      if (next.myslniki || next.plakietki) lowered[file] = next;
    }
    writeFileSync(STATE_FILE, `${JSON.stringify(lowered, null, 2)}\n`);
  }

  it('żaden plik nie ma więcej długich myślników ani plakietek niż w zapisanym stanie', () => {
    expect(ratchetProblems(current, saved)).toEqual([]);
  });

  it('zapisany stan nie zawyża liczb (po poprawce zapisz mniejszy stan)', () => {
    const stale = Object.entries(saved)
      .filter(([file, counts]) => {
        const now = current[file] ?? { myslniki: 0, plakietki: 0 };
        return now.myslniki < counts.myslniki || now.plakietki < counts.plakietki;
      })
      .map(([file]) => file);
    expect(stale, 'uruchom: ZAPISZ_STAN_TEKSTOW=1 pnpm vitest run tests/unit/teksty-straznik.test.ts').toEqual([]);
  });

  it('wyłapuje myślnik w napisie i JSX, pomija komentarze, logi i błędy', () => {
    const src = [
      "// komentarz — nie liczy się",
      "export const a = 'Faktura — wysłana';",
      "console.log('log — pomijany');",
      "throw new Error('błąd — pomijany');",
      "export const B = () => <p>Tekst — w JSX</p>;",
    ].join('\n');
    expect(countInSource('x.tsx', src)).toEqual({ myslniki: 2, plakietki: 0 });
  });

  it('wyłapuje plakietkę uppercase + tracking tuż nad nagłówkiem', () => {
    const src = `export const H = () => (<div><p className="text-xs uppercase tracking-wide">Nowość</p><h2>Tytuł</h2></div>);`;
    const notBadge = `export const H = () => (<div><p className="text-xs uppercase tracking-wide">Nowość</p><p>Akapit</p></div>);`;
    expect(countInSource('x.tsx', src).plakietki).toBe(1);
    expect(countInSource('x.tsx', notBadge).plakietki).toBe(0);
  });

  it('zapadka: wzrost w pliku i nowy plik z myślnikiem to problem, spadek nie', () => {
    const saved = { 'a.tsx': { myslniki: 2, plakietki: 0 } };
    expect(ratchetProblems({ 'a.tsx': { myslniki: 3, plakietki: 0 } }, saved)).toHaveLength(1);
    expect(ratchetProblems({ 'b.tsx': { myslniki: 1, plakietki: 0 } }, saved)).toHaveLength(1);
    expect(ratchetProblems({ 'a.tsx': { myslniki: 1, plakietki: 0 } }, saved)).toEqual([]);
  });
});
