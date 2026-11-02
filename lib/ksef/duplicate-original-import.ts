/**
 * Zapis oryginału z KSeF — część serwerowa (D-A4-1b-3 PR C, spec v3 5.3):
 * suchy przebieg przed RPC decyzji (`prepareOriginalImport`: archiwum, brama,
 * projekcja — tylko odczyty) i alarmy po decyzji ze stanu bazy
 * (`originalDecisionAlarms`, T5: na każdej ścieżce akcji, odcisk Sentry
 * `[kind, invoiceId]`).
 *
 * Woła go akcja klienta (`components/invoices/actions-detail.ts`) i akcje
 * operatora (`app/admin/ksef/actions.ts`); strona operatora robi suchy
 * przebieg, żeby pokazać `recordable` (INV-13 — bez alarmów i zapisów).
 * Strona klienta go NIE woła.
 *
 * Ponowienie od zera: `prepareOriginalImport` tylko czyta (magazyn) i liczy
 * czyste funkcje — te same bajty i ten sam znacznik dają ten sam wynik.
 * `originalDecisionAlarms` czyta stan bazy i zgłasza alarmy z odciskiem
 * `[kind, invoiceId]`, więc powtórzenie po zgubionej odpowiedzi trafia w to
 * samo zgłoszenie Sentry.
 */

import 'server-only';

import { createHash } from 'node:crypto';

import * as Sentry from '@sentry/nextjs';

import { decodeKsefXml } from '@/lib/import/ksef-xml-archive';
import { logger } from '@/lib/observability/logger';
import { downloadFromR2 } from '@/lib/storage/r2';
import type { createAdminClient } from '@/lib/supabase/admin';
import type { KsefEnvironment } from '@/types/ksef';

import {
  KSEF_ORIGINAL_ALARM_KINDS,
  ORIGINAL_GATE_UNBUILDABLE_PROBLEMS,
  originalGateOk,
  type DuplicateOriginalOffer,
  type KsefDuplicateCheck,
  type KsefOriginalImportGate,
  type OriginalGateProblem,
  type OriginalRecheckKind,
} from './duplicate-check';
import { evaluateOriginalGate } from './duplicate-original-gate';
import {
  buildOriginalImportProjection,
  ORIGINAL_IMPORT_CLIENT_PROBLEMS,
  originalImportProjectionProblem,
  type KsefOriginalImportProjection,
} from './duplicate-original-projection';

type AdminClient = ReturnType<typeof createAdminClient>;

/** Dlaczego oryginału nie zapiszemy teraz (5.3 kroki 1–6). */
export type PrepareOriginalImportFailureKind =
  /** `NoSuchKey`/404 w magazynie. */
  | 'archive-missing'
  /** SHA-256 albo długość bajtów ≠ `check.sha256` / `check.sizeBytes`. */
  | 'archive-mismatch'
  /** Inny błąd magazynu — chwilowy; bez znacznika `recheckNeeded` (`cause` do Sentry). */
  | 'read-failed'
  /** Tylko `pair`/`record`: bieżąca brama ma inny `kind` albo inne `problems` (zbiór) niż zapisana; sama inna `rules` to nie zmiana. */
  | 'gate-drift'
  /** Projekcji nie da się zbudować albo nie przechodzi lustra 4.8 (`detail` = problem bramy albo kod 4.8). */
  | 'not-buildable';

export interface PrepareOriginalImportInput {
  tenantId: string;
  /** Numer X. */
  internalNumber: string;
  /** `tenants.nip`. */
  tenantNip: string;
  /** Oferta pokazana klientowi/operatorowi (z widoku). */
  offer: DuplicateOriginalOffer;
  check: KsefDuplicateCheck;
  /** K. */
  ksefNumber: string;
  env: KsefEnvironment;
  now: Date;
}

export type PrepareOriginalImportResult =
  | { ok: true; projection: KsefOriginalImportProjection; gate: KsefOriginalImportGate }
  | { ok: false; kind: PrepareOriginalImportFailureKind; detail?: string; cause?: unknown };

export interface OriginalDecisionAlarmsInput {
  tenantId: string;
  /** X. */
  invoiceId: string;
  /** K z wyniku RPC albo z `decision.importedInvoiceId`; `null` — decyzja bez zapisu (`no-import`), nic do sprawdzenia. */
  importedInvoiceId: string | null;
}

