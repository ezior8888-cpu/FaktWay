/**
 * Pod kluczem pliku XML leży już inny plik niż ten, który właśnie wygenerowaliśmy
 * (C-12). Plików faktur nie nadpisujemy: decyzja D5 obiecuje „zero ryzyka
 * nadpisania pliku, który poszedł do KSeF”. Ponowienie tej samej próby dałoby
 * ten sam wynik, a nowe kolejkowanie dostaje nowy `sendAttemptId`, więc i nowy klucz.
 *
 * Osobny moduł, bo runner rozpoznaje ten błąd po klasie, a wiele testów
 * podmienia `@/lib/storage/r2` w całości.
 */
export class XmlArchiveConflictError extends Error {
  constructor(readonly storagePath: string) {
    super('Archiwum XML: pod tym kluczem jest inny plik, niczego nie nadpisujemy');
    this.name = 'XmlArchiveConflictError';
  }
}
