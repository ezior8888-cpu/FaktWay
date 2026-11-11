import { describe, expect, it, vi } from 'vitest';

/**
 * Krok 1.4, część 2: grupy faktur do identyfikatora zbiorczego na liście
 * „Do zapłaty”. Grupa to co najmniej 2 niezapłacone koszty z numerem KSeF od
 * tego samego dostawcy (NIP sprzedawcy), które płaci się jednym przelewem:
 * osobno z MPP i bez MPP. Faktury bez numeru KSeF (offline przed przyjęciem,
 * awaryjne, spoza KSeF) i faktury, przy których nie wiadomo, czy jest MPP, do
 * żądania nie trafiają, a ekran mówi dlaczego. Jedna faktura: zwykły numer KSeF.
 *
 * Prawdziwe: `listaDoZaplaty` (kwoty po wpłatach częściowych, `roundToCents`),
 * grupowanie, dopasowanie zapisanych identyfikatorów, odczyt z bazy (atrapa
 * klienta PostgREST).
 */

type Wiersz = import('@/lib/expenses/do-zaplaty').WierszKosztuDoZaplaty;

const DZIS = '2026-11-11';
const NIP_A = '1111111111';
const NIP_B = '1234567890';
const ksef = (nip: string, n: number) => `${nip}-20261105-0A1B2C3D4E${String(n).padStart(2, '0')}-7A`;
const WEKTOR = '1111111111-IZ202607-65ED02180000-E7';

function wiersz(n: number, pola: Partial<Wiersz> = {}, nip = NIP_A): Wiersz {
  return {
    id: `exp-${n}`,
    seller_name: 'Dostawca A sp. z o.o.',
    seller_nip: nip,
    document_number: `FV/${n}/11/2026`,
    gross_amount: 1230,
    vat_amount: 230,
    payment_due_date: `2026-11-${String(10 + n).padStart(2, '0')}`,
    payment_account: 'PL61109010140000071219812874',
    payment_split: false,
    payment_terms: { zrodlo: 'ksef_xml', odczytano: '2026-11-05T10:00:00.000Z', liczbaTerminow: 1, problemy: [] },
    paid_at: null,
    faktura: { ksef_number: ksef(nip, n), internal_number: `FV/${n}/11/2026`, currency: 'PLN' },
    ...pola,
  };
}

async function grupy(wiersze: Wiersz[], zapisane: Array<{ numeryKsef: string[]; identyfikator: string }> = []) {
  const { listaDoZaplaty } = await import('@/lib/expenses/do-zaplaty');
  const { grupyDoIdentyfikatora } = await import('@/lib/expenses/identyfikator-zbiorczy');
  return grupyDoIdentyfikatora(listaDoZaplaty(wiersze, DZIS).pozycje, zapisane);
}

