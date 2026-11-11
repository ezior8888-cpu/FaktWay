// lib/exports/edi-plus-plus-generator.ts
// Eksport faktur do InsERT Subiekt GT / Rewizor GT w formacie EDI++ (.epp).
//
// Źródło: „Komunikacja - Struktura danych EDI++” (InsERT; wersja formatu 1.05),
//   https://insert.multicomp.pl/Pliki/Serwis/Komunikacja_EDI++_1_05_1.pdf
// (ten sam dokument na forum InsERT: forum.insert.com.pl, załącznik 31029).
// Numery pól poniżej to numery „L.p.” z tego dokumentu.
//
// Reguły, na których stoi generator (z dokumentu):
//  - p. 1.1: plik to sekcje; etykieta w osobnej linii, na jej początku, dane od
//    następnej linii; [INFO] zawsze pierwsza; [NAGLOWEK] i [ZAWARTOSC] razem;
//    każdy rekord w osobnej linii, pola rozdzielone przecinkami; „na końcu
//    pliku wymiany musi się znajdować pusta linia”.
//  - tabela 2: nagłówek pliku ([INFO]) ma 24 pola; cel komunikacji 0 = biuro
//    rachunkowe; strona kodowa 1250 = Windows.
//  - tabela 3: nagłówek dokumentu obrotowego ma 62 pola; typy FS, FZ, KFS, KFZ.
//  - tabela 4: dla celu „biuro rachunkowe” zawartość dokumentu to tabela VAT
//    w rozbiciu na stawki: symbol, wysokość %, netto, VAT, brutto.
//  - p. 1.5: symbole stawek „zw”, „ex”, „ue”, „npo”, „oo”, pozostałe to liczba
//    jako tekst („23”); wysokości -1,00 zw, -2,00 ex, -3,00 ue, -4,00 npo,
//    -5,00 oo.
//  - p. 1.6: strona kodowa Windows-1250, przecinek rozdziela pola, daty
//    yyyymmddhhnnss, kwoty bez symbolu waluty i bez separatora tysięcy,
//    separator dziesiętny kropka.
//
// CZEGO DOKUMENT NIE ROZSTRZYGA (do próbnego importu w Subiekcie/Rewizorze,
// format zostaje wstrzymany w `suspended-formats.ts`):
//  - cudzysłowy: dokument opisuje sterownik ISAM Text (CSVDelimited), czyli
//    teksty w cudzysłowie z cudzysłowem podwojonym (""), liczby i daty bez;
//  - zapis wartości logicznych (przyjęto 0/1) i pusty zapis daty (puste pole);
//  - liczba miejsc kwot: dokument podaje CurrencyDigits=4 dla odczytu, tu 2
//    (grosze, jak na fakturze);
//  - znaczenie pola 25 „Liczba pozycji” przy zawartości w postaci tabeli VAT
//    (przyjęto liczbę pozycji faktury);
//  - symbol dla „np” z FA(3): dokument zna tylko „npo” (nie podlegający
//    odliczeniu); przyjęto „npo”, -4,00;
//  - pełny numer (pole 7): „mnemonik typu i spacja” + numer faktury;
//  - czy między sekcjami mają stać puste linie (dokument wymaga tylko pustej
//    linii na końcu);
//  - pola 21-24 (miejsce, data otrzymania), 34 (forma płatności), 32-33
//    (rabat) i osoby: puste, bo FaktWay ich nie przechowuje przy fakturze.
//
// Kwoty tylko przez `roundToCents` (jak na fakturze). Dokumenty, których
// plik nie wykazałby poprawnie (waluta obca, zaliczkowe i rozliczeniowe,
// usługa z art. 100 ust. 1 pkt 4, kontrahent z UE bez NIP, pozycje niezgodne
// z sumami), dostają odmowę z numerem dokumentu — nie plik z błędnymi kwotami.

import iconv from 'iconv-lite';
import { roundToCents } from '@/lib/xml/invoice-calculator';
import {
  amountsOf,
  counterpartyOf,
  JpkDocumentNotSupportedError,
  type JpkFaInputData,
  type JpkInvoice,
} from './jpk-fa-generator';

export interface EdiPlusPlusInput {
  issuer: Pick<JpkFaInputData['issuer'], 'nip' | 'name' | 'address'>;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
  issuedInvoices: JpkInvoice[];
  receivedInvoices: JpkInvoice[];
  /** Chwila wytworzenia pliku (pole 20 [INFO]); domyślnie teraz. */
  generatedAt?: Date;
}

/** Początek każdej odmowy — po nim job rozpoznaje komunikat dla człowieka. */
export const EDI_REFUSAL_PREFIX = 'Eksport EDI++ wstrzymany:';

