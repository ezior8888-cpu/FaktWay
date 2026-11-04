import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryTables, Row } from './helpers/baza-w-pamieci';

const db = vi.hoisted(() => ({ tables: {} as MemoryTables }));
vi.mock('@/lib/supabase/server', async () => {
  const { memoryClient: client } = await import('./helpers/baza-w-pamieci');
  return { createAdminClient: () => client(db.tables) };
});
vi.mock('@/lib/supabase/admin', async () => {
  const { memoryClient: client } = await import('./helpers/baza-w-pamieci');
  return { createAdminClient: () => client(db.tables) };
});

import { fetchInvoicesForExport } from '@/lib/exports/data-fetcher';
import { generateJpkFa } from '@/lib/exports/jpk-fa-generator';
import { validateJpkFa } from '@/lib/exports/jpk-fa-validator';
import { generateJpkV7m } from '@/lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';
import { parseFa3Xml, type ParsedInvoice } from '@/lib/import/fa3-parser';
import { processImportedInvoices } from '@/lib/import/import-engine';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import { validateFA3 } from '@/lib/xml/validator';
import type { Invoice, VatRate } from '@/types/invoice';

/**
 * C5c (plan „zero zgubionych faktur”, C5): import historii z KSeF czytał tylko
 * ceny netto (`P_9A`, `P_11`). Faktura w cenach brutto (art. 106e ust. 7–8:
 * `P_9B`, `P_11A`, podatek od SUMY brutto stawki) wchodziła z netto pozycji 0
 * i JPK jej odmawiał, a VAT pozycji import liczył sam (netto × stawka) — przy
 * fakturze, której wystawca liczył podatek od sumy (ust. 1 pkt 14, decyzja
 * Bartosza 06.10: też netto), JPK_FA i V7M różniły się od KSeF o grosze, po cichu.
 *
 * Łańcuch jak w C5a/C5b: plik FA(3) z generatora zmieniony tak, jak wystawiłby
 * go inny program, sprawdzony XSD MF → `parseFa3Xml` → `processImportedInvoices`
 * → `fetchInvoicesForExport` → JPK_FA(4) i JPK_V7M z walidacją XSD. Atrapa tylko
 * bazy. NIP fikcyjny 1234567890. Kwoty oczekiwane policzone w groszach całkowitych.
 */

const T = 'firma-a';
const NIP = '1234567890';
const ADRES = {
  voivodeship: 'MAZOWIECKIE', county: 'Warszawa', commune: 'Mokotów', street: 'ul. Testowa',
  buildingNumber: '1', city: 'Warszawa', postCode: '00-001',
};

let ksefCounter = 0;
const ksefNumber = () => `${NIP}-20260910-0100A0B0C0D${++ksefCounter}-AF`.slice(0, 35);

