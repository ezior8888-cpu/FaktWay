import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseFa3Xml, type ParsedInvoice } from '@/lib/import/fa3-parser';
import {
  buildImportFa3Json,
  buildImportedInvoiceRow,
  buildImportedLineRows,
  importedInvoiceContent,
  type ImportedInvoiceRowInput,
} from '@/lib/import/imported-invoice-row';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { finalizeInvoice } from '@/lib/xml/invoice-calculator';
import type { Json } from '@/types/database';
import type { BuyerParty, PaymentInfo } from '@/types/invoice';

/**
 * PR C0 (D-A4-1b-3, specyfikacja 5.9, inwariant C0-5) — czystość eksportowanych
 * funkcji `lib/import/imported-invoice-row.ts`: wynik zależy wyłącznie od
 * argumentów. Bez bazy, magazynu, zegara i środowiska; test celowo BEZ `vi.mock`
 * — moduł działa na prawdziwych zależnościach, więc nic nie jest podstawione
 * za niego. Czytanie zegara łapią dwa przebiegi pod różnym czasem systemowym,
 * a dołożenie bazy, magazynu albo `process.env` — kontrola kodu na końcu.
 * Tożsamość zapisów z silnikiem importu pilnuje osobny strażnik
 * (`import-wiersze-tozsamosc.test.ts`); tu tylko czystość i kształt wyniku.
 *
 * Pliki wejściowe jak w strażniku: ff-23 z generatora FaktWay (stały
 * `generatedAt`, NIP fikcyjne: sprzedawca 1234567890, nabywca 1111111111)
 * oraz statyczny `ceny-brutto.xml` (kwoty pozycji z ceny brutto, pola
 * `ksefLineFields` i `lineAmountProblems` w `fa3_data`).
 */

const SYSTEM_A = new Date('2031-03-04T05:06:07.000Z');
const SYSTEM_B = new Date('2044-11-12T13:14:15.000Z');
/** Znaczniki podane przez wywołującego — różne od obu czasów systemowych. */
const KSEF_ACCEPTED_AT = '2026-09-10T08:00:05Z';
const IMPORTED_AT = '2026-01-01T00:00:00.000Z';

const TENANT = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const KSEF_NUMBER = '1234567890-20260910-CZ0000000001-AF';

const BUYER: BuyerParty = {
  nip: '1111111111', name: 'Nabywca testowy sp. z o.o.', email: 'nabywca@example.test',
  address: { countryCode: 'PL', addressLine1: 'ul. Testowa 2', addressLine2: '00-002 Warszawa' },
};
const TRANSFER: Omit<PaymentInfo, 'amountDue'> = {
  currency: 'PLN', dueDate: '2026-09-24', method: 'transfer', bankAccount: '61109010140000071219812874',
};

/** Plik taki, jaki FaktWay wysyła do KSeF (stały `generatedAt`; bez `validate` — NIP fikcyjny). */
function ff23Xml(): string {
  const invoice = finalizeInvoice({
    internalNumber: 'FV/CZ/23',
    type: 'VAT',
    issueDate: '2026-09-10',
    saleDate: '2026-09-10',
    seller: {
      nip: '1234567890', name: 'Firma testowa sp. z o.o.', email: 'biuro@example.test',
      address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
    },
    buyer: BUYER,
    lines: [
      { ordinal: 1, name: 'Usługa wdrożeniowa', unit: 'szt.', quantity: 2, unitPriceNet: 50, vatRate: '23' },
      { ordinal: 2, name: 'Abonament miesięczny', unit: 'mies.', quantity: 1, unitPriceNet: 49.99, vatRate: '23' },
    ],
    payment: TRANSFER,
  });
  return generateFA3Xml(invoice, { validate: false, generatedAt: new Date('2026-09-10T08:00:00Z') });
}

/** Bez `decodeKsefXml` (ten moduł ciągnie magazyn plików): tekst UTF-8 bez BOM. */
function staticXml(name: string): string {
  const text = readFileSync(new URL(`../fixtures/import-wiersze/${name}.xml`, import.meta.url), 'utf8');
  return text.startsWith('﻿') ? text.slice(1) : text;
}

const FF23: ParsedInvoice = parseFa3Xml(ff23Xml(), { ksefNumber: KSEF_NUMBER });
const CENY_BRUTTO: ParsedInvoice = parseFa3Xml(staticXml('ceny-brutto'), { ksefNumber: KSEF_NUMBER });

