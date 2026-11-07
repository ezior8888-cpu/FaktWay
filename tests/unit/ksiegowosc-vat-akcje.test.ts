import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { vatMiesiaca } from '@/lib/ksiegowosc/vat';

/**
 * Akcje ekranu VAT (plan księgowości JDG, K6). Atrapy dla uprawnień, bazy,
 * wyłącznika, odczytu miesiąca, magazynu, audytu, Sentry i samej wysyłki do
 * MF (klient MF ma własny test na atrapie bramki); plik JPK_V7M i jego XSD są
 * prawdziwe. RLS i przejścia stanów 00170 sprawdza
 * `tests/rls-ksiegowosc-jpk.test.ts` na prawdziwej bazie.
 */

const ID = '00170170-0000-4000-8000-000000000001';
const NUMER = 'b7a0810e02818670000000b92c9f5343';
const UPO = readFileSync(join(__dirname, '..', 'fixtures', 'ksiegowosc', 'upo-jpk-v7m-test-mf.xml'), 'utf8');

const mocks = vi.hoisted(() => ({
  requireOrgRole: vi.fn(),
  obszary: { vat: true, wysylka_jpk: true } as Record<string, boolean>,
  audit: vi.fn(),
  revalidate: vi.fn(),
  sentryWyjatek: vi.fn(),
  sentryKomunikat: vi.fn(),
  dane: null as unknown,
  wyslij: vi.fn(),
  status: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  kolejnosc: [] as string[],
  wstawione: [] as Record<string, unknown>[],
  bladWstawienia: null as { code?: string; message: string } | null,
  zmiany: [] as { zmiana: Record<string, unknown>; warunki: [string, unknown][] }[],
  zmienionych: 1,
  /** Zapis stanu po wysyłce do MF kończy się błędem bazy. */
  bladPoWysylce: false,
  wiersz: null as Record<string, unknown> | null,
}));

vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/audit/log', () => ({ logAudit: mocks.audit }));
vi.mock('@sentry/nextjs', () => ({ captureException: mocks.sentryWyjatek, captureMessage: mocks.sentryKomunikat }));
vi.mock('@/lib/format/warsaw-date', async (orig) => ({
  ...(await orig<typeof import('@/lib/format/warsaw-date')>()),
  todayInWarsaw: () => '2026-11-07',
}));
vi.mock('@/lib/supabase/auth-context', async (orig) => ({
  ...(await orig<typeof import('@/lib/supabase/auth-context')>()),
  requireOrgRole: mocks.requireOrgRole,
}));
vi.mock('@/lib/ksiegowosc/wylacznik', () => ({
  czyKsiegowoscWlaczona: async (_c: unknown, _t: string, obszar: string) => ({ wlaczony: mocks.obszary[obszar] === true }),
}));
vi.mock('@/lib/ksiegowosc/vat-dane', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/vat-dane')>()),
  czytajVat: async () => mocks.dane,
}));
vi.mock('@/lib/exports/tax-office', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/tax-office')>()),
  readTenantTaxOffice: async () => '1433',
}));
vi.mock('@/lib/storage/r2', () => ({ uploadToR2IfAbsent: mocks.upload, downloadFromR2: mocks.download }));
vi.mock('@/lib/ksiegowosc/wysylka-jpk/wyslij', () => ({
  wyslijJpk: (...a: unknown[]) => {
    mocks.kolejnosc.push('mf');
    return mocks.wyslij(...a);
  },
}));
vi.mock('@/lib/ksiegowosc/wysylka-jpk/klient', async (orig) => ({
  ...(await orig<typeof import('@/lib/ksiegowosc/wysylka-jpk/klient')>()),
  statusWysylki: mocks.status,
}));

/** Łańcuch PostgREST: filtry zapisują warunki, wynik na końcu. */
function lancuch(wynik: (warunki: [string, unknown][]) => unknown) {
  const warunki: [string, unknown][] = [];
  const l: Record<string, unknown> = {};
  for (const m of ['eq', 'in', 'lt', 'order', 'limit']) {
    l[m] = (k: string, v: unknown) => {
      warunki.push([k, v]);
      return l;
    };
  }
  l.select = () => l;
  l.single = async () => wynik(warunki);
  l.maybeSingle = async () => wynik(warunki);
  l.then = (ok: (v: unknown) => unknown, nie?: (e: unknown) => unknown) => Promise.resolve(wynik(warunki)).then(ok, nie);
  return l;
}

