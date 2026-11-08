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
const TYPY_DIR = resolve(process.cwd(), 'lib/exports/schemas/jpk-ewp4');
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

function localSchema(katalog: string, fileName: string): string {
  // Tylko `schemaLocation`; przestrzeń nazw (`namespace=`) zostaje bez zmian.
  return REMOTE_PREFIXES.reduce(
    (tresc, prefix) => tresc.split(`schemaLocation="${prefix}`).join('schemaLocation="'),
    readFileSync(resolve(katalog, fileName), 'utf8'),
  );
}

/**
 * Walidator schematu JPK z typami wspólnymi 2022/01/05 (JPK_EWP(4) w K3,
 * JPK_PKPIR(3) w K7: ten sam zestaw plików z `jpk-ewp4/`).
 */
export function walidatorJpk(katalogSchematu: string, nazwaPliku: string): (xml: string) => Promise<JpkEwpValidationResult> {
  let cached: { main: string; preload: { fileName: string; contents: string }[] } | null = null;
  const schema = () =>
    (cached ??= {
      main: localSchema(resolve(process.cwd(), katalogSchematu), MAIN),
      preload: PRELOAD.map((fileName) => ({ fileName, contents: localSchema(TYPY_DIR, fileName) })),
    });
  return async (xml) => {
    const { main, preload } = schema();
    const result = await validateXML({
      xml: [{ fileName: nazwaPliku, contents: xml }],
      schema: [{ fileName: MAIN, contents: main }],
      preload,
    });
    return {
      valid: result.valid,
      errors: result.errors.map((e) => e.rawMessage ?? e.message),
    };
  };
}

export const validateJpkEwp = walidatorJpk('lib/exports/schemas/jpk-ewp4', 'jpk_ewp.xml');

/**
 * JPK_PKPIR(3), wzór `http://jpk.mf.gov.pl/wzor/2024/10/30/10302/`
 * (K7): `jpk-pkpir3/schemat.xsd` pobrany 7.11.2026 z gov.pl (strona KAS
 * „Struktury JPK w podatkach dochodowych”, za zgodą Bartosza), BEZ zmian.
 */
export const validateJpkPkpir = walidatorJpk('lib/exports/schemas/jpk-pkpir3', 'jpk_pkpir.xml');
