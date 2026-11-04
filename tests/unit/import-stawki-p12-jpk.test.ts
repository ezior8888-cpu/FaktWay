import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryTables, Row } from './helpers/baza-w-pamieci';

const db = vi.hoisted(() => ({ tables: {} as MemoryTables, failInsertInto: [] as string[] }));
vi.mock('@/lib/supabase/server', async () => {
  const { memoryClient: client } = await import('./helpers/baza-w-pamieci');
  return { createAdminClient: () => client(db.tables, { failInsertInto: db.failInsertInto }) };
});
vi.mock('@/lib/supabase/admin', async () => {
  const { memoryClient: client } = await import('./helpers/baza-w-pamieci');
  return { createAdminClient: () => client(db.tables, { failInsertInto: db.failInsertInto }) };
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
import type { Invoice, VatRate } from '@/types/invoice';

/**
 * W9 (plan „zero zgubionych faktur”, sesja C5a): import historii z KSeF
 * zapisywał P_12 z FA(3) dosłownie (`0 KR`, `np I`, `np II`) jako stawkę
 * pozycji, a eksporty znają tylko stawki FaktWay (`0`, `np`, `np_ii`).
 * JPK_FA i JPK_V7M padały na całym miesiącu z jedną taką fakturą.
 *
 * Prawdziwy łańcuch: plik FA(3) z generatora FaktWay (taki, jaki KSeF
 * przyjął) → `parseFa3Xml` → `processImportedInvoices` (zapis do bazy
 * w pamięci) → `fetchInvoicesForExport` (te same wiersze) → generator JPK
 * i walidacja XSD MF.
 */

const T = 'firma-a';
const NIP = '5260001246';
const ADRES = {
  voivodeship: 'MAZOWIECKIE', county: 'Warszawa', commune: 'Mokotów', street: 'ul. Puławska',
  buildingNumber: '12', city: 'Warszawa', postCode: '02-566',
};

let ksefCounter = 0;
const ksefNumber = () => `${NIP}-20260910-0100A0B0C0D${String(++ksefCounter).padStart(1, '0')}-AF`.slice(0, 35);

const EU_BUYER = { vatUeNumber: 'DE123456789', name: 'Kunde GmbH', address: { countryCode: 'DE', addressLine1: 'Hauptstraße 1', addressLine2: '10115 Berlin' } };
const EXEMPT = { annotations: { vatExemptionBasis: 'art. 113 ust. 1 ustawy o VAT' } } as Partial<Invoice>;

function invoice(number: string, lines: Array<{ rate: VatRate; net: number }>, o: Partial<Invoice> = {}): Invoice {
  const needsEuBuyer = lines.some((l) => l.rate === 'np_ii');
  const needsBasis = lines.some((l) => l.rate === 'zw');
  const finalized = finalizeInvoice({
    internalNumber: number,
    type: 'VAT',
    issueDate: '2026-09-10',
    saleDate: '2026-09-10',
    seller: { nip: NIP, name: 'ACME sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. Puławska 12', addressLine2: '02-566 Warszawa' } },
    buyer: { nip: '5252241585', name: 'Klient Sp. z o.o.', address: { countryCode: 'PL', addressLine1: 'ul. Klienta 10', addressLine2: '02-001 Warszawa' } },
    lines: lines.map((l, i) => ({ ordinal: i + 1, name: `Usługa ${i + 1}`, unit: 'usł.', quantity: 1, unitPriceNet: l.net, vatRate: l.rate })),
    payment: { currency: 'PLN', dueDate: '2026-09-24', method: 'transfer', bankAccount: 'PL61109010140000071219812874' },
    ...(needsEuBuyer ? { buyer: EU_BUYER } : {}),
    ...o,
  } as Invoice);
  // Adnotacje dokleja się po wyliczeniu sum (jak `buildInvoiceFromForm`).
  return (needsBasis ? { ...finalized, ...EXEMPT } : finalized) as Invoice;
}

const xmlOf = (inv: Invoice) => generateFA3Xml(inv, { generatedAt: new Date('2026-09-10T08:00:00Z') });

async function importXml(...xmls: string[]) {
  return importParsed(xmls.map((xml) => parseFa3Xml(xml, { ksefNumber: ksefNumber() })));
}

function importParsed(
  invoices: ParsedInvoice[],
  o: { direction?: 'outgoing' | 'incoming'; status?: string; source?: string } = {},
) {
  return processImportedInvoices({
    tenantId: T,
    importJobId: 'job-1',
    source: o.source ?? 'ksef_history',
    invoiceDirection: o.direction ?? 'outgoing',
    invoiceKsefStatus: o.status ?? 'accepted',
    ksefEnvironment: 'test',
    invoices,
  });
}

const storedRates = (number: string) => {
  const inv = db.tables.invoices!.find((r) => r.internal_number === number)!;
  return db.tables.invoice_line_items!.filter((l) => l.invoice_id === inv.id).map((l) => l.vat_rate);
};

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
    issuer: { nip: NIP, name: 'ACME sp. z o.o.', email: 'biuro@example.test', taxOfficeCode: '1433' },
    periodStart: '2026-09-01', periodEnd: '2026-09-30', issuedInvoices: data.issuedInvoices,
    generatedAt: new Date('2026-10-01T10:00:00Z'),
  });
}

