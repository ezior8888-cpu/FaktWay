import { Stack, useRouter } from 'expo-router';

import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { useStanFaktur } from '@/stan/faktury';

/**
 * Wybór rodzaju faktury: odpowiednik `components/invoices/invoice-type-selector.tsx`.
 * Na prawdziwym koncie (M8) z telefonu wystawisz zwykłą fakturę; pozostałe
 * rodzaje otwierają ekran „na faktway.pl” (formularz, M10).
 */
export default function EkranRodzajuFaktury() {
  const router = useRouter();
  const zBazy = useStanFaktur().dane.zrodlo === 'baza';
  const otworz = (rodzaj: string) => router.push({ pathname: '/faktury/nowa/[rodzaj]', params: { rodzaj } });
  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.dismissTo('/faktury')}>Anuluj</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <EkranListy>
        <Sekcja naglowek="Rodzaj faktury" stopka={zBazy ? 'Z telefonu wystawisz fakturę zwykłą. Korektę, zaliczkę i rozliczenie wystawisz na faktway.pl.' : undefined}>
          <Wiersz tytul="Faktura zwykła" podtytul="Standardowa faktura sprzedażowa B2B lub B2C" ikona="file-text-line" strzalka onPress={() => otworz('vat')} />
          <Wiersz tytul="Faktura korygująca" podtytul="Korekta wystawionej faktury (dane, kwoty, anulowanie)" ikona="arrow-go-back-line" strzalka onPress={() => otworz('korygujaca')} />
          <Wiersz tytul="Faktura zaliczkowa" podtytul="Zaliczka na poczet przyszłej dostawy lub usługi" ikona="cash-line" strzalka onPress={() => otworz('zaliczkowa')} />
          <Wiersz tytul="Faktura rozliczająca" podtytul="Rozliczenie wcześniej wystawionych zaliczek" ikona="checkbox-multiple-line" strzalka onPress={() => otworz('rozliczajaca')} />
        </Sekcja>
      </EkranListy>
    </>
  );
}
