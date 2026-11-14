import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Invoice } from '@/types/invoice';
import { finalizeInvoice, type InvoiceInput } from './invoice-calculator';
import {
  generateFA3Xml,
  InvoiceValidationError,
} from './fa3-generator';

// ═══════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════

function baseInvoiceInput(overrides: Partial<InvoiceInput> = {}): InvoiceInput {
  return {
    internalNumber: 'FV 2026/04/001',
    type: 'VAT',
    issueDate: '2026-04-19',
    saleDate: '2026-04-19',
    seller: {
      nip: '5260001246', // testowy NIP z BomTox (ma poprawną sumę kontrolną)
      name: 'ACME Software sp. z o.o.',
      address: {
        countryCode: 'PL',
        addressLine1: 'ul. Przykładowa 1/2',
        addressLine2: '00-001 Warszawa',
      },
      email: 'biuro@acme.test',
    },
    buyer: {
      nip: '5252241585', // sprawdzony NIP z poprawną sumą kontrolną mod 11
      name: 'Klient sp. z o.o.',
      address: {
        countryCode: 'PL',
        addressLine1: 'ul. Klienta 10',
        addressLine2: '02-001 Warszawa',
      },
      email: 'kontakt@klient.test',
    },
    lines: [
      {
        ordinal: 1,
        name: 'Licencja SaaS – plan Pro (miesiąc)',
        unit: 'usł.',
        quantity: 1,
        unitPriceNet: 199,
        vatRate: '23',
      },
    ],
    payment: {
      currency: 'PLN',
      dueDate: '2026-05-03',
      method: 'transfer',
      bankAccount: 'PL61109010140000071219812874',
      bankName: 'Santander Bank Polska',
    },
    ...overrides,
  };
}

function buildInvoice(overrides: Partial<InvoiceInput> = {}): Invoice {
  return finalizeInvoice(baseInvoiceInput(overrides));
}

// ═══════════════════════════════════════════════════════════════
// Walidacja XSD przez xmllint
// ═══════════════════════════════════════════════════════════════

const SCHEMA_PATH = resolve(
  process.cwd(),
  'lib/xml/schemas/fa3/schemat-local.xsd',
);

function validateAgainstXsd(xml: string): { ok: boolean; stderr: string } {
  if (!existsSync(SCHEMA_PATH)) {
    throw new Error(
      `Nie znaleziono lokalnego XSD: ${SCHEMA_PATH}. Uruchom \`pnpm fa3:fetch-xsd\` aby pobrać.`,
    );
  }
  const tmp = mkdtempSync(join(tmpdir(), 'fa3-xsd-'));
  const xmlPath = join(tmp, 'invoice.xml');
  writeFileSync(xmlPath, xml, 'utf8');
  const res = spawnSync(
    'xmllint',
    ['--noout', '--schema', SCHEMA_PATH, xmlPath],
    { encoding: 'utf8' },
  );
  return { ok: res.status === 0, stderr: res.stderr };
}

// ═══════════════════════════════════════════════════════════════
// Testy struktury XML (część sprawdza też XSD przez xmllint)
// ═══════════════════════════════════════════════════════════════

test('generateFA3Xml wstawia namespace FA(3)', () => {
  const xml = generateFA3Xml(buildInvoice());
  assert.match(xml, /xmlns="http:\/\/crd\.gov\.pl\/wzor\/2025\/06\/25\/13775\/"/);
});

test('generateFA3Xml wstawia KodFormularza=FA, wersjaSchemy=1-0E', () => {
  const xml = generateFA3Xml(buildInvoice());
  assert.match(
    xml,
    /<KodFormularza kodSystemowy="FA \(3\)" wersjaSchemy="1-0E">FA<\/KodFormularza>/,
  );
});

test('generateFA3Xml emituje obligatoryjne JST i GV z domyślną wartością 2', () => {
  const xml = generateFA3Xml(buildInvoice());
  assert.match(xml, /<JST>2<\/JST>/);
  assert.match(xml, /<GV>2<\/GV>/);
});

