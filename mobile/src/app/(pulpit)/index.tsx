import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import {
  FINANSE_PRZYCHOD,
  FINANSE_ZYSK,
  MIESIACE_7,
  NAJLEPIEJ_SPRZEDAJACE,
  NAJWIEKSI_KLIENCI,
  NALEZNOSCI,
  RAPORT_MIESIACA,
  VAT_NALEZNY,
} from '@/dane-przykladowe/pulpit';
import { CZLONKOWIE } from '@/dane-przykladowe/ustawienia';
import { Kafle } from '@/komponenty/kafle';
import { Kubelki } from '@/komponenty/kubelki';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PasekMarki } from '@/komponenty/pasek-marki';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { Wykres } from '@/komponenty/wykres';
import { kwota, kwotaKrotka } from '@/lib/format';
import { ileFaktur } from '@/lib/status-faktury';
import { useKolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

/**
 * Pulpit: przegląd finansów firmy. Odpowiednik `app/(dashboard)/dashboard`
 * strony i jej kart (Finanse ze słupkami składanymi, Raport, Faktury w KSeF,
 * Średnia faktura, Przychód netto, VAT należny, Należności, Najlepiej
 * sprzedające się, Najwięksi klienci). Na górze logo FaktWay zamiast
 * systemowego tytułu (plan, D12).
 */
export default function EkranPulpitu() {
  const router = useRouter();
  const kolory = useKolory();
  const r = RAPORT_MIESIACA;
  const zysk = r.przychodNetto - r.koszty;
  const vat7 = VAT_NALEZNY.slice(-MIESIACE_7.length).map((p) => p.y);
  const wlasciciel = CZLONKOWIE.find((c) => c.ty)?.imie ?? '';
  const inicjaly = wlasciciel
    .split(' ')
    .map((czlon) => czlon[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const naleznosciProcent = (kwotaWGroszach: number) => Math.round((kwotaWGroszach / Math.max(1, NALEZNOSCI.razem)) * 100);

  return (
    <View style={[styles.ekran, { backgroundColor: kolory.tloGrupowane }]}>
      <PasekMarki inicjaly={inicjaly} etykietaAwatara={`${wlasciciel}: firma i ustawienia`} onAwatar={() => router.push('/wiecej')} />
      <EkranListy gradient="pod-paskiem">
        <NaglowekKwoty
          podpis={zysk >= 0 ? 'Zysk w listopadzie' : 'Strata w listopadzie'}
          wartosc={kwota(zysk)}
          styl="title1"
          status={`Średnio ${kwotaKrotka(r.srednioZysk)} miesięcznie`}
        />

        <View style={styles.akcja}>
          <PrzyciskGlowny tytul="Nowa faktura" ikona="add-line" onPress={() => router.push('/faktury/nowa')} />
        </View>

        <Kafle
          kafle={[
            { klucz: 'przychod', podpis: 'Przychód netto', wartosc: kwotaKrotka(r.przychodNetto), ikona: 'wallet-line', zmiana: r.przychodZmiana },
            { klucz: 'koszty', podpis: 'Koszty', wartosc: kwotaKrotka(r.koszty), ikona: 'bank-card-line', opis: 'Ten miesiąc', onPress: () => router.push('/koszty') },
            { klucz: 'ksef', podpis: 'Faktury w KSeF', wartosc: String(r.fakturyWKsef), ikona: 'file-list3-line', zmiana: r.fakturyZmiana, onPress: () => router.push('/faktury') },
            { klucz: 'srednia', podpis: 'Średnia faktura', wartosc: kwotaKrotka(r.sredniaFaktura), ikona: 'cash-line', zmiana: r.sredniaZmiana },
          ]}
        />

        <Sekcja naglowek="Finanse" opis="Ostatnie 7 miesięcy: koszty, zysk i VAT" naglowekAkcja={{ tytul: 'Przepływy', onPress: () => router.push('/przeplywy') }} swobodna>
          <Wykres
            punkty={MIESIACE_7.map((m) => ({ x: m, y: 0 }))}
            stos={[
              { nazwa: 'Koszty', kolor: 'wykres4', wartosci: FINANSE_PRZYCHOD.map((p, i) => p - (FINANSE_ZYSK[i] ?? 0)) },
              { nazwa: 'Zysk', kolor: 'wykres2', wartosci: FINANSE_ZYSK },
              { nazwa: 'VAT', kolor: 'wykres1', wartosci: vat7 },
            ]}
            etykieta="Finanse w ostatnich 7 miesiącach: koszty, zysk i VAT"
          />
        </Sekcja>

        <Sekcja naglowek="Raport" opis="Listopad 2026">
          <Wiersz tytul="Zysk" ikona="money-dollar-circle-line" wartosc={kwota(zysk)} wartoscKolor="etykieta" />
          <Wiersz tytul="Przychód netto" ikona="wallet-line" wartosc={kwota(r.przychodNetto)} wartoscKolor="etykieta" />
          <Wiersz tytul="Koszty" ikona="bank-card-line" wartosc={kwota(r.koszty)} wartoscKolor="etykieta" />
        </Sekcja>

        <Sekcja
          naglowek="VAT należny"
          opis={`Ostatni rok. W listopadzie ${kwota((VAT_NALEZNY.at(-1)?.y ?? 0) * 100)}`}
          naglowekAkcja={{ tytul: 'Rozliczenie', onPress: () => router.push('/ksiegowosc/vat') }}
          swobodna>
          <Wykres punkty={VAT_NALEZNY.map((p) => ({ ...p, opis: kwota(p.y * 100) }))} rodzaj="pole" etykieta="VAT należny w ostatnim roku" />
        </Sekcja>

        <Sekcja
          naglowek="Należności"
          opis={`${kwota(NALEZNOSCI.razem)} do zapłaty, ${NALEZNOSCI.zaleglePct}% po terminie`}
          naglowekAkcja={{ tytul: 'Faktury', onPress: () => router.push({ pathname: '/faktury', params: { widok: 'po-terminie' } }) }}
          swobodna>
          <Kubelki
            kubelki={[
              { podpis: 'W terminie', procent: naleznosciProcent(NALEZNOSCI.wTerminie), kwota: kwotaKrotka(NALEZNOSCI.wTerminie), kolor: 'wykres2' },
              { podpis: '1 do 30 dni po terminie', procent: naleznosciProcent(NALEZNOSCI.do30), kwota: kwotaKrotka(NALEZNOSCI.do30), kolor: 'ostrzezenie' },
              { podpis: '31 dni i więcej', procent: naleznosciProcent(NALEZNOSCI.powyzej30), kwota: kwotaKrotka(NALEZNOSCI.powyzej30), kolor: 'blad' },
            ]}
          />
        </Sekcja>

        <Sekcja naglowek="Najlepiej sprzedające się" opis="Netto, ostatnie 12 miesięcy">
          {NAJLEPIEJ_SPRZEDAJACE.map((p) => (
            <Wiersz key={p.nazwa} tytul={p.nazwa} podtytul={`j.m.: ${p.jm}`} ikona="price-tag3-line" wartosc={kwotaKrotka(p.kwota)} wartoscKolor="etykieta" />
          ))}
        </Sekcja>

        <Sekcja naglowek="Najwięksi klienci" naglowekAkcja={{ tytul: 'Kontrahenci', onPress: () => router.push('/wiecej/kontrahenci') }}>
          {NAJWIEKSI_KLIENCI.map((k) => (
            <Wiersz
              key={k.nazwa}
              tytul={k.nazwa}
              podtytul={k.nip ? `NIP ${k.nip}` : 'Sprzedaż bez NIP nabywcy'}
              wartosc={kwotaKrotka(k.kwota)}
              wartoscKolor="etykieta"
              wartoscPodpis={`${k.udzial}% sprzedaży`}
            />
          ))}
        </Sekcja>

        <Sekcja naglowek="Analizy">
          <Wiersz tytul="Analiza sprzedaży" ikona="line-chart-line" strzalka onPress={() => router.push({ pathname: '/analizy', params: { rodzaj: 'sprzedaz' } })} />
          <Wiersz tytul="Analiza kosztów" ikona="pie-chart2-line" strzalka onPress={() => router.push({ pathname: '/analizy', params: { rodzaj: 'koszty' } })} />
          <Wiersz tytul="Przepływy pieniężne" ikona="exchange-funds-line" strzalka onPress={() => router.push('/przeplywy')} />
        </Sekcja>

        <Sekcja stopka={`Dane przykładowe: ${ileFaktur(r.fakturyWKsef)} w tym miesiącu. Twoje dane pojawią się tu po podłączeniu KSeF w ustawieniach.`}>
          <Wiersz tytul="Podłącz KSeF" ikona="shield-check-line" akcja strzalka onPress={() => router.push('/wiecej/ustawienia/ksef')} />
        </Sekcja>
      </EkranListy>
    </View>
  );
}

const styles = StyleSheet.create({
  ekran: { flex: 1 },
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});
