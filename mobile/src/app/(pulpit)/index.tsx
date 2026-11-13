import { useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { DZIS, MIESIAC, NAZWA_ZRODLA } from '@/dane-przykladowe';
import { RAPORT_MIESIACA, ZYSK_NARASTAJACO } from '@/dane-przykladowe/pulpit';
import { CZLONKOWIE } from '@/dane-przykladowe/ustawienia';
import { useStylKarty } from '@/komponenty/karta';
import { KartaWyniku } from '@/komponenty/karta-wyniku';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { PasekMarki } from '@/komponenty/pasek-marki';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { Tekst } from '@/komponenty/tekst';
import { dataKrotka, kwota } from '@/lib/format';
import { kiedyTermin } from '@/lib/status-faktury';
import { useStanFaktur } from '@/stan/faktury';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP } from '@/wyglad/odstepy';

/**
 * Pulpit w układzie Copilota (plan aplikacji, D14; makieta z 12.11.2026):
 * karta wyniku miesiąca z wykresem, „Nowa faktura” (D7), koszty z KSeF do
 * przejrzenia i nadchodzące płatności. Wykresy, raport, VAT, należności i
 * klienci są na ekranie Finanse, żeby Pulpit mieścił się na ekranie.
 */
export default function EkranPulpitu() {
  const router = useRouter();
  const kolory = useKolory();
  const stylKarty = useStylKarty();
  const { koszty } = useStanFaktur();
  const r = RAPORT_MIESIACA;
  const zysk = r.przychodNetto - r.koszty;
  const doPrzejrzenia = koszty.filter((k) => k.doOpisania);
  const wlasciciel = CZLONKOWIE.find((c) => c.ty)?.imie ?? '';
  const inicjaly = wlasciciel
    .split(' ')
    .map((czlon) => czlon[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

  // Nadchodzące płatności (ZUS, PIT, VAT) pogrupowane po terminie.
  const terminy = new Map<string, typeof MIESIAC.platnosci>();
  for (const p of MIESIAC.platnosci.filter((x) => !x.zaplacona)) {
    terminy.set(p.termin, [...(terminy.get(p.termin) ?? []), p]);
  }

  return (
    <View style={[styles.ekran, { backgroundColor: kolory.tloGrupowane }]}>
      <PasekMarki inicjaly={inicjaly} etykietaAwatara={`${wlasciciel}: firma i ustawienia`} onAwatar={() => router.push('/wiecej')} />
      <EkranListy gradient="pod-paskiem">
        <KartaWyniku
          podpis={zysk >= 0 ? 'Zysk w listopadzie' : 'Strata w listopadzie'}
          wynik={zysk}
          opis={`średnio ${kwota(r.srednioZysk)} miesięcznie`}
          narastajaco={ZYSK_NARASTAJACO}
          dniWMiesiacu={30}
          sredniMiesiac={r.srednioZysk}
          od="1 lis"
          do="30 lis"
          liczby={[
            { wartosc: kwota(r.przychodNetto), podpis: 'przychód netto' },
            { wartosc: kwota(r.koszty), podpis: 'koszty', onPress: () => router.push('/koszty') },
            { wartosc: String(r.fakturyWKsef), podpis: 'faktur w KSeF', onPress: () => router.push('/faktury') },
          ]}
        />

        <View style={styles.akcja}>
          <PrzyciskGlowny tytul="Nowa faktura" ikona="add-line" onPress={() => router.push('/faktury/nowa')} />
        </View>

        <Sekcja
          naglowek="Do przejrzenia"
          naglowekAkcja={{ tytul: 'Koszty', onPress: () => router.push('/koszty') }}
          stopka={doPrzejrzenia.length > 0 ? 'Dotknij, żeby przypisać kategorię i kolumnę KPiR.' : undefined}>
          {doPrzejrzenia.length > 0 ? (
            doPrzejrzenia.map((k) => (
              <Wiersz
                key={k.id}
                tytul={k.dostawca}
                kategoria={k.kategoria}
                podtytul={`${NAZWA_ZRODLA[k.zrodlo]} · ${dataKrotka(k.data)}`}
                wartosc={kwota(k.brutto)}
                wartoscKolor="etykieta"
                prawaStrona={<View style={[styles.kropka, { backgroundColor: kolory.akcent }]} />}
                onPress={() => router.push({ pathname: '/koszty/[id]', params: { id: k.id } })}
                etykietaDostepnosci={`${k.dostawca}, ${k.kategoria}, ${kwota(k.brutto)}, do opisania`}
              />
            ))
          ) : (
            <Wiersz tytul="Wszystko opisane" podtytul="Nowe faktury kosztowe z KSeF pojawią się tutaj." ikona="checkbox-circle-line" ikonaKolor="sukces" />
          )}
        </Sekcja>

        {terminy.size > 0 ? (
          <Sekcja naglowek="Nadchodzące" naglowekAkcja={{ tytul: 'Ten miesiąc', onPress: () => router.push('/ksiegowosc') }} bezKarty>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.terminy}>
              {[...terminy.entries()].map(([termin, lista]) => (
                <View key={termin} style={styles.grupa}>
                  <Tekst styl="footnote" kolor="etykietaDrugorzedna" style={styles.kiedy}>
                    {`${dataKrotka(termin)}, ${kiedyTermin(DZIS, termin)}`}
                  </Tekst>
                  <View style={styles.platnosci}>
                    {lista.map((p) => (
                      <Pressable
                        key={p.id}
                        onPress={() => router.push('/ksiegowosc')}
                        accessibilityRole="button"
                        accessibilityLabel={`${p.nazwa}, ${kwota(p.kwota)}, termin ${dataKrotka(termin)}`}
                        style={[styles.platnosc, stylKarty]}>
                        <Tekst styl="callout">{p.nazwa}</Tekst>
                        <Tekst styl="callout" waga="semibold" cyfry>
                          {kwota(p.kwota)}
                        </Tekst>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ))}
            </ScrollView>
          </Sekcja>
        ) : null}

        <Sekcja naglowek="Finanse" stopka="Dane przykładowe. Twoje dane pojawią się tu po podłączeniu KSeF w ustawieniach.">
          <Wiersz tytul="Wykresy i raport miesiąca" podtytul="Finanse, VAT należny, należności, klienci" strzalka onPress={() => router.push('/finanse')} />
          <Wiersz tytul="Przepływy pieniężne" strzalka onPress={() => router.push('/przeplywy')} />
          <Wiersz tytul="Podłącz KSeF" akcja strzalka onPress={() => router.push('/wiecej/ustawienia/ksef')} />
        </Sekcja>
      </EkranListy>
    </View>
  );
}

const styles = StyleSheet.create({
  ekran: { flex: 1 },
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.m },
  kropka: { width: 8, height: 8, borderRadius: 4 },
  terminy: { paddingHorizontal: MARGINES, gap: ODSTEP.s, paddingBottom: ODSTEP.xs },
  grupa: { gap: ODSTEP.xs },
  kiedy: { paddingLeft: ODSTEP.xxs },
  platnosci: { flexDirection: 'row', gap: ODSTEP.s },
  platnosc: { minHeight: CEL_DOTYKU + ODSTEP.xxs, paddingHorizontal: ODSTEP.m - 2, flexDirection: 'row', alignItems: 'center', gap: ODSTEP.s },
});
