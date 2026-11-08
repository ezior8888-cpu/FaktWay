import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { useColorScheme } from 'react-native';

import { useKolory } from '@/wyglad/kolory';

/**
 * Cztery systemowe zakładki (plan, decyzja D11). Na iOS 26 i nowszym pasek
 * rysuje system (Liquid Glass); ThemeProvider dopasowuje tło pod paskiem
 * do trybu jasnego i ciemnego, żeby nic nie mrugało przy przejściach.
 */
export default function UkladGlowny() {
  const schemat = useColorScheme();
  const kolory = useKolory();
  return (
    <ThemeProvider value={schemat === 'dark' ? DarkTheme : DefaultTheme}>
      <NativeTabs tintColor={kolory.akcent} minimizeBehavior="onScrollDown">
        <NativeTabs.Trigger name="(faktury)">
          <NativeTabs.Trigger.Label>Faktury</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf={{ default: 'doc.text', selected: 'doc.text.fill' }} md="description" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="koszty">
          <NativeTabs.Trigger.Label>Koszty</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf={{ default: 'tray', selected: 'tray.fill' }} md="inbox" />
          <NativeTabs.Trigger.Badge>2</NativeTabs.Trigger.Badge>
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="miesiac">
          <NativeTabs.Trigger.Label>Ten miesiąc</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf={{ default: 'calendar', selected: 'calendar' }} md="calendar_month" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="konto">
          <NativeTabs.Trigger.Label>Konto</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }}
            md="account_circle"
          />
        </NativeTabs.Trigger>
      </NativeTabs>
    </ThemeProvider>
  );
}