function fragment(xml: string, start: string, end: string): string {
  const i = xml.indexOf(start);
  expect(i, `brak ${start}`).toBeGreaterThanOrEqual(0);
  return xml.slice(i, xml.indexOf(end, i));
}

/** Plik FA(3) z podmienionym P_12 pozycji (i polem sumy nagłówka). */
const withP12 = (xml: string, from: string, to: string) => xml.replace(`<P_12>${from}</P_12>`, `<P_12>${to}</P_12>`);
const withoutP12 = (xml: string) => xml.replace(/<P_12>[^<]*<\/P_12>/g, '');

beforeEach(() => {
  vi.stubEnv('KSEF_ENV', 'test');
  ksefCounter = 0;
  db.failInsertInto = [];
  db.tables = {
    tenants: [{ id: T, nip: NIP, name: 'ACME sp. z o.o.', address_json: null }],
    invoices: [], invoice_line_items: [], contractors: [], products: [], expenses: [], xml_documents: [],
  };
});
afterEach(() => vi.unstubAllEnvs());

describe('W9: stawki FA(3) z importu historii KSeF → stawki FaktWay', () => {
  it('JPK_V7M za miesiąc z jedną zaimportowaną fakturą „np II”: K_11 = K_12 = netto (DoD planu C5)', async () => {
    await importXml(xmlOf(invoice('FV/NP2/1', [{ rate: 'np_ii', net: 2000 }])));

    const xml = await jpkV7m();

    const w = fragment(xml, 'FV/NP2/1', '</SprzedazWiersz>');
    expect(w).toContain('<K_11>2000.00</K_11>');
    expect(w).toContain('<K_12>2000.00</K_12>');
    expect((await validateJpkV7m(xml)).errors).toEqual([]);
  });

  it('JPK_FA dla „0 KR”, „np I”, „np II” z importu: P_13_6, P_13_5, P_12 pozycji „0”/„np”, P_18 tylko przy np II', async () => {
    await importXml(
      xmlOf(invoice('FV/0KR/1', [{ rate: '0', net: 100 }])),
      xmlOf(invoice('FV/NP1/1', [{ rate: 'np', net: 200 }])),
      xmlOf(invoice('FV/NP2/1', [{ rate: 'np_ii', net: 300 }])),
    );

    const xml = await jpkFa();

    expect((await validateJpkFa(xml)).errors).toEqual([]);
    const kr = fragment(xml, '<P_2A>FV/0KR/1</P_2A>', '</Faktura>');
    expect(kr).toContain('<P_13_6>100.00</P_13_6>');
    expect(kr).toContain('<P_18>false</P_18>');
    const np1 = fragment(xml, '<P_2A>FV/NP1/1</P_2A>', '</Faktura>');
    expect(np1).toContain('<P_13_5>200.00</P_13_5>');
    expect(np1).toContain('<P_18>false</P_18>');
    const np2 = fragment(xml, '<P_2A>FV/NP2/1</P_2A>', '</Faktura>');
    expect(np2).toContain('<P_13_5>300.00</P_13_5>');
    expect(np2).toContain('<P_18>true</P_18>');
    expect(fragment(xml, '<P_2B>FV/0KR/1</P_2B>', '</FakturaWiersz>')).toContain('<P_12>0</P_12>');
    expect(fragment(xml, '<P_2B>FV/NP2/1</P_2B>', '</FakturaWiersz>')).toContain('<P_12>np</P_12>');
  });

  it.each([
    ['23', '23'], ['8', '8'], ['5', '5'], ['0', '0'], ['zw', 'zw'], ['oo', 'oo'], ['np', 'np'], ['np_ii', 'np_ii'],
  ] as Array<[VatRate, string]>)('plik FaktWay ze stawką %s → w bazie stawka FaktWay „%s”', async (rate, stored) => {
    await importXml(xmlOf(invoice(`FV/${rate}/1`, [{ rate, net: 100 }])));
    expect(storedRates(`FV/${rate}/1`)).toEqual([stored]);
  });

  it('białe znaki w kodzie (XSD token: „np  II”) → np_ii', async () => {
    await importXml(withP12(xmlOf(invoice('FV/WS/1', [{ rate: 'np_ii', net: 100 }])), 'np II', 'np  II'));
    expect(storedRates('FV/WS/1')).toEqual(['np_ii']);
  });
});