/** Oferty, przy których zapisana brama mówi `importable` — tylko przy nich rozjazd bramy jest błędem (krok 4). */
const IMPORTABLE_OFFERS: ReadonlySet<DuplicateOriginalOffer> = new Set<DuplicateOriginalOffer>(['pair', 'record']);
const UNBUILDABLE: ReadonlySet<string> = new Set<string>(ORIGINAL_GATE_UNBUILDABLE_PROBLEMS);
const CLIENT_PROBLEMS: ReadonlySet<string> = new Set<string>(ORIGINAL_IMPORT_CLIENT_PROBLEMS);

/** `tags.area` alarmów zapisu oryginału (5.11). */
const ALARM_AREA = 'ksef.duplicate-decision';

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Brak obiektu w magazynie: `NoSuchKey` z SDK S3 (GetObject), `NotFound`
 * (HEAD) albo odpowiedź 404 — po nazwie i metadanych, bez zależności od klasy
 * (ta sama klasa z dwóch kopii SDK nie przeszłaby `instanceof`).
 */
function isMissingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, $metadata } = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return name === 'NoSuchKey' || name === 'NotFound' || $metadata?.httpStatusCode === 404;
}

/** Ta sama lista kodów jako zbiór (kolejność i powtórzenia bez znaczenia). */
function sameProblemSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((p) => sb.has(p));
}

const describeGate = (gate: Pick<KsefOriginalImportGate, 'kind' | 'problems'>): string =>
  `${gate.kind} [${gate.problems.join(', ')}]`;

/**
 * Zmiana bramy przy `pair`/`record` (krok 4): opis różnicy albo `null`, gdy
 * ocena ta sama (`kind` i `problems` jako zbiór). Zapisana brama w złym
 * kształcie to też zmiana — oferty `pair`/`record` bez poprawnej bramy nie ma
 * (blokada `recheck-needed`), więc to wyścig ze zmianą znacznika.
 */
function gateDrift(saved: unknown, current: KsefOriginalImportGate): string | null {
  if (!originalGateOk(saved)) return `zapisana brama nieczytelna, jest ${describeGate(current)}`;
  const gate = saved as KsefOriginalImportGate;
  if (gate.kind === current.kind && sameProblemSet(gate.problems, current.problems)) return null;
  return `zapisano ${describeGate(gate)}, jest ${describeGate(current)}`;
}

/** Pierwszy problem bramy (kolejność `ORIGINAL_GATE_PROBLEMS`), przy którym oryginału nie zapisze nikt (tabela 1.1). */
function unbuildableProblem(problems: readonly OriginalGateProblem[]): OriginalGateProblem | null {
  return problems.find((p) => UNBUILDABLE.has(p)) ?? null;
}

/**
 * Suchy przebieg zapisu oryginału (5.3): `downloadFromR2(check.archivePath)` →
 * SHA-256 i rozmiar → `evaluateOriginalGate` → zmiana bramy (tylko
 * `pair`/`record`) → zapisywalność (`ORIGINAL_GATE_UNBUILDABLE_PROBLEMS` przy
 * `review-*`) → `buildOriginalImportProjection` + `originalImportProjectionProblem`.
 * Tylko odczyty; nigdy nie pisze i nie alarmuje.
 */
