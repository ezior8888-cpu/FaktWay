/**
 * Klient bramki JPK MF (specyfikacja interfejsów usług JPK 5.6.0, rozdział 2):
 * `InitUploadSigned` → Put Blob do magazynu Azure → `FinishUpload` →
 * `Status/{referenceNumber}`.
 *
 * Adres magazynu przychodzi w odpowiedzi MF; zanim cokolwiek tam pójdzie,
 * musi pasować do domen z 5.6.0 (`taxdocumentstorageNN[tst].blob.core.windows.net`).
 * Metadane (z zaszyfrowanymi danymi autoryzującymi) nie trafiają do błędów
 * ani do logów.
 */

import { z } from 'zod';

import type { SrodowiskoMf } from './certyfikaty';
import { numerOryginalu } from './statusy';

export const ADRESY_MF: Readonly<Record<SrodowiskoMf, { api: string; magazyn: RegExp }>> = {
  test: {
    api: 'https://test-e-dokumenty.mf.gov.pl',
    magazyn: /^https:\/\/taxdocumentstorage\d{2}tst\.blob\.core\.windows\.net\//,
  },
  produkcja: {
    api: 'https://e-dokumenty.mf.gov.pl',
    magazyn: /^https:\/\/taxdocumentstorage\d{2}\.blob\.core\.windows\.net\//,
  },
};

const CZAS_ODPOWIEDZI_MS = 60_000;
/** Numer referencyjny idzie do ścieżki adresu: tylko litery i cyfry (w 5.6.0 32 znaki szesnastkowe). */
const NUMER_REFERENCYJNY = /^[0-9a-z]{16,64}$/i;

export type Pobierz = (url: string, init: RequestInit) => Promise<Response>;

export type EtapMf = 'init' | 'blob' | 'finish' | 'status';

export class BladMf extends Error {
  constructor(
    readonly etap: EtapMf,
    /** Kod HTTP; 0, gdy odpowiedzi nie było. */
    readonly http: number,
    /** Kod MF z treści odpowiedzi (np. 120, 158, 170). */
    readonly kod: number | null,
    komunikat: string,
    readonly requestId: string | null = null,
    /** Numer referencyjny oryginału przy duplikacie (kod 170). */
    readonly oryginal: string | null = null,
  ) {
    super(komunikat);
    this.name = 'BladMf';
  }
}

const zadanieSchema = z.object({
  BlobName: z.string().min(1),
  FileName: z.string(),
  Url: z.string(),
  Method: z.string(),
  HeaderList: z.array(z.object({ Key: z.string(), Value: z.string() })),
});

export type ZadanieWyslaniaPliku = z.infer<typeof zadanieSchema>;

const sesjaSchema = z.object({
  ReferenceNumber: z.string(),
  TimeoutInSec: z.coerce.number(),
  RequestToUploadFileList: z.array(zadanieSchema).min(1),
});

const statusSchema = z.object({
  Code: z.coerce.number().int(),
  Description: z.string(),
  Details: z.string().nullish(),
  Upo: z.string().nullish(),
  Timestamp: z.string().nullish(),
});

const bladSchema = z.object({
  Message: z.string().optional(),
  Code: z.union([z.string(), z.number()]).optional(),
  Errors: z.union([z.array(z.string()), z.string()]).optional(),
  RequestId: z.string().optional(),
});

export interface SesjaMf {
  numerReferencyjny: string;
  czasSek: number;
  pliki: ZadanieWyslaniaPliku[];
}

export interface StatusMf {
  kod: number;
  opis: string;
  szczegoly: string | null;
  /** UPO jako XML (tylko przy 200). */
  upo: string | null;
  czas: string | null;
}

function numerReferencyjny(etap: EtapMf, surowy: string): string {
  // Przykłady w 5.6.0 mają spację na początku numeru.
  const numer = surowy.trim();
  if (!NUMER_REFERENCYJNY.test(numer)) throw new BladMf(etap, 200, null, 'MF: numer referencyjny w nieoczekiwanym formacie');
  return numer;
}

