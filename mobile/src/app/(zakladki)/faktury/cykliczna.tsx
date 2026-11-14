import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { DZIS } from '@/dane-przykladowe';
import type { FakturaCykliczna } from '@/dane-przykladowe/kontrahenci';
import { PoleDaty, PoleTekstowe, PoleWyboru } from '@/komponenty/formularz';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { potwierdz } from '@/komponenty/potwierdz';
import { dataPelna, kwota } from '@/lib/format';
import { useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';
import { EkranTylkoNaStronie } from '@/komponenty/na-stronie';
import { PrzyciskPaska } from '@/komponenty/przycisk-paska';

/** Na prawdziwym koncie (M7) ten zapis jeszcze nie działa z telefonu: ekran mówi, gdzie go zrobić. */
export default function EkranFakturyCyklicznej() {
  const { dane } = useStanFaktur();
  if (dane.zrodlo === 'baza') return <EkranTylkoNaStronie co="cykliczna" />;
  return <EkranFakturyCyklicznejPrzyklad />;
}

/**
 * Faktura cykliczna: nowa albo edycja (`invoices/recurring`): faktura-wzór,
 * nazwa, harmonogram; akcje Wystaw teraz, Wstrzymaj albo Wznów, Usuń.
 */
function EkranFakturyCyklicznejPrzyklad() {
  const router = useRouter();
  const { id, wzor } = useLocalSearchParams<{ id?: string; wzor?: string }>();
  const { cykliczne, faktury, zapiszCykliczna, usunCykliczna } = useStanFaktur();
  const istniejaca = cykliczne.find((c) => c.id === id);
  const wzory = faktury.filter((f) => f.rodzaj === 'vat' && f.statusKsef === 'przyjeta');
  // Istniejąca cykliczna wystawia według ostatniej faktury swojego kontrahenta, nie pierwszej z listy.
  const [wzorId, setWzorId] = useState(wzor ?? wzory.find((f) => f.kontrahent === istniejaca?.kontrahent)?.id ?? wzory[0]?.id ?? '');
  const wybranyWzor = faktury.find((f) => f.id === wzorId);
  const [nazwa, setNazwa] = useState(istniejaca?.opis ?? wybranyWzor?.pozycje[0]?.nazwa ?? '');
  const [co, setCo] = useState<FakturaCykliczna['co']>(istniejaca?.co ?? 'miesiąc');
  const [nastepna, setNastepna] = useState(istniejaca?.nastepna ?? '2026-12-01');
  const [blad, setBlad] = useState<string>();

  const zapisz = (zmiana: Partial<FakturaCykliczna> = {}) => {
    if (!nazwa.trim()) return setBlad('Wpisz nazwę faktury cyklicznej.');
    zapiszCykliczna({
      id: istniejaca?.id ?? `c${Date.now()}`,
      kontrahent: istniejaca?.kontrahent ?? wybranyWzor?.kontrahent ?? '',
      opis: nazwa.trim(),
      brutto: istniejaca?.brutto ?? wybranyWzor?.brutto ?? 0,
      co,
      nastepna,
      wstrzymana: istniejaca?.wstrzymana ?? false,
      wyslijDoKsef: true,
      ...zmiana,
    });
    router.back();
  };

  return (
    <>
      <Stack.Screen options={{ title: istniejaca ? 'Faktura cykliczna' : 'Nowa cykliczna' }} />
      <PrzyciskPaska strona="lewa" tytul="Anuluj" onPress={() => router.back()} />
      <PrzyciskPaska strona="prawa" tytul={istniejaca ? 'Zapisz' : 'Dodaj'} glowny onPress={() => zapisz()} />

      <EkranListy keyboardShouldPersistTaps="handled">
        <Sekcja naglowek="Faktura-wzór" stopka="Wzorem może być przyjęta w KSeF faktura VAT w złotych.">
          {istniejaca ? (
            <Wiersz tytul={istniejaca.kontrahent} wartosc={kwota(istniejaca.brutto)} />
          ) : (
            <PoleWyboru
              etykieta="Wzór"
              wartosc={wzorId}
              opcje={wzory.map((f) => ({ wartosc: f.id, etykieta: `${f.numer}, ${f.kontrahent}` }))}
              onZmiana={setWzorId}
            />
          )}
        </Sekcja>

        <Sekcja naglowek="Harmonogram" stopka={`Następna faktura: ${dataPelna(nastepna)}, za okres ${co === 'miesiąc' ? 'miesiąca' : co === 'kwartał' ? 'kwartału' : 'roku'}.`}>
          <PoleTekstowe etykieta="Nazwa" wartosc={nazwa} onZmiana={setNazwa} podpowiedz="np. Abonament graficzny" blad={blad} />
          <PoleWyboru
            etykieta="Częstotliwość"
            wartosc={co}
            opcje={[
              { wartosc: 'miesiąc', etykieta: 'Co miesiąc' },
              { wartosc: 'kwartał', etykieta: 'Co kwartał' },
              { wartosc: 'rok', etykieta: 'Co rok' },
            ]}
            onZmiana={setCo}
          />
          <PoleDaty etykieta="Następne wystawienie" wartosc={nastepna} onZmiana={setNastepna} najwczesniej={DZIS} />
        </Sekcja>

        {istniejaca ? (
          <View style={styles.przyciski}>
            <PrzyciskGlowny
              tytul="Wystaw teraz"
              ikona="send-plane-line"
              onPress={() =>
                istniejaca.wstrzymana
                  ? Alert.alert('Faktura cykliczna jest wstrzymana', 'Wznów ją, żeby wystawić fakturę.')
                  : router.replace({ pathname: '/faktury/nowa/[rodzaj]', params: { rodzaj: 'vat', wzor: wybranyWzor?.id ?? wzory[0]?.id ?? '', wprost: '1' } })
              }
            />
            <PrzyciskGlowny
              tytul={istniejaca.wstrzymana ? 'Wznów' : 'Wstrzymaj'}
              ikona={istniejaca.wstrzymana ? 'play-line' : 'pause-line'}
              wariant="drugorzedny"
              onPress={() => zapisz({ wstrzymana: !istniejaca.wstrzymana })}
            />
          </View>
        ) : null}

        {istniejaca ? (
          <Sekcja>
            <Wiersz
              tytul="Usuń fakturę cykliczną"
              niszczacy
              onPress={() =>
                potwierdz({ tytul: `Usunąć fakturę cykliczną „${istniejaca.opis}”?`, opis: 'Wystawione już faktury się nie zmienią.', potwierdz: 'Usuń' }, () => {
                  usunCykliczna(istniejaca.id);
                  router.back();
                })
              }
            />
          </Sekcja>
        ) : null}
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  przyciski: { marginHorizontal: MARGINES, marginTop: ODSTEP.xl, gap: ODSTEP.s },
});
