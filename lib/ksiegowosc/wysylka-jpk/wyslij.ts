/**
 * Wysyłka jednego pliku JPK do MF z danymi autoryzującymi (plan księgowości
 * JDG, K6, sekcja 10): ZIP, AES-256, klucz RSA, metadane z `AuthData`,
 * `InitUploadSigned`, Put Blob, `FinishUpload`. UPO przychodzi później
 * (`statusWysylki`), więc wynik to numer referencyjny.
 *
 * Całość idzie w jednym żądaniu klienta: dane autoryzujące nie mogą czekać
 * w kolejce zadań, bo kolejka je zapisuje. Ponowienie to nowa sesja MF.
 * Bajtowo ten sam plik (ten sam SHA-256) MF rozpoznaje jako duplikat (kod 170)
 * i podaje numer oryginału, który zwracamy zamiast błędu; plik wygenerowany
 * od nowa ma inny czas wytworzenia, więc tę ochronę daje dopiero blokada
 * w `jpk_submissions` (jedna wysyłka w toku) i korekta po przyjętej deklaracji.
 */

import type { KeyObject } from 'node:crypto';

import { packageZip } from '@/lib/exports/zip-packager';

import { certyfikatMf, type SrodowiskoMf } from './certyfikaty';
import { xmlDanychAutoryzujacych, type DaneAutoryzujace } from './dane-autoryzujace';
import { BladMf, finishUpload, initUploadSigned, wyslijCzesc, type Pobierz } from './klient';
import { metadaneInitUpload, type KodFormularza } from './metadane';
import { nowyKluczSesji, skrotBase64, zaszyfrujAes, zaszyfrujKlucz } from './szyfrowanie';

/** Największa część paczki (5.6.0, s. 25). Plik JDG mieści się w jednej części z dużym zapasem. */
export const MAX_CZESC_B = 62_914_560;

export interface PlikJpk {
  xml: string;
  /** Nazwa pliku `[a-zA-Z0-9_.-]{5,47}` (część dostaje dopisek `.zip.aes`). */
  nazwa: string;
  formularz: KodFormularza;
}

export interface WynikWysylki {
  numerReferencyjny: string;
  /** SHA-256 pliku XML w Base64, jak w metadanych. */
  skrotPliku: string;
  /** MF miał już ten plik (kod 170): numer to numer oryginału. */
  duplikat: boolean;
}

export interface ZaleznosciWysylki {
  pobierz?: Pobierz;
  /** Tylko w testach: klucz publiczny atrapy MF zamiast certyfikatu MF. */
  kluczMf?: KeyObject;
  teraz?: Date;
}

/** Paczka jednej wysyłki: metadane z `AuthData` i zaszyfrowana część. Tylko w pamięci. */
export interface PaczkaMf {
  metadane: string;
  czesc: Buffer;
  nazwaCzesci: string;
  skrotPliku: string;
}

export async function przygotujPaczke(plik: PlikJpk, dane: DaneAutoryzujace, kluczMf: KeyObject): Promise<PaczkaMf> {
  const bajty = Buffer.from(plik.xml, 'utf8');
  const skrotPliku = skrotBase64('sha256', bajty);

  const zip = await packageZip([{ filename: plik.nazwa, content: bajty }]);
  if (zip.length > MAX_CZESC_B) throw new Error(`JPK: archiwum ma ${zip.length} B, a jedna część najwyżej ${MAX_CZESC_B} B`);
  const klucz = nowyKluczSesji();
  const czesc = zaszyfrujAes(zip, klucz);
  const nazwaCzesci = `${plik.nazwa}.zip.aes`;

  const metadane = metadaneInitUpload({
    formularz: plik.formularz,
    nazwaPliku: plik.nazwa,
    dlugoscPliku: bajty.length,
    skrotPliku,
    kluczRsa: zaszyfrujKlucz(klucz.klucz, kluczMf),
    iv: klucz.iv.toString('base64'),
    czesc: { nazwa: nazwaCzesci, dlugosc: czesc.length, md5: skrotBase64('md5', czesc) },
    authData: zaszyfrujAes(Buffer.from(xmlDanychAutoryzujacych(dane), 'utf8'), klucz).toString('base64'),
  });
  return { metadane, czesc, nazwaCzesci, skrotPliku };
}

export async function wyslijJpk(
  srodowisko: SrodowiskoMf,
  plik: PlikJpk,
  dane: DaneAutoryzujace,
  zaleznosci: ZaleznosciWysylki = {},
): Promise<WynikWysylki> {
  const pobierz = zaleznosci.pobierz ?? fetch;
  const kluczMf = zaleznosci.kluczMf ?? certyfikatMf(srodowisko, zaleznosci.teraz).publicKey;
  const { metadane, czesc, nazwaCzesci, skrotPliku } = await przygotujPaczke(plik, dane, kluczMf);

  let sesja;
  try {
    sesja = await initUploadSigned(srodowisko, metadane, pobierz);
  } catch (e) {
    if (e instanceof BladMf && e.kod === 170 && e.oryginal) return { numerReferencyjny: e.oryginal, skrotPliku, duplikat: true };
    throw e;
  }

  const zadanie = sesja.pliki.length === 1 ? sesja.pliki[0] : sesja.pliki.find((p) => p.FileName === nazwaCzesci);
  if (!zadanie) throw new BladMf('init', 200, null, `MF (init): ${sesja.pliki.length} adresów do wysłania jednej części`);
  await wyslijCzesc(srodowisko, zadanie, czesc, pobierz);
  await finishUpload(srodowisko, sesja.numerReferencyjny, [zadanie.BlobName], pobierz);
  return { numerReferencyjny: sesja.numerReferencyjny, skrotPliku, duplikat: false };
}
