/**
 * Wydatek ze zdjęcia w aplikacji na telefon (plan aplikacji mobilnej, M9):
 * moduły bez React Native z `mobile/src/lib/`, sprawdzane kodem strony.
 *
 * 1. Waluta kwot kosztu z bazy: kopia telefonu (`walutaKwotWydatku`) daje to
 *    samo co `expenseAmountsCurrency` strony na tych samych wierszach, także
 *    gdy telefon czyta ze śladu odczytu tylko klucze waluty.
 * 2. Wiersz bazy na model telefonu jak formularz kosztu strony (`buildInitialForm`).
 * 3. Treść zatwierdzenia przechodzi prawdziwy schemat trasy i jest taka jak
 *    z formularza strony (VAT zawsze, puste numer i notatka pominięte, NIP
 *    `null`, potwierdzenie złotych tylko przy walucie); kwoty bez zmian nie
 *    zmieniają się po drodze (grosze i z powrotem), więc odliczenie VAT nie
 *    liczy się od nowa.
 * 4. Czekanie na odczyt: stan nieznany (sieć, 503) nie kończy czekania.
 */
import { describe, expect, it } from 'vitest';

import { zmianyWydatkuSchema } from '../../lib/api/mobile/schematy';
import { expenseAmountsCurrency } from '../../lib/expenses/ocr-currency-review';
import { KOLUMNY_WYDATKU, sladZWiersza, walutaKwotWydatku, wydatekZBazy, type WierszWydatku } from '../../mobile/src/lib/dane/mapowanie';
import {
  czekaNaZlote,
  czekajNaOdczyt,
  formularzZKosztu,
  sprawdzFormularz,
  stanOdczytuZOdpowiedzi,
  zmianyWydatku,
  type StanOdczytuTelefonu,
} from '../../mobile/src/lib/wydatek/zatwierdzenie';
import type { Json } from '../../types/database';

const FX_EUR = { currency: 'EUR', mid: 4.25, tableNo: '187/A/NBP/2026', effectiveDate: '2026-09-24', appliedFor: '2026-09-25' };

/** Wiersz w kształcie bazy: pełny ślad odczytu, z którego telefon czyta tylko klucze waluty. */
type Przypadek = { nazwa: string; source: string; ksef_invoice_id: string | null; issue_date: string; slad: Record<string, unknown> | null };

const PRZYPADKI: Przypadek[] = [
  { nazwa: 'zdjęcie w złotych', source: 'ocr_photo', ksef_invoice_id: null, issue_date: '2026-11-10', slad: { currency: 'PLN', ocr_confidence: 0.9, line_items: [{ a: 1 }] } },
  { nazwa: 'zdjęcie bez śladu', source: 'ocr_photo', ksef_invoice_id: null, issue_date: '2026-11-10', slad: null },
  { nazwa: 'zdjęcie w EUR bez kursu', source: 'ocr_photo', ksef_invoice_id: null, issue_date: '2026-11-10', slad: { currency: 'EUR', gross_amount: 25 } },
  { nazwa: 'zdjęcie w eur małymi literami', source: 'ocr_photo', ksef_invoice_id: null, issue_date: '2026-11-10', slad: { currency: ' eur ' } },
  { nazwa: 'zdjęcie w EUR z kursem', source: 'ocr_photo', ksef_invoice_id: null, issue_date: '2026-09-25', slad: { currency: 'EUR', fx: FX_EUR } },
  { nazwa: 'zdjęcie w AED z potwierdzeniem złotych', source: 'ocr_photo', ksef_invoice_id: null, issue_date: '2026-11-10', slad: { currency: 'AED', pln_confirmation: { confirmed_by: 'u', confirmed_at: 'x' } } },
  { nazwa: 'zdjęcie z dziwnym kodem waluty', source: 'ocr_photo', ksef_invoice_id: null, issue_date: '2026-11-10', slad: { currency: 'EURO' } },
  { nazwa: 'zdjęcie ze śladem KSeF', source: 'ocr_photo', ksef_invoice_id: null, issue_date: '2026-11-10', slad: { source: 'ksef_inbox', currency: 'EUR' } },
  { nazwa: 'ręczny w złotych', source: 'manual', ksef_invoice_id: null, issue_date: '2026-11-10', slad: null },
  { nazwa: 'KSeF w złotych', source: 'ksef_inbox', ksef_invoice_id: 'inv-1', issue_date: '2026-11-10', slad: { source: 'ksef_inbox', currency: 'PLN' } },
  { nazwa: 'KSeF w EUR bez kursu', source: 'ksef_inbox', ksef_invoice_id: 'inv-1', issue_date: '2026-09-25', slad: { source: 'ksef_inbox', currency: 'EUR' } },
  { nazwa: 'KSeF w EUR z kursem', source: 'ksef_inbox', ksef_invoice_id: 'inv-1', issue_date: '2026-09-25', slad: { source: 'ksef_inbox', currency: 'EUR', fx: FX_EUR } },
  { nazwa: 'KSeF w EUR, kurs na inny dzień', source: 'ksef_inbox', ksef_invoice_id: 'inv-1', issue_date: '2026-09-26', slad: { source: 'ksef_inbox', currency: 'EUR', fx: FX_EUR } },
  { nazwa: 'KSeF w eur małymi literami z kursem', source: 'ksef_inbox', ksef_invoice_id: 'inv-1', issue_date: '2026-09-25', slad: { source: 'ksef_inbox', currency: 'eur', fx: FX_EUR } },
  { nazwa: 'KSeF bez śladu', source: 'ksef_inbox', ksef_invoice_id: 'inv-1', issue_date: '2026-11-10', slad: null },
  { nazwa: 'zdjęcie powiązane z fakturą KSeF', source: 'ocr_photo', ksef_invoice_id: 'inv-1', issue_date: '2026-11-10', slad: { currency: 'EUR' } },
];

