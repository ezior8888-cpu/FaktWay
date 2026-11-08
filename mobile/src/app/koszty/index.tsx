import { Stack } from 'expo-router';
import { Alert } from 'react-native';

import { KOSZTY, type Koszt } from '@/dane-przykladowe';
import { EkranListy, Sekcja, Wiersz } from '@/komponenty/lista';
import { dataKrotka, kwota } from '@/lib/format';

export default function EkranKosztow() {
  const doOpisania = KOSZTY.filter((k) => k.zrodlo === 'ksef' && k.doOpisania);
  const pozostale = KOSZTY.filter((k) => !(k.zrodlo === 'ksef' && k.doOpisania));

  const wiersz = (k: Koszt) => (
    <Wiersz
      key={k.id}
      tytul={k.dostawca}
      podtytul={`${k.opis} · ${dataKrotka(k.data)}`}
      wartosc={kwota(k.brutto)}
      wartoscPodpis={k.zrodlo === 'ksef' ? 'Z KSeF' : 'Ze zdjęcia'}
      onPress={() => Alert.alert(k.dostawca, 'Szczegóły kosztu pojawią się w etapie M6.')}
    />
  );

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="doc.viewfinder"
          accessibilityLabel="Zeskanuj paragon albo fakturę"
          onPress={() => Alert.alert('Skaner dokumentów', 'Skanowanie paragonów pojawi się w etapie M8.')}
        />
      </Stack.Toolbar>
      <EkranListy>
        <Sekcja
          naglowek="Do opisania"
          stopka="Faktury kosztowe pobrane z KSeF. Opisz je, żeby trafiły do ewidencji.">
          {doOpisania.map(wiersz)}
        </Sekcja>
        <Sekcja naglowek="Ostatnie">{pozostale.map(wiersz)}</Sekcja>
      </EkranListy>
    </>
  );
}