describe('W9: stawki FA(3) bez odpowiednika w FaktWay — zapis bez przekłamania, JPK odmawia z nazwą dokumentu', () => {
  const wdt = () => xmlOf(invoice('FV/WDT/1', [{ rate: '0', net: 500 }]))
    .replace('<P_12>0 KR</P_12>', '<P_12>0 WDT</P_12>')
    .replace(/<P_13_6_1>([^<]*)<\/P_13_6_1>/, '<P_13_6_2>$1</P_13_6_2>');

  it('„0 WDT”: faktura zapisana ze stawką „0 WDT” (nigdy „0” — inne pole JPK), ostrzeżenie importu z numerem', async () => {
    const result = await importXml(wdt(), xmlOf(invoice('FV/23/1', [{ rate: '23', net: 100 }])));

    expect(result.invoicesImported).toBe(2);
    expect(storedRates('FV/WDT/1')).toEqual(['0 WDT']);
    expect(result.warnings[0]).toContain('FV/WDT/1');
    expect(result.warnings[0]).toContain('0 WDT');
    expect(result.warnings[0]).toContain('JPK');
  });

  it('„0 WDT” w okresie: JPK_FA i JPK_V7M nie powstają — odmowa z numerem faktury, nie ogólny błąd', async () => {
    await importXml(wdt(), xmlOf(invoice('FV/23/1', [{ rate: '23', net: 100 }])));

    await expect(jpkFa()).rejects.toThrow(/JPK wstrzymany:.*FV\/WDT\/1.*0 WDT/);
    await expect(jpkV7m()).rejects.toThrow(/JPK wstrzymany:.*FV\/WDT\/1.*0 WDT/);
  });
});

describe('W9: pozycja bez P_12 — stawka z nagłówka, gdy wynika jednoznacznie', () => {
  it('uproszczona bez P_12, nagłówek 23% (P_13_1 + P_14_1) → „23” (bez regresji)', async () => {
    await importXml(withoutP12(xmlOf(invoice('FV/UPR/1', [{ rate: '23', net: 100 }]))));
    expect(storedRates('FV/UPR/1')).toEqual(['23']);
  });

  it('zwolniona bez P_12, w nagłówku tylko P_13_7 → „zw” (nie domyślne 23%)', async () => {
    const xml = withoutP12(xmlOf(invoice('FV/ZW/1', [{ rate: 'zw', net: 100 }])));
    await importXml(xml);
    expect(storedRates('FV/ZW/1')).toEqual(['zw']);
    expect(fragment(await jpkFa(), '<P_2A>FV/ZW/1</P_2A>', '</Faktura>')).toContain('<P_13_7>100.00</P_13_7>');
  });

  it('zwolniona bez P_12 i bez sum (art. 106e ust. 4 pkt 3), P_19 = 1 → „zw”', async () => {
    const xml = withoutP12(xmlOf(invoice('FV/ZW/2', [{ rate: 'zw', net: 100 }])))
      .replace(/<P_13_7>[^<]*<\/P_13_7>/, '');
    await importXml(xml);
    expect(storedRates('FV/ZW/2')).toEqual(['zw']);
  });

  it('bez P_12 przy dwóch stawkach w nagłówku → „nieznana”, JPK odmawia z numerem (nie zgaduje 23%)', async () => {
    await importXml(withoutP12(xmlOf(invoice('FV/MIX/1', [{ rate: '23', net: 100 }, { rate: '8', net: 50 }]))));
    expect(storedRates('FV/MIX/1')).toEqual(['nieznana', 'nieznana']);
    await expect(jpkFa()).rejects.toThrow(/JPK wstrzymany:.*FV\/MIX\/1/);
  });

  it('FA(2): gołe „np” przy P_13_9 → np_ii (P_18 = true), gołe „0” przy P_13_6_1 → „0”', async () => {
    await importXml(
      withP12(xmlOf(invoice('FV/FA2NP/1', [{ rate: 'np_ii', net: 100 }])), 'np II', 'np'),
      withP12(xmlOf(invoice('FV/FA20/1', [{ rate: '0', net: 100 }])), '0 KR', '0'),
    );
    expect(storedRates('FV/FA2NP/1')).toEqual(['np_ii']);
    expect(storedRates('FV/FA20/1')).toEqual(['0']);
  });
});