/** To, co PostgREST oddaje dla aliasów `ocr_extracted_data->klucz` z `KOLUMNY_WYDATKU`. */
function zBazy(p: Przypadek): Pick<WierszWydatku, 'slad_waluta' | 'slad_zrodlo' | 'slad_kurs' | 'slad_zlote'> {
  return { slad_waluta: p.slad?.currency ?? null, slad_zrodlo: p.slad?.source ?? null, slad_kurs: p.slad?.fx ?? null, slad_zlote: p.slad?.pln_confirmation ?? null };
}

describe('waluta kwot kosztu: telefon i strona', () => {
  it.each(PRZYPADKI)('$nazwa', (p) => {
    const strona = expenseAmountsCurrency({ source: p.source, ksef_invoice_id: p.ksef_invoice_id, issue_date: p.issue_date, ocr_extracted_data: p.slad as Json });
    const telefon = walutaKwotWydatku({ source: p.source, ksef_invoice_id: p.ksef_invoice_id, issue_date: p.issue_date, slad: sladZWiersza(zBazy(p)) });
    expect(telefon).toBe(strona);
  });

  it('zapytanie czyta ze śladu tylko klucze waluty, nie cały odczyt', () => {
    expect(KOLUMNY_WYDATKU).not.toMatch(/ocr_extracted_data(?!->)/);
    for (const klucz of ['currency', 'source', 'fx', 'pln_confirmation']) expect(KOLUMNY_WYDATKU).toContain(`ocr_extracted_data->${klucz}`);
  });
});

const WIERSZ: WierszWydatku = {
  id: 'exp-1',
  source: 'ocr_photo',
  seller_name: ' Stacja Testowa ',
  seller_nip: '123-456-78-90',
  document_number: '0051/2026',
  document_type: 'receipt',
  issue_date: '2026-11-10',
  net_amount: '81.30',
  vat_amount: '18.70',
  gross_amount: '100.00',
  kpir_column: 'col_13',
  category_label: 'Paliwo',
  is_reviewed: false,
  is_deductible: true,
  notes: null,
  ksef_invoice_id: null,
  slad_waluta: 'PLN',
};

