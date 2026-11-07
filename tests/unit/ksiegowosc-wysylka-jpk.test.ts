import { constants, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JpkInvoice } from '@/lib/exports/jpk-fa-generator';
import { generateJpkV7m, JPK_V7M_FORM_CODE } from '@/lib/exports/jpk-v7m-generator';
import { validateJpkV7m } from '@/lib/exports/jpk-v7m-validator';
import { BrakCertyfikatuMf, certyfikatMf } from '@/lib/ksiegowosc/wysylka-jpk/certyfikaty';
import { xmlDanychAutoryzujacych, type DaneAutoryzujace } from '@/lib/ksiegowosc/wysylka-jpk/dane-autoryzujace';
import { BladMf, statusWysylki, type Pobierz } from '@/lib/ksiegowosc/wysylka-jpk/klient';
import { numerOryginalu, ocenOdmoweInit, ocenStatus } from '@/lib/ksiegowosc/wysylka-jpk/statusy';
import { wyslijJpk } from '@/lib/ksiegowosc/wysylka-jpk/wyslij';

/**
 * Wysyłka JPK do MF na atrapie bramki (plan księgowości JDG, K6). Atrapa
 * robi to, co MF: odszyfrowuje klucz AES kluczem prywatnym, sprawdza MD5
 * części, rozpakowuje ZIP, porównuje SHA-256 pliku i odszyfrowuje dane
 * autoryzujące. Statusy według specyfikacji interfejsów usług JPK 5.6.0.
 */

const NIP = '1234567890'; // fikcyjny NIP testowy z AGENTS.md
const DANE: DaneAutoryzujace = { nip: NIP, imie: 'Jan', nazwisko: 'Testowy', dataUrodzenia: '1980-01-01', kwotaGr: 5_432_198 };
const REF = 'd4fd41850323d2f6000000b013016327';

function plikJpk() {
  const faktura = {
    invoiceNumber: 'FS/1/10',
    currency: 'PLN',
    invoiceType: 'regular',
    issueDate: '2026-10-05',
    buyerName: 'Klient testowy',
    netTotal: 1000,
    vatTotal: 230,
    grossTotal: 1230,
    lines: [{ position: 1, name: 'Usługa', unit: 'szt.', quantity: 1, unitPriceNet: 1000, netAmount: 1000, vatRate: '23' }],
  } as JpkInvoice;
  const xml = generateJpkV7m({
    issuer: {
      nip: NIP,
      name: 'Jan Testowy',
      email: 'jan@example.test',
      taxOfficeCode: '1433',
      naturalPerson: { firstName: 'Jan', lastName: 'Testowy', birthDate: '1980-01-01' },
    },
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    issuedInvoices: [faktura],
    generatedAt: new Date('2026-11-07T10:00:00Z'),
  });
  return { xml, nazwa: 'JPK_V7M_2026-10.xml', formularz: JPK_V7M_FORM_CODE };
}

/** Jedyny wpis archiwum ZIP (katalog centralny), rozpakowany jak u MF. */
function rozpakuj(zip: Buffer): { nazwa: string; metoda: number; dane: Buffer } {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(zip.readUInt16LE(eocd + 10)).toBe(1);
  const cd = zip.readUInt32LE(eocd + 16);
  const metoda = zip.readUInt16LE(cd + 10);
  const rozmiar = zip.readUInt32LE(cd + 20);
  const nazwa = zip.subarray(cd + 46, cd + 46 + zip.readUInt16LE(cd + 28)).toString('utf8');
  const lh = zip.readUInt32LE(cd + 42);
  const start = lh + 30 + zip.readUInt16LE(lh + 26) + zip.readUInt16LE(lh + 28);
  return { nazwa, metoda, dane: inflateRawSync(zip.subarray(start, start + rozmiar)) };
}

function pole(xml: string, wzor: RegExp): string {
  const m = wzor.exec(xml);
  if (!m) throw new Error(`brak w metadanych: ${wzor}`);
  return m[1];
}

