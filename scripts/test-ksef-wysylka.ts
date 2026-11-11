/**
 * Prawdziwa wysyłka faktur na KSeF TEST (plan „zero zgubionych faktur”, sesja H1a).
 *
 * Uruchom (bez sekretów, wszystko powstaje w locie):
 *   pnpm ksef:test-wysylka
 *
 * Ta sama droga co worker od XML do KSeF (`generateFA3Xml` -> `validateInvoiceXml` ->
 * `submitInvoice`), tylko bez bazy i magazynu plików. Pełny runner z bazą to sesja H1b.
 *
 * Co robi i czego NIE robi:
 * - rozmawia wyłącznie z KSeF TEST, a przy `KSEF_ENV=production` odmawia startu,
 * - przy każdym uruchomieniu losuje fikcyjny NIP z poprawną sumą kontrolną i tworzy
 *   certyfikat samopodpisany w pamięci (TEST je dopuszcza), nic nie zapisuje w repo,
 * - numer faktury ma identyfikator przebiegu, bo KSeF pilnuje unikalności numeru,
 * - dane TEST są współdzielone między integratorami, więc nie wysyłaj tu prawdziwych danych.
 *
 * Numery scenariuszy jak w sekcji 6 planu. Wynik: tabela w logu i podsumowanie joba.
 * Scenariusz 14 (faktura do paragonu z FP) dopisał krok 1.2 planu kompletnej aplikacji.
 */

import { randomInt, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

import type { KsefAuth } from '../lib/ksef/auth';
import { getKsefBaseUrl, ksefFetch } from '../lib/ksef/client';
import { prepareKsefCredentials } from '../lib/ksef/connect-credentials';
import { ksefSessionCache } from '../lib/ksef/session-cache';
import { KsefInvoiceRejectedError, submitInvoice } from '../lib/ksef/submit';
import { todayInWarsaw } from '../lib/format/warsaw-date';
import { generateFA3Xml } from '../lib/xml/fa3-generator';
import { validateInvoiceXml } from '../lib/xml/validator';
import { makeSelfSignedCertificate } from '../tests/helpers/self-signed-cert';
import type { Invoice } from '../types/invoice';
import type { InvoiceStatusResponse } from '../types/ksef';

const ENV = 'test' as const;
const UPO_WAIT_MS = 120_000;
const UPO_POLL_MS = 10_000;

type RawStatus = InvoiceStatusResponse & {
  invoicingMode?: string;
  invoicingDate?: string;
  acquisitionDate?: string;
};

interface References {
  sessionReferenceNumber: string;
  invoiceReferenceNumber: string;
}

interface Sent {
  xml: string;
  references?: References;
  raw?: RawStatus;
  accepted: boolean;
  error?: string;
}

interface Row {
  id: string;
  title: string;
  passed: boolean;
  facts: string;
}

function fictionalNip(): string {
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  for (;;) {
    const digits = Array.from({ length: 9 }, (_, i) => randomInt(i === 0 ? 1 : 0, 10));
    const control = digits.reduce((sum, digit, i) => sum + digit * weights[i]!, 0) % 11;
    if (control !== 10) return `${digits.join('')}${control}`;
  }
}

/** Dzień kalendarzowy przesunięty względem dzisiejszego w Polsce, w formacie P_1. */
function warsawDay(offsetDays: number): string {
  const [year, month, day] = todayInWarsaw().split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + offsetDays)).toISOString().slice(0, 10);
}

function buildInvoice(sellerNip: string, number: string, issueDate: string): Invoice {
  return {
    internalNumber: number,
    type: 'VAT',
    issueDate,
    saleDate: issueDate,
    seller: {
      nip: sellerNip,
      name: 'Firma testowa KSeF TEST',
      address: { countryCode: 'PL', addressLine1: 'ul. Testowa 1', addressLine2: '00-001 Warszawa' },
      email: 'test@example.invalid',
    },
    buyer: {
      nip: '2222222222',
      name: 'Nabywca testowy Sp. z o.o.',
      address: { countryCode: 'PL', addressLine1: 'ul. Nabywcy 5', addressLine2: '00-002 Warszawa' },
    },
    lines: [
      {
        ordinal: 1,
        name: 'Usługa testowa',
        unit: 'szt',
        quantity: 1,
        unitPriceNet: 100,
        netAmount: 100,
        vatRate: '23',
        vatAmount: 23,
        grossAmount: 123,
      },
    ],
    netTotal: 100,
    vatTotal: 23,
    grossTotal: 123,
    payment: {
      amountDue: 123,
      currency: 'PLN',
      dueDate: warsawDay(14),
      method: 'transfer',
      bankAccount: 'PL61109010140000071219812874',
    },
  };
}

