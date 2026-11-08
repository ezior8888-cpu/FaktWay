import { Stack, useIsPreview, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { bruttoPozycji, DZIS, type StatusKsef } from '@/dane-przykladowe';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { Tekst } from '@/komponenty/tekst';
import { dataPelna, kwota } from '@/lib/format';
import { doZaplaty, statusFaktury } from '@/lib/status-faktury';
import { udostepnijFakture, useStanFaktur } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

const NAZWA_STATUSU_KSEF: Record<StatusKsef, string> = {
  przyjeta: 'Przyjęta',
  wysylanie: 'Wysyłanie',
  odrzucona: 'Odrzucona',
  robocza: 'Szkic',
};

export default function EkranFaktury() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { faktury, przelaczZaplate } = useStanFaktur();
  // W podglądzie z przytrzymania wiersza ekran nie ustawia paska nawigacji.
  const podglad = useIsPreview();
  const f = faktury.find((x) => x.id === id);

  if (!f) {
    return (
      <EkranListy>
        <StanPusty ikona="doc.questionmark" tytul="Nie ma takiej faktury" opis="Mogła zostać usunięta na komputerze." />
      </EkranListy>
    );
  }
  const status = statusFaktury(f, DZIS);
  const mozeZaplacic = doZaplaty(f) || f.zaplacona;

  return (
    <>
      {podglad ? null : (
        <>
          <Stack.Screen options={{ title: f.numer }} />
          <Stack.Toolbar placement="right">
            <Stack.Toolbar.Button icon="square.and.arrow.up" accessibilityLabel="Udostępnij" onPress={() => udostepnijFakture(f)} />
          </Stack.Toolbar>
        </>
      )}

      <EkranListy>
        <View style={styles.naglowek}>
          <Tekst styl="headline" selectable>
            {f.kontrahent}
          </Tekst>
          <Tekst styl="largeTitle" cyfry selectable accessibilityLabel={`Kwota ${kwota(f.brutto)}`}>
            {kwota(f.brutto)}
          </Tekst>
          <Tekst styl="subheadline" kolor={status.kolor}>
            {status.tekst}
          </Tekst>
        </View>

        {mozeZaplacic && !podglad ? (
          <View style={styles.akcja}>
            <PrzyciskGlowny
              tytul={f.zaplacona ? 'Cofnij oznaczenie zapłaty' : 'Oznacz jako zapłaconą'}
              ikona={f.zaplacona ? 'arrow.uturn.backward' : 'checkmark'}
              wariant={f.zaplacona ? 'drugorzedny' : 'glowny'}
              onPress={() => przelaczZaplate(f)}
            />
          </View>
        ) : null}

        <Sekcja naglowek="Szczegóły">
          <Wiersz tytul="Wystawiona" wartosc={dataPelna(f.dataWystawienia)} />
          <Wiersz tytul="Termin płatności" wartosc={dataPelna(f.terminPlatnosci)} />
          <Wiersz tytul="NIP nabywcy" wartosc={f.nipKontrahenta} zaznaczalna />
        </Sekcja>

        <Sekcja naglowek="Pozycje" stopka={`Netto ${kwota(f.netto)}, VAT ${kwota(f.brutto - f.netto)}`}>
          {f.pozycje.map((p, i) => (
            <Wiersz
              key={i}
              tytul={p.nazwa}
              podtytul={`${p.ilosc} ${p.jednostka} × ${kwota(p.cenaNetto)} netto, VAT ${p.stawkaVat}%`}
              wartosc={kwota(bruttoPozycji(p))}
            />
          ))}
        </Sekcja>

        <Sekcja
          naglowek="KSeF"
          stopka={
            f.statusKsef === 'odrzucona'
              ? 'KSeF odrzucił tę fakturę. Popraw ją na faktway.pl i wyślij ponownie.'
              : f.statusKsef === 'wysylanie'
                ? 'Status odświeży się sam, gdy KSeF potwierdzi przyjęcie.'
                : undefined
          }>
          <Wiersz
            tytul="Status"
            wartosc={NAZWA_STATUSU_KSEF[f.statusKsef]}
            wartoscKolor={f.statusKsef === 'odrzucona' ? 'blad' : undefined}
          />
          {f.numerKsef ? <Wiersz tytul="Numer KSeF" podtytul={f.numerKsef} zaznaczalna /> : null}
        </Sekcja>
      </EkranListy>
    </>
  );
}

const styles = StyleSheet.create({
  naglowek: { paddingHorizontal: MARGINES + ODSTEP.xxs, paddingTop: ODSTEP.m, gap: ODSTEP.xxs },
  akcja: { marginHorizontal: MARGINES, marginTop: ODSTEP.l },
});