function rowInput(overrides: Partial<ImportedInvoiceRowInput> = {}): ImportedInvoiceRowInput {
  return {
    tenantId: TENANT,
    direction: 'outgoing',
    origin: 'ksef_import',
    ksefStatus: 'accepted',
    ksefEnvironment: 'test',
    ksefAcceptedAt: KSEF_ACCEPTED_AT,
    ksefNumber: KSEF_NUMBER,
    notes: `[import] ksef_history job=${JOB}`,
    provenance: { source: 'ksef_history', importJobId: JOB, importedAt: IMPORTED_AT },
    ...overrides,
  };
}

/** Zamraża obiekt w głąb — zapis do niego (także zagnieżdżony) rzuca TypeError. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Wszystkie eksportowane budowniczy na jednym pliku — porównywane między przebiegami. */
function buildAll(inv: ParsedInvoice, input: ImportedInvoiceRowInput) {
  const { content, amounts } = importedInvoiceContent(inv);
  return {
    content,
    amounts,
    row: buildImportedInvoiceRow(inv, input, content, amounts),
    lines: buildImportedLineRows(inv, amounts),
    fa3: buildImportFa3Json(inv, input.provenance, content, amounts),
  };
}

/** Kolejność kluczy obiektu `insert` nagłówka — jak w silniku sprzed PR C0 (bez `xml_storage_path`). */
const KLUCZE_NAGLOWKA = [
  'tenant_id', 'direction', 'origin', 'internal_number', 'ksef_status', 'ksef_environment', 'ksef_accepted_at',
  'ksef_number', 'invoice_kind', 'invoice_type', 'issue_date', 'sale_date', 'seller_nip', 'buyer_nip', 'currency',
  'net_total', 'vat_total', 'gross_total', 'payment_due_date', 'fa3_data', 'seller_data', 'buyer_data',
  'payment_data', 'is_b2c', 'buyer_id_type', 'buyer_pesel', 'buyer_id_number', 'notes',
] as const;
const KLUCZE_POZYCJI = [
  'ordinal', 'name', 'unit', 'quantity', 'unit_price_net', 'net_amount', 'vat_rate', 'vat_amount', 'gross_amount',
] as const;

afterEach(() => {
  vi.useRealTimers();
});

