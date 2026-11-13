/**
 * Magazyn danych z poprzedniego otwarcia w plikach aplikacji (`expo-file-system`).
 * Katalog podręczny (`Paths.cache`): bez kopii w iCloud, a gdy brakuje miejsca,
 * system może go wyczyścić; wtedy aplikacja pobierze dane od nowa. Na iOS
 * pliki aplikacji są szyfrowane razem z telefonem (Data Protection).
 */
import { Directory, File, Paths } from 'expo-file-system';

import { utworzPamiec, type Magazyn } from '@/lib/dane/pamiec';

const KATALOG = 'faktway-dane';

function katalog(): Directory {
  return new Directory(Paths.cache, KATALOG);
}

const magazynPlikow: Magazyn = {
  async czytaj(nazwa) {
    const plik = new File(katalog(), nazwa);
    return plik.exists ? plik.text() : null;
  },
  async zapisz(nazwa, tekst) {
    const k = katalog();
    if (!k.exists) k.create({ intermediates: true, idempotent: true });
    const plik = new File(k, nazwa);
    if (!plik.exists) plik.create();
    await plik.write(tekst);
  },
  async usunWszystko() {
    const k = katalog();
    if (k.exists) k.delete();
  },
};

export const pamiec = utworzPamiec(magazynPlikow);
