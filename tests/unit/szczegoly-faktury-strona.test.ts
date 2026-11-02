import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A4b PR2b: strona szczegółów faktury (RSC) liczy fakty ponowienia z kopii na
 * wierszu (`ksefResendFacts`) i znajomość środowiska KSeF
 * (`configuredKsefEnvironment`) — te same funkcje co akcja „Wyślij ponownie”,
 * cron I6/I7 i operator. Komponent kliencki dostaje tylko fakty: `fa3_data`
 * i `special_data` (treść dokumentu) zostają na serwerze.
 *
 * Do PR2b select strony nie miał `fa3_data` ani `special_data`, a `initial`
 * nie niósł faktów — przyciski nie mogły odróżnić ZAL z kopią od starej
 * korekty bez danych, więc każdy dokument specjalny dostawał tylko szkic.
 *
 * Prawdziwe: strona, `ksefResendFacts`, `configuredKsefEnvironment`.
 * Zastąpione: klient Supabase (baza w pamięci, projekcja wybranych kolumn —
 * kolumna niepobrana nie istnieje w wierszu), `notFound` i widok kliencki.
 */

const st = vi.hoisted(() => ({
  db: null as null | import('./helpers/ponowienie-specjalne-baza').MemoryDb,
  user: 'fixture-user',
  /** Wywołania `.not(...)` (baza w pamięci go nie ma) — D-A4-1b-3 PR B: strona czyta znacznik loaderem z samymi `.eq`. */
  notCalls: [] as Array<{ table: string; args: unknown[] }>,
  /** Odpowiedź RPC `invoice_manual_payment` (00158). */
  manualPayment: { data: null as unknown, error: null as { message: string } | null },
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q = st.db!.from(table);
      // `.not` tylko notuje wywołanie (filtr bez skutku): stary odczyt znacznika
      // 440 strony (do PR B) przechodzi na danych tych testów, a test sprawdza,
      // że strona przeszła na loader faktów bez `.not`.
      return Object.assign(q, {
        not: (...args: unknown[]) => {
          st.notCalls.push({ table, args });
          return q;
        },
      });
    },
    auth: { getUser: async () => ({ data: { user: { id: st.user } }, error: null }) },
    rpc: async (fn: string, args: unknown) => {
      st.rpcCalls.push({ fn, args });
      return st.manualPayment;
    },
  }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/components/invoices/invoice-detail-view', () => ({ InvoiceDetailView: () => null }));

import InvoiceDetailPage from '@/app/(dashboard)/invoices/[id]/page';
import type { InvoiceDetailInitial } from '@/components/invoices/invoice-detail-view';
import {
  KSEF_RESEND_SOURCE_COLUMN_KEYS,
  KSEF_RESEND_SOURCE_COLUMNS,
  type KsefResendFacts,
} from '@/lib/invoices/ksef-requeue-event';

import { formatWarsawDateTime } from '@/lib/format/warsaw-date';

import {
  BANNER,
  CLIENT,
  DECIDED_AT,
  K,
  K2,
  SHA_K,
  SQL,
  Y_ID,
  Y_NR,
  deleteRefusal,
  fill,
  knownNumberCheck,
  markerRow,
  numberTakenRow,
  sendRefusal,
} from './helpers/decyzja-klienta';
import { memoryDb, selectedColumns, type Row } from './helpers/ponowienie-specjalne-baza';

const TENANT = '11111111-1111-4111-8111-111111111111';
const REGULAR_ID = '33333333-3333-4333-8333-333333333331';
const ZAL_ID = '33333333-3333-4333-8333-333333333332';
const KOR_LEGACY_ID = '33333333-3333-4333-8333-333333333333';
const KOR_ID = '33333333-3333-4333-8333-333333333334';

// Dzień wystawienia (Europe/Warsaw) i dzień później.
const TODAY = '2026-10-02';
const NOW = new Date('2026-10-02T10:00:00Z');
const NEXT_DAY = new Date('2026-10-03T10:00:00Z');

const STORED: KsefResendFacts = { sendData: 'stored', kindHeld: false, issueDatePassed: false };

const sellerAddress = { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' };
const buyerAddress = { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' };
const seller = { nip: '1234567890', name: 'Firma testowa', address: sellerAddress };
const buyer = { nip: '1234567890', name: 'Nabywca testowy', address: buyerAddress };

/** Wiersz faktury z kolumnami czytanymi przez stronę (+ kolumny źródła ponowienia). */
function invoiceRow(id: string, patch: Row = {}): Row {
  return {
    id,
    tenant_id: TENANT,
    direction: 'outgoing',
    internal_number: 'FV/1/10/2026',
    invoice_type: 'VAT',
    invoice_kind: 'regular',
    issue_date: TODAY,
    sale_date: TODAY,
    ksef_status: 'failed',
    ksef_number: null,
    ksef_accepted_at: null,
    xml_storage_path: null,
    net_total: 100,
    vat_total: 23,
    gross_total: 123,
    notes: null,
    last_error: 'KSeF chwilowo niedostępny.',
    last_error_code: 'KSEF_UNAVAILABLE',
    last_error_field: null,
    last_error_suggestion: null,
    seller_data: seller,
    buyer_data: buyer,
    payment_data: null,
    special_data: null,
    fa3_data: {
      internalNumber: 'FV/1/10/2026', type: 'VAT', issueDate: TODAY, seller, buyer,
      lines: [{ ordinal: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
    },
    ...patch,
  };
}

/**
 * ZAL w kształcie INSERT z `saveAndSendAdvanceAction`: koperta w
 * `fa3_data.advanceEnvelope`, bez klucza `special_data` (w bazie domyślny NULL).
 */
function zalRow(): Row {
  const advanceEnvelope = {
    invoiceType: 'advance', internalNumber: 'ZAL/1/10/2026', issueDate: TODAY, seller, buyer,
    advanceAmount: 123, totalContractAmount: 1000, vatRate: '23', description: 'Testowa zaliczka na usługę',
  };
  const row = invoiceRow(ZAL_ID, {
    internal_number: 'ZAL/1/10/2026',
    invoice_type: 'ZAL',
    invoice_kind: 'advance',
    ksef_status: 'queued',
    last_error: null,
    last_error_code: null,
    fa3_data: {
      internalNumber: 'ZAL/1/10/2026', type: 'ZAL', issueDate: TODAY, seller, buyer,
      lines: [{ ordinal: 1, name: 'Testowa zaliczka na usługę', unit: 'szt.', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
      advanceEnvelope,
    },
  });
  delete row.special_data;
  return row;
}

/** Korekta: dane wysyłki w `special_data.correctionData` (00137); `null` — stara, sprzed 00137. */
function korRow(id: string, specialData: unknown): Row {
  return invoiceRow(id, {
    internal_number: 'FK/1/10/2026',
    invoice_type: 'KOR',
    invoice_kind: 'correction',
    fa3_data: {
      internalNumber: 'FK/1/10/2026', type: 'KOR', issueDate: TODAY, seller, buyer,
      lines: [{ ordinal: 1, name: 'Usługa', unit: 'szt.', quantity: -1, unitPriceNet: 100, vatRate: '23' }],
    },
    special_data: specialData,
  });
}

const korSpecialData = {
  correctionData: {
    invoiceType: 'correction', issueDate: TODAY, parentInvoiceNumber: 'FV 1/09/2026',
    correctionType: 'cancellation', correctionReason: 'Zwrot towaru', seller,
  },
};

function seed() {
  st.db = memoryDb({
    invoices: [
      invoiceRow(REGULAR_ID),
      zalRow(),
      korRow(KOR_LEGACY_ID, null),
      korRow(KOR_ID, korSpecialData),
    ],
    memberships: [{ user_id: st.user, organization_id: TENANT, status: 'active', role: 'owner' }],
    upo_receipts: [],
    ksef_submissions: [],
    // E3/P4: strona czyta skrót SHA-256 pliku XML sesją (RLS) do kodu QR (KOD I).
    xml_documents: [],
  });
  return st.db;
}

/** `initial`, który strona przekazuje widokowi klienckiemu. */
async function loadInitial(id: string): Promise<InvoiceDetailInitial> {
  const el = (await InvoiceDetailPage({ params: Promise.resolve({ id }) })) as ReactElement<{ initial: InvoiceDetailInitial }>;
  return el.props.initial;
}

beforeEach(() => {
  seed();
  st.notCalls.length = 0;
  st.rpcCalls.length = 0;
  st.manualPayment = { data: null, error: null };
  vi.stubEnv('KSEF_ENV', 'test');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('A4b PR2b: strona szczegółów faktury liczy fakty ponowienia z kopii na serwerze', () => {
  it('zwykła faktura failed z fa3_data.lines: fakty STORED, środowisko KSeF znane', async () => {
    const initial = await loadInitial(REGULAR_ID);
    expect(initial).toMatchObject({ id: REGULAR_ID, ksef_status: 'failed', can_manage_send: true });
    expect(initial.ksef_resend_facts).toEqual(STORED);
    expect(initial.ksef_environment_known).toBe(true);
  });

  it('ZAL (kształt INSERT) w kolejce: fakty liczone dla każdego statusu; następnego dnia data wystawienia minęła', async () => {
    const today = await loadInitial(ZAL_ID);
    expect(today.ksef_status).toBe('queued');
    expect(today.ksef_resend_facts).toEqual(STORED);

    vi.setSystemTime(NEXT_DAY);
    const nextDay = await loadInitial(ZAL_ID);
    expect(nextDay.ksef_resend_facts).toEqual({ sendData: 'stored', kindHeld: false, issueDatePassed: true });
  });

  it('KOR bez special_data (sprzed 00137): brak kopii danych; KOR z kopią: STORED', async () => {
    const legacy = await loadInitial(KOR_LEGACY_ID);
    expect(legacy.ksef_resend_facts).toMatchObject({ sendData: 'missing' });
    const stored = await loadInitial(KOR_ID);
    expect(stored.ksef_resend_facts).toEqual(STORED);
  });

  it('strażnik: initial bez fa3_data i special_data — treść dokumentu nie trafia do komponentu klienckiego', async () => {
    for (const id of [REGULAR_ID, ZAL_ID, KOR_ID]) {
      const initial = await loadInitial(id);
      expect(initial).not.toHaveProperty('fa3_data');
      expect(initial).not.toHaveProperty('special_data');
      const json = JSON.stringify(initial);
      expect(json).not.toContain('advanceEnvelope');
      expect(json).not.toContain('correctionData');
    }
  });

  it('odczyt faktury zawiera KSEF_RESEND_SOURCE_COLUMNS, każda kolumna raz', async () => {
    const db = st.db!;
    await loadInitial(ZAL_ID);
    const read = db.reads.find((r) => r.table === 'invoices');
    expect(read, 'strona nie czytała faktury').toBeDefined();
    const columns = selectedColumns(read!.columns);
    expect(columns).toEqual(expect.arrayContaining(['fa3_data', 'special_data']));
    expect(read!.columns).toContain(KSEF_RESEND_SOURCE_COLUMNS);
    for (const key of KSEF_RESEND_SOURCE_COLUMN_KEYS) {
      expect(columns.filter((c) => c === key), `kolumna ${key}`).toHaveLength(1);
    }
  });

  it('KSEF_ENV niepoprawne: środowisko nieznane, dokument specjalny wstrzymany (fail-closed)', async () => {
    vi.stubEnv('KSEF_ENV', 'bogus');
    const regular = await loadInitial(REGULAR_ID);
    expect(regular.ksef_environment_known).toBe(false);
    expect(regular.ksef_resend_facts).toEqual(STORED);
    const zal = await loadInitial(ZAL_ID);
    expect(zal.ksef_environment_known).toBe(false);
    expect(zal.ksef_resend_facts).toEqual({ sendData: 'stored', kindHeld: true, issueDatePassed: false });
  });

  it('KSEF_ENV production: środowisko znane, KOR wstrzymana (do C4), ZAL nie', async () => {
    vi.stubEnv('KSEF_ENV', 'production');
    const kor = await loadInitial(KOR_ID);
    expect(kor.ksef_environment_known).toBe(true);
    expect(kor.ksef_resend_facts).toEqual({ sendData: 'stored', kindHeld: true, issueDatePassed: false });
    const zal = await loadInitial(ZAL_ID);
    expect(zal.ksef_resend_facts).toEqual(STORED);
  });
});

/**
 * D-A4-1b-3 PR B (2.5): strona liczy na serwerze widok decyzji klienta
 * (`ksef_duplicate_decision`, ta sama polityka co akcja i RPC) i baner szkicu
 * wycofanego (`ksef_retired_draft`, każdy rodzaj — decyzja 9). Dane oryginału
 * czyta loader faktów sesją, samymi `.eq` (baza w pamięci nie ma `.not`); surowy
 * `original_check` nie trafia do komponentu klienckiego.
 *
 * Do PR B strona czytała znacznik 440 z `.in` i `.not` i pokazywała tylko notę,
 * a szkic wycofany wyglądał jak zwykły szkic.
 */
describe('D-A4-1b-3 PR B: widok decyzji klienta i baner szkicu wycofanego liczone na serwerze', () => {
  const DUP_ID = '33333333-3333-4333-8333-333333333341';
  const DUP_NR = 'FV/12/10/2026';
  const REG_RETIRED_ID = '33333333-3333-4333-8333-333333333342';
  const ZAL_RETIRED_ID = '33333333-3333-4333-8333-333333333343';
  const KOR_RETIRED_ID = '33333333-3333-4333-8333-333333333344';
  const PLAIN_DRAFT_ID = '33333333-3333-4333-8333-333333333345';

  /** Pola PR B w `initial` (typ zmienia się w PR B). */
  type InitialB = InvoiceDetailInitial & {
    ksef_duplicate_decision?: unknown;
    ksef_retired_draft?: unknown;
    ksef_duplicate_original: (InvoiceDetailInitial['ksef_duplicate_original'] & { link?: unknown }) | null;
  };
  const loadB = async (id: string) => (await loadInitial(id)) as InitialB;

  /** Faktura X: zwykła, failed `KSEF_DUPLICATE_RECONCILE`, bez wpłat, abonamentu i offline. */
  function duplicateRow(patch: Row = {}): Row {
    return invoiceRow(DUP_ID, {
      internal_number: DUP_NR,
      last_error: 'KSeF ma już fakturę o tym numerze — do uzgodnienia.',
      last_error_code: 'KSEF_DUPLICATE_RECONCILE',
      paid_amount: 0,
      stripe_invoice_id: null,
      offline_idempotency_key: null,
      offline_qr_offline: null,
      offline_qr_certyfikat: null,
      buyer_nip: '1234567890',
      currency: 'PLN',
      ...patch,
    });
  }

  const retiredDraft = (id: string, patch: Row): Row =>
    invoiceRow(id, { ksef_status: 'draft', last_error: null, last_error_code: null, ...patch });

  function add(invoices: Row[], submissions: Row[]) {
    st.db!.tables.invoices!.push(...invoices);
    st.db!.tables.ksef_submissions!.push(...submissions);
  }

  it('U12a: failed no-own-file — widok `decidable` z numerem KSeF i SHA-256 oryginału; znacznik czyta loader bez `.not`', async () => {
    add([duplicateRow()], [
      markerRow(TENANT, DUP_ID),
      markerRow(TENANT, DUP_ID, { id: 'sub-starsza', original_ksef_number: null, original_check: null, attempted_at: '2026-09-30T10:00:00.000Z', session_reference_number: 'SES-OWN-0' }),
    ]);

    const initial = await loadB(DUP_ID);

    expect(initial.ksef_duplicate_decision).toMatchObject({
      kind: 'decidable',
      reason: 'no-own-file',
      invoiceNumber: DUP_NR,
      originalKsefNumber: K,
      originalSha256: SHA_K,
      knownInvoice: null,
      sameContent: null,
    });
    expect(initial.ksef_retired_draft).toBeNull();
    // Fakty i nota PR A dalej na karcie (tabela danych oryginału).
    expect(initial.ksef_duplicate_original).toMatchObject({ title: 'W KSeF jest już faktura o tym numerze' });
    expect(st.notCalls).toEqual([]);
  });

  it('U12a: osoba bez roli właściciela/administratora — `refused` z powodem `role` na końcu, nota = tekst roli', async () => {
    add([duplicateRow()], [markerRow(TENANT, DUP_ID)]);
    st.db!.tables.memberships![0]!.role = 'member';

    const initial = await loadB(DUP_ID);

    expect(initial.ksef_duplicate_decision).toEqual({ kind: 'refused', refusal: 'role', message: CLIENT.role });
    expect(initial.ksef_duplicate_original?.note).toBe(CLIENT.role);
  });

  it('U12b: known-number, Y przyjęta z numerem KSeF oryginału — `decidable` z dokumentem Y', async () => {
    add(
      [duplicateRow(), { id: Y_ID, tenant_id: TENANT, direction: 'outgoing', ksef_status: 'accepted', ksef_number: K, internal_number: Y_NR }],
      [markerRow(TENANT, DUP_ID, { original_check: knownNumberCheck() })],
    );

    const initial = await loadB(DUP_ID);

    expect(initial.ksef_duplicate_decision).toMatchObject({
      kind: 'decidable',
      reason: 'known-number',
      knownInvoice: { id: Y_ID, internalNumber: Y_NR },
      originalKsefNumber: K,
    });
  });

  it('U12b: known-number, Y w stanie failed (uwaga 1 sprawdzenia) — `refused` known-stale; nota = ten tekst, odnośnik do Y (C16)', async () => {
    add(
      [duplicateRow(), { id: Y_ID, tenant_id: TENANT, direction: 'outgoing', ksef_status: 'failed', ksef_number: K, internal_number: Y_NR }],
      [markerRow(TENANT, DUP_ID, { original_check: knownNumberCheck() })],
    );

    const initial = await loadB(DUP_ID);

    const message = fill(SQL.knownStale, K, DUP_NR);
    expect(initial.ksef_duplicate_decision).toEqual({ kind: 'refused', refusal: 'known-stale', message });
    expect(initial.ksef_duplicate_original?.note).toBe(message);
    expect(initial.ksef_duplicate_original?.link).toEqual({ href: `/invoices/${Y_ID}`, label: `Zobacz dokument ${Y_NR}` });
  });

  it('U12c: szkic wycofany decyzją „inna sprzedaż” (zwykła faktura) — baner bez usuwania, przycisk „Wystaw nową fakturę”', async () => {
    const nr = 'FV/3/10/2026';
    add(
      [retiredDraft(REG_RETIRED_ID, { internal_number: nr })],
      [numberTakenRow(TENANT, REG_RETIRED_ID, 'decided-other'), numberTakenRow(TENANT, REG_RETIRED_ID, 'unmarked')],
    );

    const initial = await loadB(REG_RETIRED_ID);

    expect(initial.ksef_retired_draft).toMatchObject({
      title: BANNER.title(nr),
      body: BANNER.otherSale(formatWarsawDateTime(DECIDED_AT), K, nr),
      cta: BANNER.ctaRegular,
      knownInvoice: null,
      sendRefusal: sendRefusal(nr, 'decided-other'),
      deletable: false,
      deleteRefusal: deleteRefusal(nr),
    });
  });

  it('U12c: zaliczka po automatycznym „numer zajęty” — baner bez usuwania, przycisk nowej faktury zaliczkowej', async () => {
    const nr = 'ZAL/2/10/2026';
    add(
      [retiredDraft(ZAL_RETIRED_ID, { internal_number: nr, invoice_kind: 'advance', invoice_type: 'ZAL' })],
      [numberTakenRow(TENANT, ZAL_RETIRED_ID, 'automatic', { original_ksef_number: K2 })],
    );

    const initial = await loadB(ZAL_RETIRED_ID);

    expect(initial.ksef_retired_draft).toMatchObject({
      title: BANNER.title(nr),
      body: BANNER.autoAdvance(nr, K2),
      cta: BANNER.ctaAdvance,
      knownInvoice: null,
      sendRefusal: sendRefusal(nr, 'automatic', K2),
      deletable: false,
      deleteRefusal: deleteRefusal(nr, K2),
    });
  });

  it.each([
    ['test', false],
    ['production', true],
  ] as const)('U12c: korekta po automatycznym „numer zajęty” (KSEF_ENV=%s) — baner usuwalny, bez przycisku; blokada KOR wg środowiska', async (env, held) => {
    vi.stubEnv('KSEF_ENV', env);
    const nr = 'FK/2/10/2026';
    add(
      [{ ...korRow(KOR_RETIRED_ID, korSpecialData), internal_number: nr, ksef_status: 'draft', last_error: null, last_error_code: null }],
      [numberTakenRow(TENANT, KOR_RETIRED_ID, 'automatic')],
    );

    const initial = await loadB(KOR_RETIRED_ID);

    expect(initial.ksef_resend_facts.kindHeld).toBe(held);
    expect(initial.ksef_retired_draft).toMatchObject({
      title: BANNER.title(nr),
      body: held ? BANNER.autoDeletableHeld(nr, K, 'korekty', 'korektę') : BANNER.autoDeletable(nr, K, 'korekty', 'korektę'),
      cta: null,
      knownInvoice: null,
      sendRefusal: sendRefusal(nr, 'automatic'),
      deletable: true,
      deleteRefusal: null,
    });
  });

  it('U12c: zwykły szkic bez wpisu number_taken i faktura failed — `ksef_retired_draft: null`', async () => {
    add([retiredDraft(PLAIN_DRAFT_ID, { internal_number: 'FV/4/10/2026' })], [numberTakenRow(TENANT, PLAIN_DRAFT_ID, 'automatic', { status: 'abandoned' })]);

    expect((await loadB(PLAIN_DRAFT_ID)).ksef_retired_draft).toBeNull();
    expect((await loadB(REGULAR_ID)).ksef_retired_draft).toBeNull();
  });

  it('U12d strażnik: bez surowego original_check w `initial`; fakturę strona czyta raz, każdą kolumnę raz', async () => {
    add([duplicateRow()], [markerRow(TENANT, DUP_ID)]);

    const initial = await loadB(DUP_ID);

    const json = JSON.stringify(initial);
    expect(json).not.toContain('original_check');
    expect(json).not.toContain('ksef-import');
    expect(json).not.toContain('"summary"');
    const reads = st.db!.reads.filter((r) => r.table === 'invoices' && r.filters.id === DUP_ID);
    expect(reads, 'strona czyta fakturę raz — loader dostaje jej wiersz').toHaveLength(1);
    const columns = selectedColumns(reads[0]!.columns);
    expect(new Set(columns).size, `zdublowana kolumna w: ${reads[0]!.columns}`).toBe(columns.length);
    for (const key of KSEF_RESEND_SOURCE_COLUMN_KEYS) {
      expect(columns.filter((c) => c === key), `kolumna ${key}`).toHaveLength(1);
    }
  });
});

/**
 * „Zapłacone” (00158, FaktWay 1.0 §3 pkt 3): panel płatności liczy serwer, RPC
 * i tak sprawdza wszystko jeszcze raz. Treść dokumentu nie wychodzi: z `fa3_data`
 * idzie tylko data zapłaty.
 */
describe('„Zapłacone”: panel płatności liczony na serwerze', () => {
  const ID = '33333333-3333-4333-8333-333333333361';
  const KOR = '33333333-3333-4333-8333-333333333362';
  const PANEL_TODAY = { today: TODAY };

  function faktura(patch: Row = {}): Row {
    return invoiceRow(ID, {
      ksef_status: 'accepted',
      ksef_number: '1234567890-20261002-0100A0B0C0D0-1A',
      ksef_accepted_at: '2026-10-02T09:00:00Z',
      last_error: null,
      last_error_code: null,
      ksef_environment: 'test',
      currency: 'PLN',
      origin: 'app',
      paid_amount: 0,
      paid_at: null,
      payment_status: 'unpaid',
      ...patch,
    });
  }
  const put = (...rows: Row[]) => st.db!.tables.invoices!.push(...rows);
  const panel = async () => (await loadInitial(ID)).payment_panel;

  it('otwarta faktura: przycisk i dziś w Warszawie jako granica daty', async () => {
    put(faktura());
    expect(await panel()).toEqual({ canMark: true, canUndo: false, paidOn: null, paidOnFromDocument: false, ...PANEL_TODAY });
    expect(st.rpcCalls).toEqual([]);
  });

  it('import z pliku i historia KSeF też mają przycisk', async () => {
    put(faktura({ origin: 'file_import' }));
    expect((await panel())?.canMark).toBe(true);
  });

  it('zapłacona ręcznie: „Cofnij zapłatę” i dzień z wpłaty', async () => {
    put(faktura({ payment_status: 'paid', paid_amount: 123, paid_at: '2026-09-20T10:00:00Z' }));
    st.manualPayment = { data: { amount: 123, paid_on: '2026-09-20' }, error: null };
    expect(await panel()).toEqual({ canMark: false, canUndo: true, paidOn: '2026-09-20', paidOnFromDocument: false, ...PANEL_TODAY });
    expect(st.rpcCalls).toEqual([{ fn: 'invoice_manual_payment', args: { p_invoice_id: ID } }]);
  });

  it('zapłacona z banku albo FLO: bez cofnięcia, dzień z `paid_at` w Warszawie', async () => {
    put(faktura({ payment_status: 'paid', paid_amount: 123, paid_at: '2026-09-19T22:30:00Z' }));
    expect(await panel()).toEqual({ canMark: false, canUndo: false, paidOn: '2026-09-20', paidOnFromDocument: false, ...PANEL_TODAY });
  });

  it('błąd odczytu wpłaty ręcznej: bez cofnięcia, podgląd działa', async () => {
    put(faktura({ payment_status: 'paid', paid_amount: 123, paid_at: '2026-09-20T10:00:00Z' }));
    st.manualPayment = { data: null, error: { message: 'boom' } };
    expect(await panel()).toMatchObject({ canUndo: false, paidOn: '2026-09-20' });
  });

  it('data zapłaty z FA(3): zapłacona, mówi skąd data, a reszta `fa3_data` zostaje na serwerze', async () => {
    put(faktura({ origin: 'ksef_import', fa3_data: { parsed: { paidDate: '2026-09-01', sekret: 'tresc' } } }));
    const initial = await loadInitial(ID);
    expect(initial.payment_panel).toEqual({ canMark: false, canUndo: false, paidOn: '2026-09-01', paidOnFromDocument: true, ...PANEL_TODAY });
    expect(JSON.stringify(initial)).not.toContain('tresc');
  });

  it('księgowa: zapłaconą widzi, ale nie cofa; otwartej nie oznacza; RPC nie jest wołane', async () => {
    st.db!.tables.memberships![0]!.role = 'accountant';
    put(faktura({ payment_status: 'paid', paid_amount: 123, paid_at: '2026-09-20T10:00:00Z' }));
    expect(await panel()).toEqual({ canMark: false, canUndo: false, paidOn: '2026-09-20', paidOnFromDocument: false, ...PANEL_TODAY });
    expect(st.rpcCalls).toEqual([]);

    st.db!.tables.invoices!.length = 0;
    put(faktura());
    expect(await panel()).toEqual({ canMark: false, canUndo: false, paidOn: null, paidOnFromDocument: false, ...PANEL_TODAY });
  });

  it('korekta do zera zdejmuje przycisk, korekta częściowa nie', async () => {
    const korekta = (gross: number): Row => ({
      id: KOR, tenant_id: TENANT, parent_invoice_id: ID, invoice_kind: 'correction', ksef_status: 'accepted', gross_total: gross,
    });
    put(faktura(), korekta(-123));
    expect((await panel())?.canMark).toBe(false);

    st.db!.tables.invoices!.length = 0;
    put(faktura(), korekta(-23));
    expect((await panel())?.canMark).toBe(true);
  });

  it.each([
    ['szkic', { ksef_status: 'draft', ksef_number: null }],
    ['błąd wysyłki', { ksef_status: 'failed' }],
    ['zakup', { direction: 'incoming' }],
    ['inne środowisko', { ksef_environment: 'demo' }],
  ] as const)('%s: panelu nie ma', async (_label, patch) => {
    put(faktura(patch));
    expect(await panel()).toBeNull();
  });

  it('KSEF_ENV niepoprawne: panelu nie ma', async () => {
    vi.stubEnv('KSEF_ENV', 'bogus');
    put(faktura());
    expect(await panel()).toBeNull();
  });
});

/**
 * E3 / P4 (PLAN-FINORA §5): podgląd faktury w układzie Finory dostaje od serwera
 * TYLKO pochodne, bezpieczne pola: walutę, kwoty netto i VAT pozycji, MPP
 * (boolean z `fa3_data.annotations`), „Do zapłaty”, możliwość korekty i dane
 * kodu QR (KOD I). Treść dokumentu (`fa3_data`) nadal zostaje na serwerze.
 *
 * Do E3 `initial` nie miał waluty (widok na sztywno pisał „PLN”), kwot per
 * stawka ani linku „Korekta”, a skrót XML czytał tylko generator PDF kluczem
 * admina.
 */
describe('E3 P4: pola podglądu faktury liczone na serwerze', () => {
  const ACC_ID = '33333333-3333-4333-8333-333333333351';
  const ROZ_ID = '33333333-3333-4333-8333-333333333352';
  const CHILD_ID = '33333333-3333-4333-8333-333333333353';
  const XML_PATH = `${TENANT}/xml/FV-1.xml`;
  const SHA = 'ab'.repeat(32);
  const KSEF_NR = '1234567890-20261002-0100A0B0C0D0-1A';

  const lineRows = [
    { ordinal: 2, name: 'B', unit: 'szt.', quantity: 1, unit_price_net: 50, vat_rate: '8', net_amount: 50, vat_amount: 4, gross_amount: 54 },
    { ordinal: 1, name: 'A', unit: 'szt.', quantity: 1, unit_price_net: 100, vat_rate: '23', net_amount: 100, vat_amount: 23, gross_amount: 123 },
  ];

  function accepted(patch: Row = {}): Row {
    return invoiceRow(ACC_ID, {
      internal_number: 'FV/1/10/2026',
      ksef_status: 'accepted',
      ksef_number: KSEF_NR,
      ksef_accepted_at: '2026-10-02T09:00:00Z',
      last_error: null,
      last_error_code: null,
      ksef_environment: 'test',
      currency: 'EUR',
      paid_amount: 0,
      xml_storage_path: XML_PATH,
      net_total: 150,
      vat_total: 27,
      gross_total: 177,
      invoice_line_items: lineRows,
      ...patch,
    });
  }

  function put(row: Row, extra: Row[] = []) {
    st.db!.tables.invoices!.push(row, ...extra);
  }
  const putXml = () => st.db!.tables.xml_documents!.push({ storage_path: XML_PATH, tenant_id: TENANT, invoice_id: ACC_ID, sha256_hash: SHA });

  it('waluta i kwoty netto/VAT pozycji; pozycje posortowane po `ordinal`', async () => {
    put(accepted());
    const initial = await loadInitial(ACC_ID);
    expect(initial.currency).toBe('EUR');
    expect(initial.lines.map((l) => [l.ordinal, l.net_amount, l.vat_amount, l.gross_amount])).toEqual([
      [1, 100, 23, 123],
      [2, 50, 4, 54],
    ]);
  });

  it('brak waluty w wierszu = PLN (jak widok `invoices_overdue`)', async () => {
    put(accepted({ currency: null }));
    expect((await loadInitial(ACC_ID)).currency).toBe('PLN');
  });

  it('MPP: `split_payment` z fa3_data.annotations.splitPayment, a sama treść dokumentu nie wychodzi', async () => {
    put(accepted({
      fa3_data: { internalNumber: 'FV/1/10/2026', annotations: { splitPayment: 1, cashMethod: 2 }, lines: [] },
    }));
    const initial = await loadInitial(ACC_ID);
    expect(initial.split_payment).toBe(true);
    expect(initial).not.toHaveProperty('fa3_data');
    expect(JSON.stringify(initial)).not.toContain('annotations');
    expect(JSON.stringify(initial)).not.toContain('cashMethod');

    st.db!.tables.invoices!.length = 0;
    put(accepted({ fa3_data: { annotations: { splitPayment: 2 }, lines: [] } }));
    expect((await loadInitial(ACC_ID)).split_payment).toBe(false);
    st.db!.tables.invoices!.length = 0;
    put(accepted({ fa3_data: null }));
    expect((await loadInitial(ACC_ID)).split_payment).toBe(false);
  });

  it('„Do zapłaty” przez `amountDueOf`: zwykła faktura = brutto, ROZ = reszta po zaliczkach z payment_data', async () => {
    put(accepted(), [accepted({
      id: ROZ_ID,
      internal_number: 'ROZ/1/10/2026',
      invoice_type: 'ROZ',
      invoice_kind: 'final',
      gross_total: 4000,
      payment_data: { method: 'transfer', dueDate: '2026-10-16', currency: 'PLN', amountDue: 1000 },
    })]);
    expect((await loadInitial(ACC_ID)).amount_due).toBe(177);
    expect((await loadInitial(ROZ_ID)).amount_due).toBe(1000);
  });

  it('korekta: przyjęta zwykła faktura bez korekty w toku → `can_correct`; ten sam predykat co lista (P3)', async () => {
    put(accepted());
    expect((await loadInitial(ACC_ID)).can_correct).toBe(true);
  });

  it.each([
    ['szkic', { ksef_status: 'draft', ksef_number: null }],
    ['zaliczka', { invoice_kind: 'advance', invoice_type: 'ZAL' }],
    ['inne środowisko', { ksef_environment: 'demo' }],
    ['bez numeru KSeF', { ksef_number: null }],
    ['przychodząca', { direction: 'incoming' }],
  ] as const)('korekta niedostępna: %s', async (_label, patch) => {
    put(accepted(patch));
    expect((await loadInitial(ACC_ID)).can_correct).toBe(false);
  });

  it('korekta niedostępna, gdy KSEF_ENV niepoprawne (środowisko nieznane)', async () => {
    vi.stubEnv('KSEF_ENV', 'bogus');
    put(accepted());
    expect((await loadInitial(ACC_ID)).can_correct).toBe(false);
  });

  it.each([
    ['szkic', 'draft', false],
    ['w kolejce', 'queued', false],
    ['z błędem', 'failed', false],
    ['przyjęta', 'accepted', true],
    ['odrzucona', 'rejected', true],
  ] as const)('K4: korekta w toku (%s) blokuje „Korekta” tylko, gdy nie jest rozstrzygnięta', async (_label, status, canCorrect) => {
    put(accepted(), [{ id: CHILD_ID, tenant_id: TENANT, parent_invoice_id: ACC_ID, invoice_kind: 'correction', ksef_status: status }]);
    expect((await loadInitial(ACC_ID)).can_correct).toBe(canCorrect);
  });

  it('QR (KOD I): link z NIP sprzedawcy, daty wystawienia i skrótu XML czytanego sesją; podpis = numer KSeF', async () => {
    put(accepted());
    putXml();
    const initial = await loadInitial(ACC_ID);
    const hash = Buffer.from(SHA, 'hex').toString('base64url');
    expect(initial.qr).toEqual({
      url: `https://qr-test.ksef.mf.gov.pl/invoice/1234567890/02-10-2026/${hash}`,
      label: KSEF_NR,
    });
    const read = st.db!.reads.find((r) => r.table === 'xml_documents');
    expect(read, 'skrót XML trzeba przeczytać z xml_documents').toBeDefined();
    expect(read!.filters).toEqual({ storage_path: XML_PATH, tenant_id: TENANT, invoice_id: ACC_ID });
  });

  it('QR: brak pliku XML (import, skrzynka), brak numeru KSeF albo cudza ścieżka → `qr: null`, bez błędu', async () => {
    put(accepted());
    expect((await loadInitial(ACC_ID)).qr).toBeNull();

    putXml();
    st.db!.tables.invoices!.length = 0;
    put(accepted({ ksef_number: null, ksef_status: 'queued' }));
    expect((await loadInitial(ACC_ID)).qr).toBeNull();

    st.db!.tables.invoices!.length = 0;
    put(accepted({ xml_storage_path: 'inna-firma/xml/FV-1.xml' }));
    expect((await loadInitial(ACC_ID)).qr).toBeNull();
  });

  it('QR: skrót nie jest sha256 (uszkodzony wiersz) → `qr: null`, nie link donikąd', async () => {
    put(accepted());
    st.db!.tables.xml_documents!.push({ storage_path: XML_PATH, tenant_id: TENANT, invoice_id: ACC_ID, sha256_hash: 'zły' });
    expect((await loadInitial(ACC_ID)).qr).toBeNull();
  });

  it('strażnik: nowe pola nie wynoszą treści dokumentu ani skrótu XML; faktura czytana raz, każda kolumna raz', async () => {
    put(accepted({ fa3_data: { annotations: { splitPayment: 1 }, advanceEnvelope: {} }, special_data: { correctionData: {} } }));
    putXml();
    const initial = await loadInitial(ACC_ID);
    const json = JSON.stringify(initial);
    for (const forbidden of ['fa3_data', 'special_data', 'advanceEnvelope', 'correctionData', SHA]) {
      expect(json, forbidden).not.toContain(forbidden);
    }
    const reads = st.db!.reads.filter((r) => r.table === 'invoices' && r.filters.id === ACC_ID);
    expect(reads).toHaveLength(1);
    const columns = selectedColumns(reads[0]!.columns);
    expect(new Set(columns).size, `zdublowana kolumna w: ${reads[0]!.columns}`).toBe(columns.length);
    expect(columns).toEqual(expect.arrayContaining(['currency', 'ksef_environment']));
    expect(reads[0]!.columns).toMatch(/invoice_line_items\([^)]*net_amount[^)]*vat_amount/);
    expect(st.notCalls).toEqual([]);
  });
});
