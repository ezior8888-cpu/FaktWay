/**
 * Metadane `InitUpload` dla `InitUploadSigned` (specyfikacja interfejsów
 * usług JPK 5.6.0, rozdział 2.2.1, i przykład MF `initupload-jpk_v7m-3.xml`).
 * Uwierzytelnienie danymi autoryzującymi (1.3.2): element `AuthData` na końcu,
 * bez podpisu XAdES (podpis i dane autoryzujące razem to odmowa, kod 136).
 *
 * Deklaracja XML dokładnie `<?xml version="1.0" encoding="utf-8"?>`: inna
 * daje odmowę z kodem 101.
 */

import { create } from 'xmlbuilder2';

export const INIT_UPLOAD_NAMESPACE = 'http://e-dokumenty.mf.gov.pl';
/** Wersja REST API z 5.6.0 dla plików JPK (01.03.01.20231001 jest tylko dla PSP-IP). */
export const WERSJA_API = '01.02.01.20160617';
/** Nazwa pliku w metadanych: `[a-zA-Z0-9_.-]{5,55}`. */
export const NAZWA_PLIKU = /^[a-zA-Z0-9_.-]{5,55}$/;

/** Kod formularza z nagłówka pliku (`KodFormularza`, atrybuty `kodSystemowy` i `wersjaSchemy`). */
export interface KodFormularza {
  kod: string;
  kodSystemowy: string;
  wersjaSchemy: string;
}

export interface MetadaneWysylki {
  formularz: KodFormularza;
  /** Nazwa pliku XML (też nazwa w archiwum ZIP). */
  nazwaPliku: string;
  /** Długość pliku XML w bajtach. */
  dlugoscPliku: number;
  /** SHA-256 pliku XML w Base64; po nim MF rozpoznaje duplikaty (kod 170). */
  skrotPliku: string;
  /** Klucz AES zaszyfrowany kluczem MF, Base64. */
  kluczRsa: string;
  /** IV AES, Base64. */
  iv: string;
  czesc: {
    nazwa: string;
    dlugosc: number;
    /** MD5 zaszyfrowanej części w Base64 (24 znaki). */
    md5: string;
  };
  /** Dane autoryzujące zaszyfrowane kluczem AES paczki, Base64. */
  authData: string;
}

export function metadaneInitUpload(m: MetadaneWysylki): string {
  for (const nazwa of [m.nazwaPliku, m.czesc.nazwa]) {
    if (!NAZWA_PLIKU.test(nazwa)) throw new Error(`InitUpload: nazwa pliku „${nazwa}” poza wzorem MF`);
  }
  const root = create({ version: '1.0', encoding: 'utf-8' }).ele('InitUpload', { xmlns: INIT_UPLOAD_NAMESPACE });
  root.ele('DocumentType').txt('JPK').up();
  root.ele('Version').txt(WERSJA_API).up();
  root.ele('EncryptionKey', { algorithm: 'RSA', mode: 'ECB', padding: 'PKCS#1', encoding: 'Base64' }).txt(m.kluczRsa).up();

  const dokument = root.ele('DocumentList').ele('Document');
  dokument.ele('FormCode', { systemCode: m.formularz.kodSystemowy, schemaVersion: m.formularz.wersjaSchemy }).txt(m.formularz.kod).up();
  dokument.ele('FileName').txt(m.nazwaPliku).up();
  dokument.ele('ContentLength').txt(String(m.dlugoscPliku)).up();
  dokument.ele('HashValue', { algorithm: 'SHA-256', encoding: 'Base64' }).txt(m.skrotPliku).up();

  const lista = dokument.ele('FileSignatureList', { filesNumber: '1' });
  lista.ele('Packaging').ele('SplitZip', { type: 'split', mode: 'zip' }).up().up();
  lista
    .ele('Encryption')
    .ele('AES', { size: '256', block: '16', mode: 'CBC', padding: 'PKCS#7' })
    .ele('IV', { bytes: '16', encoding: 'Base64' })
    .txt(m.iv)
    .up()
    .up()
    .up();
  const czesc = lista.ele('FileSignature');
  czesc.ele('OrdinalNumber').txt('1').up();
  czesc.ele('FileName').txt(m.czesc.nazwa).up();
  czesc.ele('ContentLength').txt(String(m.czesc.dlugosc)).up();
  czesc.ele('HashValue', { algorithm: 'MD5', encoding: 'Base64' }).txt(m.czesc.md5).up();

  root.ele('AuthData').txt(m.authData).up();
  return root.end({ prettyPrint: true });
}