function invoice(number: string, lines: Array<{ rate: VatRate; net: number; qty?: number }>, o: Partial<Invoice> = {}): Invoice {
  const finalized = finalizeInvoice({
    internalNumber: number,
    type: 'VAT',
    issueDate: '2026-09-10',
    seller: { nip: NIP, name: 'Firma testowa', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' } },
    buyer: { nip: NIP, name: 'Nabywca testowy', address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' } },
    lines: lines.map((l, i) => ({ ordinal: i + 1, name: `Usługa ${i + 1}`, unit: 'usł.', quantity: l.qty ?? 1, unitPriceNet: l.net / (l.qty ?? 1), vatRate: l.rate })),
    payment: { currency: 'PLN', dueDate: '2026-09-24', method: 'transfer', bankAccount: '61109010140000071219812874' },
    ...o,
  } as Invoice);
  const needsBasis = lines.some((l) => l.rate === 'zw');
  return (needsBasis ? { ...finalized, annotations: { vatExemptionBasis: 'art. 113 ust. 1 ustawy o VAT' } } : finalized) as Invoice;
}
const xmlOf = (inv: Invoice) => generateFA3Xml(inv, { validate: false, generatedAt: new Date('2026-09-10T08:00:00Z') });

// ── Zmiany pliku bez RegExp z danych (CodeQL) ────────────────────────────────
/** Pierwszy element `<tag>…</tag>` (dokładna nazwa — `<P_13_1>` nie trafia w `<P_13_10>`). */
function setTag(xml: string, tag: string, value: string | null): string {
  const open = `<${tag}>`;
  const i = xml.indexOf(open);
  expect(i, `brak ${open}`).toBeGreaterThanOrEqual(0);
  const j = xml.indexOf(`</${tag}>`, i) + tag.length + 3;
  return xml.slice(0, i) + (value === null ? '' : `${open}${value}</${tag}>`) + xml.slice(j);
}
/** Pozycja `index` (od 0) w cenach brutto: P_9A → P_9B (+P_10), P_11 → P_11A (+P_11Vat). */
function grossLine(xml: string, index: number, o: { unit: string; gross: string; vat?: string; discount?: string; keepNet?: boolean }): string {
  const parts = xml.split('<FaWiersz>');
  expect(parts.length, 'za mało pozycji').toBeGreaterThan(index + 1);
  let seg = parts[index + 1]!;
  seg = setTag(seg, 'P_9A', null).replace('</P_8B>', `</P_8B><P_9B>${o.unit}</P_9B>${o.discount ? `<P_10>${o.discount}</P_10>` : ''}`);
  seg = o.keepNet
    ? seg.replace('</P_11>', `</P_11><P_11A>${o.gross}</P_11A>${o.vat ? `<P_11Vat>${o.vat}</P_11Vat>` : ''}`)
    : setTag(seg, 'P_11', null).replace('<P_12>', `<P_11A>${o.gross}</P_11A>${o.vat ? `<P_11Vat>${o.vat}</P_11Vat>` : ''}<P_12>`);
  parts[index + 1] = seg;
  return parts.join('<FaWiersz>');
}
const header = (xml: string, fields: Record<string, string | null>) =>
  Object.entries(fields).reduce((x, [tag, value]) => setTag(x, tag, value), xml);

async function expectSchemaValid(xml: string) {
  const result = await validateFA3(xml);
  expect(result.errors, 'plik testowy musi przejść XSD FA(3)').toEqual([]);
}

function parse(xml: string, ksef = ksefNumber()): ParsedInvoice {
  return parseFa3Xml(xml, { ksefNumber: ksef });
}
async function importParsed(...invoices: ParsedInvoice[]) {
  return processImportedInvoices({
    tenantId: T, importJobId: 'job-1', source: 'ksef_history', invoiceDirection: 'outgoing',
    invoiceKsefStatus: 'accepted', ksefEnvironment: 'test', invoices,
  });
}
const importXml = (xml: string) => importParsed(parse(xml));

const stored = (number: string) => db.tables.invoices!.find((r) => r.internal_number === number)!;
const lines = (number: string) => db.tables.invoice_line_items!
  .filter((l) => l.invoice_id === stored(number).id)
  .sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
const column = (number: string, key: string) => lines(number).map((l) => l[key]);

async function exportData() {
  return fetchInvoicesForExport({ tenantId: T, periodStart: '2026-09-01', periodEnd: '2026-09-30', direction: 'issued' });
}
async function jpkFa() {
  const data = await exportData();
  return generateJpkFa({
    issuer: { ...data.issuer, taxOfficeCode: '1433', registeredAddress: ADRES },
    periodStart: '2026-09-01', periodEnd: '2026-09-30', issuedInvoices: data.issuedInvoices,
    generatedAt: new Date('2026-10-01T08:00:00Z'),
  });
}
async function jpkV7m() {
  const data = await exportData();
  return generateJpkV7m({
    issuer: { nip: NIP, name: 'Firma testowa', email: 'biuro@example.test', taxOfficeCode: '1433' },
    periodStart: '2026-09-01', periodEnd: '2026-09-30', issuedInvoices: data.issuedInvoices,
    generatedAt: new Date('2026-10-01T10:00:00Z'),
  });
}
function fragment(xml: string, start: string, end: string): string {
  const i = xml.indexOf(start);
  expect(i, `brak ${start}`).toBeGreaterThanOrEqual(0);
  return xml.slice(i, xml.indexOf(end, i));
}
/** Wszystkie wiersze FakturaWiersz faktury (JPK_FA). */
function jpkLines(xml: string, number: string): string[] {
  return xml.split('<FakturaWiersz>').slice(1).filter((w) => w.includes(`<P_2B>${number}</P_2B>`));
}
async function expectJpkRefusal(number: string, reason: RegExp) {
  const refusal = (p: Promise<unknown>) => p.then(() => '', (e: unknown) => (e instanceof Error ? e.message : String(e)));
  for (const message of [await refusal(jpkFa()), await refusal(jpkV7m())]) {
    expect(message).toContain('JPK wstrzymany:');
    expect(message).toContain(`faktura ${number}`);
    expect(message).toMatch(reason);
  }
}
/** Wiersz bazy przejdzie przez JSON (supabase-js serializuje treść) — bez BigInt, NaN, Infinity. */
function expectJsonSafe(row: Row) {
  expect(JSON.parse(JSON.stringify(row))).toEqual(row);
}

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  ksefCounter = 0;
  db.tables = {
    tenants: [{ id: T, nip: NIP, name: 'Firma testowa', address_json: null }],
    invoices: [], invoice_line_items: [], contractors: [], products: [], expenses: [], xml_documents: [],
  };
});
afterEach(() => vi.unstubAllEnvs());