describe('W9: zaimportowane faktury korygujące, zaliczkowe i rozliczeniowe — JPK odmawia z nazwą dokumentu', () => {
  // Import zapisuje je jako invoice_kind „regular” (brak powiązań w danych),
  // więc JPK potraktowałby pozycje „stan przed + stan po” jak zwykłą sprzedaż.
  const kor = (rate: VatRate) => xmlOf(invoice('KOR/1', [{ rate, net: 100 }]))
    .replace('<RodzajFaktury>VAT</RodzajFaktury>', '<RodzajFaktury>KOR</RodzajFaktury>');

  it.each(['23', '0'] as VatRate[])('KOR ze stawką %s → JPK_FA i JPK_V7M odmawiają z numerem', async (rate) => {
    await importXml(kor(rate), xmlOf(invoice('FV/23/1', [{ rate: '23', net: 100 }])));
    await expect(jpkFa()).rejects.toThrow(/JPK wstrzymany:.*KOR\/1/);
    await expect(jpkV7m()).rejects.toThrow(/JPK wstrzymany:.*KOR\/1/);
  });
});

describe('W9 — ustalenia recenzji C5a', () => {
  it('pozycja zwolniona bez P_12 obok sumy 23% (P_19 = 1) → „nieznana”, nie 23% (faktura mieszana)', async () => {
    const xml = xmlOf(invoice('FV/MIESZ/1', [{ rate: '23', net: 100 }, { rate: 'zw', net: 50 }]))
      .replace('<P_12>zw</P_12>', '')
      .replace(/<P_13_7>[^<]*<\/P_13_7>/, '');
    await importXml(xml);
    expect(storedRates('FV/MIESZ/1')).toEqual(['23', 'nieznana']);
    await expect(jpkV7m()).rejects.toThrow(/JPK wstrzymany:.*FV\/MIESZ\/1/);
  });

  // C5c (świadoma zmiana): przy 0% brutto = netto, więc P_11A 500 przy P_13_6_1
  // 500 to spójna faktura w cenach brutto — wchodzi do JPK z polami z pliku.
  it('ceny brutto (P_11A zamiast P_11) przy 0% → spójne z nagłówkiem: JPK z P_9B/P_11A (C5c)', async () => {
    const xml = xmlOf(invoice('FV/BR0/1', [{ rate: '0', net: 500 }]))
      .replace(/<P_9A>([^<]*)<\/P_9A>/, '<P_9B>$1</P_9B>')
      .replace(/<P_11>([^<]*)<\/P_11>/, '<P_11A>$1</P_11A>');
    const result = await importXml(xml);
    expect(result.warnings.join('\n')).not.toMatch(/JPK_FA i JPK_V7M/);
    const fa = await jpkFa();
    expect(fragment(fa, '<P_2A>FV/BR0/1', '</Faktura>')).toContain('<P_13_6>500.00</P_13_6>');
    const wiersz = fragment(fa, '<P_2B>FV/BR0/1</P_2B>', '</FakturaWiersz>');
    expect(wiersz).toContain('<P_11A>500.00</P_11A>');
    expect(wiersz).not.toContain('<P_11>');
    expect((await validateJpkFa(fa)).errors).toEqual([]);
  });

  // Przy 23% P_11A 500 ≠ netto 500 + VAT 115 z nagłówka — plik sprzeczny, dalej odmowa (z dokładnym powodem).
  it('ceny brutto (P_11A zamiast P_11) przy 23%, sprzeczne z nagłówkiem → JPK odmawia z numerem i powodem', async () => {
    const xml = xmlOf(invoice('FV/BR23/1', [{ rate: '23', net: 500 }]))
      .replace(/<P_9A>([^<]*)<\/P_9A>/, '<P_9B>$1</P_9B>')
      .replace(/<P_11>([^<]*)<\/P_11>/, '<P_11A>$1</P_11A>');
    const result = await importXml(xml);
    expect(result.warnings[0]).toContain('FV/BR23/1');
    expect(result.warnings[0]).toContain('brutto pozycji');
    const refusal = await jpkFa().then(() => null, (e: Error) => e);
    expect(refusal?.message).toContain('JPK wstrzymany:');
    expect(refusal?.message).toContain('FV/BR23/1');
    await expect(jpkV7m()).rejects.toThrow(/JPK wstrzymany:/);
  });

  it('ponowny import własnej korekty FaktWay (w bazie jako korekta z aplikacji) → bez ostrzeżenia „JPK nie powstanie”', async () => {
    const K = `${NIP}-20260910-0100A0B0C0D1-AF`.slice(0, 35);
    db.tables.invoices!.push({
      id: 'kor-app', tenant_id: T, direction: 'outgoing', origin: 'app', internal_number: 'KOR/APP/1', invoice_kind: 'correction',
      invoice_type: 'KOR', ksef_status: 'accepted', ksef_environment: 'test', ksef_number: K, issue_date: '2026-09-10', xml_storage_path: 'x',
    });
    db.tables.invoice_line_items!.push({ id: 'kl-1', invoice_id: 'kor-app', vat_rate: '23', net_amount: 100 });
    const xml = xmlOf(invoice('KOR/APP/1', [{ rate: '23', net: 100 }])).replace('<RodzajFaktury>VAT</RodzajFaktury>', '<RodzajFaktury>KOR</RodzajFaktury>');

    const result = await importXml(xml);

    expect(result.warnings.join(' | ')).not.toMatch(/JPK_FA i JPK_V7M/);
  });

  it('ponowny import dokumentu z importu ze stawką „0 WDT” → ostrzeżenie zostaje (gałąź duplikatu)', async () => {
    const wdt = xmlOf(invoice('FV/WDT/2', [{ rate: '0', net: 500 }]))
      .replace('<P_12>0 KR</P_12>', '<P_12>0 WDT</P_12>')
      .replace(/<P_13_6_1>([^<]*)<\/P_13_6_1>/, '<P_13_6_2>$1</P_13_6_2>');
    const parsed = parseFa3Xml(wdt, { ksefNumber: ksefNumber() });
    await importParsed([parsed]);
    const again = await importParsed([parsed]);
    expect(again.warnings[0]).toContain('FV/WDT/2');
    expect(again.warnings[0]).toContain('0 WDT');
  });

  it('faktura zapisana, ale zapis oryginału XML nieudany → ostrzeżenie o JPK i tak jest', async () => {
    const wdt = xmlOf(invoice('FV/WDT/3', [{ rate: '0', net: 500 }]))
      .replace('<P_12>0 KR</P_12>', '<P_12>0 WDT</P_12>')
      .replace(/<P_13_6_1>([^<]*)<\/P_13_6_1>/, '<P_13_6_2>$1</P_13_6_2>');
    const k = ksefNumber();
    const parsed = { ...parseFa3Xml(wdt, { ksefNumber: k }), xmlArchive: { storagePath: `${T}/ksef-import/${k}.xml`, sha256Hash: 'a'.repeat(64), sizeBytes: 10 } };
    db.failInsertInto = ['xml_documents'];
    const result = await importParsed([parsed]);
    expect(db.tables.invoices!.some((r) => r.internal_number === 'FV/WDT/3')).toBe(true);
    expect(result.warnings.some((w) => /FV\/WDT\/3.*0 WDT.*JPK_FA i JPK_V7M/.test(w))).toBe(true);
  });

  it('komunikaty: faktura przychodząca i szkic z pliku — bez obietnic o JPK sprzedaży', async () => {
    const wdt = xmlOf(invoice('FZ/WDT/1', [{ rate: '0', net: 500 }]))
      .replace('<P_12>0 KR</P_12>', '<P_12>0 WDT</P_12>');
    const incoming = await importParsed([parseFa3Xml(wdt, { ksefNumber: ksefNumber() })], { direction: 'incoming' });
    expect(incoming.warnings[0]).toMatch(/FZ\/WDT\/1.*0 WDT.*sprawdź ją z księgową/);
    expect(incoming.warnings[0]).not.toContain('JPK_FA');

    const draft = await importParsed([{ ...parseFa3Xml(wdt.replace('FZ/WDT/1', 'SZK/1')), ksefNumber: undefined }], { status: 'draft', source: 'xml_file' });
    expect(draft.warnings[0]).toMatch(/SZK\/1.*szkic zapisany/);
  });

  it('odmowa JPK nie każe księgowej „przygotować JPK z księgową” (ten sam tekst idzie do portalu)', async () => {
    await importXml(xmlOf(invoice('FV/WDT/4', [{ rate: '0', net: 500 }])).replace('<P_12>0 KR</P_12>', '<P_12>0 WDT</P_12>')
      .replace(/<P_13_6_1>([^<]*)<\/P_13_6_1>/, '<P_13_6_2>$1</P_13_6_2>'));
    const error = await jpkFa().then(() => null, (e: Error) => e);
    expect(error?.message).toMatch(/JPK wstrzymany:/);
    expect(error?.message).not.toContain('z księgową');
  });
});

/** Odczyt pomocniczy dla czytelności asercji w razie błędu. */
export const _debug = (): Row[] => db.tables.invoice_line_items ?? [];