describe('wiersz bazy na wydatek telefonu', () => {
  it('jak formularz kosztu strony', () => {
    expect(wydatekZBazy(WIERSZ)).toEqual({
      id: 'exp-1',
      dostawca: 'Stacja Testowa',
      nip: '1234567890',
      opis: '',
      data: '2026-11-10',
      netto: 8130,
      brutto: 10000,
      vat: 1870,
      zrodlo: 'zdjecie',
      doOpisania: true,
      kategoria: 'Paliwo',
      kolumna: '13',
      dokument: 'Paragon',
      numer: '0051/2026',
      wKpir: true,
      walutaKwot: 'PLN',
    });
  });

  it('bez kolumny i kategorii: kolumna 13 i „Pozostałe wydatki” (jak `buildInitialForm`); kolumny 7, 8 i 16 zostają', () => {
    const k = wydatekZBazy({ ...WIERSZ, kpir_column: null, category_label: null, document_type: null, seller_nip: null });
    expect(k).toMatchObject({ kolumna: '13', kategoria: 'Pozostałe wydatki', dokument: 'Faktura' });
    expect(k).not.toHaveProperty('nip');
    expect(wydatekZBazy({ ...WIERSZ, kpir_column: 'col_16' }).kolumna).toBe('16');
    expect(wydatekZBazy({ ...WIERSZ, kpir_column: 'col_99' }).kolumna).toBe('13');
  });

  it('źródła i opis', () => {
    expect(wydatekZBazy({ ...WIERSZ, source: 'ksef_inbox' }).zrodlo).toBe('ksef');
    expect(wydatekZBazy({ ...WIERSZ, source: 'manual' }).zrodlo).toBe('reczny');
    expect(wydatekZBazy({ ...WIERSZ, source: 'import', is_reviewed: true }).doOpisania).toBe(false);
    expect(wydatekZBazy({ ...WIERSZ, notes: 'Delegacja' }).opis).toBe('Delegacja');
  });
});

describe('treść zatwierdzenia', () => {
  it('bez zmian w formularzu: te same kwoty co w bazie, schemat trasy przechodzi', () => {
    const k = wydatekZBazy(WIERSZ);
    const zmiany = zmianyWydatku(formularzZKosztu(k), czekaNaZlote(k));
    expect(zmianyWydatkuSchema.parse(zmiany)).toEqual(zmiany);
    expect(zmiany).toEqual({
      seller_name: 'Stacja Testowa',
      seller_nip: '1234567890',
      document_number: '0051/2026',
      issue_date: '2026-11-10',
      net_amount: 81.3,
      vat_amount: 18.7,
      gross_amount: 100,
      kpir_column: 'col_13',
      category_label: 'Paliwo',
      is_deductible: true,
    });
    // `reviewExpense` porównuje VAT z `Number(existing.vat_amount)`: bez zmiany nie liczy odliczenia od nowa.
    expect(zmiany.vat_amount).toBe(Number(WIERSZ.vat_amount));
  });

  it.each([
    [0.1, 0.2],
    [1234.56, 283.95],
    [999_999.99, 0.01],
  ])('kwoty %d i %d przechodzą przez grosze bez błędu zaokrąglenia', (netto, vat) => {
    const k = wydatekZBazy({ ...WIERSZ, net_amount: netto, vat_amount: vat, gross_amount: netto + vat });
    const zmiany = zmianyWydatku(formularzZKosztu(k), null);
    expect(zmiany.net_amount).toBe(netto);
    expect(zmiany.vat_amount).toBe(vat);
  });

  it('puste numer i notatka pominięte, NIP z kreskami na cyfry, pusty NIP to null', () => {
    const f = { ...formularzZKosztu(wydatekZBazy(WIERSZ)), numer: '  ', notatki: ' ', nip: ' ' };
    const zmiany = zmianyWydatku(f, null);
    expect(zmiany).not.toHaveProperty('document_number');
    expect(zmiany).not.toHaveProperty('notes');
    expect(zmiany.seller_nip).toBeNull();
    expect(zmianyWydatku({ ...f, nip: '526-000-12-46' }, null).seller_nip).toBe('5260001246');
  });

  it('dokument w walucie bez kursu: potwierdzenie złotych zawsze w treści (tak albo nie)', () => {
    const k = wydatekZBazy({ ...WIERSZ, slad_waluta: 'EUR' });
    expect(k.walutaKwot).toBe('EUR');
    expect(czekaNaZlote(k)).toBe('EUR');
    const f = formularzZKosztu(k);
    expect(zmianyWydatku(f, 'EUR').confirmPlnAmounts).toBe(false);
    expect(zmianyWydatku({ ...f, zlotePotwierdzone: true }, 'EUR').confirmPlnAmounts).toBe(true);
    expect(zmianyWydatku(f, null)).not.toHaveProperty('confirmPlnAmounts');
    // Koszt z KSeF ma własną drogę (strona), nawet z walutą.
    expect(czekaNaZlote({ zrodlo: 'ksef', walutaKwot: 'EUR' })).toBeNull();
  });

  it('szybkie sprawdzenie przed wysłaniem', () => {
    const f = formularzZKosztu(wydatekZBazy(WIERSZ));
    expect(sprawdzFormularz(f)).toBeNull();
    expect(sprawdzFormularz({ ...f, dostawca: ' ' })?.pole).toBe('dostawca');
    expect(sprawdzFormularz({ ...f, brutto: Number.NaN })?.pole).toBe('brutto');
    expect(sprawdzFormularz({ ...f, brutto: 0 })?.pole).toBe('brutto');
    expect(sprawdzFormularz({ ...f, netto: Number.NaN })?.pole).toBe('netto');
    expect(sprawdzFormularz({ ...f, data: '' })?.pole).toBe('data');
  });
});