const EXIT = 'Użyj uniwersalnego CSV albo przekaż ten dokument księgowej osobno.';

export class EdiPlusPlusForeignCurrencyNotSupportedError extends Error {
  constructor(invoiceNumber: string) {
    super(
      `${EDI_REFUSAL_PREFIX} faktura ${invoiceNumber} nie ma potwierdzonej waluty PLN. ` +
        `Faktury walutowe wymagają uzgodnienia z księgową. ${EXIT}`,
    );
    this.name = 'EdiPlusPlusForeignCurrencyNotSupportedError';
  }
}

export class EdiPlusPlusDocumentNotSupportedError extends Error {
  constructor(invoiceNumber: string, reason: string) {
    super(`${EDI_REFUSAL_PREFIX} faktura ${invoiceNumber} ${reason} Plik nie powstał, żeby nie pominąć ani nie pomylić tego dokumentu. ${EXIT}`);
    this.name = 'EdiPlusPlusDocumentNotSupportedError';
  }
}

type DocType = 'FS' | 'FZ' | 'KFS' | 'KFZ';

/** Symbol i wysokość stawki według p. 1.5 dokumentu EDI++. */
const VAT_SYMBOLS: Readonly<Record<string, { symbol: string; pct: number }>> = {
  '23': { symbol: '23', pct: 23 },
  '8': { symbol: '8', pct: 8 },
  '5': { symbol: '5', pct: 5 },
  '0': { symbol: '0', pct: 0 },
  zw: { symbol: 'zw', pct: -1 },
  np: { symbol: 'npo', pct: -4 }, // niepewne: dokument nie zna „np”
  oo: { symbol: 'oo', pct: -5 },
};
const VAT_ORDER = ['23', '8', '5', '0', 'zw', 'np', 'oo'];

const CRLF = '\r\n';

export function generateEdiPlusPlus(data: EdiPlusPlusInput): Buffer {
  const all = [
    ...data.issuedInvoices.map((inv) => ({ inv, direction: 'issued' as const })),
    ...data.receivedInvoices.map((inv) => ({ inv, direction: 'received' as const })),
  ];
  // Waluta przed wszystkim innym: kwoty nie są przeliczane, więc EUR ani brak
  // waluty nie mogą trafić do pliku jako PLN.
  for (const { inv } of all) {
    if (inv.currency?.trim().toUpperCase() !== 'PLN') {
      throw new EdiPlusPlusForeignCurrencyNotSupportedError(inv.invoiceNumber);
    }
  }

  const sorted = [...all].sort((a, b) => a.inv.issueDate.localeCompare(b.inv.issueDate));
  const counters: Record<DocType, number> = { FS: 0, FZ: 0, KFS: 0, KFZ: 0 };

  const out: string[] = [];
  out.push('[INFO]', infoRecord(data));
  for (const { inv, direction } of sorted) {
    const docType = docTypeOf(inv, direction);
    counters[docType] += 1;
    const doc = buildDocument(inv, direction, docType, counters[docType], data.issuer);
    out.push('[NAGLOWEK]', doc.header, '[ZAWARTOSC]', ...doc.content);
  }

  // Dokument: „na końcu pliku musi się znajdować pusta linia”.
  return iconv.encode(out.join(CRLF) + CRLF + CRLF, 'win1250');
}

// ============================================================================
// [INFO] — tabela 2
// ============================================================================

function infoRecord(data: EdiPlusPlusInput): string {
  const nip = data.issuer.nip.trim();
  const a = data.issuer.address;
  const street = [a?.street, a?.buildingNumber].filter(Boolean).join(' ') + (a?.apartmentNumber ? `/${a.apartmentNumber}` : '');
  return [
    q('1.05', 50), // 1 wersja formatu
    '0', // 2 cel komunikacji: biuro rachunkowe
    '1250', // 3 strona kodowa Windows
    q('FaktWay', 255), // 4 program
    q(nip, 20), // 5 kod nadawcy
    q(data.issuer.name, 40), // 6 nazwa skrócona
    q(data.issuer.name, 80), // 7 nazwa długa
    q(a?.city ?? '', 30), // 8 miasto
    q(a?.postCode ?? '', 6), // 9 kod pocztowy
    q(street, 50), // 10 ulica i numer
    q(nip, 13), // 11 NIP
    q('', 20), // 12 kod magazynu
    q('', 40), // 13 nazwa magazynu
    q('', 255), // 14 opis magazynu
    q('', 5), // 15 analityka magazynu
    '1', // 16 dane z okresu: daty 17-18 istotne
    date(data.periodStart), // 17
    date(data.periodEnd), // 18
    q('FaktWay', 35), // 19 kto wykonał
    dateTimeWarsaw(data.generatedAt ?? new Date()), // 20 kiedy
    q('Polska', 50), // 21
    q('PL', 2), // 22
    q(`PL${nip}`, 20), // 23 NIP unijny
    '0', // 24 czy nadawca unijny (niepewne: FaktWay nie zna statusu VAT-UE)
  ].join(',');
}

