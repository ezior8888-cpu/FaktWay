import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobContext } from '@/lib/jobs/registry';

/**
 * Krok 3.4 planu kompletnej aplikacji (koszty do zapłaty), część 1: termin,
 * rachunek sprzedawcy i MPP faktury kosztowej z KSeF.
 *
 * Do tej zmiany odbiór skrzynki zapisywał same metadane, a zadanie
 * `auto-categorize-inbox` archiwizowało plik FA(3), ale go nie czytało:
 * parser importu zna `Platnosc/TerminPlatnosci` (`parsePlatnosc`), tylko nikt
 * go nie wołał dla kosztów, więc wydatek nie miał terminu, rachunku ani MPP.
 *
 * Prawdziwe: odczyt pliku (`czytajWarunkiPlatnosci`), zadanie
 * `runAutoCategorizeInbox` i odczyt z archiwum (`wczytajWarunkiPlatnosciKsef`).
 * Zastąpione: KSeF (archiwizacja pliku), magazyn plików i baza.
 */

const NIP = '1234567890';
const KSEF = `${NIP}-20261105-0A1B2C3D4E5F-7A`;

function fa3({
  platnosc = '',
  p18a = '<P_18A>2</P_18A>',
  waluta = 'PLN',
}: { platnosc?: string; p18a?: string; waluta?: string } = {}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Podmiot1><DaneIdentyfikacyjne><NIP>${NIP}</NIP><Nazwa>Dostawca</Nazwa></DaneIdentyfikacyjne></Podmiot1>
  <Podmiot2><DaneIdentyfikacyjne><NIP>${NIP}</NIP><Nazwa>Nabywca</Nazwa></DaneIdentyfikacyjne></Podmiot2>
  <Fa>
    <KodWaluty>${waluta}</KodWaluty>
    <P_1>2026-11-05</P_1>
    <P_2>FV/77/11/2026</P_2>
    <P_13_1>1000.00</P_13_1>
    <P_14_1>230.00</P_14_1>
    <P_15>1230.00</P_15>
    <Adnotacje><P_16>2</P_16><P_17>2</P_17><P_18>2</P_18>${p18a}<Zwolnienie><P_19N>1</P_19N></Zwolnienie><NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu><P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy></Adnotacje>
    <RodzajFaktury>VAT</RodzajFaktury>
    <Platnosc>${platnosc}</Platnosc>
  </Fa>
</Faktura>`;
}

const TERMIN = '<TerminPlatnosci><Termin>2026-11-20</Termin></TerminPlatnosci><FormaPlatnosci>6</FormaPlatnosci>';
const RACHUNEK = '<RachunekBankowy><NrRB>PL61 1090 1014 0000 0712 1981 2874</NrRB><NazwaBanku>Bank</NazwaBanku></RachunekBankowy>';

describe('odczyt warunków płatności z FA(3)', () => {
  it('termin, rachunek bez spacji, MPP z P_18A = 1, forma płatności i waluta', async () => {
    const { czytajWarunkiPlatnosci } = await import('@/lib/expenses/platnosc-kosztu');
    const w = czytajWarunkiPlatnosci(fa3({ platnosc: TERMIN + RACHUNEK, p18a: '<P_18A>1</P_18A>' }));
    expect(w).toMatchObject({
      termin: '2026-11-20',
      liczbaTerminow: 1,
      rachunek: 'PL61109010140000071219812874',
      rachunekFaktora: null,
      mpp: true,
      zaplaconoDnia: null,
      zaplaconoCzesciowo: null,
      formaPlatnosci: '6',
      waluta: 'PLN',
      problemy: [],
    });
  });

  it('P_18A = 2 to brak MPP, a brak albo zły P_18A to „nie wiadomo” z problemem', async () => {
    const { czytajWarunkiPlatnosci } = await import('@/lib/expenses/platnosc-kosztu');
    expect(czytajWarunkiPlatnosci(fa3({ platnosc: TERMIN })).mpp).toBe(false);
    for (const p18a of ['', '<P_18A>3</P_18A>']) {
      const w = czytajWarunkiPlatnosci(fa3({ platnosc: TERMIN, p18a }));
      expect(w.mpp).toBeNull();
      expect(w.problemy.join(' ')).toMatch(/P_18A/);
    }
  });

  it('kilka terminów: najwcześniejszy (nie pierwszy w pliku) i ich liczba', async () => {
    const { czytajWarunkiPlatnosci } = await import('@/lib/expenses/platnosc-kosztu');
    const w = czytajWarunkiPlatnosci(fa3({
      platnosc: '<TerminPlatnosci><Termin>2026-12-10</Termin></TerminPlatnosci><TerminPlatnosci><Termin>2026-11-25</Termin></TerminPlatnosci>',
    }));
    expect(w).toMatchObject({ termin: '2026-11-25', liczbaTerminow: 2 });
  });

  it('termin nieczytelny albo tylko opisowy: bez daty, z problemem albo opisem (nigdy zgadywany)', async () => {
    const { czytajWarunkiPlatnosci } = await import('@/lib/expenses/platnosc-kosztu');
    const zly = czytajWarunkiPlatnosci(fa3({ platnosc: '<TerminPlatnosci><Termin>2026-13-40</Termin></TerminPlatnosci>' }));
    expect(zly.termin).toBeNull();
    expect(zly.problemy.join(' ')).toMatch(/termin/i);

    const opis = czytajWarunkiPlatnosci(fa3({
      platnosc: '<TerminPlatnosci><TerminOpis><Ilosc>14</Ilosc><Jednostka>dni</Jednostka><ZdarzeniePoczatkowe>od dostawy</ZdarzeniePoczatkowe></TerminOpis></TerminPlatnosci>',
    }));
    expect(opis).toMatchObject({ termin: null, terminOpis: '14 dni od dostawy' });
  });

  it('rachunek spoza wzorca NrRB nie trafia do kopiowania; rachunek faktora osobno', async () => {
    const { czytajWarunkiPlatnosci } = await import('@/lib/expenses/platnosc-kosztu');
    const zly = czytajWarunkiPlatnosci(fa3({ platnosc: '<RachunekBankowy><NrRB>61-1090-1014</NrRB></RachunekBankowy>' }));
    expect(zly.rachunek).toBeNull();
    expect(zly.problemy.join(' ')).toMatch(/rachun/i);

    const faktor = czytajWarunkiPlatnosci(fa3({
      platnosc: `${RACHUNEK}<RachunekBankowyFaktora><NrRB>12 1020 1026 0000 1502 0123 4567</NrRB></RachunekBankowyFaktora>`,
    }));
    expect(faktor).toMatchObject({
      rachunek: 'PL61109010140000071219812874',
      rachunekFaktora: '12102010260000150201234567',
    });
  });

  it('zapłata przed wystawieniem: Zaplacono + DataZaplaty; bez czytelnej daty koszt zostaje do zapłaty', async () => {
    const { czytajWarunkiPlatnosci } = await import('@/lib/expenses/platnosc-kosztu');
    expect(czytajWarunkiPlatnosci(fa3({
      platnosc: '<Zaplacono>1</Zaplacono><DataZaplaty>2026-11-02</DataZaplaty><FormaPlatnosci>2</FormaPlatnosci>',
    })).zaplaconoDnia).toBe('2026-11-02');

    const bezDaty = czytajWarunkiPlatnosci(fa3({ platnosc: '<Zaplacono>1</Zaplacono><DataZaplaty>02.11.2026</DataZaplaty>' }));
    expect(bezDaty.zaplaconoDnia).toBeNull();
    expect(bezDaty.problemy.join(' ')).toMatch(/zapłat/i);
  });

  it('zapłata częściowa (znacznik 1): suma wpłat; w całości w częściach (znacznik 2): ostatni dzień', async () => {
    const { czytajWarunkiPlatnosci } = await import('@/lib/expenses/platnosc-kosztu');
    const czesc = czytajWarunkiPlatnosci(fa3({
      platnosc: `<ZnacznikZaplatyCzesciowej>1</ZnacznikZaplatyCzesciowej>
        <ZaplataCzesciowa><KwotaZaplatyCzesciowej>100.00</KwotaZaplatyCzesciowej><DataZaplatyCzesciowej>2026-11-01</DataZaplatyCzesciowej></ZaplataCzesciowa>
        <ZaplataCzesciowa><KwotaZaplatyCzesciowej>200.50</KwotaZaplatyCzesciowej><DataZaplatyCzesciowej>2026-11-03</DataZaplatyCzesciowej></ZaplataCzesciowa>
        ${TERMIN}`,
    }));
    expect(czesc).toMatchObject({ zaplaconoCzesciowo: 300.5, zaplaconoDnia: null, termin: '2026-11-20' });

    const calosc = czytajWarunkiPlatnosci(fa3({
      platnosc: `<ZnacznikZaplatyCzesciowej>2</ZnacznikZaplatyCzesciowej>
        <ZaplataCzesciowa><KwotaZaplatyCzesciowej>615.00</KwotaZaplatyCzesciowej><DataZaplatyCzesciowej>2026-10-15</DataZaplatyCzesciowej></ZaplataCzesciowa>
        <ZaplataCzesciowa><KwotaZaplatyCzesciowej>615.00</KwotaZaplatyCzesciowej><DataZaplatyCzesciowej>2026-10-01</DataZaplatyCzesciowej></ZaplataCzesciowa>`,
    }));
    expect(calosc.zaplaconoDnia).toBe('2026-10-15');
  });

  it('plik nieczytelny albo bez sekcji Platnosc: puste warunki, nigdy wyjątek', async () => {
    const { czytajWarunkiPlatnosci } = await import('@/lib/expenses/platnosc-kosztu');
    const zepsuty = czytajWarunkiPlatnosci('<Faktura><Fa><Platnosc>');
    expect(zepsuty).toMatchObject({ termin: null, rachunek: null, mpp: null, zaplaconoDnia: null });
    expect(zepsuty.problemy.length).toBeGreaterThan(0);

    const bez = czytajWarunkiPlatnosci(fa3().replace(/<Platnosc>[\s\S]*<\/Platnosc>/, ''));
    expect(bez).toMatchObject({ termin: null, rachunek: null, mpp: false, zaplaconoDnia: null });
  });

  it('kolumny wydatku: termin, rachunek, MPP, fakty z pliku z chwilą odczytu; dzień zapłaty tylko z pliku', async () => {
    const { czytajWarunkiPlatnosci, kolumnyPlatnosci } = await import('@/lib/expenses/platnosc-kosztu');
    const k = kolumnyPlatnosci(czytajWarunkiPlatnosci(fa3({ platnosc: TERMIN + RACHUNEK })), '2026-11-09T10:00:00.000Z');
    expect(k).toEqual({
      payment_due_date: '2026-11-20',
      payment_account: 'PL61109010140000071219812874',
      payment_split: false,
      payment_terms: expect.objectContaining({ zrodlo: 'ksef_xml', odczytano: '2026-11-09T10:00:00.000Z', problemy: [] }),
    });
    const zaplacona = kolumnyPlatnosci(
      czytajWarunkiPlatnosci(fa3({ platnosc: '<Zaplacono>1</Zaplacono><DataZaplaty>2026-11-02</DataZaplaty>' })),
      '2026-11-09T10:00:00.000Z',
    );
    expect(zaplacona.paid_at).toBe('2026-11-02');
  });
});

// ── Zadanie skrzynki: zapis na wydatku ───────────────────────────────────────

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  archive: vi.fn(),
  download: vi.fn(),
  xmlPath: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/ksef-import/X.xml' as string | null,
  expenseExists: false,
  inserts: [] as Array<{ table: string; row: Row }>,
  updates: [] as Array<{ table: string; patch: Row; filters: Array<[string, unknown]> }>,
}));

vi.mock('@/lib/ksef/inbox-xml', () => ({ archiveInboxInvoiceXml: db.archive }));
vi.mock('@/lib/storage/r2', () => ({ downloadFromR2: db.download }));
vi.mock('@/lib/categorization', () => ({
  categorizeExpense: async () => ({ kpir_column: 'col_13', category_label: 'Usługi', method: 'rule', confidence: 0.95 }),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let patch: Row | null = null;
      let inserted = false;
      let selected = '';
      const q: Record<string, unknown> = {};
      const updateResult = () => {
        db.updates.push({ table, patch: patch!, filters });
        return { data: table === 'expenses' ? { id: 'exp-1' } : { id: INVOICE }, error: null };
      };
      Object.assign(q, {
        select: (cols?: string) => { selected = cols ?? ''; return q; },
        eq: (column: string, value: unknown) => { filters.push([column, value]); return q; },
        is: (column: string, value: unknown) => { filters.push([`is:${column}`, value]); return q; },
        limit: () => q,
        insert: (row: Row) => { inserted = true; db.inserts.push({ table, row }); return q; },
        update: (p: Row) => { patch = p; return q; },
        single: async () => {
          if (table === 'invoices') {
            return {
              data: {
                id: INVOICE, tenant_id: TENANT, direction: 'incoming', ksef_number: KSEF,
                internal_number: 'FV/77/11/2026', issue_date: '2026-11-05',
                seller_data: { name: 'Dostawca', nip: NIP }, seller_nip: NIP,
                gross_total: 1230, net_total: 1000, vat_total: 230, currency: 'PLN',
                fa3_data: { _source: 'inbox-metadata', _pendingFullFetch: true }, invoice_line_items: [],
              },
              error: null,
            };
          }
          return { data: inserted ? { id: 'exp-1' } : null, error: null };
        },
        maybeSingle: async () => {
          if (patch) return updateResult();
          if (table === 'invoices') {
            if (selected.includes('expenses!')) {
              return { data: { fa3_data: { _pendingFullFetch: true }, expenses: db.expenseExists ? [{ id: 'exp-1' }] : [] }, error: null };
            }
            if (selected.includes('xml_storage_path')) {
              return { data: { id: INVOICE, xml_storage_path: db.xmlPath }, error: null };
            }
            return {
              data: { id: INVOICE, tenant_id: TENANT, direction: 'incoming', origin: 'ksef_inbox', ksef_status: 'accepted', ksef_environment: 'test', fa3_data: { _pendingFullFetch: true } },
              error: null,
            };
          }
          if (table === 'memberships') return { data: { user_id: 'u-1' }, error: null };
          return { data: null, error: null };
        },
        then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
          const value = patch ? updateResult() : { data: null, error: null };
          return Promise.resolve(value).then(ok, ko);
        },
      });
      return q;
    },
  }),
}));

const INVOICE = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DANE = { invoiceId: INVOICE, tenantId: TENANT, environment: 'test' as const };
const ctx: JobContext = {
  attempt: 0,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  step: { run: async (_n, fn) => fn(), sleep: vi.fn(), sendEvent: vi.fn(), scheduleAfter: vi.fn() },
};

const expenseInsert = () => db.inserts.find((i) => i.table === 'expenses')?.row;
const inboxClosed = () => db.updates.some((u) => u.table === 'invoices'
  && (u.patch.fa3_data as Row | undefined)?._pendingFullFetch === false);

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  db.inserts = [];
  db.updates = [];
  db.expenseExists = false;
  db.xmlPath = `${TENANT}/ksef-import/X.xml`;
  db.archive.mockReset().mockResolvedValue({ archived: true });
  db.download.mockReset().mockResolvedValue(Buffer.from(fa3({ platnosc: TERMIN + RACHUNEK, p18a: '<P_18A>1</P_18A>' }), 'utf8'));
});
afterEach(() => vi.unstubAllEnvs());

describe('zadanie skrzynki zapisuje warunki płatności na wydatku', () => {
  it('nowy koszt: termin, rachunek i MPP z pliku w archiwum firmy', async () => {
    const { runAutoCategorizeInbox } = await import('@/lib/jobs/runners/auto-categorize-inbox');
    await expect(runAutoCategorizeInbox(DANE, ctx)).resolves.toEqual({ success: true });

    expect(db.download).toHaveBeenCalledWith(`${TENANT}/ksef-import/X.xml`, TENANT);
    expect(expenseInsert()).toMatchObject({
      payment_due_date: '2026-11-20',
      payment_account: 'PL61109010140000071219812874',
      payment_split: true,
      payment_terms: expect.objectContaining({ zrodlo: 'ksef_xml' }),
    });
    expect(expenseInsert()).not.toHaveProperty('paid_at');
    expect(inboxClosed()).toBe(true);
  });

  it('chwilowy błąd odczytu pliku: koszt powstaje bez warunków, a znacznik zostaje (cron ponowi)', async () => {
    db.download.mockRejectedValue(new Error('magazyn nie odpowiada'));
    const { runAutoCategorizeInbox } = await import('@/lib/jobs/runners/auto-categorize-inbox');
    await expect(runAutoCategorizeInbox(DANE, ctx)).resolves.toEqual({ success: true });

    expect(expenseInsert()).toBeDefined();
    expect(expenseInsert()).not.toHaveProperty('payment_terms');
    expect(inboxClosed()).toBe(false);
  });

  it('ponowienie przy istniejącym koszcie: warunki dopisane raz (warunek payment_terms IS NULL), potem domknięcie', async () => {
    db.expenseExists = true;
    const { runAutoCategorizeInbox } = await import('@/lib/jobs/runners/auto-categorize-inbox');
    await expect(runAutoCategorizeInbox(DANE, ctx)).resolves.toMatchObject({ success: true, skipped: 'expense-exists' });

    const termsUpdate = db.updates.find((u) => u.table === 'expenses');
    expect(termsUpdate?.patch).toMatchObject({ payment_due_date: '2026-11-20', payment_split: true });
    expect(termsUpdate?.filters).toEqual(expect.arrayContaining([
      ['tenant_id', TENANT], ['ksef_invoice_id', INVOICE], ['is:payment_terms', null],
    ]));
    expect(inboxClosed()).toBe(true);
  });
});