async function zapytaj(etap: EtapMf, pobierz: Pobierz, url: string, init: RequestInit): Promise<Response> {
  try {
    return await pobierz(url, { ...init, signal: AbortSignal.timeout(CZAS_ODPOWIEDZI_MS) });
  } catch (e) {
    throw new BladMf(etap, 0, null, `MF (${etap}): brak odpowiedzi: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Odpowiedź 4xx/5xx jako `BladMf` z kodem i komunikatem MF (JSON) albo Azure (XML). */
async function blad(etap: EtapMf, odp: Response): Promise<BladMf> {
  const tekst = await odp.text().catch(() => '');
  let json: unknown = null;
  try {
    json = JSON.parse(tekst);
  } catch {
    // Azure odpowiada XML-em z <Code>; wtedy w komunikacie jego początek.
  }
  const b = bladSchema.safeParse(json);
  if (b.success) {
    const kod = b.data.Code === undefined ? null : Number(b.data.Code);
    const bledy = Array.isArray(b.data.Errors) ? b.data.Errors.join('; ') : (b.data.Errors ?? '');
    const komunikat = [b.data.Message, bledy].filter(Boolean).join(': ');
    return new BladMf(
      etap,
      odp.status,
      Number.isFinite(kod) ? kod : null,
      `MF (${etap}, HTTP ${odp.status}${kod !== null ? `, kod ${kod}` : ''}): ${komunikat || 'bez opisu'}`,
      b.data.RequestId ?? null,
      kod === 170 && b.data.Message ? numerOryginalu(b.data.Message) : null,
    );
  }
  return new BladMf(etap, odp.status, null, `MF (${etap}, HTTP ${odp.status}): ${tekst.slice(0, 300) || 'bez opisu'}`);
}

export async function initUploadSigned(srodowisko: SrodowiskoMf, metadane: string, pobierz: Pobierz = fetch): Promise<SesjaMf> {
  const odp = await zapytaj('init', pobierz, `${ADRESY_MF[srodowisko].api}/api/Storage/InitUploadSigned`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml', Accept: 'application/json' },
    body: metadane,
  });
  if (!odp.ok) throw await blad('init', odp);
  const sesja = sesjaSchema.safeParse(await odp.json().catch(() => null));
  if (!sesja.success) throw new BladMf('init', odp.status, null, 'MF (init): odpowiedź w nieoczekiwanym kształcie');
  return {
    numerReferencyjny: numerReferencyjny('init', sesja.data.ReferenceNumber),
    czasSek: sesja.data.TimeoutInSec,
    pliki: sesja.data.RequestToUploadFileList,
  };
}

export async function wyslijCzesc(
  srodowisko: SrodowiskoMf,
  zadanie: ZadanieWyslaniaPliku,
  dane: Buffer,
  pobierz: Pobierz = fetch,
): Promise<void> {
  if (!ADRESY_MF[srodowisko].magazyn.test(zadanie.Url)) {
    throw new BladMf('blob', 0, null, 'MF (blob): adres magazynu spoza domen MF, plik nie został wysłany');
  }
  if (zadanie.Method.toUpperCase() !== 'PUT') throw new BladMf('blob', 0, null, `MF (blob): nieoczekiwana metoda ${zadanie.Method}`);
  const headers = Object.fromEntries(zadanie.HeaderList.map((h) => [h.Key, h.Value]));
  const odp = await zapytaj('blob', pobierz, zadanie.Url, { method: 'PUT', headers, body: new Uint8Array(dane) });
  // Put Blob: 201 Created z pustą treścią.
  if (odp.status !== 201) throw await blad('blob', odp);
}

export async function finishUpload(
  srodowisko: SrodowiskoMf,
  numer: string,
  bloby: readonly string[],
  pobierz: Pobierz = fetch,
): Promise<void> {
  const odp = await zapytaj('finish', pobierz, `${ADRESY_MF[srodowisko].api}/api/Storage/FinishUpload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ReferenceNumber: numer, AzureBlobNameList: bloby }),
  });
  if (!odp.ok) throw await blad('finish', odp);
}

export async function statusWysylki(srodowisko: SrodowiskoMf, numer: string, pobierz: Pobierz = fetch): Promise<StatusMf> {
  const odp = await zapytaj('status', pobierz, `${ADRESY_MF[srodowisko].api}/api/Storage/Status/${numerReferencyjny('status', numer)}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!odp.ok) throw await blad('status', odp);
  const s = statusSchema.safeParse(await odp.json().catch(() => null));
  if (!s.success) throw new BladMf('status', odp.status, null, 'MF (status): odpowiedź w nieoczekiwanym kształcie');
  return {
    kod: s.data.Code,
    opis: s.data.Description,
    szczegoly: s.data.Details ?? null,
    upo: s.data.Upo ?? null,
    czas: s.data.Timestamp ?? null,
  };
}