// ============================================================================
// [NAGLOWEK] + [ZAWARTOSC] — tabele 3 i 4
// ============================================================================

function docTypeOf(inv: JpkInvoice, direction: 'issued' | 'received'): DocType {
  if (inv.invoiceType === 'correction') return direction === 'issued' ? 'KFS' : 'KFZ';
  return direction === 'issued' ? 'FS' : 'FZ';
}

function buildDocument(
  inv: JpkInvoice,
  direction: 'issued' | 'received',
  docType: DocType,
  ordinal: number,
  issuer: EdiPlusPlusInput['issuer'],
): { header: string; content: string[] } {
  const refuse = (reason: string) => new EdiPlusPlusDocumentNotSupportedError(inv.invoiceNumber, reason);

  if (inv.invoiceType === 'advance' || inv.invoiceType === 'final') {
    throw refuse(
      'jest zaliczkowa albo rozliczeniowa, a jej tabela VAT wymaga wariantu formatu 1.05.1 (zaliczki), którego FaktWay jeszcze nie wykazuje.',
    );
  }
  if (inv.lines.some((l) => l.vatRate.trim().toLowerCase() === 'np_ii')) {
    throw refuse('ma usługę z art. 100 ust. 1 pkt 4 (poza terytorium kraju, rodzaj transakcji do uzgodnienia z księgową), której FaktWay nie wykazuje w EDI++.');
  }
  const party = counterpartyOf(inv, direction);
  if (!party.nip?.trim() && party.vatUe?.trim()) {
    throw refuse('ma kontrahenta z UE bez NIP-u, a rodzaj transakcji (WDT/WNT) wymaga uzgodnienia z księgową.');
  }

  const fullNumber = `${docType} ${inv.invoiceNumber}`;
  if (fullNumber.length > 30) throw refuse(`ma numer dłuższy niż pole „pełny numer” EDI++ (30 znaków razem z oznaczeniem typu „${docType} ”).`);
  if (direction === 'received' && inv.invoiceNumber.length > 20) {
    throw refuse('ma numer dłuższy niż pole „numer dokumentu dostawcy” EDI++ (20 znaków).');
  }
  if ((inv.correctedInvoiceNumber ?? '').length > 30) {
    throw refuse('ma numer faktury korygowanej dłuższy niż pole EDI++ (30 znaków).');
  }

  // Kwoty: te same reguły i odmowy co JPK_FA (import, stawki spoza FaktWay…).
  let rates;
  try {
    rates = amountsOf(inv).rates;
  } catch (error) {
    if (error instanceof JpkDocumentNotSupportedError) {
      throw refuse('ma dane, których FaktWay nie przenosi wiernie do pliku (zaimportowana korekta albo zaliczka, stawka spoza FaktWay, niepełne adnotacje albo kwoty pozycji z KSeF).');
    }
    throw error;
  }
  const table = [...rates]
    .map((r) => ({ ...r, key: r.rate.trim().toLowerCase() }))
    .sort((a, b) => VAT_ORDER.indexOf(a.key) - VAT_ORDER.indexOf(b.key));
  for (const r of table) {
    if (!VAT_SYMBOLS[r.key]) throw refuse(`ma stawkę VAT „${r.rate}”, której EDI++ w FaktWay nie obsługuje.`);
  }

  const net = roundToCents(table.reduce((s, r) => s + r.net, 0));
  const vat = roundToCents(table.reduce((s, r) => s + r.vat, 0));
  const gross = roundToCents(net + vat);
  if (net !== roundToCents(inv.netTotal) || vat !== roundToCents(inv.vatTotal) || gross !== roundToCents(inv.grossTotal)) {
    throw refuse('ma pozycje, których sumy (netto, VAT, brutto) nie zgadzają się z sumami faktury, więc tabela VAT w pliku byłaby błędna.');
  }

  const remarks = [
    inv.ksefNumber ? `KSeF: ${inv.ksefNumber}` : '',
    inv.invoiceType === 'correction' && inv.correctionReason ? `Przyczyna korekty: ${inv.correctionReason}` : '',
  ]
    .filter(Boolean)
    .join('; ');

  const code = (party.nip?.trim() || party.vatUe?.trim() || '');
  const { street, postCode, city } = splitAddress(party.address ?? '');
  const reverseCharge = table.some((r) => r.key === 'oo');

  const header = [
    q(docType, 3), // 1 typ dokumentu
    '1', // 2 status: wykonany
    '0', // 3 rejestracja fiskalna: brak
    String(ordinal), // 4 numer dokumentu (liczba długa)
    q(direction === 'received' ? inv.invoiceNumber : '', 20), // 5 numer dokumentu dostawcy
    q('', 10), // 6 rozszerzenie numeru
    q(fullNumber, 30), // 7 pełny numer
    q(inv.correctedInvoiceNumber ?? '', 30), // 8 numer dokumentu korygowanego
    '', // 9 data wystawienia dokumentu korygowanego (FaktWay jej tu nie ma)
    q('', 30), // 10 numer zamówienia
    q('', 3), // 11 magazyn docelowy
    q(code, 20), // 12 kod kontrahenta
    q(party.name, 40), // 13 nazwa skrócona
    q(party.name, 255), // 14 nazwa pełna
    q(city, 30), // 15
    q(postCode, 6), // 16
    q(street, 50), // 17
    q(code, 20), // 18 NIP
    q('', 30), // 19 kategoria
    q('', 50), // 20 podtytuł kategorii
    q(issuer.address?.city ?? '', 30), // 21 miejsce wystawienia
    date(inv.issueDate), // 22
    date(inv.saleDate ?? inv.issueDate), // 23
    '', // 24 data otrzymania
    String(inv.lines.length), // 25 liczba pozycji
    '1', // 26 wg cen netto
    q('', 20), // 27 aktywna cena
    amount(net), // 28
    amount(vat), // 29
    amount(gross), // 30
    amount(0), // 31 koszt
    q('', 30), // 32 rabat (nazwa)
    amount(0), // 33 rabat %
    q('', 30), // 34 forma płatności
    inv.paymentDueDate ? date(inv.paymentDueDate) : '', // 35 termin płatności
    amount(0), // 36 zapłacono przy odbiorze
    amount(gross), // 37 do zapłaty
    '0', // 38 zaokrąglenie do zapłaty: 1 grosz
    '0', // 39 zaokrąglenie VAT: 1 grosz
    '0', // 40 tabela VAT nie jest przeliczana automatycznie (podajemy własną)
    '0', // 41 status rozszerzony: nieużywany
    q('', 35), // 42
    q('', 35), // 43
    q('', 35), // 44
    amount(0), // 45
    amount(0), // 46
    q('PLN', 3), // 47 waluta
    amount(1), // 48 kurs
    q(remarks, 255), // 49 uwagi
    q('', 50), // 50 komentarz
    q('', 50), // 51 podtytuł
    q('', 50), // 52 nieużywane
    '0', // 53 import dokumentu: nie przeprowadzony
    '0', // 54 dokument eksportowy: nie
    reverseCharge ? '6' : '0', // 55 rodzaj transakcji: 6 odwrotne obciążenie, 0 krajowa
    q('', 50), // 56
    amount(0), // 57
    q('', 50), // 58
    amount(0), // 59
    q('Polska', 50), // 60 państwo kontrahenta
    q('PL', 2), // 61
    '0', // 62 kontrahent unijny: nie
  ].join(',');

  const content = table.map((r) => {
    const v = VAT_SYMBOLS[r.key];
    return [q(v.symbol, 6), amount(v.pct), amount(r.net), amount(r.vat), amount(roundToCents(r.net + r.vat))].join(',');
  });

  return { header, content };
}