test('generateFA3Xml emituje pełną sekcję Adnotacje z P_19N/P_22N/P_PMarzyN', () => {
  const xml = generateFA3Xml(buildInvoice());
  assert.match(xml, /<Adnotacje>/);
  assert.match(xml, /<P_16>2<\/P_16>/);
  assert.match(xml, /<P_17>2<\/P_17>/);
  assert.match(xml, /<P_18>2<\/P_18>/);
  assert.match(xml, /<P_18A>2<\/P_18A>/);
  assert.match(xml, /<Zwolnienie><P_19N>1<\/P_19N><\/Zwolnienie>/);
  assert.match(xml, /<NoweSrodkiTransportu><P_22N>1<\/P_22N><\/NoweSrodkiTransportu>/);
  assert.match(xml, /<P_23>2<\/P_23>/);
  assert.match(xml, /<PMarzy><P_PMarzyN>1<\/P_PMarzyN><\/PMarzy>/);
});

test('generateFA3Xml używa P_13_1/P_14_1 dla stawki 23%', () => {
  const xml = generateFA3Xml(buildInvoice());
  assert.match(xml, /<P_13_1>199\.00<\/P_13_1>/);
  assert.match(xml, /<P_14_1>45\.77<\/P_14_1>/);
  assert.match(xml, /<P_15>244\.77<\/P_15>/);
});

test('P_12 dla stawki 0% to "0 KR" a dla stawki 0% emitujemy P_13_6_1', () => {
  const xml = generateFA3Xml(
    buildInvoice({
      lines: [
        {
          ordinal: 1,
          name: 'Eksport usług (krajowa 0%)',
          unit: 'szt.',
          quantity: 2,
          unitPriceNet: 100,
          vatRate: '0',
        },
      ],
    }),
  );
  assert.match(xml, /<P_13_6_1>200\.00<\/P_13_6_1>/);
  assert.match(xml, /<P_12>0 KR<\/P_12>/);
  // Brak P_14 dla stawki 0%.
  assert.doesNotMatch(xml, /<P_14_6/);
});

test('stawka "oo" wymusza P_18=1 i emituje P_13_10', () => {
  const xml = generateFA3Xml(
    buildInvoice({
      lines: [
        {
          ordinal: 1,
          name: 'Usługa z odwrotnym obciążeniem',
          unit: 'usł.',
          quantity: 1,
          unitPriceNet: 500,
          vatRate: 'oo',
        },
      ],
    }),
  );
  assert.match(xml, /<P_13_10>500\.00<\/P_13_10>/);
  assert.match(xml, /<P_12>oo<\/P_12>/);
  assert.match(xml, /<P_18>1<\/P_18>/);
});

test('Platnosc ma TerminPlatnosci przed FormaPlatnosci', () => {
  const xml = generateFA3Xml(buildInvoice());
  const termIdx = xml.indexOf('<TerminPlatnosci>');
  const formIdx = xml.indexOf('<FormaPlatnosci>');
  assert.ok(termIdx > 0 && formIdx > 0, 'oba elementy istnieją');
  assert.ok(termIdx < formIdx, 'TerminPlatnosci musi być PRZED FormaPlatnosci');
});

test('FormaPlatnosci dla transfer=6, cash=1, card=2, mobile=7', () => {
  const xmlTransfer = generateFA3Xml(buildInvoice());
  assert.match(xmlTransfer, /<FormaPlatnosci>6<\/FormaPlatnosci>/);

  const xmlCash = generateFA3Xml(
    buildInvoice({ payment: { ...baseInvoiceInput().payment, method: 'cash', bankAccount: undefined } }),
  );
  assert.match(xmlCash, /<FormaPlatnosci>1<\/FormaPlatnosci>/);

  const xmlCard = generateFA3Xml(
    buildInvoice({ payment: { ...baseInvoiceInput().payment, method: 'card', bankAccount: undefined } }),
  );
  assert.match(xmlCard, /<FormaPlatnosci>2<\/FormaPlatnosci>/);

  // BLIK: forma „mobilna” z XSD (faktura za abonament opłacony BLIK-iem).
  const xmlMobile = generateFA3Xml(
    buildInvoice({ payment: { ...baseInvoiceInput().payment, method: 'mobile', bankAccount: undefined } }),
  );
  assert.match(xmlMobile, /<FormaPlatnosci>7<\/FormaPlatnosci>/);
  const { ok, stderr } = validateAgainstXsd(xmlMobile);
  assert.ok(ok, `XSD validation failed:\n${stderr}`);
});