/**
 * Faktura do paragonu (krok 1.2 planu kompletnej aplikacji): `Fa/FP` = 1 i dane
 * paragonu w `DodatkowyOpis`. Paragon z wczoraj z NIP nabywcy, ponad 450 zł
 * brutto (do 450 zł paragon z NIP z 2026 r. jest fakturą uproszczoną).
 */
function buildReceiptInvoice(sellerNip: string, number: string, issueDate: string, receiptDate: string): Invoice {
  const base = buildInvoice(sellerNip, number, issueDate);
  return {
    ...base,
    saleDate: receiptDate,
    lines: [{ ...base.lines[0]!, unitPriceNet: 1000, netAmount: 1000, vatAmount: 230, grossAmount: 1230 }],
    netTotal: 1000,
    vatTotal: 230,
    grossTotal: 1230,
    payment: { ...base.payment, amountDue: 1230, method: 'cash', bankAccount: undefined, dueDate: issueDate },
    receipt: {
      receiptNumber: `PAR/${number}`,
      receiptDate,
      cashRegisterNumber: 'ABC1234567890',
      buyerNipOnReceipt: true,
    },
  };
}

async function readRawStatus(auth: KsefAuth, references: References): Promise<RawStatus> {
  const { accessToken } = await ksefSessionCache.getSession(auth, ENV);
  return ksefFetch<RawStatus>(
    `/sessions/${encodeURIComponent(references.sessionReferenceNumber)}/invoices/${encodeURIComponent(references.invoiceReferenceNumber)}`,
    { accessToken, env: ENV },
  );
}

async function send(auth: KsefAuth, xml: string): Promise<Sent> {
  const validation = await validateInvoiceXml(xml);
  if (!validation.valid) {
    return { xml, accepted: false, error: `XSD: ${JSON.stringify(validation.errors).slice(0, 300)}` };
  }
  let references: References | undefined;
  try {
    const result = await submitInvoice(xml, auth, ENV, undefined, {
      onInvoiceSent: async (sent) => {
        references = sent;
      },
    });
    const finalReferences = {
      sessionReferenceNumber: result.sessionReferenceNumber,
      invoiceReferenceNumber: result.invoiceReferenceNumber,
    };
    return { xml, references: finalReferences, raw: await readRawStatus(auth, finalReferences), accepted: true };
  } catch (error) {
    const raw = references ? await readRawStatus(auth, references).catch(() => undefined) : undefined;
    return {
      xml,
      references,
      raw,
      accepted: false,
      error: `${error instanceof KsefInvoiceRejectedError ? 'odrzucona' : 'błąd'}: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`,
    };
  }
}

function describeSent(sent: Sent): string {
  const raw = sent.raw;
  const parts = [
    `przyjęta: ${sent.accepted ? 'tak' : 'nie'}`,
    `kod: ${raw?.status.code ?? 'brak'}`,
    raw?.status.description ? `opis: ${raw.status.description}` : '',
    raw?.status.details?.length ? `szczegóły: ${raw.status.details.join('; ').slice(0, 300)}` : '',
    raw?.invoicingMode ? `tryb: ${raw.invoicingMode}` : '',
    raw?.invoicingDate ? `invoicingDate: ${raw.invoicingDate}` : '',
    raw?.ksefNumber ? `numer KSeF: ${raw.ksefNumber}` : '',
    !raw && sent.error ? sent.error : '',
  ];
  return parts.filter(Boolean).join(', ');
}

/** UPO bywa gotowe dopiero po zamknięciu sesji: czekamy ograniczony czas i tylko raportujemy brak. */
async function waitForUpo(auth: KsefAuth, references: References): Promise<string> {
  const deadline = Date.now() + UPO_WAIT_MS;
  for (;;) {
    const raw = await readRawStatus(auth, references);
    if (raw.upoDownloadUrl) {
      const response = await fetch(raw.upoDownloadUrl);
      const body = response.ok ? await response.text() : '';
      return `UPO: HTTP ${response.status}, zawiera numer KSeF: ${raw.ksefNumber && body.includes(raw.ksefNumber) ? 'tak' : 'nie'}`;
    }
    if (Date.now() > deadline) return `UPO: brak adresu po ${UPO_WAIT_MS / 1000} s`;
    await new Promise((resolve) => setTimeout(resolve, UPO_POLL_MS));
  }
}

