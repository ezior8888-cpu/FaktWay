/**
 * WERYFIKACJA PRAWNO-KRYTYCZNA: generuje KAŻDY typ faktury w wielu scenariuszach
 * i waliduje względem PRAWDZIWEGO XSD FA(3) MF (xmllint-wasm — ten sam schemat,
 * którego używa bramka KSeF do walidacji strukturalnej). Sprawdza też spójność
 * arytmetyczną (P_15 = Σ(P_13+P_14)).
 *
 * Uruchom: pnpm tsx scripts/verify-fa3-all-types.ts
 *
 * Cel: potrójne sprawdzenie wszystkich ścieżek wysyłki do US, zanim ktokolwiek
 * wyśle realną fakturę. Jeśli scenariusz przechodzi tu, KSeF nie odrzuci go
 * z powodu struktury/enumów (zostają jeszcze reguły semantyczne MF, opisane
 * w sprawozdaniu).
 */
import {
  finalizeInvoice,
  type InvoiceInput,
  calculateInvoiceTotals,
  summarizeVatPerRate,
  roundToCents,
} from '@/lib/xml/invoice-calculator';
import { generateFA3Xml } from '@/lib/xml/fa3-generator';
import { generateCorrectionInvoiceXml } from '@/lib/ksef/fa3-correction-generator';
import {
  generateAdvanceInvoiceXml,
  generateFinalInvoiceXml,
  type AdvanceInvoiceSettlementRow,
} from '@/lib/ksef/fa3-advance-generator';
import { validateFA3 } from '@/lib/xml/validator';
import type { Invoice } from '@/types/invoice';
import type {
  CorrectionInvoiceData,
  AdvanceInvoiceData,
  FinalInvoiceData,
} from '@/types/invoice-types';

const SELLER = {
  nip: '5260001246',
  name: 'ACME Software sp. z o.o.',
  address: {
    countryCode: 'PL',
    addressLine1: 'ul. Przykładowa 1/2',
    addressLine2: '00-001 Warszawa',
  },
  email: 'biuro@acme.test',
};

const BUYER_B2B = {
  nip: '5252241585',
  name: 'Klient sp. z o.o.',
  address: {
    countryCode: 'PL',
    addressLine1: 'ul. Klienta 10',
    addressLine2: '02-001 Warszawa',
  },
  email: 'kontakt@klient.test',
};

function baseInput(o: Partial<InvoiceInput> = {}): InvoiceInput {
  return {
    internalNumber: 'FV 2026/04/001',
    type: 'VAT',
    issueDate: '2026-04-19',
    saleDate: '2026-04-19',
    seller: SELLER,
    buyer: BUYER_B2B,
    lines: [
      { ordinal: 1, name: 'Licencja SaaS Pro', unit: 'usł.', quantity: 1, unitPriceNet: 199, vatRate: '23' },
    ],
    payment: {
      currency: 'PLN',
      dueDate: '2026-05-03',
      method: 'transfer',
      bankAccount: 'PL61109010140000071219812874',
      bankName: 'Santander',
    },
    ...o,
  };
}

interface Result {
  name: string;
  xsdValid: boolean;
  arithmeticOk: boolean;
  xsdErrors: string[];
  arithmeticNote: string;
}

const results: Result[] = [];

/** Sprawdza spójność arytmetyczną wygenerowanej faktury zwykłej. */
function checkArithmetic(inv: Invoice): { ok: boolean; note: string } {
  const totals = calculateInvoiceTotals(inv.lines);
  const perRate = summarizeVatPerRate(inv.lines);
  const sumNet = roundToCents(perRate.reduce((s, r) => s + r.netSum, 0));
  const sumVat = roundToCents(perRate.reduce((s, r) => s + r.vatSum, 0));
  const p15 = roundToCents(totals.grossTotal);
  const sumP13P14 = roundToCents(sumNet + sumVat);
  const consistent = Math.abs(p15 - sumP13P14) < 0.005;
  return {
    ok: consistent,
    note: `P_15=${p15.toFixed(2)} vs Σ(P_13+P_14)=${sumP13P14.toFixed(2)} (net=${sumNet.toFixed(2)}, vat=${sumVat.toFixed(2)})`,
  };
}

