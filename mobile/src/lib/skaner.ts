/**
 * Systemowy skaner dokumentów (etap M9): na iOS VisionKit przez moduł lokalny
 * `modules/skaner-dokumentow/ios/SkanerDokumentowModule.swift`. Android i symulator bez aparatu:
 * `skanerDostepny()` daje `false`, a ekran proponuje zdjęcie z galerii.
 * Android dostanie skaner ML Kit w M12.
 */
import { requireOptionalNativeModule } from 'expo';

/** Zapisany skan: plik w katalogu tymczasowym aplikacji. */
export type Skan = {
  uri: string;
  typ: 'image/jpeg' | 'application/pdf';
  /** Ile stron trafiło do pliku (najwyżej 10). */
  strony: number;
  /** Ile stron zeskanował klient (więcej niż `strony`, gdy przekroczył limit). */
  wszystkichStron: number;
  bajty: number;
};

type Modul = {
  dostepny(): boolean;
  skanuj(): Promise<Skan | null>;
};

const modul = requireOptionalNativeModule<Modul>('SkanerDokumentow');

/** Czy to urządzenie ma systemowy skaner (iPhone z aparatem; nie symulator i nie Android). */
export function skanerDostepny(): boolean {
  try {
    return modul?.dostepny() ?? false;
  } catch {
    return false;
  }
}

/** Otwiera skaner; `null`, gdy klient zamknął go bez skanu. Odrzuca z komunikatem po polsku. */
export async function skanujDokument(): Promise<Skan | null> {
  if (!modul) throw new Error('Skaner dokumentów nie działa na tym urządzeniu.');
  return modul.skanuj();
}
