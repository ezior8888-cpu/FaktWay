import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { dataPelna } from '@/lib/format';

/**
 * Abonament: stan subskrypcji tylko do odczytu. Plan, decyzja D5: aplikacja nie
 * sprzedaje abonamentu (bez cen i przycisku zakupu), zgodnie z zasadami App
 * Store 3.1; zakup i zmiana planu odbywają się poza aplikacją.
 */
export default function EkranAbonamentu() {
  return (
    <EkranListy>
      <NaglowekKwoty podpis="Subskrypcja" wartosc="Aktywna" styl="title1" status="Plan miesięczny" statusKolor="sukces" />
      <Sekcja naglowek="Okres rozliczeniowy">
        <Wiersz tytul="Okres bieżący" podtytul={`${dataPelna('2026-11-01')} do ${dataPelna('2026-11-30')}`} />
        <Wiersz tytul="Następne odnowienie" wartosc={dataPelna('2026-12-01')} />
      </Sekcja>
      <Sekcja stopka="Wszystkie funkcje FaktWay działają w aplikacji tak samo jak na komputerze." />
    </EkranListy>
  );
}
