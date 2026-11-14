/**
 * Generator XML FA(3) dla faktur zaliczkowych (`ZAL`) i rozliczających (`ROZ`).
 * Sekwencje i nazwy jak w `lib/xml/schemas/fa3/schemat.xsd`
 * (`FakturaZaliczkowa`, `DodatkowyOpis`, `FaWiersz`).
 */

import { create } from 'xmlbuilder2';
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces';

import type { InvoiceLineItem, VatRate } from '@/types/invoice';
import {
  calculateInvoiceTotals,
  calculateLineItem,
  roundToCents,
  summarizeVatPerRate,
} from '@/lib/xml/invoice-calculator';
import type {
  AdvanceInvoiceData,
  BuyerData,
  FinalInvoiceData,
  InvoiceLine,
  SellerData,
} from '@/types/invoice-types';
import {
  calculateAdvanceTotals,
  calculateFinalInvoiceTotals,
} from '@/lib/invoices/calculator';

const FA3_NAMESPACE = 'http://crd.gov.pl/wzor/2025/06/25/13775/';
const ETD_NAMESPACE =
  'http://crd.gov.pl/xml/schematy/dziedzinowe/mf/2022/01/05/eD/DefinicjeTypy/';

const FORM_SYSTEM_CODE = 'FA (3)';
const FORM_VERSION = '1-0E';
const FORM_VALUE = 'FA';
const DEFAULT_SYSTEM_INFO = 'KSeF SaaS v1.0';

interface VatRateMapping {
  netElement: string;
  vatElement?: string;
  p12Value: string;
}

/** Stawki używane na fakturze zaliczkowej (`AdvanceInvoiceData.vatRate`). */
type AdvanceVatRate = NonNullable<AdvanceInvoiceData['vatRate']>;

const ADVANCE_VAT_RATE_MAP: Record<
  AdvanceVatRate,
  VatRateMapping & { canonical: VatRate }
> = {
  '23': {
    canonical: '23',
    netElement: 'P_13_1',
    vatElement: 'P_14_1',
    p12Value: '23',
  },
  '8': { canonical: '8', netElement: 'P_13_2', vatElement: 'P_14_2', p12Value: '8' },
  '5': { canonical: '5', netElement: 'P_13_3', vatElement: 'P_14_3', p12Value: '5' },
  '0': { canonical: '0', netElement: 'P_13_6_1', p12Value: '0 KR' },
};

const FULL_VAT_RATE_MAP: Record<VatRate, VatRateMapping> = {
  '23': { netElement: 'P_13_1', vatElement: 'P_14_1', p12Value: '23' },
  '8': { netElement: 'P_13_2', vatElement: 'P_14_2', p12Value: '8' },
  '5': { netElement: 'P_13_3', vatElement: 'P_14_3', p12Value: '5' },
  '0': { netElement: 'P_13_6_1', p12Value: '0 KR' },
  zw: { netElement: 'P_13_7', p12Value: 'zw' },
  oo: { netElement: 'P_13_10', p12Value: 'oo' },
  np: { netElement: 'P_13_8', p12Value: 'np I' },
  // AUD-70: usługi z art. 100 ust. 1 pkt 4 (nabywca z UE rozlicza VAT).
  np_ii: { netElement: 'P_13_9', p12Value: 'np II' },
};

const P_13_ORDER: readonly string[] = [
  'P_13_1',
  'P_13_2',
  'P_13_3',
  'P_13_4',
  'P_13_5',
  'P_13_6_1',
  'P_13_6_2',
  'P_13_6_3',
  'P_13_7',
  'P_13_8',
  'P_13_9',
  'P_13_10',
  'P_13_11',
];

const PAYMENT_METHOD_MAP: Record<'transfer' | 'cash' | 'card', string> = {
  cash: '1',
  card: '2',
  transfer: '6',
};

export interface AdvanceInvoiceSettlementRow {
  internal_number: string;
  ksef_number?: string | null;
  /** Kwota zaliczki brutto. */
  advance_amount: number;
  issue_date: string;
  /**
   * Stawka i rozbicie zaliczki z faktury zaliczkowej — ROZ pomniejsza o nie
   * P_13_x/P_14_x w tej stawce (`settlementVatSummaries`). Opcjonalne tylko
   * dla zdarzeń zakolejkowanych przed 28.09: wtedy stawka musi wynikać
   * z zamówienia w jednej stawce, a rozbicie liczy się jak w
   * `calculateAdvanceTotals`.
   */
  vat_rate?: string | null;
  net_amount?: number | null;
  vat_amount?: number | null;
}