async function verifyRegular(name: string, input: InvoiceInput): Promise<void> {
  let xsdValid = false;
  let xsdErrors: string[] = [];
  let arith = { ok: false, note: 'nie wygenerowano' };
  try {
    const inv = finalizeInvoice(input);
    arith = checkArithmetic(inv);
    const xml = generateFA3Xml(inv, { validate: true });
    const v = await validateFA3(xml);
    xsdValid = v.valid;
    xsdErrors = v.errors.map((e) => `L${e.line}: ${e.message}`);
  } catch (e) {
    xsdErrors = [(e as Error).message];
  }
  results.push({ name, xsdValid, arithmeticOk: arith.ok, xsdErrors, arithmeticNote: arith.note });
}

async function verifyXml(name: string, xmlFn: () => string): Promise<void> {
  let xsdValid = false;
  let xsdErrors: string[] = [];
  try {
    const xml = xmlFn();
    const v = await validateFA3(xml);
    xsdValid = v.valid;
    xsdErrors = v.errors.map((e) => `L${e.line}: ${e.message}`);
  } catch (e) {
    xsdErrors = [(e as Error).message];
  }
  results.push({ name, xsdValid, arithmeticOk: true, xsdErrors, arithmeticNote: 'n/d (osobny generator)' });
}

async function main(): Promise<void> {
  // ── FAKTURY ZWYKŁE — scenariusze ────────────────────────────
  await verifyRegular('Zwykła · 1 pozycja 23%', baseInput());

  await verifyRegular('Zwykła · wiele stawek (23/8/5/0)', baseInput({
    lines: [
      { ordinal: 1, name: 'Usługa A', unit: 'usł.', quantity: 1, unitPriceNet: 100, vatRate: '23' },
      { ordinal: 2, name: 'Książka', unit: 'szt.', quantity: 2, unitPriceNet: 25, vatRate: '5' },
      { ordinal: 3, name: 'Żywność', unit: 'szt.', quantity: 3, unitPriceNet: 10, vatRate: '8' },
      { ordinal: 4, name: 'Eksport 0%', unit: 'szt.', quantity: 1, unitPriceNet: 500, vatRate: '0' },
    ],
  }));

  await verifyRegular('Zwykła · STRESS zaokrąglenia (7×0.10 @23%)', baseInput({
    lines: Array.from({ length: 7 }, (_, i) => ({
      ordinal: i + 1, name: `Drobiazg ${i + 1}`, unit: 'szt.', quantity: 1, unitPriceNet: 0.10, vatRate: '23' as const,
    })),
  }));

  await verifyRegular('Zwykła · STRESS (3 × 33.33 @23%)', baseInput({
    lines: [{ ordinal: 1, name: 'Godziny', unit: 'godz.', quantity: 3, unitPriceNet: 33.33, vatRate: '23' }],
  }));

  await verifyRegular('Zwykła · duże kwoty (1 000 000.00)', baseInput({
    lines: [{ ordinal: 1, name: 'Projekt', unit: 'usł.', quantity: 1, unitPriceNet: 1000000, vatRate: '23' }],
  }));

  await verifyRegular('Zwykła · cena 0.00 (faktura bezpłatna)', baseInput({
    lines: [{ ordinal: 1, name: 'Gratis', unit: 'szt.', quantity: 1, unitPriceNet: 0, vatRate: '23' }],
  }));

  await verifyRegular('Zwykła · ilość ułamkowa (2.5 godz)', baseInput({
    lines: [{ ordinal: 1, name: 'Konsultacja', unit: 'godz.', quantity: 2.5, unitPriceNet: 120, vatRate: '23' }],
  }));

  await verifyRegular('Zwykła · odwrotne obciążenie (oo)', baseInput({
    lines: [{ ordinal: 1, name: 'Usługa budowlana', unit: 'usł.', quantity: 1, unitPriceNet: 5000, vatRate: 'oo' }],
  }));

  await verifyRegular('Zwykła · nabywca B2C (PESEL)', baseInput({
    buyer: {
      pesel: '44051401359', name: 'Jan Kowalski',
      address: { countryCode: 'PL', addressLine1: 'ul. Domowa 5', addressLine2: '00-002 Warszawa' },
    },
  }));

  await verifyRegular('Zwykła · nabywca zagraniczny (VAT-UE DE)', baseInput({
    buyer: {
      vatUeNumber: 'DE123456789', name: 'Auslandische GmbH',
      address: { countryCode: 'DE', addressLine1: 'Hauptstrasse 1', addressLine2: '10115 Berlin' },
    },
  }));

  await verifyRegular('Zwykła · nie podlega w kraju (np I)', baseInput({
    lines: [{ ordinal: 1, name: 'Montaż za granicą', unit: 'usł.', quantity: 1, unitPriceNet: 2000, vatRate: 'np' }],
  }));

  // AUD-70: usługa z art. 100 ust. 1 pkt 4 (art. 28b) — P_12 „np II”, P_13_9, P_18=1.
  await verifyRegular('Zwykła · np II, nabywca z UE (VAT-UE DE)', baseInput({
    buyer: {
      vatUeNumber: 'DE123456789', name: 'Auslandische GmbH',
      address: { countryCode: 'DE', addressLine1: 'Hauptstrasse 1', addressLine2: '10115 Berlin' },
    },
    lines: [{ ordinal: 1, name: 'Usługa programistyczna', unit: 'usł.', quantity: 1, unitPriceNet: 3000, vatRate: 'np_ii' }],
  }));

  // Grecja: prefiks VAT-UE „EL”, a kraj adresu (ISO) „GR”.
  await verifyRegular('Zwykła · np II + 23%, nabywca z Grecji (EL / adres GR)', baseInput({
    buyer: {
      vatUeNumber: 'EL123456789', name: 'Pelatis A.E.',
      address: { countryCode: 'GR', addressLine1: 'Odos Ermou 1', addressLine2: '10563 Athina' },
    },
    lines: [
      { ordinal: 1, name: 'Licencja', unit: 'szt.', quantity: 2, unitPriceNet: 150, vatRate: '23' },
      { ordinal: 2, name: 'Konsultacja zdalna', unit: 'godz.', quantity: 4, unitPriceNet: 200, vatRate: 'np_ii' },
    ],
  }));

  await verifyRegular('Zwykła · nabywca bez ID (konsument)', baseInput({
    buyer: {
      noIdMarker: true, name: 'Konsument',
      address: { countryCode: 'PL', addressLine1: 'ul. Anonimowa 1', addressLine2: '00-003 Warszawa' },
    },
  }));

  await verifyRegular('Zwykła · płatność gotówką', baseInput({
    payment: { currency: 'PLN', dueDate: '2026-05-03', method: 'cash' },
  }));

  await verifyRegular('Zwykła · płatność kartą', baseInput({
    payment: { currency: 'PLN', dueDate: '2026-05-03', method: 'card' },
  }));

  await verifyRegular('Zwykła · płatność inna', baseInput({
    payment: { currency: 'PLN', dueDate: '2026-05-03', method: 'other' },
  }));

  // ── FAKTURA DO PARAGONU (FP, krok 1.2) ──────────────────────
  // Fa/FP = 1 po RodzajFaktury, dane paragonu (art. 106h ust. 1) w DodatkowyOpis.
  // Firma: paragon z NIP, ponad 450 zł brutto (do 450 zł paragon z 2026 r. jest fakturą uproszczoną).
  await verifyRegular('Zwykła · faktura do paragonu (FP), firma z NIP', baseInput({
    saleDate: '2026-04-10',
    lines: [{ ordinal: 1, name: 'Rower miejski', unit: 'szt.', quantity: 1, unitPriceNet: 1000, vatRate: '23' }],
    payment: { currency: 'PLN', dueDate: '2026-04-19', method: 'cash' },
    receipt: { receiptNumber: '000123', receiptDate: '2026-04-10', cashRegisterNumber: 'ABC1234567890', buyerNipOnReceipt: true },
  }));

  await verifyRegular('Zwykła · faktura do paragonu (FP), konsument bez ID, stara kasa (3 litery i 8 cyfr)', baseInput({
    saleDate: '2026-03-31',
    buyer: {
      noIdMarker: true, name: 'Konsument',
      address: { countryCode: 'PL', addressLine1: 'ul. Anonimowa 1', addressLine2: '00-003 Warszawa' },
    },
    payment: { currency: 'PLN', dueDate: '2026-04-19', method: 'card' },
    receipt: { receiptNumber: 'PAR/2026/03/77', receiptDate: '2026-03-31', cashRegisterNumber: 'BEA12345678', requestDate: '2026-04-15' },
  }));

  // ── FAKTURA KORYGUJĄCA ──────────────────────────────────────
  const correction: CorrectionInvoiceData = {
    invoiceType: 'correction',
    internalNumber: 'FK 2026/04/001',
    issueDate: '2026-04-20',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-05-04',
    bankAccount: 'PL61109010140000071219812874',
    parentInvoiceId: '00000000-0000-0000-0000-000000000001',
    parentInvoiceNumber: 'FV 2026/04/001',
    parentInvoiceIssueDate: '2026-04-19',
    correctionType: 'amount_change',
    correctionReason: 'Zwrot części towaru',
    typKorekty: '2',
    seller: SELLER,
    buyer: { type: 'b2b', idType: 'nip', ...BUYER_B2B },
    amountChange: {
      netDelta: -199,
      vatDelta: -45.77,
      grossDelta: -244.77,
      description: 'Zwrot 1 szt. licencji',
    },
  };
  await verifyXml('KOREKTA · zmiana kwoty (zwrot)', () => generateCorrectionInvoiceXml(correction));

  // KOREKTA z nabywcą B2C PESEL — weryfikuje naprawę bugu NrID
  const correctionPesel: CorrectionInvoiceData = {
    ...correction,
    internalNumber: 'FK 2026/04/002',
    buyer: {
      type: 'b2c', idType: 'pesel', pesel: '44051401359', name: 'Jan Kowalski',
      address: { countryCode: 'PL', addressLine1: 'ul. Domowa 5', addressLine2: '00-002 Warszawa' },
    },
  };
  await verifyXml('KOREKTA · nabywca B2C PESEL (regresja NrID)', () => generateCorrectionInvoiceXml(correctionPesel));

  // AUD-70 KOR: korekta faktury dla firmy z UE — Podmiot2 KodUE+NrVatUE,
  // różnica „np II” w P_13_9 (bez P_14), P_18=1.
  const correctionEuNpII: CorrectionInvoiceData = {
    ...correction,
    internalNumber: 'FK 2026/04/003',
    correctionType: 'before_after',
    correctionReason: 'Zmiana ceny usługi',
    buyer: {
      type: 'eu', vatUeNumber: 'DE123456789', name: 'Auslandische GmbH',
      address: { countryCode: 'DE', addressLine1: 'Hauptstrasse 1', addressLine2: '10115 Berlin' },
    },
    amountChange: undefined,
    linesBefore: [
      { name: 'Usługa programistyczna', unit: 'usł.', quantity: 1, unitPriceNet: 3000, vatRate: 'np_ii' },
    ],
    linesAfter: [
      { name: 'Usługa programistyczna', unit: 'usł.', quantity: 1, unitPriceNet: 2500, vatRate: 'np_ii' },
    ],
  };
  await verifyXml('KOREKTA · przed/po np II, nabywca z UE (VAT-UE DE)', () => generateCorrectionInvoiceXml(correctionEuNpII));

  await verifyXml('KOREKTA · kwotowa np II, nabywca z UE (VAT-UE DE)', () =>
    generateCorrectionInvoiceXml({
      ...correctionEuNpII,
      internalNumber: 'FK 2026/04/004',
      correctionType: 'amount_change',
      correctionReason: 'Rabat posprzedażowy',
      linesBefore: undefined,
      linesAfter: undefined,
      amountChange: { netDelta: -300, vatDelta: 0, grossDelta: -300, description: 'Rabat 10%', vatRate: 'np_ii' },
    }),
  );

  // Grecja: prefiks VAT-UE „EL”, a kraj adresu (ISO) „GR”; korekta 23% + np II.
  await verifyXml('KOREKTA · przed/po np II + 23%, nabywca z Grecji (EL / adres GR)', () =>
    generateCorrectionInvoiceXml({
      ...correctionEuNpII,
      internalNumber: 'FK 2026/04/005',
      buyer: {
        type: 'eu', vatUeNumber: 'EL123456789', name: 'Pelatis A.E.',
        address: { countryCode: 'GR', addressLine1: 'Odos Ermou 1', addressLine2: '10563 Athina' },
      },
      linesBefore: [
        { name: 'Licencja', unit: 'szt.', quantity: 2, unitPriceNet: 150, vatRate: '23' },
        { name: 'Konsultacja zdalna', unit: 'godz.', quantity: 4, unitPriceNet: 200, vatRate: 'np_ii' },
      ],
      linesAfter: [
        { name: 'Licencja', unit: 'szt.', quantity: 1, unitPriceNet: 150, vatRate: '23' },
        { name: 'Konsultacja zdalna', unit: 'godz.', quantity: 3, unitPriceNet: 200, vatRate: 'np_ii' },
      ],
    }),
  );

  // ── FAKTURA ZALICZKOWA ──────────────────────────────────────
  const advance: AdvanceInvoiceData = {
    invoiceType: 'advance',
    taxAnnotations: { cashMethod: 2, splitPayment: 2 },
    internalNumber: 'FZ 2026/04/001',
    issueDate: '2026-04-19',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-04-26',
    bankAccount: 'PL61109010140000071219812874',
    seller: SELLER,
    buyer: { type: 'b2b', idType: 'nip', ...BUYER_B2B },
    advanceAmount: 1230,
    totalContractAmount: 6150,
    expectedDeliveryDate: '2026-06-01',
    vatRate: '23',
    description: 'Zaliczka na wykonanie strony WWW',
  };
  await verifyXml('ZALICZKOWA · 1230 zł brutto', () => generateAdvanceInvoiceXml(advance));

  // ── FAKTURA ROZLICZAJĄCA (FINAL) ────────────────────────────
  const finalData: FinalInvoiceData = {
    invoiceType: 'final',
    taxAnnotations: { cashMethod: 2, splitPayment: 2 },
    internalNumber: 'FR 2026/06/001',
    issueDate: '2026-06-05',
    paymentMethod: 'transfer',
    paymentDueDate: '2026-06-19',
    bankAccount: 'PL61109010140000071219812874',
    seller: SELLER,
    buyer: { type: 'b2b', idType: 'nip', ...BUYER_B2B },
    advanceInvoiceIds: ['00000000-0000-0000-0000-000000000002'],
    totalAdvances: 1230,
    lines: [
      { name: 'Wykonanie strony WWW', unit: 'usł.', quantity: 1, unitPriceNet: 5000, vatRate: '23' },
    ],
  };
  const settlementRows: AdvanceInvoiceSettlementRow[] = [
    {
      internal_number: 'FZ 2026/04/001',
      ksef_number: null,
      advance_amount: 1230,
      issue_date: '2026-04-19',
    },
  ];
  await verifyXml('ROZLICZAJĄCA · 1 zaliczka', () => generateFinalInvoiceXml(finalData, settlementRows));

  // ── RAPORT ──────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(' WERYFIKACJA FA(3) — wszystkie typy faktur względem XSD MF');
  console.log('═══════════════════════════════════════════════════════════════\n');
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    const xsd = r.xsdValid ? '✓ XSD' : '✗ XSD';
    const ar = r.arithmeticOk ? '✓ ARYT' : '✗ ARYT';
    const ok = r.xsdValid && r.arithmeticOk;
    if (ok) pass += 1; else fail += 1;
    console.log(`${ok ? '✅' : '❌'} ${r.name}`);
    console.log(`     ${xsd} | ${ar} | ${r.arithmeticNote}`);
    if (!r.xsdValid && r.xsdErrors.length) {
      r.xsdErrors.slice(0, 3).forEach((e) => console.log(`     ⚠ ${e}`));
    }
  }
  console.log('\n───────────────────────────────────────────────────────────────');
  console.log(` WYNIK: ${pass} OK / ${fail} BŁĄD (łącznie ${results.length} scenariuszy)`);
  console.log('───────────────────────────────────────────────────────────────\n');
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
