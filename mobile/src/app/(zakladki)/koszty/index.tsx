import { Stack, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { DZIS, KATEGORIE_KOSZTOW, NAZWA_ZRODLA, type FakturaKosztowa, type Koszt, type ZrodloKosztu } from '@/dane-przykladowe';
import { Segmenty } from '@/komponenty/formularz';
import { NotaDanych, StanBledu } from '@/komponenty/stan-danych';
import { SzkieletListy } from '@/komponenty/szkielet';
import { Karta } from '@/komponenty/karta';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { RzadLiczb } from '@/komponenty/rzad-liczb';
import { SprawdzKsefNaKoncie } from '@/komponenty/sprawdz-ksef';
import { StanPusty } from '@/komponenty/stan-pusty';
import { Tekst } from '@/komponenty/tekst';
import { dataKrotka, dzienTygodnia, kwota } from '@/lib/format';
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
 * w układzie Copilota (D14): karta z trzema liczbami miesiąca, lista po dniach
 * z kolorowymi kategoriami i kropką „do opisania”, filtry, wydatek ze zdjęcia.
 * Od M7 na prawdziwym koncie skrzynka KSeF jest z bazy (jak `(koszty)/inbox`
 * strony); wydatki zostają na danych przykładowych do M9 i M10.
 */
export default function EkranKosztow() {
  const kolory = useKolory();
  const router = useRouter();
  const { koszty, skrzynka: wszystkieZKsef, dane } = useStanFaktur();
  const zBazy = dane.zrodlo === 'baza';
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
  const nowychWSkrzynce = wszystkieZKsef.filter((s) => s.status === 'nowa').length;
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
  const fraza = szukaj.trim().toLocaleLowerCase('pl');
  const skrzynka = wszystkieZKsef.filter(
    (s) => !fraza || s.sprzedawca.toLocaleLowerCase('pl').includes(fraza) || s.nipSprzedawcy.includes(fraza) || s.numer.toLowerCase().includes(fraza),
  );
  const pierwszeWczytanie = zBazy && dane.stan === 'ladowanie' && wszystkieZKsef.length === 0;

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
      kategoria={k.kategoria}
      podtytul={NAZWA_ZRODLA[k.zrodlo]}
      wartosc={kwota(k.brutto)}
      wartoscKolor="etykieta"
      prawaStrona={<View style={[styles.kropka, { backgroundColor: k.doOpisania ? kolory.akcent : 'transparent' }]} />}
      onPress={() => router.push({ pathname: '/koszty/[id]', params: { id: k.id } })}
      etykietaDostepnosci={`${k.dostawca}, ${k.kategoria}, ${kwota(k.brutto)}, ${k.doOpisania ? 'do opisania' : 'opisany'}`}
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

      <EkranListy
        gradient={!szukaj}
        keyboardShouldPersistTaps="handled"
        onOdswiez={
          zBazy
            ? dane.odswiez
            : () =>
                new Promise<void>((gotowe) => {
                  sprawdzTeraz();
                  setTimeout(gotowe, 1500);
                })
        }>
        {szukaj ? null : (
          <>
            <Karta style={styles.karta}>
              <View style={styles.trescKarty}>
                <RzadLiczb
                  liczby={[
                    { wartosc: kwota(wKpir.reduce((s, k) => s + k.brutto, 0)), podpis: 'wydatki w listopadzie' },
                    { wartosc: kwota(vatDoOdliczenia), podpis: 'VAT do odliczenia' },
                    {
                      wartosc: String(doOpisania.length),
                      podpis: 'do opisania',
                      kolor: doOpisania.length > 0 ? 'akcent' : 'etykieta',
                      onPress: () => {
                        setWidok(0);
                        setTylkoDoOpisania(true);
                      },
                    },
                  ]}
                />
              </View>
            </Karta>
            {zBazy ? (
              // „Sprawdź teraz” zleca pobranie z KSeF na serwerze (M10a, `POST /skrzynka/sprawdz`).
              <SprawdzKsefNaKoncie style={styles.ksef} />
            ) : (
              <Pressable
                onPress={sprawdzam ? undefined : sprawdzTeraz}
                accessibilityRole="button"
                accessibilityLabel={`Ostatnie pobranie z KSeF: ${pobranie}. Sprawdzamy co 15 minut. Sprawdź teraz.`}
                hitSlop={ODSTEP.xs}
                style={styles.ksef}>
                <Tekst styl="footnote" kolor="etykietaDrugorzedna">
                  {sprawdzam ? 'Sprawdzam KSeF…' : `KSeF sprawdzony ${pobranie}, co 15 minut. `}
                  {sprawdzam ? null : (
                    <Tekst styl="footnote" kolor="akcent" waga="medium">
                      Sprawdź teraz
                    </Tekst>
                  )}
                </Tekst>
              </Pressable>
            )}
            {widok === 1 ? <NotaDanych dane={dane} /> : null}
            <View style={styles.akcja}>
              <PrzyciskGlowny tytul="Dodaj wydatek" ikona="camera-line" onPress={() => router.push('/koszty/dodaj')} />
            </View>
          </>
        )}

        <Segmenty wartosci={['Wydatki', 'Skrzynka KSeF']} wybrany={widok} onZmiana={setWidok} etykieta="Rodzaje kosztów" liczniki={[undefined, nowychWSkrzynce > 0 ? nowychWSkrzynce : undefined]} />

        {widok === 0 ? (
          widoczne.length === 0 ? (
            <StanPusty
              ikona="inbox-archive-line"
              tytul="Brak wydatków"
              opis={szukaj ? `Nic nie pasuje do „${szukaj}”.` : 'Dodaj wydatek ze zdjęcia albo poczekaj na faktury z KSeF.'}
              akcja={szukaj ? undefined : { tytul: 'Dodaj wydatek', onPress: () => router.push('/koszty/dodaj') }}
            />
          ) : (
            <Sekcja
              naglowek={tylkoDoOpisania ? 'Do opisania' : undefined}
              naglowekAkcja={tylkoDoOpisania ? { tytul: 'Pokaż wszystkie', onPress: () => setTylkoDoOpisania(false) } : undefined}
              stopka={zrodlo !== 'Wszystkie źródła' || kategoria !== 'Wszystkie kategorie' ? `Filtr: ${zrodlo}, ${kategoria}.` : undefined}>
              {/* Lista po dniach jak w Copilocie (D14): nagłówek dnia, pod nim wydatki. */}
              {poDniach(widoczne).flatMap(([dzien, lista]) => [
                <Tekst key={`dzien-${dzien}`} styl="caption1" waga="semibold" kolor="etykietaDrugorzedna" accessibilityRole="header" style={styles.dzien}>
                  {dzienTygodnia(dzien)}
                </Tekst>,
                ...lista.map(wiersz),
              ])}
            </Sekcja>
          )
        ) : pierwszeWczytanie ? (
          <SzkieletListy etykieta="Wczytujemy skrzynkę KSeF" />
        ) : zBazy && dane.stan === 'blad' ? (
          <StanBledu dane={dane} tytul="Nie udało się pobrać skrzynki KSeF" />
        ) : skrzynka.length === 0 ? (
          <StanPusty
            ikona={fraza ? 'search-line' : 'inbox-archive-line'}
            tytul={fraza ? 'Nic nie pasuje' : 'Brak faktur przychodzących'}
            opis={fraza ? `Brak faktur kosztowych pasujących do „${szukaj.trim()}”.` : 'Faktury kosztowe z KSeF pojawią się tu same.'}
          />
        ) : (
          <Sekcja
            naglowek="Faktury przychodzące z KSeF"
            stopka={dane.skrzynkaPelna ? undefined : 'Pokazujemy 200 najnowszych faktur według daty przyjęcia w KSeF. Starsze znajdziesz na faktway.pl.'}>
            {skrzynka.map((s) => (
              <WierszSkrzynki key={s.id} faktura={s} onPress={() => router.push({ pathname: '/koszty/ksef/[id]', params: { id: s.id } })} />
            ))}
          </Sekcja>
        )}
      </EkranListy>
    </>
  );
}