const supabase = {
  from: (tabela: string) => {
    if (tabela === 'tenants') return lancuch(() => ({ data: { nip: '1234567890', name: 'Jan Testowy' }, error: null }));
    if (tabela !== 'jpk_submissions') throw new Error(`nieoczekiwana tabela ${tabela}`);
    return {
      insert: (w: Record<string, unknown>) => {
        mocks.kolejnosc.push('insert');
        mocks.wstawione.push(w);
        return lancuch(() => (mocks.bladWstawienia ? { data: null, error: mocks.bladWstawienia } : { data: { id: ID }, error: null }));
      },
      update: (zmiana: Record<string, unknown>) =>
        lancuch((warunki) => {
          if (mocks.bladPoWysylce && mocks.kolejnosc.includes('mf')) return { data: null, error: { message: 'połączenie zerwane' } };
          mocks.zmiany.push({ zmiana, warunki });
          // Zamknięcie przerwanych (warunek `lt`) nie zmienia wiersza tej wysyłki.
          return { data: warunki.some(([k]) => k === 'utworzono_o') ? [] : Array(mocks.zmienionych).fill({ id: ID }), error: null };
        }),
      select: () => lancuch(() => ({ data: mocks.wiersz, error: null })),
    };
  },
};

const { pobierzJpkV7mAction, sprawdzStatusJpkAction, wyslijJpkV7mAction } = await import('@/app/actions/ksiegowosc-vat');
const { BladMf } = await import('@/lib/ksiegowosc/wysylka-jpk/klient');

const faktura = {
  invoiceNumber: 'FS/1/10',
  currency: 'PLN',
  invoiceType: 'regular',
  issueDate: '2026-10-05',
  buyerName: 'Klient',
  netTotal: 1000,
  vatTotal: 230,
  grossTotal: 1230,
  lines: [{ position: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 1000, netAmount: 1000, vatRate: '23' }],
} as JpkInvoice;

