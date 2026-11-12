import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Krok 3.4, część 2: „Pobierz plik przelewów” z listy „Do zapłaty”.
 *
 * Prawdziwe: akcja `pobierzPlikPrzelewowAction`, lista (`listaDoZaplaty`),
 * plan pliku, generator Elixir-0 z kodowaniem Windows-1250, klient białej
 * listy (`checkBankAccountAssignment`, metoda `check` API MF).
 * Zastąpione: sesja i baza (atrapa klienta), zapis audytu, HTTP (atrapa `fetch`).
 *
 * Biała lista (RP-BL-01): koszt ponad 15 000 zł brutto wchodzi do pliku tylko
 * po świeżym sprawdzeniu „TAK” z identyfikatorem zapytania (`requestId`)
 * zapisanym w `audit_logs`. „NIE”, każdy błąd API i brak dowodu to koszt poza
 * plikiem z komunikatem (fail-closed). Odpowiedź API według
 * https://wl-api.mf.gov.pl/ (EntityCheckResponse, ErrorMessage).
 */

const s = vi.hoisted(() => ({
  wiersze: [] as Record<string, unknown>[],
  rachunekFirmy: null as string | null,
  bladKolumny: false,
  rola: 'owner',
  audit: vi.fn(async (_entry: unknown) => true),
  zapytaniaWydatkow: [] as Array<{ ids: unknown }>,
}));

function klient() {
  return {
    from(tabela: string) {
      const stan: { kolumny: string; ids: unknown } = { kolumny: '', ids: null };
      const wynik = () => {
        if (tabela === 'expenses') {
          s.zapytaniaWydatkow.push({ ids: stan.ids });
          const ids = new Set(stan.ids as string[]);
          return { data: s.wiersze.filter((w) => ids.has(String(w.id))), error: null };
        }
        if (stan.kolumny.includes('bank_account')) {
          return s.bladKolumny
            ? { data: null, error: { code: '42703', message: 'column tenants.bank_account does not exist' } }
            : { data: { bank_account: s.rachunekFirmy }, error: null };
        }
        return {
          data: { name: 'Testowa Firma sp. z o.o.', address_json: { addressLine1: 'ul. Prosta 1', addressLine2: '00-001 Warszawa' } },
          error: null,
        };
      };
      const b = {
        select(kolumny: string) { stan.kolumny = kolumny; return b; },
        eq() { return b; },
        in(_k: string, ids: unknown) { stan.ids = ids; return b; },
        maybeSingle() { return Promise.resolve(wynik()); },
        then(ok: (v: unknown) => unknown, nie?: (e: unknown) => unknown) { return Promise.resolve(wynik()).then(ok, nie); },
      };
      return b;
    },
  };
}

vi.mock('@/lib/supabase/auth-context', () => {
  class ActionAuthError extends Error {}
  return {
    ActionAuthError,
    requireOrgRole: vi.fn(async (role: string[]) => {
      if (!role.includes(s.rola)) throw new ActionAuthError('Niewystarczające uprawnienia');
      return { supabase: klient(), tenantId: 'org-a', user: { id: 'u-1' }, role: s.rola };
    }),
  };
});
// Jedna atrapa dla obu zapisów audytu: `logAuditWithResult` (dowód sprawdzenia) i `logAudit` (plik).
vi.mock('@/lib/audit/log', () => ({ logAudit: s.audit, logAuditWithResult: s.audit }));

function nrbZ(bban: string): string {
  let r = 0;
  for (const c of `${bban}252100`) r = (r * 10 + Number(c)) % 97;
  return `${String(98 - r).padStart(2, '0')}${bban}`;
}

const ING = nrbZ('105010380000000000001234');
const PKO = nrbZ('102010260000000000005678');
const ODBIORCA = nrbZ('109010140000000000004321');
const NIP = '1234567890';
const ksef = (n: number) => `${NIP}-20261105-0A1B2C3D4E${String(n).padStart(2, '0')}-7A`;
const id = (n: number) => `0a0b0c0d-0000-4000-8000-${String(n).padStart(12, '0')}`;