describe('C5c: faktura w cenach brutto (art. 106e ust. 7–8) — kwoty z pliku, VAT od sumy stawki', () => {
  // 3 × 33,33 brutto przy 23%: KP = round(99,99 × 23 / 123) = 18,70; netto = 81,29.
  const t1 = () => {
    let xml = xmlOf(invoice('FV/BR/3', [{ rate: '23', net: 27.10 }, { rate: '23', net: 27.10 }, { rate: '23', net: 27.10 }]));
    for (const i of [0, 1, 2]) xml = grossLine(xml, i, { unit: '33.33', gross: '33.33' });
    return header(xml, { P_13_1: '81.29', P_14_1: '18.70', P_15: '99.99' });
  };

  it('T1: 3 × 33,33 brutto → VAT 18,70 rozłożony (6,24 / 6,23 / 6,23), netto 81,29; JPK_FA P_9B/P_11A, V7M K_19/K_20 (XSD MF)', async () => {
    const xml = t1();
    await expectSchemaValid(xml);
    const result = await importXml(xml);
    expect(result.invoicesImported).toBe(1);
    expect(result.warnings.join('\n')).not.toMatch(/JPK_FA i JPK_V7M/);

    expect(column('FV/BR/3', 'net_amount')).toEqual([27.09, 27.10, 27.10]);
    expect(column('FV/BR/3', 'vat_amount')).toEqual([6.24, 6.23, 6.23]);
    expect(column('FV/BR/3', 'gross_amount')).toEqual([33.33, 33.33, 33.33]);
    // Cena netto nie wynika z pliku — nie zmyślamy jej (dotąd 0).
    expect(column('FV/BR/3', 'unit_price_net')).toEqual([null, null, null]);
    expect(stored('FV/BR/3')).toMatchObject({ net_total: 81.29, vat_total: 18.7, gross_total: 99.99 });
    expectJsonSafe(stored('FV/BR/3'));
    for (const l of lines('FV/BR/3')) expectJsonSafe(l);

    const fa = await jpkFa();
    const f = fragment(fa, '<P_2A>FV/BR/3', '</Faktura>');
    expect(f).toContain('<P_13_1>81.29</P_13_1>');
    expect(f).toContain('<P_14_1>18.70</P_14_1>');
    expect(f).toContain('<P_15>99.99</P_15>');
    const w = jpkLines(fa, 'FV/BR/3');
    expect(w).toHaveLength(3);
    for (const l of w) {
      expect(l).toContain('<P_9B>33.33</P_9B>');
      expect(l).toContain('<P_11A>33.33</P_11A>');
      expect(l).not.toContain('<P_9A>');
      expect(l).not.toContain('<P_11>');
    }
    expect((await validateJpkFa(fa)).errors).toEqual([]);

    const v7m = await jpkV7m();
    const s = fragment(v7m, 'FV/BR/3', '</SprzedazWiersz>');
    expect(s).toContain('<K_19>81.29</K_19>');
    expect(s).toContain('<K_20>18.70</K_20>');
    expect((await validateJpkV7m(v7m)).errors).toEqual([]);
  });

  it('T1 ponowienie joba (ten sam plik) → duplikat bez błędu, pozycje bez zmian', async () => {
    const parsed = parse(t1());
    await importParsed(parsed);
    const before = structuredClone(lines('FV/BR/3'));
    const again = await importParsed(parsed);
    expect(again.invoicesFailed).toBe(0);
    expect(lines('FV/BR/3')).toEqual(before);
  });

  it('T2: VAT pozycji podany w pliku (P_11Vat, art. 106e ust. 10) → z pliku', async () => {
    let xml = xmlOf(invoice('FV/BR/V', [{ rate: '23', net: 27.10 }, { rate: '23', net: 27.10 }, { rate: '23', net: 27.10 }]));
    // VAT pozycji różny od podziału nagłówka (6,23 × 3) — widać, że jest z pliku.
    xml = grossLine(xml, 0, { unit: '33.33', gross: '33.33', vat: '6.24' });
    xml = grossLine(xml, 1, { unit: '33.33', gross: '33.33', vat: '6.22' });
    xml = grossLine(xml, 2, { unit: '33.33', gross: '33.33', vat: '6.23' });
    xml = header(xml, { P_13_1: '81.30', P_14_1: '18.69', P_15: '99.99' });
    await expectSchemaValid(xml);
    await importXml(xml);
    expect(column('FV/BR/V', 'vat_amount')).toEqual([6.24, 6.22, 6.23]);
    expect(column('FV/BR/V', 'net_amount')).toEqual([27.09, 27.11, 27.10]);
    expect(fragment(await jpkFa(), '<P_2A>FV/BR/V', '</Faktura>')).toContain('<P_14_1>18.69</P_14_1>');
  });

  it('T4: największa reszta i remis po numerze pozycji (10,00 / 1,00 / 1,00 brutto, VAT 2,24)', async () => {
    let xml = xmlOf(invoice('FV/BR/R', [{ rate: '23', net: 8.13 }, { rate: '23', net: 0.81 }, { rate: '23', net: 0.82 }]));
    xml = grossLine(xml, 0, { unit: '10.00', gross: '10.00' });
    xml = grossLine(xml, 1, { unit: '1.00', gross: '1.00' });
    xml = grossLine(xml, 2, { unit: '1.00', gross: '1.00' });
    xml = header(xml, { P_13_1: '9.76', P_14_1: '2.24', P_15: '12.00' });
    await expectSchemaValid(xml);
    await importXml(xml);
    expect(column('FV/BR/R', 'vat_amount')).toEqual([1.87, 0.19, 0.18]);
    expect(column('FV/BR/R', 'net_amount')).toEqual([8.13, 0.81, 0.82]);
  });

  it('T5: trzy stawki brutto (23, 8, zw) → netto i VAT każdej stawki jak w nagłówku; V7M', async () => {
    let xml = xmlOf(invoice('FV/BR/M', [{ rate: '23', net: 100 }, { rate: '8', net: 100 }, { rate: 'zw', net: 50 }]));
    xml = grossLine(xml, 0, { unit: '123.00', gross: '123.00' });
    xml = grossLine(xml, 1, { unit: '108.00', gross: '108.00' });
    xml = grossLine(xml, 2, { unit: '50.00', gross: '50.00' });
    await expectSchemaValid(xml);
    await importXml(xml);
    expect(column('FV/BR/M', 'net_amount')).toEqual([100, 100, 50]);
    expect(column('FV/BR/M', 'vat_amount')).toEqual([23, 8, 0]);
    const f = fragment(await jpkFa(), '<P_2A>FV/BR/M', '</Faktura>');
    for (const v of ['<P_13_1>100.00</P_13_1>', '<P_14_1>23.00</P_14_1>', '<P_13_2>100.00</P_13_2>', '<P_14_2>8.00</P_14_2>', '<P_13_7>50.00</P_13_7>', '<P_15>281.00</P_15>']) {
      expect(f).toContain(v);
    }
    const s = fragment(await jpkV7m(), 'FV/BR/M', '</SprzedazWiersz>');
    for (const v of ['<K_19>100.00</K_19>', '<K_20>23.00</K_20>', '<K_17>100.00</K_17>', '<K_18>8.00</K_18>', '<K_10>50.00</K_10>']) {
      expect(s).toContain(v);
    }
  });

  it('pozycja ujemna (rabat brutto) → podłoga i reszta poprawne: VAT 18,70 / −1,87, netto 81,30 / −8,13', async () => {
    let xml = xmlOf(invoice('FV/BR/N', [{ rate: '23', net: 81.30 }, { rate: '23', net: -8.13 }]));
    xml = grossLine(xml, 0, { unit: '100.00', gross: '100.00' });
    xml = grossLine(xml, 1, { unit: '-10.00', gross: '-10.00' });
    xml = header(xml, { P_13_1: '73.17', P_14_1: '16.83', P_15: '90.00' });
    await expectSchemaValid(xml);
    await importXml(xml);
    expect(column('FV/BR/N', 'vat_amount')).toEqual([18.7, -1.87]);
    expect(column('FV/BR/N', 'net_amount')).toEqual([81.3, -8.13]);
    expect(fragment(await jpkFa(), '<P_2A>FV/BR/N', '</Faktura>')).toContain('<P_14_1>16.83</P_14_1>');
  });

  it('P_10 (rabat) i ilość → kwoty z P_11A, cena netto nie wyliczana; JPK_FA P_8B / P_9B / P_10 / P_11A', async () => {
    let xml = xmlOf(invoice('FV/BR/D', [{ rate: '23', net: 73.17, qty: 2 }]));
    xml = grossLine(xml, 0, { unit: '50.00', gross: '90.00', discount: '10.00' });
    xml = header(xml, { P_13_1: '73.17', P_14_1: '16.83', P_15: '90.00' });
    await expectSchemaValid(xml);
    await importXml(xml);
    expect(lines('FV/BR/D')[0]).toMatchObject({ unit_price_net: null, net_amount: 73.17, vat_amount: 16.83, quantity: 2 });
    const [w] = jpkLines(await jpkFa(), 'FV/BR/D');
    expect(w).toContain('<P_8B>2</P_8B>');
    expect(w).toContain('<P_9B>50.00</P_9B>');
    expect(w).toContain('<P_10>10.00</P_10>');
    expect(w).toContain('<P_11A>90.00</P_11A>');
  });

  it('pozycja z P_11 i P_11A → VAT = P_11A − P_11; JPK_FA zapisuje oba, suma kontrolna z P_11', async () => {
    let xml = xmlOf(invoice('FV/BR/B', [{ rate: '23', net: 100 }]));
    xml = grossLine(xml, 0, { unit: '123.00', gross: '123.00', keepNet: true });
    await expectSchemaValid(xml);
    await importXml(xml);
    expect(lines('FV/BR/B')[0]).toMatchObject({ net_amount: 100, vat_amount: 23, gross_amount: 123 });
    const fa = await jpkFa();
    const [w] = jpkLines(fa, 'FV/BR/B');
    expect(w).toContain('<P_11>100.00</P_11>');
    expect(w).toContain('<P_11A>123.00</P_11A>');
    expect(fragment(fa, '<FakturaWierszCtrl>', '</FakturaWierszCtrl>')).toContain('<WartoscWierszyFaktur>100.00</WartoscWierszyFaktur>');
  });

  it('suma kontrolna JPK_FA: tylko zapisane P_11 (pozycja wyłącznie brutto się nie liczy)', async () => {
    // Dwie stawki: w jednej stawce mieszanka P_11+P_11A z samym P_11A byłaby zatrzymana (VAT tylko przy części).
    let xml = xmlOf(invoice('FV/BR/C', [{ rate: '23', net: 100 }, { rate: '8', net: 100 }]));
    xml = grossLine(xml, 0, { unit: '123.00', gross: '123.00', keepNet: true });
    xml = grossLine(xml, 1, { unit: '108.00', gross: '108.00' });
    await expectSchemaValid(xml);
    await importXml(xml);
    const fa = await jpkFa();
    expect(fragment(fa, '<FakturaWierszCtrl>', '</FakturaWierszCtrl>')).toContain('<WartoscWierszyFaktur>100.00</WartoscWierszyFaktur>');
  });

  it('produkt z faktury brutto → domyślna cena netto pusta (nie 0)', async () => {
    await importXml(t1());
    const product = db.tables.products!.find((p) => p.name === 'Usługa 1');
    expect(product, 'brak produktu z importu').toBeDefined();
    expect(product!.default_price_net).toBeNull();
  });
});

