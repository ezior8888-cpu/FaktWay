/**
 * Karta po wysłaniu faktury z formularza (WZORCE-MOBBIN.md 8.4 i 3.2; wzór
 * Revolut Business i Jobber): najpierw „Wysyłamy do KSeF” z informacją, ile to
 * trwa, a gdy KSeF przyjmie fakturę, na żywo „Przyjęta w KSeF” z numerem KSeF,
 * „Wyślij e-mailem”, „Udostępnij” i „Gotowe”. Przy odrzuceniu znika, bo
 * szczegół pokazuje powód i „Popraw fakturę”.
 */
import { StyleSheet, View } from 'react-native';

import type { Faktura } from '@/dane-przykladowe';
import { Ikona } from '@/komponenty/ikona';
import { Karta } from '@/komponenty/karta';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { RzadAkcji } from '@/komponenty/rzad-akcji';
import { Tekst } from '@/komponenty/tekst';
import { kwota } from '@/lib/format';
import { useKolory } from '@/wyglad/kolory';
import { MARGINES, ODSTEP, PROMIEN_POLA } from '@/wyglad/odstepy';

type Props = { faktura: Faktura; onEmail: () => void; onUdostepnij: () => void; onGotowe: () => void };

export function PotwierdzenieKsef({ faktura: f, onEmail, onUdostepnij, onGotowe }: Props) {
  const kolory = useKolory();
  if (f.statusKsef === 'odrzucona' || f.statusKsef === 'robocza') return null;
  const przyjeta = f.statusKsef === 'przyjeta';
  return (
    <View style={styles.oslona} accessibilityLiveRegion="polite">
      <Karta>
        <View style={styles.tresc}>
          <View style={styles.naglowek}>
            <Ikona nazwa={przyjeta ? 'checkbox-circle-fill' : 'loader4-line'} rozmiar={30} kolor={przyjeta ? kolory.sukces : kolory.akcent} />
            <View style={styles.rozciagniety}>
              <Tekst styl="headline">{przyjeta ? 'Przyjęta w KSeF' : 'Wysyłamy do KSeF'}</Tekst>
              <Tekst styl="footnote" kolor="etykietaDrugorzedna">
                {przyjeta
                  ? `${f.kontrahent}, ${kwota(f.brutto)}. Nabywca zobaczy ją w KSeF.`
                  : 'KSeF zwykle potwierdza w kilka sekund. Możesz zamknąć, status odświeży się sam.'}
              </Tekst>
            </View>
          </View>
          {przyjeta && f.numerKsef ? (
            <View style={[styles.numer, { backgroundColor: kolory.wypelnienie }]}>
              <Tekst styl="caption1" kolor="etykietaDrugorzedna">
                Numer KSeF
              </Tekst>
              <Tekst styl="footnote" cyfry selectable>
                {f.numerKsef}
              </Tekst>
            </View>
          ) : null}
        </View>
      </Karta>
      {przyjeta ? (
        <>
          <RzadAkcji
            akcje={[
              { tytul: 'Wyślij e-mailem', ikona: 'mail-line', onPress: onEmail },
              { tytul: 'Udostępnij', ikona: 'share-forward-line', onPress: onUdostepnij },
            ]}
          />
          <View style={styles.gotowe}>
            <PrzyciskGlowny tytul="Gotowe" wariant="drugorzedny" onPress={onGotowe} />
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  oslona: { marginTop: ODSTEP.s },
  tresc: { padding: MARGINES, gap: ODSTEP.s },
  naglowek: { flexDirection: 'row', alignItems: 'center', gap: ODSTEP.s },
  rozciagniety: { flex: 1, gap: ODSTEP.linia },
  numer: { borderRadius: PROMIEN_POLA, paddingHorizontal: ODSTEP.s, paddingVertical: ODSTEP.xs, gap: ODSTEP.linia },
  gotowe: { marginHorizontal: MARGINES, marginTop: ODSTEP.s },
});
