import { describe, expect, it } from 'vitest';

import type { KosztDoZaplaty } from '@/lib/expenses/do-zaplaty';
import { sumaKontrolnaIdentyfikatora } from '@/lib/invoices/identyfikator-zbiorczy';
import {
  bankExpenseConfirmedText,
  bankExpenseRefusalText,
  bankExpenseUndoneText,
  dopasujKoszty,
  identyfikatoryZbiorczeWTekscie,
  kosztDoPrzelewu,
  opisDopasowania,
  parseBankExpenseOperationsRpc,
  parseKnownBankOperationsRpc,
  poRozstrzygnieciu,
  scalPropozycje,
  wariantyRachunku,
  type KosztDoPrzelewu,
  type PrzelewZPropozycja,
} from '@/lib/import/bank/koszty';

/**
 * Przelewy do dostawców z wyciągu jako zapłaty kosztów z listy „Do zapłaty”
 * (plan kompletnej aplikacji, krok 3.2, część 3). Czyste funkcje: dopasowanie
 * przelewu do kosztów (rachunek, kwota, numer KSeF, numer faktury,
 * identyfikator zbiorczy), teksty i odczyt wyników RPC z 00196. Zapis (raz,
 * rola, obca firma, RODO) sprawdza `tests/rls-wyciag-koszty.test.ts` na bazie.
 */

const DOSTAWCA = 'PL27114020040000300201355387';
const INNY = 'PL49101010100160562221000000';
const KSEF_A = '1234567890-20261101-0A1B2C3D4E01-7A';
const KSEF_B = '1234567890-20261102-0A1B2C3D4E02-7B';
const KSEF_OBCY = '1234567890-20261103-0A1B2C3D4E03-7C';
const POCZATEK = '1234567890-IZ202611-0A1B2C3D4E5F';
const ZBIORCZY = `${POCZATEK}-${sumaKontrolnaIdentyfikatora(POCZATEK)}`;
const NBSP = /[  ]/g;
const plain = (text: string) => text.replace(NBSP, ' ');

function koszt(over: Partial<KosztDoPrzelewu> = {}): KosztDoPrzelewu {
  return {
    id: 'a',
    sprzedawca: 'Dostawca Testowy sp. z o.o.',
    numerFaktury: 'FV/7/11/2026',
    numerKsef: KSEF_A,
    kwotaGr: 123000,
    // Rachunek z faktury bywa zapisany bez „PL”.
    rachunek: '27114020040000300201355387',
    termin: '2026-11-20',
    ...over,
  };
}

const A = koszt();
const B = koszt({ id: 'b', numerFaktury: 'FV/8/11/2026', numerKsef: KSEF_B, kwotaGr: 50000 });

function przelew(title: string | null, amountGrosze = -123000, counterpartyAccount: string | null = DOSTAWCA) {
  return { amountGrosze, counterpartyAccount, title };
}