export interface GenerateAdvanceXmlOptions {
  generatedAt?: Date;
  prettyPrint?: boolean;
  systemInfo?: string;
}

function formatDecimal(value: number, decimals = 2): string {
  return value.toFixed(decimals);
}

function formatDate(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new Error(`FA(3): nieprawidłowy format daty "${isoDate}" (YYYY-MM-DD).`);
  }
  return isoDate;
}

function formatTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function requireText(value: string | undefined | null, field: string): string {
  if (value === undefined || value === null || value === '') {
    throw new Error(`FA(3): wymagane pole "${field}" jest puste.`);
  }
  return value;
}

function emitVatSummariesFromMap(
  fa: XMLBuilder,
  summaries: ReturnType<typeof summarizeVatPerRate>,
  map: Record<VatRate, VatRateMapping>,
): void {
  const emissions = new Map<
    string,
    { netElement: string; vatElement?: string; netSum: number; vatSum: number }
  >();

  for (const s of summaries) {
    const mapping = map[s.rate];
    if (!mapping) {
      throw new Error(`FA(3): brak mapowania XSD dla stawki VAT "${String(s.rate)}".`);
    }
    emissions.set(mapping.netElement, {
      netElement: mapping.netElement,
      vatElement: mapping.vatElement,
      netSum: s.netSum,
      vatSum: s.vatSum,
    });
  }

  for (const elementName of P_13_ORDER) {
    const em = emissions.get(elementName);
    if (!em) continue;
    fa.ele(em.netElement).txt(formatDecimal(em.netSum));
    if (em.vatElement) {
      fa.ele(em.vatElement).txt(formatDecimal(em.vatSum));
    }
  }
}

/**
 * „np II” (usługi z art. 100 ust. 1 pkt 4, AUD-70) wymaga nabywcy z innego
 * państwa UE identyfikowanego numerem VAT-UE (KodUE + NrVatUE). ZAL i ROZ
 * znają tylko nabywcę z NIP albo B2C (`BuyerData`), więc taka faktura byłaby
 * niezgodna z ustawą — przerywamy przed budową XML.
 */
function assertNoNpII(rates: readonly (string | null | undefined)[], kind: 'ZAL' | 'ROZ'): void {
  if (rates.some((rate) => rate === 'np_ii')) {
    const label = kind === 'ZAL' ? 'faktura zaliczkowa' : 'faktura rozliczająca';
    throw new Error(
      `FA(3) ${kind}: stawka „np II” (usługi z art. 100 ust. 1 pkt 4 ustawy o VAT) wymaga nabywcy ` +
        `z innego państwa UE z numerem VAT-UE — ${label} jej nie obsługuje (nabywca z NIP albo B2C).`,
    );
  }
}

function buildAdnotacjeStandard(
  fa: XMLBuilder,
  lines: InvoiceLineItem[],
  taxAnnotations: AdvanceInvoiceData['taxAnnotations'],
): void {
  const adn = fa.ele('Adnotacje');
  // P_18=1 dla „oo” i „np II” (VAT rozlicza nabywca; AUD-70). „np II” blokuje
  // dziś `assertNoNpII`, ale adnotacja ma być spójna z pozycjami.
  const hasReverseChargeLine = lines.some((l) => l.vatRate === 'oo' || l.vatRate === 'np_ii');
  const p18 = hasReverseChargeLine ? 1 : 2;
  const hasZwLine = lines.some((l) => l.vatRate === 'zw');
  if (hasZwLine) {
    throw new Error(
      'FA(3): stawka "zw" wymaga rozbudowanych pól Zwolnienie — MVP nieobsługiwane.',
    );
  }

  adn.ele('P_16').txt(String(taxAnnotations.cashMethod));
  adn.ele('P_17').txt('2');
  adn.ele('P_18').txt(String(p18));
  adn.ele('P_18A').txt(String(taxAnnotations.splitPayment));
  const zwolnienie = adn.ele('Zwolnienie');
  zwolnienie.ele('P_19N').txt('1');
  adn.ele('NoweSrodkiTransportu').ele('P_22N').txt('1');
  adn.ele('P_23').txt('2');
  adn.ele('PMarzy').ele('P_PMarzyN').txt('1');
}

