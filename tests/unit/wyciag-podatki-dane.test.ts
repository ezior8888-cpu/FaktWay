import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Dane sekcji „Zapłaty do ZUS i urzędu skarbowego” (krok 3.2, część 2):
 * prawdziwe `czytajPrzelewyPodatkowe`, wyłącznik modułu i propozycje; atrapy
 * tylko dla bazy (RPC `bank_tax_operations`, flaga firmy, `tax_settlements`)
 * i globalnej flagi. Dopisane po kodzie.
 */

const m = vi.hoisted(() => ({ globalStop: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/feature-flags/global-flags', () => ({ getGlobalFlag: m.globalStop }));

const { czytajPrzelewyPodatkowe } = await import('@/lib/import/bank/podatki-dane');

const TENANT = '22222222-2222-4222-8222-222222222222';
const OP_ZUS = '66666666-6666-4666-8666-666666666661';
const OP_DONE = '66666666-6666-4666-8666-666666666663';
const SP = '77777777-7777-4777-8777-777777777771';
const ZD = '77777777-7777-4777-8777-777777777772';
const RY_08 = '77777777-7777-4777-8777-777777777774';

const db = {
  flaga: true,
  bladRozliczen: false,
  rozliczenia: [
    { id: SP, okres: '2026-09-01', rodzaj: 'zus_spoleczne', wersja: 1, kwota_gr: 150000, status: 'zatwierdzone', zaplacone_o: null },
    { id: ZD, okres: '2026-09-01', rodzaj: 'zdrowotna', wersja: 1, kwota_gr: '50000', status: 'zatwierdzone', zaplacone_o: null },
    { id: RY_08, okres: '2026-08-01', rodzaj: 'ryczalt', wersja: 1, kwota_gr: 110000, status: 'zaplacone', zaplacone_o: '2026-09-18' },
  ],
};

function from(table: string) {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order']) chain[method] = () => chain;
  chain.maybeSingle = async () => {
    if (table !== 'tenant_feature_flags') throw new Error(table);
    return { data: { ksiegowosc_enabled: db.flaga }, error: null };
  };
  chain.range = async () => {
    if (table !== 'tax_settlements') throw new Error(table);
    if (db.bladRozliczen) return { data: null, count: null, error: { code: 'XX000', message: 'awaria' } };
    return { data: db.rozliczenia, count: db.rozliczenia.length, error: null };
  };
  return chain;
}

const client = { from, rpc: m.rpc } as never;

const RPC = {
  pending: [
    { id: OP_ZUS, tax_kind: 'zus', account: 'PL61109010140000071219812874', booking_date: '2026-10-15', amount: -2000, counterparty_name: 'ZUS', counterparty_account: null, title: null },
  ],
  pending_total: 1,
  decided: [
    { id: OP_DONE, tax_kind: 'us', booking_date: '2026-09-18', amount: '-1100.00', state: 'confirmed', decided_at: '2026-09-19T08:00:00Z', settlement_ids: [RY_08], marked_ids: [RY_08], title: null },
  ],
  links: [{ id: OP_DONE, booking_date: '2026-09-18', settlement_ids: [RY_08] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(db, { flaga: true, bladRozliczen: false });
  m.globalStop.mockResolvedValue(false);
  m.rpc.mockResolvedValue({ data: RPC, error: null });
});

describe('czytajPrzelewyPodatkowe', () => {
  it('moduł wyłączony dla firmy albo globalnie: brak sekcji i propozycji, bez odczytu przelewów', async () => {
    db.flaga = false;
    expect(await czytajPrzelewyPodatkowe(client, TENANT)).toBeNull();
    db.flaga = true;
    m.globalStop.mockResolvedValue(true);
    expect(await czytajPrzelewyPodatkowe(client, TENANT)).toBeNull();
    expect(m.rpc).not.toHaveBeenCalled();
  });

  it('moduł włączony: propozycja zapłaty ZUS i opis ostatniej decyzji', async () => {
    const wynik = await czytajPrzelewyPodatkowe(client, TENANT);
    expect(m.rpc).toHaveBeenCalledWith('bank_tax_operations');
    expect(wynik).toMatchObject({ ok: true, pendingTotal: 1, bladRozliczen: false });
    if (!wynik?.ok) throw new Error('brak danych');
    expect(wynik.pending[0]?.propozycja?.przypisanie).toMatchObject({ sposob: 'kwota', opcja: { ids: [SP, ZD], wyliczoneGr: 200000 } });
    expect(wynik.pending[0]?.opis).toContain('Zapłata ZUS za wrzesień 2026');
    expect(wynik.decided[0]).toMatchObject({ id: OP_DONE, state: 'confirmed', zmienione: false });
    expect(wynik.decided[0]?.opis).toContain('Zapłata ryczałtu za sierpień 2026');
  });

  it('rozliczeń nie udało się wczytać: przelewy bez propozycji, z komunikatem', async () => {
    db.bladRozliczen = true;
    const wynik = await czytajPrzelewyPodatkowe(client, TENANT);
    expect(wynik).toMatchObject({ ok: true, bladRozliczen: true });
    if (!wynik?.ok) throw new Error('brak danych');
    expect(wynik.pending[0]).toMatchObject({ id: OP_ZUS, propozycja: null, opis: null });
  });

  it('błąd albo inny kształt RPC: komunikat zamiast pustej listy', async () => {
    m.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'brak funkcji' } });
    expect(await czytajPrzelewyPodatkowe(client, TENANT)).toEqual({ ok: false, error: expect.stringContaining('Nie udało się wczytać przelewów') });
    m.rpc.mockResolvedValue({ data: { ...RPC, pending: [{ ...RPC.pending[0], amount: 2000 }] }, error: null });
    expect(await czytajPrzelewyPodatkowe(client, TENANT)).toMatchObject({ ok: false });
  });
});