function wiersz(n: number, pola: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: id(n),
    seller_name: `Dostawca ${n} sp. z o.o.`,
    seller_nip: NIP,
    seller_address: null,
    document_number: `FV/${n}/11/2026`,
    gross_amount: 1230,
    vat_amount: 230,
    payment_due_date: '2026-11-20',
    payment_account: `PL${ODBIORCA}`,
    payment_split: false,
    payment_terms: { zrodlo: 'ksef_xml', odczytano: '2026-11-05T10:00:00.000Z', liczbaTerminow: 1, problemy: [] },
    paid_at: null,
    faktura: { ksef_number: ksef(n), internal_number: `FV/${n}/11/2026`, currency: 'PLN', ksef_environment: 'test' },
    ...pola,
  };
}

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const check = (accountAssigned: string, requestId = 'd2n10-84df1a1') =>
  json({ result: { accountAssigned, requestDateTime: '10-11-2026 09:15:00', requestId } });

function plikZ(wynik: unknown): string {
  const w = wynik as { success: boolean; plik: { base64: string } | null };
  expect(w.success).toBe(true);
  return new TextDecoder('windows-1250').decode(Buffer.from(w.plik!.base64, 'base64'));
}

beforeEach(() => {
  s.wiersze = [];
  s.rachunekFirmy = ING;
  s.bladKolumny = false;
  s.rola = 'owner';
  s.audit.mockReset();
  s.audit.mockResolvedValue(true);
  s.zapytaniaWydatkow = [];
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ toFake: ['Date'] });
  // 23:30 UTC 9.11 to już 10.11 w Warszawie: „dziś” i dzień sprawdzenia to dzień w Polsce.
  vi.setSystemTime(new Date('2026-11-09T23:30:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('plik przelewów: odmowy całości', () => {
  it('bez rachunku firmy w ustawieniach: odmowa z tym, co uzupełnić (także przed migracją 00183)', async () => {
    s.rachunekFirmy = null;
    s.wiersze = [wiersz(1)];
    const { pobierzPlikPrzelewowAction } = await import('@/app/actions/plik-przelewow');
    const wynik = await pobierzPlikPrzelewowAction([id(1)]);
    expect(wynik).toMatchObject({ success: false, error: expect.stringMatching(/Uzupełnij rachunek firmy w Ustawieniach/) });

    s.bladKolumny = true;
    await expect(pobierzPlikPrzelewowAction([id(1)])).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/rachunek firmy/),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('księgowa: odmowa z wyjaśnieniem; zła lista: odmowa bez zapytań do bazy', async () => {
    const { pobierzPlikPrzelewowAction } = await import('@/app/actions/plik-przelewow');
    s.rola = 'accountant';
    await expect(pobierzPlikPrzelewowAction([id(1)])).resolves.toMatchObject({ success: false, error: expect.stringMatching(/Księgowa/) });
    s.rola = 'owner';
    await expect(pobierzPlikPrzelewowAction([])).resolves.toMatchObject({ success: false, error: expect.stringMatching(/Zaznacz/) });
    await expect(pobierzPlikPrzelewowAction(['nie-uuid'])).resolves.toMatchObject({ success: false });
    const za_duzo = Array.from({ length: 51 }, (_, i) => id(i + 1));
    await expect(pobierzPlikPrzelewowAction(za_duzo)).resolves.toMatchObject({ success: false, error: expect.stringMatching(/50/) });
    expect(s.zapytaniaWydatkow).toEqual([]);
  });
});

describe('plik przelewów: zawartość', () => {
  it('zwykły koszt: rekord 110 z datą terminu, kwotą w groszach i tytułem z numerem KSeF; dziś przy terminie, który minął', async () => {
    s.wiersze = [wiersz(1), wiersz(2, { payment_due_date: '2026-11-01', gross_amount: 99.99 })];
    const { pobierzPlikPrzelewowAction } = await import('@/app/actions/plik-przelewow');
    const wynik = await pobierzPlikPrzelewowAction([id(1), id(2)]);

    const tekst = plikZ(wynik);
    expect(tekst).toBe(
      `110,20261110,9999,10501038,0,"${ING}","${ODBIORCA}","Testowa Firma sp. z o.o.|ul. Prosta 1|00-001 Warszawa",` +
        `"Dostawca 2 sp. z o.o.",0,10901014,"${ksef(2)}| FV/2/11/2026","","","51"\r\n` +
        `110,20261120,123000,10501038,0,"${ING}","${ODBIORCA}","Testowa Firma sp. z o.o.|ul. Prosta 1|00-001 Warszawa",` +
        `"Dostawca 1 sp. z o.o.",0,10901014,"${ksef(1)}| FV/1/11/2026","","","51"\r\n`,
    );
    expect(wynik).toMatchObject({
      success: true,
      plik: { nazwa: 'przelewy-2026-11-10.pli' },
      podsumowanie: { liczba: 2, suma: 1329.99, pominiete: [] },
    });
    // Bez sprawdzenia białej listy (kwoty do 15 000 zł) i bez oznaczania zapłaty.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'expense.transfer_file_created', tenantId: 'org-a' }));
  });

  it('MPP przy rachunku w ING: komunikat /VAT/ z numerem KSeF i klasyfikacja "53"', async () => {
    s.wiersze = [wiersz(1, { payment_split: true, gross_amount: 1230, vat_amount: 230 })];
    const { pobierzPlikPrzelewowAction } = await import('@/app/actions/plik-przelewow');
    const tekst = plikZ(await pobierzPlikPrzelewowAction([id(1)]));
    const komunikat = `/VAT/230,00/IDC/${NIP}/INV/${ksef(1)}/TXT/FV/1/11/2026`;
    const linie = komunikat.match(/.{1,35}/g)!.join('|');
    expect(tekst).toContain(`,0,10901014,"${linie}","","","53"\r\n`);
  });

  it('MPP przy banku bez potwierdzonego MPP w Elixir-0: koszt poza plikiem z powodem „zapłać w bankowości jako przelew MPP”', async () => {
    s.rachunekFirmy = PKO;
    s.wiersze = [wiersz(1, { payment_split: true }), wiersz(2)];
    const { pobierzPlikPrzelewowAction } = await import('@/app/actions/plik-przelewow');
    const wynik = await pobierzPlikPrzelewowAction([id(1), id(2)]);
    expect(plikZ(wynik)).toContain('Dostawca 2');
    expect(wynik).toMatchObject({
      podsumowanie: { liczba: 1, pominiete: [{ id: id(1), kod: 'mpp_bank', powod: expect.stringMatching(/zapłać w bankowości jako przelew MPP/) }] },
    });
  });

  it('pominięcia z powodem: zapłacony, waluta, brak rachunku, zły rachunek, nieczytelne MPP, faktor, kilka terminów, brak kosztu', async () => {
    s.wiersze = [
      wiersz(1, { paid_at: '2026-11-08' }),
      wiersz(2, { faktura: { ksef_number: ksef(2), internal_number: 'INV-2', currency: 'EUR', ksef_environment: 'test' } }),
      wiersz(3, { payment_account: null }),
      wiersz(4, { payment_account: `PL${ODBIORCA.slice(0, 25)}0` }),
      wiersz(5, { payment_split: null }),
      wiersz(6, { payment_terms: { liczbaTerminow: 1, rachunekFaktora: nrbZ('124000010000000000000777'), problemy: [] } }),
      wiersz(7, { payment_terms: { liczbaTerminow: 2, problemy: [] } }),
      wiersz(8, { payment_account: 'DE89370400440532013000' }),
    ];
    const { pobierzPlikPrzelewowAction } = await import('@/app/actions/plik-przelewow');
    const wynik = await pobierzPlikPrzelewowAction([1, 2, 3, 4, 5, 6, 7, 8, 9].map(id));

    expect(wynik).toMatchObject({ success: true, plik: null, podsumowanie: { liczba: 0 } });
    const kody = (wynik as { podsumowanie: { pominiete: Array<{ id: string; kod: string; powod: string }> } }).podsumowanie.pominiete;
    expect(kody.map((p) => [p.id, p.kod])).toEqual([
      [id(1), 'zaplacony'],
      [id(2), 'waluta'],
      [id(3), 'brak_rachunku'],
      [id(4), 'rachunek_bledny'],
      [id(5), 'mpp_nieczytelne'],
      [id(6), 'rachunek_faktora'],
      [id(7), 'kilka_terminow'],
      [id(8), 'rachunek_zagraniczny'],
      [id(9), 'nie_znaleziono'],
    ]);
    for (const p of kody) {
      expect(p.powod.length).toBeGreaterThan(20);
      expect(p.powod).not.toMatch(/[—–]/);
    }
  });
});

describe('plik przelewów: biała lista ponad 15 000 zł (metoda check API MF)', () => {
  it('rachunek przypisany („TAK”): koszt w pliku, numer zapytania w audit_logs i w podsumowaniu', async () => {
    s.wiersze = [wiersz(1, { gross_amount: 15000.01 })];
    fetchMock.mockResolvedValue(check('TAK'));
    const { pobierzPlikPrzelewowAction } = await import('@/app/actions/plik-przelewow');
    const wynik = await pobierzPlikPrzelewowAction([id(1)]);

    expect(plikZ(wynik)).toContain(',1500001,');
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `https://wl-api.mf.gov.pl/api/check/nip/${NIP}/bank-account/${ODBIORCA}?date=2026-11-10`,
    );
    expect(s.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'expense.whitelist_checked',
        entityType: 'expense',
        entityId: id(1),
        metadata: expect.objectContaining({ wynik: 'TAK', requestId: 'd2n10-84df1a1', dzien: '2026-11-10', rachunek: ODBIORCA, nip: NIP }),
      }),
    );
    expect(wynik).toMatchObject({
      podsumowanie: { przelewy: [{ id: id(1), bialaLista: { requestId: 'd2n10-84df1a1', dzien: '2026-11-10' } }] },
    });
  });

  it('15 000,00 zł to jeszcze nie „ponad 15 000 zł”: bez zapytania do API', async () => {
    s.wiersze = [wiersz(1, { gross_amount: 15000 })];
    const { pobierzPlikPrzelewowAction } = await import('@/app/actions/plik-przelewow');
    plikZ(await pobierzPlikPrzelewowAction([id(1)]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rachunek spoza wykazu („NIE”): koszt poza plikiem, komunikat z numerem zapytania i ZAW-NR, dowód w audit_logs', async () => {
    s.wiersze = [wiersz(1, { gross_amount: 20000 }), wiersz(2)];
    fetchMock.mockResolvedValue(check('NIE', 'abc-999'));
    const { pobierzPlikPrzelewowAction } = await import('@/app/actions/plik-przelewow');
    const wynik = await pobierzPlikPrzelewowAction([id(1), id(2)]);

    expect(plikZ(wynik)).not.toContain('Dostawca 1');
    expect(wynik).toMatchObject({
      podsumowanie: {
        liczba: 1,
        pominiete: [{ id: id(1), kod: 'biala_lista_poza', powod: expect.stringMatching(/abc-999[\s\S]*ZAW-NR/) }],
      },
    });
    expect(s.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'expense.whitelist_checked', metadata: expect.objectContaining({ wynik: 'NIE', requestId: 'abc-999' }) }),
    );
  });

  it.each([
    ['błąd parametru (400, WL-113)', () => Promise.resolve(json({ code: 'WL-113', message: 'Pole NIP ma nieprawidłową długość' }, 400))],
    ['limit zapytań (429)', () => Promise.resolve(new Response('x', { status: 429 }))],
    ['awaria (500)', () => Promise.resolve(new Response('x', { status: 500 }))],
    ['brak odpowiedzi (przerwane połączenie)', () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))],
    ['odpowiedź nie-JSON', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['odpowiedź bez numeru zapytania', () => Promise.resolve(json({ result: { accountAssigned: 'TAK' } }))],
    ['nieznana wartość accountAssigned', () => Promise.resolve(json({ result: { accountAssigned: 'MOŻE', requestId: 'x-1' } }))],
  ])('%s: koszt poza plikiem z „nie udało się sprawdzić”, nigdy „w porządku”', async (_nazwa, odp) => {
    s.wiersze = [wiersz(1, { gross_amount: 20000 })];
    fetchMock.mockImplementation(odp);
    const { pobierzPlikPrzelewowAction } = await import('@/app/actions/plik-przelewow');
    const wynik = await pobierzPlikPrzelewowAction([id(1)]);

    expect(wynik).toMatchObject({
      success: true,
      plik: null,
      podsumowanie: { liczba: 0, pominiete: [{ id: id(1), kod: 'biala_lista_blad', powod: expect.stringMatching(/Nie udało się sprawdzić/) }] },
    });
  });

  it('brak polskiego NIP sprzedawcy przy kwocie ponad 15 000 zł: poza plikiem, bez zapytania', async () => {
    s.wiersze = [wiersz(1, { gross_amount: 20000, seller_nip: null })];
    const { pobierzPlikPrzelewowAction } = await import('@/app/actions/plik-przelewow');
    const wynik = await pobierzPlikPrzelewowAction([id(1)]);
    expect(wynik).toMatchObject({ podsumowanie: { pominiete: [{ kod: 'biala_lista_nip' }] } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dowodu sprawdzenia nie udało się zapisać: koszt poza plikiem (bez dowodu nie ma pliku)', async () => {
    s.wiersze = [wiersz(1, { gross_amount: 20000 })];
    fetchMock.mockResolvedValue(check('TAK'));
    s.audit.mockImplementation(async (entry: unknown) => (entry as { action: string }).action !== 'expense.whitelist_checked');
    const { pobierzPlikPrzelewowAction } = await import('@/app/actions/plik-przelewow');
    const wynik = await pobierzPlikPrzelewowAction([id(1)]);
    expect(wynik).toMatchObject({ plik: null, podsumowanie: { pominiete: [{ kod: 'biala_lista_dowod' }] } });
  });
});

