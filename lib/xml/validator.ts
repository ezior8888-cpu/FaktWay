import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateXML } from 'xmllint-wasm';

const SCHEMA_DIR = resolve(process.cwd(), 'lib/xml/schemas/fa3');

/**
 * Ścieżki XSD rozłożone w drzewo includes:
 *   schemat-local.xsd
 *     └── StrukturyDanych_v10-0E.xsd
 *           └── ElementarneTypyDanych_v10-0E.xsd
 *                 └── KodyKrajow_v10-0E.xsd
 *
 * xmllint-wasm wymaga pełnego preload (żadnych requestów sieciowych).
 */
const SCHEMA_FILES = {
  main: 'schemat-local.xsd',
  preload: [
    'StrukturyDanych_v10-0E.xsd',
    'ElementarneTypyDanych_v10-0E.xsd',
    'KodyKrajow_v10-0E.xsd',
  ],
} as const;

export interface ValidationError {
  line: number;
  column: number;
  message: string;
  /** Surowy komunikat z xmllint (z prefixem pliku i linii). */
  raw: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  /** Pełny stderr z xmllint - przydatne przy debugu. */
  rawOutput?: string;
}

/**
 * Cache treści XSD - odczyt z dysku robimy raz na proces.
 * xmllint-wasm i tak parsuje schemę w workerze per wywołanie
 * (nie eksponuje API do persistencji sparsowanej schemy),
 * więc cachujemy przynajmniej I/O.
 */
let cachedSchemaPayload:
  | {
      main: string;
      preload: { fileName: string; contents: string }[];
    }
  | null = null;

function getSchemaPayload() {
  if (cachedSchemaPayload) return cachedSchemaPayload;

  cachedSchemaPayload = {
    main: readFileSync(resolve(SCHEMA_DIR, SCHEMA_FILES.main), 'utf8'),
    preload: SCHEMA_FILES.preload.map((file) => ({
      fileName: file,
      contents: readFileSync(resolve(SCHEMA_DIR, file), 'utf8'),
    })),
  };
  return cachedSchemaPayload;
}

/**
 * Waliduje XML FA(3) lokalnie względem oficjalnego XSD MF
 * używając libxml2 2.13.8 skompilowanego do WebAssembly.
 *
 * Używać ZAWSZE przed wysyłką do KSeF — oszczędza tokeny sesji
 * i daje natychmiastowy feedback bez round-tripa przez API.
 *
 * Działa offline (wszystkie XSD dependencies są bundlowane lokalnie),
 * więc nie wymaga dostępu do sieci w runtime.
 */
export async function validateFA3(xmlString: string): Promise<ValidationResult> {
  const { main, preload } = getSchemaPayload();

  const result = await validateXML({
    xml: [{ fileName: 'invoice.xml', contents: xmlString }],
    schema: [main],
    preload,
  });

  if (result.valid) {
    return { valid: true, errors: [], rawOutput: result.rawOutput };
  }

  return {
    valid: false,
    errors: result.errors.map((err) => ({
      line: err.loc?.lineNumber ?? 0,
      column: 0,
      message: err.message,
      raw: err.rawMessage,
    })),
    rawOutput: result.rawOutput,
  };
}

/**
 * Klasa błędu mieszka w module granic (C1), bo rzucają ją też generatory,
 * zanim zbudują XML, a ten moduł nie może ciągnąć `node:fs` do przeglądarki.
 * Stąd ta sama klasa, więc `instanceof` i kod XSD_INVALID działają jak dotąd.
 */
export { InvoiceXmlSchemaError } from '@/lib/xml/fa3-limits';

/**
 * Preferowany entry point przed wysyłką do KSeF.
 *
 * Walidacja biznesowa (NIP checksum, arytmetyka, daty) jest już
 * wykonywana przez `validateInvoice` w `invoice-calculator.ts`
 * na etapie generowania XML — tutaj potwierdzamy jedynie
 * zgodność wygenerowanego dokumentu ze schemą XSD.
 */
export async function validateInvoiceXml(
  xmlString: string,
): Promise<ValidationResult> {
  return validateFA3(xmlString);
}
