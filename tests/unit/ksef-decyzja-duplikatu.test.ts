import { describe, expect, it } from 'vitest';

import { formatWarsawDateTime } from '@/lib/format/warsaw-date';
import { KSEF_SEND_MESSAGES } from '@/lib/invoices/ksef-send-policy';
import { DUPLICATE_ORIGINAL_OFFERS, ORIGINAL_IMPORT_SOURCE, originalHasUncorrectableLine } from '@/lib/ksef/duplicate-check';
import {
  DUPLICATE_DECISION_SQL_TEXTS,
  DUPLICATE_DECISION_TEXTS,
  decisionLabel,
  duplicateCheckAllows,
  duplicateDecisionOptions,
  duplicateNoticeVariant,
  duplicateOriginalOffer,
  fillSqlText,
  importedOriginalProvenance,
  originalGateOk,
  originalRecheckNeeded,
  ownHistoryInSubmissions,
  retiredDraftSendRefusal,
  retiredDraftView,
} from '@/lib/ksef/duplicate-decision';
import { SUPPORT_EMAIL } from '@/lib/site';

import {
  decisionFacts,
  DUP_CLIENT_USER_ID,
  DUP_DECIDED_AT,
  DUP_IMPORTED_ID,
  DUP_INVOICE_ID,
  DUP_K,
  DUP_K2,
  DUP_KNOWN_ID,
  DUP_KNOWN_NUMBER,
  DUP_NR,
  DUP_OPERATOR_ID,
  DUP_PROGRAM,
  DUP_RELEASED_AT,
  DUP_SHA,
  DUPLICATE_CHECK_CASES,
  EXPECTED_SQL_TEXTS,
  faktflowCheck,
  faktflowFacts,
  faktflowGate,
  faktflowOfferCases,
  faktflowPreview,
  faktflowRelease,
  faktflowReviewGate,
  fillExpected,
  knownNumberCheck,
  knownNumberFacts,
  numberTakenFaktflowRow,
  numberTakenRow,
  olderSentRow,
  validCheck,
  withoutKey,
  type DuplicateFactsShape,
  type DuplicateFactsSubmission,
} from './helpers/ksef-duplicate-decision-cases';

/**
 * D-A4-1b-3 PR B (plan „zero zgubionych faktur”, decyzje Bartosza 04.10
 * i 07.10.2026): czysta polityka decyzji klienta przy nierozstrzygniętym 440
 * (`lib/ksef/duplicate-decision.ts`) — lustro blokady SQL
 * `ksef_duplicate_decision_blocker` (00148), widok panelu, baner szkicu
 * wycofanego każdego rodzaju (decyzja 9) i teksty z przeglądu prawnika
 * (decyzje A i 8).
 *
 * Do PR B karta faktury pokazuje przy 440 tylko fakty i notatkę
 * (`duplicate-check.ts:165-210`): klient nie ma żadnej drogi wyjścia,
 * a szkic po automatycznym „numer zajęty” nie ma banera ani blokady.
 */

const NOW = new Date('2026-10-07T10:00:00.000Z');

type Options = {
  actor?: 'client' | 'operator';
  canManage?: boolean;
  environment?: 'test' | 'demo' | 'production' | null;
  /** PR C: chwila odczytu (`pastPeriod` liczy okres względem bieżącego miesiąca w Europe/Warsaw). */
  now?: Date;
};

function view(facts: DuplicateFactsShape, over: Options = {}) {
  return duplicateDecisionOptions({
    facts,
    actor: over.actor ?? 'client',
    canManage: over.canManage ?? true,
    environment: over.environment === undefined ? 'test' : over.environment,
    now: over.now ?? NOW,
  });
}

/** Widok do decyzji — zawężony typ (inny rodzaj widoku czerwieni test z treścią widoku). */
function decidableView(facts: DuplicateFactsShape, over: Options = {}) {
  const v = view(facts, over);
  if (v.kind !== 'decidable') throw new Error(`oczekiwano widoku do decyzji, jest ${JSON.stringify(v)}`);
  return v;
}

/** Odmowa klienta (2.11.B „Refusals in the panel”). */
const CLIENT_ROLE = 'Decyzję, czym jest ten dokument, zapisuje właściciel lub administrator firmy — poproś go o to. Nie wystawiaj tej faktury ponownie.';

const clone = <T>(v: T): T => structuredClone(v);

/** Znacznik w faktach z `decisionFacts` (pierwszy wpis). */
const markerOf = (f: DuplicateFactsShape): DuplicateFactsSubmission => f.submissions[0]!;
const checkOf = (f: DuplicateFactsShape): Record<string, unknown> | null =>
  (markerOf(f).original_check as Record<string, unknown> | null) ?? null;

interface Ctx { facts: DuplicateFactsShape; environment: 'test' | 'production' | null; canManage: boolean }

/**
 * Kolejność blokad (2.1.2), potem env-unknown, env i rola (2.2.1). Każda
 * usterka zmienia fakty tak, żeby zadziałała tylko jej blokada; nakładane
 * od końca listy, więc wcześniejsza blokada zawsze wygrywa.
 */
const ORDER: Array<{ code: string; apply: (c: Ctx) => void; message: (nr: string) => string | null | undefined }> = [
  { code: 'not-found', apply: (c) => { c.facts.invoice.direction = 'incoming'; }, message: () => undefined },
  { code: 'not-pending', apply: (c) => { c.facts.invoice.last_error_code = 'RESULT_UNCERTAIN'; }, message: (nr) => fillExpected('not-pending', nr) },
  { code: 'in-ksef', apply: (c) => { c.facts.invoice.ksef_number = DUP_K2; }, message: (nr) => fillExpected('in-ksef', nr) },
  { code: 'kind', apply: (c) => { c.facts.invoice.invoice_kind = 'advance'; }, message: (nr) => fillExpected('kind', nr) },
  { code: 'billing', apply: (c) => { c.facts.invoice.stripe_invoice_id = 'in_test_1'; }, message: (nr) => fillExpected('billing', nr) },
  { code: 'offline', apply: (c) => { c.facts.invoice.offline_idempotency_key = 'offline-1'; }, message: (nr) => fillExpected('offline', nr) },
  { code: 'no-marker', apply: (c) => { markerOf(c.facts).original_ksef_number = null; }, message: (nr) => fillExpected('no-marker', nr) },
  {
    code: 'conflicting-originals',
    apply: (c) => { c.facts.submissions.push(olderSentRow({ id: 'sub-0-inny-oryginal', status: 'duplicate', original_ksef_number: DUP_K2 })); },
    message: (nr) => fillExpected('conflicting-originals', nr),
  },
  { code: 'no-check', apply: (c) => { markerOf(c.facts).original_check = null; }, message: (nr) => fillExpected('no-check', nr) },
  {
    code: 'reason',
    apply: (c) => { const ch = checkOf(c.facts); if (ch) ch.reason = 'faktflow-original'; },
    // `reason` zostawia notatkę PR A (2.2.1).
    message: () => null,
  },
  {
    code: 'known-stale',
    apply: (c) => {
      const ch = checkOf(c.facts);
      if (ch) Object.assign(ch, { reason: 'known-number', knownInvoice: { id: DUP_KNOWN_ID, internalNumber: DUP_KNOWN_NUMBER } });
      c.facts.knownInvoice = { id: DUP_KNOWN_ID, internalNumber: DUP_KNOWN_NUMBER, holdsOriginal: false };
    },
    message: (nr) => fillExpected('known-stale', DUP_K, nr),
  },
  {
    code: 'own-history',
    // Sesja oryginału w historii tej faktury — sprawdzane na wpisach, nie z JSON.
    apply: (c) => { c.facts.submissions.push(olderSentRow({ id: 'sub-0-sesja-oryginalu', status: 'abandoned', session_reference_number: 'SES-ORIG-1' })); },
    message: (nr) => fillExpected('own-history', DUP_K, nr),
  },
  { code: 'payments', apply: (c) => { c.facts.invoice.paid_amount = 100; }, message: (nr) => fillExpected('payments', nr) },
  { code: 'env-unknown', apply: (c) => { c.environment = null; }, message: () => KSEF_SEND_MESSAGES.envUnknown },
  {
    code: 'env',
    apply: (c) => { const ch = checkOf(c.facts); if (ch) ch.env = 'production'; },
    message: (nr) => fillExpected('ENV', DUP_K, 'produkcyjne', 'testowe', nr),
  },
  { code: 'role', apply: (c) => { c.canManage = false; }, message: () => CLIENT_ROLE },
];

/** Fakty z usterkami od `from` do końca listy. */
function withFaults(from: number, base: DuplicateFactsShape = decisionFacts()): Ctx {
  const c: Ctx = { facts: clone(base), environment: 'test', canManage: true };
  for (let i = ORDER.length - 1; i >= from; i -= 1) ORDER[i]!.apply(c);
  return c;
}

describe('U1a: kolejność odmów — blokada SQL (2.1.2), potem środowisko i rola', () => {
  it('klient: każda blokada wygrywa ze wszystkimi późniejszymi, z tekstem 2.11.A dla numeru dokumentu', () => {
    for (let i = 0; i < ORDER.length; i += 1) {
      const { code, message } = ORDER[i]!;
      const c = withFaults(i);
      const v = view(c.facts, { canManage: c.canManage, environment: c.environment });
      expect(v, code).toMatchObject({ kind: 'refused', refusal: code });
      const expected = message(DUP_NR);
      if (expected !== undefined) expect((v as { message: string | null }).message, code).toBe(expected);
    }
    expect(view(decisionFacts()).kind).toBe('decidable');
  });

  it('operator: ta sama kolejność bez roli — członek firmy widzi prawdziwą blokadę, operator roli nie potrzebuje', () => {
    for (let i = 0; i < ORDER.length - 1; i += 1) {
      const c = withFaults(i);
      const v = view(c.facts, { actor: 'operator', canManage: c.canManage, environment: c.environment });
      expect(v, ORDER[i]!.code).toMatchObject({ kind: 'refused', refusal: ORDER[i]!.code });
    }
    const roleOnly = withFaults(ORDER.length - 1);
    expect(view(roleOnly.facts, { actor: 'operator', canManage: false }).kind).toBe('decidable');
  });

  it('in-ksef także z wpisu: próba accepted albo wpis z numerem KSeF w odpowiedzi', () => {
    const accepted = decisionFacts({ extra: [olderSentRow({ id: 'sub-0-przyjeta', status: 'accepted' })] });
    expect(view(accepted)).toMatchObject({ refusal: 'in-ksef', message: fillExpected('in-ksef', DUP_NR) });
    const answered = decisionFacts({ extra: [olderSentRow({ id: 'sub-0-odpowiedz', status: 'duplicate', response_ksef_number: DUP_K2 })] });
    expect(view(answered)).toMatchObject({ refusal: 'in-ksef' });
  });

  it('not-pending: stan inny niż failed (queued, szkic bez decyzji) albo kod inny niż KSEF_DUPLICATE_RECONCILE', () => {
    expect(view(decisionFacts({ invoice: { ksef_status: 'queued' } }))).toMatchObject({ refusal: 'not-pending' });
    expect(view(decisionFacts({ invoice: { ksef_status: 'rejected' } }))).toMatchObject({ refusal: 'not-pending' });
    expect(view(decisionFacts({ invoice: { last_error_code: 'KSEF_NUMBER_TAKEN' } }))).toMatchObject({ refusal: 'not-pending' });
    const automaticDraft = decisionFacts({
      invoice: { ksef_status: 'draft', last_error_code: null },
      submissions: [numberTakenRow('automatic')],
    });
    expect(view(automaticDraft)).toMatchObject({ kind: 'refused', refusal: 'not-pending' });
  });

  it('znacznik = najnowszy wpis intent/sent z numerem oryginału; wpis duplicate nie jest znacznikiem', () => {
    const newerWithoutCheck = decisionFacts({
      submissions: [
        markerRow2('sub-1-starszy-znacznik', validCheck(), '2026-09-30T10:00:00.000Z'),
        markerRow2('sub-2-nowszy-znacznik', null, '2026-10-01T10:00:00.000Z'),
      ],
    });
    expect(view(newerWithoutCheck)).toMatchObject({ refusal: 'no-check' });
    const newerWithCheck = decisionFacts({
      submissions: [
        markerRow2('sub-1-starszy-znacznik', null, '2026-09-30T10:00:00.000Z'),
        markerRow2('sub-2-nowszy-znacznik', validCheck(), '2026-10-01T10:00:00.000Z'),
      ],
    });
    expect(view(newerWithCheck).kind).toBe('decidable');
    const onlyDuplicate = decisionFacts({ marker: { status: 'duplicate' } });
    expect(view(onlyDuplicate)).toMatchObject({ refusal: 'no-marker' });
  });

  it('conflicting-originals: wpis w dowolnym stanie z innym numerem oryginału; own-history także po pliku (skrót bez względu na wielkość liter)', () => {
    const abandoned = decisionFacts({ extra: [olderSentRow({ id: 'sub-0-porzucona', status: 'abandoned', original_ksef_number: DUP_K2 })] });
    expect(view(abandoned)).toMatchObject({ refusal: 'conflicting-originals' });
    const sameOriginal = decisionFacts({ extra: [olderSentRow({ id: 'sub-0-ten-sam', status: 'duplicate', original_ksef_number: DUP_K })] });
    expect(view(sameOriginal).kind).toBe('decidable');
    const ownFile = decisionFacts({ extra: [olderSentRow({ id: 'sub-0-nasz-plik', status: 'abandoned', request_payload_hash: DUP_SHA.toUpperCase() })] });
    expect(view(ownFile)).toMatchObject({ refusal: 'own-history', message: fillExpected('own-history', DUP_K, DUP_NR) });
  });

  it('teksty: numer „(bez numeru)” jak v_num w SQL; etykiety środowisk ENV', () => {
    expect(view(decisionFacts({ invoice: { internal_number: null, paid_amount: 50 } })))
      .toMatchObject({ refusal: 'payments', message: fillExpected('payments', '(bez numeru)') });
    expect(view(decisionFacts({ check: validCheck({ env: 'demo' }) })))
      .toMatchObject({ refusal: 'env', message: fillExpected('ENV', DUP_K, 'demo', 'testowe', DUP_NR) });
    expect(view(decisionFacts({ check: validCheck({ env: 'test' }) }), { environment: 'production' }))
      .toMatchObject({ refusal: 'env', message: fillExpected('ENV', DUP_K, 'testowe', 'produkcyjne', DUP_NR) });
    expect(view(decisionFacts({ check: validCheck({ env: 'gdzie-indziej' }) })))
      .toMatchObject({ refusal: 'env', message: fillExpected('ENV', DUP_K, 'nieznane', 'testowe', DUP_NR) });
  });

  it('szkic z decyzją: widok `decided` (ponowienie po zgubionej odpowiedzi), nie odmowa', () => {
    const decided = decisionFacts({
      invoice: { ksef_status: 'draft', last_error_code: null },
      submissions: [numberTakenRow('decided', { choice: 'same_sale', via: 'operator' }), numberTakenRow('unmarked', { completedAt: DUP_DECIDED_AT })],
    });
    expect(view(decided)).toEqual({ kind: 'decided', choice: 'same_sale', via: 'operator', at: DUP_DECIDED_AT, originalKsefNumber: DUP_K });
  });
});

