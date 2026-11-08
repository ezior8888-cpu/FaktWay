import { describe, expect, it } from 'vitest';

import { operatorReconcileRefusal } from '@/lib/admin/ksef-operator-policy';
import type { KsefResendFacts } from '@/lib/invoices/ksef-requeue-event';
import { KSEF_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';
import { DUPLICATE_DECISION_TEXTS } from '@/lib/ksef/duplicate-decision';
import { SUPPORT_EMAIL } from '@/lib/site';
import type { KsefEnvironment } from '@/types/ksef';

import {
  decisionFacts,
  DUP_K,
  DUP_NR,
  faktflowGate,
  knownNumberCheck,
  validCheck,
} from './helpers/ksef-duplicate-decision-cases';

/**
 * D-A4-1b-3 PR D (stos na #248): polityka „Sprawdź ponownie” klienta przy
 * `KSEF_DUPLICATE_RECONCILE`, gdy brakuje danych oryginału (czysty moduł
 * `lib/ksef/duplicate-recheck.ts`). Do PR D klient czekał na cron I5 (48 h)
 * albo na „Tylko uzgodnij” operatora.
 *
 * Kiedy wolno (decyzja D2): `failed` + `KSEF_DUPLICATE_RECONCILE` + otwarty
 * wpis ze znacznikiem oryginału + jedno z: brak zapisu sprawdzenia
 * (`no-check`), powód pobrania/magazynu/archiwum (4 powody), środowisko
 * sprawdzenia inne niż `KSEF_ENV` aplikacji. Nie dla powodów z panelem decyzji
 * (`no-own-file`, `known-number`, `faktflow-original` z bramą) ani
 * deterministycznych (`same-content-other-program`, `archive-conflict`).
 * Kto: tylko właściciel/administrator (D1). Cooldown 10 minut (D3).
 */

const MODULE = '@/lib/ksef/duplicate-recheck';

type Reason = 'no-check' | 'download-refused' | 'download-pending' | 'storage-pending' | 'archive-pending' | 'env-mismatch';

interface Refusal {
  code: string;
  message: string;
}

interface RecheckView {
  kind: 'recheck';
  reason: Reason;
  invoiceNumber: string | null;
  originalKsefNumber: string;
  assignedDay: string | null;
  grantInvoiceRead: boolean;
  cooldownMsLeft: number | null;
  refusal: Refusal | null;
}

interface RecheckInput {
  facts: ReturnType<typeof decisionFacts>;
  sendFacts: KsefResendFacts;
  canManage: boolean;
  environment: KsefEnvironment | null;
  lastRecheckAt: string | null;
  now: Date;
}

type Blocker = 'incoming' | 'status' | 'env-unknown' | 'send-data-missing' | 'kind-held' | 'no-open-submission' | null;

interface PolicyModule {
  duplicateRecheckView: (input: RecheckInput) => RecheckView | null;
  reconcileOnlyBlocker: (input: {
    direction: string | null;
    status: string | null;
    environmentKnown: boolean;
    facts: Pick<KsefResendFacts, 'sendData' | 'kindHeld'>;
    openSent: boolean;
  }) => Blocker;
  DUPLICATE_RECHECK_COOLDOWN_MS: number;
  DUPLICATE_RECHECK_AUDIT_ACTION: string;
  DUPLICATE_RECHECK_REASONS: readonly string[];
}

async function policy(): Promise<PolicyModule> {
  return (await import(/* @vite-ignore */ MODULE)) as PolicyModule;
}

const NOW = new Date('2026-10-26T12:00:00.000Z');
const STORED: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: false };

async function view(over: Partial<RecheckInput> = {}): Promise<RecheckView | null> {
  const { duplicateRecheckView } = await policy();
  return duplicateRecheckView({
    facts: decisionFacts({ check: validCheck({ reason: 'download-pending', httpStatus: 503 }) }),
    sendFacts: STORED,
    canManage: true,
    environment: 'test',
    lastRecheckAt: null,
    now: NOW,
    ...over,
  });
}

const factsOf = (check: unknown, extra: Parameters<typeof decisionFacts>[0] = {}) => decisionFacts({ ...extra, check });

