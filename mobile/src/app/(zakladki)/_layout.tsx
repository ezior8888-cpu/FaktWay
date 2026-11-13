import { Redirect } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';

import { useStanFaktur } from '@/stan/faktury';
import { useSesja } from '@/stan/sesja';
import { useKolory } from '@/wyglad/kolory';
import { czcionka } from '@/wyglad/typografia';

/**
 * Pięć zakładek jak w menu strony (plan, D3 i D11). Pasek rysuje system
 * (płynność, na iOS 26 i nowszym Liquid Glass), ale ikony, napisy i kolor
 * są FaktWay (D12): ikony Remix z menu strony (`lib/dashboard-nav-config.ts`),
 * kontur w spoczynku i wypełnienie po wybraniu, napisy w Outfit. Widać je
 * tylko po zalogowaniu (`app/_layout.tsx`, etap M5).
 */
export default function Zakladki() {
  const kolory = useKolory();
  const { koszty, skrzynka, dane } = useStanFaktur();
  // Prawdziwe konto (M7): nowe faktury ze skrzynki KSeF; wydatki są jeszcze na danych przykładowych.
  const doOpisania = dane.zrodlo === 'baza' ? skrzynka.filter((s) => s.status === 'nowa').length : koszty.filter((k) => k.doOpisania).length;
  const { stan } = useSesja();
  // `kod`: API poprosiło o kod 2FA w trakcie sesji (`wymagajKodu`), od razu ekran kodu.
  if (stan === 'kod') return <Redirect href="/logowanie/kod" />;
  if (stan !== 'aktywna') return <Redirect href="/logowanie" />;
  return (
    <NativeTabs
      tintColor={kolory.akcent}
      iconColor={{ default: kolory.etykietaDrugorzedna, selected: kolory.akcent }}
      labelStyle={{ default: { fontFamily: czcionka('medium'), fontSize: 10, color: kolory.etykietaDrugorzedna }, selected: { fontFamily: czcionka('medium'), fontSize: 10, color: kolory.akcent } }}
      minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="(pulpit)">
        <NativeTabs.Trigger.Label>Pulpit</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={{ default: require('../../../assets/zakladki/pulpit-line.png'), selected: require('../../../assets/zakladki/pulpit-fill.png') }}
          renderingMode="template"
          md="dashboard"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="faktury">
        <NativeTabs.Trigger.Label>Faktury</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={{ default: require('../../../assets/zakladki/faktury-line.png'), selected: require('../../../assets/zakladki/faktury-fill.png') }}
          renderingMode="template"
          md="description"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="koszty">
        <NativeTabs.Trigger.Label>Koszty</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={{ default: require('../../../assets/zakladki/koszty-line.png'), selected: require('../../../assets/zakladki/koszty-fill.png') }}
          renderingMode="template"
          md="receipt_long"
        />
        {doOpisania > 0 ? <NativeTabs.Trigger.Badge>{String(doOpisania)}</NativeTabs.Trigger.Badge> : <NativeTabs.Trigger.Badge hidden />}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="ksiegowosc">
        <NativeTabs.Trigger.Label>Księgowość</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={{ default: require('../../../assets/zakladki/ksiegowosc-line.png'), selected: require('../../../assets/zakladki/ksiegowosc-fill.png') }}
          renderingMode="template"
          md="menu_book"
        />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="wiecej">
        <NativeTabs.Trigger.Label>Więcej</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          src={{ default: require('../../../assets/zakladki/wiecej-line.png'), selected: require('../../../assets/zakladki/wiecej-fill.png') }}
          renderingMode="template"
          md="more_horiz"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
