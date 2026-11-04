import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-001 / F-042 (audyt bloku 1): szkic faktury był ślepą uliczką — nie dało
 * się go wysłać do KSeF ani usunąć, a jego numer zostawał zajęty. Szkic
 * zapisywał się też bez walidacji serwerowej.
 */

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  invoices: [] as Row[],
  tenants: [] as Row[],
  ksef_submissions: [] as Row[],
  /** Tabela, której odczyt (select) kończy się błędem bazy. */
  failRead: null as string | null,
  /** Błąd DELETE (np. P0001 z wyzwalacza 00148 w wyścigu). */
  failDelete: null as { code: string; message: string } | null,
}));
const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  audit: vi.fn(),
  auth: vi.fn(),
}));

/**
 * Minimalny klient: select/update/delete z filtrami `eq` na tabeli w pamięci.
 * `db.failRead` — odczyt tej tabeli zwraca błąd bazy; `db.failDelete` — DELETE
 * zwraca podany błąd (D-A4-1b-3 PR B: odczyt historii wysyłki przed wysyłką
 * i usunięciem szkicu, odmowa wyzwalacza 00148).
 */
function fakeSupabase() {
  return {
    from(table: 'invoices' | 'tenants' | 'ksef_submissions') {
      const filters: Array<[string, unknown]> = [];
      let op: 'select' | 'update' | 'delete' = 'select';
      let patch: Row = {};
      const matches = (r: Row) => filters.every(([k, v]) => r[k] === v);
      const run = (): { data: Row[] | null; error: { code?: string; message: string } | null } => {
        const rows = db[table];
        if (op === 'update') {
          const hit = rows.filter(matches);
          hit.forEach((r) => Object.assign(r, patch));
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        if (op === 'delete') {
          if (db.failDelete) return { data: null, error: db.failDelete };
          const hit = rows.filter(matches);
          db[table] = rows.filter((r) => !matches(r));
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        if (db.failRead === table) return { data: null, error: { message: `odczyt ${table} nieudany` } };
        return { data: rows.filter(matches).map((r) => ({ ...r })), error: null };
      };
      const q = {
        select: () => q,
        update: (p: Row) => { op = 'update'; patch = p; return q; },
        delete: () => { op = 'delete'; return q; },
        eq: (k: string, v: unknown) => { filters.push([k, v]); return q; },
        maybeSingle: async () => {
          const { data, error } = run();
          return { data: error ? null : (data?.[0] ?? null), error };
        },
        then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(ok, fail),
      };
      return q;
    },
  };
}

vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return { ActionAuthError, requireUserAndActiveOrg: mocks.auth };
});
vi.mock('@/lib/invoices/ksef-submit-enqueue', () => ({ enqueueKsefSubmitAfterDraft: mocks.enqueue }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { deleteDraftInvoiceAction, sendDraftInvoiceAction } from '@/components/invoices/draft-actions';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';

import { CLIENT, K, K2, deleteRefusal, numberTakenRow, sendRefusal, type RetiredRowShape } from './helpers/decyzja-klienta';

const TENANT = 'ten-1';
const TODAY = '2026-10-02';

function snapshot(o: { issueDate?: string; bankAccount?: string } = {}) {
  return finalizeInvoice({
    internalNumber: 'FV 5/10/2026',
    type: 'VAT',
    issueDate: o.issueDate ?? TODAY,
    saleDate: o.issueDate ?? TODAY,
    seller: { nip: '5260001246', name: 'Moja Firma', address: { countryCode: 'PL', addressLine1: 'ul. A 1', addressLine2: '00-001 Warszawa' } },
    buyer: { nip: '5252241585', name: 'Klient', address: { countryCode: 'PL', addressLine1: 'ul. B 2', addressLine2: '00-002 Warszawa' } },
    lines: [{ ordinal: 1, name: 'Usługa', unit: 'szt', quantity: 1, unitPriceNet: 100, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-10-16', method: 'transfer', bankAccount: o.bankAccount ?? 'PL61109010140000071219812874' },
  });
}

function draft(o: Row = {}): Row {
  return {
    id: 'inv-1',
    tenant_id: TENANT,
    ksef_status: 'draft',
    direction: 'outgoing',
    invoice_kind: 'regular',
    invoice_type: 'VAT',
    internal_number: 'FV 5/10/2026',
    fa3_data: snapshot(),
    ...o,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T10:00:00Z`));
  db.invoices = [draft()];
  db.tenants = [{ id: TENANT, nip: '5260001246' }];
  db.ksef_submissions = [];
  db.failRead = null;
  db.failDelete = null;
  mocks.auth.mockResolvedValue({ supabase: fakeSupabase(), user: { id: 'user-1' }, tenantId: TENANT, role: 'owner' });
  mocks.enqueue.mockResolvedValue({ ok: true, mode: 'online_queued' });
});

describe('wysyłka szkicu do KSeF (F-001)', () => {
  it('poprawny szkic trafia do kolejki z danymi ze snapshotu i NIP-em firmy', async () => {
    const r = await sendDraftInvoiceAction('inv-1');
    expect(r).toEqual({ success: true, offline: false });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0]![0]).toMatchObject({
      tenantId: TENANT,
      invoiceId: 'inv-1',
      nip: '5260001246',
      auditKind: 'regular',
      invoice: expect.objectContaining({ internalNumber: 'FV 5/10/2026' }),
    });
    // Status przestawia RPC `enqueue_ksef_send` w transakcji ze zleceniem
    // (tu zamockowane) — akcja nie pisze `ksef_status` z sesji klienta (PR 3, W2).
    expect(db.invoices[0]!.ksef_status).toBe('draft');
  });

  it('drugie kliknięcie: odmowę daje RPC (warunek draft), nie zapis z sesji', async () => {
    mocks.enqueue
      .mockResolvedValueOnce({ ok: true, mode: 'online_queued' })
      .mockResolvedValueOnce({ ok: false, error: 'Ta faktura jest już wysyłana albo nie jest szkicem.' });
    await sendDraftInvoiceAction('inv-1');
    const drugi = await sendDraftInvoiceAction('inv-1');
    expect(drugi).toEqual({ success: false, error: 'Ta faktura jest już wysyłana albo nie jest szkicem.' });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(db.invoices[0]!.ksef_status).toBe('draft');
  });

  it('gdy kolejka odmówi (np. brak certyfikatu), faktura wraca do szkicu', async () => {
    mocks.enqueue.mockResolvedValue({ ok: false, error: 'Najpierw wgraj certyfikat KSeF' });
    const r = await sendDraftInvoiceAction('inv-1');
    expect(r).toEqual({ success: false, error: 'Najpierw wgraj certyfikat KSeF' });
    expect(db.invoices[0]!.ksef_status).toBe('draft');
  });

  it('szkic z błędem walidacji nie trafia do kolejki', async () => {
    db.invoices = [draft({ fa3_data: snapshot({ bankAccount: 'PL00 1234' }) })];
    const r = await sendDraftInvoiceAction('inv-1');
    expect(r.success).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(db.invoices[0]!.ksef_status).toBe('draft');
  });

  it('szkic z datą wystawienia inną niż dziś trzeba wystawić od nowa', async () => {
    db.invoices = [draft({ fa3_data: snapshot({ issueDate: '2026-10-01' }) })];
    const r = await sendDraftInvoiceAction('inv-1');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toContain('2026-10-01');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['faktura już wysłana', { ksef_status: 'accepted' }],
    ['korekta', { invoice_kind: 'correction', invoice_type: 'KOR' }],
    ['faktura kosztowa', { direction: 'incoming' }],
  ])('%s — odmowa bez kolejki', async (_label, o) => {
    db.invoices = [draft(o)];
    const r = await sendDraftInvoiceAction('inv-1');
    expect(r.success).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('szkic innej organizacji — odmowa', async () => {
    db.invoices = [draft({ tenant_id: 'ten-2' })];
    const r = await sendDraftInvoiceAction('inv-1');
    expect(r.success).toBe(false);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe('usunięcie szkicu (F-001)', () => {
  it('usuwa szkic i zapisuje audyt', async () => {
    const r = await deleteDraftInvoiceAction('inv-1');
    expect(r).toEqual({ success: true });
    expect(db.invoices).toHaveLength(0);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.draft_deleted', entityId: 'inv-1' }));
  });

  it.each([['accepted'], ['queued'], ['rejected']])('faktura w stanie %s zostaje', async (status) => {
    db.invoices = [draft({ ksef_status: status })];
    const r = await deleteDraftInvoiceAction('inv-1');
    expect(r.success).toBe(false);
    expect(db.invoices).toHaveLength(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('szkic innej organizacji zostaje', async () => {
    db.invoices = [draft({ tenant_id: 'ten-2' })];
    const r = await deleteDraftInvoiceAction('inv-1');
    expect(r.success).toBe(false);
    expect(db.invoices).toHaveLength(1);
  });
});

/**
 * D-A4-1b-3 PR B (decyzje Bartosza 07.10.2026: 2, 3, 9): szkic z wpisem
 * `number_taken` w historii wysyłki — po decyzji klienta albo po automatycznym
 * werdykcie „numer zajęty” i „Wróć do szkicu” — jest WYCOFANY: nie wysyła się
 * (każdy rodzaj; ponowna wysyłka = ponowne 440), a zwykła faktura i zaliczka
 * nie usuwają się (numer zostałby podpowiedziany ponownie, a ślad decyzji
 * zniknąłby kaskadą). Korekta i ROZ zostają usuwalne — to ich wyjście (00133/
 * 00135, 00125). Akcje sprawdzają historię sesją klienta przed kolejką
 * i przed DELETE; wyzwalacze 00148 trzymają to samo w bazie.
 *
 * Do PR B obie akcje w ogóle nie czytały `ksef_submissions`.
 */
describe('D-A4-1b-3 PR B: wysyłka szkicu wycofanego (wpis number_taken)', () => {
  const NR = 'FV 5/10/2026';
  const retire = (...shapes: RetiredRowShape[]) => {
    db.ksef_submissions = shapes.map((shape) => numberTakenRow(TENANT, 'inv-1', shape));
  };

  it.each([
    ['decyzja klienta „inna sprzedaż”', 'decided-other'],
    ['decyzja klienta „ta sama sprzedaż”', 'decided-same'],
    ['automatyczny werdykt KSEF_NUMBER_TAKEN', 'automatic'],
  ] as const)('U4a: zwykły szkic, %s — odmowa tekstem wyzwalacza 00148, bez kolejki', async (_label, shape) => {
    retire(shape);

    const r = await sendDraftInvoiceAction('inv-1');

    expect(r).toEqual({ success: false, error: sendRefusal(NR, shape) });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(db.invoices[0]!.ksef_status).toBe('draft');
  });

  it('U4a: tylko wpisy bez numeru KSeF oryginału — „inną fakturę Twojej firmy”', async () => {
    retire('unmarked');

    const r = await sendDraftInvoiceAction('inv-1');

    expect(r).toEqual({ success: false, error: sendRefusal(NR, 'unmarked', null) });
    if (!r.success) expect(r.error).toContain('przez inną fakturę Twojej firmy wystawioną poza FaktWay');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('U4a: wybór wpisu jak w wyzwalaczu — decyzja przed automatem, wpis z numerem KSeF przed nowszym bez znacznika', async () => {
    db.ksef_submissions = [
      numberTakenRow(TENANT, 'inv-1', 'automatic', { original_ksef_number: K2, completed_at: '2026-10-02T09:30:00.000Z' }),
      numberTakenRow(TENANT, 'inv-1', 'decided-other'),
    ];
    const decided = await sendDraftInvoiceAction('inv-1');
    expect(decided).toEqual({ success: false, error: sendRefusal(NR, 'decided-other', K) });

    retire('automatic', 'unmarked');
    const automatic = await sendDraftInvoiceAction('inv-1');
    expect(automatic).toEqual({ success: false, error: sendRefusal(NR, 'automatic', K) });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['zaliczka (ZAL)', { invoice_kind: 'advance', invoice_type: 'ZAL' }],
    ['korekta (KOR)', { invoice_kind: 'correction', invoice_type: 'KOR' }],
  ])('U4b: wycofany szkic — %s: tekst „numer zajęty”, nie tekst rodzaju', async (_label, kind) => {
    db.invoices = [draft(kind)];
    retire('automatic');

    const r = await sendDraftInvoiceAction('inv-1');

    expect(r).toEqual({ success: false, error: sendRefusal(NR, 'automatic') });
    if (!r.success) expect(r.error).not.toContain('Ze szkicu można wysłać tylko zwykłą fakturę VAT');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('U4c: wycofany szkic z datą wystawienia sprzed dzisiaj — tekst „numer zajęty”, nie tekst daty (A1)', async () => {
    db.invoices = [draft({ fa3_data: snapshot({ issueDate: '2026-10-01' }) })];
    retire('decided-other');

    const r = await sendDraftInvoiceAction('inv-1');

    expect(r).toEqual({ success: false, error: sendRefusal(NR, 'decided-other') });
    if (!r.success) expect(r.error).not.toContain('2026-10-01');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('U4d: błąd odczytu historii wysyłki — HISTORY_READ_FAILED (fail-closed), bez kolejki', async () => {
    db.failRead = 'ksef_submissions';

    const r = await sendDraftInvoiceAction('inv-1');

    expect(r).toEqual({ success: false, error: CLIENT.historyReadFailed });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('U4h strażnik: zwykły szkic bez number_taken (inne statusy, wpis innej faktury) trafia do kolejki', async () => {
    db.ksef_submissions = [
      numberTakenRow(TENANT, 'inv-2', 'automatic'),
      numberTakenRow(TENANT, 'inv-1', 'automatic', { status: 'abandoned' }),
      numberTakenRow(TENANT, 'inv-1', 'automatic', { id: 'sub-rejected', status: 'rejected' }),
    ];

    const r = await sendDraftInvoiceAction('inv-1');

    expect(r).toEqual({ success: true, offline: false });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('D-A4-1b-3 PR B: usunięcie szkicu wycofanego (decyzja 9: zwykła i ZAL zostają, KOR i ROZ usuwalne)', () => {
  const NR = 'FV 5/10/2026';

  it.each([
    ['zwykły szkic, decyzja klienta', {}, 'decided-other'],
    ['zwykły szkic, automatyczny werdykt', {}, 'automatic'],
    ['zaliczka (ZAL), automatyczny werdykt', { invoice_kind: 'advance', invoice_type: 'ZAL' }, 'automatic'],
  ] as const)('U4e: %s — odmowa tekstem wyzwalacza, szkic i jego historia zostają, bez audytu', async (_label, kind, shape) => {
    db.invoices = [draft(kind)];
    db.ksef_submissions = [numberTakenRow(TENANT, 'inv-1', shape)];

    const r = await deleteDraftInvoiceAction('inv-1');

    expect(r).toEqual({ success: false, error: deleteRefusal(NR) });
    expect(db.invoices).toHaveLength(1);
    expect(db.ksef_submissions).toHaveLength(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('U4e: zwykły szkic tylko z wpisami bez numeru KSeF oryginału — „inna faktura Twojej firmy”', async () => {
    db.ksef_submissions = [numberTakenRow(TENANT, 'inv-1', 'unmarked')];

    const r = await deleteDraftInvoiceAction('inv-1');

    expect(r).toEqual({ success: false, error: deleteRefusal(NR, null) });
    expect(db.invoices).toHaveLength(1);
  });

  it('U4f: błąd odczytu historii wysyłki przed DELETE — HISTORY_READ_FAILED, szkic zostaje', async () => {
    db.failRead = 'ksef_submissions';

    const r = await deleteDraftInvoiceAction('inv-1');

    expect(r).toEqual({ success: false, error: CLIENT.historyReadFailed });
    expect(db.invoices).toHaveLength(1);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('U4g: DELETE odrzucony przez wyzwalacz (P0001, wyścig) — komunikat bazy dla klienta', async () => {
    db.failDelete = { code: 'P0001', message: deleteRefusal(NR) };

    const r = await deleteDraftInvoiceAction('inv-1');

    expect(r).toEqual({ success: false, error: deleteRefusal(NR) });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('U4g strażnik: inny błąd DELETE — dotychczasowy ogólny tekst, bez szczegółów bazy', async () => {
    db.failDelete = { code: '57014', message: 'PRIVATE canceling statement' };

    const r = await deleteDraftInvoiceAction('inv-1');

    expect(r).toEqual({ success: false, error: 'Nie udało się usunąć szkicu. Spróbuj ponownie.' });
  });

  it.each([
    ['korekta (KOR)', { invoice_kind: 'correction', invoice_type: 'KOR' }],
    ['faktura rozliczeniowa (ROZ)', { invoice_kind: 'final', invoice_type: 'ROZ' }],
  ])('U4h strażnik (decyzja 9): wycofany szkic — %s — usuwa się, z audytem', async (_label, kind) => {
    db.invoices = [draft(kind)];
    db.ksef_submissions = [numberTakenRow(TENANT, 'inv-1', 'automatic')];

    const r = await deleteDraftInvoiceAction('inv-1');

    expect(r).toEqual({ success: true });
    expect(db.invoices).toHaveLength(0);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.draft_deleted', entityId: 'inv-1' }));
  });

  it('U4h strażnik: zwykły szkic z wpisem number_taken INNEJ faktury — usuwa się', async () => {
    db.ksef_submissions = [numberTakenRow(TENANT, 'inv-2', 'automatic')];

    const r = await deleteDraftInvoiceAction('inv-1');

    expect(r).toEqual({ success: true });
    expect(db.invoices).toHaveLength(0);
  });
});
