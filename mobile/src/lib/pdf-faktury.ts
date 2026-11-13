/**
 * PDF z serwera w systemowym arkuszu udostępniania (M10a): faktura
 * (`GET /api/mobile/v1/faktury/{id}/pdf`, ten sam plik co na stronie) albo
 * załącznik podglądu przypomnienia. Arkusz iOS pokazuje miniaturę pierwszej
 * strony i daje Pocztę, komunikatory, Pliki i Drukuj.
 *
 * Plik leży w `Paths.cache/faktway-dane/pdf/`, więc wylogowanie czyści go
 * razem z danymi z poprzedniego otwarcia (`lib/dane/pamiec-plikow.ts`).
 */
import { Directory, File, Paths } from 'expo-file-system';
import { Share } from 'react-native';

import type { PdfFakturyOdpowiedz } from '@/lib/api/kontrakt';
import { nazwaPlikuPdf } from '@/lib/naleznosci';
import type { KontoFirmy } from '@/stan/dane';

function katalog(): Directory {
  return new Directory(Paths.cache, 'faktway-dane', 'pdf');
}

/** Zapisuje PDF z Base64 i otwiera arkusz udostępniania. */
export async function udostepnijPdf(nazwa: string, pdfBase64: string): Promise<void> {
  const k = katalog();
  if (!k.exists) k.create({ intermediates: true, idempotent: true });
  const plik = new File(k, nazwaPlikuPdf(nazwa));
  if (plik.exists) plik.delete();
  plik.create();
  plik.write(pdfBase64, { encoding: 'base64' });
  await Share.share({ url: plik.uri, title: plik.name });
}

export type WynikPdf = { ok: true } | { ok: false; komunikat: string };

/** PDF faktury z serwera w arkuszu udostępniania. */
export async function udostepnijPdfFaktury(zapytaj: KontoFirmy['zapytaj'], id: string): Promise<WynikPdf> {
  const w = await zapytaj<PdfFakturyOdpowiedz>(`faktury/${encodeURIComponent(id)}/pdf`);
  if (!w.ok) return { ok: false, komunikat: w.blad.komunikat };
  try {
    await udostepnijPdf(w.dane.nazwa, w.dane.pdfBase64);
    return { ok: true };
  } catch {
    return { ok: false, komunikat: 'Nie udało się zapisać PDF na telefonie. Zwolnij trochę miejsca i spróbuj ponownie.' };
  }
}