/** Otwarty wpis `sent` z numerem oryginału (do testów wyboru znacznika). */
function markerRow2(id: string, check: unknown, attemptedAt: string): DuplicateFactsSubmission {
  return olderSentRow({
    id,
    original_ksef_number: DUP_K,
    original_session_reference_number: 'SES-ORIG-1',
    original_check: check,
    attempted_at: attemptedAt,
    session_reference_number: `SES-${id}`,
  });
}

describe('U1b (C2): known-stale tylko przy powodzie known-number', () => {
  it('no-own-file: bez knownInvoice i z nieaktualnym knownInvoice — nadal do decyzji', () => {
    expect(view(decisionFacts()).kind).toBe('decidable');
    const staleKnown = decisionFacts({
      check: validCheck({ knownInvoice: { id: DUP_KNOWN_ID, internalNumber: DUP_KNOWN_NUMBER } }),
      knownInvoice: { id: DUP_KNOWN_ID, internalNumber: DUP_KNOWN_NUMBER, holdsOriginal: false },
    });
    expect(view(staleKnown).kind).toBe('decidable');
  });

  it('known-number: Y nie ma już K, nie jest przyjęta (holdsOriginal false) albo jej nie ma — known-stale; Y z K — do decyzji', () => {
    expect(view(knownNumberFacts(false))).toMatchObject({ kind: 'refused', refusal: 'known-stale', message: fillExpected('known-stale', DUP_K, DUP_NR) });
    const missingY = decisionFacts({ check: knownNumberCheck(), knownInvoice: null });
    expect(view(missingY)).toMatchObject({ kind: 'refused', refusal: 'known-stale' });
    expect(view(knownNumberFacts(true)).kind).toBe('decidable');
  });
});

describe('U1c: widok do decyzji, tabela porównania i „Rozumiem skutki” (decyzje 7 i 12)', () => {
  const sameOf = (v: { comparison: Array<{ label: string; same: boolean | null }> }) =>
    Object.fromEntries(v.comparison.map((r) => [r.label, r.same]));

  it('no-own-file: numer, K, skrót, powód, program; tabela sześciu wierszy bez liczby pozycji', () => {
    const v = decidableView(decisionFacts({
      check: validCheck({ summary: { ...(validCheck().summary as object), number: ` ${DUP_NR} `, buyerNip: '1234567890' } }),
      invoice: { buyer_nip: 'PL 123-456-78-90' },
    }));
    expect(v).toMatchObject({
      kind: 'decidable', reason: 'no-own-file', invoiceNumber: DUP_NR, originalKsefNumber: DUP_K, originalSha256: DUP_SHA,
      sameContent: null, program: DUP_PROGRAM, knownInvoice: null, heldCorrections: false,
    });
    expect(v.comparison.map((r: { label: string }) => r.label))
      .toEqual(['Numer faktury', 'Data wystawienia', 'Nabywca', 'NIP nabywcy', 'Kwota brutto', 'Program']);
    // Numer po przycięciu spacji, NIP po samych cyfrach, kwota w tej samej walucie; program bez porównania.
    expect(sameOf(v)).toEqual({
      'Numer faktury': true, 'Data wystawienia': true, Nabywca: true, 'NIP nabywcy': true, 'Kwota brutto': true, Program: null,
    });
    expect(v.markedDifference).toBe(false);
  });

  // Zmiana świadoma (przegląd PR B, ustalenie #2): kwota w innej ZNANEJ walucie
  // to „różni się” (same false) — wcześniej wiersz był bez porównania (null),
  // a pole „Rozumiem skutki” mówiło o różnicach, których tabela nie zaznaczała.
  it('różnice: data, nabywca, NIP i kwota; kwota w innej znanej walucie — „różni się” (same false); waluta nieznana — bez porównania (same null)', () => {
    const differs = decidableView(decisionFacts({
      check: validCheck({ summary: { ...(validCheck().summary as object), issueDate: '2026-09-30', buyerName: 'Inny Nabywca', buyerNip: '9876543210', gross: '999.99' } }),
    }));
    expect(sameOf(differs)).toMatchObject({ 'Data wystawienia': false, Nabywca: false, 'NIP nabywcy': false, 'Kwota brutto': false });
    expect(differs.markedDifference).toBe(true);
    const eur = decidableView(decisionFacts({ check: validCheck({ summary: { ...(validCheck().summary as object), currency: 'EUR' } }) }));
    expect(sameOf(eur)['Kwota brutto']).toBe(false);
    const noCurrency = decidableView(decisionFacts({ check: validCheck({ summary: { ...(validCheck().summary as object), currency: null } }) }));
    expect(sameOf(noCurrency)['Kwota brutto']).toBeNull();
    expect(noCurrency.markedDifference).toBe(false);
    const oursNoCurrency = decidableView(decisionFacts({ invoice: { currency: null } }));
    expect(sameOf(oursNoCurrency)['Kwota brutto']).toBeNull();
    // Inna znana waluta, ale kwota nieznana — nadal bez porównania.
    const eurNoGross = decidableView(decisionFacts({ check: validCheck({ summary: { ...(validCheck().summary as object), currency: 'EUR', gross: null } }) }));
    expect(sameOf(eurNoGross)['Kwota brutto']).toBeNull();
    expect(eurNoGross.markedDifference).toBe(false);
  });

  it('#2 B2C (nabywca bez NIP, BrakID): NIP nieznany po obu stronach, reszta zgodna — „ta sama sprzedaż” wymaga potwierdzenia, ale tabela nie zaznacza różnic (markedDifference false)', () => {
    const v = decidableView(decisionFacts({
      check: validCheck({ summary: { ...(validCheck().summary as object), buyerNip: null } }),
      invoice: { buyer_nip: null },
    }));
    expect(sameOf(v)).toEqual({
      'Numer faktury': true, 'Data wystawienia': true, Nabywca: true, 'NIP nabywcy': null, 'Kwota brutto': true, Program: null,
    });
    expect(v.needsConfirmation).toEqual({ same_sale: true, other_sale: true });
    expect(v.markedDifference).toBe(false);
  });

  it('#2 ta sama wartość w EUR (KSeF) i w PLN (ten dokument): wiersz kwoty „różni się”, markedDifference true; tarcie bez zmian', () => {
    const v = decidableView(decisionFacts({ check: validCheck({ summary: { ...(validCheck().summary as object), currency: 'EUR' } }) }));
    const gross = v.comparison.find((r) => r.label === 'Kwota brutto');
    expect(gross).toEqual({ label: 'Kwota brutto', ksef: '1230.00 EUR', ours: '1230.00 PLN', same: false });
    expect(v.markedDifference).toBe(true);
    expect(v.needsConfirmation).toEqual({ same_sale: true, other_sale: true });
  });

  it.each([
    ['ten sam NIP i kwota', {}, {}, { same_sale: false, other_sale: true }],
    ['inny NIP', { buyerNip: '9876543210' }, {}, { same_sale: true, other_sale: false }],
    ['inna kwota w tej samej walucie', { gross: '999.99' }, {}, { same_sale: true, other_sale: true }],
    ['ta sama wartość w innej walucie', { currency: 'EUR' }, {}, { same_sale: true, other_sale: true }],
    ['waluta oryginału nieznana', { currency: null }, {}, { same_sale: true, other_sale: true }],
    ['kwota oryginału nieznana', { gross: null }, {}, { same_sale: true, other_sale: true }],
    ['NIP oryginału nieznany', { buyerNip: null }, {}, { same_sale: true, other_sale: true }],
    ['NIP naszego dokumentu nieznany', {}, { buyer_nip: null }, { same_sale: true, other_sale: true }],
    ['kwota naszego dokumentu nieznana', {}, { gross_total: null }, { same_sale: true, other_sale: true }],
  ] as const)('„Rozumiem skutki”: %s', (_name, summary, invoice, expected) => {
    const v = decidableView(decisionFacts({
      check: validCheck({ summary: { ...(validCheck().summary as object), ...summary } }),
      invoice: { ...invoice },
    }));
    expect(v.needsConfirmation).toEqual(expected);
  });

  it('known-number: knownInvoice {id, internalNumber}, sameContent z porównania; oryginał z FaktWay nadal do decyzji (decyzja 12)', () => {
    const v = decidableView(knownNumberFacts(true, { check: { sameContentExceptHeader: true } }));
    expect(v).toMatchObject({ kind: 'decidable', reason: 'known-number', sameContent: true });
    expect(v.knownInvoice).toEqual({ id: DUP_KNOWN_ID, internalNumber: DUP_KNOWN_NUMBER });
    const faktflow = view(knownNumberFacts(true, { check: { summary: { ...(validCheck().summary as object), systemInfo: 'KSeF SaaS v1.0' } } }));
    expect(faktflow).toMatchObject({ kind: 'decidable', program: 'FaktWay' });
    const noProgram = view(decisionFacts({ check: validCheck({ summary: { ...(validCheck().summary as object), systemInfo: null } }) }));
    expect(noProgram).toMatchObject({ kind: 'decidable', program: null });
  });

  it('heldCorrections: korekty wstrzymane na produkcyjnym KSeF (isCorrectionHeldForEnv)', () => {
    const prod = view(decisionFacts({ check: validCheck({ env: 'production' }) }), { environment: 'production' });
    expect(prod).toMatchObject({ kind: 'decidable', heldCorrections: true });
    expect(decidableView(decisionFacts()).heldCorrections).toBe(false);
  });

  it('ponowne sprawdzenie nieudane (recheck) nie blokuje — dane z udanego są ważne', () => {
    const v = view(decisionFacts({ check: validCheck({ recheck: { reason: 'download-pending', httpStatus: 503, checkedAt: '2026-10-06T10:00:00.000Z' } }) }));
    expect(v.kind).toBe('decidable');
  });
});