describe('C5c: faktura netto innego programu — VAT od sumy stawki (art. 106e ust. 1 pkt 14; decyzja Bartosza 06.10)', () => {
  it('3 × 0,10 netto przy 23%, P_14_1 = 0,07 (od sumy) → VAT pozycji 0,03 / 0,02 / 0,02; JPK 0,07, nie 0,06', async () => {
    let xml = xmlOf(invoice('FV/NET/3', [{ rate: '23', net: 0.10 }, { rate: '23', net: 0.10 }, { rate: '23', net: 0.10 }]));
    xml = header(xml, { P_14_1: '0.07', P_15: '0.37' });
    await expectSchemaValid(xml);
    await importXml(xml);
    expect(column('FV/NET/3', 'vat_amount')).toEqual([0.03, 0.02, 0.02]);
    expect(column('FV/NET/3', 'unit_price_net')).toEqual([0.1, 0.1, 0.1]);
    expect(fragment(await jpkFa(), '<P_2A>FV/NET/3', '</Faktura>')).toContain('<P_14_1>0.07</P_14_1>');
    expect(fragment(await jpkV7m(), 'FV/NET/3', '</SprzedazWiersz>')).toContain('<K_20>0.07</K_20>');
  });

  it('faktura uproszczona bez sum nagłówka, jedna stawka → VAT od sumy netto stawki (0,07), rozłożony, zgodny z P_15', async () => {
    let xml = xmlOf(invoice('FV/UPR/1', [{ rate: '23', net: 0.10 }, { rate: '23', net: 0.10 }, { rate: '23', net: 0.10 }]));
    xml = header(xml, { P_13_1: null, P_14_1: null, P_15: '0.37' });
    await expectSchemaValid(xml);
    await importXml(xml);
    expect(column('FV/UPR/1', 'vat_amount')).toEqual([0.03, 0.02, 0.02]);
    expect(stored('FV/UPR/1')).toMatchObject({ net_total: 0.3, vat_total: 0.07 });
  });
});

