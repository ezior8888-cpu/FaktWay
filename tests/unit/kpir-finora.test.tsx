import { JSDOM } from 'jsdom';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { KpirView, type KpirExpenseRow, type KpirInvoiceRow } from '@/components/expenses/kpir-view';

/**
 * KPiR w układzie Finory (P13). Poprawka Bartosza 21.10.2026
 * (przeprojektowanie Księgowości): zamiast czterech kafli i karty „Wydatki
 * według kolumn KPiR” — karta wyniku (dochód / strata, przychody, koszty)
 * i pierścień „Koszty według kolumn”; plakietka kolumny mówi „13 · Pozostałe”
 * zamiast „Kol. 13”; kolumnę „Akcje” zastąpił link w numerze dowodu.
 * Kwoty, znaki, Lp. i linki do źródeł — bez zmian.
 */

const sprzedaz = (o: Partial<KpirInvoiceRow>): KpirInvoiceRow => ({
  id: 'fv', internal_number: 'FV/1/2026', issue_date: '2026-09-05', sale_date: null, gross_total: 1230,
  net_total: 1000, buyer_data: { name: 'Nabywca spółka z ograniczoną odpowiedzialnością', nip: '1234567890' },
  invoice_kind: 'regular', settled_advances_net: null, ...o,
});

const koszt = (o: Partial<KpirExpenseRow>): KpirExpenseRow => ({
  id: 'exp', issue_date: '2026-09-03', seller_name: 'Dostawca', seller_nip: '5260001246', document_number: 'ZAK/7',
  category_label: 'Paliwo', kpir_column: 'col_13', is_deductible: true, net_amount: 1000, vat_amount: 230,
  gross_amount: 1230, vat_deductible_amount: 230, document_type: 'receipt', ...o,
} as KpirExpenseRow);

describe('KpirView — układ Finory', () => {
  it('karta wyniku, kolumny tabeli, kwoty ze znakiem i Lp. w kolejności dat', () => {
    const html = renderToStaticMarkup(
      <KpirView month={9} year={2026} invoices={[sprzedaz({})]} expenses={[koszt({})]} />,
    );
    for (const text of ['Przychody', 'Koszty', 'Koszty według kolumn',
      'Lp.', 'Data', 'Nr dowodu', 'Kontrahent', 'Opis', 'Kolumna', 'Kwota',
      'Wrzesień 2026', 'Eksport KPiR', '7 · Sprzedaż', '13 · Pozostałe']) {
      expect(html).toContain(text);
    }
    // Celowo zniknęły (przeprojektowanie 21.10.2026): kafle z numerami kolumn,
    // licznik wpisów, dolna karta kolumn i kolumna „Akcje”.
    for (const text of ['Przychody (kol. 7–8)', 'Wydatki (kol. 14)', 'Wpisy w księdze', 'Akcje',
      'Wydatki według kolumn KPiR', 'Razem (kol. 14)']) {
      expect(html).not.toContain(text);
    }
    expect(html).toContain('+1000,00 zł');
    expect(html).toContain('−1230,00 zł');
    expect(html).toContain('w tym VAT bez odliczenia 230,00');
    expect(html).toContain('03.09.2026');
    expect(html).toContain('05.09.2026');
    expect(html).toContain('Nabywca sp. z o.o.');
    // Koszt z 3.09 jest przed sprzedażą z 5.09 — Lp. 1 to ZAK/7.
    expect(html.indexOf('ZAK/7')).toBeLessThan(html.indexOf('FV/1/2026'));
    expect(html).toContain('href="/reports/exports?period=2026-09&amp;format=kpir_excel"');
    expect(html).toContain('href="/invoices/fv"');
    expect(html).toContain('href="/expenses/exp"');
    // Strata: 1000 − 1230. Wartość bez znaku (bez „Strata −230”), pełna kwota
    // ze znakiem typograficznym w `title`. Sam „230,00 zł” jest podciągiem
    // „1230,00 zł”, więc sprawdzamy atrybut, nie tekst.
    expect(html).toContain('Strata');
    expect(html).toContain('title="−230,00 zł"');
    expect(html).not.toContain('-230,00');
    expect(html).not.toContain('ff-glass-pane');
    expect(html).not.toMatch(/\$[0-9]/);
  });

  it('karta księgi jest bezpośrednim dzieckiem korzenia strony (fragment, karta sięga stopki)', () => {
    const html = renderToStaticMarkup(
      <div id="korzen" className="ff-page-fill flex flex-col gap-6">
        <KpirView month={9} year={2026} invoices={[sprzedaz({})]} expenses={[koszt({})]} />
      </div>,
    );
    const doc = new JSDOM(html).window.document;
    const ledger = doc.querySelector('#korzen > #ksiega');
    expect(ledger).not.toBeNull();
    expect(ledger!.className).toContain('flex-1');
    // Zakładki Księgowości stoją od 25.10.2026 nad stroną (`reports/layout.tsx`),
    // nie w karcie księgi — przy przełączeniu nie skaczą w pionie.
    expect(ledger!.querySelector('nav[aria-label="Księgowość"]')).toBeNull();
    expect(doc.querySelector('#korzen > :last-child')).toBe(ledger);
  });

  it('korekta in minus: „−” zamiast „+-”; zaliczka i ROZ z opisem', () => {
    const html = renderToStaticMarkup(
      <KpirView month={9} year={2026} expenses={[]} invoices={[
        sprzedaz({ id: 'kor', internal_number: 'KOR/1', invoice_kind: 'correction', net_total: -300 }),
        sprzedaz({ id: 'zal', internal_number: 'ZAL/1', invoice_kind: 'advance', net_total: 400 }),
        sprzedaz({ id: 'roz', internal_number: 'ROZ/1', invoice_kind: 'final', net_total: 1000, settled_advances_net: 400 }),
      ]} />,
    );
    expect(html).toContain('−300,00 zł');
    expect(html).not.toContain('+-');
    expect(html).toContain('Korekta sprzedaży');
    expect(html).toContain('Zaliczka');
    expect(html).toContain('Faktura rozliczeniowa');
    expect(html).toContain('+600,00 zł');
    expect(html).toContain('zamówienie 1000,00, minus zaliczki 400,00');
  });

  it('pusty miesiąc: bez rzędu sum, pusty stan z wyjściem, miesiąc w znaczniku', () => {
    const html = renderToStaticMarkup(<KpirView month={1} year={2027} expenses={[]} invoices={[]} />);
    expect(html).toContain('Brak przychodów i wydatków w tym okresie');
    expect(html).toContain('Styczeń 2027');
    expect(html).toContain('Wystaw fakturę');
    expect(html).toContain('href="/invoices/new"');
    expect(html).toContain('Dodaj wydatek');
    expect(html).toContain('href="/expenses?miesiac=2027-01"');
    // Bez „ściany zer”: żadnej kwoty, żadnej karty wyniku ani paginacji.
    expect(html).not.toContain('zł');
    expect(html).not.toContain('Dochód');
    expect(html).not.toContain('Brak pozycji');
  });
});