describe('czekanie na odczyt', () => {
  function pytania(stany: Array<StanOdczytuTelefonu | Error>) {
    let n = 0;
    const pytaj = async () => {
      const s = stany[Math.min(n, stany.length - 1)]!;
      n += 1;
      if (s instanceof Error) throw s;
      return s;
    };
    return { pytaj, ile: () => n };
  }
  const bezCzekania = (zegar = { t: 0 }) => ({ czekaj: async (ms: number) => void (zegar.t += ms), teraz: () => zegar.t });

  it('stan nieznany (sieć, 503) i odrzucone pytanie nie kończą czekania', async () => {
    const p = pytania([{ stan: 'trwa' }, { stan: 'nieznany' }, new Error('sieć'), { stan: 'gotowy', wydatekId: 'exp-1' }]);
    expect(await czekajNaOdczyt(p.pytaj, bezCzekania())).toEqual({ wynik: 'gotowy', wydatekId: 'exp-1' });
    expect(p.ile()).toBe(4);
  });

  it.each([
    [{ stan: 'nieudany', komunikat: 'Nieczytelne' } as const, { wynik: 'nieudany', komunikat: 'Nieczytelne' }],
    [{ stan: 'brak' } as const, { wynik: 'brak' }],
    [{ stan: 'sesja' } as const, { wynik: 'sesja' }],
  ])('%j kończy od razu', async (stan, koniec) => {
    const p = pytania([stan]);
    expect(await czekajNaOdczyt(p.pytaj, bezCzekania())).toEqual(koniec);
    expect(p.ile()).toBe(1);
  });

  it('po limicie: „czas” (bez propozycji drugiego zdjęcia)', async () => {
    const p = pytania([{ stan: 'trwa' }]);
    expect(await czekajNaOdczyt(p.pytaj, { ...bezCzekania(), coMs: 2000, limitMs: 10_000 })).toEqual({ wynik: 'czas' });
    // Pytania w 0, 2, 4, 6, 8 i 10 s; następne byłoby po limicie.
    expect(p.ile()).toBe(6);
  });

  it('zamknięty ekran: bez dalszych pytań', async () => {
    let zamkniety = false;
    const p = pytania([{ stan: 'trwa' }]);
    const wynik = await czekajNaOdczyt(p.pytaj, { ...bezCzekania(), czekaj: async () => void (zamkniety = true), przerwano: () => zamkniety });
    expect(wynik).toEqual({ wynik: 'przerwano' });
    expect(p.ile()).toBe(1);
  });

  it('odpowiedź serwera na stan telefonu', () => {
    expect(stanOdczytuZOdpowiedzi({ id: 'j', stan: 'completed', wydatekId: 'exp-1', blad: null })).toEqual({ stan: 'gotowy', wydatekId: 'exp-1' });
    expect(stanOdczytuZOdpowiedzi({ id: 'j', stan: 'failed', wydatekId: null, blad: 'Nieczytelne' })).toEqual({ stan: 'nieudany', komunikat: 'Nieczytelne' });
    expect(stanOdczytuZOdpowiedzi({ id: 'j', stan: 'processing', wydatekId: null, blad: null })).toEqual({ stan: 'trwa' });
    // Odczyt skończony, wydatek usunięty na stronie: koniec czekania, nie 90 s kręciołka.
    expect(stanOdczytuZOdpowiedzi({ id: 'j', stan: 'completed', wydatekId: null, blad: null })).toEqual({ stan: 'brak' });
  });
});