describe('U1d: baner szkicu wycofanego — każdy rodzaj (decyzja 9)', () => {
  const data = formatWarsawDateTime(DUP_DECIDED_AT);
  const title = `Dokument wycofany — numer ${DUP_NR} jest zajęty w KSeF`;
  const regularCta = { href: '/invoices/new/regular', label: 'Wystaw nową fakturę' };
  const deleteRefusal = fillExpected('TRIGGER_DELETE', DUP_NR, `faktura ${DUP_K}`);
  const retired = (invoiceKind: string, submissions: DuplicateFactsSubmission[], kindHeld = false) =>
    retiredDraftView({ invoiceNumber: DUP_NR, invoiceKind, submissions, kindHeld });

  it('zwykła, ta sama sprzedaż: bez przycisku, nie do usunięcia, odmowa wysyłki = TRIGGER_SAME', () => {
    expect(retired('regular', [numberTakenRow('decided', { choice: 'same_sale' })])).toEqual({
      title,
      body: `Zapisano ${data}: to ta sama sprzedaż co faktura ${DUP_NR} w KSeF (numer KSeF ${DUP_K}), wystawiona w programie „${DUP_PROGRAM}”. Tam ją rozliczasz i korygujesz; FaktWay nie ujmuje jej w JPK ani w KPiR. Tego dokumentu nie wyślesz do KSeF. Jeśli to jednak inna sprzedaż, wystaw ją jako nową fakturę z nowym numerem.`,
      cta: null,
      knownInvoice: null,
      sendRefusal: fillExpected('TRIGGER_SAME', DUP_NR, DUP_K),
      deletable: false,
      deleteRefusal,
    });
  });

  it('zwykła, ta sama sprzedaż przy known-number: dokument Y i odnośnik do niego; zapis operatora — „zapisała pomoc FaktWay”', () => {
    const v = retired('regular', [numberTakenRow('decided', { choice: 'same_sale', reason: 'known-number', via: 'operator' })]);
    expect(v).toMatchObject({
      body: `Zapisano ${data} (zapisała pomoc FaktWay na Twoją prośbę): to ta sama sprzedaż co faktura ${DUP_NR} w KSeF (numer KSeF ${DUP_K}), którą w FaktWay ma dokument ${DUP_KNOWN_NUMBER}. Tego dokumentu nie wyślesz do KSeF. Jeśli to jednak inna sprzedaż, wystaw ją jako nową fakturę z nowym numerem.`,
      cta: null,
      deletable: false,
    });
    expect(v!.knownInvoice).toEqual({ id: DUP_KNOWN_ID, internalNumber: DUP_KNOWN_NUMBER });
  });

  it('zwykła, inna sprzedaż: jedyny przycisk „Wystaw nową fakturę”, odmowa wysyłki = TRIGGER_OTHER', () => {
    expect(retired('regular', [numberTakenRow('decided', { choice: 'other_sale' })])).toEqual({
      title,
      body: `Zapisano ${data}: to inna sprzedaż niż faktura ${DUP_K} w KSeF. Wystaw ją jako nową fakturę — z nowym numerem i dzisiejszą datą. Tego dokumentu nie wyślesz do KSeF ani nie usuniesz; numer ${DUP_NR} zostaje przy nim, żeby FaktWay nie podpowiedział go ponownie.`,
      cta: regularCta,
      knownInvoice: null,
      sendRefusal: fillExpected('TRIGGER_OTHER', DUP_NR, DUP_K),
      deletable: false,
      deleteRefusal,
    });
  });

  it('zwykła, automatyczny „numer zajęty” (decyzja 3): ten sam baner, przycisk i blokada usunięcia', () => {
    expect(retired('regular', [numberTakenRow('automatic'), numberTakenRow('unmarked', { completedAt: '2026-10-04T09:00:00.000Z' })])).toEqual({
      title,
      body: `KSeF ma już fakturę Twojej firmy o numerze ${DUP_NR} (numer KSeF ${DUP_K}), wystawioną poza FaktWay — tego dokumentu nie wyślesz do KSeF ani nie usuniesz; numer zostaje przy nim, żeby FaktWay nie podpowiedział go ponownie. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie (zmiany: korekta tamtej faktury w programie, w którym ją wystawiono). Jeśli inna — wystaw ją jako nową fakturę z nowym numerem.`,
      cta: regularCta,
      knownInvoice: null,
      sendRefusal: fillExpected('TRIGGER_AUTO', DUP_NR, `fakturę ${DUP_K}`),
      deletable: false,
      deleteRefusal,
    });
  });

  it('zwykła bez K (tylko wpisy bez numeru oryginału): bez „(numer KSeF …)”, „inna faktura Twojej firmy” w odmowach', () => {
    const v = retired('regular', [numberTakenRow('unmarked')]);
    expect(v).toMatchObject({
      body: `KSeF ma już fakturę Twojej firmy o numerze ${DUP_NR}, wystawioną poza FaktWay — tego dokumentu nie wyślesz do KSeF ani nie usuniesz; numer zostaje przy nim, żeby FaktWay nie podpowiedział go ponownie. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie (zmiany: korekta tamtej faktury w programie, w którym ją wystawiono). Jeśli inna — wystaw ją jako nową fakturę z nowym numerem.`,
      sendRefusal: fillExpected('TRIGGER_AUTO', DUP_NR, 'inną fakturę Twojej firmy'),
      deleteRefusal: fillExpected('TRIGGER_DELETE', DUP_NR, 'inna faktura Twojej firmy'),
      deletable: false,
    });
  });

  it('ZAL (automatycznie): nie do usunięcia, przycisk „Wystaw nową fakturę zaliczkową”', () => {
    expect(retired('advance', [numberTakenRow('automatic')])).toEqual({
      title,
      body: `KSeF ma już dokument Twojej firmy o numerze ${DUP_NR} (numer KSeF ${DUP_K}), wystawiony poza FaktWay — tej faktury zaliczkowej nie wyślesz do KSeF ani nie usuniesz; numer zostaje przy niej, żeby FaktWay nie podpowiedział go ponownie. Jeśli to ta sama sprzedaż — nie wystawiaj jej ponownie. Jeśli inna — wystaw nową fakturę zaliczkową z nowym numerem.`,
      cta: { href: '/invoices/new/advance', label: 'Wystaw nową fakturę zaliczkową' },
      knownInvoice: null,
      sendRefusal: fillExpected('TRIGGER_AUTO', DUP_NR, `fakturę ${DUP_K}`),
      deletable: false,
      deleteRefusal,
    });
  });

  it.each([
    ['correction', 'korekty', 'korektę'],
    ['final', 'faktury rozliczeniowej', 'fakturę rozliczeniową'],
  ] as const)('%s (automatycznie): usuwalny szkic — bez przycisku na banerze, „Usuń szkic” w tekście; rodzaj wstrzymany — „po zdjęciu blokady”', (kind, G, A) => {
    const lead = `KSeF ma już dokument Twojej firmy o numerze ${DUP_NR} (numer KSeF ${DUP_K}), wystawiony poza FaktWay — tego szkicu ${G} nie wyślesz do KSeF. Jeśli w KSeF jest ten sam dokument — nie wystawiaj go ponownie. Jeśli inny — `;
    expect(retired(kind, [numberTakenRow('automatic')])).toEqual({
      title,
      body: `${lead}usuń ten szkic („Usuń szkic”) i wystaw ${A} od nowa z nowym numerem.`,
      cta: null,
      knownInvoice: null,
      sendRefusal: fillExpected('TRIGGER_AUTO', DUP_NR, `fakturę ${DUP_K}`),
      deletable: true,
      deleteRefusal: null,
    });
    const held = retired(kind, [numberTakenRow('automatic')], true);
    expect(held!.body).toBe(`${lead}usuń ten szkic („Usuń szkic”), a po zdjęciu blokady wysyłki wystaw ${A} od nowa z nowym numerem.`);
    expect(held!.body).toContain('po zdjęciu blokady');
  });

  it('wpis z decyzją przy korekcie (uszkodzone dane — decyzja jest tylko dla zwykłej): tekst automatyczny korekty', () => {
    const kor = retired('correction', [numberTakenRow('decided', { choice: 'other_sale' })]);
    expect(kor).toMatchObject({ deletable: true, deleteRefusal: null, cta: null, knownInvoice: null });
    expect(kor!.body).toBe(retired('correction', [numberTakenRow('automatic')])!.body);
  });

  it('bez wpisu number_taken — brak banera dla każdego rodzaju', () => {
    const rows = [olderSentRow({ status: 'abandoned' }), olderSentRow({ id: 'sub-x', status: 'duplicate', original_ksef_number: DUP_K })];
    for (const kind of ['regular', 'advance', 'correction', 'final']) {
      expect(retiredDraftView({ invoiceNumber: DUP_NR, invoiceKind: kind, submissions: rows, kindHeld: false }), kind).toBeNull();
      expect(retiredDraftView({ invoiceNumber: DUP_NR, invoiceKind: kind, submissions: [], kindHeld: true }), kind).toBeNull();
    }
  });
});

describe('U1e: retiredDraftSendRefusal — każdy rodzaj, kolejność wpisów jak wyzwalacz (2.1.4 krok 2)', () => {
  it('decyzja przed wpisem automatycznym (nawet późniejszym); wpis z K przed wpisem bez numeru; potem completed_at malejąco', () => {
    expect(retiredDraftSendRefusal(DUP_NR, [
      numberTakenRow('automatic', { id: 'nt-pozniejszy', k: DUP_K2, completedAt: '2026-10-06T10:00:00.000Z' }),
      numberTakenRow('decided', { choice: 'other_sale', k: DUP_K }),
    ])).toBe(fillExpected('TRIGGER_OTHER', DUP_NR, DUP_K));
    expect(retiredDraftSendRefusal(DUP_NR, [
      numberTakenRow('automatic', { completedAt: '2026-10-04T10:00:00.000Z' }),
      numberTakenRow('unmarked', { completedAt: '2026-10-06T10:00:00.000Z' }),
    ])).toBe(fillExpected('TRIGGER_AUTO', DUP_NR, `fakturę ${DUP_K}`));
    expect(retiredDraftSendRefusal(DUP_NR, [
      numberTakenRow('automatic', { id: 'nt-a', k: DUP_K, completedAt: '2026-10-03T10:00:00.000Z' }),
      numberTakenRow('automatic', { id: 'nt-b', k: DUP_K2, completedAt: '2026-10-04T10:00:00.000Z' }),
    ])).toBe(fillExpected('TRIGGER_AUTO', DUP_NR, `fakturę ${DUP_K2}`));
    expect(retiredDraftSendRefusal(DUP_NR, [
      numberTakenRow('automatic', { id: 'nt-bez-daty', k: DUP_K2, completedAt: null }),
      numberTakenRow('automatic', { id: 'nt-z-data', k: DUP_K, completedAt: '2026-10-03T10:00:00.000Z' }),
    ])).toBe(fillExpected('TRIGGER_AUTO', DUP_NR, `fakturę ${DUP_K}`));
  });

  it('ta sama sprzedaż: TRIGGER_SAME; dokument bez numeru — „(bez numeru)” jak v_num', () => {
    expect(retiredDraftSendRefusal(DUP_NR, [numberTakenRow('decided', { choice: 'same_sale' })]))
      .toBe(fillExpected('TRIGGER_SAME', DUP_NR, DUP_K));
    expect(retiredDraftSendRefusal(null, [numberTakenRow('automatic')]))
      .toBe(fillExpected('TRIGGER_AUTO', '(bez numeru)', `fakturę ${DUP_K}`));
  });

  it('korekta też: ta sama odmowa co w banerze; bez wpisu number_taken — null', () => {
    const rows = [numberTakenRow('automatic')];
    const kor = retiredDraftView({ invoiceNumber: DUP_NR, invoiceKind: 'correction', submissions: rows, kindHeld: true });
    expect(kor!.sendRefusal).toBe(retiredDraftSendRefusal(DUP_NR, rows));
    expect(retiredDraftSendRefusal(DUP_NR, rows)).toBe(fillExpected('TRIGGER_AUTO', DUP_NR, `fakturę ${DUP_K}`));
    expect(retiredDraftSendRefusal(DUP_NR, [olderSentRow({ status: 'abandoned' })])).toBeNull();
  });
});

/** Wszystkie napisy z obiektu tekstów; funkcje wołane z argumentami-znacznikami. */
function collectTexts(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 5) return out;
  if (typeof value === 'string') {
    out.push(value);
  } else if (typeof value === 'function') {
    const fn = value as (...args: unknown[]) => unknown;
    const args = Array.from({ length: Math.max(fn.length, 1) }, (_, i) => `{a${i}}`);
    try {
      collectTexts(fn(...args), out, depth + 1);
    } catch {
      // Funkcja z innym kształtem argumentów — jej teksty sprawdzają widoki niżej.
    }
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectTexts(v, out, depth + 1);
  }
  return out;
}

/** Teksty, które widzi klient: obiekt tekstów, wzorce SQL, odmowy panelu, banery i odmowy szkicu wycofanego. */
function clientTexts(): string[] {
  const out = collectTexts(DUPLICATE_DECISION_TEXTS);
  out.push(...Object.values(DUPLICATE_DECISION_SQL_TEXTS as Record<string, { template: string }>).map((t) => t.template));
  for (let i = 0; i < ORDER.length; i += 1) {
    const c = withFaults(i);
    const v = view(c.facts, { canManage: c.canManage, environment: c.environment }) as { message?: string | null };
    if (v.message) out.push(v.message);
  }
  for (const kind of ['regular', 'advance', 'correction', 'final']) {
    for (const rows of [
      [numberTakenRow('decided', { choice: 'same_sale' })],
      [numberTakenRow('decided', { choice: 'same_sale', reason: 'known-number', via: 'operator' })],
      [numberTakenRow('decided', { choice: 'other_sale' })],
      [numberTakenRow('automatic')],
      [numberTakenRow('unmarked')],
    ]) {
      for (const kindHeld of [false, true]) {
        const v = retiredDraftView({ invoiceNumber: DUP_NR, invoiceKind: kind, submissions: rows, kindHeld });
        if (!v) continue;
        out.push(v.title, v.body, v.sendRefusal ?? '', v.deleteRefusal ?? '', v.cta?.label ?? '');
      }
    }
  }
  return out.filter(Boolean);
}

describe('U1f: teksty klienta (przegląd prawnika, decyzje A i 8)', () => {
  it('żaden tekst klienta nie odsyła do operatora (reguła 07.10)', () => {
    const withOperator = clientTexts().filter((t) => /operator/i.test(t));
    expect(withOperator).toEqual([]);
  });

  it('żaden tekst zwykłej faktury i zaliczki (nieusuwalnych) nie każe ich usuwać', () => {
    const nonDeletable: string[] = [];
    for (const kind of ['regular', 'advance']) {
      for (const rows of [[numberTakenRow('decided', { choice: 'same_sale' })], [numberTakenRow('decided', { choice: 'other_sale' })], [numberTakenRow('automatic')], [numberTakenRow('unmarked')]]) {
        const v = retiredDraftView({ invoiceNumber: DUP_NR, invoiceKind: kind, submissions: rows, kindHeld: false })!;
        nonDeletable.push(v.title, v.body, v.sendRefusal ?? '', v.deleteRefusal ?? '');
      }
    }
    nonDeletable.push(...Object.values(DUPLICATE_DECISION_SQL_TEXTS as Record<string, { template: string }>).map((t) => t.template));
    expect(nonDeletable.filter((t) => /usuń (go|je|wpłaty)/i.test(t))).toEqual([]);
    expect(clientTexts().filter((t) => /usuń (go|je|wpłaty)/i.test(t))).toEqual([]);
  });

  it('C5: oba pola „Rozumiem skutki: …” i CONFIRM słowo w słowo', () => {
    const texts = collectTexts(DUPLICATE_DECISION_TEXTS);
    expect(texts).toContain('Zaznacz „Rozumiem skutki” i zapisz decyzję jeszcze raz.');
    const labels = texts.filter((t) => t.startsWith('Rozumiem skutki: '));
    expect(labels.some((t) => /^Rozumiem skutki: faktura .+ w KSeF dokumentuje tę samą sprzedaż co dokument .+, mimo różnic zaznaczonych w tabeli\.$/.test(t)))
      .toBe(true);
    // #2: wariant bez różnic zaznaczonych w tabeli (NIP nieznany, B2C, waluta nieznana).
    expect(labels.some((t) => /^Rozumiem skutki: faktura .+ w KSeF dokumentuje tę samą sprzedaż co dokument .+, choć części danych w tabeli nie da się porównać\.$/.test(t)))
      .toBe(true);
    expect(labels.some((t) => /^Rozumiem skutki: faktura .+ w KSeF dokumentuje inną sprzedaż niż dokument .+\.$/.test(t))).toBe(true);
    // „Rozumiem skutki” poza etykietą pola tylko w cudzysłowie (CONFIRM).
    expect(texts.filter((t) => t.includes('Rozumiem skutki') && !t.startsWith('Rozumiem skutki: ') && !t.includes('„Rozumiem skutki”')))
      .toEqual([]);
  });

  it('zdanie o wstrzymanych korektach tylko przy heldCorrections (KSeF produkcyjny)', () => {
    expect(collectTexts(DUPLICATE_DECISION_TEXTS).some((t) => t.includes('Korekty do produkcyjnego KSeF są teraz wstrzymane przez FaktWay.'))).toBe(true);
    expect(decidableView(decisionFacts()).heldCorrections).toBe(false);
    expect(decidableView(decisionFacts({ check: validCheck({ env: 'production' }) }), { environment: 'production' }).heldCorrections).toBe(true);
  });
});

