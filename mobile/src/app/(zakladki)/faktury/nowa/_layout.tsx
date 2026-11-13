import { Stack } from 'expo-router';

import { useOpcjeStosu } from '@/wyglad/naglowki';

/** Link z zewnątrz ma pod formularzem wybór rodzaju; wejścia z aplikacji (Popraw, Korekta, Duplikuj) dają `wprost` i „Anuluj”. */
export const unstable_settings = { anchor: 'index' };

/** Arkusz „Nowa faktura” ma własny stos: wybór rodzaju, potem formularz. */
export default function UkladNowejFaktury() {
  const opcje = useOpcjeStosu();
  return (
    <Stack screenOptions={opcje}>
      <Stack.Screen name="index" options={{ title: 'Nowa faktura' }} />
      <Stack.Screen name="[rodzaj]" options={{ title: 'Nowa faktura' }} />
    </Stack>
  );
}