describe('grupy do identyfikatora zbiorczego', () => {
  it('dwie faktury jednego dostawcy: jedna grupa z sumą, numery KSeF po kolei, bez zapisanego identyfikatora', async () => {
    const wynik = await grupy([wiersz(2, { gross_amount: '200.10', vat_amount: '37.42' }), wiersz(1)]);

    expect(wynik).toHaveLength(1);
    expect(wynik[0]).toMatchObject({
      nip: NIP_A,
      sprzedawca: 'Dostawca A sp. z o.o.',
      mpp: false,
      suma: 1430.1,
      numeryKsef: [ksef(NIP_A, 1), ksef(NIP_A, 2)],
      rachunek: 'PL61109010140000071219812874',
      rozneRachunki: false,
      identyfikator: null,
      poza: [],
    });
    // Kolejność faktur jak na liście: od najbliższego terminu.
    expect(wynik[0]!.faktury.map((f) => f.id)).toEqual(['exp-1', 'exp-2']);
  });

  it('jedna faktura u dostawcy: bez grupy (wystarczy jej numer KSeF)', async () => {
    expect(await grupy([wiersz(1), wiersz(2, {}, NIP_B)])).toEqual([]);
  });

  it('różni dostawcy to różne grupy; liczy się NIP sprzedawcy, nie nazwa', async () => {
    const wynik = await grupy([
      wiersz(1),
      wiersz(2, { seller_name: 'Dostawca A Spółka z o.o.' }),
      wiersz(3, { seller_name: 'Dostawca A sp. z o.o.' }, NIP_B),
      wiersz(4, { seller_name: 'Dostawca A sp. z o.o.' }, NIP_B),
    ]);

    expect(wynik.map((g) => [g.nip, g.faktury.map((f) => f.id)])).toEqual([
      [NIP_A, ['exp-1', 'exp-2']],
      [NIP_B, ['exp-3', 'exp-4']],
    ]);
  });

  it('NIP z prefiksem PL, spacjami i myślnikami to ten sam dostawca; obcy numer VAT nie trafia do grupy', async () => {
    const wynik = await grupy([
      wiersz(1, { seller_nip: 'PL 111-111-11-11' }),
      wiersz(2, { seller_nip: '1111111111' }),
      wiersz(3, { seller_nip: 'CZ1234567890' }, NIP_B),
      wiersz(4, { seller_nip: 'CZ1234567890' }, NIP_B),
    ]);

    expect(wynik).toHaveLength(1);
    expect(wynik[0]).toMatchObject({ nip: NIP_A });
  });

  it('faktura bez numeru KSeF: poza identyfikatorem z powodem; pozostałe dwie w grupie', async () => {
    const wynik = await grupy([
      wiersz(1),
      wiersz(2),
      wiersz(3, { faktura: { ksef_number: null, internal_number: 'FV/3/11/2026', currency: 'PLN' } }),
    ]);

    expect(wynik).toHaveLength(1);
    expect(wynik[0]!.faktury.map((f) => f.id)).toEqual(['exp-1', 'exp-2']);
    expect(wynik[0]!.poza).toEqual([{ id: 'exp-3', numerFaktury: 'FV/3/11/2026', powod: 'brak_numeru_ksef' }]);
    expect(wynik[0]!.numeryKsef).not.toContain(null);
  });

  it('jedna faktura z numerem KSeF i jedna bez: bez grupy', async () => {
    expect(
      await grupy([wiersz(1), wiersz(2, { faktura: { ksef_number: 'zły numer', internal_number: 'FV/2/11/2026', currency: 'PLN' } })]),
    ).toEqual([]);
  });

  it('MPP i bez MPP to osobne przelewy, więc osobne grupy; przy MPP suma VAT', async () => {
    const wynik = await grupy([
      wiersz(1, { payment_split: true, gross_amount: 12300, vat_amount: 2300 }),
      wiersz(2),
      wiersz(3, { payment_split: true, gross_amount: '123.01', vat_amount: '23.01' }),
      wiersz(4),
    ]);

    expect(wynik.map((g) => [g.mpp, g.faktury.map((f) => f.id)])).toEqual([
      [true, ['exp-1', 'exp-3']],
      [false, ['exp-2', 'exp-4']],
    ]);
    expect(wynik[0]).toMatchObject({ suma: 12423.01, vat: 2323.01 });
  });

  it('nie wiadomo, czy jest MPP: faktura poza grupą z powodem', async () => {
    const wynik = await grupy([wiersz(1), wiersz(2), wiersz(3, { payment_split: null })]);

    expect(wynik).toHaveLength(1);
    expect(wynik[0]!.poza).toEqual([{ id: 'exp-3', numerFaktury: 'FV/3/11/2026', powod: 'mpp_nieznane' }]);
  });

  it('MPP z wpłatą częściową: suma do zapłaty po wpłacie, kwoty VAT do komunikatu brak (do sprawdzenia w fakturach)', async () => {
    const wynik = await grupy([
      wiersz(1, { payment_split: true }),
      wiersz(2, {
        payment_split: true,
        payment_terms: { zrodlo: 'ksef_xml', odczytano: '2026-11-05T10:00:00.000Z', liczbaTerminow: 1, problemy: [], zaplaconoCzesciowo: 230 },
      }),
    ]);

    expect(wynik[0]).toMatchObject({ suma: 2230, vat: null, wplatyCzesciowe: true });
  });

  it('grosze przez roundToCents: 0,10 + 0,20 to 0,30', async () => {
    const wynik = await grupy([wiersz(1, { gross_amount: 0.1, vat_amount: 0.02 }), wiersz(2, { gross_amount: 0.2, vat_amount: 0.04 })]);
    expect(wynik[0]!.suma).toBe(0.3);
  });

  it('różne rachunki w fakturach: bez wspólnego rachunku', async () => {
    const wynik = await grupy([wiersz(1), wiersz(2, { payment_account: 'PL27114020040000300201355387' })]);
    expect(wynik[0]).toMatchObject({ rachunek: null, rozneRachunki: true });
  });

  it('zapisany identyfikator dla tego samego zestawu (w dowolnej kolejności) wraca do grupy', async () => {
    const wynik = await grupy([wiersz(1), wiersz(2)], [{ numeryKsef: [ksef(NIP_A, 2), ksef(NIP_A, 1)], identyfikator: WEKTOR }]);
    expect(wynik[0]!.identyfikator).toBe(WEKTOR);
  });

  it('identyfikator innego zestawu (część faktur, faktura więcej) nie pasuje', async () => {
    const wynik = await grupy(
      [wiersz(1), wiersz(2), wiersz(3)],
      [
        { numeryKsef: [ksef(NIP_A, 1), ksef(NIP_A, 2)], identyfikator: WEKTOR },
        { numeryKsef: [ksef(NIP_A, 1), ksef(NIP_A, 2), ksef(NIP_A, 3), ksef(NIP_A, 4)], identyfikator: WEKTOR },
      ],
    );
    expect(wynik[0]!.identyfikator).toBeNull();
  });

  it('zapisany identyfikator ze złą sumą kontrolną nie jest pokazywany', async () => {
    const wynik = await grupy([wiersz(1), wiersz(2)], [{ numeryKsef: [ksef(NIP_A, 1), ksef(NIP_A, 2)], identyfikator: WEKTOR.replace(/E7$/, 'E8') }]);
    expect(wynik[0]!.identyfikator).toBeNull();
  });

  it('owner i admin tworzą identyfikator; członek i księgowa nie', async () => {
    const { mozeTworzycIdentyfikator } = await import('@/lib/expenses/identyfikator-zbiorczy');
    expect(['owner', 'admin', 'member', 'accountant', null].map(mozeTworzycIdentyfikator)).toEqual([true, true, false, false, false]);
  });
});