describe('dopasujKoszty: pewne dopasowanie (jedno kliknięcie)', () => {
  it('numer KSeF w tytule, kwota równa do zapłaty i rachunek z faktury', () => {
    expect(dopasujKoszty(przelew(`${KSEF_A} FV/7/11/2026`), [A, B])).toEqual({
      propozycja: { rodzaj: 'ksef_number', kosztIds: ['a'], pewne: true },
      uwaga: null,
      wskazane: ['a'],
      kandydaci: ['a', 'b'],
    });
  });

  it('numer KSeF bez myślnika w środku i rozcięty spacją przez bank', () => {
    const rozciety = `${KSEF_A.slice(0, 20)} ${KSEF_A.slice(20)}`.replace('0A1B2C3D4E01', '0A1B2C 3D4E01');
    expect(dopasujKoszty(przelew(`ZAPLATA ${rozciety}`), [A])?.propozycja).toEqual({ rodzaj: 'ksef_number', kosztIds: ['a'], pewne: true });
  });

  it('rachunek odbiorcy ze spacjami i z „PL” wobec rachunku bez „PL” na fakturze to ten sam rachunek', () => {
    expect(dopasujKoszty(przelew(KSEF_A, -123000, 'PL 2711 4020 0400 0030 0201 3553 87'), [A])?.propozycja?.pewne).toBe(true);
  });

  it('dwa numery KSeF w tytule i kwota równa sumie obu kosztów', () => {
    expect(dopasujKoszty(przelew(`${KSEF_A} ${KSEF_B}`, -173000), [A, B])?.propozycja).toEqual({
      rodzaj: 'ksef_number',
      kosztIds: ['a', 'b'],
      pewne: true,
    });
  });

  it('numer faktury w tytule z granicą numeru: FV/7 nie trafia w FV/77', () => {
    const bezKsef = koszt({ numerKsef: null });
    expect(dopasujKoszty(przelew('Faktura FV/7/11/2026'), [bezKsef])?.propozycja).toEqual({ rodzaj: 'invoice_number', kosztIds: ['a'], pewne: true });
    expect(dopasujKoszty(przelew('Faktura FV/77/11/2026'), [bezKsef])?.propozycja).toEqual({ rodzaj: 'amount', kosztIds: ['a'], pewne: false });
  });

  it('identyfikator zbiorczy w tytule: suma kosztów z zapisanego zestawu jednego dostawcy', () => {
    const zapisane = [{ numeryKsef: [KSEF_B, KSEF_A], identyfikator: ZBIORCZY }];
    expect(dopasujKoszty(przelew(ZBIORCZY, -173000), [A, B], zapisane)?.propozycja).toEqual({
      rodzaj: 'collective_identifier',
      kosztIds: ['a', 'b'],
      pewne: true,
    });
  });
});

describe('dopasujKoszty: granice', () => {
  it('inny rachunek odbiorcy: przelew nie dotyczy kosztów, nawet z numerem KSeF w tytule (nie wraca do klienta)', () => {
    expect(dopasujKoszty(przelew(KSEF_A, -123000, INNY), [A, B])).toBeNull();
    expect(dopasujKoszty(przelew(KSEF_A, -123000, null), [A, B])).toBeNull();
  });

  it('wpływ albo zero: bez dopasowania do kosztów', () => {
    expect(dopasujKoszty(przelew(KSEF_A, 123000), [A])).toBeNull();
    expect(dopasujKoszty(przelew(KSEF_A, 0), [A])).toBeNull();
  });

  it('numer KSeF z tytułu i inna kwota: bez jednego kliknięcia, z uwagą i wskazaną fakturą', () => {
    expect(dopasujKoszty(przelew(KSEF_A, -122999), [A, B])).toEqual({
      propozycja: null,
      uwaga: 'kwota_inna',
      wskazane: ['a'],
      kandydaci: ['a', 'b'],
    });
  });

  it('numer KSeF spoza listy zatrzymuje słabsze dopasowanie po samej kwocie', () => {
    expect(dopasujKoszty(przelew(KSEF_OBCY), [A])).toEqual({ propozycja: null, uwaga: 'ksef_nieznany', wskazane: [], kandydaci: ['a'] });
  });

  it('identyfikator zbiorczy bez zapisanego zestawu albo z fakturą już zapłaconą: bez jednego kliknięcia', () => {
    expect(dopasujKoszty(przelew(ZBIORCZY, -173000), [A, B], [])?.uwaga).toBe('identyfikator_nieznany');
    const zapisane = [{ numeryKsef: [KSEF_A, KSEF_B, KSEF_OBCY], identyfikator: ZBIORCZY }];
    expect(dopasujKoszty(przelew(ZBIORCZY, -173000), [A, B], zapisane)).toMatchObject({ propozycja: null, uwaga: 'identyfikator_nieznany' });
  });

  it('identyfikator zbiorczy i suma inna niż do zapłaty: uwaga o kwocie', () => {
    const zapisane = [{ numeryKsef: [KSEF_A, KSEF_B], identyfikator: ZBIORCZY }];
    expect(dopasujKoszty(przelew(ZBIORCZY, -123000), [A, B], zapisane)).toMatchObject({ propozycja: null, uwaga: 'kwota_inna', wskazane: ['a', 'b'] });
  });

  it('identyfikator zbiorczy ze złą sumą kontrolną to zwykły tekst', () => {
    const zly = `${POCZATEK}-00` === ZBIORCZY ? `${POCZATEK}-01` : `${POCZATEK}-00`;
    expect(identyfikatoryZbiorczeWTekscie(`Zaplata ${zly}`)).toEqual([]);
    expect(identyfikatoryZbiorczeWTekscie(`Zaplata ${ZBIORCZY.toLowerCase()} za listopad`)).toEqual([ZBIORCZY]);
  });

  it('tytuł bez numeru i kwota jednego kosztu: propozycja do wyboru, nie jedno kliknięcie', () => {
    expect(dopasujKoszty(przelew('Za listopad', -50000), [A, B])).toEqual({
      propozycja: { rodzaj: 'amount', kosztIds: ['b'], pewne: false },
      uwaga: null,
      wskazane: [],
      kandydaci: ['a', 'b'],
    });
  });

  it('dwa koszty z tą samą kwotą: bez propozycji, wybór klienta', () => {
    const drugi = koszt({ id: 'c', numerFaktury: 'FV/9/11/2026', numerKsef: null });
    expect(dopasujKoszty(przelew('Za listopad'), [A, drugi])).toEqual({ propozycja: null, uwaga: 'kilka_kosztow', wskazane: [], kandydaci: ['a', 'c'] });
  });

  it('rachunek ten sam, kwota bez pary: bez propozycji, wybór kilku kosztów albo „Pomiń”', () => {
    expect(dopasujKoszty(przelew('Za listopad', -1000), [A, B])).toEqual({ propozycja: null, uwaga: 'bez_propozycji', wskazane: [], kandydaci: ['a', 'b'] });
  });
});

