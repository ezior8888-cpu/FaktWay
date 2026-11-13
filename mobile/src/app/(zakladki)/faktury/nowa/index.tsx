import { Stack, useRouter } from 'expo-router';

import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { EkranTylkoNaStronie } from '@/komponenty/na-stronie';
import { useStanFaktur } from '@/stan/faktury';

/** Na prawdziwym koncie (M7) ten zapis jeszcze nie działa z telefonu: ekran mówi, gdzie go zrobić. */
export default function EkranRodzajuFaktury() {
  const { dane } = useStanFaktur();
  if (dane.zrodlo === 'baza') return <EkranTylkoNaStronie co="wystawienie" />;
  return <EkranRodzajuFakturyPrzyklad />;
}

/** Wybór rodzaju faktury: odpowiednik `components/invoices/invoice-type-selector.tsx`. */
function EkranRodzajuFakturyPrzyklad() {
  const router = useRouter();
  const otworz = (rodzaj: string) => router.push({ pathname: '/faktury/nowa/[rodzaj]', params: { rodzaj } });
  return (
    <>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.dismissTo('/faktury')}>Anuluj</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <EkranListy>
        <Sekcja naglowek="Rodzaj faktury">
          <Wiersz tytul="Faktura zwykła" podtytul="Standardowa faktura sprzedażowa B2B lub B2C" ikona="file-text-line" strzalka onPress={() => otworz('vat')} />
          <Wiersz tytul="Faktura korygująca" podtytul="Korekta wystawionej faktury (dane, kwoty, anulowanie)" ikona="arrow-go-back-line" strzalka onPress={() => otworz('korygujaca')} />
          <Wiersz tytul="Faktura zaliczkowa" podtytul="Zaliczka na poczet przyszłej dostawy lub usługi" ikona="cash-line" strzalka onPress={() => otworz('zaliczkowa')} />
          <Wiersz tytul="Faktura rozliczająca" podtytul="Rozliczenie wcześniej wystawionych zaliczek" ikona="checkbox-multiple-line" strzalka onPress={() => otworz('rozliczajaca')} />
        </Sekcja>
      </EkranListy>
    </>
  );
}
