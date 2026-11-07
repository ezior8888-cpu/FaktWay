/**
 * Próba techniczna wysyłki JPK_V7M(3) na środowisko TESTOWE MF (plan
 * księgowości JDG, K6.0): plik z fikcyjnym podatnikiem (NIP testowy
 * z AGENTS.md, „Jan Testowy”), fikcyjne dane autoryzujące, potem
 * odpytywanie statusu do UPO albo odmowy. Środowiska produkcyjnego skrypt
 * nie zna.
 *
 * Uruchom z katalogu repo:
 *   pnpm tsx scripts/test-jpk-mf.ts --sucho          # tylko paczka i metadane, bez wysyłki
 *   pnpm tsx scripts/test-jpk-mf.ts [katalog-na-upo] # wysyłka i status (do 10 min)
 *
 * Dane autoryzujące nie są wypisywane; w metadanych są zaszyfrowane.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { JpkInvoice } from '../lib/exports/jpk-fa-generator';
import { generateJpkV7m, JPK_V7M_FORM_CODE } from '../lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '../lib/exports/jpk-v7m-validator';
import { certyfikatMf } from '../lib/ksiegowosc/wysylka-jpk/certyfikaty';
import { BladMf, statusWysylki } from '../lib/ksiegowosc/wysylka-jpk/klient';
import { ocenOdmoweInit, ocenStatus } from '../lib/ksiegowosc/wysylka-jpk/statusy';
import { przygotujPaczke, wyslijJpk } from '../lib/ksiegowosc/wysylka-jpk/wyslij';

const SRODOWISKO = 'test' as const;
const NIP = '1234567890';
const CO_ILE_MS = 15_000;
const ILE_RAZY = 40;

function plik() {
  const faktura = {
    invoiceNumber: 'TEST/1/10/2026',
    currency: 'PLN',
    invoiceType: 'regular',
    issueDate: '2026-10-05',
    buyerName: 'Klient testowy',
    netTotal: 1000,
    vatTotal: 230,
    grossTotal: 1230,
    lines: [{ position: 1, name: 'Usługa testowa', unit: 'szt.', quantity: 1, unitPriceNet: 1000, netAmount: 1000, vatRate: '23' }],
  } as JpkInvoice;
  const xml = generateJpkV7m({
    issuer: {
      nip: NIP,
      name: 'Jan Testowy',
      email: 'jan.testowy@example.test',
      taxOfficeCode: '1433',
      naturalPerson: { firstName: 'Jan', lastName: 'Testowy', birthDate: '1980-01-01' },
    },
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    issuedInvoices: [faktura],
    systemName: 'FaktWay (próba techniczna)',
  });
  return { xml, nazwa: 'JPK_V7M_TEST_2026-10.xml', formularz: JPK_V7M_FORM_CODE };
}

const DANE = { nip: NIP, imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01', kwotaGr: 10_000_000 };

async function main() {
  const args = process.argv.slice(2);
  const sucho = args.includes('--sucho');
  const katalogUpo = args.find((a) => !a.startsWith('--'));

  const jpk = plik();
  const xsd = await validateJpkV7m(jpk.xml);
  if (!xsd.valid) throw new Error(`Plik nie przechodzi XSD: ${xsd.errors.join('; ')}`);
  console.log(`Plik ${jpk.nazwa}: ${Buffer.byteLength(jpk.xml)} B, XSD JPK_V7M(3) zgodny`);

  if (sucho) {
    const paczka = await przygotujPaczke(jpk, DANE, certyfikatMf(SRODOWISKO).publicKey);
    console.log(`Część ${paczka.nazwaCzesci}: ${paczka.czesc.length} B, SHA-256 pliku ${paczka.skrotPliku}\n`);
    console.log(`${jpk.xml}\n`);
    console.log(paczka.metadane);
    return;
  }

  console.log(`Wysyłka na ${SRODOWISKO}...`);
  const wynik = await wyslijJpk(SRODOWISKO, jpk, DANE);
  console.log(`Numer referencyjny: ${wynik.numerReferencyjny}${wynik.duplikat ? ' (duplikat, numer oryginału)' : ''}`);

  for (let i = 1; i <= ILE_RAZY; i++) {
    await new Promise((r) => setTimeout(r, CO_ILE_MS));
    const s = await statusWysylki(SRODOWISKO, wynik.numerReferencyjny);
    const ocena = ocenStatus(s.kod);
    console.log(`[${i}] ${s.kod} ${s.opis}${s.szczegoly ? ` | ${s.szczegoly}` : ''} → ${ocena.stan}`);
    if (ocena.stan === 'w_toku') continue;
    if (s.upo) {
      console.log(`UPO: ${s.upo.length} znaków`);
      if (katalogUpo) {
        mkdirSync(katalogUpo, { recursive: true });
        const sciezka = join(katalogUpo, `UPO_${wynik.numerReferencyjny}.xml`);
        writeFileSync(sciezka, s.upo, 'utf8');
        console.log(`UPO zapisane: ${sciezka}`);
      }
    }
    return;
  }
  console.log('Status nadal w toku; numer referencyjny wyżej, odpytanie można powtórzyć później.');
}

main().catch((e: unknown) => {
  if (e instanceof BladMf) {
    console.error(`Błąd MF: etap ${e.etap}, HTTP ${e.http}, kod ${e.kod ?? 'brak'}, RequestId ${e.requestId ?? 'brak'}`);
    console.error(e.message);
    if (e.etap === 'init') console.error(`Dla klienta: ${ocenOdmoweInit(e.kod).tresc}`);
  } else {
    console.error(e);
  }
  process.exit(1);
});