describe('kosztDoPrzelewu i rachunki do odczytu', () => {
  function pozycja(over: Partial<KosztDoZaplaty> = {}): KosztDoZaplaty {
    return {
      id: 'a', sprzedawca: 'Dostawca', nip: '1234567890', numerFaktury: 'FV/1', numerKsef: KSEF_A, termin: '2026-11-20', dniDoTerminu: 9,
      przeterminowany: false, kwota: 1230, brutto: 1230, vat: 230, rachunek: '27114020040000300201355387', mpp: false, tytul: KSEF_A,
      wymagaBialejListy: false, sankcjaPitBialejListy: true, uwagi: [], ...over,
    };
  }

  it('kwota do zapłaty w groszach przez roundToCents (0,1 + 0,2 to 30 gr), kwota zero albo ujemna to brak kosztu', () => {
    expect(kosztDoPrzelewu(pozycja({ kwota: 0.1 + 0.2 }))?.kwotaGr).toBe(30);
    expect(kosztDoPrzelewu(pozycja({ kwota: 1.005 }))?.kwotaGr).toBe(101);
    expect(kosztDoPrzelewu(pozycja({ kwota: 0 }))).toBeNull();
    expect(kosztDoPrzelewu(pozycja({ kwota: -5 }))).toBeNull();
  });

  it('warianty rachunku do zapytania: z „PL” i bez dla polskiego, IBAN zagraniczny bez zmian, śmieci odpadają', () => {
    expect(wariantyRachunku([DOSTAWCA, '27114020040000300201355387', 'DE89370400440532013000', 'zly'])).toEqual([
      'PL27114020040000300201355387',
      '27114020040000300201355387',
      'DE89370400440532013000',
    ]);
  });
});

