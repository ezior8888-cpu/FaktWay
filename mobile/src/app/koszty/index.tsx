import { Stack, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { DZIS, KATEGORIE_KOSZTOW, NAZWA_ZRODLA, type Koszt, type ZrodloKosztu } from '@/dane-przykladowe';
import { Segmenty } from '@/komponenty/formularz';
import { Kafle } from '@/komponenty/kafle';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { dataKrotka, kwota } from '@/lib/format';
import { useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';
import { IKONY_PASKA } from '@/wyglad/ikony-paska';
import { useKolory } from '@/wyglad/kolory';

const ZRODLA: { etykieta: string; zrodlo?: ZrodloKosztu }[] = [
  { etykieta: 'Wszystkie źródła' },
  { etykieta: 'KSeF', zrodlo: 'ksef' },
  { etykieta: 'Zdjęcie', zrodlo: 'zdjecie' },
  { etykieta: 'Ręcznie', zrodlo: 'reczny' },
  { etykieta: 'Import', zrodlo: 'import' },
];

/**
 * Koszty: odpowiednik sekcji strony `(koszty)` (Wydatki i Skrzynka KSeF)
 * z kafelkami miesiąca, filtrami i dodawaniem wydatku ze zdjęcia.
 */
export default function EkranKosztow() {
  const kolory = useKolory();
  const router = useRouter();
  const { koszty } = useStanFaktur();
  const [widok, setWidok] = useState(0);
  const [tylkoDoOpisania, setTylkoDoOpisania] = useState(false);
  const [zrodlo, setZrodlo] = useState('Wszystkie źródła');
  const [kategoria, setKategoria] = useState('Wszystkie kategorie');
  const [szukaj, setSzukaj] = useState('');
  const [pobranie, setPobranie] = useState('dziś, 7:45');
  const [sprawdzam, setSprawdzam] = useState(false);

  const miesiac = koszty.filter((k) => k.data.startsWith(DZIS.slice(0, 7)));
  const wKpir = miesiac.filter((k) => k.wKpir);
  const doOpisania = koszty.filter((k) => k.doOpisania);
  const vatDoOdliczenia = miesiac.filter((k) => k.dokument !== 'Paragon').reduce((s, k) => s + (k.brutto - k.netto), 0);

  const widoczne = useMemo(() => {
    const fraza = szukaj.trim().toLocaleLowerCase('pl');
    const wybraneZrodlo = ZRODLA.find((z) => z.etykieta === zrodlo)?.zrodlo;
    return koszty
      .filter((k) => (tylkoDoOpisania ? k.doOpisania : true))
      .filter((k) => !wybraneZrodlo || k.zrodlo === wybraneZrodlo)
      .filter((k) => kategoria === 'Wszystkie kategorie' || k.kategoria === kategoria)
      .filter((k) => !fraza || k.dostawca.toLocaleLowerCase('pl').includes(fraza) || (k.nip ?? '').includes(fraza) || k.numer.toLowerCase().includes(fraza));
  }, [koszty, tylkoDoOpisania, zrodlo, kategoria, szukaj]);
  const skrzynka = koszty.filter((k) => k.zrodlo === 'ksef').filter((k) => !szukaj || k.dostawca.toLocaleLowerCase('pl').includes(szukaj.toLocaleLowerCase('pl')));

  const sprawdzTeraz = () => {
    setSprawdzam(true);
    setTimeout(() => {
      setSprawdzam(false);
      setPobranie('przed chwilą');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }, 1500);
  };

  const wiersz = (k: Koszt) => (
    <Wiersz
      key={k.id}
      tytul={k.dostawca}
      podtytul={`${k.kategoria} · ${NAZWA_ZRODLA[k.zrodlo]} · ${dataKrotka(k.data)}`}
      wartosc={kwota(k.brutto)}
      wartoscKolor="etykieta"
      wartoscPodpis={k.doOpisania ? 'Do opisania' : 'Opisany'}
      wartoscPodpisKolor={k.doOpisania ? 'ostrzezenie' : 'sukces'}
      onPress={() => router.push({ pathname: '/koszty/[id]', params: { id: k.id } })}
      etykietaDostepnosci={`${k.dostawca}, ${kwota(k.brutto)}, ${k.doOpisania ? 'do opisania' : 'opisany'}`}
    />
  );

  return (
    <>
      <Stack.SearchBar placeholder="Sprzedawca, NIP, numer" onChangeText={(e) => setSzukaj(e.nativeEvent.text)} />
      {widok === 0 ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Menu icon={IKONY_PASKA.filtr} iconRenderingMode="template" tintColor={kolory.etykieta} title="Filtry wydatków">
            <Stack.Toolbar.Menu title="Widok" inline>
              <Stack.Toolbar.MenuAction isOn={!tylkoDoOpisania} onPress={() => setTylkoDoOpisania(false)}>
                Wszystkie
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction isOn={tylkoDoOpisania} onPress={() => setTylkoDoOpisania(true)}>
                Do opisania
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
            <Stack.Toolbar.Menu title="Źródło" inline>
              {ZRODLA.map((z) => (
                <Stack.Toolbar.MenuAction key={z.etykieta} isOn={zrodlo === z.etykieta} onPress={() => setZrodlo(z.etykieta)}>
                  {z.etykieta}
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>
            <Stack.Toolbar.Menu title="Kategoria">
              {['Wszystkie kategorie', ...KATEGORIE_KOSZTOW].map((x) => (
                <Stack.Toolbar.MenuAction key={x} isOn={kategoria === x} onPress={() => setKategoria(x)}>
                  {x}
                </Stack.Toolbar.MenuAction>
              ))}
            </Stack.Toolbar.Menu>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      ) : null}

      <EkranListy keyboardShouldPersistTaps="handled">
        {szukaj ? null : (
          <>
            <NaglowekKwoty
              podpis="Wydatki w tym miesiącu"
              wartosc={kwota(wKpir.reduce((s, k) => s + k.brutto, 0))}
              styl="title1"
              status="Tylko koszty w KPiR"
            />
            <View style={styles.akcja}>
              <PrzyciskGlowny tytul="Dodaj wydatek" ikona="camera-line" onPress={() => router.push('/koszty/dodaj')} />
            </View>
            <Kafle
              kafle={[
                { klucz: 'vat', ikona: 'percent-line', podpis: 'VAT do odliczenia', wartosc: kwota(vatDoOdliczenia), opis: 'Z faktur, jak w JPK_V7M' },
                {
                  klucz: 'opisanie',
                  ikona: 'edit-box-line',
                  podpis: 'Do opisania',
                  wartosc: String(doOpisania.length),
                  opis: doOpisania.length > 0 ? `${doOpisania.length} czeka na sprawdzenie` : 'Wszystko opisane',
                  opisKolor: doOpisania.length > 0 ? 'ostrzezenie' : 'sukces',
                  onPress: () => {
                    setWidok(0);
                    setTylkoDoOpisania(true);
                  },
                },
                {
                  klucz: 'ksef',
                  podpis: 'Ostatnie pobranie z KSeF',
                  wartosc: sprawdzam ? 'Sprawdzam…' : pobranie,
                  opis: 'Sprawdzamy KSeF co 15 minut. Dotknij, żeby sprawdzić teraz.',
                  ikona: 'refresh-line',
                  onPress: sprawdzam ? undefined : sprawdzTeraz,
                },
              ]}
            />
          </>
        )}

        <Segmenty wartosci={['Wydatki', 'Skrzynka KSeF']} wybrany={widok} onZmiana={setWidok} etykieta="Rodzaje kosztów" />

        {widok === 0 ? (
          widoczne.length === 0 ? (
            <StanPusty ikona="inbox-archive-line" tytul="Brak wydatków" opis={szukaj ? `Nic nie pasuje do „${szukaj}”.` : 'Dodaj wydatek ze zdjęcia albo poczekaj na faktury z KSeF.'} />
          ) : (
            <Sekcja naglowek={tylkoDoOpisania ? 'Do opisania' : 'Listopad 2026'} stopka={zrodlo !== 'Wszystkie źródła' || kategoria !== 'Wszystkie kategorie' ? `Filtr: ${zrodlo}, ${kategoria}.` : undefined}>
              {widoczne.map(wiersz)}
            </Sekcja>
          )
        ) : skrzynka.length === 0 ? (
          <StanPusty ikona="inbox-archive-line" tytul="Brak faktur przychodzących" opis="Faktury kosztowe z KSeF pojawią się tu same." />
        ) : (
          <Sekcja naglowek="Faktury przychodzące z KSeF" stopka="Pokazujemy 200 najnowszych faktur według daty przyjęcia w KSeF.">
            {skrzynka.map((k) => (
              <Wiersz
                key={k.id}
                tytul={k.dostawca}
                podtytul={`${k.numer} · wystawiona ${dataKrotka(k.data)}, odebrana ${dataKrotka(k.otrzymano ?? k.data)}`}
                wartosc={kwota(k.brutto)}
                wartoscKolor="etykieta"
                wartoscPodpis={k.doOpisania ? 'Nowa' : 'Opisana'}
                wartoscPodpisKolor={k.doOpisania ? 'akcent' : 'etykietaDrugorzedna'}
                onPress={() => router.push({ pathname: '/koszty/[id]', params: { id: k.id } })}
              />
            ))}
          </Sekcja>
        )}
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});
