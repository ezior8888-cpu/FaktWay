import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Share, StyleSheet, View } from 'react-native';

import { DZIS } from '@/dane-przykladowe';
import { ROZLICZENIE } from '@/dane-przykladowe/ksiegowosc';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { NaglowekKwoty } from '@/komponenty/naglowek';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { StanPusty } from '@/komponenty/stan-pusty';
import { dataPelna, kwota } from '@/lib/format';
import { kiedyTermin } from '@/lib/status-faktury';
import { useFlaga } from '@/stan/faktury';
import { MARGINES, ODSTEP } from '@/wyglad/odstepy';

/**
 * Arkusz „Dane do przelewu” jednej płatności z „Ten miesiąc” (WZORCE-MOBBIN.md
 * 5.2; wzór Lightyear i N26): kwota, termin, dane przelewu do zaznaczenia,
 * „Udostępnij dane przelewu” i „Oznacz jako zapłacone” z cofnięciem.
 * Kopiowanie jednym dotknięciem potrzebuje `expo-clipboard` (nowy build
 * natywny): na razie zaznaczanie tekstu i udostępnianie. Mikrorachunku nie
 * liczymy tu z NIP (R1), pokazujemy dane z rozliczenia.
 */
export default function EkranPrzelewu() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const p = ROZLICZENIE.pozycje.find((x) => x.id === id);
  const [zaplacone, setZaplacone] = useFlaga(`zaplacone-${id}`, false);
  if (!p) return <StanPusty ikona="file-unknow-line" tytul="Nie ma takiej płatności" opis="Wróć do „Ten miesiąc” i wybierz płatność z listy." />;

  return (
    <EkranListy>
      <NaglowekKwoty
        podpis={p.nazwa}
        podpisWyrozniony
        wartosc={kwota(p.kwota)}
        status={zaplacone ? 'Zapłacone' : `Termin ${dataPelna(p.termin)}, ${kiedyTermin(DZIS, p.termin)}`}
        statusKolor={zaplacone ? 'sukces' : 'etykietaDrugorzedna'}
      />
      <Sekcja naglowek="Dane do przelewu" stopka="Przytrzymaj tekst, żeby go zaznaczyć i skopiować.">
        <Wiersz tytul="Kwota" wartosc={kwota(p.kwota)} wartoscKolor="etykieta" zaznaczalna />
        <Wiersz tytul="Termin" wartosc={dataPelna(p.termin)} />
        <Wiersz tytul="Rachunek i opis" podtytul={p.przelew} zaznaczalna />
      </Sekcja>
      <View style={styles.akcje}>
        <PrzyciskGlowny
          tytul="Udostępnij dane przelewu"
          ikona="share-forward-line"
          wariant="drugorzedny"
          onPress={() => void Share.share({ message: `${p.nazwa}: ${kwota(p.kwota)}, termin ${dataPelna(p.termin)}. ${p.przelew}` })}
        />
        <PrzyciskGlowny
          tytul={zaplacone ? 'Cofnij zapłatę' : 'Oznacz jako zapłacone'}
          ikona={zaplacone ? 'arrow-go-back-line' : 'check-line'}
          wariant={zaplacone ? 'drugorzedny' : 'glowny'}
          onPress={() => {
            setZaplacone(!zaplacone);
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            if (!zaplacone) router.back();
          }}
        />
      </View>
    </EkranListy>
  );
}

const styles = StyleSheet.create({
  akcje: { marginHorizontal: MARGINES, marginTop: ODSTEP.l, gap: ODSTEP.s },
});