/** Atrapa bramki MF i magazynu Azure. */
function atrapaMf(opcje: { init?: Response; urlMagazynu?: string; statusy?: object[] } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const zadania: { url: string; metoda: string; naglowki: Record<string, string>; tresc: Buffer }[] = [];
  const statusy = [...(opcje.statusy ?? [])];
  let metadane = '';

  const odszyfrujKlucz = (b64: string): Buffer => {
    // PKCS#1 v1.5 ręcznie (00 02 PS 00 klucz): Node 22 w CI nie odszyfrowuje tego dopełnienia.
    const surowy = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(b64, 'base64'));
    expect([surowy[0], surowy[1]]).toEqual([0, 2]);
    return surowy.subarray(surowy.indexOf(0, 2) + 1);
  };

  const pobierz: Pobierz = async (url, init) => {
    const tresc = init.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.from(String(init.body ?? ''), 'utf8');
    zadania.push({ url, metoda: String(init.method), naglowki: (init.headers ?? {}) as Record<string, string>, tresc });
    if (url.endsWith('/api/Storage/InitUploadSigned')) {
      if (opcje.init) return opcje.init;
      metadane = tresc.toString('utf8');
      const md5 = pole(metadane, /<HashValue algorithm="MD5" encoding="Base64">([^<]+)</);
      return Response.json({
        ReferenceNumber: ` ${REF}`,
        TimeoutInSec: 900,
        RequestToUploadFileList: [
          {
            BlobName: '8377ed3d-1b05-4c76-b718-6fddd46fd298',
            FileName: 'JPK_V7M_2026-10.xml.zip.aes',
            Url: opcje.urlMagazynu ?? `https://taxdocumentstorage09tst.blob.core.windows.net/${REF}/8377ed3d?sv=2015-07-08&sr=b&sig=x`,
            Method: 'PUT',
            HeaderList: [
              { Key: 'Content-MD5', Value: md5 },
              { Key: 'x-ms-blob-type', Value: 'BlockBlob' },
            ],
          },
        ],
      });
    }
    // Magazyn MF po nazwie hosta, nie po fragmencie adresu (CodeQL js/incomplete-url-substring-sanitization).
    if (/^taxdocumentstorage\d{2}(tst)?\.blob\.core\.windows\.net$/.test(new URL(url).hostname)) {
      const md5 = createHash('md5').update(tresc).digest('base64');
      return md5 === (init.headers as Record<string, string>)['Content-MD5'] ? new Response(null, { status: 201 }) : new Response('<Error/>', { status: 400 });
    }
    if (url.endsWith('/api/Storage/FinishUpload')) return new Response(null, { status: 200 });
    if (url.includes('/api/Storage/Status/')) return Response.json(statusy.shift() ?? { Code: 120, Description: 'Trwa weryfikacja' });
    return new Response('nieznany adres', { status: 404 });
  };

  /** To, co MF odczytuje z paczki. */
  const odczytaj = () => {
    const klucz = odszyfrujKlucz(pole(metadane, /<EncryptionKey[^>]*>([^<]+)</));
    const iv = Buffer.from(pole(metadane, /<IV bytes="16" encoding="Base64">([^<]+)</), 'base64');
    const aes = (b: Buffer) => {
      const d = createDecipheriv('aes-256-cbc', klucz, iv);
      return Buffer.concat([d.update(b), d.final()]);
    };
    const czesc = zadania.find((z) => z.metoda === 'PUT')!.tresc;
    return {
      klucz,
      czesc,
      zip: rozpakuj(aes(czesc)),
      authData: aes(Buffer.from(pole(metadane, /<AuthData>([^<]+)</), 'base64')).toString('utf8'),
    };
  };

  return { pobierz, zadania, kluczMf: publicKey, odczytaj, metadane: () => metadane };
}

afterEach(() => vi.restoreAllMocks());