describe('teksty dla klienta', () => {
  const koszty = new Map([A, B].map((k) => [k.id, k]));

  it('opis pewnego dopasowania nazywa fakturę i dostawcę, bez długich myślników', () => {
    const opis = opisDopasowania(dopasujKoszty(przelew(KSEF_A), [A, B])!, koszty);
    expect(opis).toContain('FV/7/11/2026');
    expect(opis).toContain('Dostawca Testowy');
    expect(opis).toMatch(/numer KSeF/);
    expect(opis).not.toMatch(/[—–]/);
  });

  it('opis przy innej kwocie podaje kwotę do zapłaty i mówi, co zrobić', () => {
    const opis = plain(opisDopasowania(dopasujKoszty(przelew(KSEF_A, -100000), [A, B])!, koszty));
    expect(opis).toContain('1230,00 PLN');
    expect(opis).toContain('Oznacz jako zapłacone');
  });

  it.each([
    ['amount_mismatch', { documentNumber: null, dueGr: 123000, amountGr: 100000 }, ['1000,00 PLN', '1230,00 PLN', 'Oznacz jako zapłacone']],
    ['account_mismatch', { documentNumber: 'FV/7/11/2026' }, ['FV/7/11/2026', 'rachunek', 'Oznacz jako zapłacone']],
    ['expense_paid', { documentNumber: 'FV/7/11/2026' }, ['FV/7/11/2026', 'już oznaczony jako zapłacony']],
    ['operation_confirmed', {}, ['Cofnij']],
    ['operation_skipped', {}, ['Oznacz jako zapłacone']],
    ['expense_currency', { documentNumber: 'FV/7/11/2026' }, ['FV/7/11/2026', 'złotych']],
    ['payment_in_future', {}, ['dzień księgowania']],
    ['not_expense_payment', {}, ['nie pasuje do kosztów']],
  ] as const)('odmowa %s nazywa dokument i mówi, co zrobić', (code, ctx, fragments) => {
    const text = plain(bankExpenseRefusalText(code, ctx));
    for (const fragment of fragments) expect(text.toLowerCase()).toContain(fragment.toLowerCase());
    expect(text).not.toMatch(/[—–]/);
  });

  it('nieznany kod odmowy to ogólny komunikat o zapisie', () => {
    expect(bankExpenseRefusalText('cos_innego')).toMatch(/Nie udało się zapisać decyzji/);
  });

  it('komunikaty po potwierdzeniu i cofnięciu: dzień z wyciągu, numer faktury, kolejny krok', () => {
    expect(bankExpenseConfirmedText({ status: 'confirmed', paidOn: '2026-11-05', documents: [{ numer: 'FV/7/11/2026', sprzedawca: 'Dostawca' }] }))
      .toContain('05.11.2026');
    expect(bankExpenseConfirmedText({ status: 'already_confirmed', paidOn: '2026-11-05', documents: [] })).toMatch(/już zapisana/);
    expect(bankExpenseUndoneText(1, [])).toMatch(/wgraj wyciąg jeszcze raz/i);
    expect(bankExpenseUndoneText(0, ['FV/7/11/2026'])).toContain('FV/7/11/2026');
  });
});

describe('odczyt wyników RPC', () => {
  it('bank_expense_operations: potwierdzone z kosztami i pominięte bez danych drugiej strony', () => {
    const data = {
      confirmed_total: 1,
      decided: [
        {
          id: 'op1', booking_date: '2026-11-05', amount: -1230, state: 'confirmed', decided_at: '2026-11-06T10:00:00Z',
          counterparty_name: 'Dostawca', title: KSEF_A,
          expenses: [{ id: 'a', document_number: 'FV/7/11/2026', seller_name: 'Dostawca', paid_at: '2026-11-05' }],
        },
        { id: 'op2', booking_date: '2026-11-05', amount: '-77.00', state: 'skipped', decided_at: '2026-11-06T10:00:00Z', counterparty_name: null, title: null, expenses: [] },
      ],
    };
    expect(parseBankExpenseOperationsRpc(data)).toEqual({
      confirmedTotal: 1,
      decided: [
        {
          id: 'op1', bookingDate: '2026-11-05', amountGrosze: -123000, state: 'confirmed', decidedAt: '2026-11-06T10:00:00Z',
          counterpartyName: 'Dostawca', title: KSEF_A,
          koszty: [{ id: 'a', numer: 'FV/7/11/2026', sprzedawca: 'Dostawca', zaplaconoO: '2026-11-05' }],
        },
        { id: 'op2', bookingDate: '2026-11-05', amountGrosze: -7700, state: 'skipped', decidedAt: '2026-11-06T10:00:00Z', counterpartyName: null, title: null, koszty: [] },
      ],
    });
  });

  it('bank_expense_operations: zły kształt to null (ekran mówi o błędzie odczytu), wpływ też', () => {
    expect(parseBankExpenseOperationsRpc(null)).toBeNull();
    expect(parseBankExpenseOperationsRpc({ decided: [], confirmed_total: -1 })).toBeNull();
    expect(parseBankExpenseOperationsRpc({ decided: [{ id: 'x', booking_date: '2026-11-05', amount: 10, state: 'confirmed', expenses: [] }], confirmed_total: 0 })).toBeNull();
  });

  it('bank_known_operations: klucze już rozstrzygnięte; zły kształt to null', () => {
    const key = `v1:${'a'.repeat(64)}`;
    expect(parseKnownBankOperationsRpc({ status: 'ok', known: [{ key, state: 'confirmed' }] })).toEqual(new Map([[key, 'confirmed']]));
    expect(parseKnownBankOperationsRpc({ status: 'refused', code: 'invalid_request' })).toBeNull();
    expect(parseKnownBankOperationsRpc({ status: 'ok', known: [{ key: 1 }] })).toBeNull();
  });
});