export async function prepareOriginalImport(input: PrepareOriginalImportInput): Promise<PrepareOriginalImportResult> {
  const { check, offer } = input;
  // Znacznik bez pliku w archiwum (nie powinien dać oferty) — nie ma czego czytać; nowy werdykt odbuduje archiwum.
  if (check.archivePath === null || check.sha256 === null || check.sizeBytes === null) {
    return { ok: false, kind: 'archive-missing', detail: 'znacznik bez archivePath, sha256 albo sizeBytes' };
  }

  // 1. Archiwum bajtów oryginału (klucz w folderze firmy — `downloadFromR2` to pilnuje).
  let bytes: Buffer;
  try {
    bytes = await downloadFromR2(check.archivePath, input.tenantId);
  } catch (error) {
    if (isMissingObject(error)) return { ok: false, kind: 'archive-missing' };
    return { ok: false, kind: 'read-failed', cause: error };
  }

  // 2. Te same bajty, które ocenił runner (INV-1: K to dokładnie plik z KSeF).
  if (sha256Hex(bytes) !== check.sha256 || bytes.length !== check.sizeBytes) {
    return { ok: false, kind: 'archive-mismatch' };
  }

  // 3. Brama na bieżących bajtach — czysta, nigdy nie rzuca.
  const evaluation = evaluateOriginalGate({
    xml: decodeKsefXml(bytes),
    ksefNumber: input.ksefNumber,
    internalNumber: input.internalNumber,
    tenantNip: input.tenantNip,
  });
  const { gate, parsed, content, amounts } = evaluation;

  if (IMPORTABLE_OFFERS.has(offer)) {
    // 4. Zmiana bramy: klient widział ofertę z oceny `importable` — inna ocena dziś to nowa sprawa.
    const drift = gateDrift(check.importGate, gate);
    if (drift !== null) return { ok: false, kind: 'gate-drift', detail: drift };
    const savedRules = check.importGate?.rules;
    if (savedRules !== gate.rules) {
      // Sama wersja reguł to nie zmiana bramy (5.2): ta sama ocena, plik zapisujemy.
      logger.info('Zapis oryginału: inna wersja reguł bramy przy tej samej ocenie pliku', {
        ksefNumber: input.ksefNumber,
        savedRules,
        rules: gate.rules,
      });
    }
  } else {
    // 5. Zapisywalność przy przeglądzie: problemy, przy których projekcji nie zbuduje nikt (tabela 1.1).
    const problem = unbuildableProblem(gate.problems);
    if (problem !== null) return { ok: false, kind: 'not-buildable', detail: problem };
  }
  // Plik nieczytelny albo w walucie obcej — przy każdej ofercie (przy `pair`/`record` łapie to już krok 4).
  if (parsed === null || content === null || amounts === null) {
    return { ok: false, kind: 'not-buildable', detail: gate.problems[0] ?? 'parse' };
  }

  // 6. Projekcja K i lustro 4.8 — to samo, co sprawdzi baza w RPC.
  let projection: KsefOriginalImportProjection;
  try {
    projection = buildOriginalImportProjection(parsed, content, amounts, {
      tenantId: input.tenantId,
      env: input.env,
      check,
      ksefNumber: input.ksefNumber,
      now: input.now,
    });
  } catch (error) {
    return { ok: false, kind: 'not-buildable', detail: 'shape', cause: error };
  }
  const mismatch = originalImportProjectionProblem(projection, {
    internalNumber: input.internalNumber,
    tenantNip: input.tenantNip,
    tenantId: input.tenantId,
    ksefNumber: input.ksefNumber,
    check,
    offer,
  });
  if (mismatch !== null) return { ok: false, kind: 'not-buildable', detail: mismatch };

  return { ok: true, projection, gate };
}

/**
 * Rodzaj znacznika `recheckNeeded` dla odmowy suchego przebiegu na ścieżce
 * zapisu (5.6 krok 9, wspólne dla klienta i operatora): `archive-*` i
 * `gate-drift` — ten sam rodzaj; `not-buildable` z `detail` `number`/`seller`
 * → `import-mismatch`, inaczej `not-buildable`; `read-failed` → `null`
 * (chwilowy błąd magazynu — bez znacznika).
 */
export function originalRecheckKindFor(
  failure: { kind: PrepareOriginalImportFailureKind; detail?: string },
): OriginalRecheckKind | null {
  switch (failure.kind) {
    case 'archive-missing':
    case 'archive-mismatch':
    case 'gate-drift':
      return failure.kind;
    case 'not-buildable':
      return failure.detail !== undefined && CLIENT_PROBLEMS.has(failure.detail) ? 'import-mismatch' : 'not-buildable';
    case 'read-failed':
      return null;
  }
}

interface ImportedInvoiceRow {
  id: string;
  ksef_number: string | null;
  ksef_accepted_at: string | null;
}

interface ImportedSubmissionRow {
  session_reference_number: string | null;
  response_ksef_number: string | null;
}

interface ReadError {
  message?: string;
  code?: string;
}