/** ZAL i ROZ: P_16/P_18A tylko z zamrożonej koperty — brak to błąd, nie „2”. */
function requireTaxAnnotations(
  data: AdvanceInvoiceData | FinalInvoiceData,
  kind: 'ZAL' | 'ROZ',
): AdvanceInvoiceData['taxAnnotations'] {
  const flags = data.taxAnnotations;
  if (!flags || (flags.cashMethod !== 1 && flags.cashMethod !== 2) ||
      (flags.splitPayment !== 1 && flags.splitPayment !== 2)) {
    throw new Error(`FA(3) ${kind}: brak zweryfikowanych adnotacji P_16/P_18A.`);
  }
  if (flags.splitPayment === 1 &&
      (data.paymentMethod !== 'transfer' ||
        typeof data.bankAccount !== 'string' || !data.bankAccount.trim())) {
    throw new Error(`FA(3) ${kind}: MPP wymaga przelewu i numeru rachunku.`);
  }
  return flags;
}

function buildHeader(
  root: XMLBuilder,
  generatedAt: Date,
  systemInfo: string,
): void {
  const naglowek = root.ele('Naglowek');
  naglowek
    .ele('KodFormularza', {
      kodSystemowy: FORM_SYSTEM_CODE,
      wersjaSchemy: FORM_VERSION,
    })
    .txt(FORM_VALUE);
  naglowek.ele('WariantFormularza').txt('3');
  naglowek.ele('DataWytworzeniaFa').txt(formatTimestamp(generatedAt));
  naglowek.ele('SystemInfo').txt(systemInfo);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildSeller(root: any, seller: SellerData): void {
  const podmiot1 = root.ele('Podmiot1');
  const dane = podmiot1.ele('DaneIdentyfikacyjne');
  dane.ele('NIP').txt(requireText(seller.nip, 'seller.nip'));
  dane.ele('Nazwa').txt(requireText(seller.name, 'seller.name'));

  const adres = podmiot1.ele('Adres');
  adres
    .ele('KodKraju')
    .txt(requireText(seller.address.countryCode || 'PL', 'seller.address.countryCode'));
  adres.ele('AdresL1').txt(requireText(seller.address.addressLine1, 'seller.address.addressLine1'));
  if (seller.address.addressLine2) {
    adres.ele('AdresL2').txt(seller.address.addressLine2);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildBuyer(root: any, buyer: BuyerData): void {
  const podmiot2 = root.ele('Podmiot2');
  const dane = podmiot2.ele('DaneIdentyfikacyjne');

  if (buyer.type === 'b2b') {
    dane.ele('NIP').txt(requireText(buyer.nip, 'buyer.nip'));
  } else if (buyer.idType === 'pesel' && buyer.pesel) {
    // FA(3) Podmiot2 nie ma NrPESEL — PESEL → KodKraju+NrID (bug fix).
    dane.ele('KodKraju').txt(buyer.address.countryCode || 'PL');
    dane.ele('NrID').txt(buyer.pesel);
  } else if (buyer.idType === 'no_id') {
    dane.ele('BrakID').txt('1');
  } else if (buyer.idNumber) {
    dane.ele('KodKraju').txt(buyer.address.countryCode || 'PL');
    dane.ele('NrID').txt(buyer.idNumber);
  } else {
    throw new Error('FA(3): nabywca B2C — brak PESEL / BrakID / NrInny.');
  }

  dane.ele('Nazwa').txt(requireText(buyer.name, 'buyer.name'));

  const adres = podmiot2.ele('Adres');
  adres.ele('KodKraju').txt(requireText(buyer.address.countryCode, 'buyer.address.countryCode'));
  adres.ele('AdresL1').txt(requireText(buyer.address.addressLine1, 'buyer.address.addressLine1'));
  if (buyer.address.addressLine2) {
    adres.ele('AdresL2').txt(buyer.address.addressLine2);
  }

  podmiot2.ele('JST').txt('2');
  podmiot2.ele('GV').txt('2');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function appendFaWiersz(fa: any, line: InvoiceLineItem): void {
  const wiersz = fa.ele('FaWiersz');
  wiersz.ele('NrWierszaFa').txt(String(line.ordinal));
  // Kolejność z XSD (FaWiersz): P_7, potem klasyfikacja (GTIN, PKWiU, CN), potem P_8A.
  wiersz.ele('P_7').txt(requireText(line.name, `line[${line.ordinal}].name`));

  if (line.classificationCode) {
    if (/^\d{8,14}$/.test(line.classificationCode)) {
      wiersz.ele('GTIN').txt(line.classificationCode);
    } else if (/^\d{4,10}$/.test(line.classificationCode)) {
      wiersz.ele('CN').txt(line.classificationCode);
    } else {
      wiersz.ele('PKWiU').txt(line.classificationCode);
    }
  }

  wiersz.ele('P_8A').txt(requireText(line.unit, `line[${line.ordinal}].unit`));
  wiersz.ele('P_8B').txt(formatDecimal(line.quantity, 4));
  wiersz.ele('P_9A').txt(formatDecimal(line.unitPriceNet, 4));
  wiersz.ele('P_11').txt(formatDecimal(line.netAmount));

  const mapping = FULL_VAT_RATE_MAP[line.vatRate];
  if (!mapping) {
    throw new Error(`FA(3): brak mapowania P_12 dla vatRate "${line.vatRate}".`);
  }
  wiersz.ele('P_12').txt(mapping.p12Value);
}

function toPreparedLineItems(lines: InvoiceLine[]): InvoiceLineItem[] {
  return lines.map((line, idx) => {
    const { netAmount, vatAmount, grossAmount } = calculateLineItem({
      quantity: line.quantity,
      unitPriceNet: line.unitPriceNet,
      vatRate: line.vatRate as VatRate,
    });
    return {
      ordinal: idx + 1,
      name: line.name,
      unit: line.unit,
      quantity: line.quantity,
      unitPriceNet: line.unitPriceNet,
      vatRate: line.vatRate as VatRate,
      classificationCode:
        line.pkwiuCode && /^[0-9A-Za-z]+$/.test(line.pkwiuCode)
          ? line.pkwiuCode
          : undefined,
      netAmount,
      vatAmount,
      grossAmount,
    };
  });
}

function buildPlatnoscFa(
  fa: XMLBuilder,
  data: AdvanceInvoiceData | FinalInvoiceData,
): void {
  const platnosc = fa.ele('Platnosc');
  platnosc.ele('TerminPlatnosci').ele('Termin').txt(formatDate(data.paymentDueDate));

  if (
    data.paymentMethod === 'other' ||
    data.paymentMethod === 'compensation' ||
    !(data.paymentMethod in PAYMENT_METHOD_MAP)
  ) {
    platnosc.ele('PlatnoscInna').txt('1');
    platnosc
      .ele('OpisPlatnosci')
      .txt(
        data.paymentMethod === 'compensation'
          ? 'kompensata'
          : data.paymentMethod === 'other'
            ? 'inna'
            : data.paymentMethod,
      );
  } else {
    const code = PAYMENT_METHOD_MAP[data.paymentMethod as keyof typeof PAYMENT_METHOD_MAP];
    platnosc.ele('FormaPlatnosci').txt(code);
  }

  if (data.bankAccount?.trim()) {
    const iban = data.bankAccount.replace(/\s+/g, '').toUpperCase();
    const nrRb = iban.startsWith('PL') ? iban.slice(2) : iban;
    const rachunek = platnosc.ele('RachunekBankowy');
    rachunek.ele('NrRB').txt(nrRb);
  }
}

function advanceLineItem(data: AdvanceInvoiceData): InvoiceLineItem {
  const totals = calculateAdvanceTotals(data);
  const rateCfg = ADVANCE_VAT_RATE_MAP[data.vatRate];
  return {
    ordinal: 1,
    unit: 'szt.',
    quantity: 1,
    name: `Zaliczka: ${data.description}`,
    unitPriceNet: totals.advanceNet,
    vatRate: rateCfg.canonical,
    netAmount: totals.advanceNet,
    vatAmount: totals.advanceVat,
    grossAmount: totals.advanceGross,
  };
}

/** Faktura zaliczkowa — `RodzajFaktury` = `ZAL`. */
export function generateAdvanceInvoiceXml(
  data: AdvanceInvoiceData,
  options: GenerateAdvanceXmlOptions = {},
): string {
  const taxAnnotations = requireTaxAnnotations(data, 'ZAL');
  // Koperta z bazy (JSON) nie przechodzi przez typ `vatRate` — sprawdzamy w runtime.
  assertNoNpII([data.vatRate], 'ZAL');
  const {
    generatedAt = new Date(),
    prettyPrint = true,
    systemInfo = DEFAULT_SYSTEM_INFO,
  } = options;

  const advanceLine = advanceLineItem(data);
  const summaries = summarizeVatPerRate([advanceLine]);

  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele('Faktura', {
    xmlns: FA3_NAMESPACE,
    'xmlns:etd': ETD_NAMESPACE,
  });

  buildHeader(root, generatedAt, systemInfo);
  buildSeller(root, data.seller);
  buildBuyer(root, data.buyer);

  const fa = root.ele('Fa');
  fa.ele('KodWaluty').txt('PLN');
  fa.ele('P_1').txt(formatDate(data.issueDate));
  fa.ele('P_2').txt(requireText(data.internalNumber, 'internalNumber'));
  // F12-D1: P_6 to data otrzymania zaliczki, o ile różni się od daty wystawienia
  // (art. 106f ust. 1 pkt 1 w zw. z art. 106e ust. 1 pkt 6; opis P_6 w schemacie).
  if (data.advanceReceivedDate && data.advanceReceivedDate !== data.issueDate) {
    fa.ele('P_6').txt(formatDate(data.advanceReceivedDate));
  }

  emitVatSummariesFromMap(fa, summaries, FULL_VAT_RATE_MAP);
  fa.ele('P_15').txt(formatDecimal(advanceLine.grossAmount));

  buildAdnotacjeStandard(fa, [advanceLine], taxAnnotations);

  fa.ele('RodzajFaktury').txt('ZAL');

  const contractOpis = fa.ele('DodatkowyOpis');
  contractOpis.ele('Klucz').txt('Wartość_umowy_całkowita_PLN');
  contractOpis.ele('Wartosc').txt(formatDecimal(data.totalContractAmount));

  // Bez „pozostało do rozliczenia” (AUD-95): ZAL nie wie o wcześniejszych
  // zaliczkach tej samej umowy, więc kwota bywała zawyżona. Ustawa jej nie
  // wymaga — wymaga wartości zamówienia (`Zamowienie` niżej).

  if (data.expectedDeliveryDate) {
    const d = fa.ele('DodatkowyOpis');
    d.ele('Klucz').txt('Planowana_data_realizacji');
    d.ele('Wartosc').txt(formatDate(data.expectedDeliveryDate));
  }

  appendFaWiersz(fa, advanceLine);

  buildPlatnoscFa(fa, data);

  buildZamowienie(fa, data);

  if (data.notes?.trim()) {
    const stopka = root.ele('Stopka');
    stopka.ele('Informacje').ele('StopkaFaktury').txt(data.notes.trim());
  }

  return root.end({ prettyPrint, headless: false });
}

/**
 * Dane zamówienia lub umowy na fakturze zaliczkowej (art. 106f ust. 1 pkt 4
 * ustawy o VAT; element `Zamowienie` FA(3), po `Platnosc`) — AUD-71.
 * Formularz ZAL zna jedną pozycję umowy: opis, wartość brutto i stawkę,
 * więc wiersz jest jeden, ilość 1, a netto i VAT liczone jak dla zaliczki.
 */
function buildZamowienie(fa: XMLBuilder, data: AdvanceInvoiceData): void {
  const rateCfg = ADVANCE_VAT_RATE_MAP[data.vatRate];
  const contract = calculateAdvanceTotals({
    vatRate: data.vatRate,
    advanceAmount: data.totalContractAmount,
    totalContractAmount: data.totalContractAmount,
  });
  const zamowienie = fa.ele('Zamowienie');
  zamowienie.ele('WartoscZamowienia').txt(formatDecimal(data.totalContractAmount));
  const wiersz = zamowienie.ele('ZamowienieWiersz');
  wiersz.ele('NrWierszaZam').txt('1');
  wiersz.ele('P_7Z').txt(requireText(data.description, 'description'));
  wiersz.ele('P_8AZ').txt('szt.');
  wiersz.ele('P_8BZ').txt(formatDecimal(1, 4));
  wiersz.ele('P_9AZ').txt(formatDecimal(contract.advanceNet, 4));
  wiersz.ele('P_11NettoZ').txt(formatDecimal(contract.advanceNet));
  wiersz.ele('P_11VatZ').txt(formatDecimal(contract.advanceVat));
  wiersz.ele('P_12Z').txt(rateCfg.p12Value);
}

/**
 * P_13_x / P_14_x faktury rozliczającej (art. 106f ust. 3 ustawy o VAT):
 * wartość i podatek PEŁNEGO zamówienia w podziale na stawki, pomniejszone
 * o zaliczki — każda w swojej stawce. Pozycje (`FaWiersz`) zostają pełne,
 * a P_15 to kwota pozostała do zapłaty (broszura MF FA(3): opis P_15
 * i elementu FaWiersz dla faktur z art. 106f ust. 3).
 *
 * Do 28.09 generator wpisywał tu pełne zamówienie, a zaliczki odejmował
 * w `Rozliczenie/Odliczenia` — elemencie na obciążenia i odliczenia SPOZA
 * czynności (broszura: zwrot opłat, saldo klienta, różnice z korekt).
 * Faktura w KSeF wykazywała więc VAT zaliczek drugi raz.
 */
export function settlementVatSummaries(
  lines: InvoiceLineItem[],
  advances: readonly AdvanceInvoiceSettlementRow[],
): ReturnType<typeof summarizeVatPerRate> {
  const summaries = summarizeVatPerRate(lines);
  const byRate = new Map(summaries.map((s) => [s.rate, { ...s }]));

  for (const adv of advances) {
    const { rate, net, vat } = advanceSplit(adv, [...byRate.keys()]);
    const bucket = byRate.get(rate);
    if (!bucket) {
      throw new Error(
        `FA(3) ROZ: zaliczka ${adv.internal_number} jest w stawce ${rate}, a zamówienie nie ma pozycji w tej stawce.`,
      );
    }
    bucket.netSum = roundToCents(bucket.netSum - net);
    bucket.vatSum = roundToCents(bucket.vatSum - vat);
    if (bucket.netSum < 0 || bucket.vatSum < 0) {
      throw new Error(`FA(3) ROZ: zaliczki przekraczają wartość zamówienia w stawce ${rate}.`);
    }
  }

  return summaries.map((s) => byRate.get(s.rate) ?? s);
}

function isVatRate(value: string): value is VatRate {
  return Object.prototype.hasOwnProperty.call(FULL_VAT_RATE_MAP, value);
}

function advanceSplit(
  adv: AdvanceInvoiceSettlementRow,
  orderRates: readonly VatRate[],
): { rate: VatRate; net: number; vat: number } {
  const declared = adv.vat_rate?.trim();
  let rate: VatRate;
  if (declared) {
    if (!isVatRate(declared)) {
      throw new Error(`FA(3) ROZ: nieznana stawka "${declared}" zaliczki ${adv.internal_number}.`);
    }
    rate = declared;
  } else if (orderRates.length === 1) {
    rate = orderRates[0];
  } else {
    throw new Error(
      `FA(3) ROZ: brak stawki zaliczki ${adv.internal_number}, a zamówienie ma kilka stawek — nie da się rozbić podatku.`,
    );
  }

  if (adv.net_amount != null && adv.vat_amount != null) {
    return { rate, net: Number(adv.net_amount), vat: Number(adv.vat_amount) };
  }
  // Jak `calculateAdvanceTotals`: netto = brutto / (1 + stawka), VAT = reszta.
  const pct = rate === '23' || rate === '8' || rate === '5' ? Number(rate) : 0;
  const net = roundToCents(adv.advance_amount / (1 + pct / 100));
  return { rate, net, vat: roundToCents(adv.advance_amount - net) };
}

/** Faktura rozliczająca zaliczki — `RodzajFaktury` = `ROZ`. */
export function generateFinalInvoiceXml(
  data: FinalInvoiceData,
  advanceInvoices: AdvanceInvoiceSettlementRow[],
  options: GenerateAdvanceXmlOptions = {},
): string {
  if (!advanceInvoices.length) {
    throw new Error('FA(3) ROZ: przekazano pustą listę faktur zaliczkowych.');
  }
  const taxAnnotations = requireTaxAnnotations(data, 'ROZ');
  assertNoNpII(
    [...data.lines.map((l) => l.vatRate), ...advanceInvoices.map((a) => a.vat_rate?.trim())],
    'ROZ',
  );

  const {
    generatedAt = new Date(),
    prettyPrint = true,
    systemInfo = DEFAULT_SYSTEM_INFO,
  } = options;

  const preparedLines = toPreparedLineItems(data.lines);
  if (preparedLines.length === 0) {
    throw new Error('FA(3) ROZ: brak pozycji faktury końcowej.');
  }

  // P_13_x/P_14_x i P_15 — po odjęciu zaliczek; FaWiersz — pełne zamówienie.
  const summaries = settlementVatSummaries(preparedLines, advanceInvoices);
  const totals = calculateInvoiceTotals(preparedLines);
  const sumAdvancesRound = roundToCents(
    advanceInvoices.reduce((s, a) => s + roundToCents(a.advance_amount), 0),
  );

  // Zaliczki ponad zamówienie zatrzymuje już `settlementVatSummaries` (stawka
  // spadłaby poniżej zera), więc P_15 nie wyjdzie ujemne.
  const finalTotals = calculateFinalInvoiceTotals(data.lines, sumAdvancesRound);

  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele('Faktura', {
    xmlns: FA3_NAMESPACE,
    'xmlns:etd': ETD_NAMESPACE,
  });

  buildHeader(root, generatedAt, systemInfo);
  buildSeller(root, data.seller);
  buildBuyer(root, data.buyer);

  const fa = root.ele('Fa');
  fa.ele('KodWaluty').txt('PLN');
  fa.ele('P_1').txt(formatDate(data.issueDate));
  fa.ele('P_2').txt(requireText(data.internalNumber, 'internalNumber'));

  emitVatSummariesFromMap(fa, summaries, FULL_VAT_RATE_MAP);
  fa.ele('P_15').txt(formatDecimal(finalTotals.amountDue));

  buildAdnotacjeStandard(fa, preparedLines, taxAnnotations);

  fa.ele('RodzajFaktury').txt('ROZ');

  // Kwoty dla człowieka czytającego fakturę — pełne zamówienie i suma
  // zaliczek. Na pola podatkowe nie wpływają (te są już po odjęciu).
  const orderOpis = fa.ele('DodatkowyOpis');
  orderOpis.ele('Klucz').txt('Wartość_zamówienia_brutto_PLN');
  orderOpis.ele('Wartosc').txt(formatDecimal(totals.grossTotal));
  const advancesOpis = fa.ele('DodatkowyOpis');
  advancesOpis.ele('Klucz').txt('Rozliczone_zaliczki_brutto_PLN');
  advancesOpis.ele('Wartosc').txt(formatDecimal(sumAdvancesRound));

  for (const adv of advanceInvoices) {
    const fz = fa.ele('FakturaZaliczkowa');
    const ksef = adv.ksef_number?.trim();
    if (ksef) {
      fz.ele('NrKSeFFaZaliczkowej').txt(ksef);
    } else {
      fz.ele('NrKSeFZN').txt('1');
      fz.ele('NrFaZaliczkowej').txt(requireText(adv.internal_number, 'advance.internal_number'));
    }
  }

  for (const line of preparedLines) {
    appendFaWiersz(fa, line);
  }

  // Bez `Rozliczenie`: zaliczki są już odjęte w P_13_x/P_14_x/P_15, a
  // `DoZaplaty = P_15 − Odliczenia` odjęłoby je drugi raz.

  buildPlatnoscFa(fa, data);

  if (data.notes?.trim()) {
    const stopka = root.ele('Stopka');
    stopka.ele('Informacje').ele('StopkaFaktury').txt(data.notes.trim());
  }

  return root.end({ prettyPrint, headless: false });
}
