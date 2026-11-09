import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import {
  FINANSE_ZYSK,
  MIESIACE_7,
  NAJLEPIEJ_SPRZEDAJACE,
  NAJWIEKSI_KLIENCI,
  NALEZNOSCI,
  RAPORT_MIESIACA,
  VAT_NALEZNY,
} from '@/dane-przykladowe/pulpit';
import { Kafle } from '@/komponenty/kafle';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { Wykres } from '@/komponenty/wykres';
import { kwota, kwotaKrotka, zmiana } from '@/lib/format';
import { ileFaktur } from '@/lib/status-faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

/**
 * Pulpit: przegląd finansów firmy. Odpowiednik `app/(dashboard)/dashboard`
 * (karty Finanse, Raport, Faktury w KSeF, Średnia faktura, Przychód netto,
 * VAT należny, Należności, Najlepiej sprzedające się, Najwięksi klienci).
 */
export default function EkranPulpitu() {
  const router = useRouter();
  const r = RAPORT_MIESIACA;
  const zysk = r.przychodNetto - r.koszty;

  return (
    <EkranListy>
      <NaglowekKwoty
        podpis={zysk >= 0 ? 'Zysk w listopadzie' : 'Strata w listopadzie'}
        wartosc={kwota(zysk)}
        styl="title1"
        status={`Średnio ${kwotaKrotka(r.srednioZysk)} miesięcznie`}
      />

      <View style={styles.akcja}>
        <PrzyciskGlowny tytul="Nowa faktura" ikona="plus" onPress={() => router.push('/faktury/nowa')} />
      </View>

      <Kafle
        kafle={[
          { klucz: 'przychod', podpis: 'Przychód netto', wartosc: kwotaKrotka(r.przychodNetto), opis: `${zmiana(r.przychodZmiana)} m/m`, opisKolor: 'sukces' },
          { klucz: 'koszty', podpis: 'Koszty', wartosc: kwotaKrotka(r.koszty), opis: 'Ten miesiąc', onPress: () => router.push('/koszty') },
          { klucz: 'ksef', podpis: 'Faktury w KSeF', wartosc: String(r.fakturyWKsef), opis: `${zmiana(r.fakturyZmiana)} m/m`, opisKolor: 'sukces', onPress: () => router.push('/faktury') },
          { klucz: 'srednia', podpis: 'Średnia faktura', wartosc: kwotaKrotka(r.sredniaFaktura), opis: `${zmiana(r.sredniaZmiana)} m/m`, opisKolor: 'ostrzezenie' },
        ]}
      />

      <Sekcja naglowek="Finanse" stopka="Zysk w ostatnich 7 miesiącach: przychód netto minus koszty." swobodna>
        <Wykres
          punkty={FINANSE_ZYSK.map((y, i) => ({ x: MIESIACE_7[i] ?? '', y, opis: kwota(y * 100), kolor: y < 0 ? 'blad' : 'akcent' }))}
          etykieta="Zysk w ostatnich 7 miesiącach"
        />
      </Sekcja>
      <Sekcja>
        <Wiersz tytul="Przepływy pieniężne" ikona="arrow.left.arrow.right" strzalka onPress={() => router.push('/przeplywy')} />
      </Sekcja>

      <Sekcja naglowek="VAT należny" stopka={`Ostatni rok. W listopadzie ${kwota((VAT_NALEZNY.at(-1)?.y ?? 0) * 100)}.`} swobodna>
        <Wykres punkty={VAT_NALEZNY.map((p) => ({ ...p, opis: kwota(p.y * 100) }))} rodzaj="linia" etykieta="VAT należny w ostatnim roku" />
      </Sekcja>
      <Sekcja>
        <Wiersz tytul="VAT za ten miesiąc" ikona="percent" strzalka onPress={() => router.push('/ksiegowosc/vat')} />
      </Sekcja>

      <Sekcja naglowek="Należności" stopka={`${NALEZNOSCI.zaleglePct}% kwoty jest po terminie.`}>
        <Wiersz tytul="Do zapłaty razem" wartosc={kwota(NALEZNOSCI.razem)} wartoscKolor="etykieta" />
        <Wiersz tytul="W terminie" wartosc={kwota(NALEZNOSCI.wTerminie)} />
        <Wiersz tytul="Od 1 do 30 dni po terminie" wartosc={kwota(NALEZNOSCI.do30)} wartoscKolor="ostrzezenie" />
        <Wiersz tytul="31 dni i więcej" wartosc={kwota(NALEZNOSCI.powyzej30)} />
        <Wiersz tytul="Szczegóły" akcja strzalka onPress={() => router.push('/faktury')} />
      </Sekcja>

      <Sekcja naglowek="Najlepiej sprzedające się" stopka="Netto, ostatnie 12 miesięcy.">
        {NAJLEPIEJ_SPRZEDAJACE.map((p) => (
          <Wiersz key={p.nazwa} tytul={p.nazwa} podtytul={`j.m.: ${p.jm}`} wartosc={kwotaKrotka(p.kwota)} wartoscKolor="etykieta" />
        ))}
      </Sekcja>

      <Sekcja naglowek="Najwięksi klienci">
        {NAJWIEKSI_KLIENCI.map((k) => (
          <Wiersz
            key={k.nazwa}
            tytul={k.nazwa}
            podtytul={k.nip ? `NIP ${k.nip}` : 'Sprzedaż bez NIP nabywcy'}
            wartosc={kwotaKrotka(k.kwota)}
            wartoscKolor="etykieta"
            wartoscPodpis={`${k.udzial}%`}
          />
        ))}
        <Wiersz tytul="Kontrahenci" akcja strzalka onPress={() => router.push('/wiecej/kontrahenci')} />
      </Sekcja>

      <Sekcja naglowek="Analizy">
        <Wiersz tytul="Analiza sprzedaży" ikona="chart.bar" strzalka onPress={() => router.push({ pathname: '/analizy', params: { rodzaj: 'sprzedaz' } })} />
        <Wiersz tytul="Analiza kosztów" ikona="chart.pie" strzalka onPress={() => router.push({ pathname: '/analizy', params: { rodzaj: 'koszty' } })} />
        <Wiersz tytul="Twój rok w liczbach" ikona="sparkles" strzalka onPress={() => router.push('/twoj-rok')} />
      </Sekcja>

      <Sekcja stopka={`Dane przykładowe: ${ileFaktur(r.fakturyWKsef)} w tym miesiącu. Twoje dane pojawią się tu po podłączeniu KSeF w ustawieniach.`}>
        <Wiersz tytul="Podłącz KSeF" akcja strzalka onPress={() => router.push('/wiecej/ustawienia/ksef')} />
      </Sekcja>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});