test('payment.method="other" emituje PlatnoscInna+OpisPlatnosci zamiast FormaPlatnosci', () => {
  const xml = generateFA3Xml(
    buildInvoice({
      payment: { ...baseInvoiceInput().payment, method: 'other', bankAccount: undefined },
    }),
  );
  assert.match(xml, /<PlatnoscInna>1<\/PlatnoscInna>/);
  assert.match(xml, /<OpisPlatnosci>inna<\/OpisPlatnosci>/);
  assert.doesNotMatch(xml, /<FormaPlatnosci>/);
});

test('IBAN z prefiksem PL jest normalizowany do 26 cyfr w NrRB', () => {
  const xml = generateFA3Xml(buildInvoice());
  assert.match(xml, /<NrRB>61109010140000071219812874<\/NrRB>/);
});

// Nabywca z innego państwa UE (AUD-70): adres za granicą — walidacja odrzuca
// zagraniczny VAT-UE z krajem adresu „PL”.
const BUYER_DE: InvoiceInput['buyer'] = {
  vatUeNumber: 'DE123456789',
  name: 'Kunde GmbH',
  address: {
    countryCode: 'DE',
    addressLine1: 'Hauptstrasse 1',
    addressLine2: '10115 Berlin',
  },
};

const BUYER_EL: InvoiceInput['buyer'] = {
  vatUeNumber: 'EL123456789',
  name: 'Pelatis A.E.',
  address: {
    countryCode: 'GR', // adres: ISO „GR”; prefiks VAT-UE Grecji to „EL”
    addressLine1: 'Odos Ermou 1',
    addressLine2: '10563 Athina',
  },
};

const NP_II_LINE: InvoiceInput['lines'][number] = {
  ordinal: 1,
  name: 'Usługa programistyczna (art. 28b)',
  unit: 'usł.',
  quantity: 1,
  unitPriceNet: 1000,
  vatRate: 'np_ii',
};

test('buyer.vatUeNumber rozbija się na KodUE + NrVatUE', () => {
  const xml = generateFA3Xml(buildInvoice({ buyer: BUYER_DE }));
  assert.match(xml, /<KodUE>DE<\/KodUE>/);
  assert.match(xml, /<NrVatUE>123456789<\/NrVatUE>/);
});

test('stawka "np_ii" emituje P_12 "np II", P_13_9 bez P_14 i wymusza P_18=1', () => {
  const xml = generateFA3Xml(buildInvoice({ buyer: BUYER_DE, lines: [NP_II_LINE] }));
  assert.match(xml, /<P_12>np II<\/P_12>/);
  assert.match(xml, /<P_13_9>1000\.00<\/P_13_9>/);
  assert.doesNotMatch(xml, /<P_14_/);
  assert.match(xml, /<P_18>1<\/P_18>/);
});

test('np II wymaga nabywcy z VAT-UE innego państwa — nabywca z NIP odpada', () => {
  assert.throws(
    () => generateFA3Xml(buildInvoice({ lines: [NP_II_LINE] })),
    InvoiceValidationError,
  );
});

test('VAT-UE z prefiksem „GR” (zamiast „EL”) odpada w walidacji', () => {
  assert.throws(
    () => generateFA3Xml(buildInvoice({ buyer: { ...BUYER_EL, vatUeNumber: 'GR123456789' } })),
    InvoiceValidationError,
  );
});

test('walidacja wyrzuca InvoiceValidationError gdy dane są niespójne', () => {
  assert.throws(
    () =>
      generateFA3Xml({
        ...buildInvoice(),
        grossTotal: 9999, // celowo zły total
      }),
    InvoiceValidationError,
  );
});