const OSOBA = { imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01', email: 'jan@example.test' };
const WEJSCIE = { miesiac: '2026-10', nadwyzka: 0, ...OSOBA, kwotaGr: 5_432_198 };
/** Wartości, których nie może być w bazie, audycie, Sentry ani logach. */
const TAJNE = ['5432198', '54321.98', 'Testowy', '1980-01-01'];

function wiersz(z: Record<string, unknown> = {}) {
  return {
    id: ID,
    okres: '2026-10-01',
    cel: 1,
    srodowisko: 'test',
    skrot_pliku: 'A'.repeat(43) + '=',
    deklaracja: { P_38: 230, P_39: 0, P_48: 0, P_51: 230, P_62: 0 },
    stan: 'w_toku',
    numer_referencyjny: NUMER,
    status_kod: null,
    status_opis: null,
    upo_sciezka: null,
    blad: null,
    utworzono_o: '2026-11-07T10:00:00Z',
    wyslano_o: '2026-11-07T10:00:05Z',
    zakonczono_o: null,
    ...z,
  };
}

let konsola: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  vi.stubEnv('JPK_MF_ENV', 'test');
  mocks.requireOrgRole.mockReset().mockResolvedValue({ supabase, user: { id: 'u-1', email: 'jan@example.test' }, tenantId: 'firma-1', role: 'owner' });
  mocks.obszary = { vat: true, wysylka_jpk: true };
  for (const f of [mocks.audit, mocks.revalidate, mocks.sentryWyjatek, mocks.sentryKomunikat, mocks.wyslij, mocks.status, mocks.upload, mocks.download]) f.mockReset();
  mocks.wyslij.mockResolvedValue({ numerReferencyjny: NUMER, skrotPliku: 'x', duplikat: false });
  mocks.upload.mockResolvedValue(true);
  mocks.dane = {
    ok: true,
    miesiac: '2026-10',
    dane: { issuer: { nip: '1234567890', name: 'Jan Testowy' }, issuedInvoices: [faktura], receivedInvoices: [], expenses: [] },
    nadwyzka: { zl: 0, zrodlo: 'klient' },
    wynik: vatMiesiaca({ sprzedaz: [faktura], koszty: [] }, 0),
    wysylki: [],
  };
  mocks.kolejnosc = [];
  mocks.wstawione = [];
  mocks.bladWstawienia = null;
  mocks.zmiany = [];
  mocks.zmienionych = 1;
  mocks.bladPoWysylce = false;
  mocks.wiersz = wiersz();
  konsola = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Wszystko, co wyszło poza wysyłkę do MF. */
function zapisane(): string {
  return JSON.stringify([
    mocks.wstawione,
    mocks.zmiany,
    mocks.audit.mock.calls,
    mocks.sentryWyjatek.mock.calls.map((c) => [String(c[0]), c[1]]),
    mocks.sentryKomunikat.mock.calls,
    konsola.map((s) => s.mock.calls),
  ]);
}

describe('wysyłka JPK_V7M do MF', () => {
  it('wiersz przed wysyłką, numer po FinishUpload; dane autoryzujące tylko w wysyłce, nigdzie więcej', async () => {
    const wynik = await wyslijJpkV7mAction(WEJSCIE);
    expect(wynik).toEqual({ success: true, numer: NUMER, duplikat: false });
    expect(mocks.kolejnosc).toEqual(['insert', 'mf']);

    const [srodowisko, plik, dane] = mocks.wyslij.mock.calls[0];
    expect(srodowisko).toBe('test');
    expect(plik.nazwa).toBe('JPK_V7M_1234567890_2026-10.xml');
    expect(plik.xml).toMatch(/<OsobaFizyczna>\s*<etd:NIP>1234567890<\/etd:NIP>/);
    expect(dane).toEqual({ nip: '1234567890', imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01', kwotaGr: 5_432_198 });
    expect(plik.xml).toContain('<CelZlozenia poz="P_7">1</CelZlozenia>');

    expect(Object.keys(mocks.wstawione[0]).sort()).toEqual(['cel', 'deklaracja', 'okres', 'rodzaj', 'skrot_pliku', 'srodowisko', 'tenant_id']);
    expect(mocks.wstawione[0]).toMatchObject({ okres: '2026-10-01', rodzaj: 'JPK_V7M', cel: 1, srodowisko: 'test', deklaracja: { P_38: 230, P_51: 230 } });
    expect(mocks.zmiany.at(-1)).toMatchObject({ zmiana: { stan: 'w_toku', numer_referencyjny: NUMER }, warunki: [['id', ID], ['stan', 'wysylanie']] });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'jpk_v7m.sent', entityId: ID, metadata: expect.objectContaining({ numer: NUMER }) }));
    for (const s of TAJNE) expect(zapisane()).not.toContain(s);
  });

  it('bez obszaru `wysylka_jpk` albo bez JPK_MF_ENV nic nie idzie do bazy ani do MF', async () => {
    mocks.obszary.wysylka_jpk = false;
    expect(await wyslijJpkV7mAction(WEJSCIE)).toMatchObject({ success: false, error: expect.stringContaining('nie jest jeszcze włączona') });
    mocks.obszary.wysylka_jpk = true;
    vi.stubEnv('JPK_MF_ENV', '');
    expect(await wyslijJpkV7mAction(WEJSCIE)).toMatchObject({ success: false, error: expect.stringContaining('nie jest jeszcze włączona') });
    vi.stubEnv('JPK_MF_ENV', 'produkcja');
    // Produkcja bez certyfikatu MF w kodzie: odmowa przed zapisem.
    expect(await wyslijJpkV7mAction(WEJSCIE)).toMatchObject({ success: false });
    expect(mocks.kolejnosc).toEqual([]);
    expect(mocks.wyslij).not.toHaveBeenCalled();
  });

  it('wysyłka za ten miesiąc już trwa (indeks z 00170): komunikat, bez drugiej wysyłki', async () => {
    mocks.bladWstawienia = { code: '23505', message: 'duplicate key value violates unique constraint "jpk_submissions_jedna_w_toku"' };
    expect(await wyslijJpkV7mAction(WEJSCIE)).toEqual({ success: false, error: expect.stringContaining('już trwa') });
    expect(mocks.wyslij).not.toHaveBeenCalled();
    // Przed nową wysyłką akcja zamyka wiersz „wysylanie” starszy niż 15 minut.
    expect(mocks.zmiany[0]).toMatchObject({ zmiana: { stan: 'przerwana' }, warunki: expect.arrayContaining([['stan', 'wysylanie']]) });
  });

  it('odmowa InitUploadSigned: wiersz „odrzucona” z kodem; brak odpowiedzi MF: „przerwana”', async () => {
    mocks.wyslij.mockRejectedValueOnce(new BladMf('init', 400, 158, 'MF (init, HTTP 400, kod 158): Zbyt dużo wysłanych plików'));
    expect(await wyslijJpkV7mAction(WEJSCIE)).toEqual({ success: false, error: expect.stringContaining('za kilka minut') });
    expect(mocks.zmiany.at(-1)?.zmiana).toMatchObject({ stan: 'odrzucona', status_kod: 158 });
    expect(mocks.sentryWyjatek).not.toHaveBeenCalled();

    mocks.wyslij.mockRejectedValueOnce(new BladMf('blob', 0, null, 'MF (blob): brak odpowiedzi: fetch failed'));
    expect(await wyslijJpkV7mAction(WEJSCIE)).toEqual({ success: false, error: expect.stringContaining('nie doszła do końca') });
    expect(mocks.zmiany.at(-1)?.zmiana).toMatchObject({ stan: 'przerwana', status_kod: null });
    expect(mocks.sentryWyjatek).toHaveBeenCalledTimes(1);
    for (const s of TAJNE) expect(zapisane()).not.toContain(s);
  });

  it('plik doszedł do MF, a zapis numeru padł: klient dostaje numer, numer jest w audycie i w Sentry', async () => {
    mocks.bladPoWysylce = true;
    expect(await wyslijJpkV7mAction(WEJSCIE)).toEqual({ success: true, numer: NUMER, duplikat: false });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ numer: NUMER, zapisany: false }) }));
    expect(mocks.sentryWyjatek).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ extra: expect.objectContaining({ numer: NUMER }) }));
  });
});