/**
 * RP-BL-01 po zmianie art. 22p ustawy o PIT (Dz.U. 2026 poz. 1371, art. 1 pkt 2
 * i art. 3): powód „poza wykazem” mówi o koszcie w PIT tylko przy fakturze
 * wystawionej przed 1.01.2027, także gdy plik powstaje w 2027 r. VAT i ZAW-NR
 * zostają przy każdej fakturze. Dzień wystawienia: P_1 z faktury KSeF, a bez
 * niego data dokumentu kosztu.
 */
describe('plik przelewów: skutki rachunku spoza wykazu według dnia wystawienia faktury', () => {
  const zFaktura = (n: number, p1: string | null, pola: Record<string, unknown> = {}) =>
    wiersz(n, {
      gross_amount: 20000,
      payment_due_date: '2027-01-20',
      issue_date: p1,
      faktura: { ksef_number: ksef(n), internal_number: `FV/${n}/12/2026`, currency: 'PLN', ksef_environment: 'test', issue_date: p1 },
      ...pola,
    });

  async function powodPoza(w: Record<string, unknown>): Promise<string> {
    s.wiersze = [w];
    fetchMock.mockResolvedValue(check('NIE', 'abc-2027'));
    const { pobierzPlikPrzelewowAction } = await import('@/app/actions/plik-przelewow');
    const wynik = await pobierzPlikPrzelewowAction([String(w.id)]);
    expect(wynik).toMatchObject({ success: true, plik: null, podsumowanie: { pominiete: [{ kod: 'biala_lista_poza' }] } });
    const p = (wynik as { podsumowanie: { pominiete: Array<{ powod: string }> } }).podsumowanie.pominiete[0]!;
    expect(p.powod).toContain('abc-2027');
    expect(p.powod).toContain('stan na 15.01.2027');
    expect(p.powod).not.toMatch(/[—–]/);
    return p.powod;
  }

  beforeEach(() => {
    // 23:30 UTC 14.01.2027 to już 15.01.2027 w Warszawie: plik i sprawdzenie w 2027 r.
    vi.setSystemTime(new Date('2027-01-14T23:30:00Z'));
  });

  it('faktura z 31.12.2026, plik w 2027: dawne skutki (koszt w PIT, VAT, ZAW-NR)', async () => {
    const powod = await powodPoza(zFaktura(1, '2026-12-31'));
    expect(powod).toContain('tej kwoty nie zaliczysz do kosztów w PIT');
    expect(powod).toContain('odpowiadasz solidarnie za VAT niezapłacony przez sprzedawcę');
    expect(powod).toContain('(formularz ZAW-NR)');
    expect(powod).toContain('Plik go nie zawiera: wyjaśnij rachunek ze sprzedawcą.');
  });

  it('faktura z 1.01.2027: bez zdania o PIT, VAT i ZAW-NR zostają, koszt dalej poza plikiem', async () => {
    const powod = await powodPoza(zFaktura(2, '2027-01-01'));
    expect(powod).not.toContain('PIT');
    expect(powod).not.toContain('kosztów');
    expect(powod).toContain('odpowiadasz solidarnie za VAT niezapłacony przez sprzedawcę');
    expect(powod).toContain('w ciągu 7 dni od zlecenia przelewu');
    expect(powod).toContain('(formularz ZAW-NR)');
    expect(powod).toContain('Plik go nie zawiera: wyjaśnij rachunek ze sprzedawcą.');
  });

  it('P_1 z 31.12.2026, a data kosztu 2.01.2027: liczy się P_1 (dawne skutki)', async () => {
    const powod = await powodPoza(zFaktura(3, '2026-12-31', { issue_date: '2027-01-02' }));
    expect(powod).toContain('tej kwoty nie zaliczysz do kosztów w PIT');
  });

  it('faktura bez daty wystawienia: data dokumentu kosztu z 4.01.2027 (bez zdania o PIT)', async () => {
    const powod = await powodPoza(zFaktura(4, null, { issue_date: '2027-01-04' }));
    expect(powod).not.toContain('PIT');
    expect(powod).toContain('(formularz ZAW-NR)');
  });

  it('dwie faktury w jednym pliku: każda ze swoim skutkiem', async () => {
    s.wiersze = [zFaktura(5, '2026-12-30'), zFaktura(6, '2027-01-02')];
    // Osobna odpowiedź na każde zapytanie: treść `Response` da się przeczytać tylko raz.
    fetchMock.mockImplementation(async () => check('NIE', 'abc-2027'));
    const { pobierzPlikPrzelewowAction } = await import('@/app/actions/plik-przelewow');
    const wynik = await pobierzPlikPrzelewowAction([id(5), id(6)]);
    const pominiete = (wynik as { podsumowanie: { pominiete: Array<{ id: string; kod: string; powod: string }> } }).podsumowanie.pominiete;
    expect(pominiete.map((p) => [p.id, p.kod, /kosztów w PIT/.test(p.powod)])).toEqual([
      [id(5), 'biala_lista_poza', true],
      [id(6), 'biala_lista_poza', false],
    ]);
  });
});
