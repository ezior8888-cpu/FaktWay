import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { bruttoPozycji, cenaPozycji, stawkaTekst, type FakturaKosztowa } from '@/dane-przykladowe';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { MA_ADRES_STRONY, otworzStrone } from '@/komponenty/na-stronie';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { SzkieletListy } from '@/komponenty/szkielet';
import { dataPelna, kwota } from '@/lib/format';
import { useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';
import { useTytulNaGradiencie } from '@/wyglad/naglowki';

function status(s: FakturaKosztowa): { tekst: string; kolor: 'info' | 'sukces' | 'etykietaDrugorzedna' } {
  if (s.status === 'nowa') return { tekst: 'Nowa, do opisania', kolor: 'info' };
  if (s.status === 'opisana') return { tekst: 'Opisana', kolor: 'sukces' };
  if (s.zHistorii) return { tekst: 'Historia z KSeF', kolor: 'etykietaDrugorzedna' };
  return { tekst: 'Wydatek jeszcze powstaje', kolor: 'etykietaDrugorzedna' };
}

/**
 * Faktura kosztowa ze skrzynki KSeF (etap M7): odpowiednik wiersza
 * `(koszty)/inbox` strony, tylko do odczytu, w układzie szczegółu faktury
 * (kwota na gradiencie, potem sprzedawca, dokument, pozycje). Opis i
 * kategoria wydatku: na danych przykładowych ekran wydatku, na prawdziwym
 * koncie strona (ekran wydatku z bazy w M9 i M10).
 */
export default function EkranFakturyKosztowej() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { skrzynka, koszty, dane } = useStanFaktur();
  const { tytul, onScroll, scrollEventThrottle } = useTytulNaGradiencie();
  const s = skrzynka.find((x) => x.id === id);

  if (!s) {
    if (dane.zrodlo === 'baza' && dane.stan === 'ladowanie') {
      return (
        <EkranListy>
          <SzkieletListy wiersze={3} etykieta="Wczytujemy fakturę" />
        </EkranListy>
      );
    }
    return (
      <EkranListy>
        <StanPusty ikona="file-unknow-line" tytul="Nie ma takiej faktury" opis="Telefon pokazuje 200 najnowszych faktur ze skrzynki KSeF. Starsze znajdziesz na faktway.pl." />
      </EkranListy>
    );
  }

  const st = status(s);
  // Ekran wydatku jest dziś tylko na danych przykładowych; wydatek z bazy otwiera strona.
  const wydatekWTelefonie = s.wydatekId ? koszty.some((k) => k.id === s.wydatekId) : false;
  const vat = s.netto === undefined ? undefined : s.brutto - s.netto;

  return (
    <>
      <Stack.Screen options={{ title: s.numer, headerTitleStyle: tytul }} />
      <EkranListy gradient onScroll={onScroll} scrollEventThrottle={scrollEventThrottle}>
        <NaglowekKwoty podpis={s.sprzedawca} podpisWyrozniony wartosc={kwota(s.brutto, s.waluta)} status={st.tekst} statusKolor={st.kolor} />

        {s.wydatekId && wydatekWTelefonie ? (
          <View style={styles.akcja}>
            <PrzyciskGlowny
              tytul={s.status === 'nowa' ? 'Opisz wydatek' : 'Otwórz wydatek'}
              ikona="edit-box-line"
              onPress={() => router.push({ pathname: '/koszty/[id]', params: { id: s.wydatekId as string } })}
            />
          </View>
        ) : null}

        <Sekcja naglowek="Sprzedawca">
          <Wiersz tytul={s.sprzedawca} podtytul={s.nipSprzedawcy ? `NIP: ${s.nipSprzedawcy}` : undefined} zaznaczalna />
        </Sekcja>

        <Sekcja naglowek="Dokument">
          <Wiersz tytul="Numer" wartosc={s.numer} />
          {s.numerKsef ? <Wiersz tytul="Numer KSeF" podtytul={s.numerKsef} zaznaczalna /> : null}
          <Wiersz tytul="Data wystawienia" wartosc={dataPelna(s.dataWystawienia)} />
          {s.otrzymano ? <Wiersz tytul="Przyjęta w KSeF" wartosc={dataPelna(s.otrzymano)} /> : null}
        </Sekcja>

        {s.pozycje.length > 0 ? (
          <Sekcja naglowek="Pozycje">
            {s.pozycje.map((p, i) => (
              <Wiersz
                key={i}
                tytul={p.nazwa}
                podtytul={`${p.ilosc.toLocaleString('pl-PL')} ${p.jednostka} × ${cenaPozycji(p, s.waluta)} netto · VAT ${stawkaTekst(p)}`}
                wartosc={kwota(bruttoPozycji(p), s.waluta)}
                wartoscKolor="etykieta"
              />
            ))}
            {s.netto !== undefined ? <Wiersz tytul="Razem netto" wartosc={kwota(s.netto, s.waluta)} /> : null}
            {vat !== undefined ? <Wiersz tytul="VAT" wartosc={kwota(vat, s.waluta)} /> : null}
            <Wiersz tytul="Razem brutto" wartosc={kwota(s.brutto, s.waluta)} wartoscKolor="etykieta" />
          </Sekcja>
        ) : null}

        {!wydatekWTelefonie ? (
          <Sekcja
            naglowek="Wydatek"
            stopka={
              s.zHistorii
                ? 'Faktury z historii KSeF to archiwum: nie tworzymy z nich kosztów.'
                : 'Kategorię, opis i kolumnę KPiR ustawisz na faktway.pl, w zakładce Koszty.'
            }>
            <Wiersz tytul="Stan" wartosc={st.tekst} wartoscKolor={st.kolor} />
            {MA_ADRES_STRONY && !s.zHistorii ? (
              <Wiersz tytul="Otwórz na stronie" strzalka onPress={() => otworzStrone(s.wydatekId ? `/expenses/${encodeURIComponent(s.wydatekId)}` : '/inbox')} />
            ) : null}
          </Sekcja>
        ) : null}
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.m },
});