// ============================================================================
// Zapis pól
// ============================================================================

/** Tekst: cudzysłów podwojony, znaki nowej linii zamienione na spację, obcięty do długości pola. */
function q(value: string, max: number): string {
  const clean = value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
  return `"${clean.replace(/"/g, '""')}"`;
}

/** Kwota: dwa miejsca, kropka, bez separatora tysięcy, bez „-0.00”. */
function amount(value: number): string {
  const text = roundToCents(value).toFixed(2);
  return text === '-0.00' ? '0.00' : text;
}

/** `YYYY-MM-DD` → `yyyymmddhhnnss` (p. 1.6); nieczytelna data → puste pole. */
function date(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((iso ?? '').trim());
  return m ? `${m[1]}${m[2]}${m[3]}000000` : '';
}

function dateTimeWarsaw(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}${get('second')}`;
}

/** „ul. X 1, 00-001 Miasto” → ulica, kod, miasto; adres w innym układzie zostaje w polu ulicy. */
function splitAddress(address: string): { street: string; postCode: string; city: string } {
  const m = /^(.*?)[,\s]*(\d{2}-\d{3})\s+(.+)$/.exec(address.trim());
  if (!m) return { street: address.trim(), postCode: '', city: '' };
  return { street: m[1].trim(), postCode: m[2], city: m[3].trim() };
}