/** Status jak na stronie: „Nowa”, „Opisana”; archiwum z historii KSeF bez kosztu ma własny podpis. */
function podpisSkrzynki(s: FakturaKosztowa): { tekst?: string; kolor: 'akcent' | 'etykietaDrugorzedna' } {
  if (s.status === 'nowa') return { tekst: 'Nowa', kolor: 'akcent' };
  if (s.status === 'opisana') return { tekst: 'Opisana', kolor: 'etykietaDrugorzedna' };
  if (s.zHistorii) return { tekst: 'Historia z KSeF', kolor: 'etykietaDrugorzedna' };
  return { kolor: 'etykietaDrugorzedna' };
}

function WierszSkrzynki({ faktura: s, onPress }: { faktura: FakturaKosztowa; onPress: () => void }) {
  const podpis = podpisSkrzynki(s);
  return (
    <Wiersz
      tytul={s.sprzedawca}
      podtytul={`${s.numer} · wystawiona ${dataKrotka(s.dataWystawienia)}${s.otrzymano ? `, odebrana ${dataKrotka(s.otrzymano)}` : ''}`}
      wartosc={kwota(s.brutto, s.waluta)}
      wartoscKolor="etykieta"
      wartoscPodpis={podpis.tekst}
      wartoscPodpisKolor={podpis.kolor}
      onPress={onPress}
      etykietaDostepnosci={`${s.sprzedawca}, ${s.numer}, ${kwota(s.brutto, s.waluta)}${podpis.tekst ? `, ${podpis.tekst}` : ''}`}
    />
  );
}

/** Wydatki pogrupowane po dniu, od najnowszego. */
function poDniach(koszty: Koszt[]): [string, Koszt[]][] {
  const dni = new Map<string, Koszt[]>();
  for (const k of [...koszty].sort((a, b) => b.data.localeCompare(a.data))) {
    dni.set(k.data, [...(dni.get(k.data) ?? []), k]);
  }
  return [...dni.entries()];
}

const styles = StyleSheet.create({
  karta: { marginTop: ODSTEP.s },
  trescKarty: { paddingVertical: ODSTEP.m, paddingHorizontal: ODSTEP.xs },
  ksef: { marginHorizontal: MARGINES + ODSTEP.xxs, marginTop: ODSTEP.s },
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.m },
  dzien: { textTransform: 'uppercase', letterSpacing: 0.6, paddingHorizontal: MARGINES, paddingTop: ODSTEP.s, paddingBottom: ODSTEP.linia },
  kropka: { width: 8, height: 8, borderRadius: 4 },
});