async function main(): Promise<number> {
  if (process.env.KSEF_ENV === 'production') {
    console.error('Odmowa: ten skrypt działa wyłącznie na KSeF TEST.');
    return 2;
  }

  const runId = randomUUID().slice(0, 8).toUpperCase();
  const nip = fictionalNip();
  const material = makeSelfSignedCertificate({ kind: 'rsa', nip, subject: 'seal' });
  const prepared = prepareKsefCredentials({
    certificate: Buffer.from(material.certPem),
    privateKey: Buffer.from(material.keyPem),
  });
  if (!prepared.ok) {
    console.error(`Certyfikat testowy odrzucony lokalnie: ${prepared.problem}`);
    return 2;
  }
  const auth: KsefAuth = {
    type: 'xades',
    nip,
    certificatePem: prepared.certificatePem,
    privateKeyPem: prepared.privateKeyPem,
  };

  console.log(`KSeF: ${getKsefBaseUrl(ENV)}, przebieg ${runId}, fikcyjny NIP ${nip}`);
  const generatedAt = new Date();
  const xmlFor = (suffix: string, issueDate: string) =>
    generateFA3Xml(buildInvoice(nip, `H1A/${runId}/${suffix}`, issueDate), { generatedAt });
  const rows: Row[] = [];

  // 1. Zwykła faktura z dzisiejszą datą.
  const regularXml = xmlFor('1', warsawDay(0));
  const regular = await send(auth, regularXml);
  const upo = regular.references ? await waitForUpo(auth, regular.references) : 'UPO: bez sesji';
  rows.push({
    id: '1',
    title: 'Zwykła faktura, P_1 = dziś',
    passed: regular.accepted && Boolean(regular.raw?.ksefNumber) && regular.raw?.invoicingMode === 'Online',
    facts: `${describeSent(regular)}, ${upo}`,
  });

  // 2. Ten sam plik drugi raz: KSeF odrzuca jako duplikat i wskazuje oryginał.
  const duplicate = await send(auth, regularXml);
  rows.push({
    id: '2',
    title: 'Ten sam plik drugi raz',
    passed:
      !duplicate.accepted &&
      duplicate.raw?.status.code === 440 &&
      duplicate.raw.status.extensions?.originalKsefNumber === regular.raw?.ksefNumber,
    facts: `${describeSent(duplicate)}, oryginał: ${duplicate.raw?.status.extensions?.originalKsefNumber ?? 'brak'}`,
  });

  // 3. Data wystawienia z przyszłości: odrzucenie semantyczne (450).
  const future = await send(auth, xmlFor('3', warsawDay(1)));
  rows.push({
    id: '3',
    title: 'Odrzucenie: P_1 = jutro',
    passed: !future.accepted && future.raw?.status.code === 450,
    facts: describeSent(future),
  });

  // 13. Założenie B1 (art. 106nda ust. 16): KSeF przyjmuje taką fakturę i sam nadaje tryb offline.
  const yesterday = await send(auth, xmlFor('13', warsawDay(-1)));
  rows.push({
    id: '13',
    title: 'P_1 = wczoraj, bez offlineMode',
    passed: yesterday.accepted && Boolean(yesterday.raw?.ksefNumber) && yesterday.raw?.invoicingMode === 'Offline',
    facts: describeSent(yesterday),
  });

  // 13b. KSeF nie pilnuje terminu dosłania, więc musi go pilnować aplikacja (sesja B2).
  const overdue = await send(auth, xmlFor('13b', warsawDay(-5)));
  rows.push({
    id: '13b',
    title: 'P_1 = 5 dni temu, bez offlineMode',
    passed: overdue.accepted && overdue.raw?.invoicingMode === 'Offline',
    facts: describeSent(overdue),
  });

  // 14. Faktura do paragonu (krok 1.2): KSeF przyjmuje FA(3) z FP = 1 i DodatkowyOpis.
  const receiptXml = generateFA3Xml(
    buildReceiptInvoice(nip, `H1A/${runId}/14`, warsawDay(0), warsawDay(-1)),
    { generatedAt },
  );
  const receipt = await send(auth, receiptXml);
  rows.push({
    id: '14',
    title: 'Faktura do paragonu (FP = 1, dane paragonu w DodatkowyOpis)',
    passed:
      receiptXml.includes('<FP>1</FP>') &&
      receipt.accepted &&
      Boolean(receipt.raw?.ksefNumber) &&
      receipt.raw?.invoicingMode === 'Online',
    facts: describeSent(receipt),
  });

  const report = [
    `## KSeF TEST: wysyłka, przebieg ${runId}`,
    '',
    '| Scenariusz | Wynik | Co odpowiedział KSeF |',
    '|---|---|---|',
    ...rows.map((row) => `| ${row.id}. ${row.title} | ${row.passed ? 'OK' : 'BŁĄD'} | ${row.facts.replaceAll('|', '/')} |`),
    '',
  ].join('\n');
  console.log(`\n${report}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

  return rows.every((row) => row.passed) ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