describe('U1g (C1): teksty SQL 00148 — wzorce RAISE z % i fillSqlText', () => {
  it('lustro ma klucz dla każdego wiersza 2.11.A (z TRIGGER_RENUMBER), wzorce słowo w słowo i ich liczbę argumentów', () => {
    expect(DUPLICATE_DECISION_SQL_TEXTS).toEqual(EXPECTED_SQL_TEXTS);
    expect(Object.keys(DUPLICATE_DECISION_SQL_TEXTS)).toContain('TRIGGER_RENUMBER');
  });

  it('żaden wzorzec nie ma apostrofu; liczba % = arity (format() z gołym % by padł)', () => {
    for (const [key, { template, arity }] of Object.entries(DUPLICATE_DECISION_SQL_TEXTS as Record<string, { template: string; arity: number }>)) {
      expect(template, key).not.toContain("'");
      expect(template.split('%').length - 1, key).toBe(arity);
    }
  });

  it('fillSqlText wypełnia od lewej do prawej, nie podstawia w argumentach i odmawia przy złej liczbie', () => {
    expect(fillSqlText('a % b % c', 'X', 'Y')).toBe('a X b Y c');
    expect(fillSqlText('% i %', '50%', 'x')).toBe('50% i x');
    expect(fillSqlText('bez znaczników')).toBe('bez znaczników');
    expect(() => fillSqlText('a % b', 'X', 'Y')).toThrow();
    expect(() => fillSqlText('a % b %', 'X')).toThrow();
  });

  it('TRIGGER_AUTO bez K: „przez inną fakturę Twojej firmy wystawioną” (poprawka v3)', () => {
    const t = (DUPLICATE_DECISION_SQL_TEXTS as Record<string, { template: string }>).TRIGGER_AUTO!.template;
    expect(fillSqlText(t, DUP_NR, 'inną fakturę Twojej firmy')).toContain('przez inną fakturę Twojej firmy wystawioną');
    expect(fillSqlText(t, DUP_NR, `fakturę ${DUP_K}`)).toContain(`przez fakturę ${DUP_K} wystawioną poza FaktWay`);
  });
});

