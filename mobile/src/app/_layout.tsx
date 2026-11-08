import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { PrzyciskNowejNadZakladkami } from '@/komponenty/przycisk-nowej';
import { KOSZTY } from '@/dane-przykladowe';
import { StanFaktur, useStanFaktur } from '@/stan/faktury';
import { useKolory } from '@/wyglad/kolory';

const DO_OPISANIA = KOSZTY.filter((k) => k.zrodlo === 'ksef' && k.doOpisania).length;

/**
 * Cztery systemowe zakładki (plan, decyzja D11). Na iOS 26 i nowszym pasek
 * rysuje system (Liquid Glass); ThemeProvider dopasowuje tło pod paskiem
 * do trybu jasnego i ciemnego, żeby nic nie mrugało przy przejściach.
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
  const { wariantNowej } = useStanFaktur();
  return (
    <NativeTabs tintColor={kolory.akcent} minimizeBehavior="onScrollDown">
      {wariantNowej === 'nad-zakladkami' ? (
        <NativeTabs.BottomAccessory>
          <PrzyciskNowejNadZakladkami />
        </NativeTabs.BottomAccessory>
      ) : null}
      <NativeTabs.Trigger name="(faktury)">
        <NativeTabs.Trigger.Label>Faktury</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'doc.text', selected: 'doc.text.fill' }} md="description" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="koszty">
        <NativeTabs.Trigger.Label>Koszty</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'tray', selected: 'tray.fill' }} md="inbox" />
        {DO_OPISANIA > 0 ? <NativeTabs.Trigger.Badge>{String(DO_OPISANIA)}</NativeTabs.Trigger.Badge> : null}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="miesiac">
        <NativeTabs.Trigger.Label>Ten miesiąc</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="calendar" md="calendar_month" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="konto">
        <NativeTabs.Trigger.Label>Konto</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }}
          md="account_circle"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
