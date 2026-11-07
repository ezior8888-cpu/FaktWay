import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateXML } from 'xmllint-wasm';

/**
 * Walidacja JPK_EWP(4) względem oficjalnego XSD MF, wzór
 * `http://jpk.mf.gov.pl/wzor/2024/10/30/10301/`. Pliki w
 * `lib/exports/schemas/jpk-ewp4/` (śledzi je build, `next.config.ts`):
 * `schemat.xsd` pobrany 5.11.2026 z gov.pl (strona KAS „Struktury JPK
 * w podatkach dochodowych”), typy wspólne z crd.gov.pl (2022/01/05) to kopie
 * plików z `lib/xml/schemas/fa3/` i `lib/exports/schemas/jpk-v7m3/`, BEZ zmian:
 *
 *   schemat.xsd
 *     ├── StrukturyDanych_v10-0E.xsd
 *     │     └── ElementarneTypyDanych_v10-0E.xsd
 *     │           └── KodyKrajow_v10-0E.xsd
 *     └── KodyUrzedowSkarbowych_v8-0E.xsd
 *
 * Schemat wskazuje typy wspólne pełnymi adresami crd.gov.pl, a xmllint-wasm
 * nie chodzi do sieci: prefiksy zdejmujemy przy wczytaniu (jak
 * `jpk-fa-validator.ts`), treść plików zostaje oryginalna.
 */
const SCHEMA_DIR = resolve(process.cwd(), 'lib/exports/schemas/jpk-ewp4');
const MAIN = 'schemat.xsd';
const PRELOAD = [
  'StrukturyDanych_v10-0E.xsd',
  'ElementarneTypyDanych_v10-0E.xsd',
  'KodyKrajow_v10-0E.xsd',
  'KodyUrzedowSkarbowych_v8-0E.xsd',
];
const REMOTE_PREFIXES = [
  'http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/',
  'http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/KodyUrzedowSkarbowych/',
];

export interface JpkEwpValidationResult {
  valid: boolean;
  /** Komunikaty xmllint: do logów, nie do interfejsu (niosą wartości pól). */
  errors: string[];
}

let cached: { main: string; preload: { fileName: string; contents: string }[] } | null = null;

function localSchema(fileName: string): string {
  // Tylko `schemaLocation`; przestrzeń nazw (`namespace=`) zostaje bez zmian.
  return REMOTE_PREFIXES.reduce(
    (tresc, prefix) => tresc.split(`schemaLocation="${prefix}`).join('schemaLocation="'),
    readFileSync(resolve(SCHEMA_DIR, fileName), 'utf8'),
  );
}

function schema() {
  if (cached) return cached;
  cached = {
    main: localSchema(MAIN),
    preload: PRELOAD.map((fileName) => ({ fileName, contents: localSchema(fileName) })),
  };
  return cached;
}

export async function validateJpkEwp(xml: string): Promise<JpkEwpValidationResult> {
  const { main, preload } = schema();
  const result = await validateXML({
    xml: [{ fileName: 'jpk_ewp.xml', contents: xml }],
    schema: [{ fileName: MAIN, contents: main }],
    preload,
  });
  return {
    valid: result.valid,
    errors: result.errors.map((e) => e.rawMessage ?? e.message),
  };
}