test('FaWiersz ma kolejność z XSD: NrWierszaFa → P_7 → (klasyfikacja) → P_8A → P_8B → P_9A → P_11 → P_12', () => {
  const xml = generateFA3Xml(
    buildInvoice({
      lines: [
        {
          ordinal: 1,
          name: 'Produkt',
          classificationCode: '5901234123457', // GTIN
          unit: 'szt.',
          quantity: 1,
          unitPriceNet: 50,
          vatRate: '23',
        },
      ],
    }),
  );
  // XSD FaWiersz: P_7, Indeks, GTIN, PKWiU, CN, PKOB, P_8A (C1-KOLEJNOSC).
  const order = [
    '<NrWierszaFa>',
    '<P_7>',
    '<GTIN>',
    '<P_8A>',
    '<P_8B>',
    '<P_9A>',
    '<P_11>',
    '<P_12>',
  ];
  let lastIdx = -1;
  for (const tag of order) {
    const idx = xml.indexOf(tag);
    assert.ok(idx > lastIdx, `${tag} powinien pojawić się po poprzednim elemencie`);
    lastIdx = idx;
  }
  const { ok, stderr } = validateAgainstXsd(xml);
  assert.ok(ok, `XSD validation failed:\n${stderr}\n\n---XML---\n${xml}`);
});

// ═══════════════════════════════════════════════════════════════
// Walidacja przeciwko oficjalnemu XSD FA(3)
// ═══════════════════════════════════════════════════════════════

test('wygenerowany XML waliduje się przeciwko oficjalnemu XSD FA(3) (xmllint)', () => {
  const xml = generateFA3Xml(buildInvoice(), { prettyPrint: true });
  const { ok, stderr } = validateAgainstXsd(xml);
  assert.ok(
    ok,
    `XSD validation failed:\n${stderr}\n\n---XML---\n${xml}`,
  );
});

test('XSD walidacja: faktura z linią stawki 0%', () => {
  const xml = generateFA3Xml(
    buildInvoice({
      lines: [
        {
          ordinal: 1,
          name: 'Usługa 0% krajowa',
          unit: 'usł.',
          quantity: 1,
          unitPriceNet: 1000,
          vatRate: '0',
        },
      ],
    }),
  );
  const { ok, stderr } = validateAgainstXsd(xml);
  assert.ok(ok, `XSD validation failed:\n${stderr}`);
});

test('XSD walidacja: faktura z wieloma stawkami (23% + 8% + oo)', () => {
  const xml = generateFA3Xml(
    buildInvoice({
      lines: [
        {
          ordinal: 1,
          name: 'Linia 23%',
          unit: 'szt.',
          quantity: 2,
          unitPriceNet: 100,
          vatRate: '23',
        },
        {
          ordinal: 2,
          name: 'Linia 8%',
          unit: 'szt.',
          quantity: 1,
          unitPriceNet: 50,
          vatRate: '8',
        },
        {
          ordinal: 3,
          name: 'Linia odwrotnego obciążenia',
          unit: 'usł.',
          quantity: 1,
          unitPriceNet: 300,
          vatRate: 'oo',
        },
      ],
    }),
  );
  const { ok, stderr } = validateAgainstXsd(xml);
  assert.ok(ok, `XSD validation failed:\n${stderr}`);
});

test('XSD walidacja: np II dla nabywcy z DE (KodUE + NrVatUE, P_13_9, P_18=1)', () => {
  const xml = generateFA3Xml(buildInvoice({ buyer: BUYER_DE, lines: [NP_II_LINE] }));
  const { ok, stderr } = validateAgainstXsd(xml);
  assert.ok(ok, `XSD validation failed:\n${stderr}`);
});

test('XSD walidacja: nabywca z Grecji (KodUE EL, adres GR), 23% + np II', () => {
  const xml = generateFA3Xml(
    buildInvoice({
      buyer: BUYER_EL,
      lines: [
        {
          ordinal: 1,
          name: 'Licencja',
          unit: 'szt.',
          quantity: 1,
          unitPriceNet: 100,
          vatRate: '23',
        },
        { ...NP_II_LINE, ordinal: 2 },
      ],
    }),
  );
  assert.match(xml, /<KodUE>EL<\/KodUE>/);
  assert.match(xml, /<Adres><KodKraju>GR<\/KodKraju>/);
  const { ok, stderr } = validateAgainstXsd(xml);
  assert.ok(ok, `XSD validation failed:\n${stderr}`);
});

test('XSD walidacja: faktura bez konta bankowego (płatność gotówką)', () => {
  const xml = generateFA3Xml(
    buildInvoice({
      payment: {
        currency: 'PLN',
        dueDate: '2026-04-19',
        method: 'cash',
      },
    }),
  );
  const { ok, stderr } = validateAgainstXsd(xml);
  assert.ok(ok, `XSD validation failed:\n${stderr}`);
});