/** Błąd odczytu po decyzji: decyzja jest zapisana, I3K i tak to pokaże — jedyny ślad w Sentry. */
function reportAlarmReadFailure(error: unknown, input: OriginalDecisionAlarmsInput, what: string): void {
  Sentry.captureException(error instanceof Error ? error : new Error(`originalDecisionAlarms: ${what}`), {
    tags: { area: ALARM_AREA },
    extra: {
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      importedInvoiceId: input.importedInvoiceId,
      what,
      ...(error instanceof Error ? {} : { error }),
    },
  });
}

function readError(what: string, error: ReadError): Error {
  return new Error(`originalDecisionAlarms: odczyt ${what} nieudany${error.code ? ` (${error.code})` : ''}`);
}

/**
 * Alarmy po decyzji — ze stanu bazy, na KAŻDEJ ścieżce sukcesu akcji (nowa
 * decyzja, `already_decided`, wczesny widok `decided`): K bez
 * `ksef_accepted_at` → `ksef-duplicate-import-no-date`; K bez wpisu z sesją
 * (`response_ksef_number = K`, sesja nie NULL) → `ksef-duplicate-import-no-session`
 * (`level: 'warning'`, `tags.area = 'ksef.duplicate-decision'`, odcisk
 * `[kind, invoiceId]`). Błąd odczytu → `Sentry.captureException`. Nigdy nie rzuca.
 */
export async function originalDecisionAlarms(admin: AdminClient, input: OriginalDecisionAlarmsInput): Promise<void> {
  const { tenantId, invoiceId, importedInvoiceId } = input;
  if (importedInvoiceId === null) return;
  try {
    // Dwa odczyty naraz: K i jego wpisy historii wysyłki (dopasowanie numeru KSeF w TypeScript).
    const [invoiceRead, submissionsRead] = await Promise.all([
      admin
        .from('invoices')
        .select('id, ksef_number, ksef_accepted_at')
        .eq('id', importedInvoiceId)
        .eq('tenant_id', tenantId)
        .maybeSingle(),
      admin
        .from('ksef_submissions')
        .select('session_reference_number, response_ksef_number')
        .eq('tenant_id', tenantId)
        .eq('invoice_id', importedInvoiceId),
    ]);
    let failed = false;
    if (invoiceRead.error) {
      reportAlarmReadFailure(readError('faktury K', invoiceRead.error), input, 'faktury K');
      failed = true;
    }
    if (submissionsRead.error) {
      reportAlarmReadFailure(readError('wpisów K', submissionsRead.error), input, 'wpisów K');
      failed = true;
    }
    if (failed) return;
    const k = invoiceRead.data as ImportedInvoiceRow | null;
    if (!k) {
      // K z wyniku RPC nie istnieje w tej firmie — rozjazd stanu, nie dane do alarmów zapisu.
      reportAlarmReadFailure(new Error('originalDecisionAlarms: brak faktury K w tej firmie'), input, 'faktury K');
      return;
    }
    const rows = (submissionsRead.data ?? []) as unknown as ImportedSubmissionRow[];
    const withSession = k.ksef_number !== null && rows.some((r) => r.response_ksef_number === k.ksef_number
      && typeof r.session_reference_number === 'string' && r.session_reference_number !== '');

    const alarm = (kind: string, message: string) =>
      Sentry.captureMessage(message, {
        level: 'warning',
        tags: { area: ALARM_AREA, kind },
        fingerprint: [kind, invoiceId],
        extra: { tenantId, invoiceId, importedInvoiceId },
      });
    if (!k.ksef_accepted_at) {
      // Runbook: scripts/ops/oryginal-ksef-data-nadania.sh (data nadania z metadanych KSeF).
      alarm(KSEF_ORIGINAL_ALARM_KINDS.importNoDate, 'KSeF: faktura zapisana z KSeF bez daty nadania numeru');
    }
    if (!withSession) {
      // Runbook: UPO ręcznie (D-A4-1b-3-UPO) — bez sesji nie pobierzemy UPO automatem.
      alarm(KSEF_ORIGINAL_ALARM_KINDS.importNoSession, 'KSeF: faktura zapisana z KSeF bez sesji (UPO)');
    }
  } catch (error) {
    reportAlarmReadFailure(error, input, 'stanu po decyzji');
  }
}
