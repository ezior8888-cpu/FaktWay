import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { memoryClient, type MemoryTables } from './helpers/baza-w-pamieci';

vi.mock('@/lib/exports/issuer-address', async (orig) => ({
  ...(await orig<typeof import('@/lib/exports/issuer-address')>()),
  readIssuerRegisteredAddress: async () => ({
    voivodeship: 'MAZOWIECKIE', county: 'Warszawa', commune: 'Mokotów', buildingNumber: '1', city: 'Warszawa', postCode: '00-001',
  }),
}));

import { jpkFaBlocker } from '@/lib/exports/jpk-fa-readiness';

/**
 * W9 (C5a): paczka Co-Pilot dla księgowej sprawdza przed utworzeniem
 * eksportów, czy JPK_FA powstanie (jeden nieudany format wywraca paczkę).
 * Faktura z importu ze stawką spoza FaktWay albo zaimportowana korekta /
 * zaliczka / ROZ zablokuje JPK_FA — paczka ma dostać CSV, z powodem.
 */

let tables: MemoryTables;
/**
 * C5b: import zapisuje adnotacje z pliku w `fa3_data.annotations` — wiersz
 * z importu bez nich to import sprzed C5b (JPK odmawia z podpowiedzią). Domyślna
 * faktura testowa ma adnotacje jak po imporcie pliku bez procedur (świadoma
 * zmiana danych testu, opis w PR).
 */
const ADNOTACJE_IMPORTU = { cashMethod: 2, selfInvoicing: 2, reverseCharge: 2, splitPayment: 2, simplifiedProcedure: 2, newMeansOfTransport: 2 };
const faktura = (o: Record<string, unknown>) => ({
  tenant_id: 'firma-a', direction: 'outgoing', ksef_status: 'accepted', ksef_environment: 'test',
  issue_date: '2026-09-10', invoice_kind: 'regular', invoice_type: 'VAT', origin: 'ksef_import',
  fa3_data: { annotations: ADNOTACJE_IMPORTU }, ...o,
});
const blocker = () => jpkFaBlocker(memoryClient(tables) as never, {
  tenantId: 'firma-a', periodStart: '2026-09-01', periodEnd: '2026-09-30', includeCorrections: true,
});

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  tables = {
    tenants: [{ id: 'firma-a', nip: '5260001246' }],
    // C5c: VAT pozycji = VAT faktury co do grosza (świadoma zmiana danych testu —
    // bez VAT bazowa faktura z importu byłaby zatrzymana przez nową kontrolę VAT).
    invoices: [faktura({ id: 'fv-1', internal_number: 'FV/1', net_total: 100, vat_total: 23 })],
    invoice_line_items: [{ id: 'l-1', invoice_id: 'fv-1', vat_rate: '23', net_amount: 100, vat_amount: 23 }],
  };
});
afterEach(() => vi.unstubAllEnvs());

