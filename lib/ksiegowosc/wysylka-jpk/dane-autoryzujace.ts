/**
 * Dane autoryzujące wysyłki JPK (D9): dokument według schematu MF
 * SIG-2008_v2-0 (`podp:DaneAutoryzujace`, przestrzeń
 * `http://e-deklaracje.mf.gov.pl/Repozytorium/Definicje/Podpis/`, odczyt
 * 7.11.2026 z podatki-arch.mf.gov.pl). Kolejność elementów: NIP albo PESEL,
 * ImiePierwsze, Nazwisko, DataUrodzenia, Kwota.
 *
 * Klient wpisuje je przy każdej wysyłce. Nie zapisujemy ich ani nie logujemy:
 * istnieją tylko w pamięci wysyłki, a do MF idą zaszyfrowane kluczem AES
 * paczki (`AuthData` w metadanych).
 */

import { create } from 'xmlbuilder2';
import { z } from 'zod';

export const PODPIS_NAMESPACE = 'http://e-deklaracje.mf.gov.pl/Repozytorium/Definicje/Podpis/';

/** Najwyższa kwota z `totalDigits 16` i dwoma miejscami po przecinku, w groszach. */
const KWOTA_MAX_GR = 10 ** 16 - 1;

function poprawnaData(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '1900-01-01';
}

export const daneAutoryzujaceSchema = z.object({
  /** NIP firmy; formularz go nie pyta, bierze go z firmy. */
  nip: z.string().regex(/^[1-9]((\d[1-9])|([1-9]\d))\d{7}$/, 'NIP ma 10 cyfr.'),
  imie: z.string().trim().min(1, 'Brak imienia.').max(30, 'Imię ma w danych autoryzujących najwyżej 30 znaków.'),
  nazwisko: z.string().trim().min(1, 'Brak nazwiska.').max(81, 'Nazwisko ma w danych autoryzujących najwyżej 81 znaków.'),
  dataUrodzenia: z.string().refine(poprawnaData, 'Data urodzenia w formacie RRRR-MM-DD, nie wcześniejsza niż 1900 r.'),
  /** Przychód z zeznania za rok o dwa lata wcześniejszy niż rok wysyłki, w groszach. */
  kwotaGr: z.number().int('Kwota w groszach.').min(0, 'Kwota nie może być ujemna.').max(KWOTA_MAX_GR, 'Kwota jest za duża.'),
});

export type DaneAutoryzujace = z.infer<typeof daneAutoryzujaceSchema>;

/** Kwota SIG-2008: grosze jako „1234.56”. */
function kwota(gr: number): string {
  return `${Math.floor(gr / 100)}.${String(gr % 100).padStart(2, '0')}`;
}

/** Spacje jak w `xsd:whiteSpace collapse`: MF porówna imię i nazwisko bez nadmiarowych odstępów. */
function znaki(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function xmlDanychAutoryzujacych(dane: DaneAutoryzujace): string {
  const wynik = daneAutoryzujaceSchema.safeParse(dane);
  // Błąd bez wartości pól: komunikat może trafić do logów.
  if (!wynik.success) throw new Error(`Dane autoryzujące: niepoprawne pola ${wynik.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const d = wynik.data;
  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele(PODPIS_NAMESPACE, 'podp:DaneAutoryzujace');
  root.ele(PODPIS_NAMESPACE, 'podp:NIP').txt(d.nip).up();
  root.ele(PODPIS_NAMESPACE, 'podp:ImiePierwsze').txt(znaki(d.imie)).up();
  root.ele(PODPIS_NAMESPACE, 'podp:Nazwisko').txt(znaki(d.nazwisko)).up();
  root.ele(PODPIS_NAMESPACE, 'podp:DataUrodzenia').txt(d.dataUrodzenia).up();
  root.ele(PODPIS_NAMESPACE, 'podp:Kwota').txt(kwota(d.kwotaGr)).up();
  return root.end({ prettyPrint: false });
}