describe('C5c: kwoty, których nie da się wiernie przenieść — zatrzymanie z numerem (nic nie zgadujemy)', () => {
  it.each([
    ['pozycje netto i brutto w jednej stawce', 'FV/MIX/2', () => {
      const xml = xmlOf(invoice('FV/MIX/2', [{ rate: '23', net: 100 }, { rate: '23', net: 100 }]));
      return grossLine(xml, 1, { unit: '123.00', gross: '123.00' });
    }, /netto \(P_11\) i brutto \(P_11A\) naraz/],
    ['P_11Vat tylko przy części pozycji (decyzja: zatrzymać)', 'FV/BR/P5', () => {
      let xml = xmlOf(invoice('FV/BR/P5', [{ rate: '23', net: 27.10 }, { rate: '23', net: 27.10 }, { rate: '23', net: 27.10 }]));
      xml = grossLine(xml, 0, { unit: '33.33', gross: '33.33', vat: '6.23' });
      for (const i of [1, 2]) xml = grossLine(xml, i, { unit: '33.33', gross: '33.33' });
      return header(xml, { P_13_1: '81.30', P_14_1: '18.69', P_15: '99.99' });
    }, /P_11Vat.*tylko przy części pozycji/],
    ['suma P_11Vat ≠ VAT nagłówka (decyzja: zatrzymać)', 'FV/BR/P6', () => {
      let xml = xmlOf(invoice('FV/BR/P6', [{ rate: '23', net: 27.10 }, { rate: '23', net: 27.10 }, { rate: '23', net: 27.10 }]));
      for (const i of [0, 1, 2]) xml = grossLine(xml, i, { unit: '33.33', gross: '33.33', vat: '6.23' });
      return header(xml, { P_13_1: '81.29', P_14_1: '18.70', P_15: '99.99' });
    }, /VAT pozycji 18\.69 ≠ VAT z nagłówka 18\.70/],
    ['VAT nagłówka poza możliwym zakresem', 'FV/BR/X', () => {
      const xml = grossLine(xmlOf(invoice('FV/BR/X', [{ rate: '23', net: 100 }])), 0, { unit: '123.00', gross: '123.00' });
      return header(xml, { P_13_1: '99.99', P_14_1: '23.01' });
    }, /VAT z nagłówka 23\.01 nie wynika z wartości pozycji/],
    ['brutto pozycji ≠ netto + VAT nagłówka', 'FV/BR23/2', () => {
      const xml = grossLine(xmlOf(invoice('FV/BR23/2', [{ rate: '23', net: 500 }])), 0, { unit: '500.00', gross: '500.00' });
      return xml;
    }, /brutto pozycji 500\.00 ≠ netto 500\.00 \+ VAT 115\.00/],
    ['netto pozycji ≠ netto nagłówka (dokładnie, nie z tolerancją)', 'FV/NET/X', () => {
      const xml = xmlOf(invoice('FV/NET/X', [{ rate: '23', net: 33.33 }, { rate: '23', net: 33.33 }, { rate: '23', net: 33.33 }]));
      return header(xml, { P_13_1: '100.00', P_14_1: '23.00', P_15: '123.00' });
    }, /netto pozycji 99\.99 ≠ netto z nagłówka 100\.00/],
    ['suma w nagłówku bez pozycji tej stawki', 'FV/PUSTA/1', () => {
      const xml = xmlOf(invoice('FV/PUSTA/1', [{ rate: '23', net: 100 }]));
      return xml.replace('<P_15>', '<P_13_2>50.00</P_13_2><P_14_2>4.00</P_14_2><P_15>');
    }, /suma P_13_2 bez pozycji/],
    ['ceny brutto bez sum nagłówka, pozycje ≠ P_15', 'FV/BR/U', () => {
      const xml = grossLine(xmlOf(invoice('FV/BR/U', [{ rate: '23', net: 100 }])), 0, { unit: '123.00', gross: '123.00' });
      return header(xml, { P_13_1: null, P_14_1: null, P_15: '120.00' });
    }, /brutto pozycji 123\.00 ≠ P_15 120\.00/],
  ])('%s → ostrzeżenie i odmowa JPK z numerem', async (_name, number, build, reason) => {
    const xml = build();
    await expectSchemaValid(xml);
    const result = await importXml(xml);
    expect(result.invoicesImported).toBe(1);
    expect(result.warnings[0]).toContain(number);
    await expectJpkRefusal(number, reason);
  });

  it('faktura uproszczona w cenach brutto przy 23% bez sum stawek → VAT ze wzoru ust. 7 (od sumy brutto stawki)', async () => {
    const xml = header(grossLine(xmlOf(invoice('FV/UPR/23', [{ rate: '23', net: 100 }])), 0, { unit: '123.00', gross: '123.00' }), { P_13_1: null, P_14_1: null });
    await expectSchemaValid(xml);
    await importXml(xml);
    expect(lines('FV/UPR/23')[0]).toMatchObject({ net_amount: 100, vat_amount: 23, gross_amount: 123 });
    expect(stored('FV/UPR/23')).toMatchObject({ net_total: 100, vat_total: 23 });
    const f = fragment(await jpkFa(), '<P_2A>FV/UPR/23', '</Faktura>');
    expect(f).toContain('<P_13_1>100.00</P_13_1>');
    expect(f).toContain('<P_14_1>23.00</P_14_1>');
  });

  it('faktura uproszczona w cenach brutto przy zw bez sum stawek → netto faktury z pozycji, JPK z P_13_7', async () => {
    let xml = xmlOf(invoice('FV/UPR/ZW', [{ rate: 'zw', net: 50 }, { rate: 'zw', net: 30 }]));
    xml = grossLine(xml, 0, { unit: '50.00', gross: '50.00' });
    xml = grossLine(xml, 1, { unit: '30.00', gross: '30.00' });
    xml = header(xml, { P_13_7: null });
    await expectSchemaValid(xml);
    const result = await importXml(xml);
    expect(result.warnings.join('\n')).not.toMatch(/JPK_FA i JPK_V7M/);
    expect(stored('FV/UPR/ZW')).toMatchObject({ net_total: 80, vat_total: 0, gross_total: 80 });
    expect(fragment(await jpkFa(), '<P_2A>FV/UPR/ZW', '</Faktura>')).toContain('<P_13_7>80.00</P_13_7>');
  });

  it('odmowa JPK przy nieznanych kwotach faktury mówi, że KPiR i CSV też ich nie pokażą (eksport i paczka)', async () => {
    const xml = header(grossLine(xmlOf(invoice('FV/BR/U3', [{ rate: '23', net: 100 }, { rate: '8', net: 50 }])), 0, { unit: '123.00', gross: '123.00' }), { P_13_1: null, P_14_1: null });
    await importXml(xml);
    await expectJpkRefusal('FV/BR/U3', /KPiR i CSV też nie pokażą/);
    const { jpkFaBlocker } = await import('@/lib/exports/jpk-fa-readiness');
    const { memoryClient } = await import('./helpers/baza-w-pamieci');
    const blocker = await jpkFaBlocker(memoryClient(db.tables) as never, { tenantId: T, periodStart: '2026-09-01', periodEnd: '2026-09-30', includeCorrections: true });
    expect(blocker).toMatch(/FV\/BR\/U3.*KPiR i CSV też nie pokażą/);
  });

  it('pozycja w bazie bez pól z pliku (ksefLineFields bez jej numeru) → odmowa eksportu i paczki z numerem', async () => {
    const xml = grossLine(xmlOf(invoice('FV/BR/F', [{ rate: '23', net: 100 }])), 0, { unit: '123.00', gross: '123.00' });
    await importXml(xml);
    const row = stored('FV/BR/F');
    (row.fa3_data as Record<string, unknown>).ksefLineFields = [];
    await expectJpkRefusal('FV/BR/F', /pozycja 1 bez pól z pliku KSeF/);
    const { jpkFaBlocker } = await import('@/lib/exports/jpk-fa-readiness');
    const { memoryClient } = await import('./helpers/baza-w-pamieci');
    const blocker = await jpkFaBlocker(memoryClient(db.tables) as never, { tenantId: T, periodStart: '2026-09-01', periodEnd: '2026-09-30', includeCorrections: true });
    expect(blocker).toMatch(/FV\/BR\/F.*bez pól z pliku KSeF/);
  });

  it('ceny brutto bez sum nagłówka → komunikat mówi wprost, że KPiR i CSV nie znają kwot (nie „działają”)', async () => {
    const xml = header(grossLine(xmlOf(invoice('FV/BR/U2', [{ rate: '23', net: 100 }])), 0, { unit: '123.00', gross: '123.00' }), { P_13_1: null, P_14_1: null, P_15: '120.00' });
    const result = await importXml(xml);
    expect(result.warnings[0]).toContain('FV/BR/U2');
    expect(result.warnings[0]).toMatch(/KPiR i CSV też nie pokażą/);
    expect(result.warnings[0]).not.toMatch(/KPiR i CSV działają/);
  });

  it('zatrzymana stawka: pozycje brutto zapisane bez zgadywania VAT (0), jak dotąd', async () => {
    const xml = grossLine(xmlOf(invoice('FV/MIX/3', [{ rate: '23', net: 100 }, { rate: '23', net: 100 }])), 1, { unit: '123.00', gross: '123.00' });
    await importXml(xml);
    expect(lines('FV/MIX/3')[1]).toMatchObject({ vat_amount: 0, unit_price_net: null });
  });

  it('powtórzone numery pozycji (NrWierszaFa) przy cenach brutto → zatrzymane', async () => {
    let xml = xmlOf(invoice('FV/DUP/1', [{ rate: '23', net: 100 }, { rate: '23', net: 100 }]));
    for (const i of [0, 1]) xml = grossLine(xml, i, { unit: '123.00', gross: '123.00' });
    xml = xml.replace('<NrWierszaFa>2</NrWierszaFa>', '<NrWierszaFa>1</NrWierszaFa>');
    await expectSchemaValid(xml);
    await importXml(xml);
    await expectJpkRefusal('FV/DUP/1', /NrWierszaFa\) powtarzają się/);
  });

  it('powtórzone numery pozycji przy cenach netto → JPK z pozycji z bazy, bez zatrzymania', async () => {
    const xml = xmlOf(invoice('FV/DUP/2', [{ rate: '23', net: 100 }, { rate: '8', net: 100 }]))
      .replace('<NrWierszaFa>2</NrWierszaFa>', '<NrWierszaFa>1</NrWierszaFa>');
    await importXml(xml);
    expect(fragment(await jpkFa(), '<P_2A>FV/DUP/2', '</Faktura>')).toContain('<P_13_2>100.00</P_13_2>');
  });

  it('zaimportowana korekta → pozycje jak dotąd, bez powodów kwotowych (odmowa z rodzaju, C5a)', async () => {
    const xml = xmlOf(invoice('KOR/BR/1', [{ rate: '23', net: 100 }])).replace('<RodzajFaktury>VAT</RodzajFaktury>', '<RodzajFaktury>KOR</RodzajFaktury>');
    const result = await importXml(xml);
    expect(result.warnings.join('\n')).not.toMatch(/kwot pozycji/);
    expect(stored('KOR/BR/1').fa3_data).not.toHaveProperty('lineAmountProblems');
  });
});
