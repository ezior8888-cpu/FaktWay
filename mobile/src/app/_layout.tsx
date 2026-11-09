import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { StanFaktur, useStanFaktur } from '@/stan/faktury';
import { useKolory } from '@/wyglad/kolory';

/**
 * Pięć systemowych zakładek jak w menu strony (plan, D3 i D11 po zmianie
 * 09.11.2026). Na iOS 26 i nowszym pasek rysuje system (Liquid Glass);
 * ThemeProvider dopasowuje tło pod paskiem do trybu jasnego i ciemnego,
 * żeby nic nie mrugało przy przejściach.
 */
export default function UkladGlowny() {
  const schemat = useColorScheme();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={schemat === 'dark' ? DarkTheme : DefaultTheme}>
        <StanFaktur>
          <Zakladki />
        </StanFaktur>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

function Zakladki() {
  const kolory = useKolory();
  const doOpisania = useStanFaktur().koszty.filter((k) => k.doOpisania).length;
  return (
    <NativeTabs tintColor={kolory.akcent} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="(pulpit)">
        <NativeTabs.Trigger.Label>Pulpit</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'square.grid.2x2', selected: 'square.grid.2x2.fill' }} md="dashboard" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="faktury">
        <NativeTabs.Trigger.Label>Faktury</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'doc.text', selected: 'doc.text.fill' }} md="description" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="koszty">
        <NativeTabs.Trigger.Label>Koszty</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'tray', selected: 'tray.fill' }} md="inbox" />
        {doOpisania > 0 ? <NativeTabs.Trigger.Badge>{String(doOpisania)}</NativeTabs.Trigger.Badge> : <NativeTabs.Trigger.Badge hidden />}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="ksiegowosc">
        <NativeTabs.Trigger.Label>Księgowość</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'book.closed', selected: 'book.closed.fill' }} md="menu_book" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="wiecej">
        <NativeTabs.Trigger.Label>Więcej</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="ellipsis.circle" md="more_horiz" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