describe('U1h: zgodność polityki jsonb z SQL — wspólna tabela (R6)', () => {
  it('tabela pokrywa oba powody PR B, każdy wybór i nie ma wiersza v: 1.0 (C14)', () => {
    expect(DUPLICATE_CHECK_CASES.some((c) => c.allows)).toBe(true);
    expect(DUPLICATE_CHECK_CASES.some((c) => !c.allows)).toBe(true);
    expect(new Set(DUPLICATE_CHECK_CASES.map((c) => c.name)).size).toBe(DUPLICATE_CHECK_CASES.length);
    expect(DUPLICATE_CHECK_CASES.filter((c) => JSON.stringify(c.check).includes('"v":1.0'))).toEqual([]);
  });

  it.each(DUPLICATE_CHECK_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(duplicateCheckAllows(c.check, c.choice)).toBe(c.allows);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// D-A4-1b-3 PR C (00149, spec v3 5.5, 6.1–6.4, 7.2): powód `faktflow-original` —
// czerwone testy polityki. Każdy test odtwarza zachowanie na prawdziwej ścieżce
// (`duplicateDecisionOptions`, `retiredDraftView`, ...) z faktów w kształcie
// wierszy ładowarki; oczekiwane teksty z `DUPLICATE_DECISION_TEXTS.FAKTFLOW`
// i `fillExpected` (wzorce SQL spisane ręcznie z 6.3), nigdy kopiowane napisy.
// Do commitu 3 polityka odmawia `faktflow-original` powodem `reason`, a funkcje
// oferty, lustra i proweniencji rzucają „PR C: nie zaimplementowane”.
// ═══════════════════════════════════════════════════════════════════════════════

const FF = DUPLICATE_DECISION_TEXTS.FAKTFLOW;

/** Jak `decidableView`, ale na faktach `faktflow-original`. */
const ffDecidable = (over: Parameters<typeof faktflowFacts>[0] = {}, options: Options = {}) =>
  decidableView(faktflowFacts(over), options);

const rowOf = (v: { comparison: Array<{ label: string }> }, label: string) => v.comparison.find((r) => r.label === label);

const releasedCheck = (): Record<string, unknown> => ({ importGate: faktflowReviewGate(['rates'], { release: faktflowRelease() }) });

describe('U1i (PR C): faktflow-original — oferta pair (dwa przyciski, zapis oryginału)', () => {
  it('klient: widok do decyzji z ofertą pair, trybem import, obu wyborami, programem FaktWay i danymi oryginału z bramy', () => {
    const v = ffDecidable();
    expect(v).toMatchObject({
      kind: 'decidable',
      reason: 'faktflow-original',
      offer: 'pair',
      mode: 'import',
      invoiceNumber: DUP_NR,
      originalKsefNumber: DUP_K,
      originalSha256: DUP_SHA,
      program: 'FaktWay',
      choices: ['same_sale', 'other_sale'],
      sameContent: false,
      knownInvoice: null,
      heldCorrections: false,
      correctionForPerson: false,
    });
    // Podgląd pliku z `importGate.preview` — strona nie czyta archiwum (INV-13); dzień nadania w Europe/Warsaw.
    expect(v.original).toEqual({ preview: faktflowPreview(), assignedDay: '2026-10-01', pastPeriod: false });
  });

  it('tabela: sześć wierszy PR B i wiersz „Data sprzedaży”; program bez porównania', () => {
    const v = ffDecidable();
    expect(v.comparison.map((r) => r.label)).toEqual(expect.arrayContaining([
      'Numer faktury', 'Data wystawienia', 'Nabywca', 'NIP nabywcy', 'Kwota brutto', 'Program', FF.ROW_SALE_DATE,
    ]));
    expect(v.comparison).toHaveLength(7);
    expect(rowOf(v, 'Program')).toMatchObject({ ksef: 'FaktWay', ours: 'FaktWay', same: null });
  });

  it('wiersz „Data sprzedaży”: NULL po obu stronach to „jak data wystawienia”, nie „—” ani brak', () => {
    expect(rowOf(ffDecidable(), FF.ROW_SALE_DATE)).toMatchObject({ ksef: FF.SALE_DATE_AS_ISSUE, ours: FF.SALE_DATE_AS_ISSUE });
    const withDates = ffDecidable({ check: { importGate: faktflowGate({ preview: faktflowPreview({ saleDate: '2026-09-30' }) }) }, invoice: { sale_date: '2026-09-29' } });
    expect(rowOf(withDates, FF.ROW_SALE_DATE)).toMatchObject({ ksef: '2026-09-30', ours: '2026-09-29' });
    const oursNull = ffDecidable({ check: { importGate: faktflowGate({ preview: faktflowPreview({ saleDate: '2026-09-30' }) }) } });
    expect(rowOf(oursNull, FF.ROW_SALE_DATE)).toMatchObject({ ksef: '2026-09-30', ours: FF.SALE_DATE_AS_ISSUE });
    const ksefNull = ffDecidable({ invoice: { sale_date: '2026-09-29' } });
    expect(rowOf(ksefNull, FF.ROW_SALE_DATE)).toMatchObject({ ksef: FF.SALE_DATE_AS_ISSUE, ours: '2026-09-29' });
  });

  it('przyszła postać SystemInfo „FaktFlow 2.0” (D-A4-1b-3-SYS) też daje program FaktWay i ofertę pair', () => {
    const v = ffDecidable({ check: { summary: { ...(validCheck().summary as object), systemInfo: 'FaktFlow 2.0' } } });
    expect(v).toMatchObject({ offer: 'pair', program: 'FaktWay' });
  });

  it.each([
    ['ten sam NIP i kwota', {}, {}, { same_sale: false, other_sale: true }],
    ['inny NIP nabywcy', { buyerNip: '9876543210' }, {}, { same_sale: true, other_sale: false }],
    ['inna kwota w tej samej walucie', { gross: '999.99' }, {}, { same_sale: true, other_sale: true }],
    ['NIP oryginału nieznany', { buyerNip: null }, {}, { same_sale: true, other_sale: true }],
    ['kwota naszego dokumentu nieznana', {}, { gross_total: null }, { same_sale: true, other_sale: true }],
  ] as const)('„Rozumiem skutki” jak w PR B (pair): %s', (_name, summary, invoice, expected) => {
    const v = ffDecidable({
      check: { summary: { ...(validCheck().summary as object), systemInfo: 'KSeF SaaS v1.0', ...summary } },
      invoice: { ...invoice },
    });
    expect(v).toMatchObject({ offer: 'pair', needsConfirmation: expected });
  });

  it('korekty do produkcyjnego KSeF wstrzymane: heldCorrections także przy faktflow-original', () => {
    const v = ffDecidable({ check: { env: 'production' } }, { environment: 'production' });
    expect(v).toMatchObject({ offer: 'pair', heldCorrections: true });
  });

  it('operator też dostaje widok do decyzji (oba wybory) — bez roli', () => {
    const v = ffDecidable({}, { actor: 'operator', canManage: false });
    expect(v).toMatchObject({ offer: 'pair', mode: 'import', choices: ['same_sale', 'other_sale'] });
  });
});

describe('U1j (PR C): faktflow-original — oferta record (jeden przycisk, własna historia albo ta sama treść)', () => {
  it.each([
    ['własna historia w JSON (ownHistory = true)', () => faktflowFacts({ check: { ownHistory: true } })],
    ['własna historia w bazie: sesja oryginału w próbie faktury (T3, JSON ownHistory = false)', () => faktflowFacts({ history: 'session' })],
    ['własna historia w bazie: skrót oryginału w próbie, wielkość liter bez znaczenia (T3)', () => faktflowFacts({ history: 'hash' })],
    ['ta sama treść poza nagłówkiem (C5)', () => faktflowFacts({ check: { sameContentExceptHeader: true } })],
  ])('%s — oferta record, tryb import, tylko „ta sama sprzedaż”, program FaktWay', (_name, facts) => {
    const v = decidableView(facts());
    expect(v).toMatchObject({
      kind: 'decidable',
      reason: 'faktflow-original',
      offer: 'record',
      mode: 'import',
      program: 'FaktWay',
      choices: ['same_sale'],
      needsConfirmation: expect.objectContaining({ other_sale: false }),
    });
  });

  it('własna historia w bazie nie daje odmowy own-history (PR B odmawiał nią każdy powód) — faktura czeka na zapis oryginału', () => {
    for (const history of ['session', 'hash'] as const) {
      expect(view(faktflowFacts({ history })), history).toMatchObject({ kind: 'decidable', offer: 'record' });
    }
  });

  it.each([
    ['własna historia i treść różna', { ownHistory: true, sameContentExceptHeader: false }, true, false],
    ['własna historia i treść nieznana (null)', { ownHistory: true, sameContentExceptHeader: null }, true, null],
    ['ta sama treść', { sameContentExceptHeader: true }, false, true],
    ['własna historia i ta sama treść', { ownHistory: true, sameContentExceptHeader: true }, false, true],
  ] as const)('„Rozumiem skutki” (record): %s — same_sale wymaga pola tylko, gdy treść nie jest ta sama; other_sale nigdy', (_name, check, sameSale, sameContent) => {
    const v = ffDecidable({ check });
    expect(v).toMatchObject({ offer: 'record', sameContent, needsConfirmation: { same_sale: sameSale, other_sale: false } });
  });

  it('„Rozumiem skutki” (record) nie zależy od NIP nabywcy ani kwoty — reguła `sameContent !== true`, nie reguły PR B', () => {
    const differs = { summary: { ...(validCheck().summary as object), systemInfo: 'KSeF SaaS v1.0', buyerNip: '9876543210', gross: '999.99' } };
    expect(ffDecidable({ check: { ...differs, sameContentExceptHeader: true } }).needsConfirmation).toEqual({ same_sale: false, other_sale: false });
    expect(ffDecidable({ check: { ...differs, ownHistory: true } }).needsConfirmation).toEqual({ same_sale: true, other_sale: false });
  });

  it('record niesie ten sam podgląd pliku, dzień nadania i okres co pair', () => {
    const v = ffDecidable({ check: { ownHistory: true } });
    expect(v.original).toEqual({ preview: faktflowPreview(), assignedDay: '2026-10-01', pastPeriod: false });
  });

  // I1 (weryfikacja commitu 2): wstęp panelu przy record to pole widoku `recordIntro`, bo panel nie widzi
  // `ownHistoryDb`, a `sameContent` samo nie odróżnia „własna historia + ta sama treść” od „sama ta sama treść”.
  // 'own' (własna historia z JSON albo z bazy) ma pierwszeństwo przed 'same' (tylko sameContentExceptHeader).
  it.each([
    ['własna historia w JSON i ta sama treść', () => faktflowFacts({ check: { ownHistory: true, sameContentExceptHeader: true } }), true, 'own'],
    ['własna historia w bazie (sesja) i ta sama treść', () => faktflowFacts({ history: 'session', check: { sameContentExceptHeader: true } }), true, 'own'],
    ['własna historia w bazie (skrót) i ta sama treść', () => faktflowFacts({ history: 'hash', check: { sameContentExceptHeader: true } }), true, 'own'],
    ['własna historia w JSON i treść różna', () => faktflowFacts({ check: { ownHistory: true, sameContentExceptHeader: false } }), false, 'own'],
    ['własna historia w bazie (sesja) i treść różna', () => faktflowFacts({ history: 'session' }), false, 'own'],
    ['własna historia w bazie (skrót) i treść różna', () => faktflowFacts({ history: 'hash' }), false, 'own'],
    ['ta sama treść bez własnej historii', () => faktflowFacts({ check: { sameContentExceptHeader: true } }), true, 'same'],
  ] as const)('recordIntro (record): %s → "%s"', (_name, facts, sameContent, intro) => {
    const v = decidableView(facts());
    expect(v).toMatchObject({ offer: 'record', sameContent, recordIntro: intro });
  });

  it('recordIntro jest tylko przy ofercie record — pair, released i powody PR B go nie mają', () => {
    expect(ffDecidable().recordIntro).toBeUndefined();
    expect(ffDecidable({ check: releasedCheck() }).recordIntro).toBeUndefined();
    expect(decidableView(decisionFacts()).recordIntro).toBeUndefined();
    expect(decidableView(knownNumberFacts(true)).recordIntro).toBeUndefined();
  });
});

describe('U1k (PR C): faktflow-original — oferta released (operator oddał decyzję; semantyka PR B bez zapisu)', () => {
  it('klient: widok do decyzji z ofertą released, trybem no-import, obu wyborami i programem „nieznanym”', () => {
    const v = ffDecidable({ check: releasedCheck() });
    expect(v).toMatchObject({
      kind: 'decidable',
      reason: 'faktflow-original',
      offer: 'released',
      mode: 'no-import',
      program: null,
      choices: ['same_sale', 'other_sale'],
      invoiceNumber: DUP_NR,
      originalKsefNumber: DUP_K,
    });
    expect(rowOf(v, 'Program')).toMatchObject({ ksef: FF.PROGRAM_RELEASED, ours: 'FaktWay' });
  });

  it('„Rozumiem skutki” jak w PR B (NIP, kwota), nie jak record', () => {
    const buyerDiffers = { ...releasedCheck(), summary: { ...(validCheck().summary as object), systemInfo: 'KSeF SaaS v1.0', buyerNip: '9876543210' } };
    expect(ffDecidable({ check: buyerDiffers }).needsConfirmation).toEqual({ same_sale: true, other_sale: false });
    expect(ffDecidable({ check: releasedCheck() }).needsConfirmation).toEqual({ same_sale: false, other_sale: true });
  });

  it('operator: „Zapisz decyzję klienta” także przy oddaniu (widok do decyzji, bez roli)', () => {
    expect(ffDecidable({ check: releasedCheck() }, { actor: 'operator', canManage: false })).toMatchObject({ offer: 'released', mode: 'no-import' });
  });

  it('oddanie nie obowiązuje, gdy plik jest w historii dokumentu albo ma tę samą treść — przegląd record, klient odmowa', () => {
    for (const facts of [
      faktflowFacts({ check: releasedCheck(), history: 'session' }),
      faktflowFacts({ check: { ...releasedCheck(), sameContentExceptHeader: true } }),
      faktflowFacts({ check: { ...releasedCheck(), ownHistory: true } }),
    ]) {
      expect(view(facts)).toMatchObject({ kind: 'refused', refusal: 'provenance-review' });
      expect(view(facts, { actor: 'operator' })).toMatchObject({ kind: 'review', offer: 'review-record', releasable: false });
    }
  });
});

describe('U1l (PR C): powody PR B — pola widoku ustawione zawsze (offer/mode null, oba wybory, original null)', () => {
  it.each([
    ['no-own-file', () => decisionFacts()],
    ['known-number', () => knownNumberFacts(true)],
  ])('%s: offer i mode null, oba wybory, bez danych oryginału', (_name, facts) => {
    expect(decidableView(facts())).toMatchObject({
      offer: null,
      mode: null,
      choices: ['same_sale', 'other_sale'],
      original: null,
    });
  });
});

describe('U1m (PR C): dzień nadania numeru, okres wsteczny i zdanie o korekcie dla nabywcy bez NIP', () => {
  it('assignedDay: data nadania w Europe/Warsaw, bez niej data z numeru KSeF, bez obu null', () => {
    expect(ffDecidable().original?.assignedDay).toBe('2026-10-01');
    expect(ffDecidable({ check: { acquiredAt: '2026-10-01T22:30:00.000Z' } }).original?.assignedDay).toBe('2026-10-02');
    expect(ffDecidable({ check: { acquiredAt: null } }).original?.assignedDay).toBe('2026-10-01');
    expect(ffDecidable({ check: { acquiredAt: 'nie data' } }).original?.assignedDay).toBe('2026-10-01');
    const bezDaty = ffDecidable({ check: { acquiredAt: null }, marker: { original_ksef_number: 'KSEF-BEZ-DATY' } });
    expect(bezDaty.original?.assignedDay).toBeNull();
  });

  it.each([
    ['bieżący miesiąc (10.2026) nie jest wsteczny', '10.2026', NOW, false],
    ['poprzedni miesiąc (09.2026) jest wsteczny', '09.2026', NOW, true],
    ['poprzedni rok (12.2025) jest wsteczny', '12.2025', NOW, true],
    ['przyszły miesiąc nie jest wsteczny', '11.2026', NOW, false],
    ['po północy w Warszawie (30.09 22:30 UTC = 01.10): wrzesień jest już wsteczny', '09.2026', new Date('2026-09-30T22:30:00.000Z'), true],
    ['przed północą w Warszawie (30.09 21:59 UTC = 23:59): wrzesień jeszcze nie jest wsteczny', '09.2026', new Date('2026-09-30T21:59:59.000Z'), false],
    ['sylwester w zimie (31.12 23:30 UTC = 01.01): grudzień jest już wsteczny', '12.2026', new Date('2026-12-31T23:30:00.000Z'), true],
  ])('pastPeriod: %s', (_name, period, now, expected) => {
    const v = ffDecidable({ check: { importGate: faktflowGate({ preview: faktflowPreview({ period }) }) } }, { now });
    expect(v.original?.pastPeriod).toBe(expected);
  });

  it.each([
    ['nip', false],
    ['vat-ue', false],
    ['pesel', true],
    ['nr-inny', true],
    ['brak-id', true],
    ['none', true],
  ] as const)('correctionForPerson: nabywca %s → %s (korekta K istnieje tylko dla NIP i VAT-UE)', (buyerIdKind, expected) => {
    const check = { importGate: faktflowGate({ preview: faktflowPreview({ buyerIdKind }) }) };
    expect(ffDecidable({ check }).correctionForPerson).toBe(expected);
    expect(ffDecidable({ check: { ...check, ownHistory: true } }).correctionForPerson).toBe(expected);
  });
});

/** Kolejność odmów `faktflow-original`: blokada SQL i JSON (4.5), potem środowisko i rola — jak `ORDER` PR B. */
const FF_ORDER: Array<{ code: string; apply: (c: Ctx) => void; message: (nr: string) => string | null }> = [
  { code: 'state-unknown', apply: (c) => { c.facts.sqlBlocker = undefined; }, message: (nr) => FF.READ_FAILED(nr) },
  { code: 'known-now', apply: (c) => { c.facts.sqlBlocker = 'known-now'; }, message: (nr) => fillExpected('known-now', DUP_K, nr) },
  { code: 'cross-tenant', apply: (c) => { c.facts.sqlBlocker = 'cross-tenant'; }, message: (nr) => fillExpected('cross-tenant', nr, nr) },
  {
    code: 'recheck-needed',
    apply: (c) => { delete checkOf(c.facts)!.importGate; },
    message: (nr) => fillExpected('recheck-needed', nr),
  },
  { code: 'payments', apply: (c) => { c.facts.invoice.paid_amount = 100; }, message: (nr) => fillExpected('payments', nr) },
  {
    code: 'provenance-review',
    apply: (c) => { checkOf(c.facts)!.importGate = faktflowReviewGate(['rates']); },
    message: (nr) => fillExpected('provenance-review', nr),
  },
  { code: 'env-unknown', apply: (c) => { c.environment = null; }, message: () => KSEF_SEND_MESSAGES.envUnknown },
  { code: 'env', apply: (c) => { checkOf(c.facts)!.env = 'production'; }, message: (nr) => fillExpected('ENV', DUP_K, 'produkcyjne', 'testowe', nr) },
  { code: 'role', apply: (c) => { c.canManage = false; }, message: () => CLIENT_ROLE },
];

function ffFaults(from: number): Ctx {
  const c: Ctx = { facts: clone(faktflowFacts()), environment: 'test', canManage: true };
  for (let i = FF_ORDER.length - 1; i >= from; i -= 1) FF_ORDER[i]!.apply(c);
  return c;
}

/** Fakty `faktflow-original`, w których znacznik nie ma klucza `importGate` (sprzed 00149 albo stary runner). */
function noGateFacts(over: Parameters<typeof faktflowFacts>[0] = {}): DuplicateFactsShape {
  const facts = faktflowFacts(over);
  delete checkOf(facts)!.importGate;
  return facts;
}

describe('U1n (PR C): faktflow-original — kolejność odmów (blokada SQL i JSON, potem środowisko i rola)', () => {
  it('klient: każda usterka wygrywa ze wszystkimi późniejszymi, z tekstem dla numeru dokumentu', () => {
    for (let i = 0; i < FF_ORDER.length; i += 1) {
      const { code, message } = FF_ORDER[i]!;
      const c = ffFaults(i);
      const v = view(c.facts, { canManage: c.canManage, environment: c.environment });
      expect(v, code).toMatchObject({ kind: 'refused', refusal: code, message: message(DUP_NR) });
      // Klient nie dostaje danych dla operatora.
      expect(v, code).not.toHaveProperty('detail');
    }
    expect(view(faktflowFacts()).kind).toBe('decidable');
  });

  it('operator: ta sama kolejność bez roli; w przeglądzie dostaje widok review, nie odmowę', () => {
    for (let i = 0; i < FF_ORDER.length - 1; i += 1) {
      const { code } = FF_ORDER[i]!;
      if (code === 'provenance-review') continue;
      const c = ffFaults(i);
      const v = view(c.facts, { actor: 'operator', canManage: c.canManage, environment: c.environment });
      expect(v, code).toMatchObject({ kind: 'refused', refusal: code });
    }
    const roleOnly = ffFaults(FF_ORDER.length - 1);
    expect(view(roleOnly.facts, { actor: 'operator', canManage: false }).kind).toBe('decidable');
  });

  it('state-unknown: blokady SQL nie odczytano (sqlBlocker undefined) — fail-closed, także dla operatora; null = czeka na decyzję', () => {
    const unread = faktflowFacts({ sqlBlocker: undefined });
    expect(view(unread)).toMatchObject({ kind: 'refused', refusal: 'state-unknown', message: FF.READ_FAILED(DUP_NR) });
    expect(view(unread, { actor: 'operator' })).toMatchObject({ kind: 'refused', refusal: 'state-unknown' });
    expect(view(faktflowFacts({ sqlBlocker: null })).kind).toBe('decidable');
  });

  it('known-now i cross-tenant z blokady SQL wygrywają z recheck-needed z JSON i z wpłatami; tekst z numerem K i dokumentu', () => {
    const facts = (sqlBlocker: string) => noGateFacts({ sqlBlocker, invoice: { paid_amount: 100 } });
    expect(view(facts('known-now'))).toMatchObject({ refusal: 'known-now', message: fillExpected('known-now', DUP_K, DUP_NR) });
    expect(view(facts('cross-tenant'))).toMatchObject({ refusal: 'cross-tenant', message: fillExpected('cross-tenant', DUP_NR, DUP_NR) });
  });

  it('recheck-needed (lustro 11c): brak bramy, brama w złym kształcie albo recheckNeeded na znaczniku — nawet gdy baza (sqlBlocker) mówi NULL', () => {
    const expected = { kind: 'refused', refusal: 'recheck-needed', message: fillExpected('recheck-needed', DUP_NR) };
    expect(view(noGateFacts())).toMatchObject(expected);
    for (const importGate of [null, 'importable', faktflowGate({ v: 2 }), faktflowGate({ kind: 'cokolwiek' }), faktflowGate({ problems: ['rates'] }), faktflowReviewGate([])]) {
      expect(view(faktflowFacts({ check: { importGate } })), JSON.stringify(importGate)).toMatchObject(expected);
    }
    const flagged = { recheckNeeded: { kind: 'import-mismatch', at: '2026-10-09T08:00:00.000Z' } };
    expect(view(faktflowFacts({ check: flagged }))).toMatchObject(expected);
    expect(view(faktflowFacts({ check: { ...flagged, importGate: faktflowReviewGate(['rates']) } }))).toMatchObject(expected);
  });

  it('recheck-needed z blokady SQL przy poprawnej bramie w JSON (baza ma ostatnie słowo) — ten sam tekst', () => {
    expect(view(faktflowFacts({ sqlBlocker: 'recheck-needed' })))
      .toMatchObject({ kind: 'refused', refusal: 'recheck-needed', message: fillExpected('recheck-needed', DUP_NR) });
  });

  it('operator przy recheck-needed: detail niesie rodzaj i czas znacznika (recheckPending); bez znacznika — brak oceny pliku', () => {
    const at = '2026-10-09T08:00:00.000Z';
    const flagged = view(faktflowFacts({ check: { recheckNeeded: { kind: 'gate-drift', at } } }), { actor: 'operator' });
    expect(flagged).toMatchObject({ kind: 'refused', refusal: 'recheck-needed', detail: { recheckKind: 'gate-drift', recheckAt: at } });
    const noGate = view(noGateFacts(), { actor: 'operator' });
    expect(noGate).toMatchObject({ kind: 'refused', refusal: 'recheck-needed' });
    const detail = (noGate as { detail?: { recheckKind?: string | null; recheckAt?: string | null } }).detail;
    expect(detail?.recheckKind ?? null).toBeNull();
    expect(detail?.recheckAt ?? null).toBeNull();
  });

  it('payments: sam paid_amount (JSON) albo wiersze payments (blokada SQL) — przed provenance-review (INV-17)', () => {
    expect(view(faktflowFacts({ invoice: { paid_amount: 100 } })))
      .toMatchObject({ refusal: 'payments', message: fillExpected('payments', DUP_NR) });
    expect(view(faktflowFacts({ sqlBlocker: 'payments' })))
      .toMatchObject({ refusal: 'payments', message: fillExpected('payments', DUP_NR) });
    const review = { importGate: faktflowReviewGate(['rates']) };
    expect(view(faktflowFacts({ check: review, invoice: { paid_amount: 100 }, sqlBlocker: 'payments' })))
      .toMatchObject({ refusal: 'payments' });
    expect(view(faktflowFacts({ check: review, invoice: { paid_amount: 100 }, sqlBlocker: 'payments' }), { actor: 'operator' }))
      .toMatchObject({ kind: 'refused', refusal: 'payments' });
  });

  it('baza ma ostatnie słowo: kod blokady SQL nieobsłużony przez TS odmawia z jego tekstem (wyścig)', () => {
    expect(view(faktflowFacts({ sqlBlocker: 'not-pending' })))
      .toMatchObject({ kind: 'refused', refusal: 'not-pending', message: fillExpected('not-pending', DUP_NR) });
    expect(view(faktflowFacts({ sqlBlocker: 'provenance-review' })))
      .toMatchObject({ kind: 'refused', refusal: 'provenance-review', message: fillExpected('provenance-review', DUP_NR) });
  });
});

describe('U1o (PR C): widok operatora w przeglądzie pliku (provenance-review, I5R)', () => {
  const reviewFacts = (check: Record<string, unknown> = {}, over: Parameters<typeof faktflowFacts>[0] = {}) =>
    faktflowFacts({ check: { importGate: faktflowReviewGate(['rates', 'amounts']), ...check }, sqlBlocker: 'provenance-review', ...over });

  it('klient: odmowa provenance-review z tekstem „sprawdzamy”, bez danych operatora i bez przycisku', () => {
    const v = view(reviewFacts());
    expect(v).toEqual({ kind: 'refused', refusal: 'provenance-review', message: fillExpected('provenance-review', DUP_NR) });
  });

  it('klient: provenance-review wygrywa ze środowiskiem i rolą (blokada SQL przed odmowami aplikacji)', () => {
    expect(view(reviewFacts(), { environment: null, canManage: false })).toMatchObject({ refusal: 'provenance-review' });
    expect(view(reviewFacts({ env: 'production' }), { canManage: false })).toMatchObject({ refusal: 'provenance-review' });
  });

  it('operator: review-pair → widok review z problemami bramy, obu wyborami i możliwością oddania', () => {
    const v = view(reviewFacts(), { actor: 'operator' });
    expect(v).toMatchObject({
      kind: 'review',
      offer: 'review-pair',
      problems: ['rates', 'amounts'],
      invoiceNumber: DUP_NR,
      originalKsefNumber: DUP_K,
      originalSha256: DUP_SHA,
      choices: ['same_sale', 'other_sale'],
      needsConfirmation: { same_sale: false, other_sale: true },
      sameContent: false,
      markedDifference: false,
      heldCorrections: false,
      program: 'FaktWay',
      releasable: true,
      correctionForPerson: false,
    });
    if (v.kind !== 'review') throw new Error('oczekiwano widoku review');
    expect(v.original).toEqual({ preview: faktflowPreview(), assignedDay: '2026-10-01', pastPeriod: false });
    expect(v.comparison.map((r) => r.label)).toContain(FF.ROW_SALE_DATE);
  });

  it.each([
    ['własna historia w JSON', () => reviewFacts({ ownHistory: true })],
    ['własna historia w bazie (sesja)', () => reviewFacts({}, { history: 'session' })],
    ['własna historia w bazie (skrót pliku)', () => reviewFacts({}, { history: 'hash' })],
    ['ta sama treść poza nagłówkiem', () => reviewFacts({ sameContentExceptHeader: true })],
  ])('operator: review-record (%s) → tylko „ta sama sprzedaż”, bez oddania decyzji (INV-19)', (_name, facts) => {
    const v = view(facts(), { actor: 'operator' });
    expect(v).toMatchObject({
      kind: 'review',
      offer: 'review-record',
      choices: ['same_sale'],
      releasable: false,
      needsConfirmation: expect.objectContaining({ other_sale: false }),
    });
  });

  it.each([
    ['własna historia w JSON i ta sama treść', () => reviewFacts({ ownHistory: true, sameContentExceptHeader: true }), 'own'],
    ['własna historia w bazie (sesja)', () => reviewFacts({}, { history: 'session' }), 'own'],
    ['ta sama treść bez własnej historii', () => reviewFacts({ sameContentExceptHeader: true }), 'same'],
  ] as const)('operator: review-record (%s) niesie recordIntro "%s" jak widok do decyzji (INV-24: ten sam wstęp)', (_name, facts, intro) => {
    expect(view(facts(), { actor: 'operator' })).toMatchObject({ kind: 'review', offer: 'review-record', recordIntro: intro });
  });

  it('operator: review-pair nie niesie recordIntro', () => {
    const v = view(reviewFacts(), { actor: 'operator' });
    expect(v).toMatchObject({ kind: 'review', offer: 'review-pair' });
    expect((v as { recordIntro?: unknown }).recordIntro).toBeUndefined();
  });

  it('operator: review bez podglądu pliku (plik nie dał się odczytać) — original.preview null, bez wiersza „Data sprzedaży”', () => {
    const gate = faktflowReviewGate(['parse'], { preview: null });
    const v = view(reviewFacts({ importGate: gate }), { actor: 'operator' });
    expect(v).toMatchObject({ kind: 'review', offer: 'review-pair', problems: ['parse'] });
    if (v.kind !== 'review') throw new Error('oczekiwano widoku review');
    expect(v.original?.preview ?? null).toBeNull();
    expect(rowOf(v, FF.ROW_SALE_DATE)).toBeUndefined();
  });

  it('operator: rodzaj identyfikatora nabywcy i KSeF produkcyjny w widoku review', () => {
    const pesel = view(reviewFacts({ importGate: faktflowReviewGate(['rates'], { preview: faktflowPreview({ buyerIdKind: 'pesel' }) }) }), { actor: 'operator' });
    expect(pesel).toMatchObject({ kind: 'review', correctionForPerson: true });
    const prod = view(reviewFacts({ env: 'production' }), { actor: 'operator', environment: 'production' });
    expect(prod).toMatchObject({ kind: 'review', heldCorrections: true });
  });

  it('operator: wpłata na dokumencie blokuje także zapis w przeglądzie (payments przed provenance-review)', () => {
    expect(view(reviewFacts({}, { invoice: { paid_amount: 100 } }), { actor: 'operator' })).toMatchObject({ kind: 'refused', refusal: 'payments' });
  });

  // M9 (rozstrzygnięcie leada): odmowa środowiska stoi PRZED widokiem review operatora — spec 5.5 krok 5 (review)
  // przed krokiem 6 (env) uznajemy za błąd kolejności, bo RPC i tak odmówiłoby ENV po zapisie kliknięcia.
  it('operator: środowisko znacznika inne niż serwera → odmowa env, nie widok review (M9)', () => {
    const wrongEnv = reviewFacts({ env: 'production' });

    const v = view(wrongEnv, { actor: 'operator' });

    expect(v).toMatchObject({ kind: 'refused', refusal: 'env' });
    expect(v.kind).not.toBe('review');
    // Kontrola dodatnia: to samo przejrzenie przy zgodnym środowisku daje widok review.
    expect(view(reviewFacts(), { actor: 'operator' }).kind).toBe('review');
  });

  it('operator: recheck-needed w przeglądzie wygrywa z review (znacznik albo brak bramy)', () => {
    const flagged = reviewFacts({ recheckNeeded: { kind: 'gate-drift', at: '2026-10-09T08:00:00.000Z' } });
    expect(view(flagged, { actor: 'operator' })).toMatchObject({ kind: 'refused', refusal: 'recheck-needed' });
  });
});

describe('U1p (PR C): szkic wycofany po zapisie oryginału — trzy banery, przycisk tylko przy „inna sprzedaż”, zdanie o korekcie', () => {
  const data = formatWarsawDateTime(DUP_DECIDED_AT);
  const nrOld = DUP_NR;
  const deleteRefusal = fillExpected('TRIGGER_DELETE_IMPORTED', nrOld, DUP_K);
  const regularCta = { href: '/invoices/new/regular', label: 'Wystaw nową fakturę' };
  /** Szkic po zapisie K nie ma numeru (przeszedł na K): `invoiceNumber` null. */
  const retired = (rows: DuplicateFactsSubmission[], over: { invoiceNumber?: string | null; kindHeld?: boolean } = {}) =>
    retiredDraftView({
      invoiceNumber: over.invoiceNumber === undefined ? null : over.invoiceNumber,
      invoiceKind: 'regular',
      submissions: rows,
      kindHeld: over.kindHeld ?? false,
    });
  const imported = { id: DUP_IMPORTED_ID, internalNumber: nrOld };

  it('ta sama sprzedaż (para): baner SAME, bez przycisku, odmowy *_IMPORTED, odnośnik do K', () => {
    expect(retired([numberTakenFaktflowRow('import', { choice: 'same_sale', offer: 'pair' })])).toEqual({
      title: FF.BANNER_TITLE(nrOld),
      body: FF.BANNER_SAME(data, '', DUP_NR, DUP_K),
      cta: null,
      knownInvoice: null,
      sendRefusal: fillExpected('TRIGGER_SAME_IMPORTED', nrOld, DUP_K, nrOld),
      deletable: false,
      deleteRefusal,
      imported,
    });
  });

  it('inna sprzedaż (para): baner OTHER i jedyny przycisk „Wystaw nową fakturę”; odmowa wysyłki TRIGGER_OTHER_IMPORTED', () => {
    expect(retired([numberTakenFaktflowRow('import', { choice: 'other_sale', offer: 'pair' })])).toEqual({
      title: FF.BANNER_TITLE(nrOld),
      body: FF.BANNER_OTHER(data, '', DUP_NR, DUP_K),
      cta: regularCta,
      knownInvoice: null,
      sendRefusal: fillExpected('TRIGGER_OTHER_IMPORTED', nrOld, nrOld, DUP_K),
      deletable: false,
      deleteRefusal,
      imported,
    });
  });

  it.each(['record', 'review-record'] as const)('zapis oryginału (oferta %s): baner RECORD, bez przycisku, odmowa jak „ta sama”', (offer) => {
    expect(retired([numberTakenFaktflowRow('import', { choice: 'same_sale', offer })])).toEqual({
      title: FF.BANNER_TITLE(nrOld),
      body: FF.BANNER_RECORD(data, '', DUP_NR, DUP_K),
      cta: null,
      knownInvoice: null,
      sendRefusal: fillExpected('TRIGGER_SAME_IMPORTED', nrOld, DUP_K, nrOld),
      deletable: false,
      deleteRefusal,
      imported,
    });
  });

  it('zapis operatora w przeglądzie: baner SAME / OTHER (review-pair) albo RECORD (review-record) z dopiskiem „zapisała pomoc FaktWay”', () => {
    const via = DUPLICATE_DECISION_TEXTS.BANNER_VIA_OPERATOR;
    const same = retired([numberTakenFaktflowRow('import', { choice: 'same_sale', offer: 'review-pair', via: 'operator' })]);
    expect(same).toMatchObject({ body: FF.BANNER_SAME(data, via, DUP_NR, DUP_K), cta: null });
    const other = retired([numberTakenFaktflowRow('import', { choice: 'other_sale', offer: 'review-pair', via: 'operator' })]);
    expect(other).toMatchObject({ body: FF.BANNER_OTHER(data, via, DUP_NR, DUP_K), cta: regularCta });
    const record = retired([numberTakenFaktflowRow('import', { choice: 'same_sale', offer: 'review-record', via: 'operator' })]);
    expect(record).toMatchObject({ body: FF.BANNER_RECORD(data, via, DUP_NR, DUP_K), cta: null });
  });

  it('numer faktury z KSeF w banerze to P_2 z pliku (summary.number), a nrOld — numer, który przeszedł z dokumentu', () => {
    const v = retired([numberTakenFaktflowRow('import', { choice: 'same_sale', summaryNumber: 'FV/2026/10/7-K' })]);
    expect(v!.body).toBe(FF.BANNER_SAME(data, '', 'FV/2026/10/7-K', DUP_K));
    expect(v!.title).toBe(FF.BANNER_TITLE(nrOld));
  });

  it.each([
    ['nip', false],
    ['vat-ue', false],
    ['pesel', true],
    ['nr-inny', true],
    ['brak-id', true],
    ['none', true],
  ] as const)('zdanie o korekcie dla nabywcy bez NIP i bez VAT-UE (decision.original.buyerIdKind = %s): dokładnie raz = %s', (buyerIdKind, expected) => {
    const sentence = FF.CORRECTION_PERSON.trim();
    for (const choice of ['same_sale', 'other_sale'] as const) {
      const v = retired([numberTakenFaktflowRow('import', { choice, buyerIdKind })]);
      // Baner po zapisie oryginału (nie baner PR B) — dopiero on niesie zdanie o korekcie.
      expect(v!.title, `${choice}/${buyerIdKind}`).toBe(FF.BANNER_TITLE(nrOld));
      expect(v!.body.split(sentence).length - 1, `${choice}/${buyerIdKind}`).toBe(expected ? 1 : 0);
    }
  });

  it('po oddaniu (no-import): teksty PR B z programem „nieznanym”, numer zostaje na dokumencie, bez odnośnika do K', () => {
    const same = retired([numberTakenFaktflowRow('no-import', { choice: 'same_sale', offer: 'released' })], { invoiceNumber: DUP_NR });
    expect(same).toMatchObject({
      title: DUPLICATE_DECISION_TEXTS.BANNER_TITLE(DUP_NR),
      body: DUPLICATE_DECISION_TEXTS.BANNER_SAME(data, '', DUP_NR, DUP_K, null),
      cta: null,
      knownInvoice: null,
      sendRefusal: fillExpected('TRIGGER_SAME', DUP_NR, DUP_K),
      deletable: false,
      deleteRefusal: fillExpected('TRIGGER_DELETE', DUP_NR, `faktura ${DUP_K}`),
    });
    expect(same!.imported ?? null).toBeNull();
    const other = retired([numberTakenFaktflowRow('no-import', { choice: 'other_sale', offer: 'released' })], { invoiceNumber: DUP_NR });
    expect(other).toMatchObject({
      body: DUPLICATE_DECISION_TEXTS.BANNER_OTHER(data, '', DUP_K, DUP_NR),
      cta: regularCta,
      sendRefusal: fillExpected('TRIGGER_OTHER', DUP_NR, DUP_K),
    });
    expect(other!.imported ?? null).toBeNull();
  });
});

describe('U1q (PR C): retiredDraftSendRefusal po zapisie oryginału — numer z decyzji, nie z dokumentu', () => {
  it('ta sama sprzedaż i zapis: TRIGGER_SAME_IMPORTED (dawny numer, K, dawny numer); inna: TRIGGER_OTHER_IMPORTED (dawny, dawny, K)', () => {
    expect(retiredDraftSendRefusal(null, [numberTakenFaktflowRow('import', { choice: 'same_sale' })]))
      .toBe(fillExpected('TRIGGER_SAME_IMPORTED', DUP_NR, DUP_K, DUP_NR));
    expect(retiredDraftSendRefusal(null, [numberTakenFaktflowRow('import', { choice: 'same_sale', offer: 'record' })]))
      .toBe(fillExpected('TRIGGER_SAME_IMPORTED', DUP_NR, DUP_K, DUP_NR));
    expect(retiredDraftSendRefusal(null, [numberTakenFaktflowRow('import', { choice: 'other_sale' })]))
      .toBe(fillExpected('TRIGGER_OTHER_IMPORTED', DUP_NR, DUP_NR, DUP_K));
  });

  it('dawny numer: retiredInternalNumber z decyzji, inaczej numer dokumentu, inaczej „bez numeru”', () => {
    const noOld = numberTakenFaktflowRow('import', { choice: 'same_sale', retiredInternalNumber: null });
    expect(retiredDraftSendRefusal('FV/DOKUMENT/1', [noOld])).toBe(fillExpected('TRIGGER_SAME_IMPORTED', 'FV/DOKUMENT/1', DUP_K, 'FV/DOKUMENT/1'));
    expect(retiredDraftSendRefusal(null, [noOld])).toBe(fillExpected('TRIGGER_SAME_IMPORTED', 'bez numeru', DUP_K, 'bez numeru'));
    const other = numberTakenFaktflowRow('import', { choice: 'same_sale', retiredInternalNumber: 'FV/STARY/9' });
    expect(retiredDraftSendRefusal('FV/DOKUMENT/1', [other])).toBe(fillExpected('TRIGGER_SAME_IMPORTED', 'FV/STARY/9', DUP_K, 'FV/STARY/9'));
  });
});

describe('U1r (PR C): decyzja zapisana na znaczniku — widok decided z trybem, ofertą i fakturą K (decisionOf)', () => {
  const draft = (rows: DuplicateFactsSubmission[], numberless = true) => decisionFacts({
    invoice: { ksef_status: 'draft', last_error_code: null, internal_number: numberless ? null : DUP_NR },
    submissions: rows,
  });

  it('zapis oryginału: widok decided niesie mode, offer, importedInvoiceId i retiredInternalNumber', () => {
    for (const offer of ['pair', 'record', 'review-pair', 'review-record'] as const) {
      const v = view(draft([numberTakenFaktflowRow('import', { choice: 'same_sale', offer, via: offer.startsWith('review') ? 'operator' : 'client' })]));
      expect(v, offer).toEqual({
        kind: 'decided',
        choice: 'same_sale',
        via: offer.startsWith('review') ? 'operator' : 'client',
        at: DUP_DECIDED_AT,
        originalKsefNumber: DUP_K,
        mode: 'import',
        offer,
        importedInvoiceId: DUP_IMPORTED_ID,
        retiredInternalNumber: DUP_NR,
      });
    }
  });

  it('inna sprzedaż z zapisem oryginału: ten sam widok z wyborem other_sale', () => {
    const v = view(draft([numberTakenFaktflowRow('import', { choice: 'other_sale', offer: 'pair' })]));
    expect(v).toMatchObject({ kind: 'decided', choice: 'other_sale', mode: 'import', offer: 'pair', importedInvoiceId: DUP_IMPORTED_ID });
  });

  it('po oddaniu (no-import): mode i offer z decyzji, bez faktury K', () => {
    const v = view(draft([numberTakenFaktflowRow('no-import', { choice: 'other_sale', offer: 'released' })], false));
    expect(v).toMatchObject({ kind: 'decided', choice: 'other_sale', mode: 'no-import', offer: 'released', originalKsefNumber: DUP_K });
    const decided = v as { importedInvoiceId?: string | null; retiredInternalNumber?: string | null };
    expect(decided.importedInvoiceId ?? null).toBeNull();
    expect(decided.retiredInternalNumber ?? null).toBeNull();
  });
});

describe('U1s (PR C): importedOriginalProvenance — pochodzenie faktury K z fa3_data.import (karta K, 6.5)', () => {
  const fa3 = (decision: Record<string, unknown> = {}, importOver: Record<string, unknown> = {}) => ({
    uwagi: 'dane faktury z pliku',
    import: {
      source: ORIGINAL_IMPORT_SOURCE,
      originalSha256: DUP_SHA,
      checkedAt: '2026-10-02T08:00:00.000Z',
      preparedAt: DUP_DECIDED_AT,
      gateRules: 1,
      decision: {
        choice: 'same_sale',
        via: 'client',
        at: DUP_DECIDED_AT,
        offer: 'pair',
        actorUserId: DUP_CLIENT_USER_ID,
        note: null,
        retiredInvoiceId: DUP_INVOICE_ID,
        retiredInternalNumber: DUP_NR,
        markerSubmissionId: 'sub-2-znacznik',
        ...decision,
      },
      ...importOver,
    },
  });
  const valid = {
    decidedAt: DUP_DECIDED_AT,
    choice: 'same_sale',
    offer: 'pair',
    via: 'client',
    retiredInvoiceId: DUP_INVOICE_ID,
    retiredInternalNumber: DUP_NR,
  };

  it('poprawna decyzja → dokładnie sześć pól dla komponentu (bez aktora i notatki)', () => {
    expect(importedOriginalProvenance(fa3())).toEqual(valid);
    expect(importedOriginalProvenance(fa3({ via: 'operator', actorUserId: DUP_OPERATOR_ID, note: DUP_RELEASED_AT, choice: 'other_sale', offer: 'review-pair' })))
      .toEqual({ ...valid, via: 'operator', choice: 'other_sale', offer: 'review-pair' });
  });

  it.each(['pair', 'record', 'review-pair', 'review-record'] as const)('oferta trybu import %s przechodzi', (offer) => {
    expect(importedOriginalProvenance(fa3({ offer }))).toEqual({ ...valid, offer });
  });

  it.each([
    ['fa3_data null', null],
    ['fa3_data napisem', 'json'],
    ['fa3_data tablicą', []],
    ['fa3_data pusty', {}],
    ['import null', { import: null }],
    ['import tablicą', { import: [] }],
    ['źródło ksef_history (Magiczny import)', fa3({}, { source: 'ksef_history' })],
    ['brak źródła', fa3({}, { source: undefined })],
    ['brak decision', fa3({}, { decision: undefined })],
    ['decision napisem', fa3({}, { decision: 'same_sale' })],
    ['decision tablicą', fa3({}, { decision: [] })],
    ['wybór nieznany', fa3({ choice: 'cokolwiek' })],
    ['brak wyboru', fa3({ choice: undefined })],
    ['via nieznane', fa3({ via: 'ktoś' })],
    ['brak via', fa3({ via: undefined })],
    ['oferta released (tryb no-import nie tworzy K)', fa3({ offer: 'released' })],
    ['oferta nieznana', fa3({ offer: 'cokolwiek' })],
    ['brak oferty', fa3({ offer: undefined })],
    ['data decyzji nie jest datą', fa3({ at: 'nie data' })],
    ['brak daty decyzji', fa3({ at: undefined })],
    ['brak id dokumentu X', fa3({ retiredInvoiceId: undefined })],
    ['puste id dokumentu X', fa3({ retiredInvoiceId: '' })],
    ['id dokumentu X liczbą', fa3({ retiredInvoiceId: 7 })],
    ['brak numeru X', fa3({ retiredInternalNumber: undefined })],
    ['pusty numer X', fa3({ retiredInternalNumber: '' })],
    ['numer X liczbą', fa3({ retiredInternalNumber: 7 })],
  ])('%s → null', (_name, fa3Data) => {
    // Pierwszy wiersz tej samej tabeli: decyzja poprawna daje wynik — test nie przechodzi przez samo `null`.
    expect(importedOriginalProvenance(fa3())).toEqual(valid);
    expect(importedOriginalProvenance(fa3Data)).toBeNull();
  });
});

describe('U1t (PR C): decisionLabel — jedna etykieta decyzji dla karty K, ALREADY_IMPORTED i toastów', () => {
  it.each([
    ['record', 'same_sale', 'record'],
    ['review-record', 'same_sale', 'record'],
    ['pair', 'same_sale', 'same_sale'],
    ['pair', 'other_sale', 'other_sale'],
    ['review-pair', 'other_sale', 'other_sale'],
    ['review-pair', 'same_sale', 'same_sale'],
    ['released', 'same_sale', 'same_sale'],
    ['released', 'other_sale', 'other_sale'],
    [null, 'other_sale', 'other_sale'],
    [undefined, 'same_sale', 'same_sale'],
  ] as const)('oferta %s, wybór %s → %s', (offer, choice, expected) => {
    expect(decisionLabel(offer, choice)).toBe(expected);
  });

  it('każda oferta × wybór: tylko record i review-record dają „record”', () => {
    for (const offer of DUPLICATE_ORIGINAL_OFFERS) {
      for (const choice of ['same_sale', 'other_sale'] as const) {
        const recordOffer = offer === 'record' || offer === 'review-record';
        expect(decisionLabel(offer, choice), `${offer}/${choice}`).toBe(recordOffer ? 'record' : choice);
      }
    }
  });
});

describe('U1u (PR C): lustra funkcji SQL na wspólnych tabelach (INV-15) — oferta, brama, znacznik „sprawdź ponownie”, własna historia', () => {
  const importGateOf = (check: unknown): unknown =>
    typeof check === 'object' && check !== null && !Array.isArray(check) ? (check as Record<string, unknown>).importGate : undefined;
  const OFFER_CASES = faktflowOfferCases();

  it('R-C15: tabela ma unikalne nazwy i każdą ofertę, a lustro TS zwraca dokładnie zbiór ofert z tabeli', () => {
    expect(new Set(OFFER_CASES.map((c) => c.name)).size).toBe(OFFER_CASES.length);
    const expected = new Set(OFFER_CASES.map((c) => c.offer));
    for (const offer of [...DUPLICATE_ORIGINAL_OFFERS, null]) expect(expected.has(offer), String(offer)).toBe(true);
    expect(new Set(OFFER_CASES.map((c) => duplicateOriginalOffer(c.check, c.ownHistoryDb)))).toEqual(expected);
  });

  it.each(OFFER_CASES.map((c) => [c.name, c] as const))('duplicateOriginalOffer: %s', (_name, c) => {
    expect(duplicateOriginalOffer(c.check, c.ownHistoryDb)).toBe(c.offer);
  });

  it.each(OFFER_CASES.map((c) => [c.name, c] as const))('originalGateOk: %s', (_name, c) => {
    expect(originalGateOk(importGateOf(c.check))).toBe(c.gateOk);
  });

  it.each([
    ['brama importable, bez znacznika', faktflowCheck(), false],
    ['brama review (poprawna)', faktflowCheck({ importGate: faktflowReviewGate(['rates']) }), false],
    ['brama review z oddaniem', faktflowCheck({ importGate: faktflowReviewGate(['rates'], { release: faktflowRelease() }) }), false],
    ['brak bramy', withoutKey(faktflowCheck(), 'importGate'), true],
    ['brama null', faktflowCheck({ importGate: null }), true],
    ['brama w złym kształcie (v 2)', faktflowCheck({ importGate: faktflowGate({ v: 2 }) }), true],
    ['brama importable z problemem', faktflowCheck({ importGate: faktflowGate({ problems: ['rates'] }) }), true],
    ['brama review bez problemów', faktflowCheck({ importGate: faktflowReviewGate([]) }), true],
    ['poprawna brama importable i recheckNeeded', faktflowCheck({ recheckNeeded: { kind: 'gate-drift', at: DUP_RELEASED_AT } }), true],
    ['poprawna brama review i recheckNeeded', faktflowCheck({ importGate: faktflowReviewGate(['rates']), recheckNeeded: { kind: 'archive-missing', at: DUP_RELEASED_AT } }), true],
    ['brak bramy i recheckNeeded', { ...withoutKey(faktflowCheck(), 'importGate'), recheckNeeded: { kind: 'not-buildable', at: DUP_RELEASED_AT } }, true],
    // M4: liczy się OBECNOŚĆ klucza (SQL 11c: `p_check ? 'recheckNeeded'`), nie wartość — spec 5.5 `!= null` ustępuje SQL.
    ['poprawna brama i recheckNeeded: null — sama obecność klucza (jak SQL ?)', faktflowCheck({ recheckNeeded: null }), true],
  ])('originalRecheckNeeded (lustro kroku 11c): %s → %s', (_name, check, expected) => {
    expect(originalRecheckNeeded(check)).toBe(expected);
  });

  describe('ownHistoryInSubmissions (lustro ksef_duplicate_own_history, 4.3)', () => {
    const subs = (...rows: Array<{ session?: string | null; hash?: string | null }>) =>
      rows.map((r) => ({ session_reference_number: r.session ?? null, request_payload_hash: r.hash ?? null }));
    const marker = (over: { session?: string | null; check?: unknown } = {}) => ({
      original_session_reference_number: over.session === undefined ? 'SES-ORIG-1' : over.session,
      original_check: 'check' in over ? over.check : { sha256: DUP_SHA },
    });

    it('sesja oryginału w którejś próbie → true; skrót oryginału (wielkość liter bez znaczenia) → true; inaczej false', () => {
      expect(ownHistoryInSubmissions(subs({ session: 'SES-OWN-0' }, { session: 'SES-ORIG-1' }), marker())).toBe(true);
      expect(ownHistoryInSubmissions(subs({ hash: 'cc'.repeat(32) }, { hash: DUP_SHA }), marker())).toBe(true);
      expect(ownHistoryInSubmissions(subs({ hash: DUP_SHA.toUpperCase() }), marker())).toBe(true);
      expect(ownHistoryInSubmissions(subs({ session: 'SES-OWN-0', hash: 'cc'.repeat(32) }), marker())).toBe(false);
      expect(ownHistoryInSubmissions([], marker())).toBe(false);
    });

    it('brak sesji oryginału na znaczniku nie dopasowuje prób bez sesji; brak skrótu w znaczniku nie dopasowuje prób bez skrótu', () => {
      // Najpierw przypadek, który MUSI być prawdziwy (skrót zgadza się, sesji brak) — potem brak dopasowania przez NULL.
      expect(ownHistoryInSubmissions(subs({ hash: DUP_SHA }), marker({ session: null }))).toBe(true);
      expect(ownHistoryInSubmissions(subs({ session: null, hash: 'cc'.repeat(32) }, {}), marker({ session: null }))).toBe(false);
      expect(ownHistoryInSubmissions(subs({ hash: null }, {}), marker({ check: {} }))).toBe(false);
      expect(ownHistoryInSubmissions(subs({ hash: DUP_SHA }), marker({ check: null }))).toBe(false);
      expect(ownHistoryInSubmissions(subs({ session: 'SES-ORIG-1' }), marker({ check: null }))).toBe(true);
    });
  });

  describe('duplicateNoticeVariant (INV-24): ten sam wariant co panel', () => {
    const released = faktflowCheck(releasedCheck());
    it.each([
      ['FO-PARA (JSON ownHistory=false, baza bez historii)', faktflowCheck(), false, null, 'pair'],
      ['FO-PARA, ale skrót oryginału w próbie faktury (baza ma historię)', faktflowCheck(), true, null, 'record'],
      ['FO-WŁASNA (ownHistory w JSON)', faktflowCheck({ ownHistory: true }), false, null, 'record'],
      ['FO-TA-SAMA-TREŚĆ', faktflowCheck({ sameContentExceptHeader: true }), false, null, 'record'],
      ['FO-ODDANA', released, false, null, 'released'],
      ['FO-PRZEGLĄD: blokada provenance-review', faktflowCheck({ importGate: faktflowReviewGate(['rates']) }), false, 'provenance-review', 'review'],
      ['FO-PRZEGLĄD: review-record', faktflowCheck({ importGate: faktflowReviewGate(['rates']), ownHistory: true }), true, 'provenance-review', 'review'],
      ['no-own-file (PR B)', validCheck(), false, null, 'pair'],
      ['known-number (PR B)', knownNumberCheck(), false, null, 'pair'],
      ['recheck-needed → ścieżka ogólna', withoutKey(faktflowCheck(), 'importGate'), false, 'recheck-needed', null],
      ['known-now → ścieżka ogólna', faktflowCheck(), false, 'known-now', null],
      ['cross-tenant → ścieżka ogólna', faktflowCheck(), false, 'cross-tenant', null],
      ['payments → ścieżka ogólna', faktflowCheck(), false, 'payments', null],
      ['own-history (PR B) → ścieżka ogólna', validCheck(), true, 'own-history', null],
    ] as const)('%s', (_name, check, ownHistoryDb, blocker, expected) => {
      expect(duplicateNoticeVariant(check, ownHistoryDb, blocker)).toBe(expected);
    });
  });
});

describe('U1r (D-A4-1b-3-KORZW): korekta K, której FaktWay jeszcze nie wystawi (stawka zw, stawka spoza FaktWay, brak ceny netto)', () => {
  const line = (over: Record<string, unknown> = {}) => ({
    ordinal: 1, name: 'Usługa', quantity: '1', unit: 'usł.', unitPriceNet: '100.00', vatRate: '23', gross: '123.00', ...over,
  });
  /** Brama z podglądem o podanych pozycjach (liczba pozycji = liczba widocznych, chyba że `lineCount` podano). */
  const gateOf = (lines: unknown[], problems: string[] = [], previewOver: Record<string, unknown> = {}) => {
    const preview = faktflowPreview({ lines, lineCount: lines.length, ...previewOver });
    return problems.length > 0 ? faktflowReviewGate(problems, { preview }) : faktflowGate({ preview });
  };
  const manyLines = (n: number, over: Record<string, unknown> = {}) => Array.from({ length: n }, (_, i) => line({ ordinal: i + 1, ...over }));
  const zw = () => gateOf([line({ vatRate: 'zw' })]);

  describe('polityka originalHasUncorrectableLine', () => {
    it('sama pozycja zw → true; nabywca z NIP i stawka 23% → false', () => {
      expect(originalHasUncorrectableLine(zw())).toBe(true);
      expect(originalHasUncorrectableLine(faktflowGate())).toBe(false);
    });

    it.each(['23', '8', '5', '0', 'oo', 'np', 'np_ii'])('stawka %s, którą FaktWay koryguje → false', (vatRate) => {
      expect(originalHasUncorrectableLine(gateOf([line({ vatRate })]))).toBe(false);
    });

    it.each(['zw', '0 WDT', '0 EX', '22', '7', '4', '3', 'nieznana'])('stawka %s bez korekty w FaktWay → true (nawet gdy inne pozycje są w porządku)', (vatRate) => {
      expect(originalHasUncorrectableLine(gateOf([line(), line({ ordinal: 2, vatRate })]))).toBe(true);
    });

    it('pozycja bez ceny netto (null albo pusta) → true', () => {
      expect(originalHasUncorrectableLine(gateOf([line({ unitPriceNet: null })]))).toBe(true);
      expect(originalHasUncorrectableLine(gateOf([line({ unitPriceNet: '' })]))).toBe(true);
    });

    it('pozycji jest więcej niż widocznych (20): problem rates, gross-prices albo line-fields → true, inny problem albo brak → false', () => {
      const visible = manyLines(20);
      expect(originalHasUncorrectableLine(gateOf(visible, ['rates'], { lineCount: 25 }))).toBe(true);
      expect(originalHasUncorrectableLine(gateOf(visible, ['gross-prices'], { lineCount: 25 }))).toBe(true);
      expect(originalHasUncorrectableLine(gateOf(visible, ['line-fields'], { lineCount: 25 }))).toBe(true);
      expect(originalHasUncorrectableLine(gateOf(visible, ['amounts', 'totals'], { lineCount: 25 }))).toBe(false);
      expect(originalHasUncorrectableLine(gateOf(visible, [], { lineCount: 25 }))).toBe(false);
      // Warunek dodatni: te same problemy przy kompletnej liście pozycji nic nie dopisują (widać wszystko).
      expect(originalHasUncorrectableLine(gateOf(visible, ['rates'], { lineCount: 20 }))).toBe(false);
    });

    it('widoczna pozycja zw wygrywa także przy skróconej liście', () => {
      expect(originalHasUncorrectableLine(gateOf([...manyLines(19), line({ ordinal: 20, vatRate: 'zw' })], [], { lineCount: 25 }))).toBe(true);
    });

    it('brak bramy, podglądu albo pozycji (zły kształt) → false: nie ma na czym oprzeć obietnicy ani jej cofnięcia', () => {
      for (const gate of [null, undefined, 'importable', [], {}, faktflowGate({ preview: null }), faktflowGate({ preview: 'x' }), faktflowGate({ preview: { lines: 'x' } })]) {
        expect(originalHasUncorrectableLine(gate), JSON.stringify(gate)).toBe(false);
      }
    });
  });

  describe('widok panelu (decidable) i przeglądu operatora', () => {
    it('zw → correctionForRate; correctionForPerson bez zmian (nabywca z NIP)', () => {
      const check = { importGate: zw() };
      for (const ownHistory of [false, true]) {
        const v = ffDecidable({ check: { ...check, ownHistory } });
        expect(v, `ownHistory=${ownHistory}`).toMatchObject({ kind: 'decidable', correctionForRate: true, correctionForPerson: false });
      }
      expect(ffDecidable()).toMatchObject({ correctionForRate: false, correctionForPerson: false });
    });

    it('nabywca bez NIP i stawka zw → oba zdania; nabywca bez NIP i 23% → tylko osoba', () => {
      const pesel = (lines: unknown[]) => ({ importGate: gateOf(lines, [], { buyerIdKind: 'pesel' }) });
      expect(ffDecidable({ check: pesel([line({ vatRate: 'zw' })]) })).toMatchObject({ correctionForPerson: true, correctionForRate: true });
      expect(ffDecidable({ check: pesel([line()]) })).toMatchObject({ correctionForPerson: true, correctionForRate: false });
    });

    it('skrócona lista pozycji z problemem rates (oferta review) → true także w widoku operatora', () => {
      const gate = gateOf(manyLines(20), ['rates'], { lineCount: 25 });
      const v = view(
        faktflowFacts({ check: { importGate: gate }, sqlBlocker: 'provenance-review' }),
        { actor: 'operator' },
      );
      expect(v).toMatchObject({ kind: 'review', correctionForRate: true, correctionForPerson: false });
    });

    it('powód PR B (bez oferty): correctionForRate false, jak correctionForPerson', () => {
      const v = decidableView(decisionFacts({}));
      expect(v).toMatchObject({ correctionForPerson: false, correctionForRate: false });
    });
  });

  describe('baner szkicu wycofanego po zapisie K (z importGate.preview znacznika)', () => {
    const retiredOf = (choice: 'same_sale' | 'other_sale', over: Parameters<typeof numberTakenFaktflowRow>[1] = {}) =>
      retiredDraftView({
        invoiceNumber: null,
        invoiceKind: 'regular',
        submissions: [numberTakenFaktflowRow('import', { choice, summaryNumber: 'FV/2026/10/7-K', ...over })],
        kindHeld: false,
      });
    const nrK = 'FV/2026/10/7-K';

    it.each(['same_sale', 'other_sale'] as const)('%s: K z pozycją zw → CORRECTION_RATE(numer K) dokładnie raz; K z 23% → brak', (choice) => {
      const sentence = FF.CORRECTION_RATE(nrK).trim();
      const withZw = retiredOf(choice, { check: { importGate: zw() } })!;
      expect(withZw.body.split(sentence).length - 1).toBe(1);
      expect(withZw.body.endsWith(FF.CORRECTION_RATE(nrK))).toBe(true);
      expect(retiredOf(choice)!.body).not.toContain(sentence);
    });

    it('nabywca bez NIP i stawka zw → oba zdania po jednym razie, osoba przed stawką', () => {
      const v = retiredOf('same_sale', { buyerIdKind: 'pesel', check: { importGate: zw() } })!;
      expect(v.body.endsWith(FF.CORRECTION_PERSON + FF.CORRECTION_RATE(nrK))).toBe(true);
      expect(v.body.split(FF.CORRECTION_PERSON.trim()).length - 1).toBe(1);
      expect(v.body.split(FF.CORRECTION_RATE(nrK).trim()).length - 1).toBe(1);
    });

    it('baner po oddaniu (no-import) i decyzje PR B nie dostają zdania o stawce', () => {
      const released = retiredDraftView({
        invoiceNumber: DUP_NR,
        invoiceKind: 'regular',
        submissions: [numberTakenFaktflowRow('no-import', { choice: 'same_sale', offer: 'released', check: { importGate: zw() } })],
        kindHeld: false,
      })!;
      expect(released.body).not.toContain(FF.CORRECTION_RATE(DUP_NR).trim());
    });
  });

  it('CORRECTION_RATE: krótko, z numerem K i adresem pomocy, bez długiego myślnika', () => {
    const t = FF.CORRECTION_RATE('FV/1/K');
    expect(t.startsWith(' Korekt faktury FV/1/K ')).toBe(true);
    expect(t).toContain('zwolnion');
    expect(t).toContain('spoza FaktWay');
    expect(t).toContain('bez ceny netto');
    expect(t).toContain(SUPPORT_EMAIL);
    expect(t).not.toMatch(/[—–]/);
  });
});