describe('status wysyłki i UPO', () => {
  it('200: UPO z próby MF w magazynie pod kluczem firmy, wiersz „przyjeta”, audyt raz; spóźnione odświeżenie bez drugiego audytu', async () => {
    mocks.status.mockResolvedValue({ kod: 200, opis: 'Przetwarzanie dokumentu zakończone poprawnie', szczegoly: NUMER, upo: UPO, czas: null });
    expect(await sprawdzStatusJpkAction({ id: ID })).toMatchObject({ success: true, stan: 'przyjeta' });
    const klucz = `upo/firma-1/jpk/2026-10/${NUMER}.xml`;
    expect(mocks.upload).toHaveBeenCalledWith(klucz, Buffer.from(UPO, 'utf8'), 'application/xml');
    expect(mocks.zmiany.at(-1)).toMatchObject({ zmiana: { stan: 'przyjeta', status_kod: 200, upo_sciezka: klucz }, warunki: [['id', ID], ['stan', 'w_toku']] });
    expect(mocks.audit).toHaveBeenCalledTimes(1);

    // Druga karta zdążyła wcześniej: UPO zapisane bez nadpisania, wiersz bez zmiany, audyt bez duplikatu.
    mocks.zmienionych = 0;
    mocks.upload.mockResolvedValue(false);
    expect(await sprawdzStatusJpkAction({ id: ID })).toMatchObject({ success: true, stan: 'przyjeta' });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it('120 zostaje w toku; odmowa klienta (422) bez Sentry, techniczna (412) z Sentry; zakończonej wysyłki nie pyta MF', async () => {
    mocks.status.mockResolvedValueOnce({ kod: 120, opis: 'Trwa weryfikacja dokumentu', szczegoly: null, upo: null, czas: null });
    expect(await sprawdzStatusJpkAction({ id: ID })).toMatchObject({ success: true, stan: 'w_toku' });
    expect(mocks.zmiany.at(-1)?.zmiana).toMatchObject({ status_kod: 120 });
    expect(mocks.zmiany.at(-1)?.zmiana).not.toHaveProperty('stan');

    mocks.status.mockResolvedValueOnce({ kod: 422, opis: 'tylko osoba fizyczna', szczegoly: null, upo: null, czas: null });
    expect(await sprawdzStatusJpkAction({ id: ID })).toMatchObject({ success: true, stan: 'odrzucona', tresc: expect.stringContaining('osobą fizyczną') });
    expect(mocks.sentryKomunikat).not.toHaveBeenCalled();
    mocks.status.mockResolvedValueOnce({ kod: 412, opis: 'Dokument nieprawidłowo zaszyfrowany', szczegoly: null, upo: null, czas: null });
    expect(await sprawdzStatusJpkAction({ id: ID })).toMatchObject({ success: true, stan: 'odrzucona' });
    expect(mocks.sentryKomunikat).toHaveBeenCalledTimes(1);

    mocks.wiersz = wiersz({ stan: 'przyjeta', upo_sciezka: 'upo/firma-1/jpk/2026-10/x.xml' });
    mocks.status.mockClear();
    expect(await sprawdzStatusJpkAction({ id: ID })).toMatchObject({ success: true, stan: 'przyjeta' });
    expect(mocks.status).not.toHaveBeenCalled();
  });
});

describe('pobranie pliku JPK_V7M', () => {
  it('plik osoby fizycznej przechodzi XSD; audyt z kwotami deklaracji, bez danych osoby', async () => {
    const wynik = await pobierzJpkV7mAction({ miesiac: '2026-10', nadwyzka: 0, ...OSOBA });
    expect(wynik).toMatchObject({ success: true, nazwa: 'JPK_V7M_1234567890_2026-10.xml' });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'jpk_v7m.downloaded', metadata: { miesiac: '2026-10', cel: 1, deklaracja: { P_38: 230, P_39: 0, P_48: 0, P_51: 230, P_62: 0 }, nadwyzkaZ: 'klient' } }),
    );
    for (const s of TAJNE) expect(zapisane()).not.toContain(s);
  });

  it('po deklaracji przyjętej przez MF kolejny plik to korekta (CelZlozenia 2, cel 2 w wysyłce); e-mail z formularza w Podmiot1', async () => {
    const przyjeta = { id: 'w-0', okres: '2026-10-01', stan: 'przyjeta', srodowisko: 'test', deklaracja: { P_62: 0 } };
    mocks.dane = { ...(mocks.dane as object), wysylki: [przyjeta] };
    await wyslijJpkV7mAction({ ...WEJSCIE, email: 'biuro@example.test' });
    const [, plik] = mocks.wyslij.mock.calls[0];
    expect(plik.xml).toContain('<CelZlozenia poz="P_7">2</CelZlozenia>');
    expect(plik.xml).toContain('<Email>biuro@example.test</Email>');
    expect(plik.nazwa).toBe('JPK_V7M_1234567890_2026-10_korekta.xml');
    expect(mocks.wstawione[0]).toMatchObject({ cel: 2 });
    // Przyjęta na teście nie robi korekty z pliku bez środowiska wysyłki (produkcja).
    vi.stubEnv('JPK_MF_ENV', '');
    expect(await pobierzJpkV7mAction({ miesiac: '2026-10', nadwyzka: 0, ...OSOBA })).toMatchObject({ success: true, nazwa: 'JPK_V7M_1234567890_2026-10.xml' });
    expect(await pobierzJpkV7mAction({ miesiac: '2026-10', nadwyzka: 0, ...OSOBA, email: 'bez-malpy' })).toMatchObject({ success: false, pole: 'email' });
  });

  it('bez nadwyżki z poprzedniej deklaracji nie ma pliku, a przed końcem miesiąca też nie', async () => {
    mocks.dane = { ...(mocks.dane as object), nadwyzka: null, wynik: null };
    expect(await pobierzJpkV7mAction({ miesiac: '2026-10', nadwyzka: null, ...OSOBA })).toEqual({
      success: false,
      error: expect.stringContaining('nadwyżka z deklaracji za wrzesień 2026'),
    });
    expect(await pobierzJpkV7mAction({ miesiac: '2026-11', nadwyzka: 0, ...OSOBA })).toEqual({
      success: false,
      error: expect.stringContaining('po zakończeniu miesiąca'),
    });
  });
});