describe('C0-5: imported-invoice-row — czystość eksportowanych funkcji', () => {
  it('fikstury mają to, co mają przypinać (ff-23: dwie pozycje 23%; ceny-brutto: trzy pozycje z ceną brutto)', () => {
    expect(FF23.invoiceNumber).toBe('FV/CZ/23');
    expect(FF23.lines).toHaveLength(2);
    expect(CENY_BRUTTO.lines).toHaveLength(3);
    expect(importedInvoiceContent(CENY_BRUTTO).amounts.ksefLineFields).toBeDefined();
  });

  it.each([
    { nazwa: 'ff-23', inv: FF23 },
    { nazwa: 'ceny-brutto', inv: CENY_BRUTTO },
  ])('wynik nie zależy od zegara systemowego: $nazwa pod czasem A i pod czasem B', ({ inv }) => {
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(SYSTEM_A);
    const podA = buildAll(inv, rowInput());
    vi.setSystemTime(SYSTEM_B);
    const podB = buildAll(inv, rowInput());

    expect(podB.content).toEqual(podA.content);
    expect(podB.amounts).toEqual(podA.amounts);
    expect(podB.row).toEqual(podA.row);
    expect(podB.lines).toEqual(podA.lines);
    expect(podB.fa3).toEqual(podA.fa3);

    // Ślad czasu systemowego nie może wyciec do żadnego z wyników.
    const surowe = JSON.stringify([podA.row, podA.lines, podA.fa3]);
    expect(surowe).not.toContain('2031-03-04');
    expect(surowe).not.toContain('2044-11-12');
  });

  it('znaczniki czasu podaje wywołujący: ksef_accepted_at i fa3_data.import wprost z wejścia, nie z zegara', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SYSTEM_A);
    const provenance = { source: 'ksef_history', importJobId: JOB, importedAt: IMPORTED_AT } satisfies Record<string, Json>;
    const { row, fa3 } = buildAll(FF23, rowInput({ provenance }));

    expect(row.ksef_accepted_at).toBe(KSEF_ACCEPTED_AT);
    expect((row.fa3_data as { import: unknown }).import).toEqual(provenance);
    expect((fa3 as { import: unknown }).import).toEqual(provenance);

    // Brak znacznika (np. szkic) zostaje brakiem — moduł nie wstawia „teraz”.
    vi.setSystemTime(SYSTEM_B);
    const szkic = buildAll(FF23, rowInput({ ksefStatus: 'draft', ksefAcceptedAt: null, ksefNumber: null }));
    expect(szkic.row.ksef_accepted_at).toBeNull();
    expect(szkic.row.ksef_number).toBeNull();
  });

  it('nie zmienia swoich argumentów (ParsedInvoice, wejście zapisu, provenance, treść i kwoty)', () => {
    // Świeży odczyt, nie wspólny FF23 — wcześniejsze testy przepuściły go już
    // przez budowniczych, więc jednorazowy zapis do argumentu by umknął.
    // Zamrożone w głąb: każdy zapis do argumentu rzuca (moduły ES są ścisłe).
    const inv = deepFreeze(parseFa3Xml(ff23Xml(), { ksefNumber: KSEF_NUMBER }));
    const input = deepFreeze(rowInput());
    const { content, amounts } = importedInvoiceContent(inv);
    deepFreeze(content);
    deepFreeze(amounts);

    expect(() => {
      buildImportedInvoiceRow(inv, input, content, amounts);
      buildImportedLineRows(inv, amounts);
      buildImportFa3Json(inv, input.provenance, content, amounts);
    }).not.toThrow();
  });

  it('klucze nagłówka w kolejności z silnika sprzed PR C0; xml_storage_path dopisany na końcu tylko gdy podano ścieżkę', () => {
    const { content, amounts } = importedInvoiceContent(FF23);
    const bezSciezki = buildImportedInvoiceRow(FF23, rowInput(), content, amounts);
    expect(Object.keys(bezSciezki)).toEqual([...KLUCZE_NAGLOWKA]);

    // `undefined` i `null` = brak archiwum: kolumny nie ma w obiekcie `insert` (jak `...(inv.xmlArchive ? … : {})`).
    for (const brak of [undefined, null]) {
      const row = buildImportedInvoiceRow(FF23, rowInput({ xmlStoragePath: brak }), content, amounts);
      expect(Object.keys(row)).toEqual([...KLUCZE_NAGLOWKA]);
      expect('xml_storage_path' in row).toBe(false);
    }

    const sciezka = `${TENANT}/ksef-import/${KSEF_NUMBER}.xml`;
    const zeSciezka = buildImportedInvoiceRow(FF23, rowInput({ xmlStoragePath: sciezka }), content, amounts);
    expect(Object.keys(zeSciezka)).toEqual([...KLUCZE_NAGLOWKA, 'xml_storage_path']);
    expect(zeSciezka.xml_storage_path).toBe(sciezka);
  });

  it('pozycje: klucze w kolejności z silnika, bez invoice_id (dopisuje go zapis); kolejność i liczba jak w pliku', () => {
    for (const inv of [FF23, CENY_BRUTTO]) {
      const { amounts } = importedInvoiceContent(inv);
      const lines = buildImportedLineRows(inv, amounts);
      expect(lines).toHaveLength(inv.lines.length);
      expect(Object.keys(lines[0]!)).toEqual([...KLUCZE_POZYCJI]);
      expect(lines.map((l) => l.name)).toEqual(inv.lines.map((l) => l.name));
      for (const line of lines) expect('invoice_id' in line).toBe(false);
    }
  });

  /**
   * Kontrola kodu źródłowego: komentarze (w tym nagłówek, który opisuje zakaz
   * `Date.now()` / `new Date()`) są odcięte — sprawdzamy wyłącznie kod.
   */
  it('kod modułu nie czyta zegara, bazy, magazynu ani środowiska', () => {
    const zrodlo = readFileSync(new URL('../../lib/import/imported-invoice-row.ts', import.meta.url), 'utf8');
    const kod = zrodlo
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/(\s)\/\/.*$/gm, '$1');

    // Odcięcie komentarzy działa i zostawia kod, więc brak zakazanych napisów nie jest pozorny.
    expect(kod).toContain('export function buildImportedInvoiceRow');
    expect(kod).not.toContain('Moduł czysty');

    for (const zakazane of ['new Date(', 'Date.now', '@/lib/supabase', '@/lib/storage', 'server-only', 'process.env']) {
      expect(kod, `kod modułu zawiera „${zakazane}”`).not.toContain(zakazane);
    }
  });
});
