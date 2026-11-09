import { SegmentedControl } from '@expo/ui/community/segmented-control';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { DZIS, type Faktura } from '@/dane-przykladowe';
import { EkranListy, Sekcja } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { Tekst } from '@/komponenty/tekst';
import { WierszFaktury } from '@/komponenty/wiersz-faktury';
import { kwota } from '@/lib/format';
import { doZaplaty, ileFaktur, statusFaktury } from '@/lib/status-faktury';
import { useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

const FILTRY = ['Wszystkie', 'Do zapłaty'] as const;

const MIESIACE = new Intl.DateTimeFormat('pl-PL', { month: 'long', year: 'numeric' });

function nazwaMiesiaca(iso: string): string {
  const tekst = MIESIACE.format(new Date(`${iso}T12:00:00`));
  return tekst.charAt(0).toUpperCase() + tekst.slice(1);
}

function grupujPoMiesiacu(faktury: Faktura[]): [string, Faktura[]][] {
  const grupy = new Map<string, Faktura[]>();
  for (const f of faktury) {
    const klucz = nazwaMiesiaca(f.dataWystawienia);
    grupy.set(klucz, [...(grupy.get(klucz) ?? []), f]);
  }
  return [...grupy.entries()];
}

function suma(faktury: Faktura[]): number {
  return faktury.reduce((s, f) => s + f.brutto, 0);
}

export default function EkranFaktur() {
  const router = useRouter();
  const { faktury } = useStanFaktur();
  const [filtr, setFiltr] = useState(0);
  const [szukaj, setSzukaj] = useState('');
  const tylkoDoZaplaty = filtr === 1;

  const otwarte = faktury.filter(doZaplaty);
  const zalegle = otwarte.filter((f) => statusFaktury(f, DZIS).zalegla);

  const widoczne = useMemo(() => {
    const fraza = szukaj.trim().toLocaleLowerCase('pl');
    return faktury
      .filter((f) => (tylkoDoZaplaty ? doZaplaty(f) : true))
      .filter(
        (f) => !fraza || f.kontrahent.toLocaleLowerCase('pl').includes(fraza) || f.numer.toLowerCase().includes(fraza),
      );
  }, [faktury, tylkoDoZaplaty, szukaj]);

  const widoczneZalegle = widoczne.filter((f) => statusFaktury(f, DZIS).zalegla);
  const widocznePrzedTerminem = widoczne.filter((f) => doZaplaty(f) && !statusFaktury(f, DZIS).zalegla);
  const nowa = () => router.push('/nowa');

  return (
    <>
      <Stack.SearchBar placeholder="Kontrahent albo numer" onChangeText={(e) => setSzukaj(e.nativeEvent.text)} />

      <EkranListy keyboardShouldPersistTaps="handled">
        {szukaj ? null : (
          <View
            style={styles.podsumowanie}
            accessible
            accessibilityLabel={`Do zapłaty ${kwota(suma(otwarte))}. Po terminie ${zalegle.length}, razem ${kwota(suma(zalegle))}.`}>
            <Tekst styl="subheadline" kolor="etykietaDrugorzedna">
              Do zapłaty
            </Tekst>
            <Tekst styl="title1" cyfry selectable>
              {kwota(suma(otwarte))}
            </Tekst>
            {zalegle.length > 0 ? (
              <Tekst styl="subheadline" kolor="ostrzezenie">
                {ileFaktur(zalegle.length)} po terminie,{' '}
                {kwota(suma(zalegle))}
              </Tekst>
            ) : (
              <Tekst styl="subheadline" kolor="etykietaDrugorzedna">
                Nic po terminie
              </Tekst>
            )}
          </View>
        )}

        {/* D7 (Bartosz, 09.11.2026): „Nowa faktura” jako szeroki bloczek pod sumą, nie plus w pasku. */}
        {!szukaj ? (
          <View style={styles.akcja}>
            <PrzyciskGlowny tytul="Nowa faktura" ikona="plus" onPress={nowa} />
          </View>
        ) : null}

        <View style={styles.filtr}>
          <SegmentedControl
            values={[...FILTRY]}
            selectedIndex={filtr}
            onChange={(e) => setFiltr(e.nativeEvent.selectedSegmentIndex)}
            accessibilityLabel="Pokaż faktury"
          />
        </View>

        {widoczne.length === 0 ? (
          <StanPusty
            ikona={szukaj ? 'magnifyingglass' : 'checkmark.circle'}
            tytul={szukaj ? 'Brak wyników' : 'Wszystko zapłacone'}
            opis={szukaj ? `Nie ma faktury pasującej do „${szukaj}”.` : 'Żadna faktura nie czeka na zapłatę.'}
          />
        ) : tylkoDoZaplaty ? (
          <>
            {widoczneZalegle.length > 0 ? (
              <Sekcja naglowek="Po terminie" stopka={`Razem ${kwota(suma(widoczneZalegle))}`}>
                {widoczneZalegle.map((f) => (
                  <WierszFaktury key={f.id} faktura={f} />
                ))}
              </Sekcja>
            ) : null}
            {widocznePrzedTerminem.length > 0 ? (
              <Sekcja naglowek="Przed terminem" stopka={`Razem ${kwota(suma(widocznePrzedTerminem))}`}>
                {widocznePrzedTerminem.map((f) => (
                  <WierszFaktury key={f.id} faktura={f} />
                ))}
              </Sekcja>
            ) : null}
          </>
        ) : (
          grupujPoMiesiacu(widoczne).map(([miesiac, lista]) => (
            <Sekcja key={miesiac} naglowek={miesiac}>
              {lista.map((f) => (
                <WierszFaktury key={f.id} faktura={f} />
              ))}
            </Sekcja>
          ))
        )}
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  podsumowanie: { paddingHorizontal: MARGINES + ODSTEP.xxs, paddingTop: ODSTEP.xs, gap: ODSTEP.linia },
  filtr: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});
