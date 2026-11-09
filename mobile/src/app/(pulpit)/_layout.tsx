import { Stack } from 'expo-router';

/** Lista zakładki zawsze leży pod spodem: arkusze i ekrany otwarte linkiem mają „wstecz” i prezentują się jako arkusze. */
export const unstable_settings = { anchor: 'index' };

/** Stos zakładki Pulpit: przegląd finansów, przepływy, analizy, podsumowanie roku. */
export default function UkladPulpitu() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Pulpit', headerLargeTitle: true }} />
      <Stack.Screen name="przeplywy" options={{ title: 'Przepływy' }} />
      <Stack.Screen name="analizy" options={{ title: 'Analizy' }} />
      <Stack.Screen name="twoj-rok" options={{ presentation: 'modal', title: 'Twój rok w liczbach' }} />
    </Stack>
  );
}