describe('wysyłka JPK do MF (atrapa bramki)', () => {
  it('paczka: klucz RSA, AES-256-CBC, ZIP z jednym plikiem, skróty i długości z metadanych, dane autoryzujące', async () => {
    const mf = atrapaMf();
    const plik = plikJpk();
    const wynik = await wyslijJpk('test', plik, DANE, { pobierz: mf.pobierz, kluczMf: mf.kluczMf });

    // Spacja z przykładu MF obcięta; kolejność wywołań jak w 5.6.0.
    expect(wynik).toEqual({ numerReferencyjny: REF, skrotPliku: createHash('sha256').update(plik.xml).digest('base64'), duplikat: false });
    expect(mf.zadania.map((z) => `${z.metoda} ${new URL(z.url).hostname}${new URL(z.url).pathname.replace(REF, 'REF')}`)).toEqual([
      'POST test-e-dokumenty.mf.gov.pl/api/Storage/InitUploadSigned',
      'PUT taxdocumentstorage09tst.blob.core.windows.net/REF/8377ed3d',
      'POST test-e-dokumenty.mf.gov.pl/api/Storage/FinishUpload',
    ]);
    expect(JSON.parse(mf.zadania[2].tresc.toString('utf8'))).toEqual({
      ReferenceNumber: REF,
      AzureBlobNameList: ['8377ed3d-1b05-4c76-b718-6fddd46fd298'],
    });

    const m = mf.metadane();
    expect(m.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(m).toContain('<InitUpload xmlns="http://e-dokumenty.mf.gov.pl">');
    expect(m).toContain('<FormCode systemCode="JPK_V7M (3)" schemaVersion="1-0E">JPK_VAT</FormCode>');
    expect(m).toContain('<SplitZip type="split" mode="zip"/>');
    expect(m).toContain('<AES size="256" block="16" mode="CBC" padding="PKCS#7">');
    // AuthData ostatni, po liście dokumentów.
    expect(m.indexOf('</DocumentList>')).toBeLessThan(m.indexOf('<AuthData>'));

    const { klucz, czesc, zip, authData } = mf.odczytaj();
    expect(klucz).toHaveLength(32);
    expect(zip).toMatchObject({ nazwa: 'JPK_V7M_2026-10.xml', metoda: 8 });
    expect(zip.dane.toString('utf8')).toBe(plik.xml);
    expect(pole(m, /<Document>[\s\S]*?<ContentLength>(\d+)</)).toBe(String(Buffer.byteLength(plik.xml)));
    expect(pole(m, /<FileSignature>[\s\S]*?<ContentLength>(\d+)</)).toBe(String(czesc.length));
    expect(pole(m, /<HashValue algorithm="MD5" encoding="Base64">([^<]+)</)).toHaveLength(24);
    expect(authData).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><podp:DaneAutoryzujace xmlns:podp="http://e-deklaracje.mf.gov.pl/Repozytorium/Definicje/Podpis/">' +
        '<podp:NIP>1234567890</podp:NIP><podp:ImiePierwsze>Jan</podp:ImiePierwsze><podp:Nazwisko>Testowy</podp:Nazwisko>' +
        '<podp:DataUrodzenia>1980-01-01</podp:DataUrodzenia><podp:Kwota>54321.98</podp:Kwota></podp:DaneAutoryzujace>',
    );
  });

  it('dane autoryzujące nie są jawne w metadanych ani w błędzie, a nic nie idzie do konsoli', async () => {
    const konsola = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const jawne = ['54321.98', '5432198', 'Testowy', '1980-01-01', 'DaneAutoryzujace'];

    const mf = atrapaMf();
    await wyslijJpk('test', plikJpk(), DANE, { pobierz: mf.pobierz, kluczMf: mf.kluczMf });
    for (const s of jawne) expect(mf.metadane()).not.toContain(s);

    // Błąd po stronie MF: komunikat i stos bez danych autoryzujących.
    const zly = atrapaMf({ init: Response.json({ Message: 'Wewnętrzny błąd systemu', RequestId: 'r-1' }, { status: 500 }) });
    const blad = await wyslijJpk('test', plikJpk(), DANE, { pobierz: zly.pobierz, kluczMf: zly.kluczMf }).catch((e: unknown) => e);
    expect(blad).toBeInstanceOf(BladMf);
    const tekst = `${(blad as Error).message}\n${(blad as Error).stack}\n${JSON.stringify(blad)}`;
    for (const s of jawne) expect(tekst).not.toContain(s);
    for (const spy of konsola) expect(spy).not.toHaveBeenCalled();

    // Niepoprawne dane: błąd wymienia pola, nie wartości.
    expect(() => xmlDanychAutoryzujacych({ ...DANE, dataUrodzenia: '1980-02-30', kwotaGr: -1 })).toThrow(/dataUrodzenia, kwotaGr$/);
    expect(() => xmlDanychAutoryzujacych({ ...DANE, dataUrodzenia: '1980-02-30' })).not.toThrow(/1980/);
  });

  it('duplikat przetworzonego pliku (170): numer oryginału zamiast błędu, bez wysyłania części', async () => {
    const mf = atrapaMf({
      init: Response.json(
        { Message: 'Przesłano duplikat przetworzonego dokumentu. Numer referencyjny oryginału: ef7d17780087346e0000004c0c7982ec', Code: '170' },
        { status: 400 },
      ),
    });
    const wynik = await wyslijJpk('test', plikJpk(), DANE, { pobierz: mf.pobierz, kluczMf: mf.kluczMf });
    expect(wynik).toMatchObject({ numerReferencyjny: 'ef7d17780087346e0000004c0c7982ec', duplikat: true });
    expect(mf.zadania.map((z) => z.metoda)).toEqual(['POST']);
  });

  it('adres magazynu spoza domen MF: część nie wychodzi, sesja nie jest kończona', async () => {
    const mf = atrapaMf({ urlMagazynu: 'https://taxdocumentstorage09tst.blob.core.windows.net.example.com/x' });
    await expect(wyslijJpk('test', plikJpk(), DANE, { pobierz: mf.pobierz, kluczMf: mf.kluczMf })).rejects.toThrow(/spoza domen MF/);
    expect(mf.zadania.map((z) => z.metoda)).toEqual(['POST']);
    // Produkcyjny magazyn nie przyjmuje testowego adresu i odwrotnie.
    const prod = atrapaMf({ urlMagazynu: 'https://taxdocumentstorage09.blob.core.windows.net/x' });
    await expect(wyslijJpk('test', plikJpk(), DANE, { pobierz: prod.pobierz, kluczMf: prod.kluczMf })).rejects.toThrow(/spoza domen MF/);
  });

  it('odmowa InitUploadSigned: kod MF w błędzie, 158 to chwilowa odmowa dla klienta, reszta techniczna', async () => {
    const mf = atrapaMf({ init: Response.json({ Message: 'Zbyt dużo wysłanych plików InitUpload', Code: 158, RequestId: 'r-2' }, { status: 400 }) });
    const blad = (await wyslijJpk('test', plikJpk(), DANE, { pobierz: mf.pobierz, kluczMf: mf.kluczMf }).catch((e: unknown) => e)) as BladMf;
    expect(blad).toMatchObject({ etap: 'init', http: 400, kod: 158, requestId: 'r-2' });
    expect(ocenOdmoweInit(blad.kod)).toEqual({ stan: 'odrzucona', techniczny: false, tresc: expect.stringContaining('za kilka minut') });
    expect(ocenOdmoweInit(140).techniczny).toBe(true);
    expect(ocenOdmoweInit(null).techniczny).toBe(true);
  });
});