describe('PR D: polityka „Sprawdź ponownie” (D2): kiedy wolno', () => {
  it('stałe: cooldown 10 minut, akcja audytu i lista powodów', async () => {
    const p = await policy();
    expect(p.DUPLICATE_RECHECK_COOLDOWN_MS).toBe(10 * 60 * 1000);
    expect(p.DUPLICATE_RECHECK_AUDIT_ACTION).toBe('invoice.duplicate_recheck');
    expect([...p.DUPLICATE_RECHECK_REASONS].sort()).toEqual(
      ['archive-pending', 'download-pending', 'download-refused', 'env-mismatch', 'no-check', 'storage-pending'],
    );
  });

  it.each([
    ['download-refused', validCheck({ reason: 'download-refused', httpStatus: 403 })],
    ['download-pending', validCheck({ reason: 'download-pending', httpStatus: 503 })],
    ['storage-pending', validCheck({ reason: 'storage-pending' })],
    ['archive-pending', validCheck({ reason: 'archive-pending' })],
    ['no-check', null],
  ] as const)('powód %s: przycisk dostępny dla właściciela/administratora, z numerem KSeF i dniem nadania', async (reason, check) => {
    const v = await view({ facts: factsOf(check) });
    expect(v).not.toBeNull();
    expect(v).toMatchObject({
      kind: 'recheck',
      reason,
      invoiceNumber: DUP_NR,
      originalKsefNumber: DUP_K,
      refusal: null,
    });
    // Dzień z numeru KSeF (RRRRMMDD w numerze) albo z `acquiredAt` (Europe/Warsaw).
    expect(v!.assignedDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each([
    ['no-own-file', validCheck()],
    ['known-number', knownNumberCheck()],
    ['faktflow-original z bramą', validCheck({
      reason: 'faktflow-original',
      sameContentExceptHeader: false,
      importGate: faktflowGate(),
      summary: { ...(validCheck().summary as Record<string, unknown>), systemInfo: 'KSeF SaaS v1.0' },
    })],
    ['same-content-other-program', validCheck({ reason: 'same-content-other-program' })],
    ['archive-conflict', validCheck({ reason: 'archive-conflict' })],
  ] as const)('powód %s (środowisko zgodne): nie ma przycisku (panel decyzji albo werdykt deterministyczny)', async (_name, check) => {
    expect(await view({ facts: factsOf(check) })).toBeNull();
  });

  it('inne środowisko sprawdzenia niż KSEF_ENV: env-mismatch, także dla powodów z panelem decyzji i dla powodów pobrania', async () => {
    for (const check of [
      validCheck({ env: 'production' }),
      knownNumberCheck({ env: 'production' }),
      validCheck({ reason: 'download-refused', httpStatus: 403, env: 'production' }),
      validCheck({ reason: 'same-content-other-program', env: 'production' }),
    ]) {
      const v = await view({ facts: factsOf(check) });
      expect(v, JSON.stringify(check.reason)).toMatchObject({ kind: 'recheck', reason: 'env-mismatch', refusal: null });
      // Wskazówka o InvoiceRead dotyczy wyłącznie świeżego 403 w TYM środowisku.
      expect(v!.grantInvoiceRead).toBe(false);
    }
  });

  it('to samo środowisko: brak env-mismatch (powód no-own-file zostaje przy panelu decyzji)', async () => {
    expect(await view({ facts: factsOf(validCheck({ env: 'test' })), environment: 'test' })).toBeNull();
    expect(await view({ facts: factsOf(validCheck({ env: 'production' })), environment: 'production' })).toBeNull();
  });

  it('nieznane środowisko aplikacji: powód pobrania daje odmowę env-unknown z tekstem sprawdzania (z numerem dokumentu), bez zgadywania', async () => {
    const v = await view({ environment: null });
    expect(v).toMatchObject({ kind: 'recheck', refusal: { code: 'env-unknown', message: DUPLICATE_DECISION_TEXTS.RECHECK.ENV_UNKNOWN(DUP_NR) } });
    // Nie zdanie z wysyłki („tej faktury teraz nie wyślemy”): ponowne sprawdzenie niczego nie wysyła i nazywa dokument (D4).
    expect(v!.refusal!.message).not.toBe(KSEF_SEND_MESSAGES.envUnknown);
    expect(v!.refusal!.message).toContain(DUP_NR);
  });

  it('wymaga failed + KSEF_DUPLICATE_RECONCILE, wychodzącej i otwartego wpisu ze znacznikiem oryginału', async () => {
    const check = validCheck({ reason: 'download-pending', httpStatus: 503 });
    expect(await view({ facts: factsOf(check, { invoice: { ksef_status: 'queued' } }) })).toBeNull();
    expect(await view({ facts: factsOf(check, { invoice: { ksef_status: 'sending' } }) })).toBeNull();
    expect(await view({ facts: factsOf(check, { invoice: { ksef_status: 'accepted' } }) })).toBeNull();
    expect(await view({ facts: factsOf(check, { invoice: { last_error_code: 'KSEF_NUMBER_TAKEN' } }) })).toBeNull();
    expect(await view({ facts: factsOf(check, { invoice: { last_error_code: null } }) })).toBeNull();
    expect(await view({ facts: factsOf(check, { invoice: { direction: 'incoming' } }) })).toBeNull();
    // Znacznik zamknięty (`duplicate`) = brak otwartego wpisu: nie ma czego uzgadniać.
    expect(await view({ facts: factsOf(check, { submissions: [{ ...decisionFacts({ check }).submissions[0]!, status: 'duplicate' }] }) })).toBeNull();
    // Brak wpisów w ogóle (440 bez numeru oryginału): bez przycisku, karta nie ma panelu.
    expect(await view({ facts: factsOf(check, { submissions: [] }) })).toBeNull();
    // Brak faktury w firmie.
    expect(await view({ facts: { ...factsOf(check), invoice: null } as unknown as RecheckInput["facts"] })).toBeNull();
  });

  it('znacznik w kształcie, którego nie rozumiemy (v ≠ 1): bez przycisku', async () => {
    expect(await view({ facts: factsOf({ v: 2, reason: 'download-pending' }) })).toBeNull();
  });

  it('dokument specjalny: tak samo jak „Tylko uzgodnij” (kopia danych i rodzaj niewstrzymany), inaczej odmowa z tekstem', async () => {
    const check = validCheck({ reason: 'download-pending', httpStatus: 503 });
    const ok = await view({ facts: factsOf(check, { invoice: { invoice_kind: 'advance' } }) });
    expect(ok).toMatchObject({ reason: 'download-pending', refusal: null });
    const noData = await view({ sendFacts: { ...STORED, sendData: 'missing' } });
    expect(noData?.refusal?.code).toBe('cannot-reconcile');
    expect(noData?.refusal?.message).toContain(DUP_NR);
    const held = await view({ sendFacts: { ...STORED, kindHeld: true } });
    expect(held?.refusal?.code).toBe('cannot-reconcile');
  });
});

describe('PR D: teksty RECHECK dla klienta (lista prawnika, D4)', () => {
  const NR = 'FV/77/10/2026';
  const T = DUPLICATE_DECISION_TEXTS.RECHECK as unknown as Record<string, string | ((...args: unknown[]) => string)>;

  it('ENV_UNKNOWN(nr): nazywa dokument, mówi o sprawdzaniu (nie o wysyłce), zawiera adres pomocy i „Nie wystawiaj go ponownie”', () => {
    const make = T.ENV_UNKNOWN;
    expect(typeof make).toBe('function');
    const text = (make as (nr: string) => string)(NR);
    expect(text).toContain(NR);
    expect(text).toContain('środowiska KSeF');
    expect(text).toContain(SUPPORT_EMAIL);
    expect(text).toContain('Nie wystawiaj go ponownie.');
    expect(text).not.toMatch(/wyślemy|wysyłk|wysłać/i);
    expect(text).not.toBe(KSEF_SEND_MESSAGES.envUnknown);
  });

  it('żaden tekst RECHECK nie ma długiego myślnika (nowe teksty bez dekoracji)', () => {
    for (const [key, value] of Object.entries(T)) {
      const text = typeof value === 'function' ? value(NR, 'x', 'y') : value;
      expect(text, key).not.toContain('—');
    }
  });

  it('każda odmowa z numerem w treści (funkcja z numerem dokumentu) nazywa dokument', () => {
    for (const key of ['IN_FLIGHT', 'COOLDOWN', 'QUEUED', 'NOT_AVAILABLE', 'CANNOT', 'PAUSED', 'PAUSE_UNKNOWN', 'NO_CERTIFICATE', 'REFUSED', 'ENV_UNKNOWN']) {
      const fn = T[key];
      expect(typeof fn, key).toBe('function');
      expect((fn as (...args: unknown[]) => string)(NR, 5, 'powód'), key).toContain(NR);
    }
  });
});

describe('PR D: kto (D1)', () => {
  it('członek (nie właściciel/administrator) widzi dane tylko do odczytu i prośbę o właściciela', async () => {
    const v = await view({ canManage: false });
    expect(v).toMatchObject({ kind: 'recheck', reason: 'download-pending', originalKsefNumber: DUP_K });
    expect(v!.refusal?.code).toBe('role');
    expect(v!.refusal?.message).toContain('Poproś właściciela lub administratora firmy');
    expect(v!.refusal?.message).toContain('Nie wystawiaj tej faktury ponownie');
  });

  it('rola ma pierwszeństwo przed cooldownem i środowiskiem', async () => {
    const v = await view({ canManage: false, environment: null, lastRecheckAt: new Date(NOW.getTime() - 60_000).toISOString() });
    expect(v!.refusal?.code).toBe('role');
  });
});

describe('PR D: cooldown 10 minut (D3)', () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

  it('9:59 po poprzednim sprawdzeniu: odmowa, jedna minuta do końca, zdanie z numerem dokumentu', async () => {
    const v = await view({ lastRecheckAt: ago(9 * 60_000 + 59_000) });
    expect(v!.refusal?.code).toBe('cooldown');
    expect(v!.refusal?.message).toBe(DUPLICATE_DECISION_TEXTS.RECHECK.COOLDOWN(DUP_NR, 1));
    expect(v!.refusal?.message).toContain(DUP_NR);
    expect(v!.refusal?.message).toContain('1 min');
  });

  it('10:00 po poprzednim sprawdzeniu: wolno', async () => {
    expect((await view({ lastRecheckAt: ago(10 * 60_000) }))!.refusal).toBeNull();
    expect((await view({ lastRecheckAt: ago(10 * 60_000 + 1) }))!.refusal).toBeNull();
  });

  it('minuty do końca: 5:00 po sprawdzeniu → 5 min; tuż po sprawdzeniu → 10 min', async () => {
    expect((await view({ lastRecheckAt: ago(5 * 60_000) }))!.refusal?.message).toBe(DUPLICATE_DECISION_TEXTS.RECHECK.COOLDOWN(DUP_NR, 5));
    expect((await view({ lastRecheckAt: ago(0) }))!.refusal?.message).toBe(DUPLICATE_DECISION_TEXTS.RECHECK.COOLDOWN(DUP_NR, 10));
  });

  it('widok niesie czas do końca cooldownu w ms (karta odświeża się po nim sama); poza cooldownem null', async () => {
    expect((await view({ lastRecheckAt: ago(9 * 60_000 + 59_000) }))!.cooldownMsLeft).toBe(1_000);
    expect((await view({ lastRecheckAt: ago(5 * 60_000) }))!.cooldownMsLeft).toBe(5 * 60_000);
    expect((await view({ lastRecheckAt: ago(0) }))!.cooldownMsLeft).toBe(10 * 60_000);
    // Data z przyszłości liczy się jak świeże sprawdzenie: pełny cooldown, nie więcej.
    expect((await view({ lastRecheckAt: new Date(NOW.getTime() + 60_000).toISOString() }))!.cooldownMsLeft).toBe(10 * 60_000);
    for (const over of [{ lastRecheckAt: null }, { lastRecheckAt: ago(10 * 60_000) }, { lastRecheckAt: 'nie-data' }]) {
      expect((await view(over))!.cooldownMsLeft).toBeNull();
    }
    // Odmowa roli ma pierwszeństwo przed cooldownem: karta nie odlicza czasu, którego członek i tak nie wykorzysta.
    expect((await view({ canManage: false, lastRecheckAt: ago(60_000) }))!.cooldownMsLeft).toBeNull();
  });

  it('brak albo nieczytelny wpis poprzedniego sprawdzenia: nie blokuje', async () => {
    expect((await view({ lastRecheckAt: null }))!.refusal).toBeNull();
    expect((await view({ lastRecheckAt: 'nie-data' }))!.refusal).toBeNull();
  });

  it('data z przyszłości (zegar): traktowana jak świeże sprawdzenie, nie omija cooldownu', async () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    expect((await view({ lastRecheckAt: future }))!.refusal?.code).toBe('cooldown');
  });
});

describe('PR D: wskazówka o uprawnieniu InvoiceRead (D6) tylko przy 403', () => {
  it('download-refused 403: grantInvoiceRead', async () => {
    const v = await view({ facts: factsOf(validCheck({ reason: 'download-refused', httpStatus: 403 })) });
    expect(v!.grantInvoiceRead).toBe(true);
  });

  it.each([
    ['download-refused inny kod', validCheck({ reason: 'download-refused', httpStatus: 400 })],
    ['download-pending', validCheck({ reason: 'download-pending', httpStatus: 503 })],
    ['storage-pending', validCheck({ reason: 'storage-pending' })],
    ['archive-pending', validCheck({ reason: 'archive-pending' })],
    ['no-check', null],
  ] as const)('%s: bez wskazówki', async (_name, check) => {
    const v = await view({ facts: factsOf(check) });
    expect(v!.grantInvoiceRead).toBe(false);
  });
});

describe('PR D: dzień nadania numeru (D6)', () => {
  it('z `acquiredAt` w czasie Europe/Warsaw, a bez niego z numeru KSeF', async () => {
    const withDate = await view({
      facts: factsOf(validCheck({ reason: 'download-pending', httpStatus: 503, acquiredAt: '2026-09-30T22:30:00.000Z' })),
    });
    expect(withDate!.assignedDay).toBe('2026-10-01');
    const fromNumber = await view({ facts: factsOf(validCheck({ reason: 'download-pending', httpStatus: 503, acquiredAt: null })) });
    expect(fromNumber!.assignedDay).toBe('2026-10-01'); // DUP_K = 1234567890-20261001-…
    const noCheck = await view({ facts: factsOf(null) });
    expect(noCheck!.assignedDay).toBe('2026-10-01');
  });
});

describe('PR D: wspólny rdzeń z „Tylko uzgodnij” operatora (D2)', () => {
  const cases: Array<{
    name: string;
    input: { direction: string | null; status: string | null; environmentKnown: boolean; facts: Pick<KsefResendFacts, 'sendData' | 'kindHeld'>; openSent: boolean };
    expected: Blocker;
  }> = [
    { name: 'wszystko w porządku', input: { direction: 'outgoing', status: 'failed', environmentKnown: true, facts: STORED, openSent: true }, expected: null },
    { name: 'rejected też wolno uzgadniać', input: { direction: 'outgoing', status: 'rejected', environmentKnown: true, facts: STORED, openSent: true }, expected: null },
    { name: 'faktura zakupowa', input: { direction: 'incoming', status: 'failed', environmentKnown: true, facts: STORED, openSent: true }, expected: 'incoming' },
    { name: 'status queued', input: { direction: 'outgoing', status: 'queued', environmentKnown: true, facts: STORED, openSent: true }, expected: 'status' },
    { name: 'środowisko nieznane', input: { direction: 'outgoing', status: 'failed', environmentKnown: false, facts: STORED, openSent: true }, expected: 'env-unknown' },
    { name: 'brak kopii danych', input: { direction: 'outgoing', status: 'failed', environmentKnown: true, facts: { sendData: 'missing', kindHeld: false }, openSent: true }, expected: 'send-data-missing' },
    { name: 'rodzaj wstrzymany', input: { direction: 'outgoing', status: 'failed', environmentKnown: true, facts: { sendData: 'stored', kindHeld: true }, openSent: true }, expected: 'kind-held' },
    { name: 'brak otwartego wpisu', input: { direction: 'outgoing', status: 'failed', environmentKnown: true, facts: STORED, openSent: false }, expected: 'no-open-submission' },
  ];

  it.each(cases)('$name', async ({ input, expected }) => {
    const { reconcileOnlyBlocker } = await policy();
    expect(reconcileOnlyBlocker(input)).toBe(expected);
    // Operator odmawia dokładnie wtedy, gdy rdzeń zgłasza blokadę (jedna definicja, nie dwie).
    const operator = operatorReconcileRefusal({
      direction: input.direction,
      status: input.status,
      invoiceKind: 'regular',
      facts: { ...input.facts, issueDatePassed: false },
      environmentKnown: input.environmentKnown,
      openSent: input.openSent,
    });
    expect(operator === null).toBe(expected === null);
  });
});