describe('jpkFaBlocker — dokumenty, których JPK nie wykaże poprawnie', () => {
  it('same stawki FaktWay → brak blokady', async () => {
    expect(await blocker()).toBeNull();
  });

  it('pozycja „0 WDT” z importu → powód z numerem faktury (paczka dostanie CSV)', async () => {
    tables.invoices!.push(faktura({ id: 'fv-wdt', internal_number: 'FV/WDT/1', ksef_number: '5260001246-20260910-0100A0B0C0D1-AF', net_total: 500 }));
    tables.invoice_line_items!.push({ id: 'l-2', invoice_id: 'fv-wdt', vat_rate: '0 WDT', net_amount: 500 });
    expect(await blocker()).toMatch(/JPK wstrzymany:.*FV\/WDT\/1.*0 WDT/);
  });

  it('zaimportowana korekta (invoice_kind regular, invoice_type KOR) → powód z numerem', async () => {
    tables.invoices!.push(faktura({ id: 'kor-1', internal_number: 'KOR/1', invoice_type: 'KOR' }));
    tables.invoice_line_items!.push({ id: 'l-3', invoice_id: 'kor-1', vat_rate: '23' });
    expect(await blocker()).toMatch(/JPK wstrzymany:.*KOR\/1/);
  });

  it('faktura z importu z pozycjami, które nie sumują się do netto (ceny brutto) → powód z numerem', async () => {
    tables.invoices!.push(faktura({ id: 'fv-br', internal_number: 'FV/BR/1', net_total: 500 }));
    tables.invoice_line_items!.push({ id: 'l-5', invoice_id: 'fv-br', vat_rate: '0', net_amount: 0 });
    expect(await blocker()).toMatch(/JPK wstrzymany:.*FV\/BR\/1/);
  });

  it('faktura z aplikacji ze stawką spoza FaktWay (dane historyczne) → powód z numerem', async () => {
    tables.invoices!.push(faktura({ id: 'fv-app', internal_number: 'FV/APP/1', origin: 'app', net_total: 100 }));
    tables.invoice_line_items!.push({ id: 'l-6', invoice_id: 'fv-app', vat_rate: '0 KR', net_amount: 100 });
    expect(await blocker()).toMatch(/JPK wstrzymany:.*FV\/APP\/1/);
  });

  it('C5b: faktura z importu z procedurą trójstronną (P_23) → powód z numerem', async () => {
    tables.invoices!.push(faktura({ id: 'fv-p23', internal_number: 'FV/P23/1', net_total: 100, fa3_data: { annotations: { ...ADNOTACJE_IMPORTU, simplifiedProcedure: 1 } } }));
    tables.invoice_line_items!.push({ id: 'l-7', invoice_id: 'fv-p23', vat_rate: '23', net_amount: 100 });
    expect(await blocker()).toMatch(/JPK wstrzymany:.*FV\/P23\/1.*procedura trójstronna/);
  });

  it('C5b: faktura z importu z oznaczeniem FP (do paragonu) → powód z numerem', async () => {
    tables.invoices!.push(faktura({ id: 'fv-fp', internal_number: 'FV/FP/1', net_total: 100, fa3_data: { annotations: ADNOTACJE_IMPORTU, ksefMarkers: { fp: true } } }));
    tables.invoice_line_items!.push({ id: 'l-8', invoice_id: 'fv-fp', vat_rate: '23', net_amount: 100 });
    expect(await blocker()).toMatch(/JPK wstrzymany:.*FV\/FP\/1.*\(FP\)/);
  });

  // Magiczny import wycofany (decyzja Bartosza 22.10.2026): adnotacje uzupełnia
  // synchronizacja historii KSeF sama — tekst kieruje do Importu danych i pomocy.
  it('C5b: faktura zaimportowana przed C5b (bez adnotacji) → powód z numerem i automatyczne uzupełnienie z KSeF', async () => {
    tables.invoices!.push(faktura({ id: 'fv-old', internal_number: 'FV/OLD/1', net_total: 100, fa3_data: { import: { source: 'ksef_history' }, parsed: {} } }));
    tables.invoice_line_items!.push({ id: 'l-9', invoice_id: 'fv-old', vat_rate: '23', net_amount: 100 });
    expect(await blocker()).toMatch(/JPK wstrzymany:.*FV\/OLD\/1.*uzupełnia te dane automatycznie.*Historia z KSeF/);
  });

  it('C5b: nieczytelne adnotacje z importu (annotationProblems) → powód z numerem', async () => {
    tables.invoices!.push(faktura({ id: 'fv-adn', internal_number: 'FV/ADN/1', net_total: 100, fa3_data: { annotations: ADNOTACJE_IMPORTU, annotationProblems: ['P_16 „tak”'] } }));
    tables.invoice_line_items!.push({ id: 'l-10', invoice_id: 'fv-adn', vat_rate: '23', net_amount: 100 });
    expect(await blocker()).toMatch(/JPK wstrzymany:.*FV\/ADN\/1.*nie udało się odczytać/);
  });

  it('C5b: różne daty sprzedaży pozycji z importu (saleDates.unclear) → powód z numerem', async () => {
    tables.invoices!.push(faktura({ id: 'fv-dat', internal_number: 'FV/DAT/1', net_total: 100, fa3_data: { annotations: ADNOTACJE_IMPORTU, saleDates: { unclear: true } } }));
    tables.invoice_line_items!.push({ id: 'l-11', invoice_id: 'fv-dat', vat_rate: '23', net_amount: 100 });
    expect(await blocker()).toMatch(/JPK wstrzymany:.*FV\/DAT\/1.*datami sprzedaży/);
  });

  it('C5b: zwolnienie (P_19) z importu przy pozycji 23% → powód z numerem (sprawdzenie z pozycjami)', async () => {
    tables.invoices!.push(faktura({ id: 'fv-zw', internal_number: 'FV/ZW/1', net_total: 100, fa3_data: { annotations: { ...ADNOTACJE_IMPORTU, vatExemptionBasis: 'art. 113 ust. 1' } } }));
    tables.invoice_line_items!.push({ id: 'l-12', invoice_id: 'fv-zw', vat_rate: '23', net_amount: 100 });
    expect(await blocker()).toMatch(/JPK wstrzymany:.*FV\/ZW\/1.*P_19/);
  });

  it('C5b: faktura z aplikacji bez adnotacji w fa3_data nie jest „importem sprzed C5b” (bramka po origin)', async () => {
    tables.invoices!.push(faktura({ id: 'fv-own', internal_number: 'FV/OWN/1', origin: 'app', net_total: 100, fa3_data: { lines: [] } }));
    tables.invoice_line_items!.push({ id: 'l-13', invoice_id: 'fv-own', vat_rate: '23', net_amount: 100 });
    expect(await blocker()).toBeNull();
  });

  it('C5c: VAT pozycji z importu różny od VAT faktury → powód z numerem (jak eksport)', async () => {
    tables.invoices!.push(faktura({ id: 'fv-vat', internal_number: 'FV/VAT/1', net_total: 100, vat_total: 23 }));
    tables.invoice_line_items!.push({ id: 'l-14', invoice_id: 'fv-vat', vat_rate: '23', net_amount: 100, vat_amount: 22 });
    expect(await blocker()).toMatch(/JPK wstrzymany:.*FV\/VAT\/1.*VAT/);
  });

  it('C5c: kwoty pozycji z importu nieprzeniesione wiernie (lineAmountProblems) → powód z numerem', async () => {
    tables.invoices!.push(faktura({ id: 'fv-kw', internal_number: 'FV/KW/1', net_total: 100, vat_total: 23, fa3_data: { annotations: ADNOTACJE_IMPORTU, lineAmountProblems: ['stawka 23: pozycje z wartością netto (P_11) i brutto (P_11A) naraz'] } }));
    tables.invoice_line_items!.push({ id: 'l-15', invoice_id: 'fv-kw', vat_rate: '23', net_amount: 100, vat_amount: 23 });
    expect(await blocker()).toMatch(/JPK wstrzymany:.*FV\/KW\/1.*naraz/);
  });

  it('dokument z innego środowiska KSeF nie blokuje (eksport go nie czyta)', async () => {
    tables.invoices!.push(faktura({ id: 'fv-prod', internal_number: 'FV/PROD/1', ksef_environment: 'production' }));
    tables.invoice_line_items!.push({ id: 'l-4', invoice_id: 'fv-prod', vat_rate: '0 WDT' });
    expect(await blocker()).toBeNull();
  });
});