describe('status wysyłki i UPO', () => {
  it('120 w toku, 200 z UPO, a odmowy z planu (411, 420, 422, 424) z treścią dla klienta', async () => {
    const mf = atrapaMf({
      statusy: [
        { Code: 120, Description: 'Sesja została poprawnie zakończona. Trwa weryfikacja dokumentu' },
        { Code: 200, Description: 'Przetwarzanie dokumentu zakończone poprawnie', Details: REF, Upo: '<Potwierdzenie/>', Timestamp: '2026-11-07T10:05:00+00:00' },
      ],
    });
    const w = await statusWysylki('test', ` ${REF}`, mf.pobierz);
    expect(w).toMatchObject({ kod: 120, upo: null });
    expect(ocenStatus(w.kod).stan).toBe('w_toku');
    const p = await statusWysylki('test', REF, mf.pobierz);
    expect(p).toMatchObject({ kod: 200, upo: '<Potwierdzenie/>', czas: '2026-11-07T10:05:00+00:00' });
    expect(ocenStatus(p.kod)).toMatchObject({ stan: 'przyjeta', techniczny: false });
    expect(mf.zadania[0].url).toBe(`https://test-e-dokumenty.mf.gov.pl/api/Storage/Status/${REF}`);

    const odmowy = Object.fromEntries([411, 420, 422, 424].map((k) => [k, ocenStatus(k)]));
    for (const k of [420, 422, 424]) expect(odmowy[k]).toMatchObject({ stan: 'odrzucona', techniczny: false, tresc: expect.stringMatching(/Plik nie został złożony\.$/) });
    // Duplikat (407, 411): deklaracja jest złożona wcześniejszą wysyłką, więc bez „nie został złożony”.
    for (const k of [407, 411]) expect(ocenStatus(k)).toMatchObject({ stan: 'odrzucona', techniczny: false, tresc: expect.stringContaining('Deklaracja jest złożona tamtą wysyłką') });
    expect(odmowy[420].tresc).toContain('pełnomocnictwa');
    expect(odmowy[422].tresc).toContain('osobą fizyczną');
    expect(odmowy[424].tresc).toContain('podpis kwalifikowany albo zaufany');
    // Błąd paczki (schemat, szyfrowanie, ZIP) i nieznany numer to błąd FaktWay.
    for (const k of [300, 401, 410, 412, 417, 418, 433, 499]) expect(ocenStatus(k)).toMatchObject({ stan: 'odrzucona', techniczny: true });
    expect(ocenStatus(101).stan).toBe('w_toku');
  });

  it('numer referencyjny spoza wzoru nie trafia do adresu, a 407 podaje numer oryginału', async () => {
    const mf = atrapaMf();
    await expect(statusWysylki('test', '../InitUploadSigned', mf.pobierz)).rejects.toThrow(/nieoczekiwanym formacie/);
    expect(mf.zadania).toHaveLength(0);
    expect(numerOryginalu('Przesłałeś duplikat dokumentu. Numer referencyjny oryginału to ba96951d00635700000001726b6ec621')).toBe(
      'ba96951d00635700000001726b6ec621',
    );
  });
});

describe('certyfikat MF i plik osoby fizycznej', () => {
  it('certyfikat testowy MF z kodu, produkcja bez certyfikatu i certyfikat po terminie to odmowa', () => {
    const c = certyfikatMf('test', new Date('2026-11-07T00:00:00Z'));
    expect(c.subject).toContain('jpk@mf.gov.pl');
    expect(c.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(() => certyfikatMf('produkcja')).toThrow(BrakCertyfikatuMf);
    expect(() => certyfikatMf('test', new Date('2027-07-08T00:00:00Z'))).toThrow(/ważny od/);
  });

  it('JPK_V7M(3) z Podmiot1/OsobaFizyczna przechodzi oficjalny XSD', async () => {
    const { xml } = plikJpk();
    expect(xml).toMatch(/<OsobaFizyczna>\s*<etd:NIP>1234567890<\/etd:NIP>\s*<etd:ImiePierwsze>Jan<\/etd:ImiePierwsze>/);
    const wynik = await validateJpkV7m(xml);
    expect(wynik.errors).toEqual([]);
    expect(wynik.valid).toBe(true);
  });
});
