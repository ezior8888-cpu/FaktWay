/**
 * „PDF” i „Udostępnij” przy fakturze (M10a): na prawdziwym koncie plik PDF
 * z serwera w arkuszu udostępniania, na danych przykładowych opis faktury jak
 * dotąd. Błąd (brak sieci, PDF niedostępny w tym stanie) pokazuje pasek nad
 * zakładkami z „Ponów”, a drugie dotknięcie w trakcie pobierania nic nie robi.
 */
import { useRef } from 'react';

import type { Faktura } from '@/dane-przykladowe';
import { udostepnijPdfFaktury } from '@/lib/pdf-faktury';
import { useKontoFirmy } from '@/stan/dane';
import { udostepnijFakture, useStanFaktur } from '@/stan/faktury';

export function useUdostepnijPdf(): (f: Faktura) => void {
  const k = useKontoFirmy();
  const { pokazCofnij } = useStanFaktur();
  const trwa = useRef(false);
  const udostepnij = (f: Faktura): void => {
    if (!k) return udostepnijFakture(f);
    if (trwa.current) return;
    trwa.current = true;
    void udostepnijPdfFaktury(k.zapytaj, f.id)
      .then((w) => {
        if (!w.ok) pokazCofnij({ tekst: w.komunikat, przycisk: 'Ponów', akcja: () => udostepnij(f) });
      })
      .finally(() => {
        trwa.current = false;
      });
  };
  return udostepnij;
}
