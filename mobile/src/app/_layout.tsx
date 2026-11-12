import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { LogBox, StyleSheet, useColorScheme, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { PasekCofnij } from '@/komponenty/pasek-cofnij';
import { StanFaktur, useStanFaktur } from '@/stan/faktury';
import { paleta, useKolory } from '@/wyglad/kolory';
import { czcionka } from '@/wyglad/typografia';

// Znane ostrzeżenie React Native w wersji deweloperskiej przy przejściach ekranów
// (wartości `Animated` bez nasłuchu); nie dotyczy naszego kodu i zasłaniało dół ekranu.
LogBox.ignoreLogs(['Sending `onAnimatedValueUpdate` with no listeners registered']);

/**
 * Pięć zakładek jak w menu strony (plan, D3 i D11). Pasek rysuje system
 * (płynność, na iOS 26 i nowszym Liquid Glass), ale ikony, napisy i kolor
 * są FaktWay (D12): ikony Remix z menu strony (`lib/dashboard-nav-config.ts`),
 * kontur w spoczynku i wypełnienie po wybraniu, napisy w Outfit.
 * Motyw nawigacji ma kolory marki, żeby tło pod paskiem nie mrugało.
 */
export default function UkladGlowny() {
  const ciemny = useColorScheme() === 'dark';
  const k = paleta(ciemny);
  const baza = ciemny ? DarkTheme : DefaultTheme;
  const motyw = {
    ...baza,
    colors: { ...baza.colors, primary: k.akcent, background: k.tloGrupowane, card: k.tloGrupowane, text: k.etykieta, border: k.obwodka },
  };
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={motyw}>
        <StanFaktur>
          <View style={styles.ekran}>
            <Zakladki />
            <PasekCofnij />
          </View>
        </StanFaktur>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

function Zakladki() {
  const kolory = useKolory();
  const doOpisania = useStanFaktur().koszty.filter((k) => k.doOpisania).length;
  return (
    <NativeTabs
      tintColor={kolory.akcent}
      iconColor={{ default: kolory.etykietaDrugorzedna, selected: kolory.akcent }}
      labelStyle={{ default: { fontFamily: czcionka('medium'), fontSize: 10, color: kolory.etykietaDrugorzedna }, selected: { fontFamily: czcionka('medium'), fontSize: 10, color: kolory.akcent } }}
      minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="(pulpit)">
        <NativeTabs.Trigger.Label>Pulpit</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={{ default: require('../../assets/zakladki/pulpit-line.png'), selected: require('../../assets/zakladki/pulpit-fill.png') }}
          renderingMode="template"
          md="dashboard"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="faktury">
        <NativeTabs.Trigger.Label>Faktury</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={{ default: require('../../assets/zakladki/faktury-line.png'), selected: require('../../assets/zakladki/faktury-fill.png') }}
          renderingMode="template"
          md="description"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="koszty">
        <NativeTabs.Trigger.Label>Koszty</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={{ default: require('../../assets/zakladki/koszty-line.png'), selected: require('../../assets/zakladki/koszty-fill.png') }}
          renderingMode="template"
          md="receipt_long"
        />
        {doOpisania > 0 ? <NativeTabs.Trigger.Badge>{String(doOpisania)}</NativeTabs.Trigger.Badge> : <NativeTabs.Trigger.Badge hidden />}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="ksiegowosc">
        <NativeTabs.Trigger.Label>Księgowość</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={{ default: require('../../assets/zakladki/ksiegowosc-line.png'), selected: require('../../assets/zakladki/ksiegowosc-fill.png') }}
          renderingMode="template"
          md="menu_book"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="wiecej">
        <NativeTabs.Trigger.Label>Więcej</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={{ default: require('../../assets/zakladki/wiecej-line.png'), selected: require('../../assets/zakladki/wiecej-fill.png') }}
          renderingMode="template"
          md="more_horiz"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

const styles = StyleSheet.create({
  ekran: { flex: 1 },
});
