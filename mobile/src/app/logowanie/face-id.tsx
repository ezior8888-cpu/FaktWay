import { SymbolView } from 'expo-symbols';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { EkranLogowania } from '@/komponenty/ekran-logowania';
import { KoloIkony } from '@/komponenty/ikona';
import { Karta } from '@/komponenty/karta';
import { PrzyciskGlowny } from '@/komponenty/przycisk-glowny';
import { Tekst } from '@/komponenty/tekst';
import { useSesja } from '@/stan/sesja';
import { useKolory } from '@/wyglad/kolory';
import { CEL_DOTYKU, MARGINES, ODSTEP } from '@/wyglad/odstepy';

const KOLO = 72;

/**
 * Propozycja Face ID, raz po pierwszym logowaniu i tylko na telefonie z
 * biometrią (WZORCE-MOBBIN.md 7, ekran 4; wzory Fidelity, Betterment,
 * Revolut Business). Ten sam przełącznik co w Więcej, Bezpieczeństwo.
 * Znak Face ID to systemowy symbol (`faceid`), bo tak go klient zna z innych
 * aplikacji; Remix nie ma odpowiednika (ZASADY-DESIGNU.md, sekcja 4).
 */
export default function EkranPropozycjiFaceId() {
  const kolory = useKolory();
  const { biometria, zakonczPropozycje } = useSesja();
  const nazwa = biometria?.nazwa ?? 'Face ID';
  const twarz = biometria?.twarz ?? true;
  return (
    <EkranLogowania tytul="Jeszcze jedno" opis="Możesz to zmienić w Więcej, Bezpieczeństwo.">
      <Karta wnetrze={styles.karta}>
        <View style={styles.ikona}>
          {twarz && Platform.OS === 'ios' ? (
            <View style={[styles.kolo, { backgroundColor: kolory.akcentTlo }]} accessibilityElementsHidden>
              <SymbolView name="faceid" size={36} tintColor={kolory.akcent} />
            </View>
          ) : (
            <KoloIkony nazwa="fingerprint-line" rozmiar={KOLO} />
          )}
        </View>
        <Tekst styl="title2" style={styles.wysrodkowany} accessibilityRole="header">
          {twarz ? 'Odblokowuj FaktWay twarzą' : 'Odblokowuj FaktWay odciskiem palca'}
        </Tekst>
        <Tekst styl="subheadline" kolor="etykietaDrugorzedna" style={styles.wysrodkowany}>
          {`Po powrocie do aplikacji wystarczy ${twarz ? 'spojrzeć na telefon' : 'dotknąć czytnika'}, a kwoty nie będą widoczne dla nikogo innego.`}
        </Tekst>
      </Karta>
      <View style={styles.przyciski}>
        <PrzyciskGlowny tytul={`Włącz ${nazwa}`} onPress={() => zakonczPropozycje(true)} />
        <Pressable onPress={() => zakonczPropozycje(false)} accessibilityRole="button" style={styles.tekstowy}>
          <Tekst styl="callout" waga="medium" kolor="akcent" style={styles.wysrodkowany}>
            Nie teraz
          </Tekst>
        </Pressable>
      </View>
    </EkranLogowania>
  );
}

const styles = StyleSheet.create({
  karta: { padding: MARGINES + ODSTEP.xxs, gap: ODSTEP.xs, alignItems: 'center' },
  ikona: { marginBottom: ODSTEP.xs },
  kolo: { width: KOLO, height: KOLO, borderRadius: KOLO / 2, alignItems: 'center', justifyContent: 'center' },
  wysrodkowany: { textAlign: 'center' },
  przyciski: { paddingHorizontal: MARGINES, gap: ODSTEP.xs },
  tekstowy: { minHeight: CEL_DOTYKU, alignItems: 'center', justifyContent: 'center' },
});