describe('odczyt zapisanych identyfikatorów (RLS, klucz sesji)', () => {
  function klient(wynik: { data: unknown; error: unknown }) {
    const wywolania: Array<[string, ...unknown[]]> = [];
    const b = {
      select: (...a: unknown[]) => (wywolania.push(['select', ...a]), b),
      eq: (...a: unknown[]) => (wywolania.push(['eq', ...a]), b),
      in: (...a: unknown[]) => (wywolania.push(['in', ...a]), b),
      order: (...a: unknown[]) => (wywolania.push(['order', ...a]), b),
      limit: (...a: unknown[]) => (wywolania.push(['limit', ...a]), b),
      then: (ok: (v: unknown) => unknown, nie?: (e: unknown) => unknown) => Promise.resolve(wynik).then(ok, nie),
    };
    return { klient: { from: (t: string) => (wywolania.push(['from', t]), b) }, wywolania };
  }

  it('gotowe identyfikatory firmy w tym środowisku KSeF dla NIP-ów z listy', async () => {
    const { wczytajZapisaneIdentyfikatory } = await import('@/lib/expenses/identyfikator-zbiorczy-dane');
    const { klient: c, wywolania } = klient({
      data: [{ ksef_numbers: [ksef(NIP_A, 1), ksef(NIP_A, 2)], identifier: WEKTOR }],
      error: null,
    });

    const zapisane = await wczytajZapisaneIdentyfikatory(c, 'org-a', 'test', [NIP_A]);

    expect(zapisane).toEqual([{ numeryKsef: [ksef(NIP_A, 1), ksef(NIP_A, 2)], identyfikator: WEKTOR }]);
    expect(wywolania).toEqual(
      expect.arrayContaining([
        ['from', 'ksef_collective_identifiers'],
        ['eq', 'tenant_id', 'org-a'],
        ['eq', 'ksef_environment', 'test'],
        ['eq', 'status', 'ready'],
        ['in', 'seller_nip', [NIP_A]],
      ]),
    );
  });

  it('przed migracją 00191 (brak tabeli) i przy błędzie odczytu: pusta lista, lista „Do zapłaty” działa dalej', async () => {
    const { wczytajZapisaneIdentyfikatory } = await import('@/lib/expenses/identyfikator-zbiorczy-dane');
    const blad = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const error of [
      { code: 'PGRST205', message: "Could not find the table 'public.ksef_collective_identifiers' in the schema cache" },
      { code: '42P01', message: 'relation "public.ksef_collective_identifiers" does not exist' },
      { code: '57014', message: 'canceling statement due to statement timeout' },
    ]) {
      expect(await wczytajZapisaneIdentyfikatory(klient({ data: null, error }).klient, 'org-a', 'test', [NIP_A])).toEqual([]);
    }
    blad.mockRestore();
  });

  it('bez grup nie pyta bazy', async () => {
    const { wczytajZapisaneIdentyfikatory } = await import('@/lib/expenses/identyfikator-zbiorczy-dane');
    const { klient: c, wywolania } = klient({ data: [], error: null });
    expect(await wczytajZapisaneIdentyfikatory(c, 'org-a', 'test', [])).toEqual([]);
    expect(wywolania).toEqual([]);
  });
});
