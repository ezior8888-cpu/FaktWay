import { describe, expect, it } from 'vitest';

import { parseFa3Xml } from '@/lib/import/fa3-parser';
import { buildImportFa3Json, importedInvoiceContent } from '@/lib/import/imported-invoice-row';

/**
 * PLAN-PRAWDZIWE-DANE E11: wpływ faktury sprzedaży to prawdziwa zapłata
 * (odwołanie D-W, 02.11.2026), a faktura
 * FA(3) wystawiona po zapłacie mówi to sama (`Platnosc/Zaplacono = 1`
 * + `DataZaplaty`). Parser importu dotąd tych pól nie czytał, więc data
 * ginęła. Teraz trafia do `ParsedInvoice.paidDate`, a z nim do
 * `fa3_data.parsed` każdego nowego importu (plik i historia KSeF) — bez
 * migracji. Daty, której nie da się odczytać, nie zgadujemy.
 */

const fa3 = (platnosc: string) => `<?xml version="1.0" encoding="UTF-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Podmiot1><DaneIdentyfikacyjne><NIP>1234567890</NIP><Nazwa>Sprzedawca</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>PL</KodKraju><AdresL1>ul. Testowa 1</AdresL1><AdresL2>00-001 Warszawa</AdresL2></Adres></Podmiot1>
  <Podmiot2><DaneIdentyfikacyjne><NIP>1234567890</NIP><Nazwa>Nabywca</Nazwa></DaneIdentyfikacyjne></Podmiot2>
  <Fa>
    <KodWaluty>PLN</KodWaluty>
    <P_1>2026-09-15</P_1>
    <P_2>FV/1/2026</P_2>
    <P_13_1>1000.00</P_13_1>
    <P_14_1>230.00</P_14_1>
    <P_15>1230.00</P_15>
    <RodzajFaktury>VAT</RodzajFaktury>
    <FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Usługa</P_7><P_8A>szt.</P_8A><P_8B>1</P_8B><P_9A>1000.00</P_9A><P_11>1000.00</P_11><P_12>23</P_12></FaWiersz>
    <Platnosc>${platnosc}</Platnosc>
  </Fa>
</Faktura>`;

describe('FA(3) Zaplacono + DataZaplaty → paidDate', () => {
  it('faktura opłacona przed wystawieniem: data zapłaty z pliku', () => {
    const r = parseFa3Xml(fa3('<Zaplacono>1</Zaplacono><DataZaplaty>2026-09-14</DataZaplaty><FormaPlatnosci>1</FormaPlatnosci>'));
    expect(r.paidDate).toBe('2026-09-14');
    expect(r.warnings.join(' ')).not.toMatch(/zapłat/i);
  });

  it('bez znacznika Zaplacono nie ma daty zapłaty (termin zostaje terminem)', () => {
    const r = parseFa3Xml(fa3('<TerminPlatnosci><Termin>2026-09-29</Termin></TerminPlatnosci><FormaPlatnosci>6</FormaPlatnosci>'));
    expect(r.paidDate).toBeUndefined();
    expect('paidDate' in r).toBe(false);
    expect(r.paymentDueDate).toBe('2026-09-29');
  });

  it('nieczytelna data zapłaty: brak daty i ostrzeżenie zamiast zgadywania', () => {
    const r = parseFa3Xml(fa3('<Zaplacono>1</Zaplacono><DataZaplaty>15.09.2026</DataZaplaty>'));
    expect(r.paidDate).toBeUndefined();
    expect(r.warnings).toContain('Nieczytelna data zapłaty: 15.09.2026');
  });

  it('data bez znacznika Zaplacono = 1 nie jest zapłatą', () => {
    const r = parseFa3Xml(fa3('<Zaplacono>2</Zaplacono><DataZaplaty>2026-09-14</DataZaplaty>'));
    expect(r.paidDate).toBeUndefined();
  });

  it('nowy import zapisuje datę w fa3_data.parsed (tam czyta ją karta wpływów)', () => {
    const parsed = parseFa3Xml(fa3('<Zaplacono>1</Zaplacono><DataZaplaty>2026-09-14</DataZaplaty>'));
    const { content, amounts } = importedInvoiceContent(parsed);
    const json = buildImportFa3Json(parsed, { source: 'test' }, content, amounts) as { parsed: { paidDate?: string } };
    expect(json.parsed.paidDate).toBe('2026-09-14');
  });
});
