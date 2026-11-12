import { Stack } from 'expo-router';

import { useOpcjeStosu } from '@/wyglad/naglowki';

/** Lista zakładki zawsze leży pod spodem: arkusze i ekrany otwarte linkiem mają „wstecz” i prezentują się jako arkusze. */
export const unstable_settings = { anchor: 'index' };

/** Stos zakładki Pulpit: przegląd, finanse (karty, które zeszły z Pulpitu), przepływy, analizy. */
export default function UkladPulpitu() {
  const opcje = useOpcjeStosu();
  return (
    <Stack screenOptions={opcje}>
      {/* Pulpit ma własny pasek z logo FaktWay na gradiencie (komponenty/pasek-marki), więc jasny pasek stanu; tytuł zostaje dla przycisku wstecz. */}
      <Stack.Screen name="index" options={{ title: 'Pulpit', headerShown: false, statusBarStyle: 'light' }} />
      <Stack.Screen name="finanse" options={{ title: 'Finanse' }} />
      <Stack.Screen name="przeplywy" options={{ title: 'Przepływy' }} />
      <Stack.Screen name="analizy" options={{ title: 'Analizy' }} />
    </Stack>
  );
}