// Dopisane po komponencie ekranu (stan przelewów do decyzji w przeglądarce).
describe('stan ekranu: kolejne wgrania i decyzje', () => {
  function zPropozycja(key: string, title: string, amountGrosze = -123000): PrzelewZPropozycja {
    const base = { key, account: 'PL61109010140000071219812874', bookingDate: '2026-11-05', amountGrosze, counterpartyName: 'D', counterpartyAccount: DOSTAWCA, title, reference: null };
    return { ...base, ...dopasujKoszty(base, [A, B])! };
  }

  it('kolejny plik dokłada przelewy, ten sam klucz zastępuje starszy, błąd nie kasuje wcześniejszych propozycji', () => {
    const pierwszy = scalPropozycje(null, { success: true, fileFormat: 'mt940', przelewy: [zPropozycja('k1', KSEF_A)], koszty: [A], znane: 0 });
    const drugi = scalPropozycje(pierwszy, { success: true, fileFormat: 'camt053', przelewy: [zPropozycja('k1', KSEF_A), zPropozycja('k2', 'Za listopad', -50000)], koszty: [A, B], znane: 0 });
    expect(drugi.przelewy.map((p) => [p.key, p.fileFormat])).toEqual([['k1', 'camt053'], ['k2', 'camt053']]);
    expect(drugi.koszty.map((k) => k.id)).toEqual(['a', 'b']);
    const blad = scalPropozycje(drugi, { success: false, error: 'nie wyszło' });
    expect(blad).toEqual({ ...drugi, error: 'nie wyszło' });
  });

  it('po zapłacie kosztu jednym przelewem znika on z wyboru przy pozostałych, a ich jedno kliknięcie z tym kosztem gaśnie', () => {
    const stan = scalPropozycje(null, {
      success: true, fileFormat: 'camt053', przelewy: [zPropozycja('k1', KSEF_A), zPropozycja('k2', `${KSEF_A} drugi raz`), zPropozycja('k3', 'Za listopad', -50000)], koszty: [A, B], znane: 0,
    });
    const po = poRozstrzygnieciu(stan, 'k1', ['a']);
    expect(po.przelewy.map((p) => p.key)).toEqual(['k2', 'k3']);
    expect(po.przelewy[0]).toMatchObject({ propozycja: null, uwaga: 'koszt_zaplacony', kandydaci: ['b'], wskazane: [] });
    expect(po.przelewy[1]).toMatchObject({ propozycja: { rodzaj: 'amount', kosztIds: ['b'] }, kandydaci: ['b'] });
    expect(opisDopasowania(po.przelewy[0]!, new Map([[B.id, B]]))).toContain('już zapłacony innym przelewem');
    expect(poRozstrzygnieciu(po, 'k3', []).przelewy.map((p) => p.key)).toEqual(['k2']);
  });
});
